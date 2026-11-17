/**
 * model.ts — the questionnaire's pure state machine (no pi / pi-tui imports);
 * view.ts is only its key-decoding + rendering shell. All the interaction
 * semantics (tab switching, cursor, multi-select toggles, single/multi/free-
 * text submits, the submit-page gate, cancel) live here — `node --test`
 * covers them directly.
 *
 * State conventions:
 * - `currentTab` 0..n-1 are question pages; `n` (= questions.length) is the
 *   submit page — **only multi-question runs (n>1) have a submit page**: a
 *   single question submits on selection, there is nothing to switch to.
 * - `cursor` is the row index inside the current question page:
 *   0..options.length-1 are the model's options; options.length is the
 *   auto-appended "Type something." sentinel row.
 * - `toggles[i][j]` is option j's checked state under question i's
 *   multi-select (single-select does not use it).
 * - `answers[i]` is question i's submitted answer; re-answering overwrites.
 *
 * reduce mutates state in place and returns an Outcome telling the shell what
 * to do next (continue / enter free input / leave free input / submit /
 * cancel). The result of both submit and cancel is a snapshot of the
 * **answered portion**.
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

/** Only multi-question runs have a submit page. */
export function hasSubmitTab(state: QuestionnaireState): boolean {
	return state.questions.length > 1;
}

export function isSubmitTab(state: QuestionnaireState): boolean {
	return hasSubmitTab(state) && state.currentTab === state.questions.length;
}

/** The current question page's row count = options + 1 (the sentinel row). Meaningless on the submit page → 0. */
export function rowCount(state: QuestionnaireState): number {
	const q = state.questions[state.currentTab];
	return q ? q.options.length + 1 : 0;
}

export function allAnswered(state: QuestionnaireState): boolean {
	return state.answers.every((a) => a !== undefined);
}

/** The headers of unanswered questions (for the submit page's hint). */
export function unansweredHeaders(state: QuestionnaireState): string[] {
	const headers: string[] = [];
	for (let i = 0; i < state.questions.length; i++) {
		if (state.answers[i] === undefined) headers.push(state.questions[i].header || `Q${i + 1}`);
	}
	return headers;
}

/** A snapshot of the answered portion (undefined dropped), in question order. */
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

/** Advance after submitting the current question: a single question submits; multi goes to the next question, the last one to the submit page. */
function advance(state: QuestionnaireState): Outcome {
	if (state.questions.length === 1) {
		return { status: "submit", result: { answers: compactAnswers(state), cancelled: false } };
	}
	if (state.currentTab < state.questions.length - 1) {
		focusTab(state, state.currentTab + 1);
	} else {
		state.currentTab = state.questions.length; // the submit page
		state.cursor = 0;
	}
	return CONTINUE;
}

/** Switch to a page and restore the cursor from the existing answer (a re-answer parks on the previous pick). */
function focusTab(state: QuestionnaireState, tab: number): void {
	state.currentTab = tab;
	state.cursor = 0;
	state.inputMode = false;
	const q = state.questions[tab];
	const answer = state.answers[tab];
	if (!q || !answer) return;
	if (answer.kind === "custom") {
		state.cursor = q.options.length; // the sentinel row
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
			const total = state.questions.length + 1; // incl. the submit page
			const delta = intent.type === "nextTab" ? 1 : -1;
			const next = (state.currentTab + delta + total) % total;
			focusTab(state, next);
			return CONTINUE;
		}
		case "toggle": {
			const q = currentQuestion(state);
			if (!q || isSubmitTab(state) || !q.multiSelect) return CONTINUE;
			if (state.cursor >= q.options.length) return CONTINUE; // the sentinel row cannot be checked
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
