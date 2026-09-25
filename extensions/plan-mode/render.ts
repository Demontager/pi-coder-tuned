/**
 * plan-mode 的显示层文案：状态行。
 *
 * 不 import pi / pi-tui —— 颜色由主题的 `fg(slot, text)` 注入，所以 `node --test`
 * 能直接断言每条文案。
 *
 * ## 为什么复用一个 `setStatus` key
 *
 * 本机 statusline 扩展把其它扩展 `ctx.ui.setStatus()` 的文本拼成第二行（`formatExtensionStatuses`，
 * 最多 5 条、` | ` 分隔），所以这里的键数越少越好。两个态共用 `plan-mode` 一个键：
 * plan 给一份文案，bypass 直接 `undefined` 清掉，第二行不会留下空档。
 *
 * 2026-09-24 删掉 execute 态之后**没有步骤 widget 了** —— 计划是一份 markdown，没有
 * 可逐条打勾的步骤；进度归模型自己（它要建任务清单就自己 `task_set`，那是 simple-task
 * 的 widget 该显示的事）。
 *
 * ## 配色
 *
 * 状态行走 `warning`（与「等你拍板」的语义一致），写文档子态走 `accent`，
 * 都取自三套主题都有的语义槽，不写死色值。
 */

import type { PlanPhase } from "./plan.ts";

export const STATUS_KEY = "plan-mode";

export interface PlanTheme {
	fg(color: string, text: string): string;
}

export interface PlanStatusSource {
	phase: PlanPhase;
	/** plan 态：模型已提交、等用户审批。 */
	pending?: string;
	/** plan 态：写文档子态。 */
	docWriting?: boolean;
}

/**
 * statusline 第二行的那段文本。**两个态都有文案** —— bypass 也要显示，
 * 让「当前处于哪个模式」永远有个固定的显示位（这一格原先归 simple-task 的
 * `✔ n/N`，它与输入框上方的 widget 重复，已让给模式指示）。
 *
 *   ⏵ bypass                  普通模式（全权限）
 *   ⏸ plan                    等待模型提交计划
 *   ⏸ plan · 待批准            已提交、等用户审批
 *   ⏸ plan · 写文档中          写文档子态（模型正在把计划落成文件）
 */
export function formatPlanStatus(theme: PlanTheme, source: PlanStatusSource): string {
	if (source.phase === "plan") {
		const label = theme.fg("warning", "⏸");
		if (source.docWriting) {
			return `${label} ${theme.fg("warning", "plan")} ${theme.fg("accent", "· writing document")}`;
		}
		if (source.pending) return `${label} ${theme.fg("warning", "plan")} ${theme.fg("muted", "· awaiting approval")}`;
		return `${label} ${theme.fg("warning", "plan")}`;
	}
	// bypass：用 `toolDiffRemoved`（删除行前景色）而不是 `dim` —— 那个槽在三套皮肤里
	// 都解析成红色（ayu #D95757 / catppuccin #F38BA8 / summer-night #e27878），
	// 让「全权限」这个态一眼可见：未开启保护，而不是「什么都没开」。
	// 注意 **plan 的配色不变**（warning），那一态才是要读仔细的。
	return `${theme.fg("toolDiffRemoved", "⏵")} ${theme.fg("toolDiffRemoved", "bypass")}`;
}
