/**
 * subagents.ts — detects "is a subagent running right now".
 *
 * recap triggers **on idle**: 30 quiet seconds after a turn ends (`agent_settled`) →
 * generate. But an async subagent lives **outside the turn**: `subagent({ async: true
 * })` returns at once — the main turn ends while the subagent keeps running in the
 * background for tens of seconds or minutes, its result carried back by a woken turn
 * later. A 30s expiry would then summarize "just dispatched the task, still waiting"
 * as "turn done". So before generating it must ask "any subagent still running?" —
 * yes → re-check only, never generate, and restart the 30s countdown once they all end.
 *
 * Why pi-subagents's in-process RPC instead of counting `subagent` tool calls ourselves:
 *   - **Uncountable**. An async call returns immediately (`details.asyncId`) and its
 *     result comes back in a later turn — the tool call itself cannot say "still
 *     running"; that state lives only in pi-subagents's in-process state (`asyncJobs`
 *     / `foregroundControls`), with no session entries and no files on disk to read.
 *   - **Its docs give the hook**. `pi-subagents/docs/extension-api.md`'s
 *     "In-process event-bus RPC" section is the public interface for "other Pi
 *     extensions": emit `subagents:rpc:v1:request`, receive on
 *     `subagents:rpc:v1:reply:<requestId>`; a `status` call (no target) replies with
 *     `data.fleet` (Fleet status DTO v1) whose `totalActive` is the current session's
 *     active subagent count (foreground + async + queued all included).
 *   - **No pi-subagents file is imported**. It is an independently-installed npm
 *     package, not a resolvable dependency here — and it may not be installed at all
 *     (a different machine may lack it). The protocol is versioned string channels +
 *     a JSON reply, so a minimal structural interface is enough. For the same reason
 *     this file **does not import pi** (the bus is injected via the interface below),
 *     and `node --test` can drive it with a fake bus:
 *
 *         node --test clients/pi/extensions/recap/subagents.test.ts
 *
 * Every failure counts as "none": pi-subagents missing, protocol version changed,
 * reply shape unrecognized, timeout / exception — all return false (fail-open).
 * Better to occasionally generate a recap while a subagent runs than let the probe
 * stall the whole recap. The probe timeout is 1s: with no subagents the peer answers
 * from an in-memory snapshot in milliseconds.
 */

/** The subset of pi's event bus this uses (structurally compatible with pi's real `EventBus`). */
export interface SubagentEventBus {
	on(channel: string, handler: (data: unknown) => void): (() => void) | void;
	emit(channel: string, data: unknown): void;
}

/** pi-subagents's RPC channels (see its docs/extension-api.md; protocol version 1). */
export const SUBAGENT_RPC_REQUEST = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_RPC_VERSION = 1;

/** The probe timeout: with no subagents the peer answers instantly — a timeout means it is absent. */
export const SUBAGENT_RPC_TIMEOUT_MS = 1_000;

let requestSeq = 0;

/** A unique id per request — only our own reply channel is matched, never someone else's reply. */
export function nextSubagentRequestId(now = Date.now()): string {
	requestSeq += 1;
	return `recap-${requestSeq}-${now.toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decide "a subagent is running" from a `status` reply.
 *
 * The primary signal is `data.fleet.totalActive` (the **total** active count beyond the
 * bounded `entries` window, so anything past the window still counts). `queued` /
 * `running` inside `asyncSnapshot.runs` is the fallback: `fleet` only exists since v1
 * (absent when `ping.capabilities.fleetStatus` is missing) while the snapshot may exist
 * alone on older versions. Recognizing neither → false (fail-open).
 */
export function isSubagentWorkActive(reply: unknown): boolean {
	if (!isRecord(reply) || reply.success !== true) return false;
	const data = reply.data;
	if (!isRecord(data)) return false;

	const fleet = data.fleet;
	if (isRecord(fleet) && typeof fleet.totalActive === "number" && fleet.totalActive > 0) return true;

	const snapshot = data.asyncSnapshot;
	const runs = isRecord(snapshot) ? snapshot.runs : undefined;
	if (!Array.isArray(runs)) return false;
	return runs.some((run) => isRecord(run) && (run.state === "queued" || run.state === "running"));
}

/**
 * Ask pi-subagents once: is a subagent running right now.
 *
 * The happy path: subscribe the reply channel → emit the request → receive the reply
 * (or the timeout) → unsubscribe → parse.
 * Any step failing counts as "none" — this function **never throws**.
 */
export async function hasActiveSubagentWork(
	events: SubagentEventBus,
	options: { timeoutMs?: number; requestId?: string } = {},
): Promise<boolean> {
	const timeoutMs = options.timeoutMs ?? SUBAGENT_RPC_TIMEOUT_MS;
	const requestId = options.requestId ?? nextSubagentRequestId();

	const reply = await new Promise<unknown>((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (value: unknown) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			try {
				unsubscribe?.();
			} catch {
				// an unsubscribe failure is harmless: the handler already settled, and a late reply is ignored.
			}
			resolve(value);
		};

		try {
			const off = events.on(`${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`, finish);
			if (typeof off === "function") unsubscribe = off;
			timer = setTimeout(() => finish(undefined), timeoutMs);
			timer.unref?.();
			events.emit(SUBAGENT_RPC_REQUEST, {
				version: SUBAGENT_RPC_VERSION,
				requestId,
				method: "status",
				// no target = only this session's fleet summary (the peer answers from an in-memory snapshot, instantly).
				params: {},
				source: { extension: "recap" },
			});
		} catch {
			finish(undefined);
		}
	});

	return isSubagentWorkActive(reply);
}
