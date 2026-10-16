/**
 * Checks for goal.ts: the pure state machine, directly `node --test`.
 *
 *   node --test clients/pi/extensions/verify-loop/goal.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { VERIFY_LOOP_CUSTOM_TYPE, type GateMessage } from "./gate.ts";
import {
	applyVerdict,
	clearGoal,
	CLEAR_ALIASES,
	countContinuations,
	countNoProgressStreak,
	decideGoalGate,
	DEFAULT_GOAL_CAP,
	emptyGoal,
	GOAL_ENTRY_TYPE,
	hasGoal,
	MAX_CONDITION_CHARS,
	NO_PROGRESS_LIMIT,
	reconstructGoal,
	renderStatus,
	setGoal,
	toEntryData,
	type GoalState,
} from "./goal.ts";

// =============================================================================
// Helpers building projection messages
// =============================================================================

function user(text: string): GateMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistantToolCalls(...calls: Array<{ name: string; args?: Record<string, unknown> }>): GateMessage {
	return {
		role: "assistant",
		content: calls.map((call, index) => ({
			type: "toolCall",
			id: `call-${index}-${call.name}`,
			name: call.name,
			arguments: call.args ?? {},
		})),
	};
}

function assistantText(text: string): GateMessage {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function injected(kind: string): GateMessage {
	return { role: "custom", customType: VERIFY_LOOP_CUSTOM_TYPE, content: "...", details: { kind, at: 1 } };
}

const config = { cap: DEFAULT_GOAL_CAP };

function activeGoal(condition = "all tests pass"): GoalState {
	return setGoal(condition, 1_700_000_000_000);
}

// =============================================================================
// setGoal / clearGoal / hasGoal
// =============================================================================

test("setGoal: the condition is clipped to CC's 4000-char cap", () => {
	const state = setGoal("x".repeat(MAX_CONDITION_CHARS + 100), 1);
	assert.equal(state.condition.length, MAX_CONDITION_CHARS);
	assert.equal(state.status, "active");
	assert.equal(state.evaluatedTurns, 0);
});

test("clearGoal: back to the empty state, hasGoal false", () => {
	assert.equal(hasGoal(activeGoal()), true);
	assert.equal(hasGoal(clearGoal()), false);
});

test("CLEAR_ALIASES: CC's stop/off/reset/none/cancel are all there", () => {
	for (const alias of ["clear", "stop", "off", "reset", "none", "cancel"]) {
		assert.equal(CLEAR_ALIASES.has(alias), true, alias);
	}
});

// =============================================================================
// applyVerdict
// =============================================================================

test("applyVerdict: not_met stays active, evaluated turns +1", () => {
	const state = applyVerdict(activeGoal(), "not_met", "tests not run yet");
	assert.equal(state.status, "active");
	assert.equal(state.evaluatedTurns, 1);
	assert.equal(state.lastVerdict, "not_met");
	assert.equal(state.lastReason, "tests not run yet");
	assert.equal(hasGoal(state), true);
});

test("applyVerdict: met → achieved, no more evaluation", () => {
	const state = applyVerdict(activeGoal(), "met", "test output shows all passing");
	assert.equal(state.status, "achieved");
	assert.equal(hasGoal(state), false);
});

test("applyVerdict: impossible → impossible, no more evaluation", () => {
	const state = applyVerdict(activeGoal(), "impossible", "the target file does not exist");
	assert.equal(state.status, "impossible");
	assert.equal(hasGoal(state), false);
});

// =============================================================================
// decideGoalGate: every count is derived from the projection
// =============================================================================

test("decideGoalGate: no goal → none", () => {
	assert.deepEqual(decideGoalGate(emptyGoal(), [user("a")], config), { action: "none" });
});

test("decideGoalGate: an achieved goal → none", () => {
	const state = applyVerdict(activeGoal(), "met", "done");
	assert.deepEqual(decideGoalGate(state, [user("a")], config), { action: "none" });
});

test("decideGoalGate: normally evaluable", () => {
	const messages = [user("a"), assistantToolCalls({ name: "bash", args: { command: "npm test" } })];
	const gate = decideGoalGate(activeGoal(), messages, config);
	assert.equal(gate.action, "evaluate");
	if (gate.action === "evaluate") {
		assert.equal(gate.continuations, 0);
		assert.equal(gate.toolCallCount, 1);
	}
});

test("countContinuations: counts goal-not-met injections inside the run window", () => {
	const messages = [user("a"), injected("goal-not-met"), assistantText("continue"), injected("goal-not-met"), assistantText("retry")];
	assert.equal(countContinuations(messages), 2);
});

test("decideGoalGate: continuations at the cap → cap (CC's forced release)", () => {
	const messages = [user("a")];
	for (let i = 0; i < DEFAULT_GOAL_CAP; i += 1) {
		messages.push(injected("goal-not-met"), assistantText("continue"));
	}
	const gate = decideGoalGate(activeGoal(), messages, config);
	assert.equal(gate.action, "cap");
});

test("countNoProgressStreak: the initial turn does not count (the turn the goal was set)", () => {
	const messages = [user("a"), assistantText("I think it is done already")];
	assert.equal(countNoProgressStreak(messages), 0);
});

test("countNoProgressStreak: text-only after a bounce-back → 1", () => {
	const messages = [user("a"), injected("goal-not-met"), assistantText("I think it is done already")];
	assert.equal(countNoProgressStreak(messages), 1);
});

test("countNoProgressStreak: tools used after a bounce-back → 0", () => {
	const messages = [
		user("a"),
		injected("goal-not-met"),
		assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
	];
	assert.equal(countNoProgressStreak(messages), 0);
});

test("countNoProgressStreak: two consecutive tool-less rounds → 2", () => {
	const messages = [
		user("a"),
		injected("goal-not-met"),
		assistantText("done"),
		injected("goal-not-met"),
		assistantText("really done"),
	];
	assert.equal(countNoProgressStreak(messages), 2);
});

test("countNoProgressStreak: a tool-using round in the middle → only the last stretch counts", () => {
	const messages = [
		user("a"),
		injected("goal-not-met"),
		assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
		injected("goal-not-met"),
		assistantText("done"),
	];
	assert.equal(countNoProgressStreak(messages), 1);
});

test("decideGoalGate: no progress to the cap → halt (goal kept)", () => {
	const messages = [user("a")];
	for (let i = 0; i < NO_PROGRESS_LIMIT; i += 1) {
		messages.push(injected("goal-not-met"), assistantText("done"));
	}
	const gate = decideGoalGate(activeGoal(), messages, config);
	assert.equal(gate.action, "halt");
	if (gate.action === "halt") assert.equal(gate.streak, NO_PROGRESS_LIMIT);
});

// =============================================================================
// Rebuilding from session entries (appendEntry → getBranch())
// =============================================================================

test("reconstructGoal: takes the last snapshot from the branch entries", () => {
	const entries = [
		{ type: "custom", customType: GOAL_ENTRY_TYPE, data: toEntryData(setGoal("old condition", 1)) },
		{ type: "custom", customType: GOAL_ENTRY_TYPE, data: toEntryData(setGoal("new condition", 2)) },
		{ type: "custom", customType: "simple-task-state", data: {} },
	];
	const state = reconstructGoal(entries);
	assert.equal(state.condition, "new condition");
	assert.equal(state.status, "active");
});

test("reconstructGoal: an achieved/impossible goal is not restored (CC semantics)", () => {
	const achieved = applyVerdict(setGoal("condition", 1), "met", "done");
	assert.equal(reconstructGoal([{ type: "custom", customType: GOAL_ENTRY_TYPE, data: toEntryData(achieved) }]).condition, "");
	const impossible = applyVerdict(setGoal("condition", 1), "impossible", "nope");
	assert.equal(reconstructGoal([{ type: "custom", customType: GOAL_ENTRY_TYPE, data: toEntryData(impossible) }]).condition, "");
});

test("reconstructGoal: turn counting resets (CC: resume resets the turn count)", () => {
	const entries = [{ type: "custom", customType: GOAL_ENTRY_TYPE, data: { ...toEntryData(setGoal("condition", 1)), evaluatedTurns: 5 } }];
	const state = reconstructGoal(entries);
	assert.equal(state.condition, "condition");
	assert.equal(state.evaluatedTurns, 0);
	assert.equal(state.lastVerdict, undefined);
	// continuation/no-progress counts come from the projection — unrelated to the rebuild
	const messages = [user("a"), injected("goal-not-met")];
	assert.equal(countContinuations(messages), 1);
});

test("reconstructGoal: no entries / empty condition → empty state", () => {
	assert.equal(reconstructGoal([]).condition, "");
	assert.equal(reconstructGoal([{ type: "custom", customType: GOAL_ENTRY_TYPE, data: { condition: "" } }]).condition, "");
});

// =============================================================================
// renderStatus
// =============================================================================

test("renderStatus: no goal → usage hint", () => {
	assert.match(renderStatus(emptyGoal(), 0, config, 0), /No/);
});

test("renderStatus: a goal → condition and counts", () => {
	const text = renderStatus(activeGoal("all tests pass"), 1_700_000_120_000, config, 3);
	assert.match(text, /all tests pass/);
	assert.match(text, /continuations 3\/8/);
	assert.match(text, /evaluated 0 turns/);
});
