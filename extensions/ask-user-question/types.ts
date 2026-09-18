/**
 * types.ts — ask_user_question 的纯数据模型与常量（单一事实来源）。
 *
 * 刻意不 import typebox / pi / pi-tui：validate.ts / answers.ts / dialog.ts /
 * model.ts 只依赖本文件，所以 `node --test` 能直接跑它们的单测（Node 的类型擦除
 * 只擦标注、不解析运行时依赖）。TypeBox schema 单独放 schema.ts，只在 pi 运行时
 * 被 index.ts 加载。
 *
 * 形状对齐 Claude Code 的 AskUserQuestion（1-4 个问题、每题 2-4 个带说明的选项、
 * 可选 multiSelect），刻意砍掉参考实现（npm:@juicesharp/rpiv-ask-user-question）
 * 里的 preview 侧栏、逐题 note、全局 note 与 i18n —— 自由文本由每题自动追加的
 * "Type something." 哨兵行承担，够用且 UI 简单一个量级。
 */

/** 一次调用最多问几个问题。 */
export const MAX_QUESTIONS = 4;
/** 每题最少选项数。 */
export const MIN_OPTIONS = 2;
/** 每题最多选项数（不含自动追加的哨兵行）。 */
export const MAX_OPTIONS = 4;
/** 问题 chip 标签的显示上限；超长在运行时截断（不报错）。 */
export const MAX_HEADER_LENGTH = 16;
/** 选项 label 的显示上限；超长在运行时截断（不报错）。 */
export const MAX_LABEL_LENGTH = 60;

/** 每题自动追加的自由输入行。模型不许自己写这个 label（reserved_label 拒绝）。 */
export const CUSTOM_ANSWER_LABEL = "Type something.";

/**
 * 保留 label："Other" 是因为模型被 Claude Code 条件化、总想自己写一个 Other 选项，
 * 而这里哨兵行是唯一来源；CUSTOM_ANSWER_LABEL 是哨兵行本身。
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
 * 单题答案意图（判别联合，`kind` 是唯一判别子）：
 * - `option`：单选，选中模型给的选项；`answer` = 选项 label
 * - `custom`：用户在 "Type something." 行自由输入；`answer` = 输入文本
 * - `multi`：多选提交；`selected` = 选中的 label 列表，`answer` 恒为 null
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
 * 失败码。`no_ui` / `no_dialog_ui` 依赖宿主能力、在执行路径上判定；
 * 其余由 validateQuestionnaire 产出。
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
