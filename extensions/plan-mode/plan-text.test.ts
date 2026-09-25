/**
 * Tests for plan-text.ts — 注入给模型的上下文、批准对话框的计划截断、收尾指令。
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/plan-text.test.ts
 *
 * plan-text.ts 不 import pi / pi-tui。这里最要紧的三件事：
 *   1. 截断后的总高度**不超过**对话框预算（超了就把计划开头顶出屏幕）；
 *   2. 写文档指令必须钉死目标路径、带上计划全文、并说明「写完不用再调工具」；
 *   3. doc-only 的收尾指令必须硬到模型不会顺手开始改代码（那时写权限已经恢复）。
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

describe("注入上下文", () => {
	it("plan 阶段说明只读阶段、点名 exit_plan_mode 与 cwd", () => {
		const context = buildPlanModeContext("/Users/x/project");
		assert.match(context, /\[PLAN MODE\]/);
		assert.match(context, /exit_plan_mode/);
		assert.match(context, /\/Users\/x\/project/);
		assert.match(context, /ask_user_question/, "要告诉模型可以用它问用户");
	});

	it("plan 阶段要求提交的是一份完整方案，不是一串步骤标题", () => {
		const context = buildPlanModeContext("/repo");
		assert.match(context, /complete Markdown design/, "参数名与形状都要说清楚");
		assert.match(context, /markdown/i);
		assert.match(context, /verification/, "验证方式是方案的一部分");
		assert.match(context, /not just step headings/);
	});
});

// =============================================================================
// 写文档子态
// =============================================================================

const DOC_PATH = "/repo/.pi/plans/2026-09-24-改两个文件.md";
const PLAN = "# 方案\n\n## 总结\n改 index.ts 与 render.ts。\n\n## 验证\n跑 node --test。";

describe("buildDocWriteContext", () => {
	it("钉死目标路径，并说明这是唯一允许写入的文件", () => {
		const context = buildDocWriteContext(DOC_PATH, PLAN, "改两个文件");
		assert.match(context, /\[WRITE PLAN DOC\]/);
		assert.match(context, /use this exact path/);
		assert.ok(context.includes(DOC_PATH), "路径必须原样出现在指令里");
		assert.match(context, /only writable file/);
		assert.match(context, /Use the write tool/, "点名工具，模型才不会去试 bash 重定向");
	});

	it("带上计划全文与总结（模型照着整理，不是重新想一遍）", () => {
		const context = buildDocWriteContext(DOC_PATH, PLAN, "改两个文件");
		assert.ok(context.includes(PLAN), "计划全文要原样带进去");
		assert.match(context, /Design summary: 改两个文件/);
	});

	it("没有总结时给占位文案，不留一个空冒号", () => {
		assert.match(buildDocWriteContext(DOC_PATH, PLAN), /Design summary: \(no summary provided\)/);
		assert.match(buildDocWriteContext(DOC_PATH, PLAN, "   "), /Design summary: \(no summary provided\)/);
	});

	it("明确边界没变：仍是只读阶段，不许开始改代码", () => {
		const context = buildDocWriteContext(DOC_PATH, PLAN);
		assert.match(context, /Do not start changing code/);
		assert.match(context, /edit is unavailable/);
		assert.match(context, /Bash writes/, "bash 闸仍在，要说清楚");
	});

	it("写完不用再调任何工具（收尾由 tool_result 钩子自动做）", () => {
		const context = buildDocWriteContext(DOC_PATH, PLAN);
		assert.match(context, /Do not call exit_plan_mode/, "少一次模型可能忘记的调用");
		assert.match(context, /finishes this phase/);
	});

	it("给出文档结构模板，且要求读者是零上下文的执行者", () => {
		const context = buildDocWriteContext(DOC_PATH, PLAN);
		assert.match(context, /no prior context/);
		for (const section of ["## Summary", "## Background", "## Files", "## Implementation steps", "## Verification", "## Risks and open questions"]) {
			assert.ok(context.includes(section), `模板里应有 ${section}`);
		}
	});
});

// =============================================================================
// 收尾指令
// =============================================================================

describe("buildDocWrittenMessage", () => {
	it("execute-with-doc：报路径、让模型按文档实施、建不建清单由它自己判断", () => {
		const message = buildDocWrittenMessage("execute-with-doc", DOC_PATH);
		assert.ok(message.includes(DOC_PATH));
		assert.match(message, /write access is restored/);
		assert.match(message, /Follow this document/);
		assert.match(message, /task_set/, "要提到这个工具，模型才知道进度归它自己");
		assert.match(message, /when useful/, "不强制建清单 —— 这是本次改动的核心");
		assert.match(message, /survives context compaction/, "文档存在的理由");
	});

	it("doc-only：报路径并硬止住，不许开始改代码", () => {
		const message = buildDocWrittenMessage("doc-only", DOC_PATH);
		assert.ok(message.includes(DOC_PATH));
		assert.match(message, /document only, no implementation/);
		assert.match(message, /stop now/, "写权限已恢复，措辞必须硬");
		assert.match(message, /Do not change code/);
		assert.match(message, /create a task list/);
		assert.ok(!message.includes("Follow this document"), "两条路线的指令不能串");
	});

	it("两条路线都把文档路径报出来（那是这次规划唯一的持久产物）", () => {
		for (const mode of ["execute-with-doc", "doc-only"] as const) {
			assert.ok(buildDocWrittenMessage(mode, DOC_PATH).includes(DOC_PATH), mode);
		}
	});
});

describe("buildRejectedMessage", () => {
	it("说明仍在 plan mode（只读），要按用户反馈改后重新提交", () => {
		const message = buildRejectedMessage();
		assert.match(message, /did not approve/);
		assert.match(message, /Remain in plan mode \(read-only\)/);
		assert.match(message, /exit_plan_mode/);
	});
});

// =============================================================================
// 批准对话框的计划截断
// =============================================================================

/**
 * 测试用的折行器：按**字符数**硬断（不认 CJK 宽字）。生产代码注入的是 pi-tui 的
 * `wrapTextWithAnsi`，它按可见列宽折行 —— 两者接口相同，这里只需要一个行数可预测的实现。
 */
const wrapByChars: WrapFn = (text, width) => {
	if (width <= 0) return [text];
	const out: string[] = [];
	for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
	return out.length > 0 ? out : [""];
};

/** N 行同样长度的计划（markdown 形状：每行一句）。 */
function makePlan(lines: number, text = "改一个文件"): string {
	return Array.from({ length: lines }, (_, i) => `${i + 1}. ${text}`).join("\n");
}

/** 一段文本在对话框里占多少行（与生产代码同一个算法：逐行折行后求和）。 */
function dialogHeight(text: string, contentWidth: number): number {
	return text
		.split("\n")
		.reduce((sum, line) => sum + Math.max(1, wrapByChars(line, contentWidth).length), 0);
}

describe("dialogPlanBudget", () => {
	it("宽终端：chrome 11 行（三选一）+ 下方预留 5 行", () => {
		const { budget, contentWidth } = dialogPlanBudget({ rows: 40, columns: 100 });
		assert.equal(contentWidth, 98, "Text 的 paddingX=1，左右各吃一列");
		assert.equal(budget, 40 - 11 - 5);
	});

	it("窄终端（<50 列）：快捷键提示折行，chrome 多 1 行", () => {
		const wide = dialogPlanBudget({ rows: 40, columns: 100 }).budget;
		const narrow = dialogPlanBudget({ rows: 40, columns: 40 }).budget;
		assert.equal(narrow, wide - 1);
	});

	it("列宽有下限，极窄终端不会算出 0 或负数", () => {
		assert.ok(dialogPlanBudget({ rows: 40, columns: 1 }).contentWidth >= 8);
	});
});

describe("truncatePlanForDialog", () => {
	it("塞得下的计划原样返回，一个字符都不动", () => {
		const plan = makePlan(5);
		const result = truncatePlanForDialog(plan, { rows: 40, columns: 100 }, wrapByChars);
		assert.equal(result, plan);
		assert.ok(!result.includes("还有"), "不该出现截断提示");
	});

	it("markdown 的空行也占一行（段落间距是可读性的一部分）", () => {
		const plan = "第一段\n\n第二段";
		const result = truncatePlanForDialog(plan, { rows: 40, columns: 100 }, wrapByChars);
		assert.equal(result, plan, "空行不能被压掉");
	});

	it("CRLF 归一成 LF，不因为 \\r 多算宽度", () => {
		const plan = "第一行\r\n第二行";
		const result = truncatePlanForDialog(plan, { rows: 40, columns: 100 }, wrapByChars);
		assert.equal(result, "第一行\n第二行");
	});

	it("刚好等于预算不截断，多一行就截断", () => {
		const metrics = { rows: 40, columns: 100 };
		const { budget, contentWidth } = dialogPlanBudget(metrics);
		const exact = truncatePlanForDialog(makePlan(budget), metrics, wrapByChars);
		assert.ok(!exact.includes("还有"), `${budget} 行刚好塞满，不该截断`);

		const over = truncatePlanForDialog(makePlan(budget + 1), metrics, wrapByChars);
		// 提示行自己占 1 行，所以能完整留下的只有 budget-1 行，藏起来的是 2 行。
		assert.match(over, /plus 2 lines/, "多一行就该截断并点名剩下几行");
		assert.equal(dialogHeight(over, contentWidth), budget, "截断后恰好占满预算");
	});

	it("超屏计划截断后带提示行，且提示行报的是被藏起来的行数", () => {
		const metrics = { rows: 30, columns: 100 };
		const result = truncatePlanForDialog(makePlan(40), metrics, wrapByChars);
		const lines = result.split("\n");
		assert.match(lines[lines.length - 1]!, /^… plus \d+ lines \(scroll up to read the full plan\)$/);
		const { budget } = dialogPlanBudget(metrics);
		assert.ok(lines.length <= budget, `${lines.length} 行应 ≤ 预算 ${budget}`);
	});

	it("折行占多行的段落按真实高度计入预算", () => {
		// 每行 300 字符，在 98 列下折成 4 行（wrapByChars 按字符硬断）
		const long = "x".repeat(300);
		const metrics = { rows: 30, columns: 100 };
		const { budget, contentWidth } = dialogPlanBudget(metrics);
		const result = truncatePlanForDialog(makePlan(20, long), metrics, wrapByChars);
		assert.ok(dialogHeight(result, contentWidth) <= budget, `截断后总高应 ≤ 预算 ${budget}`);
		assert.match(result, /plus \d+ lines/);
	});

	it("CJK 文案按注入的折行器算高度（生产注入 pi-tui 的 wrapTextWithAnsi，逐字断行）", () => {
		const cjk = "中".repeat(200);
		const metrics = { rows: 30, columns: 100 };
		const { budget, contentWidth } = dialogPlanBudget(metrics);
		const result = truncatePlanForDialog(makePlan(20, cjk), metrics, wrapByChars);
		assert.ok(dialogHeight(result, contentWidth) <= budget);
	});

	it("终端极矮（预算连一行都放不下）时只给提示行，不超预算", () => {
		const metrics = { rows: 17, columns: 100 }; // budget = 17 - 11 - 5 = 1
		const { budget } = dialogPlanBudget(metrics);
		const result = truncatePlanForDialog(makePlan(8), metrics, wrapByChars);
		assert.ok(budget <= 1, `这个终端的预算应是 1，实际 ${budget}`);
		assert.equal(result.split("\n").length, 1, "只有一行提示");
		assert.match(result, /Plan has 8 lines/);
	});

	it("预算为 0 或负数（终端矮到放不下对话框）也不崩、不超预算", () => {
		for (const rows of [16, 10, 1]) {
			const metrics = { rows, columns: 100 };
			const result = truncatePlanForDialog(makePlan(8), metrics, wrapByChars);
			assert.equal(result.split("\n").length, 1, `rows=${rows} 应只有一行提示`);
		}
	});

	it("一行超长计划按宽度截到能显示，不给用户一个空框", () => {
		const metrics = { rows: 20, columns: 100 }; // budget = 4
		const result = truncatePlanForDialog("x".repeat(2000), metrics, wrapByChars);
		assert.ok(result.length > 0);
		assert.ok(dialogHeight(result, dialogPlanBudget(metrics).contentWidth) <= 4);
	});

	it("空计划不崩（返回空串）", () => {
		assert.equal(truncatePlanForDialog("", { rows: 40, columns: 100 }, wrapByChars), "");
	});
});
