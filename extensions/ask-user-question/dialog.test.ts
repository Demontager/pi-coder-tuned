/**
 * Tests for dialog.ts — 非 TUI 宿主的顺序 select/input 回退。
 *
 * Run with:  node --test clients/pi/extensions/ask-user-question/dialog.test.ts
 *
 * DialogUI 是鸭子类型，用脚本化的假 ui 覆盖：单选命中选项、哨兵行转自由输入、
 * 多选编号解析、自由文本逃生、空提交、关掉对话框取消（含保留已答部分）、
 * 宿主返回清单外内容按取消处理。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { hasDialogUI, parseIndex, runDialogQuestionnaire, type DialogUI } from "./dialog.ts";
import type { AskParams } from "./types.ts";

/** 脚本化假 ui：select/input 按调用次序吐出预设值，undefined = 用户关掉对话框。 */
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

test("hasDialogUI: 结构化判定", () => {
	assert.equal(hasDialogUI({ select: async () => undefined, input: async () => undefined }), true);
	assert.equal(hasDialogUI({ select: async () => undefined }), false);
	assert.equal(hasDialogUI(null), false);
	assert.equal(hasDialogUI(undefined), false);
});

test("parseIndex: 编号解析与越界", () => {
	assert.equal(parseIndex("1", 3), 0);
	assert.equal(parseIndex("3. dayjs — tiny", 3), 2);
	assert.equal(parseIndex("0", 3), null);
	assert.equal(parseIndex("4", 3), null);
	assert.equal(parseIndex("abc", 3), null);
});

test("单选：选第 1 项 → option 答案", async () => {
	const ui = fakeUi({ select: ["1. date-fns — functional"] });
	const result = await runDialogQuestionnaire(ui, single);
	assert.deepEqual(result, {
		answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "date-fns" }],
		cancelled: false,
	});
});

test("单选：选哨兵行 → 转自由输入", async () => {
	const ui = fakeUi({ select: ["3. Type something."], input: ["use luxon instead"] });
	const result = await runDialogQuestionnaire(ui, single);
	assert.equal(result.cancelled, false);
	assert.equal(result.answers[0].kind, "custom");
	assert.equal(result.answers[0].answer, "use luxon instead");
});

test("单选：哨兵行后关掉输入框 → 整份取消", async () => {
	const ui = fakeUi({ select: ["3. Type something."], input: [undefined] });
	const result = await runDialogQuestionnaire(ui, single);
	assert.equal(result.cancelled, true);
	assert.deepEqual(result.answers, []);
});

test("单选：关掉选择框 → 取消", async () => {
	const ui = fakeUi({ select: [undefined] });
	const result = await runDialogQuestionnaire(ui, single);
	assert.equal(result.cancelled, true);
});

test("单选：宿主返回清单外的串 → 按取消处理，不编造答案", async () => {
	const ui = fakeUi({ select: ["99. not in list"] });
	const result = await runDialogQuestionnaire(ui, single);
	assert.equal(result.cancelled, true);
});

test("多选：\"1,3\" → 两个 label（但只有 2 个选项时 3 越界 → 走自由文本）", async () => {
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

test("多选：带空格与点号的编号也能解析，且去重", async () => {
	const ui = fakeUi({ input: [" 1. , 2 , 2 "] });
	const result = await runDialogQuestionnaire(ui, multi);
	assert.deepEqual(result.answers[0].selected, ["date-fns", "dayjs"]);
});

test("多选：空提交 → selected 为空数组", async () => {
	const ui = fakeUi({ input: ["   "] });
	const result = await runDialogQuestionnaire(ui, multi);
	assert.equal(result.answers[0].kind, "multi");
	assert.deepEqual(result.answers[0].selected, []);
});

test("多选：非编号文本 → 原样保留为 custom（自由文本逃生口）", async () => {
	const ui = fakeUi({ input: ["let's just use luxon"] });
	const result = await runDialogQuestionnaire(ui, multi);
	assert.equal(result.answers[0].kind, "custom");
	assert.equal(result.answers[0].answer, "let's just use luxon");
});

test("多选：越界编号（13）混在编号里 → 整体当自由文本", async () => {
	const ui = fakeUi({ input: ["1, 13"] });
	const result = await runDialogQuestionnaire(ui, multi);
	assert.equal(result.answers[0].kind, "custom");
	assert.equal(result.answers[0].answer, "1, 13");
});

test("多题：第二题被关掉 → 取消但保留第一题答案", async () => {
	const ui = fakeUi({ select: ["1. date-fns — functional", undefined] });
	const result = await runDialogQuestionnaire(ui, twoQuestions);
	assert.equal(result.cancelled, true);
	assert.equal(result.answers.length, 1);
	assert.equal(result.answers[0].answer, "date-fns");
});

test("多题：全部回答 → cancelled:false 且按题序", async () => {
	const ui = fakeUi({ select: ["2. dayjs — tiny", "1. date-fns — functional"] });
	const result = await runDialogQuestionnaire(ui, twoQuestions);
	assert.equal(result.cancelled, false);
	assert.deepEqual(
		result.answers.map((a) => a.answer),
		["dayjs", "date-fns"],
	);
});

test("对话框标题带 header 前缀", async () => {
	const ui = fakeUi({ select: ["1. date-fns — functional"] });
	await runDialogQuestionnaire(ui, single);
	assert.ok(ui.calls.select[0].startsWith("[Lib] Which library?"));
});
