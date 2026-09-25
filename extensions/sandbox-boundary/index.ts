/**
 * Sandbox Boundary —— 给**不走 shell 的文件工具**补上 bash 沙箱管不到的那部分：删除。
 *
 * ## 为什么需要它
 *
 * bash 命令已经被 seatbelt 沙箱包住了（见 `bash-command-collapse/sandbox.ts`），但 pi 的
 * `write` / `edit` 工具**不走 shell** —— 它们是扩展进程里的直接 `fs` 调用，沙箱管不到。
 * 沙箱那边收回的能力只有一项（边界外的 `file-write-unlink`），所以这里也只需要补同一项：
 * **删除**边界外的文件才问，写入不问。
 *
 * ## 口径（用户 2026-09-24 定）
 *
 * > 写入目标在可写边界之外，不需要弹框提醒；只有删除的文件在沙箱之外才提醒。
 *
 * 于是：
 *
 * - `write` / `edit` / `multiedit` —— 一律放行，不看边界。它们只会创建或覆盖内容，
 *   不会让任何 inode 消失；覆盖前的旧内容属于「可逆性」范畴，由 git 与 AGENTS.md
 *   的 `## Destructive actions` 纪律负责，不是这道闸的职责。
 * - `apply_patch` —— 只检查 `*** Delete File: <path>` 行里的路径。`Update File` /
 *   `Add File` 是写入，放行。
 *
 * ## 三档授权（与 bash 沙箱同一套，用户 2026-09-24 定，同日新增「永不删除」档）
 *
 * 边界外的删除按目标路径分三档，判定核心是 `sandbox.ts` 的 `classifyOutsidePaths`，
 * 记忆落在 `allowlist.ts` 的同一个 globalThis 单例上 —— 所以 bash 侧记住的目录，
 * 这里立刻生效，反之亦然，两边口径不会漂移：
 *
 * - **永不删除**（身份 / 凭据 / 手写配置：`~/.zshrc`、`~/.ssh`、`~/.gnupg`…）：
 *   **不弹框、无任何放行选项**，直接 fail-closed。白名单 / 会话豁免 /
 *   `PI_SANDBOX_EXTRA_WRITE` 都压不过。整份 patch 一起拒。
 *   用户 2026-09-25 把 `~/.config`、`~/.pi`、`~/.claude`、`~/.codex` 移出本档 ——
 *   它们是工具状态目录（含 lock / 缓存 / 会话日志），走下面的普通档。
 * - **危险路径**（系统根 / bin / 应用安装目录 / `~/Library` / 含 `.git`）：每次都问，
 *   只支持会话级豁免（`Allow for this session`），重启 pi 后恢复。
 * - **普通路径**：问一次，`Allow for this session（并记住该目录）` 后把目录范围写进持久白名单，
 *   以后（含 headless）不再问。
 *
 * 与 bash 侧的一个区别：`apply_patch` 是 `tool_call` 钩子，**执行前**就能拦，且它知道
 * 全部目标路径（不像 bash 要先失败再从 stderr 里抽）。所以这里没有「命令重跑一次」的代价，
 * `Allow once` 就是单纯放行这一次、不记忆。
 *
 * ## 体验
 *
 * 写入**一次都不弹窗**，边界内（含可再生缓存 `~/.cache`、`~/Library/Caches` 等）的删除
 * 也不弹 —— 这是绝大多数操作。只有删边界外的文件才问。
 * 命中持久白名单时静默放行，但补一行 `notify`（否则会疑惑「怎么不问了」）。
 * 非交互环境（`pi -p`、subagent）：持久白名单**生效**（授权本来就是交互时给的），
 * 危险目录与未授权的普通目录 fail-closed 直接拒 —— 没有人在屏幕前，"默认同意"等于没有边界。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	boundaryFromEnv,
	classifyOutsidePaths,
	isSandboxEnabled,
	memoryScopeFor,
	memoryScopesFor,
	neverDeleteReasonFor,
	sessionScopeFor,
	writableRoots,
	type PathEnv,
	type WriteBoundary,
} from "../bash-command-collapse/sandbox.ts";
import { getAllowlistStore, getSessionScopes } from "../bash-command-collapse/allowlist.ts";

/**
 * 可能携带删除意图的工具。
 *
 * `write` / `edit` / `multiedit` 刻意**不在**这个集合里 —— 它们只写不删（见文件头口径）。
 * `apply_patch` 的 `*** Delete File:` 是唯一一个「非 shell 工具也能删文件」的形状。
 */
const GUARDED_TOOLS = new Set(["apply_patch"]);

/**
 * 从工具入参里取出**要删除**的路径。
 *
 * `apply_patch` 的形状是 `patch` 文本，路径在 `*** Delete File: <path>` 行里。
 * `Update File` / `Add File` 是写入，按口径放行，所以这里不提取。
 * 认不出来就交给"无目标 → 放行"：bash 沙箱与 AGENTS.md 纪律仍在，
 * 不该为了一个形状猜错而拦住正常写入。
 */
function deleteTargetPaths(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const obj = input as Record<string, unknown>;
	const out: string[] = [];

	if (typeof obj.patch === "string" && obj.patch) {
		for (const line of obj.patch.split("\n")) {
			const m = /^\*\*\* Delete File: (.+)$/.exec(line.trim());
			if (m?.[1]) out.push(m[1].trim());
		}
	}

	// 少数实现把删除目标单独放在字段里，一并认。
	for (const key of ["deletePaths", "deletedPaths"]) {
		const value = obj[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string" && item) out.push(item);
			}
		}
	}

	return out;
}

export default function (pi: ExtensionAPI) {
	// 与 bash 沙箱共用同一个开关：PI_SANDBOX=off 时两边一起关，不会出现
	// "bash 有边界、apply_patch 没边界"这种半开状态。
	const enabled = isSandboxEnabled();
	const allowlistPath = process.env.PI_SANDBOX_ALLOWLIST?.trim() || join(getAgentDir(), "sandbox-allowlist.json");
	const sessionScopes = getSessionScopes();
	// 路径分类需要的 IO（realpath / isDirectory）由这里注入，sandbox.ts 保持纯逻辑。
	const pathEnv: PathEnv = {
		home: homedir(),
		realpath: (p) => {
			try {
				return realpathSync(p);
			} catch {
				return undefined;
			}
		},
		isDirectory: (p) => {
			try {
				return statSync(p).isDirectory();
			} catch {
				return false;
			}
		},
	};
	const allowlist = () => getAllowlistStore(allowlistPath, pathEnv);
	let stats = { checked: 0, remembered: 0, confirmed: 0, blocked: 0 };

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;

		const paths = deleteTargetPaths(event.input);
		// 认不出删除目标就放行：这不是"漏网"，而是这个工具形状没有删除动作可判。
		// 真正的兜底是 bash 沙箱（删除最终都要落到某个路径上）。
		if (paths.length === 0) return undefined;

		const boundary: WriteBoundary = boundaryFromEnv(ctx.cwd ?? process.cwd());
		stats.checked += paths.length;
		const classification = classifyOutsidePaths(paths, {
			boundary,
			allowedRoots: allowlist().roots(),
			sessionRoots: sessionScopes.roots(),
			env: pathEnv,
		});

		const pending = [...classification.dangerous.map((d) => d.path), ...classification.ordinary];

		// 永不删除档：不弹框、无任何放行选项，直接 fail-closed。
		// 整份 patch 一起拒（与「全部命中才放行」同一口径）—— 否则一份 patch 里
		// 混一个 `*** Delete File: ~/.ssh/id_rsa` 会被其余合法操作带着放行。
		if (classification.blocked.length > 0) {
			stats.blocked += classification.blocked.length;
			return {
				block: true,
				reason:
					`These identity, credential, or manually maintained configuration paths cannot be deleted regardless of authorization:
` +
					classification.blocked.map((d) => `  ${d.path}（${d.reason}）`).join("\n") +
					`
If deletion is necessary, perform it yourself in a terminal (or disable this layer with PI_SANDBOX=off).`,
			};
		}

		if (pending.length === 0) {
			// 全部命中边界内 / 持久白名单 / 会话豁免。命中白名单时补一行 notify，
			// 否则用户会疑惑「怎么不问了」。（边界内的删除不 notify —— 那是绝大多数操作。）
			if (classification.covered.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`Deletion targets already allowlisted; allowed: ${classification.covered.join("、")}`, "info");
			}
			return undefined;
		}

		const roots = writableRoots(boundary).join("、");

		// 非交互环境：持久白名单已在上面 classify 时生效（命中的进了 covered），
		// 能走到这里说明没命中 → fail-closed。
		if (!ctx.hasUI) {
			stats.blocked += pending.length;
			return {
				block: true,
				reason:
					`Deletion targets are outside the boundary and unauthorized; denied in non-interactive mode.
` +
					`Target: ${pending.join("、")}
Deletion boundary: ${roots}\n` +
					`Persistent allowlist: ${allowlist().roots().length} entries (pre-authorize with /sandbox-boundary allow <directory> in an interactive session)`,
			};
		}

		const foldPaths = (list: readonly string[], limit = 3): string => {
			const shown = list.slice(0, limit).map((p) => `  ${p}`);
			if (list.length > limit) shown.push(`  … plus ${list.length - limit} matches`);
			return shown.join("\n");
		};
		const hasDangerous = classification.dangerous.length > 0;
		const ordinaryScopes = memoryScopesFor(classification.ordinary, pathEnv, boundary.cwd);
		const dangerousScopes = classification.dangerous.map((d) => sessionScopeFor(d.path, pathEnv, boundary.cwd));

		let choice: string | undefined;
		if (hasDangerous) {
			const lines = [
				"⚠️ Deletion targets outside the boundary (high-risk directories)",
				"",
				"High-risk paths (confirmation on each deletion; session-only exemptions):",
				foldPaths(classification.dangerous.map((d) => `${d.path}（${d.reason}）`)),
			];
			if (classification.ordinary.length > 0) {
				lines.push("", "Also includes ordinary out-of-boundary paths (approve this time only; not remembered):", foldPaths(classification.ordinary));
			}
			lines.push("", `Deletion boundary: ${roots}`, "", "Choose Deny to leave everything untouched.");
			// pi 的 select 只有 (title, options)：正文必须拼进 title（destructive-guard 同一做法）。
			choice = await ctx.ui.select(lines.join("\n"), ["Deny", "Allow once", "Allow for this session"]);
		} else {
			const lines = [
				"⚠️ Deletion targets outside the boundary",
				"",
				"Delete targets: ",
				foldPaths(classification.ordinary),
				"",
				ordinaryScopes.length > 0
					? `Remember these paths: ${ordinaryScopes.join("、")} (future deletions within these directories will not prompt)`
					: "No safe persistent scope can be determined for these paths; approve each request individually.",
				"",
				`Deletion boundary: ${roots}`,
				"",
				"Choose Deny to leave everything untouched.",
			];
			choice = await ctx.ui.select(lines.join("\n"), [
				"Deny",
				"Allow for this session (and remember the directory)",
				"Allow once",
			]);
		}

		if (choice === undefined || choice === "Deny") {
			stats.blocked += pending.length;
			return {
				block: true,
				reason: `The user denied deletion outside the boundary: ${pending.join("、")} (deletion boundary: ${roots}）`,
			};
		}

		if (choice === "Allow for this session (and remember the directory)") {
			const remembered = allowlist().remember(ordinaryScopes, "confirm", pathEnv);
			stats.remembered += remembered.length;
			if (remembered.length > 0)
				ctx.ui.notify(
					`Permanently remembered ${remembered.length} directories (persists across restarts); future deletions within them will not prompt`,
					"info",
				);
		} else if (choice === "Allow for this session") {
			// 危险分支的会话级豁免：不落盘，重启 pi 即失效。
			sessionScopes.add(dangerousScopes);
		}
		// `Allow once`：什么都不记，直接放行这一次。

		stats.confirmed += pending.length;
		return undefined;
	});

	pi.registerCommand("sandbox-boundary", {
		description: "Show deletion boundary and allowlist; forget <path> removes an entry, clear empties it, allow <path> pre-authorizes",
		handler: (args, ctx) => {
			if (!enabled) {
				ctx.ui.notify("Boundary checks are disabled (PI_SANDBOX=off or non-macOS platform).", "info");
				return;
			}
			const boundary = boundaryFromEnv(ctx.cwd ?? process.cwd());
			const [sub, ...rest] = args.trim().split(/\s+/);
			const store = allowlist();

			if (sub === "forget") {
				const target = rest.join(" ");
				if (!target) {
					ctx.ui.notify("Usage: /sandbox-boundary forget <path>", "warning");
					return;
				}
				const removed = store.forget(target);
				ctx.ui.notify(removed ? `Removed allowlist entry: ${target}` : `No such allowlist entry: ${target}`, removed ? "info" : "warning");
				return;
			}
			if (sub === "clear") {
				const n = store.clear();
				ctx.ui.notify(n > 0 ? `Cleared allowlist (${n} entries)` : "The allowlist was already empty", "info");
				return;
			}
			if (sub === "allow") {
				const target = rest.join(" ");
				if (!target) {
					ctx.ui.notify("Usage: /sandbox-boundary allow <path>", "warning");
					return;
				}
				const scope = memoryScopeFor(target, pathEnv, boundary.cwd);
				if (!scope) {
					const never = neverDeleteReasonFor(target, pathEnv);
					ctx.ui.notify(
						never
							? `Protected identity, credential, or manually maintained configuration data cannot be pre-authorized: ${target}`
							: `Cannot determine a safe persistent scope (path is too shallow or high-risk): ${target}`,
						"warning",
					);
					return;
				}
				const remembered = store.remember([scope], "command", pathEnv);
				ctx.ui.notify(
					remembered.length > 0 ? `Pre-authorized: ${scope}` : `${scope} is already allowlisted or was blocked by a safety check`,
					"info",
				);
				return;
			}

			const entries = store.entries();
			const lines = [
				`Deletion boundary: ${writableRoots(boundary).join("、")}`,
				`Session counts: checked ${stats.checked}, remembered ${stats.remembered}, confirmed ${stats.confirmed}, denied ${stats.blocked}`,
				"",
				`Persistent allowlist (${store.filePath}）：${entries.length} entries`,
				...(entries.length > 0 ? entries.map((e) => `  ${e.path}（${e.source}，${e.addedAt.slice(0, 10)}）`) : ["  (none)"]),
				"",
				`Session exemptions (expire on restart): ${sessionScopes.roots().length ? sessionScopes.roots().join("、") : "(none)"}`,
				"",
				"High-risk directories (system roots / bin / application directories / ~/Library / paths containing .git) prompt on every deletion and only allow session exemptions.",
				"Protected identity, credential, or manually maintained configurations (~/.zshrc, ~/.ssh, ~/.gnupg, etc.) are denied without approval options.",
				"Writes are not blocked (write / edit also work outside the boundary); Bash commands have the same deletion boundary enforced by the seatbelt sandbox.",
				"Subcommands: forget <path> removes an entry · clear empties the list · allow <path> pre-authorizes. PI_SANDBOX=off disables this layer.",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
