/**
 * Tests for summary-request.ts — the pure logic of "when the prompt is too long, ask the model
 * to compress it into one line".
 *
 * Run with:  node --test clients/pi/extensions/working-indicator/summary-request.test.ts
 *
 * The module under test imports no pi / pi-tui (widths arrive pre-measured by the caller), so
 * this test feeds a fake notion of width: arguments are already column counts, no measuring
 * function needed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DEFAULT_TRIGGER_RATIO,
	MAX_REQUEST_INPUT_CHARS,
	MAX_SUMMARY_TEXT_CHARS,
	MIN_REQUEST_BUDGET,
	TARGET_WIDTH_RATIO,
	buildSummaryRequestPrompt,
	cleanSummaryText,
	planSummaryRequest,
} from "./summary-request.ts";

describe("planSummaryRequest: trigger", () => {
	it("does not request when the prompt fits the available width", () => {
		assert.equal(planSummaryRequest({ promptWidth: 30, budgetWidth: 40 }).needed, false);
		assert.equal(planSummaryRequest({ promptWidth: 40, budgetWidth: 40 }).needed, false);
	});

	it("with a raised ratio, a mild overflow still does not request", () => {
		// explicit ratio 2: truncation still shows half the original — not worth a request.
		assert.equal(planSummaryRequest({ promptWidth: 41, budgetWidth: 40, triggerRatio: 2 }).needed, false);
		assert.equal(planSummaryRequest({ promptWidth: 79, budgetWidth: 40, triggerRatio: 2 }).needed, false);
	});

	it("requests as soon as the prompt exceeds the budget (default ratio 1)", () => {
		// default ratio 1: in a 40-column cell, 41 columns (the first one that does not fit) already triggers.
		assert.equal(planSummaryRequest({ promptWidth: 41, budgetWidth: 40 }).needed, true);
		assert.equal(planSummaryRequest({ promptWidth: 4000, budgetWidth: 40 }).needed, true);
	});

	it("is strict about the boundary (equal to budget * ratio does not request)", () => {
		const threshold = 40 * DEFAULT_TRIGGER_RATIO;
		assert.equal(planSummaryRequest({ promptWidth: threshold, budgetWidth: 40 }).needed, false);
		assert.equal(planSummaryRequest({ promptWidth: threshold + 1, budgetWidth: 40 }).needed, true);
	});

	it("honours a custom trigger ratio", () => {
		assert.equal(planSummaryRequest({ promptWidth: 60, budgetWidth: 40, triggerRatio: 1.5 }).needed, false);
		assert.equal(planSummaryRequest({ promptWidth: 61, budgetWidth: 40, triggerRatio: 1.5 }).needed, true);
		// ratio 1 = request whenever it does not fit.
		assert.equal(planSummaryRequest({ promptWidth: 41, budgetWidth: 40, triggerRatio: 1 }).needed, true);
	});

	it("never requests when the available width is too narrow to hold a useful summary", () => {
		const plan = planSummaryRequest({ promptWidth: 10_000, budgetWidth: MIN_REQUEST_BUDGET - 1 });
		assert.equal(plan.needed, false);
		// exactly at the floor it is allowed (as long as the original is long enough).
		assert.equal(planSummaryRequest({ promptWidth: 1000, budgetWidth: MIN_REQUEST_BUDGET }).needed, true);
	});

	it("honours a custom minBudget", () => {
		assert.equal(planSummaryRequest({ promptWidth: 10_000, budgetWidth: 20, minBudget: 30 }).needed, false);
	});

	it("defaults the trigger ratio to 1 (request as soon as it does not fit)", () => {
		assert.equal(DEFAULT_TRIGGER_RATIO, 1);
	});
});

describe("planSummaryRequest: target width", () => {
	it("leaves headroom below the available width", () => {
		const plan = planSummaryRequest({ promptWidth: 1000, budgetWidth: 40 });
		assert.equal(plan.targetWidth, Math.floor(40 * TARGET_WIDTH_RATIO));
		assert.ok(plan.targetWidth < 40, "the target must be under the available width, or a slightly-over model answer gets clipped");
	});

	it("floors fractional budgets and keeps a tenth of the width as headroom", () => {
		assert.equal(planSummaryRequest({ promptWidth: 1000, budgetWidth: 40.9 }).targetWidth, 36);
		// the narrowest requestable cell: 10-column budget → 9-column target.
		assert.equal(planSummaryRequest({ promptWidth: 1000, budgetWidth: MIN_REQUEST_BUDGET }).targetWidth, 9);
	});
});

describe("buildSummaryRequestPrompt", () => {
	it("states the target width and the display-column unit", () => {
		const prompt = buildSummaryRequestPrompt("replace the working summary with model compression", 48);
		assert.match(prompt, /48 display columns/);
		assert.match(prompt, /CJK\/full-width character counts as 2 columns/);
	});

	it("asks for a single line without decoration and mirrors the input language", () => {
		const prompt = buildSummaryRequestPrompt("hello", 30);
		assert.match(prompt, /Output a single line/);
		assert.match(prompt, /No line breaks, no quotes, no markdown/);
		assert.match(prompt, /same language as the input/);
	});

	it("embeds the input prompt verbatim", () => {
		const input = "optimize summary truncation logic\nsecond-line detail";
		const prompt = buildSummaryRequestPrompt(input, 30);
		assert.ok(prompt.includes(input), "the original should be embedded verbatim (flattening and other processing are the caller's job)");
		assert.ok(prompt.trimEnd().endsWith(input));
	});

	it("clips a very long prompt to the request cap", () => {
		const prompt = buildSummaryRequestPrompt("x".repeat(MAX_REQUEST_INPUT_CHARS + 500), 30);
		assert.ok(prompt.includes("x".repeat(MAX_REQUEST_INPUT_CHARS)));
		assert.ok(!prompt.includes("x".repeat(MAX_REQUEST_INPUT_CHARS + 1)), "anything past the cap should be clipped");
		assert.ok(prompt.includes("…"), "the cut should carry an ellipsis");
	});

	it("does not split a surrogate pair when clipping", () => {
		const prompt = buildSummaryRequestPrompt("😀".repeat(MAX_REQUEST_INPUT_CHARS + 20), 30);
		const clipped = prompt.slice(prompt.lastIndexOf("Input:") + "Input:".length + 1);
		assert.ok(clipped.endsWith("😀…"), `the cut must not land on half a surrogate pair (actual tail ${JSON.stringify(clipped.slice(-3))})`);
	});
});

describe("cleanSummaryText", () => {
	it("passes a plain one-liner through", () => {
		assert.equal(cleanSummaryText("optimize the prompt-summary truncation logic"), "optimize the prompt-summary truncation logic");
	});

	it("strips a label prefix in ASCII and Chinese", () => {
		assert.equal(cleanSummaryText("摘要：优化摘要逻辑"), "优化摘要逻辑");
		assert.equal(cleanSummaryText("Summary: refactor the loader"), "refactor the loader");
		assert.equal(cleanSummaryText("概括 : 修 bug"), "修 bug");
	});

	it("strips a bold-wrapped label and its closing markers", () => {
		assert.equal(cleanSummaryText("**摘要：** 优化摘要逻辑"), "优化摘要逻辑");
		assert.equal(cleanSummaryText("**摘要**：优化摘要逻辑"), "优化摘要逻辑");
	});

	it("skips a label-only first line and uses the next line", () => {
		assert.equal(cleanSummaryText("摘要：\n优化提示词摘要逻辑"), "优化提示词摘要逻辑");
		assert.equal(cleanSummaryText("**Summary**\nrefactor the loader"), "refactor the loader");
	});

	it("takes only the first meaningful line", () => {
		const reply = "优化摘要逻辑\n\n这段代码做的事情是把很长的提示词交给模型压缩，具体来说……";
		assert.equal(cleanSummaryText(reply), "优化摘要逻辑");
	});

	it("strips wrapping quotes and book-title marks", () => {
		assert.equal(cleanSummaryText('"优化摘要逻辑"'), "优化摘要逻辑");
		assert.equal(cleanSummaryText("「优化摘要逻辑」"), "优化摘要逻辑");
		assert.equal(cleanSummaryText("《优化摘要逻辑》"), "优化摘要逻辑");
		assert.equal(cleanSummaryText("`优化摘要逻辑`"), "优化摘要逻辑");
	});

	it("strips whole-text bold wrapping", () => {
		assert.equal(cleanSummaryText("**优化摘要逻辑**"), "优化摘要逻辑");
		assert.equal(cleanSummaryText("__refactor the loader__"), "refactor the loader");
	});

	it("unwraps stacked decoration (label + quotes + bold)", () => {
		assert.equal(cleanSummaryText('**"摘要：优化摘要逻辑"**'), "优化摘要逻辑");
	});

	it("strips list bullets and markdown chrome via flattenPrompt", () => {
		assert.equal(cleanSummaryText("- 优化摘要逻辑"), "优化摘要逻辑");
		assert.equal(cleanSummaryText("# 优化摘要逻辑"), "优化摘要逻辑");
	});

	it("keeps the fenced content when the reply is a code fence", () => {
		assert.equal(cleanSummaryText("```\n优化摘要逻辑\n```"), "优化摘要逻辑");
	});

	it("removes ANSI escapes, zero-width characters and control chars", () => {
		assert.equal(cleanSummaryText("\u001b[31m优化摘要逻辑\u001b[0m"), "优化摘要逻辑");
		assert.equal(cleanSummaryText("优化\u200b摘要逻辑"), "优化摘要逻辑");
	});

	it("returns empty for empty / decorative-only replies", () => {
		assert.equal(cleanSummaryText(""), "");
		assert.equal(cleanSummaryText("   \n\t\n "), "");
		assert.equal(cleanSummaryText("摘要："), "");
		assert.equal(cleanSummaryText("```\n```"), "");
	});

	it("caps runaway replies at MAX_SUMMARY_TEXT_CHARS without splitting a surrogate pair", () => {
		const reply = "😀".repeat(MAX_SUMMARY_TEXT_CHARS + 50);
		const cleaned = cleanSummaryText(reply);
		// the cap plus one `…` marking the cut — exactly one extra code point.
		assert.equal([...cleaned].length, MAX_SUMMARY_TEXT_CHARS + 1);
		assert.ok(cleaned.endsWith("😀…"));
	});

	it("keeps CJK text intact", () => {
		const text = "把右侧摘要换成模型压缩后的一句话";
		assert.equal(cleanSummaryText(text), text);
	});
});
