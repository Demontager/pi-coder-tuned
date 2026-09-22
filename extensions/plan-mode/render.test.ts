/**
 * Tests for render.ts — plan-mode 的状态行与步骤 widget 文案。
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/render.test.ts
 *
 * render.ts 不 import pi / pi-tui：`plain` 主题丢掉颜色以便断言可见文本，`painted`
 * 主题把每段包成 `slot(text)` 以便断言用的是哪个语义色槽；宽度函数固定按 CJK 2 列算，
 * 与 pi-tui 的 `visibleWidth` 口径一致。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	MAX_WIDGET_STEPS,
	MAX_WIDGET_WIDTH,
	type PlanTheme,
	formatPlanStatus,
	formatStepLines,
} from "./render.ts";

const plain: PlanTheme = { fg: (_color, text) => text, bold: (text) => text, strikethrough: (text) => `~${text}~` };
const painted: PlanTheme = { fg: (color, text) => `${color}(${text})`, bold: (text) => text, strikethrough: (text) => text };

function widthOf(text: string): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
}

const steps = (...texts: string[]) => texts.map((text, index) => ({ step: index + 1, text, done: false }));

describe("状态行", () => {
	it("normal 态显示 ⏵ normal（这一格是模式指示，任何态都有文案）", () => {
		assert.equal(formatPlanStatus(plain, { phase: "normal", steps: [] }), "⏵ normal");
	});

	it("normal 态在两步之间也保持显示（不是只在切换时才画）", () => {
		assert.equal(formatPlanStatus(plain, { phase: "normal", steps: steps("残留步骤") }), "⏵ normal");
		assert.equal(formatPlanStatus(plain, { phase: "normal", steps: [], pending: steps("残留") }), "⏵ normal");
	});

	it("plan 态：等待模型提交时只显示 ⏸ plan", () => {
		assert.equal(formatPlanStatus(plain, { phase: "plan", steps: [] }), "⏸ plan");
	});

	it("plan 态：计划已提交时带步骤数（复数处理）", () => {
		assert.equal(formatPlanStatus(plain, { phase: "plan", steps: [], pending: steps("一") }), "⏸ plan · 1 step");
		assert.equal(formatPlanStatus(plain, { phase: "plan", steps: [], pending: steps("一", "二") }), "⏸ plan · 2 steps");
	});

	it("execute 态显示进度", () => {
		const executing = steps("一", "二", "三", "四", "五");
		executing[0]!.done = true;
		executing[1]!.done = true;
		assert.equal(formatPlanStatus(plain, { phase: "execute", steps: executing }), "▶ 2/5 executing");
	});

	it("execute 但步骤为空时显示 ▶ execute（不退回 normal）", () => {
		assert.equal(formatPlanStatus(plain, { phase: "execute", steps: [] }), "▶ execute");
	});

	it("用到的色槽：plan 走 warning，execute 走 accent + muted，normal 走 toolDiffRemoved（红色）", () => {
		assert.equal(formatPlanStatus(painted, { phase: "plan", steps: [] }), "warning(⏸) warning(plan)");
		const executing = steps("一");
		executing[0]!.done = true;
		assert.equal(formatPlanStatus(painted, { phase: "execute", steps: executing }), "accent(▶) accent(1/1) muted(executing)");
		// normal 是「未开启保护」，用删除行前景色（三套皮肤里都是红）标出来。
		assert.equal(formatPlanStatus(painted, { phase: "normal", steps: [] }), "toolDiffRemoved(⏵) toolDiffRemoved(normal)");
	});

	it("normal 态不用 dim/muted（改回静息色会让它又看不见）", () => {
		const rendered = formatPlanStatus(painted, { phase: "normal", steps: [] });
		assert.ok(!rendered.includes("dim("), rendered);
		assert.ok(!rendered.includes("muted("), rendered);
	});
});

describe("步骤 widget", () => {
	it("没有步骤时返回 undefined（调用方据此清掉 widget）", () => {
		assert.equal(formatStepLines(plain, { phase: "plan", steps: [] }, widthOf), undefined);
		assert.equal(formatStepLines(plain, { phase: "normal", steps: steps("一") }, widthOf), undefined);
	});

	it("plan 态画待审批的步骤，execute 态画执行中的步骤", () => {
		assert.deepEqual(formatStepLines(plain, { phase: "plan", steps: [], pending: steps("第一步") }, widthOf), ["☐ 第一步"]);
		assert.deepEqual(formatStepLines(plain, { phase: "execute", steps: steps("第一步") }, widthOf), ["☐ 第一步"]);
	});

	it("完成的步骤打勾加删除线，未完成的用方框", () => {
		const executing = steps("已完成", "未完成");
		executing[0]!.done = true;
		assert.deepEqual(formatStepLines(plain, { phase: "execute", steps: executing }, widthOf), ["☑ ~已完成~", "☐ 未完成"]);
	});

	it("超过上限只显示前 N 条，并追加一行剩余摘要", () => {
		const many = steps(...Array.from({ length: MAX_WIDGET_STEPS + 3 }, (_, index) => `步骤 ${index + 1}`));
		const lines = formatStepLines(plain, { phase: "execute", steps: many }, widthOf);
		assert.equal(lines?.length, MAX_WIDGET_STEPS + 1);
		assert.equal(lines?.at(-1), "… 还有 3 步");
	});

	it("恰好等于上限时不追加摘要行", () => {
		const exact = steps(...Array.from({ length: MAX_WIDGET_STEPS }, (_, index) => `步骤 ${index + 1}`));
		assert.equal(formatStepLines(plain, { phase: "execute", steps: exact }, widthOf)?.length, MAX_WIDGET_STEPS);
	});

	it("超长的 CJK 步骤按可见宽度截断到预算内（CJK 算 2 列）", () => {
		const long = "改".repeat(200);
		const line = formatStepLines(plain, { phase: "execute", steps: steps(long) }, widthOf)?.[0] ?? "";
		assert.ok(line.endsWith("…"));
		assert.ok(widthOf(line) <= MAX_WIDGET_WIDTH, `实际宽 ${widthOf(line)}`);
	});

	it("ASCII 步骤用满自己的预算（同样 100 列，ASCII 放得更多）", () => {
		const line = formatStepLines(plain, { phase: "execute", steps: steps("a".repeat(200)) }, widthOf)?.[0] ?? "";
		// 行首 `☐ ` 占 2 列，正文预算 = MAX_WIDGET_WIDTH − 2 列预留，整行 98 列。
		assert.equal(widthOf(line), MAX_WIDGET_WIDTH - 2);
	});

	it("色槽：完成的勾走 success，当前步骤方框走 accent，其余走 muted", () => {
		const executing = steps("已完成", "当前", "以后");
		executing[0]!.done = true;
		assert.deepEqual(formatStepLines(painted, { phase: "execute", steps: executing }, widthOf), [
			"success(☑) muted(已完成)",
			"accent(☐) text(当前)",
			"muted(☐) muted(以后)",
		]);
	});

	it("plan 阶段的方框统一走 muted（还没有「当前步骤」的概念）", () => {
		assert.deepEqual(formatStepLines(painted, { phase: "plan", steps: [], pending: steps("一") }, widthOf), ["muted(☐) muted(一)"]);
	});
});
