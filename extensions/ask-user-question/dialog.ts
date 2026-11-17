/**
 * dialog.ts — the sequential dialog fallback for non-TUI hosts (RPC / ACP —
 * a VS Code pendant, Zed, etc.).
 *
 * `ctx.ui.custom()` cannot render on those hosts, but the select / input
 * dialog subprotocol (extension_ui_request/response) works — so each
 * question walks a native dialog, producing the very same AskResult the TUI
 * produces, fed into the same buildResponse envelope. Pure functions (the
 * duck-typed DialogUI), no pi imports — unit tests cover it with a fake ui.
 *
 * The tradeoff vs the TUI: no tab-style multi-question overview (one dialog
 * per question); multi-select degrades to "type numbers, comma-separated";
 * any non-number input is kept verbatim as a free-text answer (also the
 * multi-select's "Type something." escape hatch). Closing any dialog
 * (resolving undefined) = the whole questionnaire is cancelled — the same
 * meaning as Esc in the TUI.
 */

import { CUSTOM_ANSWER_LABEL, type AskAnswer, type AskParams, type AskQuestion, type AskResult } from "./types.ts";

/** The slice of ExtensionUIContext this module needs. Structured types + the hasDialogUI runtime gate. */
export type DialogUI = {
	select: (title: string, options: string[]) => Promise<string | undefined>;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
};

export function hasDialogUI(ui: unknown): ui is DialogUI {
	const u = ui as Partial<Record<"select" | "input", unknown>> | null | undefined;
	return typeof u?.select === "function" && typeof u?.input === "function";
}

function formatOptionLine(q: AskQuestion, index: number): string {
	const o = q.options[index];
	return `${index + 1}. ${o.label} — ${o.description}`;
}

/** Parse a selection string like "2. Label — desc" or "2" into a 0-based index; out of range / non-numeric → null. */
export function parseIndex(token: string, count: number): number | null {
	const i = Number.parseInt(token, 10) - 1;
	return Number.isFinite(i) && i >= 0 && i < count ? i : null;
}

/** Each question walks a native dialog. undefined (a closed dialog) = the whole questionnaire is cancelled, keeping the answered portion. */
export async function runDialogQuestionnaire(ui: DialogUI, params: AskParams): Promise<AskResult> {
	const answers: AskAnswer[] = [];
	for (let qi = 0; qi < params.questions.length; qi++) {
		const q = params.questions[qi];
		const header = q.header ? `[${q.header}] ` : "";
		const answer = q.multiSelect ? await askMultiSelect(ui, q, qi, header) : await askSingleSelect(ui, q, qi, header);
		if (answer === undefined) return { answers, cancelled: true };
		answers.push(answer);
	}
	return { answers, cancelled: false };
}

async function askSingleSelect(
	ui: DialogUI,
	q: AskQuestion,
	questionIndex: number,
	header: string,
): Promise<AskAnswer | undefined> {
	const options = q.options.map((_o, i) => formatOptionLine(q, i));
	options.push(`${q.options.length + 1}. ${CUSTOM_ANSWER_LABEL}`);
	const chosen = await ui.select(`${header}${q.question}`, options);
	if (chosen == null) return undefined;
	const idx = parseIndex(chosen, options.length);
	// a host returning something off the list is indistinguishable from a closed dialog — treated as cancel, never an invented answer.
	if (idx == null) return undefined;
	if (idx < q.options.length) {
		return { questionIndex, question: q.question, kind: "option", answer: q.options[idx].label };
	}
	const typed = await ui.input(`${header}${q.question}\n\nType your answer:`, "");
	if (typed == null) return undefined;
	return { questionIndex, question: q.question, kind: "custom", answer: typed };
}

const MULTI_INSTRUCTIONS = 'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.';

async function askMultiSelect(
	ui: DialogUI,
	q: AskQuestion,
	questionIndex: number,
	header: string,
): Promise<AskAnswer | undefined> {
	const list = q.options.map((_o, i) => formatOptionLine(q, i)).join("\n");
	const value = await ui.input(`${header}${q.question}\n\n${list}\n\n${MULTI_INSTRUCTIONS}`, "1,3");
	if (value == null) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		// an empty submit = nothing checked — the same meaning as Enter with nothing toggled in the TUI.
		return { questionIndex, question: q.question, kind: "multi", answer: null, selected: [] };
	}
	const tokens = trimmed.split(/[,\s]+/).filter((tok) => tok.length > 0);
	const indices = tokens.map((tok) => (/^\d+\.?$/.test(tok) ? parseIndex(tok, q.options.length) : null));
	if (indices.every((i): i is number => i != null)) {
		const selected: string[] = [];
		for (const i of indices) {
			const label = q.options[i].label;
			if (!selected.includes(label)) selected.push(label);
		}
		return { questionIndex, question: q.question, kind: "multi", answer: null, selected };
	}
	// any non-number token (text, or an out-of-range number like "13") = the user typing an answer —
	// kept verbatim as custom, never silently dropped.
	return { questionIndex, question: q.question, kind: "custom", answer: trimmed };
}
