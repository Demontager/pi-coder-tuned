/**
 * pi-destructive-guard — 在工具调用**执行前**拦住危险的删除。
 *
 * 背景：2026-09-23，一次验证脚本里的
 *
 *     fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true })
 *
 * 因为 `s.log[0].x` 不存在、`?? "/tmp"` 兜底、`dirname("/tmp")` 得到 `"/"`，以本机
 * 用户权限删了 2.5 分钟。root 拥有的树靠权限活了下来，`bachi` 可写的部分（`/usr/local`
 * 大半、`/Library` 部分、`~/Music`、`~/.vim` …）没了，且**任何地方都没有第二份**。
 *
 * AGENTS.md 里的 `## Destructive actions` 事故前两小时就写好了，没拦住 —— 因为那份
 * 纪律约束的是“我”，而事故发生在“我写的脚本在运行时做了什么”。这个扩展补的就是那一段：
 * 它挂在 `tool_call` 上，在**执行前**看参数，是确定性代码判定，不依赖模型自觉。
 *
 * ## 两道闸
 *
 * 1. **bash / powershell**：抽出删除目标，套 AGENTS.md 那套断言（少于两段路径 / 受保护
 *    根 / 受保护根的祖先 / 系统树 / VCS 存储根 / 兜底值与路径运算）。
 * 2. **write / edit**：检查**要写进去的内容**里有没有上面的删除形态。事故的危险代码是
 *    更早写进文件的，“运行脚本”那一步看起来完全无害 —— Claude Code 的分类器有对应规则
 *    （`WRITTEN FILE EXECUTION`：写本身就是一次动作，按执行时判），这道闸是同一个意思。
 *
 * ## 行为
 *
 * `block` 直接拒绝（工具错误结果回给模型）；`confirm` 在 TUI 里弹一次选择，非交互环境
 * 一律拒绝（fail closed，同 Claude Code 分类器的 `automode-unavailable` 语义）。
 *
 * 环境变量：
 *   `PI_DESTRUCTIVE_GUARD=off`     整个关掉
 *   `PI_DESTRUCTIVE_GUARD=block`   连 confirm 也直接拒（更严）
 *   `PI_DESTRUCTIVE_GUARD=notify`  只通知，不拦（先观察一段时间，收集误报）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";

import { inspectBash, type Finding } from "./targets.ts";
import { inspectWrittenContent, type WriteFinding } from "./writes.ts";

/** 运行模式。 */
type Mode = "on" | "off" | "block" | "notify";

/** 每次会话的统计，`/destructive-guard` 用。 */
interface Stats {
	checked: number;
	blocked: number;
	confirmed: number;
	allowed: number;
	notified: number;
}

/** 写类工具的参数名 → 内容字段。`edit` 用的是 old/new 两段。 */
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch"]);

function readMode(): Mode {
	const raw = (process.env.PI_DESTRUCTIVE_GUARD ?? "").trim().toLowerCase();
	if (raw === "off" || raw === "0" || raw === "false") return "off";
	if (raw === "block" || raw === "strict") return "block";
	if (raw === "notify" || raw === "dry-run") return "notify";
	return "on";
}

/** 从工具参数里取出所有要写入的文本。 */
export function contentFields(input: unknown): string[] {
	if (typeof input !== "object" || input === null) return [];
	const record = input as Record<string, unknown>;
	const out: string[] = [];
	for (const key of ["content", "newText", "new_string", "text", "patch"]) {
		const value = record[key];
		if (typeof value === "string" && value !== "") out.push(value);
	}
	return out;
}

/** 把命中渲染成给模型看的一段理由。 */
export function renderFindings(findings: readonly Finding[]): string {
	const lines = findings.map(
		(finding) =>
			`  · ${finding.target}${finding.resolved && finding.resolved !== finding.target ? `  →  ${finding.resolved}` : ""}\n` +
			`    [${finding.rule}] ${finding.reason}`,
	);
	return lines.join("\n");
}

/** 把写入侧的命中渲染成理由。 */
export function renderWriteFindings(findings: readonly WriteFinding[]): string {
	return findings
		.map((finding) => `  第 ${finding.line} 行 [${finding.rule}] ${finding.reason}\n    ${finding.text}`)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	let mode = readMode();
	const stats: Stats = { checked: 0, blocked: 0, confirmed: 0, allowed: 0, notified: 0 };

	pi.registerCommand("destructive-guard", {
		description: "Show destructive-guard status and what it has caught this session",
		handler: async (_args, ctx) => {
			const lines = [
				`模式：${mode}${mode === "notify" ? "（只通知，不拦）" : ""}${mode === "block" ? "（confirm 也直接拒）" : ""}`,
				`本会话检查过 ${stats.checked} 次删除动作`,
				`拒绝 ${stats.blocked} · 确认后放行 ${stats.confirmed} · 放行 ${stats.allowed} · 仅通知 ${stats.notified}`,
				"",
				"环境变量：PI_DESTRUCTIVE_GUARD = off | on | block | notify",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", async () => {
		mode = readMode();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (mode === "off") return undefined;

		const cwd = process.cwd();
		const home = homedir();

		// ---- 闸一：删除类命令 ----
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = typeof event.input?.command === "string" ? event.input.command : "";
			if (command === "") return undefined;

			const findings = inspectBash(command, cwd, home);
			if (findings.length === 0) {
				stats.checked += 1;
				stats.allowed += 1;
				return undefined;
			}

			stats.checked += 1;
			const hardest = findings.some((finding) => finding.verdict === "block") ? "block" : "confirm";

			if (mode === "notify") {
				stats.notified += 1;
				if (ctx.hasUI) ctx.ui.notify(`destructive-guard 本会拦下：\n${renderFindings(findings)}`, "warning");
				return undefined;
			}

			if (hardest === "block" || mode === "block") {
				stats.blocked += 1;
				return {
					block: true,
					reason:
						`destructive-guard 拦下了这条删除：\n${renderFindings(findings)}\n\n` +
						`如果确实要删，请说明目标与理由，并改用能逐级确认的形式（先列出内容再删，或用可恢复的移动/改名）。`,
				};
			}

			// confirm：TUI 里问一次；非交互环境 fail closed。
			if (!ctx.hasUI) {
				stats.blocked += 1;
				return {
					block: true,
					reason:
						`destructive-guard 拦下了这条删除（当前环境无法向你确认，按 fail-closed 拒绝）：\n` +
						`${renderFindings(findings)}`,
				};
			}

			const choice = await ctx.ui.select(
				`⚠️ 这条命令要删除的内容需要确认：\n\n${command}\n\n${renderFindings(findings)}`,
				["取消", "确认删除"],
			);
			if (choice !== "确认删除") {
				stats.blocked += 1;
				return { block: true, reason: "destructive-guard：用户取消了这条删除。" };
			}
			stats.confirmed += 1;
			return undefined;
		}

		// ---- 闸二：写入内容里的删除代码 ----
		if (!WRITE_TOOLS.has(event.toolName)) return undefined;

		const blocks = contentFields(event.input);
		if (blocks.length === 0) return undefined;

		const findings = blocks.flatMap((block) => inspectWrittenContent(block));
		if (findings.length === 0) return undefined;

		stats.checked += 1;

		if (mode === "notify") {
			stats.notified += 1;
			if (ctx.hasUI) ctx.ui.notify(`destructive-guard 本会拦下这段写入：\n${renderWriteFindings(findings)}`, "warning");
			return undefined;
		}

		if (mode === "block" || !ctx.hasUI) {
			stats.blocked += 1;
			const why = [
				"destructive-guard \u62e6\u4e0b\u4e86\u5199\u5165\uff1a\u8fd9\u6bb5\u4ee3\u7801\u91cc\u7684\u5220\u9664\u8c03\u7528\u6709\u5371\u9669\u5f62\u6001\u3002",
				renderWriteFindings(findings),
				"",
				"\u8fd9\u4e0d\u662f\u201c\u4e0d\u8bb8\u5220\u6587\u4ef6\u201d\uff0c\u800c\u662f\u8fd9\u51e0\u4e2a\u5199\u6cd5\u672c\u8eab\u5c31\u4f1a\u7b97\u9519\u76ee\u6807\uff08" +
					"2026-09-23 \u7684\u4e00\u6b21\u4e8b\u6545\u6b63\u662f fs.rmSync(path.dirname(x ?? \"/tmp\")) " +
					"\u9000\u5316\u6210 rm -rf /\uff09\u3002",
				"\u8bf7\u6539\u6210\uff1a\u5b57\u9762\u76ee\u6807 + \u5220\u9664\u524d\u6838\u5bf9\u89e3\u6790\u540e\u7684\u7edd\u5bf9\u8def\u5f84 + \u547d\u4e2d\u4fdd\u62a4\u8868\u5c31\u4e2d\u6b62\u3002",
			].join("\n");
			return { block: true, reason: why };
		}

		const choice = await ctx.ui.select(
			`⚠️ 这段写入里的删除调用需要确认：\n\n${renderWriteFindings(findings)}`,
			["取消", "确认写入"],
		);
		if (choice !== "确认写入") {
			stats.blocked += 1;
			return { block: true, reason: `destructive-guard：用户取消了这段写入。` };
		}
		stats.confirmed += 1;
		return undefined;
	});
}
