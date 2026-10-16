/**
 * Tests for plan-text.ts — the context injected for the model, plan truncation for the
 * approval dialog, and the wrap-up instructions.
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/plan-text.test.ts
 *
 * plan-text.ts imports no pi / pi-tui. The three things that matter most:
 *   1. the truncated total height **does not exceed** the dialog budget (over pushes the
 *      plan's top off-screen);
 *   2. the doc-writing instruction must pin the target path, carry the full plan, and say
 *      "no more tool calls after writing";
 *   3. doc-only's wrap-up instruction must be firm enough that the model does not casually
 *      start editing (write access is already restored by then).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildDocWriteContext,
	buildDocWrittenMessage,
	buildPlanModeContext,
	buildRejectedMessage,
	dialogPlanBudget,
	truncatePlanForDialog,
	type WrapFn,
} from "./plan-text.ts";

describe("injected context", () => {
	it("plan phase explains the read-only phase and names exit_plan_mode and cwd", () => {
		const context = buildPlanModeContext("/Users/x/project");
		assert.match(context, /\[PLAN MODE\]/);
		assert.match(context, /exit_plan_mode/);
		assert.match(context, /\/Users\/x\/project/);
		assert.match(context, /ask_user_question/, "the model must be told it can ask the user through it");
	});

	it("plan phase requires submitting a complete plan, not a list of step titles", () => {
		const context = buildPlanModeContext("/repo");
		assert.match(context, /complete Markdown design/, "the parameter name and shape must be spelled out");
		assert.match(context, /markdown/i);
		assert.match(context, /verification/, "verification is part of the plan");
		assert.match(context, /not just step headings/);
	});
});

// =============================================================================
// Doc-writing sub-state
// =============================================================================

const DOC_PATH = "/repo/.pi/plans/2026-09-24-change-two-files.md";
const PLAN = "# Plan\n\n## Summary\nChange index.ts and render.ts.\n\n## Verification\nRun node --test.";

describe("buildDocWriteContext", () => {
	it("pins the target path and says it is the only writable file", () => {
		const context = buildDocWriteContext(DOC_PATH, PLAN, "change two files");
		assert.match(context, /\[WRITE PLAN DOC\]/);
		assert.match(context, /use this exact path/);
		assert.ok(context.includes(DOC_PATH), "the path must appear verbatim in the instruction");
		assert.match(context, /only writable file/);
		assert.match(context, /Use the write tool/, "the tool must be named, or the model would try a bash redirect");
	});

	it("carries the full plan and summary (the model organizes it — not rethinks it)", () => {
		const context = buildDocWriteContext(DOC_PATH, PLAN, "change two files");
		assert.ok(context.includes(PLAN), "the full plan must be embedded verbatim");
		assert.match(context, /Design summary: change two files/);
	});

	it("a missing summary gets placeholder text, not a dangling colon", () => {
		assert.match(buildDocWriteContext(DOC_PATH, PLAN), /Design summary: \(no summary provided\)/);
		assert.match(buildDocWriteContext(DOC_PATH, PLAN, "   "), /Design summary: \(no summary provided\)/);
	});

	it("the unchanged boundary is spelled out: still read-only, no editing code", () => {
		const context = buildDocWriteContext(DOC_PATH, PLAN);
		assert.match(context, /Do not start changing code/);
		assert.match(context, /edit is unavailable/);
		assert.match(context, /Bash writes/, "the bash gate still stands — must be said");
	});

	it("no tool calls after writing (tool_result wraps up automatically)", () => {
		const context = buildDocWriteContext(DOC_PATH, PLAN);
		assert.match(context, /Do not call exit_plan_mode/, "one call less the model could forget");
		assert.match(context, /finishes this phase/);
	});

	it("a document structure template is given, and the reader is required to be a zero-context executor", () => {
		const context = buildDocWriteContext(DOC_PATH, PLAN);
		assert.match(context, /no prior context/);
		for (const section of ["## Summary", "## Background", "## Files", "## Implementation steps", "## Verification", "## Risks and open questions"]) {
			assert.ok(context.includes(section), `the template should contain ${section}`);
		}
	});
});

// =============================================================================
// Wrap-up instructions
// =============================================================================

describe("buildDocWrittenMessage", () => {
	it("execute-with-doc: report the path, send the model implementing per the doc, list-building left to its judgment", () => {
		const message = buildDocWrittenMessage("execute-with-doc", DOC_PATH);
		assert.ok(message.includes(DOC_PATH));
		assert.match(message, /write access is restored/);
		assert.match(message, /Follow this document/);
		assert.match(message, /task_set/, "the tool must be named so the model knows progress is its own");
		assert.match(message, /when useful/, "list-building is not forced — the core of this change");
		assert.match(message, /survives context compaction/, "the document's reason to exist");
	});

	it("doc-only: report the path and firmly stop — no editing", () => {
		const message = buildDocWrittenMessage("doc-only", DOC_PATH);
		assert.ok(message.includes(DOC_PATH));
		assert.match(message, /document only, no implementation/);
		assert.match(message, /stop now/, "write access is already restored — the wording must be firm");
		assert.match(message, /Do not change code/);
		assert.match(message, /create a task list/);
		assert.ok(!message.includes("Follow this document"), "the two routes' instructions must not cross");
	});

	it("both routes report the doc path (the only persistent artifact of this planning)", () => {
		for (const mode of ["execute-with-doc", "doc-only"] as const) {
			assert.ok(buildDocWrittenMessage(mode, DOC_PATH).includes(DOC_PATH), mode);
		}
	});
});

describe("buildRejectedMessage", () => {
	it("explains it is still in plan mode (read-only), to revise per user feedback and resubmit", () => {
		const message = buildRejectedMessage();
		assert.match(message, /did not approve/);
		assert.match(message, /Remain in plan mode \(read-only\)/);
		assert.match(message, /exit_plan_mode/);
	});
});

// =============================================================================
// Plan truncation for the approval dialog
// =============================================================================

/**
 * The test wrapper: hard-breaks by **character count** (no CJK wide-char awareness). Production
 * injects pi-tui's `wrapTextWithAnsi`, which wraps by visible columns — same interface; the
 * test only needs one with predictable row counts.
 */
const wrapByChars: WrapFn = (text, width) => {
	if (width <= 0) return [text];
	const out: string[] = [];
	for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
	return out.length > 0 ? out : [""];
};

/** A plan of N same-length lines (markdown shape: one sentence per line). */
function makePlan(lines: number, text = "change a file"): string {
	return Array.from({ length: lines }, (_, i) => `${i + 1}. ${text}`).join("\n");
}

/** How many rows a text occupies in the dialog (same algorithm as production: wrap per line, then sum). */
function dialogHeight(text: string, contentWidth: number): number {
	return text
		.split("\n")
		.reduce((sum, line) => sum + Math.max(1, wrapByChars(line, contentWidth).length), 0);
}

describe("dialogPlanBudget", () => {
	it("wide terminal: chrome 11 rows (three choices) + 5 reserved below", () => {
		const { budget, contentWidth } = dialogPlanBudget({ rows: 40, columns: 100 });
		assert.equal(contentWidth, 98, "Text's paddingX=1 eats one column on each side");
		assert.equal(budget, 40 - 11 - 5);
	});

	it("narrow terminal (<50 cols): the shortcut hint wraps, chrome +1 row", () => {
		const wide = dialogPlanBudget({ rows: 40, columns: 100 }).budget;
		const narrow = dialogPlanBudget({ rows: 40, columns: 40 }).budget;
		assert.equal(narrow, wide - 1);
	});

	it("the column width has a floor — an extremely narrow terminal never yields 0 or negative", () => {
		assert.ok(dialogPlanBudget({ rows: 40, columns: 1 }).contentWidth >= 8);
	});
});

describe("truncatePlanForDialog", () => {
	it("a fitting plan returns verbatim, not one char touched", () => {
		const plan = makePlan(5);
		const result = truncatePlanForDialog(plan, { rows: 40, columns: 100 }, wrapByChars);
		assert.equal(result, plan);
		assert.ok(!result.includes("plus"), "no truncation hint should appear");
	});

	it("markdown blank lines count as rows too (paragraph spacing is part of readability)", () => {
		const plan = "first line\n\nsecond line";
		const result = truncatePlanForDialog(plan, { rows: 40, columns: 100 }, wrapByChars);
		assert.equal(result, plan, "blank lines must not be squashed");
	});

	it("CRLF normalizes to LF — \\r adds no width", () => {
		const plan = "first line\nsecond line";
		const result = truncatePlanForDialog(plan, { rows: 40, columns: 100 }, wrapByChars);
		assert.equal(result, "first line\nsecond line");
	});

	it("exactly at the budget no truncation; one line over and it truncates", () => {
		const metrics = { rows: 40, columns: 100 };
		const { budget, contentWidth } = dialogPlanBudget(metrics);
		const exact = truncatePlanForDialog(makePlan(budget), metrics, wrapByChars);
		assert.ok(!exact.includes("plus"), `${budget} rows fit exactly — must not truncate`);

		const over = truncatePlanForDialog(makePlan(budget + 1), metrics, wrapByChars);
		// the hint line takes 1 row itself, so only budget-1 lines stay whole; 2 lines are hidden.
		assert.match(over, /plus 2 lines/, "one line over must truncate and name how many are hidden");
		assert.equal(dialogHeight(over, contentWidth), budget, "after truncation it fills the budget exactly");
	});

	it("an overlong plan truncates with a hint line that reports the hidden line count", () => {
		const metrics = { rows: 30, columns: 100 };
		const result = truncatePlanForDialog(makePlan(40), metrics, wrapByChars);
		const lines = result.split("\n");
		assert.match(lines[lines.length - 1]!, /^… plus \d+ lines \(scroll up to read the full plan\)$/);
		const { budget } = dialogPlanBudget(metrics);
		assert.ok(lines.length <= budget, `${lines.length} rows should be ≤ budget ${budget}`);
	});

	it("a paragraph wrapping to multiple rows counts at its real height", () => {
		// 300 chars per line wraps to 4 rows at 98 columns (wrapByChars hard-breaks by char)
		const long = "x".repeat(300);
		const metrics = { rows: 30, columns: 100 };
		const { budget, contentWidth } = dialogPlanBudget(metrics);
		const result = truncatePlanForDialog(makePlan(20, long), metrics, wrapByChars);
		assert.ok(dialogHeight(result, contentWidth) <= budget, `truncated total height should be ≤ budget ${budget}`);
		assert.match(result, /plus \d+ lines/);
	});

	it("CJK text is measured by the injected wrapper (production injects pi-tui's wrapTextWithAnsi, breaking per char)", () => {
		const cjk = "中".repeat(200);
		const metrics = { rows: 30, columns: 100 };
		const { budget, contentWidth } = dialogPlanBudget(metrics);
		const result = truncatePlanForDialog(makePlan(20, cjk), metrics, wrapByChars);
		assert.ok(dialogHeight(result, contentWidth) <= budget);
	});

	it("an extremely short terminal (budget under one row) yields only the hint line, within budget", () => {
		const metrics = { rows: 17, columns: 100 }; // budget = 17 - 11 - 5 = 1
		const { budget } = dialogPlanBudget(metrics);
		const result = truncatePlanForDialog(makePlan(8), metrics, wrapByChars);
		assert.ok(budget <= 1, `this terminal's budget should be 1; got ${budget}`);
		assert.equal(result.split("\n").length, 1, "only the one hint line");
		assert.match(result, /Plan has 8 lines/);
	});

	it("budget 0 or negative (terminal too short for the dialog) does not crash or overflow", () => {
		for (const rows of [16, 10, 1]) {
			const metrics = { rows, columns: 100 };
			const result = truncatePlanForDialog(makePlan(8), metrics, wrapByChars);
			assert.equal(result.split("\n").length, 1, `rows=${rows} should only have the hint line`);
		}
	});

	it("a single overlong line is clipped to displayable width — no empty box for the user", () => {
		const metrics = { rows: 20, columns: 100 }; // budget = 4
		const result = truncatePlanForDialog("x".repeat(2000), metrics, wrapByChars);
		assert.ok(result.length > 0);
		assert.ok(dialogHeight(result, dialogPlanBudget(metrics).contentWidth) <= 4);
	});

	it("an empty plan does not crash (returns an empty string)", () => {
		assert.equal(truncatePlanForDialog("", { rows: 40, columns: 100 }, wrapByChars), "");
	});
});
