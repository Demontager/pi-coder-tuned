/**
 * schema.ts — ask_user_question's TypeBox params schema (loaded only inside
 * pi's runtime).
 *
 * Deliberately **no maxLength**: pi validates the params against the schema
 * before execute (pi-ai's `validateToolArguments`), and an over-long
 * header/label would fail the whole call — a burned turn; a clipped chip
 * label harms nothing, so length caps go to validate.ts's runtime
 * normalization (clip + `…`), while the schema's descriptions still teach
 * the model the soft caps. The count limits (1-4 questions, 2-4 options
 * each) **stay in the schema**: silently dropping a fifth option would
 * distort the model's intent — a clear validation error to retry on is the
 * right behavior.
 */

import { Type } from "typebox";
import { CUSTOM_ANSWER_LABEL, MAX_HEADER_LENGTH, MAX_LABEL_LENGTH, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from "./types.ts";

export const AskOptionSchema = Type.Object({
	label: Type.String({
		description: `Display text for this option that the user will see and select. Concise (1-5 words; soft limit ${MAX_LABEL_LENGTH} characters, longer labels are truncated in the UI). Do NOT author "${CUSTOM_ANSWER_LABEL}" or "Other" — reserved.`,
	}),
	description: Type.String({
		description: "Explanation of what this option means or what will happen if chosen. Use it for trade-offs and implications.",
	}),
});

export const AskQuestionSchema = Type.Object({
	question: Type.String({
		description: 'The complete question to ask the user. Clear, specific, ends with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
	}),
	header: Type.String({
		description: `Very short chip/tag shown next to the question, max ${MAX_HEADER_LENGTH} characters (longer headers are truncated). Examples: "Auth method", "Library", "Approach".`,
	}),
	options: Type.Array(AskOptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description: `The available choices, ${MIN_OPTIONS}-${MAX_OPTIONS} distinct mutually exclusive options (unless multiSelect). The "${CUSTOM_ANSWER_LABEL}" row is appended automatically — do NOT author it. If you recommend an option, put it first and append "(Recommended)" to its label.`,
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive. Default false.",
		}),
	),
});

export const AskParamsSchema = Type.Object({
	questions: Type.Array(AskQuestionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: `Questions to ask the user (1-${MAX_QUESTIONS} per invocation). Group all clarifying questions into one invocation.`,
	}),
});
