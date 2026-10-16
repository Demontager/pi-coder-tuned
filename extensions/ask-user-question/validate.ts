/**
 * validate.ts — params normalization + runtime validation (pure functions,
 * no pi / pi-tui / typebox imports).
 *
 * Normalization runs once at execute's entrance, before validation — every
 * downstream consumer (the validator, the TUI, the dialog fallback, the
 * answer envelope) sees one clean copy:
 * - line terminators: `\r\n` → `\n`, a lone `\r` deleted (CR is a cursor
 *   control byte, not text — left in, it breaks the row's head pointer; the
 *   same normalization pi's own display does)
 * - header / label / description are single-line chips / list rows:
 *   whitespace runs (incl. newlines) collapse to one space, then clip;
 *   question keeps newlines (the renderer wraps row by row)
 * - clipping appends `…`; the caps are in types.ts (deliberately no
 *   maxLength in the schema — the reason is in schema.ts)
 *
 * Validation covers counts plus duplicate/reserved labels; `reserved_label`
 * must short-circuit before `duplicate_option_label` (two "Other"s are
 * first a reserved-word problem).
 */

import {
	MAX_HEADER_LENGTH,
	MAX_LABEL_LENGTH,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	RESERVED_LABELS,
	type AskErrorCode,
	type AskParams,
} from "./types.ts";

export const ERROR_NO_QUESTIONS = "Error: At least one question is required";
export const ERROR_TOO_MANY_QUESTIONS = `Error: At most ${MAX_QUESTIONS} questions are allowed per invocation — group them into one call with fewer questions`;
export const ERROR_DUPLICATE_QUESTION = "Error: Question text must be unique within an invocation";
export const ERROR_TOO_FEW_OPTIONS = `Error: Each question requires at least ${MIN_OPTIONS} options`;
export const ERROR_TOO_MANY_OPTIONS = `Error: Each question allows at most ${MAX_OPTIONS} options`;
export const ERROR_RESERVED_LABEL = `Error: Option label is reserved (${RESERVED_LABELS.join(", ")}) — the custom-answer row is appended automatically`;
export const ERROR_DUPLICATE_OPTION_LABEL = "Error: Option labels must be unique within a question";

const RESERVED_LABEL_SET: ReadonlySet<string> = new Set(RESERVED_LABELS);

export type ValidationResult = { ok: true } | { ok: false; error: AskErrorCode; message: string };

/** `\r\n` → `\n`, a lone `\r` deleted (not a space — it would leave phantom gaps mid-word). */
export function normalizeLineTerminators(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

/** Single-line: line terminators normalized + whitespace runs collapsed to one space + trimmed. */
function toSingleLine(text: string): string {
	return normalizeLineTerminators(text).replace(/\s+/g, " ").trim();
}

/** Clip to max by **character count**, appending `…` on overflow (only meaningful for max ≥ 2). */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

/**
 * Returns a params copy: all display strings normalized, header/label
 * clipped. Pure — never mutates the input.
 * The reserved-label **comparison** happens after normalization (an
 * `"Other\r"` must not slip past reserved_label).
 */
export function normalizeParams(params: AskParams): AskParams {
	return {
		questions: params.questions.map((q) => ({
			question: normalizeLineTerminators(q.question).trim(),
			header: clip(toSingleLine(q.header), MAX_HEADER_LENGTH),
			multiSelect: q.multiSelect === true,
			options: q.options.map((o) => ({
				label: clip(toSingleLine(o.label), MAX_LABEL_LENGTH),
				description: toSingleLine(o.description),
			})),
		})),
	};
}

/** The pure runtime validator. no_ui / no_dialog_ui depend on host capabilities — judged on the execution path. */
export function validateQuestionnaire(params: AskParams): ValidationResult {
	if (params.questions.length === 0) {
		return { ok: false, error: "no_questions", message: ERROR_NO_QUESTIONS };
	}
	if (params.questions.length > MAX_QUESTIONS) {
		return { ok: false, error: "too_many_questions", message: ERROR_TOO_MANY_QUESTIONS };
	}

	const seenQuestions = new Set<string>();
	for (const q of params.questions) {
		if (seenQuestions.has(q.question)) {
			return { ok: false, error: "duplicate_question", message: ERROR_DUPLICATE_QUESTION };
		}
		seenQuestions.add(q.question);
	}

	for (const q of params.questions) {
		if (q.options.length < MIN_OPTIONS) {
			return { ok: false, error: "too_few_options", message: ERROR_TOO_FEW_OPTIONS };
		}
		if (q.options.length > MAX_OPTIONS) {
			return { ok: false, error: "too_many_options", message: ERROR_TOO_MANY_OPTIONS };
		}
		const seenLabels = new Set<string>();
		for (const o of q.options) {
			if (RESERVED_LABEL_SET.has(o.label)) {
				return { ok: false, error: "reserved_label", message: ERROR_RESERVED_LABEL };
			}
			if (seenLabels.has(o.label)) {
				return { ok: false, error: "duplicate_option_label", message: ERROR_DUPLICATE_OPTION_LABEL };
			}
			seenLabels.add(o.label);
		}
	}

	return { ok: true };
}
