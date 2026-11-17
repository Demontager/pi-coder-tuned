/**
 * gate.ts — the verification gate's pure judgment: "files were changed this turn, but no
 * verification command ran after the last change" → block.
 *
 * This is the pi equivalent of CC's `Stop` hook in its deterministic (`type: "command"`)
 * shape: CC fires Stop at every turn end and a `{"decision":"block","reason":...}` result
 * prevents finishing; pi's landing point is `agent_before_settle` returning
 * `{entries, continue:true}` (`agent-session.js:1142` `_runBeforeSettleBoundary`). This file
 * only judges — no events, no pi — so it is directly `node --test`-able.
 *
 * ## The judgment input
 *
 * The `agent_before_settle` event's `context.contextMessages` (the model-visible projection,
 * built by `agent-session.js:_buildBoundaryContext`) — **naturally branch-correct**: branches
 * dropped by rewind/navigation are absent from the projection, so no incremental state is
 * needed.
 *
 * ## What counts as "this turn", and why block counts are read from the projection too
 *
 * All messages after **the last `role:"user"` message in the projection** = this run.
 * Why not the whole projection: last turn's test run cannot vouch for this turn's change
 * (verification-before-completion's iron rule is FRESH evidence).
 *
 * The block count (CC's `stop_hook_active` + the 8-strike cap) uses **no in-memory counter —
 * it counts the injected messages already in the projection**. Two reasons:
 *   1. `agent_start` fires again on every boundary continuation (`emit({type:"agent_start"})`
 *      in `runAgentLoopContinue`), so any reset hung on agent_start would zero the count in
 *      the continuation chain and the cap would never work;
 *   2. a value counted from the projection is naturally branch-correct, still correct after
 *      resume, and needs no mutable state.
 *
 * We inject `role:"custom"` messages (not user), so they do **not** cut the run window —
 * the whole continuation chain shares one window, exactly CC's "consecutive blocks within one
 * turn" semantics.
 *
 * ## The mutation / verification criteria (known boundary, same level as destructive-guard's
 * lexical rule)
 *
 * - mutation: a `toolCall` block in an assistant message whose tool name ∈ MUTATION_TOOLS
 *   (`edit` / `write` / `apply_patch` / `multiedit` — the latter two do not exist in pi
 *   0.87.1 built-ins; dist/core/tools/ only has bash/edit/find/grep/ls/powershell/read/write,
 *   so including them costs nothing and covers future or third-party registrations), and the
 *   target path is not pure documentation
 *   (`.md` / `.txt` excluded by default: this repo edits AGENTS.md constantly and the gate
 *   would wear down to noise otherwise).
 * - **Writes inside bash (`sed -i` / redirects / scripts editing files) do not count as
 *   mutations** — lexical judgment does no data-flow analysis; this is a documented known
 *   boundary, not an oversight.
 * - verification: **any single `bash` call** (success or failure both count). Why the rule
 *   is this wide: see "why verification is 'ran a command', not 'ran a test'" below.
 */

/** Minimal duck-type for a projection message (no pi import — stays unit-testable). */
export interface GateMessage {
	role?: unknown;
	customType?: unknown;
	details?: unknown;
	content?: unknown;
}

interface ToolCallBlock {
	name: string;
	arguments: Record<string, unknown>;
}

/** The injected messages' customType (index.ts's registerMessageRenderer uses it too). */
export const VERIFY_LOOP_CUSTOM_TYPE = "verify-loop";

/** The injected message kinds, stored in `details.kind` — block counts are tallied per kind. */
export type InjectKind = "gate" | "goal-not-met" | "goal-met" | "goal-impossible" | "goal-halted" | "goal-cap";

/** Tool names that change files. pi 0.87.1 built-ins only have edit/write; the rest guards future/third-party. */
export const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"]);

/**
 * The strict recognizer: only test/build/lint-shaped commands.
 *
 * **Not the default** — the default rule is "any command run counts" (see below). This
 * constant exists for `PI_VERIFY_PATTERN=strict` and doc references: use it when a
 * "must actually run tests" gate is wanted.
 */
export const STRICT_VERIFY_PATTERN =
	/\b(node\s+--test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+(run\s+)?test|pytest|python3?\s+-m\s+unittest|cargo\s+(test|build|check)|go\s+(test|build|vet)|tsc\b|eslint\b|biome\s+check|ruff\s+check|flake8\b|make\s+(test|build|check))\b/i;

/**
 * The default verification rule: **any bash call counts as evidence** (`verifyPattern` is
 * undefined).
 *
 * ## Why not "must have run a test"
 *
 * The first live smoke run on 2026-09-25 measured the false positive: after editing
 * `probe.js` the model ran
 * `node --input-type=module -e "import('./probe.js').then(m => console.log(m.VALUE))"`
 * — genuinely fresh evidence (imports the changed module, prints the new value), but it
 * matches no test-runner shape, so the gate blocked it a **second** time; the model said
 * "I already ran a verification" and wasted a whole round. Measured on the record, not
 * conjecture.
 *
 * A lexical gate cannot decide "is this command a *relevant* test" — that needs semantic
 * judgment, which is the `/goal` evaluator's job. So the two layers split the work:
 *
 *   - the gate (this file): **was there any observation of actual state after the change**
 *     (a command ran, output was seen). It catches "claims done without running anything" —
 *     exactly the shape issue #12 and verification-before-completion target.
 *   - the `/goal` evaluator: **did that observation prove the condition** (the semantic
 *     layer, CC's prompt hook).
 *
 * The known cost (documented — do not fix as a bug): a plain `ls` also passes the gate.
 * CC's command-type Stop hook is equally coarse — it is the user's own script and cannot
 * judge relevance either.
 * For a strict gate use `PI_VERIFY_PATTERN=strict` (or supply your own regex).
 */
export const DEFAULT_VERIFY_PATTERN: RegExp | undefined = undefined;

/** Pure-doc extensions excluded by default (editing them does not trip the gate). */
export const DEFAULT_DOC_EXTENSIONS = [".md", ".txt"];

export interface GateConfig {
	/** block / notify / off — parsed from env by index.ts and passed in. */
	mode: "block" | "notify" | "off";
	/** The verification-command recognizer; undefined = any bash call counts (default rule, see DEFAULT_VERIFY_PATTERN). */
	verifyPattern: RegExp | undefined;
	/** Pure-doc extensions (editing these is not a mutation). */
	docExtensions: string[];
	/** The consecutive-block cap (CC's general cap is 8; with a single rule the default is 2). */
	blockCap: number;
}

export interface MutationEvent {
	tool: string;
	/** The target path; apply_patch and friends with no single path record undefined. */
	path?: string;
}

export interface GateScan {
	/** Total tool-call count in the scan window (reused by goal's no-progress detection). */
	toolCallCount: number;
	mutations: MutationEvent[];
	/** How many verification commands appear after the last mutation. */
	verificationsAfterLastMutation: number;
}

export type GateDecision =
	| { action: "pass"; reason: string }
	| { action: "block"; mutations: MutationEvent[]; attempt: number; cap: number };

/** Pull a toolCall block's path argument (both edit's and write's schema use `path: string`). */
function toolCallPath(block: ToolCallBlock): string | undefined {
	const path = block.arguments?.path;
	return typeof path === "string" && path !== "" ? path : undefined;
}

function isDocPath(path: string | undefined, docExtensions: string[]): boolean {
	if (path === undefined) return false;
	const lower = path.toLowerCase();
	return docExtensions.some((ext) => lower.endsWith(ext));
}

function asToolCallBlocks(content: unknown): ToolCallBlock[] {
	if (!Array.isArray(content)) return [];
	const blocks: ToolCallBlock[] = [];
	for (const item of content) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as { type?: unknown; name?: unknown; arguments?: unknown };
		if (record.type !== "toolCall" || typeof record.name !== "string") continue;
		blocks.push({
			name: record.name,
			arguments: (typeof record.arguments === "object" && record.arguments !== null
				? record.arguments
				: {}) as Record<string, unknown>,
		});
	}
	return blocks;
}

/**
 * The run window's start: the index of the last `role:"user"` message (excluding itself).
 * With no user message returns -1 (the whole projection counts).
 *
 * Note: our injections are `role:"custom"` — **not** user — so the continuation chain shares
 * one window.
 */
export function findRunStart(messages: readonly GateMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i].role === "user") return i;
	}
	return -1;
}

/**
 * Count how many injected messages of a kind already exist in the projection (from
 * startIndex on).
 * This is CC's "how many consecutive blocks this turn", counted from evidence rather than
 * an in-memory counter.
 */
export function countInjected(messages: readonly GateMessage[], kind: InjectKind, startIndex = findRunStart(messages)): number {
	let count = 0;
	for (let i = startIndex + 1; i < messages.length; i += 1) {
		const message = messages[i];
		if (message.role !== "custom" || message.customType !== VERIFY_LOOP_CUSTOM_TYPE) continue;
		const details = message.details as { kind?: unknown } | undefined;
		if (details?.kind === kind) count += 1;
	}
	return count;
}

/**
 * Scan tool-call events inside the window.
 *
 * `startIndex` defaults to the run window start; goal's no-progress detection passes "after
 * the last injected message" to see only the newest continuation stretch.
 */
export function scanRun(
	messages: readonly GateMessage[],
	config?: Pick<GateConfig, "verifyPattern" | "docExtensions">,
	startIndex?: number,
): GateScan {
	const verifyPattern = config?.verifyPattern ?? DEFAULT_VERIFY_PATTERN;
	const docExtensions = config?.docExtensions ?? [];
	const from = startIndex ?? findRunStart(messages);

	const scan: GateScan = { toolCallCount: 0, mutations: [], verificationsAfterLastMutation: 0 };
	for (let i = from + 1; i < messages.length; i += 1) {
		if (messages[i].role !== "assistant") continue;
		for (const block of asToolCallBlocks(messages[i].content)) {
			scan.toolCallCount += 1;
			if (block.name === "bash") {
				const command = block.arguments.command;
				if (typeof command !== "string") continue;
				// the default rule: any bash call counts as an observation; a configured recognizer limits it to matches.
				if (verifyPattern !== undefined && !verifyPattern.test(command)) continue;
				// order matters: only verifications appearing after the last mutation count
				if (scan.mutations.length > 0) scan.verificationsAfterLastMutation += 1;
				continue;
			}
			if (MUTATION_TOOLS.has(block.name)) {
				const path = toolCallPath(block);
				if (isDocPath(path, docExtensions)) continue;
				scan.mutations.push({ tool: block.name, path });
				// a new mutation expires earlier verifications
				scan.verificationsAfterLastMutation = 0;
			}
		}
	}
	return scan;
}

/**
 * The gate judgment. The caller (index.ts) has already filtered `outcome !== "completed"`
 * (CC: abort does not fire Stop; API errors go through StopFailure).
 */
export function decideGate(messages: readonly GateMessage[], config: GateConfig): GateDecision {
	if (config.mode === "off") return { action: "pass", reason: "off" };

	const alreadyBlocked = countInjected(messages, "gate");
	if (alreadyBlocked >= config.blockCap) return { action: "pass", reason: "cap" };

	const scan = scanRun(messages, config);
	if (scan.mutations.length === 0) return { action: "pass", reason: "no-mutation" };
	if (scan.verificationsAfterLastMutation > 0) return { action: "pass", reason: "verified" };

	return {
		action: "block",
		mutations: scan.mutations,
		attempt: alreadyBlocked + 1,
		cap: config.blockCap,
	};
}

/** The gate's block message (CC's reason — both the model's next instruction and the user-visible "Stop hook feedback"). */
export function renderGateMessage(decision: Extract<GateDecision, { action: "block" }>): string {
	const files = decision.mutations
		.map((mutation) => mutation.path ?? `(${mutation.tool})`)
		.filter((value, index, all) => all.indexOf(value) === index);
	const fileList = files.length > 0 ? files.join(", ") : "(no specific paths identified)";
	return (
		`You claimed completion, but after this run's file changes (${fileList}) no command was run to observe the actual result.
` +
		`Run a command demonstrating correctness (tests / build / lint, or execute the changed code and print the result) ` +
		`and show its output. If verification is genuinely unnecessary, explain why.
` +
		`This is intervention ${decision.attempt}/${decision.cap}; interventions stop at the limit.`
	);
}
