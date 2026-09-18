/**
 * Tests for answers.ts — 结果封装 / 信封文本 / 错误路径。
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

test("formatAnswerScalar: option / custom / multi / 空值", () => {
	assert.equal(formatAnswerScalar(optionAnswer), "A");
	assert.equal(formatAnswerScalar(customAnswer), "use luxon");
	assert.equal(formatAnswerScalar(multiAnswer), "X, Y");
	assert.equal(formatAnswerScalar(emptyMulti), NO_INPUT_PLACEHOLDER);
	assert.equal(formatAnswerScalar(emptyCustom), NO_INPUT_PLACEHOLDER);
});

test("buildAnswerSegment: \"问题\"=\"答案\".", () => {
	assert.equal(buildAnswerSegment(optionAnswer), '"Which library?"="A".');
	assert.equal(buildAnswerSegment(multiAnswer), '"Which features?"="X, Y".');
});

test("buildEnvelopeText: 全答 → 前缀 + 各段 + 后缀", () => {
	const result: AskResult = { answers: [optionAnswer, multiAnswer], cancelled: false };
	const text = buildEnvelopeText(result, params);
	assert.ok(text.startsWith(`${ENVELOPE_PREFIX} `));
	assert.ok(text.endsWith(` ${ENVELOPE_SUFFIX}`));
	assert.ok(text.includes('"Which library?"="A".'));
	assert.ok(text.includes('"Which features?"="X, Y".'));
});

test("buildEnvelopeText: 部分提交只产生已答段", () => {
	const result: AskResult = { answers: [optionAnswer], cancelled: false };
	const text = buildEnvelopeText(result, params);
	assert.ok(text.includes('"Which library?"="A".'));
	assert.ok(!text.includes("Which features?"));
});

test("buildEnvelopeText: 取消 / null / 零答案段都塌缩成 DECLINE_MESSAGE", () => {
	assert.equal(buildEnvelopeText({ answers: [], cancelled: true }, params), DECLINE_MESSAGE);
	assert.equal(buildEnvelopeText(null, params), DECLINE_MESSAGE);
	assert.equal(buildEnvelopeText(undefined, params), DECLINE_MESSAGE);
	assert.equal(buildEnvelopeText({ answers: [], cancelled: false }, params), DECLINE_MESSAGE);
});

test("buildResponse: 成功路径 content 是信封、details 原样带回", () => {
	const result: AskResult = { answers: [optionAnswer], cancelled: false };
	const out = buildResponse(result, params);
	assert.equal(out.content.length, 1);
	assert.equal(out.content[0].type, "text");
	assert.ok(out.content[0].text.startsWith(ENVELOPE_PREFIX));
	assert.equal(out.details, result);
});

test("buildResponse: 取消路径 content 是 DECLINE_MESSAGE、cancelled:true", () => {
	const out = buildResponse({ answers: [optionAnswer], cancelled: true }, params);
	assert.equal(out.content[0].text, DECLINE_MESSAGE);
	assert.equal(out.details.cancelled, true);
	// 已答部分仍保留在 details 里（回放/渲染用）
	assert.equal(out.details.answers.length, 1);
});

test("errorResult: cancelled:true + error 码 + 写给模型的正文", () => {
	const out = errorResult("Error: boom", "no_ui");
	assert.equal(out.content[0].text, "Error: boom");
	assert.deepEqual(out.details, { answers: [], cancelled: true, error: "no_ui" });
});

test("toolResult: 结构稳定", () => {
	const out = toolResult("hi", { answers: [], cancelled: false });
	assert.deepEqual(out.content, [{ type: "text", text: "hi" }]);
	assert.deepEqual(out.details, { answers: [], cancelled: false });
});
