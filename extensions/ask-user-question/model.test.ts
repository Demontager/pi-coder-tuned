/**
 * Tests for model.ts — the questionnaire state machine (a pure reducer).
 *
 * Run with:  node --test clients/pi/extensions/ask-user-question/model.test.ts
 *
 * Covers: single-select submit ends it (a single question has no submit
 * page), digit keys, multi-select toggling/submitting, free input (incl. an
 * empty one backing out), cancel, multi-question advancing and the
 * submit-page gate, Tab wrap-around, cursor restore on re-answer, the
 * sentinel row, and boundaries (up/down clamping, Space inert on
 * single-select, digit keys inert on the submit page).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	allAnswered,
	createState,
	hasSubmitTab,
	isSubmitTab,
	reduce,
	rowCount,
	unansweredHeaders,
	type Outcome,
} from "./model.ts";
import type { AskParams } from "./types.ts";

function option(label: string) {
	return { label, description: `${label} desc` };
}

function singleParams(): AskParams {
	return {
		questions: [
			{ question: "Which library?", header: "Lib", options: [option("date-fns"), option("dayjs"), option("luxon")] },
		],
	};
}

function multiSelectParams(): AskParams {
	return {
		questions: [
			{
				question: "Which features?",
				header: "Feat",
				multiSelect: true,
				options: [option("X"), option("Y"), option("Z")],
			},
		],
	};
}

function twoParams(): AskParams {
	return {
		questions: [
			{ question: "Q1?", header: "One", options: [option("a"), option("b")] },
			{ question: "Q2?", header: "Two", options: [option("c"), option("d")] },
		],
	};
}

function submitted(outcome: Outcome) {
	assert.equal(outcome.status, "submit");
	if (outcome.status !== "submit") throw new Error("unreachable");
	return outcome.result;
}

test("a single question has no submit page; rows = options + 1 (the sentinel)", () => {
	const state = createState(singleParams());
	assert.equal(hasSubmitTab(state), false);
	assert.equal(isSubmitTab(state), false);
	assert.equal(rowCount(state), 4);
	assert.equal(allAnswered(state), false);
	assert.deepEqual(unansweredHeaders(state), ["Lib"]);
});

test("single-select: Enter on an option → submits directly (a single question has no submit page)", () => {
	const state = createState(singleParams());
	reduce(state, { type: "down" }); // cursor = 1 → dayjs
	const result = submitted(reduce(state, { type: "confirm" }));
	assert.equal(result.cancelled, false);
	assert.deepEqual(result.answers, [
		{ questionIndex: 0, question: "Which library?", kind: "option", answer: "dayjs" },
	]);
});

test("single-select: a digit key picks and submits directly", () => {
	const state = createState(singleParams());
	const result = submitted(reduce(state, { type: "digit", digit: 3 }));
	assert.equal(result.answers[0].answer, "luxon");
});

test("single-select: a digit on the sentinel row → free input", () => {
	const state = createState(singleParams());
	const outcome = reduce(state, { type: "digit", digit: 4 });
	assert.equal(outcome.status, "enterInput");
	assert.equal(state.inputMode, true);
	assert.equal(state.cursor, 3);
});

test("single-select: an out-of-range digit does nothing", () => {
	const state = createState(singleParams());
	const outcome = reduce(state, { type: "digit", digit: 9 });
	assert.equal(outcome.status, "continue");
	assert.equal(state.cursor, 0);
});

test("up/down keys clamp to [0, rowCount-1]", () => {
	const state = createState(singleParams());
	reduce(state, { type: "up" });
	assert.equal(state.cursor, 0);
	for (let i = 0; i < 10; i++) reduce(state, { type: "down" });
	assert.equal(state.cursor, 3);
});

test("Space toggles nothing on single-select", () => {
	const state = createState(singleParams());
	const outcome = reduce(state, { type: "toggle" });
	assert.equal(outcome.status, "continue");
	assert.deepEqual(state.toggles[0], [false, false, false]);
});

test("multi-select: Space checks + Enter submits the picks", () => {
	const state = createState(multiSelectParams());
	reduce(state, { type: "toggle" }); // X
	reduce(state, { type: "down" });
	reduce(state, { type: "down" });
	reduce(state, { type: "toggle" }); // Z
	const result = submitted(reduce(state, { type: "confirm" }));
	assert.deepEqual(result.answers[0], {
		questionIndex: 0,
		question: "Which features?",
		kind: "multi",
		answer: null,
		selected: ["X", "Z"],
	});
});

test("multi-select: a digit key flips the toggle and moves the cursor", () => {
	const state = createState(multiSelectParams());
	reduce(state, { type: "digit", digit: 2 });
	assert.equal(state.cursor, 1);
	assert.deepEqual(state.toggles[0], [false, true, false]);
	reduce(state, { type: "digit", digit: 2 }); // pressing again unchecks
	assert.deepEqual(state.toggles[0], [false, false, false]);
});

test("multi-select: Enter with nothing checked → an empty selected array still submits", () => {
	const state = createState(multiSelectParams());
	const result = submitted(reduce(state, { type: "confirm" }));
	assert.deepEqual(result.answers[0].selected, []);
});

test("Enter on the sentinel row → free input; typed text submits as custom", () => {
	const state = createState(singleParams());
	for (let i = 0; i < 3; i++) reduce(state, { type: "down" }); // the sentinel row
	const enter = reduce(state, { type: "confirm" });
	assert.equal(enter.status, "enterInput");
	const result = submitted(reduce(state, { type: "inputSubmit", text: "  use luxon  " }));
	assert.deepEqual(result.answers[0], {
		questionIndex: 0,
		question: "Which library?",
		kind: "custom",
		answer: "use luxon",
	});
	assert.equal(state.inputMode, false);
});

test("empty free input → back to the option list, no answer produced", () => {
	const state = createState(singleParams());
	for (let i = 0; i < 3; i++) reduce(state, { type: "down" });
	reduce(state, { type: "confirm" }); // enterInput
	const outcome = reduce(state, { type: "inputSubmit", text: "   " });
	assert.equal(outcome.status, "exitInput");
	assert.equal(state.inputMode, false);
	assert.equal(state.answers[0], undefined);
});

test("inputCancel returns to the option list", () => {
	const state = createState(singleParams());
	for (let i = 0; i < 3; i++) reduce(state, { type: "down" });
	reduce(state, { type: "confirm" });
	const outcome = reduce(state, { type: "inputCancel" });
	assert.equal(outcome.status, "exitInput");
	assert.equal(state.inputMode, false);
});

test("cancel: the answered portion leaves with the cancel result", () => {
	const state = createState(twoParams());
	reduce(state, { type: "confirm" }); // answered Q1
	const outcome = reduce(state, { type: "cancel" });
	assert.equal(outcome.status, "cancel");
	if (outcome.status !== "cancel") throw new Error("unreachable");
	assert.equal(outcome.result.cancelled, true);
	assert.equal(outcome.result.answers.length, 1);
	assert.equal(outcome.result.answers[0].answer, "a");
});

test("multi-question: answering Q1 goes to Q2, answering Q2 goes to the submit page", () => {
	const state = createState(twoParams());
	assert.equal(state.currentTab, 0);
	const after1 = reduce(state, { type: "confirm" });
	assert.equal(after1.status, "continue");
	assert.equal(state.currentTab, 1);
	const after2 = reduce(state, { type: "confirm" });
	assert.equal(after2.status, "continue");
	assert.equal(isSubmitTab(state), true);
	assert.equal(allAnswered(state), true);
	const result = submitted(reduce(state, { type: "confirm" }));
	assert.deepEqual(
		result.answers.map((a) => a.answer),
		["a", "c"],
	);
});

test("the submit-page gate: unanswered questions → Enter does not submit", () => {
	const state = createState(twoParams());
	reduce(state, { type: "confirm" }); // Q1
	reduce(state, { type: "nextTab" }); // skip Q2 to the submit page
	assert.equal(isSubmitTab(state), true);
	assert.deepEqual(unansweredHeaders(state), ["Two"]);
	const outcome = reduce(state, { type: "confirm" });
	assert.equal(outcome.status, "continue");
});

test("Tab wraps (incl. the submit page); switching resets the cursor and restores it from the existing answer", () => {
	const state = createState(twoParams());
	reduce(state, { type: "down" }); // Q1 cursor=1 (option b)
	reduce(state, { type: "nextTab" });
	assert.equal(state.currentTab, 1);
	assert.equal(state.cursor, 0);
	reduce(state, { type: "nextTab" });
	assert.equal(isSubmitTab(state), true);
	reduce(state, { type: "nextTab" }); // wraps back to Q1
	assert.equal(state.currentTab, 0);
	// Q1 unanswered — the cursor returns to 0
	assert.equal(state.cursor, 0);
});

test("re-answering an answered single-select: the cursor returns to the old option", () => {
	const state = createState(twoParams());
	reduce(state, { type: "down" }); // cursor=1
	reduce(state, { type: "confirm" }); // answer b, on to Q2
	reduce(state, { type: "prevTab" }); // back to Q1
	assert.equal(state.currentTab, 0);
	assert.equal(state.cursor, 1); // parked on b
	// a re-answer overwrites the old value
	const outcome = reduce(state, { type: "up" }); // cursor=0 → a
	assert.equal(outcome.status, "continue");
	reduce(state, { type: "confirm" });
	assert.equal(state.answers[0]?.answer, "a");
});

test("re-answering a custom answer: the cursor returns to the sentinel row", () => {
	const state = createState(twoParams());
	reduce(state, { type: "down" });
	reduce(state, { type: "down" }); // the sentinel row
	reduce(state, { type: "confirm" }); // enterInput
	reduce(state, { type: "inputSubmit", text: "custom" }); // answer submitted, on to Q2
	reduce(state, { type: "prevTab" });
	assert.equal(state.cursor, 2); // Q1's sentinel row = options.length
});

test("digit keys / Space do nothing on the submit page", () => {
	const state = createState(twoParams());
	reduce(state, { type: "confirm" });
	reduce(state, { type: "confirm" });
	assert.equal(isSubmitTab(state), true);
	assert.equal(reduce(state, { type: "digit", digit: 1 }).status, "continue");
	assert.equal(reduce(state, { type: "toggle" }).status, "continue");
	assert.equal(reduce(state, { type: "up" }).status, "continue");
});

test("Tab does nothing in single-question mode", () => {
	const state = createState(singleParams());
	assert.equal(reduce(state, { type: "nextTab" }).status, "continue");
	assert.equal(state.currentTab, 0);
});
