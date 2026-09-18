/**
 * model.ts — 问卷的纯状态机（不 import pi / pi-tui），view.ts 只是它的一层
 * 按键解码 + 渲染外壳。所有交互语义（tab 切换、光标、多选勾选、单选/多选/
 * 自由输入的提交、提交页闸门、取消）都集中在这里，`node --test` 直接覆盖。
 *
 * 状态约定：
 * - `currentTab` 0..n-1 是问题页；`n`（=questions.length）是提交页，**只有
 *   多题（n>1）才有提交页**——单题选完即提交，没有可切换的页。
 * - `cursor` 是当前问题页内的行号：0..options.length-1 是模型给的选项，
 *   options.length 是自动追加的 "Type something." 哨兵行。
 * - `toggles[i][j]` 是第 i 题多选下第 j 个选项的勾选态（单选不用）。
 * - `answers[i]` 是第 i 题已提交的答案；重答覆盖旧值。
 *
 * reduce 原地改 state、返回 Outcome 告诉外壳下一步做什么（继续 / 进自由输入 /
 * 出自由输入 / 提交 / 取消）。提交与取消的 result 都是**已答部分**的快照。
 */

import type { AskAnswer, AskParams, AskQuestion, AskResult } from "./types.ts";

export interface QuestionnaireState {
	readonly questions: AskQuestion[];
	currentTab: number;
	cursor: number;
	inputMode: boolean;
	answers: Array<AskAnswer | undefined>;
	toggles: boolean[][];
}

export type Intent =
	| { type: "up" }
	| { type: "down" }
	| { type: "nextTab" }
	| { type: "prevTab" }
	| { type: "toggle" }
	| { type: "digit"; digit: number }
	| { type: "confirm" }
	| { type: "cancel" }
	| { type: "inputSubmit"; text: string }
	| { type: "inputCancel" };

export type Outcome =
	| { status: "continue" }
	| { status: "enterInput" }
	| { status: "exitInput" }
	| { status: "submit"; result: AskResult }
	| { status: "cancel"; result: AskResult };

const CONTINUE: Outcome = { status: "continue" };

export function createState(params: AskParams): QuestionnaireState {
	return {
		questions: params.questions,
		currentTab: 0,
		cursor: 0,
		inputMode: false,
		answers: params.questions.map(() => undefined),
		toggles: params.questions.map((q) => q.options.map(() => false)),
	};
}

/** 多题才有提交页。 */
export function hasSubmitTab(state: QuestionnaireState): boolean {
	return state.questions.length > 1;
}

export function isSubmitTab(state: QuestionnaireState): boolean {
	return hasSubmitTab(state) && state.currentTab === state.questions.length;
}

/** 当前问题页的行数 = 选项数 + 1（哨兵行）。提交页无意义，返回 0。 */
export function rowCount(state: QuestionnaireState): number {
	const q = state.questions[state.currentTab];
	return q ? q.options.length + 1 : 0;
}

export function allAnswered(state: QuestionnaireState): boolean {
	return state.answers.every((a) => a !== undefined);
}

/** 未回答问题的 header 列表（提交页提示用）。 */
export function unansweredHeaders(state: QuestionnaireState): string[] {
	const headers: string[] = [];
	for (let i = 0; i < state.questions.length; i++) {
		if (state.answers[i] === undefined) headers.push(state.questions[i].header || `Q${i + 1}`);
	}
	return headers;
}

/** 已答部分（去掉 undefined）的快照，按题序。 */
function compactAnswers(state: QuestionnaireState): AskAnswer[] {
	return state.answers.filter((a): a is AskAnswer => a !== undefined);
}

function currentQuestion(state: QuestionnaireState): AskQuestion | undefined {
	return state.questions[state.currentTab];
}

function selectedLabels(state: QuestionnaireState): string[] {
	const q = currentQuestion(state);
	if (!q) return [];
	const toggles = state.toggles[state.currentTab];
	const labels: string[] = [];
	for (let i = 0; i < q.options.length; i++) {
		if (toggles[i]) labels.push(q.options[i].label);
	}
	return labels;
}

/** 提交当前题后前进：单题直接提交；多题去下一题，最后一题去提交页。 */
function advance(state: QuestionnaireState): Outcome {
	if (state.questions.length === 1) {
		return { status: "submit", result: { answers: compactAnswers(state), cancelled: false } };
	}
	if (state.currentTab < state.questions.length - 1) {
		focusTab(state, state.currentTab + 1);
	} else {
		state.currentTab = state.questions.length; // 提交页
		state.cursor = 0;
	}
	return CONTINUE;
}

/** 切到某页并按已有答案恢复光标位置（重答时停在原选择上）。 */
function focusTab(state: QuestionnaireState, tab: number): void {
	state.currentTab = tab;
	state.cursor = 0;
	state.inputMode = false;
	const q = state.questions[tab];
	const answer = state.answers[tab];
	if (!q || !answer) return;
	if (answer.kind === "custom") {
		state.cursor = q.options.length; // 哨兵行
	} else if (answer.kind === "option" && answer.answer != null) {
		const idx = q.options.findIndex((o) => o.label === answer.answer);
		if (idx >= 0) state.cursor = idx;
	} else if (answer.kind === "multi" && answer.selected) {
		const first = q.options.findIndex((o) => answer.selected!.includes(o.label));
		if (first >= 0) state.cursor = first;
	}
}

function recordOption(state: QuestionnaireState): void {
	const q = currentQuestion(state);
	if (!q) return;
	const opt = q.options[state.cursor];
	if (!opt) return;
	state.answers[state.currentTab] = {
		questionIndex: state.currentTab,
		question: q.question,
		kind: "option",
		answer: opt.label,
	};
}

function recordMulti(state: QuestionnaireState): void {
	const q = currentQuestion(state);
	if (!q) return;
	state.answers[state.currentTab] = {
		questionIndex: state.currentTab,
		question: q.question,
		kind: "multi",
		answer: null,
		selected: selectedLabels(state),
	};
}

function recordCustom(state: QuestionnaireState, text: string): void {
	const q = currentQuestion(state);
	if (!q) return;
	state.answers[state.currentTab] = {
		questionIndex: state.currentTab,
		question: q.question,
		kind: "custom",
		answer: text,
	};
}

export function reduce(state: QuestionnaireState, intent: Intent): Outcome {
	switch (intent.type) {
		case "up": {
			if (!isSubmitTab(state)) state.cursor = Math.max(0, state.cursor - 1);
			return CONTINUE;
		}
		case "down": {
			if (!isSubmitTab(state)) state.cursor = Math.min(rowCount(state) - 1, state.cursor + 1);
			return CONTINUE;
		}
		case "nextTab":
		case "prevTab": {
			if (!hasSubmitTab(state)) return CONTINUE;
			const total = state.questions.length + 1; // 含提交页
			const delta = intent.type === "nextTab" ? 1 : -1;
			const next = (state.currentTab + delta + total) % total;
			focusTab(state, next);
			return CONTINUE;
		}
		case "toggle": {
			const q = currentQuestion(state);
			if (!q || isSubmitTab(state) || !q.multiSelect) return CONTINUE;
			if (state.cursor >= q.options.length) return CONTINUE; // 哨兵行不可勾
			state.toggles[state.currentTab][state.cursor] = !state.toggles[state.currentTab][state.cursor];
			return CONTINUE;
		}
		case "digit": {
			const q = currentQuestion(state);
			if (!q || isSubmitTab(state)) return CONTINUE;
			const d = intent.digit;
			if (d >= 1 && d <= q.options.length) {
				if (q.multiSelect) {
					state.cursor = d - 1;
					state.toggles[state.currentTab][d - 1] = !state.toggles[state.currentTab][d - 1];
					return CONTINUE;
				}
				state.cursor = d - 1;
				recordOption(state);
				return advance(state);
			}
			if (d === q.options.length + 1) {
				state.cursor = q.options.length;
				state.inputMode = true;
				return { status: "enterInput" };
			}
			return CONTINUE;
		}
		case "confirm": {
			if (isSubmitTab(state)) {
				if (!allAnswered(state)) return CONTINUE;
				return { status: "submit", result: { answers: compactAnswers(state), cancelled: false } };
			}
			const q = currentQuestion(state);
			if (!q) return CONTINUE;
			if (state.cursor === q.options.length) {
				state.inputMode = true;
				return { status: "enterInput" };
			}
			if (q.multiSelect) {
				recordMulti(state);
			} else {
				recordOption(state);
			}
			return advance(state);
		}
		case "cancel":
			return { status: "cancel", result: { answers: compactAnswers(state), cancelled: true } };
		case "inputSubmit": {
			const text = intent.text.trim();
			if (text.length === 0) {
				state.inputMode = false;
				return { status: "exitInput" };
			}
			recordCustom(state, text);
			state.inputMode = false;
			return advance(state);
		}
		case "inputCancel":
			state.inputMode = false;
			return { status: "exitInput" };
	}
}
