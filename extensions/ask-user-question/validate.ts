/**
 * validate.ts — 参数归一化 + 运行时校验（纯函数，不 import pi / pi-tui / typebox）。
 *
 * 归一化在 execute 入口跑一次、校验之前，所以下游所有消费者（校验器、TUI、
 * 对话框回退、答案封装）看到的都是同一份干净文本：
 * - 行终止符：`\r\n` → `\n`、落单 `\r` 删除（CR 是光标控制字节不是文本，
 *   直接进渲染会把行首指针冲掉；与 pi 自己的显示归一化口径一致）
 * - header / label / description 是单行 chip / 列表行，空白串（含换行）折叠成
 *   一个空格再截断；question 保留换行（渲染端逐行折行）
 * - 截断补 `…`，上限见 types.ts（刻意不在 schema 里设 maxLength，理由见 schema.ts）
 *
 * 校验覆盖数量与重复/保留 label；`reserved_label` 必须短路在
 * `duplicate_option_label` 之前（两个 "Other" 首先是保留字问题）。
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

/** `\r\n` → `\n`，落单 `\r` 删除（不是空格：会在词中间留幻影间隙）。 */
export function normalizeLineTerminators(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

/** 单行化：行终止符归一 + 空白串折叠成一个空格 + 去首尾。 */
function toSingleLine(text: string): string {
	return normalizeLineTerminators(text).replace(/\s+/g, " ").trim();
}

/** 按**字符数**截断到 max，超长补 `…`（max ≥ 2 才有意义）。 */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

/**
 * 返回参数副本：所有展示字符串归一化，header/label 截断。纯函数，不改入参。
 * 保留 label 的**比较**发生在归一化之后（`"Other\r"` 不能溜过 reserved_label）。
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

/** 纯运行时校验器。no_ui / no_dialog_ui 依赖宿主能力，留在执行路径上判。 */
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
