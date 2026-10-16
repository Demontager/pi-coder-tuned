/**
 * view.ts — the questionnaire's TUI shell: key decoding + rendering. All
 * state semantics live in model.ts (pure); this file does exactly two
 * things: map pi-tui key sequences to Intents, and draw the state into rows.
 *
 * Hosted via `ctx.ui.custom()` (not an overlay): a custom component
 * temporarily takes over the editor area, and a plain object returning
 * `{ render, invalidate, handleInput }` satisfies pi-tui's Component shape
 * (the examples/extensions/question.ts approach — no pi-tui component
 * classes needed). The free-input row reuses pi-tui's Editor (multiline,
 * Shift+Enter for a newline, paste folding); Enter submits, Esc returns to
 * the option list.
 *
 * This file does not enter `node --test` (a real TUI cannot be built
 * headlessly — repo convention); everything testable lives in model.ts /
 * validate.ts / answers.ts / dialog.ts.
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

/** Digit keys 1-9 jump straight to the matching row (incl. the sentinel). */
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
				// a re-answer loads the previous draft back into the editor (switching away and back loses nothing).
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
