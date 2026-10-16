/**
 * Tests for dialog.ts — the sequential select/input fallback for non-TUI
 * hosts.
 *
 * Run with:  node --test clients/pi/extensions/ask-user-question/dialog.test.ts
 *
 * DialogUI is duck-typed, covered by a scripted fake ui: a single-select
 * picking an option, the sentinel row routing to free input, multi-select
 * number parsing, the free-text escape, empty submits, closing a dialog
 * cancelling (incl. keeping the answered portion), and a host returning
 * off-list content treated as a cancel.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { hasDialogUI, parseIndex, runDialogQuestionnaire, type DialogUI } from "./dialog.ts";
import type { AskParams } from "./types.ts";

/** A scripted fake ui: select/input yield preset values in call order; undefined = the user closed the dialog. */
function fakeUi(script: { select?: Array<string | undefined>; input?: Array<string | undefined> }): DialogUI & {
	calls: { select: string[]; input: string[] };
} {
	const calls = { select: [] as string[], input: [] as string[] };
	return {
		calls,
		async select(title, _options) {
			calls.select.push(title);
			return (script.select ?? []).shift();
		},
		async input(title, _placeholder) {
			calls.input.push(title);
			return (script.input ?? []).shift();
		},
	};
}

const single: AskParams = {
	questions: [
		{
			question: "Which library?",
			header: "Lib",
			options: [
				{ label: "date-fns", description: "functional" },
				{ label: "dayjs", description: "tiny" },
			],
		},
	],
};

const multi: AskParams = {
	questions: [{ ...single.questions[0], question: "Which features?", header: "Feat", multiSelect: true }],
};

const twoQuestions: AskParams = {
	questions: [single.questions[0], { ...single.questions[0], question: "Which style?", header: "Style" }],
};

test("hasDialogUI: structural check", () => {
	assert.equal(hasDialogUI({ select: async () => undefined, input: async () => undefined }), true);
	assert.equal(hasDialogUI({ select: async () => undefined }), false);
	assert.equal(hasDialogUI(null), false);
	assert.equal(hasDialogUI(undefined), false);
});

test("parseIndex: number parsing and out of range", () => {
	assert.equal(parseIndex("1", 3), 0);
	assert.equal(parseIndex("3. dayjs — tiny", 3), 2);
	assert.equal(parseIndex("0", 3), null);
	assert.equal(parseIndex("4", 3), null);
	assert.equal(parseIndex("abc", 3), null);
});

test("single-select: picking #1 → an option answer", async () => {
	const ui = fakeUi({ select: ["1. date-fns — functional"] });
	const result = await runDialogQuestionnaire(ui, single);
	assert.deepEqual(result, {
		answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "date-fns" }],
		cancelled: false,
	});
});

test("single-select: picking the sentinel row → routes to free input", async () => {
	const ui = fakeUi({ select: ["3. Type something."], input: ["use luxon instead"] });
	const result = await runDialogQuestionnaire(ui, single);
	assert.equal(result.cancelled, false);
	assert.equal(result.answers[0].kind, "custom");
	assert.equal(result.answers[0].answer, "use luxon instead");
});

test("single-select: closing the input after the sentinel → the whole thing cancelled", async () => {
	const ui = fakeUi({ select: ["3. Type something."], input: [undefined] });
	const result = await runDialogQuestionnaire(ui, single);
	assert.equal(result.cancelled, true);
	assert.deepEqual(result.answers, []);
});

test("single-select: closing the select → cancelled", async () => {
	const ui = fakeUi({ select: [undefined] });
	const result = await runDialogQuestionnaire(ui, single);
	assert.equal(result.cancelled, true);
});

test("single-select: the host returning an off-list string → treated as cancel, no invented answer", async () => {
	const ui = fakeUi({ select: ["99. not in list"] });
	const result = await runDialogQuestionnaire(ui, single);
	assert.equal(result.cancelled, true);
});

test("multi-select: \"1,3\" → two labels (but with only 2 options, 3 is out of range → free text)", async () => {
	const three = {
		questions: [
			{
				...multi.questions[0],
				options: [
					{ label: "X", description: "x" },
					{ label: "Y", description: "y" },
					{ label: "Z", description: "z" },
				],
			},
		],
	};
	const ui = fakeUi({ input: ["1,3"] });
	const result = await runDialogQuestionnaire(ui, three);
	assert.equal(result.cancelled, false);
	assert.deepEqual(result.answers[0], {
		questionIndex: 0,
		question: "Which features?",
		kind: "multi",
		answer: null,
		selected: ["X", "Z"],
	});
});

test("multi-select: numbers with spaces and dots parse too — and dedupe", async () => {
	const ui = fakeUi({ input: [" 1. , 2 , 2 "] });
	const result = await runDialogQuestionnaire(ui, multi);
	assert.deepEqual(result.answers[0].selected, ["date-fns", "dayjs"]);
});

test("multi-select: an empty submit → selected is an empty array", async () => {
	const ui = fakeUi({ input: ["   "] });
	const result = await runDialogQuestionnaire(ui, multi);
	assert.equal(result.answers[0].kind, "multi");
	assert.deepEqual(result.answers[0].selected, []);
});

test("multi-select: non-number text → kept verbatim as custom (the free-text escape)", async () => {
	const ui = fakeUi({ input: ["let's just use luxon"] });
	const result = await runDialogQuestionnaire(ui, multi);
	assert.equal(result.answers[0].kind, "custom");
	assert.equal(result.answers[0].answer, "let's just use luxon");
});

test("multi-select: an out-of-range number (13) mixed into numbers → the whole input is free text", async () => {
	const ui = fakeUi({ input: ["1, 13"] });
	const result = await runDialogQuestionnaire(ui, multi);
	assert.equal(result.answers[0].kind, "custom");
	assert.equal(result.answers[0].answer, "1, 13");
});

test("multi-question: the second question closed → cancelled but the first answer kept", async () => {
	const ui = fakeUi({ select: ["1. date-fns — functional", undefined] });
	const result = await runDialogQuestionnaire(ui, twoQuestions);
	assert.equal(result.cancelled, true);
	assert.equal(result.answers.length, 1);
	assert.equal(result.answers[0].answer, "date-fns");
});

test("multi-question: all answered → cancelled:false, in question order", async () => {
	const ui = fakeUi({ select: ["2. dayjs — tiny", "1. date-fns — functional"] });
	const result = await runDialogQuestionnaire(ui, twoQuestions);
	assert.equal(result.cancelled, false);
	assert.deepEqual(
		result.answers.map((a) => a.answer),
		["dayjs", "date-fns"],
	);
});

test("the dialog title carries the header prefix", async () => {
	const ui = fakeUi({ select: ["1. date-fns — functional"] });
	await runDialogQuestionnaire(ui, single);
	assert.ok(ui.calls.select[0].startsWith("[Lib] Which library?"));
});
