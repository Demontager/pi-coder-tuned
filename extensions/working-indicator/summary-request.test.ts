/**
 * Tests for summary-request.ts — 「提示词太长时请模型压成一句话」的纯逻辑。
 *
 * Run with:  node --test clients/pi/extensions/working-indicator/summary-request.test.ts
 *
 * 被测模块不 import pi / pi-tui（宽度是调用方量好的列数），所以这里也喂假宽度概念：
 * 参数直接就是列数，不需要任何测量函数。
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

	it("does not request for a mild overflow (pure truncation is good enough)", () => {
		// 显式倍数 2：截断后仍能显示一半原文，不值得请求。
		assert.equal(planSummaryRequest({ promptWidth: 41, budgetWidth: 40, triggerRatio: 2 }).needed, false);
		assert.equal(planSummaryRequest({ promptWidth: 79, budgetWidth: 40, triggerRatio: 2 }).needed, false);
	});

	it("requests once the prompt exceeds the budget by the trigger ratio", () => {
		// 默认倍数 1.2：40 列的格子放下 48 列以上就请求。
		assert.equal(planSummaryRequest({ promptWidth: 49, budgetWidth: 40 }).needed, true);
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
		// ratio 1 = 只要放不下就请求。
		assert.equal(planSummaryRequest({ promptWidth: 41, budgetWidth: 40, triggerRatio: 1 }).needed, true);
	});

	it("never requests when the available width is too narrow to hold a useful summary", () => {
		const plan = planSummaryRequest({ promptWidth: 10_000, budgetWidth: MIN_REQUEST_BUDGET - 1 });
		assert.equal(plan.needed, false);
		// 恰好到下限就允许（只要原文够长）。
		assert.equal(planSummaryRequest({ promptWidth: 1000, budgetWidth: MIN_REQUEST_BUDGET }).needed, true);
	});

	it("honours a custom minBudget", () => {
		assert.equal(planSummaryRequest({ promptWidth: 10_000, budgetWidth: 20, minBudget: 30 }).needed, false);
	});

	it("defaults the trigger ratio to 1.2", () => {
		assert.equal(DEFAULT_TRIGGER_RATIO, 1.2);
	});
});

describe("planSummaryRequest: target width", () => {
	it("leaves headroom below the available width", () => {
		const plan = planSummaryRequest({ promptWidth: 1000, budgetWidth: 40 });
		assert.equal(plan.targetWidth, Math.floor(40 * TARGET_WIDTH_RATIO));
		assert.ok(plan.targetWidth < 40, "目标必须小于可用宽度，否则模型略超一点就被截");
	});

	it("floors fractional budgets and keeps a tenth of the width as headroom", () => {
		assert.equal(planSummaryRequest({ promptWidth: 1000, budgetWidth: 40.9 }).targetWidth, 36);
		// 最窄的可请求格子：10 列预算 → 目标 9 列。
		assert.equal(planSummaryRequest({ promptWidth: 1000, budgetWidth: MIN_REQUEST_BUDGET }).targetWidth, 9);
	});
});

describe("buildSummaryRequestPrompt", () => {
	it("states the target width and the display-column unit", () => {
		const prompt = buildSummaryRequestPrompt("把 working 摘要改成模型压缩", 48);
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
		const input = "优化 summary 截断逻辑\n第二行说明";
		const prompt = buildSummaryRequestPrompt(input, 30);
		assert.ok(prompt.includes(input), "原文应原样带上（压平等加工由调用方负责）");
		assert.ok(prompt.trimEnd().endsWith(input));
	});

	it("clips a very long prompt to the request cap", () => {
		const prompt = buildSummaryRequestPrompt("x".repeat(MAX_REQUEST_INPUT_CHARS + 500), 30);
		assert.ok(prompt.includes("x".repeat(MAX_REQUEST_INPUT_CHARS)));
		assert.ok(!prompt.includes("x".repeat(MAX_REQUEST_INPUT_CHARS + 1)), "超过上限的部分应被截掉");
		assert.ok(prompt.includes("…"), "截断处应有省略号");
	});

	it("does not split a surrogate pair when clipping", () => {
		const prompt = buildSummaryRequestPrompt("😀".repeat(MAX_REQUEST_INPUT_CHARS + 20), 30);
		const clipped = prompt.slice(prompt.lastIndexOf("Input:") + "Input:".length + 1);
		assert.ok(clipped.endsWith("😀…"), `截断点不能落在半个代理对上（实际结尾 ${JSON.stringify(clipped.slice(-3))}）`);
	});
});

describe("cleanSummaryText", () => {
	it("passes a plain one-liner through", () => {
		assert.equal(cleanSummaryText("优化提示词摘要的截断逻辑"), "优化提示词摘要的截断逻辑");
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
		// 上限 + 表示被截的 `…`，按码点算恰好一个。
		assert.equal([...cleaned].length, MAX_SUMMARY_TEXT_CHARS + 1);
		assert.ok(cleaned.endsWith("😀…"));
	});

	it("keeps CJK text intact", () => {
		const text = "把右侧摘要换成模型压缩后的一句话";
		assert.equal(cleanSummaryText(text), text);
	});
});
