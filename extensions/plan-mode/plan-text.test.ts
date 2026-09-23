/**
 * Tests for plan-text.ts — 步骤文案清洗、[DONE:n] 进度标记、注入给模型的上下文。
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/plan-text.test.ts
 *
 * plan-text.ts 不 import pi / pi-tui。这里最要紧的是两条边界：围栏里的 `[DONE:n]`
 * 既不能被当成进度、也不能被清理掉（那是用户代码块里的内容）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildExecuteContext,
	buildPlanModeContext,
	cleanStepText,
	extractDoneSteps,
	stripDoneMarkers,
} from "./plan-text.ts";

describe("cleanStepText", () => {
	it("清掉反引号与粗体标记", () => {
		assert.equal(cleanStepText("把 `shift+tab` 接进 **index.ts**"), "把 shift+tab 接进 index.ts");
	});

	it("去掉行首的列表符号并压掉多余空白", () => {
		assert.equal(cleanStepText("- 读   代码"), "读 代码");
	});

	it("去掉结尾标点", () => {
		assert.equal(cleanStepText("改配置文件，"), "改配置文件");
		assert.equal(cleanStepText("update the config."), "update the config");
	});

	it("超长文案截断到 100 列内并以省略号收尾", () => {
		const cleaned = cleanStepText("步".repeat(200));
		assert.ok(cleaned.length <= 100, `实际 ${cleaned.length}`);
		assert.ok(cleaned.endsWith("…"));
	});

	it("空串与纯空白", () => {
		assert.equal(cleanStepText(""), "");
		assert.equal(cleanStepText("   "), "");
	});
});

describe("[DONE:n] 提取", () => {
	it("单个标记", () => {
		assert.deepEqual(extractDoneSteps("做完了 [DONE:1]"), [1]);
	});

	it("一次声明多个（逗号 / 空格 / 中文逗号）", () => {
		assert.deepEqual(extractDoneSteps("[DONE:1,2] [DONE:3 4]"), [1, 2, 3, 4]);
		assert.deepEqual(extractDoneSteps("[done：5，6]"), [5, 6]);
	});

	it("大小写不敏感", () => {
		assert.deepEqual(extractDoneSteps("[Done:2] [DONE:3]"), [2, 3]);
	});

	it("没有标记时返回空数组", () => {
		assert.deepEqual(extractDoneSteps("什么都没说"), []);
		assert.deepEqual(extractDoneSteps(""), []);
	});

	it("围栏里讨论这个标记本身时不算进度", () => {
		assert.deepEqual(extractDoneSteps("写法是：\n```\n[DONE:1]\n```"), []);
		assert.deepEqual(extractDoneSteps("~~~\n[DONE:1]\n~~~"), []);
	});
});

describe("stripDoneMarkers", () => {
	it("从正文里清掉标记，不留下多余空格", () => {
		assert.equal(stripDoneMarkers("搞定 [DONE:1]\n继续"), "搞定\n继续");
	});

	it("围栏内容原样保留（那是用户代码块里的内容）", () => {
		const text = "说明：\n```\n[DONE:1]\n```";
		assert.ok(stripDoneMarkers(text).includes("[DONE:1]"));
	});

	it("没有标记时原样返回", () => {
		const text = "普通回复\n第二行";
		assert.equal(stripDoneMarkers(text), text);
	});

	it("提取与清理口径一致：清掉的正是提取到的", () => {
		const text = "第一步好了 [DONE:1]，第二步也好了 [DONE:2]\n```\n示例 [DONE:9]\n```";
		assert.deepEqual(extractDoneSteps(text), [1, 2]);
		const cleaned = stripDoneMarkers(text);
		assert.ok(!cleaned.includes("[DONE:1]"));
		assert.ok(!cleaned.includes("[DONE:2]"));
		assert.ok(cleaned.includes("[DONE:9]"), "围栏里的不该被清");
	});
});

describe("注入上下文", () => {
	it("plan 阶段说明只读阶段、点名 exit_plan_mode 与 cwd", () => {
		const context = buildPlanModeContext("/Users/x/project");
		assert.match(context, /\[PLAN MODE\]/);
		assert.match(context, /exit_plan_mode/);
		assert.match(context, /\/Users\/x\/project/);
		assert.match(context, /ask_user_question/, "要告诉模型可以用它问用户");
	});

	it("execute 阶段只列剩余步骤，并点名任务清单是唯一进度表", () => {
		const context = buildExecuteContext([
			{ step: 1, text: "第一步", done: true },
			{ step: 2, text: "第二步", done: false },
			{ step: 3, text: "第三步", done: false },
		]);
		assert.ok(!context.includes("第一步"));
		assert.match(context, /2\. 第二步/);
		assert.match(context, /3\. 第三步/);
		// 主路径是 task_update，`[DONE:n]` 作为等价别名保留
		assert.match(context, /task_update/);
		assert.match(context, /唯一/);
		assert.match(context, /不要 task_set/);
		assert.match(context, /\[DONE:n\]/);
	});

	it("execute 阶段沿用计划里的原序号（不重排）", () => {
		const context = buildExecuteContext([
			{ step: 5, text: "五", done: false },
			{ step: 9, text: "九", done: false },
		]);
		assert.match(context, /^5\. 五$/m);
		assert.match(context, /^9\. 九$/m);
	});

	it("execute 阶段示例里的步号取自剩余步骤的第一条，且是两步走（in_progress → done）", () => {
		const context = buildExecuteContext([
			{ step: 4, text: "四", done: true },
			{ step: 7, text: "七", done: false },
		]);
		assert.match(context, /task_update #7 → in_progress/, "开始做之前先标 in_progress");
		assert.match(context, /task_update #7 → done/, "做完再标 done");
		// 全局 AGENTS.md 的 `Never move an item straight from pending to done`：
		// 注入文本必须教两步，否则模型跟着更近的这条指令跳步（实测跳步率 50%）。
		// 判据：每个 `task_update #n → X` 都必须有配对的 in_progress 在前。
		const updates = [...context.matchAll(/task_update #(\d+) → (\w+)/g)].map((m) => [m[1], m[2]]);
		assert.deepEqual(
			updates,
			[["7", "in_progress"], ["7", "done"]],
			`注入文本应恰好教两步，实际 ${JSON.stringify(updates)}`,
		);
	});
});
