/**
 * subagent-log-guard — keep pi-subagents's startup diagnostics from smearing
 * over the input box.
 *
 * The symptom: while a **foreground** subagent runs, the input-box row (after
 * `❯ `) is suddenly overwritten by
 *   [pi-subagents] Agent 'researcher': host runtime tool availability omitted [web_search, …]
 * — the widget's following rows are smeared by this line's continuations, the
 * background shifts, the input box looks broken; Enter / window switches do
 * not repaint it away.
 *
 * The root cause (reproduced locally under tmux): pi-subagents prints this
 * diagnostic via console.warn (`runs/foreground/execution.ts`'s launch
 * warnings, `runs/background/subagent-runner.ts`'s same-named diagnostic,
 * etc.).
 * In the parent process console.warn writes to the **real stderr** — pi only
 * takeOverStdout in rpc / json / print modes (`dist/main.js`:
 * `shouldTakeOverStdout = appMode !== "interactive"`), and interactive mode
 * does not intercept extensions' console output. So the line lands on the
 * TUI's alt screen at the hardware cursor (the column after `❯ ` in the
 * editor); pi-tui's diff renderer considers those rows unchanged and never
 * repaints — the dirty text stays.
 * Repro: `pi -ne -e` with a probe extension that console.warns one
 * `[pi-subagents] …` line after 2.5s — `tmux capture-pane` shows the same
 * dirty row 6s later.
 *
 * This extension does exactly one thing: in a **UI-bearing process**, wrap
 * process.stderr.write — anything starting with `[pi-subagents]` (the check
 * is in filter.ts) never reaches the terminal.
 *   - Default: drop — those diagnostics ("the host did not provide the
 *     extension tools your tools: declares" and friends) are non-fatal, and
 *     their cost is that smear on screen; dropping is cleanest.
 *   - `PI_SUBAGENT_LOG_GUARD=notify`: instead of dropping, route through
 *     ctx.ui.notify(..., "warning") — pi does the layout itself: the
 *     information survives without smearing. Use it to keep parent-side
 *     errors like "async spawn failed".
 *   - `PI_SUBAGENT_LOG_GUARD=off`: the net is not installed (the old dirty
 *     rows are back) — for investigating "who printed this line".
 *   - Processes with `ctx.hasUI === false` (RPC / print / cron / async
 *     subagent runners) get **no net**: no TUI exists to pollute, and an
 *     async subagent's diagnostics still land in `runner.stderr.log` —
 *     behavior identical to before.
 *   - Only this prefix is intercepted: everything else written to stderr
 *     (pi's own crash handler, other extensions) passes through.
 *
 * A foreground subagent runs **in-process** (`runs/shared/child-session.ts`
 * builds its session with pi's createAgentSession and shares the host's
 * ModelRuntime), so a console.warn from any extension inside the child
 * session passes this net too.
 *
 * Why not sidestep the trigger instead (avoid agents declaring extension
 * tools in tools:, like the built-in researcher): that means giving up a
 * whole class of agents, and the trap's general form is "any extension's
 * console.warn in interactive mode smears" — pi-subagents merely happens to
 * do it often. The upstream fix is `if (!ctx.hasUI)` at the call sites (pi
 * core writes it that way) or routing via ctx.ui.notify; this extension is
 * the local safety net — once upstream fixes it, it simply catches nothing,
 * with no side effects.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chunkToText, splitSubagentDiagnostics } from "./filter.ts";

/** /reload re-executes this file; only one wrapped write may exist, so the state lives on a process symbol for reuse. */
const STATE_KEY = Symbol.for("pi.subagent-log-guard.state");

/** The three modes: unset/other = drop (default); `notify` = route into pi's notifications; `off` = never install. */
const MODE = (process.env.PI_SUBAGENT_LOG_GUARD ?? "").trim().toLowerCase();
const DISABLED = MODE === "off";
const NOTIFY_MODE = MODE === "notify";

interface GuardState {
	/** The notification sink of the current session; undefined without an active session (= drop). */
	sink: ((text: string) => void) | undefined;
	/** How many diagnostics were intercepted — for forensics only (never shown, never persisted). */
	captured: number;
}

function guardState(): GuardState | undefined {
	return (globalThis as unknown as Record<symbol, GuardState | undefined>)[STATE_KEY];
}

/**
 * Wrap process.stderr.write. Idempotent: `/reload` reuses one state — no
 * nested layers.
 * Passing through forwards the args verbatim (chunk / encoding / callback) —
 * fully transparent to pi and other extensions.
 */
function installGuard(): GuardState {
	const existing = guardState();
	if (existing) return existing;

	const state: GuardState = { sink: undefined, captured: 0 };
	const originalWrite = process.stderr.write.bind(process.stderr);

	// the signature forwards Node's write(chunk, encoding?, callback?) verbatim; on interception the callback is invoked
	// anyway — or the caller (console internals / other extensions) would think it never flushed. Async per Node's convention.
	const guard = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		const { passThrough, captured } = splitSubagentDiagnostics(chunkToText(chunk));
		if (captured.length === 0) {
			return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
		}
		state.captured += captured.length;
		const text = captured.join(" ").trim();
		if (text) state.sink?.(text);
		const callback = rest.find((arg) => typeof arg === "function") as
			| ((error?: Error | null) => void)
			| undefined;
		if (callback) queueMicrotask(() => callback(null));
		return true;
	};

	process.stderr.write = guard as typeof process.stderr.write;
	(globalThis as unknown as Record<symbol, GuardState | undefined>)[STATE_KEY] = state;
	return state;
}

export default function subagentLogGuard(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		// UI-less processes (RPC / print / async runners) need no net: stderr is their log outlet anyway.
		if (DISABLED || !ctx.hasUI) return;
		const state = installGuard();
		state.sink = NOTIFY_MODE
			? (text) => {
					try {
						ctx.ui.notify(text, "warning");
					} catch {
						// the ctx may already be dead inside a session-swap window — dropping one line beats crashing the host.
					}
				}
			: undefined;
	});

	pi.on("session_shutdown", () => {
		const state = guardState();
		if (state) state.sink = undefined;
	});
}
