/**
 * answers.ts — package the questionnaire result into the tool result for the
 * model (pure functions).
 *
 * Success: `User has answered your questions: "<question>"="<answer>".
 * … You can now continue with the user's answers in mind.`; a multi-select
 * answer is joined with ", ".
 * Cancelled / no answer segments: collapsed to the one canonical
 * DECLINE_MESSAGE — the model cannot read "unanswered" as anything other
 * than declined.
 *
 * Error paths (no_ui / validation failure, etc.) also take errorResult:
 * `cancelled: true` + empty answers + an error code — the content text is
 * written for the model, not a log.
 */

import type { AskAnswer, AskErrorCode, AskParams, AskResult } from "./types.ts";

export const DECLINE_MESSAGE = "User declined to answer the questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";
export const NO_INPUT_PLACEHOLDER = "(no input)";

export interface AskToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: AskResult;
}

/** One answer's scalar form: option → the label; custom → the typed text; multi → joined with ", ". */
export function formatAnswerScalar(a: AskAnswer): string {
	switch (a.kind) {
		case "multi":
			return a.selected && a.selected.length > 0 ? a.selected.join(", ") : NO_INPUT_PLACEHOLDER;
		case "custom":
			return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
		case "option":
			return a.answer ?? NO_INPUT_PLACEHOLDER;
	}
}

/** One question's answer segment: `"<question>"="<answer>".` */
export function buildAnswerSegment(a: AskAnswer): string {
	return `"${a.question}"="${formatAnswerScalar(a)}".`;
}

/**
 * Result → the body text for the model. cancelled / null / zero answer
 * segments all land on DECLINE_MESSAGE; a partial submit is allowed —
 * unanswered questions produce no segment.
 */
export function buildEnvelopeText(result: AskResult | null | undefined, params: AskParams): string {
	if (!result || result.cancelled) return DECLINE_MESSAGE;
	const segments: string[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) segments.push(buildAnswerSegment(a));
	}
	if (segments.length === 0) return DECLINE_MESSAGE;
	return `${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`;
}

export function toolResult(text: string, details: AskResult): AskToolResult {
	return { content: [{ type: "text", text }], details };
}

/** The full success/cancel path: result + params → the tool result. */
export function buildResponse(result: AskResult | null | undefined, params: AskParams): AskToolResult {
	if (!result || result.cancelled) {
		return toolResult(DECLINE_MESSAGE, { answers: result?.answers ?? [], cancelled: true });
	}
	return toolResult(buildEnvelopeText(result, params), result);
}

/** The error path: the model-facing error text in content + cancelled:true + the error code. */
export function errorResult(message: string, error: AskErrorCode, answers: AskAnswer[] = []): AskToolResult {
	return toolResult(message, { answers, cancelled: true, error });
}
