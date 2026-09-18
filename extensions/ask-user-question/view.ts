/**
 * view.ts — 问卷的 TUI 外壳：按键解码 + 渲染。状态语义全在 model.ts（纯），
 * 这里只做两件事：把 pi-tui 的按键序列映射成 Intent、把 state 画成行。
 *
 * 用 `ctx.ui.custom()` 装载（非 overlay）：custom 组件临时接管编辑器区，
 * 返回 `{ render, invalidate, handleInput }` 的普通对象即满足 pi-tui 的
 * Component 结构（examples/extensions/question.ts 同款做法，不依赖 pi-tui
 * 组件类）。自由输入行复用 pi-tui 的 Editor（多行、Shift+Enter 换行、
 * 粘贴折叠），Enter 提交、Esc 退回选项列表。
 *
 * 本文件不进 `node --test`（真 TUI 无法无头构建，仓库约定）；可单测的逻辑
 * 都在 model.ts / validate.ts / answers.ts / dialog.ts。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { CUSTOM_ANSWER_LABEL, type AskParams, type AskResult } from "./types.ts";
import { formatAnswerScalar } from "./answers.ts";
import {
	allAnswered,
	createState,
	hasSubmitTab,
	type Intent,
	isSubmitTab,
	reduce,
	unansweredHeaders,
} from "./model.ts";

/** 数字键 1-9 直接跳到对应行（含哨兵行）。 */
const DIGIT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export function createQuestionnaireView(
	tui: TUI,
	theme: Theme,
	params: AskParams,
	done: (result: AskResult) => void,
): Component {
	const state = createState(params);
	let cachedLines: string[] | undefined;

	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
	const editor = new Editor(tui, editorTheme);

	function refresh(): void {
		cachedLines = undefined;
		tui.requestRender();
	}

	function dispatch(intent: Intent): void {
		const outcome = reduce(state, intent);
		switch (outcome.status) {
			case "submit":
			case "cancel":
				done(outcome.result);
				return;
			case "enterInput": {
				// 重答时把上次打的字放回编辑器（切走再切回来不丢草稿）。
				const previous = state.answers[state.currentTab];
				editor.setText(previous?.kind === "custom" ? (previous.answer ?? "") : "");
				refresh();
				return;
			}
			case "exitInput":
				editor.setText("");
				refresh();
				return;
			case "continue":
				refresh();
				return;
		}
	}

	editor.onSubmit = (value) => dispatch({ type: "inputSubmit", text: value });

	function handleInput(data: string): void {
		if (state.inputMode) {
			if (matchesKey(data, Key.escape)) {
				dispatch({ type: "inputCancel" });
				return;
			}
			editor.handleInput(data);
			refresh();
			return;
		}

		if (matchesKey(data, Key.up)) return dispatch({ type: "up" });
		if (matchesKey(data, Key.down)) return dispatch({ type: "down" });
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) return dispatch({ type: "nextTab" });
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) return dispatch({ type: "prevTab" });
		if (matchesKey(data, Key.space)) return dispatch({ type: "toggle" });
		if (matchesKey(data, Key.enter)) return dispatch({ type: "confirm" });
		if (matchesKey(data, Key.escape)) return dispatch({ type: "cancel" });
		for (let i = 0; i < DIGIT_KEYS.length; i++) {
			if (matchesKey(data, DIGIT_KEYS[i])) return dispatch({ type: "digit", digit: i + 1 });
		}
	}

	function render(width: number): string[] {
		if (cachedLines) return cachedLines;
		const lines: string[] = [];
		const renderWidth = Math.max(1, width);

		const addWrapped = (text: string): void => {
			lines.push(...wrapTextWithAnsi(text, renderWidth));
		};
		const addWrappedWithPrefix = (prefix: string, text: string): void => {
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= renderWidth) {
				addWrapped(prefix + text);
				return;
			}
			const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
			const continuation = " ".repeat(prefixWidth);
			for (let i = 0; i < wrapped.length; i++) {
				lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
			}
		};

		lines.push(theme.fg("accent", "─".repeat(renderWidth)));

		if (hasSubmitTab(state)) {
			addWrappedWithPrefix(" ", renderTabBar());
			lines.push("");
		}

		if (isSubmitTab(state)) {
			renderSubmitTab();
		} else {
			renderQuestionTab();
		}

		lines.push("");
		addWrappedWithPrefix(" ", theme.fg("dim", helpLine()));
		lines.push(theme.fg("accent", "─".repeat(renderWidth)));

		cachedLines = lines;
		return lines;

		function renderTabBar(): string {
			const parts: string[] = [];
			for (let i = 0; i < state.questions.length; i++) {
				const q = state.questions[i];
				const answered = state.answers[i] !== undefined;
				const box = answered ? "■" : "□";
				const label = ` ${box} ${q.header || `Q${i + 1}`} `;
				const styled =
					i === state.currentTab
						? theme.bg("selectedBg", theme.fg("text", label))
						: theme.fg(answered ? "success" : "muted", label);
				parts.push(styled);
			}
			const submitActive = isSubmitTab(state);
			const submitLabel = " ✓ Submit ";
			const submitStyled = submitActive
				? theme.bg("selectedBg", theme.fg("text", submitLabel))
				: theme.fg(allAnswered(state) ? "success" : "dim", submitLabel);
			parts.push(submitStyled);
			return parts.join("");
		}

		function renderQuestionTab(): void {
			const q = state.questions[state.currentTab];
			if (!q) return;

			for (const line of q.question.split("\n")) {
				addWrappedWithPrefix(" ", theme.fg("text", line));
			}
			lines.push("");

			for (let i = 0; i < q.options.length; i++) {
				const opt = q.options[i];
				const selected = i === state.cursor;
				const prefix = selected ? theme.fg("accent", "> ") : "  ";
				const check = q.multiSelect ? `[${state.toggles[state.currentTab][i] ? "x" : " "}] ` : "";
				const label = `${i + 1}. ${check}${opt.label}`;
				addWrappedWithPrefix(prefix, theme.fg(selected ? "accent" : "text", label));
				if (opt.description) {
					addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
				}
			}

			const sentinelSelected = state.cursor === q.options.length;
			const sentinelPrefix = sentinelSelected ? theme.fg("accent", "> ") : "  ";
			const sentinel = `${q.options.length + 1}. ${CUSTOM_ANSWER_LABEL}${state.inputMode ? " ✎" : ""}`;
			addWrappedWithPrefix(sentinelPrefix, theme.fg(sentinelSelected || state.inputMode ? "accent" : "dim", sentinel));

			if (state.inputMode) {
				lines.push("");
				addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
				for (const line of editor.render(Math.max(1, renderWidth - 2))) {
					lines.push(` ${line}`);
				}
			}
		}

		function renderSubmitTab(): void {
			addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Review your answers")));
			lines.push("");
			for (let i = 0; i < state.questions.length; i++) {
				const q = state.questions[i];
				const answer = state.answers[i];
				const head = theme.fg("muted", `${q.header || `Q${i + 1}`}: `);
				if (answer) {
					const text = answer.kind === "custom" ? `✎ ${formatAnswerScalar(answer)}` : formatAnswerScalar(answer);
					addWrappedWithPrefix(` ${theme.fg("success", "✓")} `, head + theme.fg("text", text));
				} else {
					addWrappedWithPrefix(` ${theme.fg("warning", "○")} `, head + theme.fg("dim", "(unanswered)"));
				}
			}
			lines.push("");
			if (allAnswered(state)) {
				addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
			} else {
				addWrappedWithPrefix(
					" ",
					theme.fg("warning", `Unanswered: ${unansweredHeaders(state).join(", ")} — Tab back to answer`),
				);
			}
		}

		function helpLine(): string {
			if (state.inputMode) return "Enter submit · Esc back";
			if (isSubmitTab(state)) return "Enter submit · Tab back · Esc cancel";
			const q = state.questions[state.currentTab];
			const parts: string[] = [];
			if (hasSubmitTab(state)) parts.push("Tab switch question");
			parts.push("↑↓ move");
			if (q?.multiSelect) parts.push("Space toggle");
			parts.push(`1-${q ? q.options.length + 1 : 9} jump`);
			parts.push("Enter confirm");
			parts.push("Esc cancel");
			return parts.join(" · ");
		}
	}

	return {
		render,
		invalidate: () => {
			cachedLines = undefined;
			editor.invalidate();
		},
		handleInput,
	};
}
