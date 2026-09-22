/**
 * plan-mode 的显示层文案：状态行与步骤 widget。
 *
 * 不 import pi / pi-tui —— 颜色由主题的 `fg(slot, text)` 注入，宽度函数也注入，所以
 * `node --test` 能直接断言每条文案与每一行的可见宽度。
 *
 * ## 为什么复用一个 `setStatus` key
 *
 * 本机 statusline 扩展把其它扩展 `ctx.ui.setStatus()` 的文本拼成第二行（`formatExtensionStatuses`，
 * 最多 5 条、` | ` 分隔），所以这里的键数越少越好。三态共用 `plan-mode` 一个键：
 * plan / execute 各给一份文案，normal 直接 `undefined` 清掉，第二行不会留下空档。
 *
 * ## 配色
 *
 * 状态行走 `warning`（与「等你拍板」的语义一致），执行进度走 `accent`，步骤文本走
 * `muted` —— 都取自三套主题都有的语义槽，不写死色值。
 */

import type { PlanPhase, PlanStep } from "./plan.ts";

export const STATUS_KEY = "plan-mode";
export const STEPS_WIDGET_KEY = "plan-steps";

/** 步骤 widget 最多显示几行：本机 pi 的 widget 上限是 10 行，留出余量给其它 widget。 */
export const MAX_WIDGET_STEPS = 8;

/** widget 每行最大列数：超出就在底部追加一行摘要，不要让它挤掉终端里的其它内容。 */
export const MAX_WIDGET_WIDTH = 100;

/**
 * `truncate` 为行首标记预留的列数：`☑ ` / `☐ ` 实际占 2 列，另外 2 列是余量 ——
 * 于是整行最多 `MAX_WIDGET_WIDTH - 2` 列，永远碰不到终端右边缘。
 */
const PREFIX_RESERVE = 4;

export interface PlanTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
}

export interface PlanStatusSource {
	phase: PlanPhase;
	steps: readonly PlanStep[];
	pending?: readonly PlanStep[];
}

/**
 * statusline 第二行的那段文本。**三个态都有文案** —— normal 也要显示，
 * 让「当前处于哪个模式」永远有个固定的显示位（这一格原先归 simple-task 的
 * `✔ n/N`，它与输入框上方的 widget 重复，已让给模式指示）。
 *
 *   ⏵ normal                  普通模式（全权限）
 *   ⏸ plan                    等待模型提交计划
 *   ⏸ plan · 4 steps          已提交、等用户批准
 *   ▶ 2/5 executing           执行中
 */
export function formatPlanStatus(theme: PlanTheme, source: PlanStatusSource): string {
	if (source.phase === "plan") {
		const label = theme.fg("warning", "⏸");
		const pending = source.pending ?? [];
		if (pending.length === 0) return `${label} ${theme.fg("warning", "plan")}`;
		return `${label} ${theme.fg("warning", "plan")} ${theme.fg("muted", `· ${pending.length} step${pending.length === 1 ? "" : "s"}`)}`;
	}
	if (source.phase === "execute") {
		const total = source.steps.length;
		if (total === 0) return `${theme.fg("accent", "▶")} ${theme.fg("accent", "execute")}`;
		const done = source.steps.filter((step) => step.done).length;
		const arrow = theme.fg("accent", "▶");
		return `${arrow} ${theme.fg("accent", `${done}/${total}`)} ${theme.fg("muted", "executing")}`;
	}
	// normal：用 `toolDiffRemoved`（删除行前景色）而不是 `dim` —— 那个槽在三套皮肤里
	// 都解析成红色（ayu #D95757 / catppuccin #F38BA8 / summer-night #e27878），
	// 让「全权限」这个态一眼可见：未开启保护，而不是「什么都没开」。
	// 注意 **plan / execute 的配色不变**（warning / accent），那两态才是要读仔细的。
	return `${theme.fg("toolDiffRemoved", "⏵")} ${theme.fg("toolDiffRemoved", "normal")}`;
}

/**
 * 步骤 widget 的每一行（`ctx.ui.setWidget` 收 string[]）。没有步骤时返回 `undefined`，
 * 让调用方清掉 widget。
 *
 * 渲染长度按**可见宽度**预算（CJK 按 2 列），超出的行按宽度截断；步骤多于
 * `MAX_WIDGET_STEPS` 时只显示前 N 条 + 一行 `… 还有 M 步`，避免 widget 涨成半屏。
 */
export function formatStepLines(
	theme: PlanTheme,
	source: PlanStatusSource,
	widthOf: (text: string) => number,
): string[] | undefined {
	const steps = source.phase === "execute" ? source.steps : source.pending ?? [];
	if (steps.length === 0) return undefined;

	const shown = steps.slice(0, MAX_WIDGET_STEPS);
	const lines = shown.map((step) => {
		if (step.done) {
			const check = theme.fg("success", "☑");
			return `${check} ${theme.fg("muted", theme.strikethrough(truncate(step.text, widthOf, PREFIX_RESERVE)))}`;
		}
		const current = step.step === currentStep(source);
		const box = theme.fg(current ? "accent" : "muted", "☐");
		const text = theme.fg(current ? "text" : "muted", truncate(step.text, widthOf, PREFIX_RESERVE));
		return `${box} ${text}`;
	});

	const hidden = steps.length - shown.length;
	if (hidden > 0) lines.push(theme.fg("dim", truncate(`… 还有 ${hidden} 步`, widthOf, 0)));

	return lines;
}

/** execute 阶段的当前步骤：第一条未完成的。 */
function currentStep(source: PlanStatusSource): number | undefined {
	if (source.phase !== "execute") return undefined;
	return source.steps.find((step) => !step.done)?.step;
}

/** 按可见宽度截断，行首标记预留 `reserve` 列。 */
function truncate(text: string, widthOf: (text: string) => number, reserve: number): string {
	const budget = MAX_WIDGET_WIDTH - reserve;
	if (budget <= 0) return "";
	if (widthOf(text) <= budget) return text;
	let result = "";
	let width = 0;
	for (const char of text) {
		const charWidth = widthOf(char);
		if (width + charWidth > budget - 1) break;
		result += char;
		width += charWidth;
	}
	return `${result}…`;
}
