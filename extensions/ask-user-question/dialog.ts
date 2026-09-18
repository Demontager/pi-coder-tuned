/**
 * dialog.ts — 非 TUI 宿主（RPC / ACP，如 VS Code pendant、Zed）的顺序对话框回退。
 *
 * `ctx.ui.custom()` 在这些宿主上渲染不出来，但 select / input 对话框子协议
 * （extension_ui_request/response）是好用的，所以逐题走原生对话框，产出与 TUI
 * 完全相同的 AskResult，喂给同一个 buildResponse 封装。纯函数（鸭子类型的
 * DialogUI），不 import pi —— 单测用假 ui 覆盖。
 *
 * 与 TUI 的取舍：没有 tab 式多题总览（一题一个对话框）；多选退化成
 * "输入编号，逗号分隔" 的文本输入；任何非编号输入都当自由回答原样保留
 * （这也是多选的 "Type something." 逃生口）。任一对话框被关掉（resolve
 * undefined）= 整份问卷取消，与 TUI 里按 Esc 同义。
 */

import { CUSTOM_ANSWER_LABEL, type AskAnswer, type AskParams, type AskQuestion, type AskResult } from "./types.ts";

/** ExtensionUIContext 上本模块需要的切片。结构化类型 + hasDialogUI 运行时闸门。 */
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

/** 把 "2. Label — desc" 或 "2" 这样的选择串解析成 0 基下标；越界 / 非数字 → null。 */
export function parseIndex(token: string, count: number): number | null {
	const i = Number.parseInt(token, 10) - 1;
	return Number.isFinite(i) && i >= 0 && i < count ? i : null;
}

/** 逐题走原生对话框。undefined（关掉对话框）= 取消整份问卷，保留已答部分。 */
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
	// 宿主返回了清单外的东西与关掉对话框无法区分，一律当取消，不编造答案。
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
		// 空提交 = 一个都不选，与 TUI 里不勾任何项直接 Enter 同义。
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
	// 出现任何非编号 token（文字、或 "13" 这种越界编号）= 用户在打字回答，
	// 原样保留为 custom，不静默丢弃。
	return { questionIndex, question: q.question, kind: "custom", answer: trimmed };
}
