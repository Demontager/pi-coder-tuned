/**
 * answers.ts — 把问卷结果封装成给模型的 tool result（纯函数）。
 *
 * 成功：`User has answered your questions: "<问题>"="<答案>". … You can now
 * continue with the user's answers in mind.`；多选答案用 ", " 连接。
 * 取消 / 无答案段：统一塌缩成 DECLINE_MESSAGE 这一个规范信号，
 * 模型不会把"没答"误读成"拒绝回答内容"之外的任何东西。
 *
 * 错误路径（no_ui / 校验失败等）也走 errorResult：`cancelled: true` +
 * 空 answers + error 码 —— content 文本是写给模型看的，不是日志。
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

/** 单个答案的标量形式：option → label；custom → 输入文本；multi → ", " 连接。 */
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

/** 单题答案段：`"<问题>"="<答案>".` */
export function buildAnswerSegment(a: AskAnswer): string {
	return `"${a.question}"="${formatAnswerScalar(a)}".`;
}

/**
 * 结果 → 给模型的正文。cancelled / null / 零答案段都落到 DECLINE_MESSAGE；
 * 部分提交允许：未回答的题不产生段。
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

/** 完整成功/取消路径：result + params → tool result。 */
export function buildResponse(result: AskResult | null | undefined, params: AskParams): AskToolResult {
	if (!result || result.cancelled) {
		return toolResult(DECLINE_MESSAGE, { answers: result?.answers ?? [], cancelled: true });
	}
	return toolResult(buildEnvelopeText(result, params), result);
}

/** 错误路径：content 写给模型的错误说明 + cancelled:true + error 码。 */
export function errorResult(message: string, error: AskErrorCode, answers: AskAnswer[] = []): AskToolResult {
	return toolResult(message, { answers, cancelled: true, error });
}
