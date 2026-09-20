/**
 * summary-request.ts — 「提示词太长时请模型压成一句话」的纯逻辑：触发决策、请求提示词、回复清洗。
 *
 * 背景见 `working-summary.ts` 头注释：spinner 行尾那一格只能放几十列，长提示词按可见宽度
 * 截断后只剩开头几个字（「帮我看看…」），信息量几乎为零。所以 `working-indicator.ts` 在
 * `input` 事件里除了压平/缓存提示词，还会**异步**发一次模型请求，让它用一句话说清这段
 * 提示词要干什么。请求和主回合并行，互不阻塞；回来了就换上摘要，没回来/失败就一直显示
 * 截断后的原文 —— 摘要永远是增强。
 *
 * ## 触发条件（`planSummaryRequest`）
 *
 * 只要原文放不下就值得花一次请求。两档（默认倍数 1）：
 *
 *   原文宽度 ≤ 可用宽度   → 整段放得下，`layoutPromptSummary` 全量展示，不请求
 *   原文宽度 > 可用宽度   → 请求摘要（哪怕只超一列 —— 截断丢的是尾巴，而尾巴往往
 *                          正是「要改什么/改成什么样」，压成一句话比截断信息量大）
 *
 * 倍数是 `triggerRatio`（`PI_WORKING_SUMMARY_TRIGGER`，默认 1）：1 = 只要放不下就压；
 * 调到 1.2 / 2 是留给「不想每条放不下的提示词都花一次带 thinking 的请求」这类偏好 ——
 * 1.2 ≈ 截断丢掉近两成原文才压，2 = 丢掉一半以上才压。宽度一律是**可见列数**
 * （调用方用 pi-tui 的 `visibleWidth` 量好传进来），不是字符数 —— 一个汉字占 2 列，
 * 用字符数判断会把中文提示词全判成「还好」。
 *
 * ## 目标长度（`targetWidth`）
 *
 * 可用宽度（`availableSummaryTextWidth`，与渲染共用同一份数学）乘 `TARGET_WIDTH_RATIO`
 * 得到要求模型输出的列数，并告诉它口径（汉字 2 列 / ASCII 1 列）。留出那一成余量是给
 * 「模型数不准」的：宁可短一点、整句完整显示，也不要卡在边界上被切掉半句。可用宽度太窄
 * （`MIN_REQUEST_BUDGET` 列以下）时干脆不请求 —— 一句话压到十列以内已经没有信息量，
 * 截断原文和它一样难读。
 *
 * **超长不追问（调用方保证，不是这里的逻辑）**：模型回来的摘要超长也**不重试**，由
 * `layoutPromptSummary` 按可见宽度截断补 `…`。再要一次只会让这一格的内容来回跳，而且第二次
 * 大概率还是长 —— 需求原文即「不要再第二次请求了，正常做截断处理就好」。（失败后的重试是
 * 另一回事，由 `index.ts` 负责：那是「没拿到结果」，不是「结果太长」。）
 *
 * ## 清洗（`cleanSummaryText`）
 *
 * 模型输出是不可信文本：可能多给几行、加个「摘要：」标签、整体包一层引号或 `**`，也可能
 * 跑飞写成几百字。清洗只做展示层面的最小加工：
 *
 *   - **只取第一行有效内容**。模型偶尔先写一句「摘要：」再换行写正文，所以逐行清洗、跳过
 *     清洗后为空的行（标签行、代码围栏标记行），取第一行非空的结果。刻意不是整段拼接 ——
 *     模型多给一段解释时，拼接会把解说词也顶进那一格里。
 *   - 逐行过 `flattenPrompt`（复用压平那套：剥 ANSI / 零宽字符、折叠空白、剥列表符号与
 *     标题标记），所以模型加 `- ` 前缀或引号都不会带进显示。
 *   - 去掉整体包裹的引号（ASCII 与中文成对符号）与 `**粗体**` 包裹，去掉「摘要：」这类
 *     标签前缀。最多迭代三轮，`**"摘要：xx"**` 这种叠着的装饰也能剥干净。
 *   - 字符数硬上限 `MAX_SUMMARY_TEXT_CHARS`（按码点切，不切半个代理对）。显示层还会按
 *     可见宽度截一次，这里只是防「模型返回十万字」把内存和宽度计算拖着走。
 *
 * 本文件不 import pi / pi-tui（宽度是调用方量好的列数），所以 `node --test` 直跑
 * （用例见 `summary-request.test.ts`）。
 */

import { flattenPrompt } from "./working-summary.ts";

/**
 * 触发倍数：原文宽度超过可用宽度的这个倍数才请求摘要。默认 1 = 只要放不下（哪怕只多一列）
 * 就请求 —— 口径是「超过可显示区域就要摘要」，没有「略微超出先用截断凑合」这一档。
 * 调大是留给「不想每条放不下的提示词都花一次带 thinking 的请求」的偏好：1.2 ≈ 截断丢掉
 * 近两成原文才压，2 = 丢掉一半以上才压。
 */
export const DEFAULT_TRIGGER_RATIO = 1;

/** 目标宽度占可用宽度的比例：留一成余量，模型略微超一点也不会被截掉半句。 */
export const TARGET_WIDTH_RATIO = 0.9;

/** 可用宽度低于这个列数就不值得请求：一句话压到十列以内没有信息量，跟截断原文一样难读。 */
export const MIN_REQUEST_BUDGET = 10;

/**
 * 喂给模型的提示词上限（字符）。压平后的原文最长 `MAX_PROMPT_SCAN_CHARS`（4000），
 * 再截一道：模型只需要开头那段的语义，后面的细节对「一句话说清干什么」没有增量，
 * 而请求体越大越慢。
 */
export const MAX_REQUEST_INPUT_CHARS = 2000;

/** 清洗后摘要的字符数上限（按码点计）。显示层另有可见宽度截断，这里只防模型跑飞。 */
export const MAX_SUMMARY_TEXT_CHARS = 200;

export interface SummaryRequestPlan {
	/** 值不值得为这段提示词发一次模型请求。 */
	needed: boolean;
	/** 要求模型输出的目标宽度（可见列数）；`needed` 为 false 时无意义。 */
	targetWidth: number;
}

export interface SummaryRequestPlanOptions {
	/** 压平后的提示词宽度（可见列数，调用方用 `visibleWidth` 量）。 */
	promptWidth: number;
	/** 摘要正文的可用宽度（可见列数，来自 `availableSummaryTextWidth`）。 */
	budgetWidth: number;
	/** 触发倍数，默认 `DEFAULT_TRIGGER_RATIO`。 */
	triggerRatio?: number;
	/** 可用宽度下限，默认 `MIN_REQUEST_BUDGET`。 */
	minBudget?: number;
}

/**
 * 决定「要不要请求」与「要求模型写多长」。纯函数：传进来的都是量好的列数，不做任何测量。
 * 条件用严格大于（`promptWidth > budget * ratio`）：正好等于阈值时不请求，与「放得下就不
 * 请求」的边界保持同一套开闭方向。
 */
export function planSummaryRequest(opts: SummaryRequestPlanOptions): SummaryRequestPlan {
	const budget = Math.floor(opts.budgetWidth);
	const minBudget = opts.minBudget ?? MIN_REQUEST_BUDGET;
	const triggerRatio = opts.triggerRatio ?? DEFAULT_TRIGGER_RATIO;
	// 目标宽度只是「可用宽度的一成余量版」：`budget < minBudget` 的窄格子已经被下面挡掉，
	// 所以不需要再单独设一个目标下限（两个阈值只会有一个真正生效）。
	const targetWidth = Math.max(1, Math.floor(budget * TARGET_WIDTH_RATIO));
	if (budget < minBudget) return { needed: false, targetWidth };
	return { needed: opts.promptWidth > budget * triggerRatio, targetWidth };
}

/** 按码点截断（不切半个代理对）：超长时末尾补 `…` 表示「被截了」。 */
function clipToPoints(text: string, maxPoints: number): string {
	const points = [...text];
	if (points.length <= maxPoints) return text;
	return `${points.slice(0, maxPoints).join("")}…`;
}

/**
 * 组装请求提示词（单条 user 消息的文本）。要求模型：
 *   1. 一行、无换行、无引号、无 markdown、无「摘要：」标签、无解释；
 *   2. 不超过 `targetWidth` 个显示列（并给出汉字 2 列 / ASCII 1 列的口径）、宁短勿长；
 *   3. 保留「做什么 + 对象」，丢掉寒暄 / 背景 / 示例 / 重复；
 *   4. 用与原文相同的语言。
 *
 * 第 4 条不指定中文：提示词是英文时给出中文摘要反而别扭，让模型跟随原文更自然。
 */
export function buildSummaryRequestPrompt(prompt: string, targetWidth: number): string {
	const input = clipToPoints(prompt, MAX_REQUEST_INPUT_CHARS);
	return [
		"You label user prompts in a terminal status bar: say in one short line what the user is asking for.",
		"",
		"Rules:",
		`- Output a single line, at most about ${targetWidth} display columns wide. A CJK/full-width character counts as 2 columns, an ASCII character as 1. Stay clearly under the limit rather than at it.`,
		'- No line breaks, no quotes, no markdown, no label like "Summary:", no explanation — only that line.',
		"- Keep the action and its main object. Drop greetings, background, examples and repeated detail.",
		"- Write in the same language as the input.",
		"",
		"Input:",
		input,
	].join("\n");
}

/** 「摘要」这类标签词本身。 */
const LABEL_TEXT = "(?:summary|prompt summary|recap|title|label|摘要|总结|概括|简述|一句话摘要)";

/**
 * 标签前缀：`摘要：` / `Summary:`，并容忍两种粗体包裹（`**摘要：**` 与 `**摘要**：`）——
 * 分隔符后面那截粗体收尾也一并吃掉，否则会剩下一串 `**` 混进摘要正文。
 */
const LABEL_PREFIX_RE = new RegExp(
	`^(?:\\*\\*|__)?${LABEL_TEXT}(?:\\*\\*|__)?\\s*[:：]\\s*(?:\\*\\*|__)?\\s*`,
	"i",
);

/** 整行只有标签本身（`摘要` / `**Summary**`）：不是摘要内容，该行跳过。 */
const LABEL_ONLY_RE = new RegExp(`^(?:\\*\\*|__)?${LABEL_TEXT}(?:\\*\\*|__)?\\s*[:：]?$`, "i");

/** 成对包裹的引号 / 书名号（ASCII 直引号与中文成对符号）。 */
const WRAPPING_QUOTES: ReadonlyArray<readonly [string, string]> = [
	["\"", "\""],
	["'", "'"],
	["“", "”"],
	["‘", "’"],
	["「", "」"],
	["『", "』"],
	["《", "》"],
	["`", "`"],
];

/** 剥一层装饰：标签前缀 → 整体包裹的引号 → 整体包裹的 `**`/`__`。 */
function stripDecoration(text: string): string {
	let out = text.replace(LABEL_PREFIX_RE, "").trim();
	for (const [open, close] of WRAPPING_QUOTES) {
		if (out.length > open.length + close.length && out.startsWith(open) && out.endsWith(close)) {
			const inner = out.slice(open.length, out.length - close.length).trim();
			if (inner !== "") {
				out = inner;
				break;
			}
		}
	}
	return out.replace(/^(\*\*|__)(.+)\1$/, "$2").trim();
}

/**
 * 清洗模型回复（规则见文件头）。返回空串表示这次请求没有可用结果 —— 调用方按「不显示摘要」
 * 处理（继续显示截断后的原文），不重试、不报错。
 */
export function cleanSummaryText(raw: string): string {
	// 逐行取第一个「清洗后非空」的行：标签行（「摘要：」）、代码围栏标记行会被清洗成空串，
	// 于是自然落到下一行；模型把正文分成了多行时只取第一行，后面的解说词不进来。
	for (const line of raw.split(/\r\n|[\n\r\u0085\u000b\u000c\u2028\u2029]/)) {
		let text = flattenPrompt(line);
		if (text === "") continue;
		// 装饰可能叠着（`**"摘要：xx"**`）：迭代到不再变化为止，上限四轮兜底。
		for (let round = 0; round < 4; round++) {
			const next = stripDecoration(text);
			if (next === text) break;
			text = next;
		}
		if (text === "" || LABEL_ONLY_RE.test(text)) continue;
		return clipToPoints(text, MAX_SUMMARY_TEXT_CHARS);
	}
	return "";
}
