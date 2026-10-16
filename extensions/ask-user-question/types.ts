/**
 * types.ts — ask_user_question's pure data model and constants (single source
 * of truth).
 *
 * Deliberately imports no typebox / pi / pi-tui: validate.ts / answers.ts /
 * dialog.ts / model.ts only depend on this file, so `node --test` runs their
 * unit tests directly (Node's type erasure strips annotations only — no
 * runtime deps are resolved). The TypeBox schema lives alone in schema.ts,
 * loaded by index.ts only inside pi's runtime.
 *
 * The shape matches Claude Code's AskUserQuestion (1-4 questions, 2-4
 * described options each, optional multiSelect) while dropping the reference
 * implementation's (npm:@juicesharp/rpiv-ask-user-question) preview sidebar,
 * per-question note, global note, and i18n — free text is handled by each
 * question's auto-appended "Type something." sentinel row: sufficient, and
 * an order of magnitude simpler.
 */

/** How many questions one call may ask. */
export const MAX_QUESTIONS = 4;
/** The fewest options per question. */
export const MIN_OPTIONS = 2;
/** The most options per question (not counting the auto-appended sentinel row). */
export const MAX_OPTIONS = 4;
/** The question chip label's display cap; overflow truncates at runtime (no error). */
export const MAX_HEADER_LENGTH = 16;
/** An option label's display cap; overflow truncates at runtime (no error). */
export const MAX_LABEL_LENGTH = 60;

/** The free-input row auto-appended to every question. The model may not write this label itself (reserved_label rejects it). */
export const CUSTOM_ANSWER_LABEL = "Type something.";

/**
 * Reserved labels: "Other" because a model conditioned by Claude Code keeps
 * trying to write its own Other option — and here the sentinel row is the
 * single source of that; CUSTOM_ANSWER_LABEL is the sentinel itself.
 */
export const RESERVED_LABELS: readonly string[] = ["Other", CUSTOM_ANSWER_LABEL];

export interface AskOption {
	label: string;
	description: string;
}

export interface AskQuestion {
	question: string;
	header: string;
	options: AskOption[];
	multiSelect?: boolean;
}

export interface AskParams {
	questions: AskQuestion[];
}

/**
 * One question's answer intent (a discriminated union — `kind` is the sole
 * discriminant):
 * - `option`: single-select, picked a model-given option; `answer` = the
 *   option's label
 * - `custom`: the user typed on the "Type something." row; `answer` = the
 *   typed text
 * - `multi`: a multi-select submit; `selected` = the picked labels, `answer`
 *   always null
 */
export type AskAnswerKind = "option" | "custom" | "multi";

export interface AskAnswer {
	questionIndex: number;
	question: string;
	kind: AskAnswerKind;
	answer: string | null;
	selected?: string[];
}

/**
 * The failure codes. `no_ui` / `no_dialog_ui` depend on host capabilities and
 * are judged on the execution path; the rest are produced by
 * validateQuestionnaire.
 */
export type AskErrorCode =
	| "no_ui"
	| "no_dialog_ui"
	| "no_questions"
	| "too_many_questions"
	| "duplicate_question"
	| "too_few_options"
	| "too_many_options"
	| "reserved_label"
	| "duplicate_option_label";

export interface AskResult {
	answers: AskAnswer[];
	cancelled: boolean;
	error?: AskErrorCode;
}
