/**
 * Tests for model.ts — 问卷状态机（纯 reducer）。
 *
 * Run with:  node --test clients/pi/extensions/ask-user-question/model.test.ts
 *
 * 覆盖：单选提交即结束（单题无提交页）、数字键、多选勾选/提交、自由输入
 * （含空输入退回）、取消、多题推进与提交页闸门、Tab 环绕切换、重答恢复光标、
 * 哨兵行与边界（上下键 clamp、单选题 Space 无效、提交页数字键无效）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	allAnswered,
	createState,
	hasSubmitTab,
	isSubmitTab,
	reduce,
	rowCount,
	unansweredHeaders,
	type Outcome,
} from "./model.ts";
import type { AskParams } from "./types.ts";

function option(label: string) {
	return { label, description: `${label} desc` };
}

function singleParams(): AskParams {
	return {
		questions: [
			{ question: "Which library?", header: "Lib", options: [option("date-fns"), option("dayjs"), option("luxon")] },
		],
	};
}

function multiSelectParams(): AskParams {
	return {
		questions: [
			{
				question: "Which features?",
				header: "Feat",
				multiSelect: true,
				options: [option("X"), option("Y"), option("Z")],
			},
		],
	};
}

function twoParams(): AskParams {
	return {
		questions: [
			{ question: "Q1?", header: "One", options: [option("a"), option("b")] },
			{ question: "Q2?", header: "Two", options: [option("c"), option("d")] },
		],
	};
}

function submitted(outcome: Outcome) {
	assert.equal(outcome.status, "submit");
	if (outcome.status !== "submit") throw new Error("unreachable");
	return outcome.result;
}

test("单题没有提交页；行数 = 选项数 + 1（哨兵）", () => {
	const state = createState(singleParams());
	assert.equal(hasSubmitTab(state), false);
	assert.equal(isSubmitTab(state), false);
	assert.equal(rowCount(state), 4);
	assert.equal(allAnswered(state), false);
	assert.deepEqual(unansweredHeaders(state), ["Lib"]);
});

test("单选：光标移到选项上 Enter → 直接提交（单题无提交页）", () => {
	const state = createState(singleParams());
	reduce(state, { type: "down" }); // cursor = 1 → dayjs
	const result = submitted(reduce(state, { type: "confirm" }));
	assert.equal(result.cancelled, false);
	assert.deepEqual(result.answers, [
		{ questionIndex: 0, question: "Which library?", kind: "option", answer: "dayjs" },
	]);
});

test("单选：数字键直接选中并提交", () => {
	const state = createState(singleParams());
	const result = submitted(reduce(state, { type: "digit", digit: 3 }));
	assert.equal(result.answers[0].answer, "luxon");
});

test("单选：数字键落在哨兵行 → 进自由输入", () => {
	const state = createState(singleParams());
	const outcome = reduce(state, { type: "digit", digit: 4 });
	assert.equal(outcome.status, "enterInput");
	assert.equal(state.inputMode, true);
	assert.equal(state.cursor, 3);
});

test("单选：越界数字键无效", () => {
	const state = createState(singleParams());
	const outcome = reduce(state, { type: "digit", digit: 9 });
	assert.equal(outcome.status, "continue");
	assert.equal(state.cursor, 0);
});

test("上下键 clamp 在 [0, rowCount-1]", () => {
	const state = createState(singleParams());
	reduce(state, { type: "up" });
	assert.equal(state.cursor, 0);
	for (let i = 0; i < 10; i++) reduce(state, { type: "down" });
	assert.equal(state.cursor, 3);
});

test("单选题 Space 不产生勾选", () => {
	const state = createState(singleParams());
	const outcome = reduce(state, { type: "toggle" });
	assert.equal(outcome.status, "continue");
	assert.deepEqual(state.toggles[0], [false, false, false]);
});

test("多选：Space 勾选 + Enter 提交选中项", () => {
	const state = createState(multiSelectParams());
	reduce(state, { type: "toggle" }); // X
	reduce(state, { type: "down" });
	reduce(state, { type: "down" });
	reduce(state, { type: "toggle" }); // Z
	const result = submitted(reduce(state, { type: "confirm" }));
	assert.deepEqual(result.answers[0], {
		questionIndex: 0,
		question: "Which features?",
		kind: "multi",
		answer: null,
		selected: ["X", "Z"],
	});
});

test("多选：数字键切换勾选态并移动光标", () => {
	const state = createState(multiSelectParams());
	reduce(state, { type: "digit", digit: 2 });
	assert.equal(state.cursor, 1);
	assert.deepEqual(state.toggles[0], [false, true, false]);
	reduce(state, { type: "digit", digit: 2 }); // 再按取消勾选
	assert.deepEqual(state.toggles[0], [false, false, false]);
});

test("多选：一个都不勾直接 Enter → selected 为空数组也算提交", () => {
	const state = createState(multiSelectParams());
	const result = submitted(reduce(state, { type: "confirm" }));
	assert.deepEqual(result.answers[0].selected, []);
});

test("哨兵行 Enter → 进自由输入；输入文本提交为 custom", () => {
	const state = createState(singleParams());
	for (let i = 0; i < 3; i++) reduce(state, { type: "down" }); // 哨兵行
	const enter = reduce(state, { type: "confirm" });
	assert.equal(enter.status, "enterInput");
	const result = submitted(reduce(state, { type: "inputSubmit", text: "  use luxon  " }));
	assert.deepEqual(result.answers[0], {
		questionIndex: 0,
		question: "Which library?",
		kind: "custom",
		answer: "use luxon",
	});
	assert.equal(state.inputMode, false);
});

test("自由输入为空 → 退回选项列表，不产生答案", () => {
	const state = createState(singleParams());
	for (let i = 0; i < 3; i++) reduce(state, { type: "down" });
	reduce(state, { type: "confirm" }); // enterInput
	const outcome = reduce(state, { type: "inputSubmit", text: "   " });
	assert.equal(outcome.status, "exitInput");
	assert.equal(state.inputMode, false);
	assert.equal(state.answers[0], undefined);
});

test("inputCancel 退回选项列表", () => {
	const state = createState(singleParams());
	for (let i = 0; i < 3; i++) reduce(state, { type: "down" });
	reduce(state, { type: "confirm" });
	const outcome = reduce(state, { type: "inputCancel" });
	assert.equal(outcome.status, "exitInput");
	assert.equal(state.inputMode, false);
});

test("取消：已答部分随 cancel 结果带出", () => {
	const state = createState(twoParams());
	reduce(state, { type: "confirm" }); // 答了 Q1
	const outcome = reduce(state, { type: "cancel" });
	assert.equal(outcome.status, "cancel");
	if (outcome.status !== "cancel") throw new Error("unreachable");
	assert.equal(outcome.result.cancelled, true);
	assert.equal(outcome.result.answers.length, 1);
	assert.equal(outcome.result.answers[0].answer, "a");
});

test("多题：答完 Q1 自动到 Q2，答完 Q2 进提交页", () => {
	const state = createState(twoParams());
	assert.equal(state.currentTab, 0);
	const after1 = reduce(state, { type: "confirm" });
	assert.equal(after1.status, "continue");
	assert.equal(state.currentTab, 1);
	const after2 = reduce(state, { type: "confirm" });
	assert.equal(after2.status, "continue");
	assert.equal(isSubmitTab(state), true);
	assert.equal(allAnswered(state), true);
	const result = submitted(reduce(state, { type: "confirm" }));
	assert.deepEqual(
		result.answers.map((a) => a.answer),
		["a", "c"],
	);
});

test("提交页闸门：有未答题时 Enter 不提交", () => {
	const state = createState(twoParams());
	reduce(state, { type: "confirm" }); // Q1
	reduce(state, { type: "nextTab" }); // 跳过 Q2 到提交页
	assert.equal(isSubmitTab(state), true);
	assert.deepEqual(unansweredHeaders(state), ["Two"]);
	const outcome = reduce(state, { type: "confirm" });
	assert.equal(outcome.status, "continue");
});

test("Tab 环绕切换（含提交页），切页重置光标并按已有答案恢复", () => {
	const state = createState(twoParams());
	reduce(state, { type: "down" }); // Q1 cursor=1（选项 b）
	reduce(state, { type: "nextTab" });
	assert.equal(state.currentTab, 1);
	assert.equal(state.cursor, 0);
	reduce(state, { type: "nextTab" });
	assert.equal(isSubmitTab(state), true);
	reduce(state, { type: "nextTab" }); // 环绕回 Q1
	assert.equal(state.currentTab, 0);
	// Q1 尚无答案，光标回 0
	assert.equal(state.cursor, 0);
});

test("重答已答过的单选题：光标恢复到原选项", () => {
	const state = createState(twoParams());
	reduce(state, { type: "down" }); // cursor=1
	reduce(state, { type: "confirm" }); // 答 b，进 Q2
	reduce(state, { type: "prevTab" }); // 回 Q1
	assert.equal(state.currentTab, 0);
	assert.equal(state.cursor, 1); // 停在 b 上
	// 重答覆盖旧值
	const outcome = reduce(state, { type: "up" }); // cursor=0 → a
	assert.equal(outcome.status, "continue");
	reduce(state, { type: "confirm" });
	assert.equal(state.answers[0]?.answer, "a");
});

test("重答 custom 答案：光标恢复到哨兵行", () => {
	const state = createState(twoParams());
	reduce(state, { type: "down" });
	reduce(state, { type: "down" }); // 哨兵行
	reduce(state, { type: "confirm" }); // enterInput
	reduce(state, { type: "inputSubmit", text: "custom" }); // 答完进 Q2
	reduce(state, { type: "prevTab" });
	assert.equal(state.cursor, 2); // Q1 的哨兵行 = options.length
});

test("提交页上数字键 / Space 无效", () => {
	const state = createState(twoParams());
	reduce(state, { type: "confirm" });
	reduce(state, { type: "confirm" });
	assert.equal(isSubmitTab(state), true);
	assert.equal(reduce(state, { type: "digit", digit: 1 }).status, "continue");
	assert.equal(reduce(state, { type: "toggle" }).status, "continue");
	assert.equal(reduce(state, { type: "up" }).status, "continue");
});

test("单题模式下 Tab 切换无效", () => {
	const state = createState(singleParams());
	assert.equal(reduce(state, { type: "nextTab" }).status, "continue");
	assert.equal(state.currentTab, 0);
});
