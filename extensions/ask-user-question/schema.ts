/**
 * schema.ts — ask_user_question 的 TypeBox 参数 schema（只在 pi 运行时加载）。
 *
 * 刻意**不设 maxLength**：pi 在 execute 之前用 schema 校验参数
 * （pi-ai `validateToolArguments`），header/label 超长会让整次调用直接失败、
 * 白烧一个回合；而 chip 标签截断显示毫无危害，所以长度上限交给
 * validate.ts 的运行时归一化（截断 + 补 `…`），schema 的 description 里
 * 仍然写明软上限教模型。数量约束（1-4 题、每题 2-4 项）**保留在 schema 里**：
 * 悄悄丢掉第 5 个选项会歪曲模型本意，让它拿到明确校验错误去重试才对。
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
