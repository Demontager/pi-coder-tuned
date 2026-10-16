/**
 * goal.ts — /goal's pure state machine: set / clear / rebuild from session entries / whether
 * this turn should evaluate.
 *
 * The CC prototype (code.claude.com/docs/en/goal, verified):
 *   - `/goal <condition>` sets a **session-scoped** completion condition — one goal per
 *     session at a time; setting it starts a turn immediately ("Setting a goal starts a
 *     turn immediately").
 *   - Afterwards **every turn end auto-evaluates**: the condition + the conversation so far
 *     go to a small fast model — three verdicts: not met (keep going, the reason is the next
 *     round's guidance) / met (clear and record) / impossible (clear and record the failure).
 *   - Guardrails: several consecutive turns of text-only replies with no tool calls = no
 *     progress → stop the loop, warn, **keep the goal** ("stops the loop, prints a warning,
 *     and returns control to you with the goal still set"); a subagent/background command
 *     still running → skip this turn's evaluation.
 *   - resume restores the goal but **resets the turn counting**; `/goal clear` clears;
 *     `/clear`'s new session clears; the condition caps at 4000 chars.
 *
 * ## Why the counters are read from the projection, not memory
 *
 * Same reason as gate.ts: `agent_start` fires again on every boundary continuation
 * (`emit({type:"agent_start"})` in `runAgentLoopContinue`), so any reset hung on
 * agent_start would zero the count in the continuation chain and the cap would never work.
 * So "how many continuations" and "the consecutive no-progress streak" are counted from the
 * injected messages already in the projection — naturally branch-correct, correct after
 * resume, no mutable state.
 *
 * Only the goal itself persists (condition + status + evaluated turns + latest verdict),
 * via `pi.appendEntry` (same as simple-task / plan-mode); `session_start` rebuilds it from
 * `getBranch()` — so resume naturally restores and a new session naturally clears, matching
 * CC's resume semantics.
 *
 * This file imports no pi — all pure functions, directly `node --test`-able.
 */

import { countInjected, findRunStart, scanRun, VERIFY_LOOP_CUSTOM_TYPE, type GateMessage } from "./gate.ts";

/** The evaluator's three verdicts (CC's not yet met / met / impossible). */
export type Verdict = "met" | "not_met" | "impossible";

/** The goal's lifecycle status (the persisted part). */
export type GoalStatus = "active" | "achieved" | "impossible";

export interface GoalState {
	/** The user's completion condition verbatim; empty = no goal. */
	condition: string;
	/** When it was set (ms). */
	setAt: number;
	status: GoalStatus;
	/** How many turns have been evaluated (CC status's "how many turns have been evaluated"). */
	evaluatedTurns: number;
	/** The latest verdict and reason (CC status's "the evaluator's most recent reason"). */
	lastVerdict?: Verdict;
	lastReason?: string;
}

/** The empty state: no goal. */
export function emptyGoal(): GoalState {
	return { condition: "", setAt: 0, status: "active", evaluatedTurns: 0 };
}

/** Whether a goal is still running (false after achieved/impossible — no more evaluation). */
export function hasGoal(state: GoalState): boolean {
	return state.condition !== "" && state.status === "active";
}

/** CC's condition-length cap. */
export const MAX_CONDITION_CHARS = 4000;

/** The consecutive no-tool-call turns cap (CC: "no tool use for several turns in a row"). */
export const NO_PROGRESS_LIMIT = 2;

/** The forced-continuation cap (CC's Stop-hook block cap default). */
export const DEFAULT_GOAL_CAP = 8;

export interface GoalConfig {
	/** The forced-continuation cap. */
	cap: number;
}

/** The aliases /goal clear accepts (CC: stop / off / reset / none / cancel). */
export const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

/** Set a goal: a new condition replaces the old (CC: "If a goal is already active, the new one replaces it"). */
export function setGoal(condition: string, now: number): GoalState {
	return {
		condition: condition.slice(0, MAX_CONDITION_CHARS),
		setAt: now,
		status: "active",
		evaluatedTurns: 0,
	};
}

/** Clear the goal. */
export function clearGoal(): GoalState {
	return emptyGoal();
}

/** The new state after applying a verdict (achieved/impossible clears it — CC: "clears the goal and records an entry"). */
export function applyVerdict(state: GoalState, verdict: Verdict, reason: string): GoalState {
	const evaluatedTurns = state.evaluatedTurns + 1;
	if (verdict === "met") return { ...state, status: "achieved", evaluatedTurns, lastVerdict: verdict, lastReason: reason };
	if (verdict === "impossible") return { ...state, status: "impossible", evaluatedTurns, lastVerdict: verdict, lastReason: reason };
	return { ...state, status: "active", evaluatedTurns, lastVerdict: verdict, lastReason: reason };
}

// =============================================================================
// Whether this turn should evaluate (derived entirely from the projection)
// =============================================================================

export type GoalGateAction =
	/** No active goal. */
	| { action: "none" }
	/** Continuations hit the cap: stop the loop, hand control back, keep the goal. */
	| { action: "cap"; continuations: number }
	/** Several consecutive turns with no tool calls: stop the loop, warn, keep the goal (CC's no-progress detection). */
	| { action: "halt"; streak: number }
	/** OK to evaluate. */
	| { action: "evaluate"; continuations: number; toolCallCount: number };

/**
 * Continuations so far = the count of `goal-not-met` injected messages in the run window.
 */
export function countContinuations(messages: readonly GateMessage[]): number {
	return countInjected(messages, "goal-not-met");
}

/**
 * Consecutive turns with "no tool calls at all".
 *
 * Split the run window at each `goal-not-met` injection point: from each injection to the
 * next is one continuation round. Counting backwards from the last segment until a segment
 * contains a tool call.
 *
 * The first segment (before any injection) does not count — that is the initial turn where
 * the goal was set; no-progress detection targets only continuation rounds "after the
 * evaluator sent it back" (CC: "If Claude keeps answering the evaluator without making
 * progress (no tool use for several turns in a row)").
 */
export function countNoProgressStreak(messages: readonly GateMessage[]): number {
	const runStart = findRunStart(messages);
	const marks: number[] = [];
	for (let i = runStart + 1; i < messages.length; i += 1) {
		const message = messages[i];
		if (message.role !== "custom" || message.customType !== VERIFY_LOOP_CUSTOM_TYPE) continue;
		const details = message.details as { kind?: unknown } | undefined;
		if (details?.kind === "goal-not-met") marks.push(i);
	}

	let streak = 0;
	for (let i = marks.length - 1; i >= 0; i -= 1) {
		const scan = scanRun(messages, undefined, marks[i]);
		if (scan.toolCallCount > 0) break;
		streak += 1;
	}
	return streak;
}

/**
 * Whether this turn should evaluate.
 *
 * Skipping when a background subagent is running lives in index.ts — that needs the
 * pi-subagents RPC and is not a pure function's job (CC: "If a subagent or a background
 * shell command is still running when a turn ends, Claude Code skips the evaluation for
 * that turn").
 */
export function decideGoalGate(state: GoalState, messages: readonly GateMessage[], config: GoalConfig): GoalGateAction {
	if (!hasGoal(state)) return { action: "none" };

	const continuations = countContinuations(messages);
	if (continuations >= config.cap) return { action: "cap", continuations };

	const streak = countNoProgressStreak(messages);
	if (streak >= NO_PROGRESS_LIMIT) return { action: "halt", streak };

	const runStart = findRunStart(messages);
	const toolCallCount = scanRun(messages, undefined, runStart).toolCallCount;
	return { action: "evaluate", continuations, toolCallCount };
}

// =============================================================================
// Injected text
// =============================================================================

/** The continuation instruction injected on not-met (CC: the reason serves as the next round's guidance). */
export function renderNotMetMessage(state: GoalState, reason: string, config: GoalConfig, continuations: number): string {
	return (
		`/goal evaluation: condition not yet met (continuations: ${continuations + 1}/${config.cap}, evaluated turns: ${state.evaluatedTurns + 1}).
` +
		`Condition: ${state.condition}\n` +
		`Evaluator reason: ${reason}\n` +
		`Continue working based on this feedback. The evaluator only reads the conversation and cannot run commands, so **evidence must appear in your output** ` +
		`(run commands and show their output), otherwise the next evaluation will still fail.`
	);
}

/** The transcript entry recorded on met / impossible (CC: records an achieved / failed entry). */
export function renderTerminalMessage(state: GoalState, verdict: Verdict, reason: string): string {
	if (verdict === "met") {
		return `/goal achieved ✔ (evaluated turns: ${state.evaluatedTurns})
Condition: ${state.condition}
Reason: ${reason}`;
	}
	return `/goal deemed impossible; cleared ✘
Condition: ${state.condition}
Reason: ${reason}`;
}

/** Stopping the loop on no progress (CC: stops the loop, prints a warning, goal still set). */
export function renderHaltMessage(state: GoalState, streak: number): string {
	return (
		`/goal paused: ${streak} consecutive turns without tool calls; no progress detected. Control returned to you; the condition is retained.
` +
		`Condition: ${state.condition}\n` +
		`Send another message to resume evaluation, or use /goal clear to remove it.`
	);
}

/** Hitting the cap (CC: force-ends the turn after N consecutive blocks). */
export function renderCapMessage(state: GoalState, config: GoalConfig): string {
	return (
		`/goal continued ${config.cap} times without success; automatic looping stopped and control returned to you. The condition is retained.
` +
		`Condition: ${state.condition}
Use /goal for status, or /goal clear to remove it.`
	);
}

// =============================================================================
// Rebuilding from session entries (appendEntry → getBranch())
// =============================================================================

/** appendEntry's customType. */
export const GOAL_ENTRY_TYPE = "verify-loop-goal";

/** The persisted shape. */
export interface GoalEntryData {
	condition: string;
	setAt: number;
	status: GoalStatus;
	evaluatedTurns: number;
	lastVerdict?: Verdict;
	lastReason?: string;
}

export function toEntryData(state: GoalState): GoalEntryData {
	return {
		condition: state.condition,
		setAt: state.setAt,
		status: state.status,
		evaluatedTurns: state.evaluatedTurns,
		lastVerdict: state.lastVerdict,
		lastReason: state.lastReason,
	};
}

/**
 * Rebuild the goal from session-branch entries. Takes the last — each entry is a full
 * snapshot.
 *
 * An achieved/impossible goal is not restored (CC: "does not restore a goal that was already
 * achieved or cleared"). The turn counting resets too (CC: "carries the condition over but
 * resets the turn count, timer, and token-spend baseline") — only the condition itself is
 * carried; continuation/no-progress counts are projection-derived and always start at 0.
 */
export function reconstructGoal(entries: readonly unknown[]): GoalState {
	let latest: GoalEntryData | undefined;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (record.type !== "custom" || record.customType !== GOAL_ENTRY_TYPE) continue;
		const data = record.data as GoalEntryData | undefined;
		if (data && typeof data.condition === "string") latest = data;
	}
	if (latest === undefined || latest.condition === "") return emptyGoal();
	if (latest.status !== "active") return emptyGoal();
	return {
		condition: latest.condition,
		setAt: typeof latest.setAt === "number" ? latest.setAt : 0,
		status: "active",
		evaluatedTurns: 0,
		lastVerdict: latest.lastVerdict,
		lastReason: latest.lastReason,
	};
}

/** The status text for a bare /goal (CC status: condition, duration, turns, latest reason). */
export function renderStatus(state: GoalState, now: number, config: GoalConfig, continuations: number): string {
	if (state.condition === "") return "No /goal set. Usage: /goal <completion condition>; /goal clear removes it.";
	const minutes = state.setAt > 0 ? Math.max(0, Math.round((now - state.setAt) / 60_000)) : 0;
	const lines = [
		`◎ /goal ${state.status === "active" ? "active" : state.status}`,
		`Condition: ${state.condition}`,
		`Running for ${minutes} minutes, evaluated ${state.evaluatedTurns} turns, continuations ${continuations}/${config.cap} times`,
	];
	if (state.lastVerdict !== undefined) {
		lines.push(`Latest verdict: ${state.lastVerdict}${state.lastReason ? ` —— ${state.lastReason}` : ""}`);
	}
	return lines.join("\n");
}
