/**
 * Tests for answers.ts — the result envelope / envelope text / error path.
 *
 * Run with:  node --test clients/pi/extensions/ask-user-question/answers.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildAnswerSegment,
	buildEnvelopeText,
	buildResponse,
	DECLINE_MESSAGE,
	ENVELOPE_PREFIX,
	ENVELOPE_SUFFIX,
	errorResult,
	formatAnswerScalar,
	NO_INPUT_PLACEHOLDER,
	toolResult,
} from "./answers.ts";
import type { AskAnswer, AskParams, AskResult } from "./types.ts";

const params: AskParams = {
	questions: [
		{ question: "Which library?", header: "Lib", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
		{
			question: "Which features?",
			header: "Feat",
			multiSelect: true,
			options: [{ label: "X", description: "x" }, { label: "Y", description: "y" }],
		},
	],
};

const optionAnswer: AskAnswer = { questionIndex: 0, question: "Which library?", kind: "option", answer: "A" };
const multiAnswer: AskAnswer = { questionIndex: 1, question: "Which features?", kind: "multi", answer: null, selected: ["X", "Y"] };
const emptyMulti: AskAnswer = { questionIndex: 1, question: "Which features?", kind: "multi", answer: null, selected: [] };
const customAnswer: AskAnswer = { questionIndex: 0, question: "Which library?", kind: "custom", answer: "use luxon" };
const emptyCustom: AskAnswer = { questionIndex: 0, question: "Which library?", kind: "custom", answer: "" };

test("formatAnswerScalar: option / custom / multi / empty", () => {
	assert.equal(formatAnswerScalar(optionAnswer), "A");
	assert.equal(formatAnswerScalar(customAnswer), "use luxon");
	assert.equal(formatAnswerScalar(multiAnswer), "X, Y");
	assert.equal(formatAnswerScalar(emptyMulti), NO_INPUT_PLACEHOLDER);
	assert.equal(formatAnswerScalar(emptyCustom), NO_INPUT_PLACEHOLDER);
});

test("buildAnswerSegment: \"question\"=\"answer\".", () => {
	assert.equal(buildAnswerSegment(optionAnswer), '"Which library?"="A".');
	assert.equal(buildAnswerSegment(multiAnswer), '"Which features?"="X, Y".');
});

test("buildEnvelopeText: all answered → prefix + segments + suffix", () => {
	const result: AskResult = { answers: [optionAnswer, multiAnswer], cancelled: false };
	const text = buildEnvelopeText(result, params);
	assert.ok(text.startsWith(`${ENVELOPE_PREFIX} `));
	assert.ok(text.endsWith(` ${ENVELOPE_SUFFIX}`));
	assert.ok(text.includes('"Which library?"="A".'));
	assert.ok(text.includes('"Which features?"="X, Y".'));
});

test("buildEnvelopeText: a partial submit produces only answered segments", () => {
	const result: AskResult = { answers: [optionAnswer], cancelled: false };
	const text = buildEnvelopeText(result, params);
	assert.ok(text.includes('"Which library?"="A".'));
	assert.ok(!text.includes("Which features?"));
});

test("buildEnvelopeText: cancel / null / zero segments all collapse into DECLINE_MESSAGE", () => {
	assert.equal(buildEnvelopeText({ answers: [], cancelled: true }, params), DECLINE_MESSAGE);
	assert.equal(buildEnvelopeText(null, params), DECLINE_MESSAGE);
	assert.equal(buildEnvelopeText(undefined, params), DECLINE_MESSAGE);
	assert.equal(buildEnvelopeText({ answers: [], cancelled: false }, params), DECLINE_MESSAGE);
});

test("buildResponse: the success path's content is the envelope, details carried verbatim", () => {
	const result: AskResult = { answers: [optionAnswer], cancelled: false };
	const out = buildResponse(result, params);
	assert.equal(out.content.length, 1);
	assert.equal(out.content[0].type, "text");
	assert.ok(out.content[0].text.startsWith(ENVELOPE_PREFIX));
	assert.equal(out.details, result);
});

test("buildResponse: the cancel path's content is DECLINE_MESSAGE, cancelled:true", () => {
	const out = buildResponse({ answers: [optionAnswer], cancelled: true }, params);
	assert.equal(out.content[0].text, DECLINE_MESSAGE);
	assert.equal(out.details.cancelled, true);
	// the answered portion stays in details (for replay/rendering)
	assert.equal(out.details.answers.length, 1);
});

test("errorResult: cancelled:true + error code + model-facing body", () => {
	const out = errorResult("Error: boom", "no_ui");
	assert.equal(out.content[0].text, "Error: boom");
	assert.deepEqual(out.details, { answers: [], cancelled: true, error: "no_ui" });
});

test("toolResult: a stable shape", () => {
	const out = toolResult("hi", { answers: [], cancelled: false });
	assert.deepEqual(out.content, [{ type: "text", text: "hi" }]);
	assert.deepEqual(out.details, { answers: [], cancelled: false });
});
