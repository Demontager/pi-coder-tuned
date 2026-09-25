/**
 * /init：仿 Claude Code —— 让模型分析当前仓库，生成或更新「记忆文件」。
 *
 * 目标文件的选取（没显式指定时，只看 `ctx.cwd` 这一层）：
 *   ① 有 `CLAUDE.md` → 更新 `CLAUDE.md`
 *   ② 否则有 `AGENTS.md` → 更新 `AGENTS.md`
 *   ③ 两个都没有 → 新建 `AGENTS.md`
 * 显式指定：`/init <文件.md>`（第一个词以 `.md` 结尾就当路径，其余的当附加要求），
 * 例如 `/init docs/NOTES.md`、`/init /tmp/foo.md`、`/init 重点写构建和测试`。
 *
 * 为什么 CLAUDE.md 优先：这个仓库（以及作者的大部分项目）把 `CLAUDE.md` 当正文、
 * `AGENTS.md` 只是指向它的符号链接 —— 写 `CLAUDE.md` 才不会在复制/打包时丢内容。
 * pi 自己两个名字都认（`docs/usage.md` 的 Context Files：从 cwd 逐层向上加载
 * `AGENTS.md` 或 `CLAUDE.md`，同目录有 `AGENTS.override.md` 时以它为准），所以这个顺序
 * 只决定「往哪个文件写」，不影响它会不会被加载。
 *
 * 扩展自己**不写文件**：只做目标判定 + 把一段提示词当**用户消息**发给模型
 *（`pi.sendUserMessage`），由模型的 read / write / edit 去落盘。这正是 Claude Code
 * `/init` 的形态（一条命令 + 一段提示词），好处是用户能在会话里看到模型的产出过程、
 * 也能中途纠正；扩展不碰文件，就没有「扩展在后台偷偷改仓库」这类意外。
 *
 * 三个刻意的决定：
 *   ① **先 `await ctx.waitForIdle()`** 再判定：agent 正在跑的时候发用户消息要么抛错
 *      （未指定 `deliverAs`），要么被排成 followUp；而目标文件的判定会因此变旧 ——
 *      当前回合可能刚创建/删掉 `CLAUDE.md`，那样就会把内容写进错的记忆文件。
 *      等这轮结束再判定 + 发送，语义最稳（同 `/clear` 先 `waitForIdle` 的理由）。
 *   ② **只认 cwd 这一层，不向上找父目录**：pi 是逐层加载的，用户在子目录里 `/init`
 *      想写的就是这个子目录自己的记忆文件；要写别处直接传路径。向上找会让人在子目录里
 *      一不留神改到仓库根的记忆文件。
 *   ③ **不注册参数补全**：`/init` 的候选只有两个固定名字，补全的收益抵不上一个额外的
 *      pi-tui 依赖面；要指定路径就手敲，反正有 `read`/`write` 的相对路径习惯。
 *
 * `ctx.hasUI` 为 false（print / json 模式）时不 notify —— 那里没有 UI，提示无处可去；
 * 命令本身照常把提示词发出去。
 */

import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 自动判定时的候选顺序：有 `CLAUDE.md` 就写它，否则 `AGENTS.md`。 */
const CANDIDATES = ["CLAUDE.md", "AGENTS.md"];

/** 两个候选都没有时新建哪个。 */
const NEW_FILE = "AGENTS.md";

/** `statSync` 跟随符号链接 —— 本仓库就是 `AGENTS.md -> CLAUDE.md`，两个名字都该算“存在”。 */
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

interface InitTarget {
	/** 交给模型落盘的**绝对路径**。 */
	path: string;
	/** 提示词里展示用的路径（在项目内用相对路径，否则回落绝对路径）。 */
	display: string;
	exists: boolean;
	/** 用户显式指定的路径（提示词里换一种说法，并提醒别动兄弟文件）。 */
	explicit: boolean;
}

/**
 * 解析 `/init` 的参数：第一个词以 `.md` 结尾就算目标文件，其余文字当附加要求；
 * 没有这样的词就整串当附加要求（`/init 重点写构建和测试`）。
 */
function parseArgs(args: string): { file?: string; extra: string } {
	const trimmed = args.trim();
	if (!trimmed) return { extra: "" };
	const match = /^(\S+\.md)(?:\s+([\s\S]*))?$/i.exec(trimmed);
	if (!match) return { extra: trimmed };
	return { file: match[1], extra: (match[2] ?? "").trim() };
}

/** 项目内显示相对路径（`../x` 这种跳出去的回落绝对路径，免得看不出真写到哪了）。 */
function displayPath(cwd: string, path: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function resolveTarget(cwd: string, file: string | undefined): InitTarget {
	if (file) {
		const path = isAbsolute(file) ? file : resolve(cwd, file);
		return { path, display: displayPath(cwd, path), exists: isFile(path), explicit: true };
	}
	for (const name of CANDIDATES) {
		const path = resolve(cwd, name);
		if (isFile(path)) return { path, display: name, exists: true, explicit: false };
	}
	return { path: resolve(cwd, NEW_FILE), display: NEW_FILE, exists: false, explicit: false };
}

/**
 * 提示词。要点：
 *   - 把「文件会被之后的每次会话自动加载」说清楚，模型才知道该写什么（写给下一个 agent）。
 *   - 明确**只写验证过的事实**（这个仓库的一贯要求：不臆造命令、不猜路径）。
 *   - 已存在时强调「先 read、保留正确内容、别为重写而重写」，否则模型很容易整篇重写，
 *     把仓库里那些踩坑记录一把抹掉。
 *   - 列出「不要写」的清单（通用建议 / 目录树 / README 复述 / 临时信息）—— 这是
 *     Claude Code 的 /init 提示词里最起作用的那几条，照搬。
 */
function buildPrompt(target: InitTarget, cwd: string, extra: string): string {
	const action = target.exists ? "Update" : "Create";
	const lines = [
		`Analyze this codebase, then ${action} the memory file \`${target.display}\` (absolute path: \`${target.path}\`）。`,
		"",
		"Pi automatically loads this file in **every subsequent session**, reading AGENTS.md / CLAUDE.md up from the working directory, with AGENTS.override.md taking precedence in the same directory. Write for the next agent working in this repository.",
		`Project root: \`${cwd}\``,
		"",
		target.exists
			? "The file **already exists**: read it first. Keep accurate content, remove outdated content, and add missing information. Avoid unnecessary rewrites and retain existing troubleshooting notes."
			: "The file **does not exist yet**: create it.",
		"",
		"Explore the repository first (README, dependency/build manifests, CI, tests, and main source). **Write only verified facts**: commands must exist and paths must be correct. Omit uncertain claims rather than inventing them.",
		"",
		"Include, in priority order:",
		"1. **Common commands**: install dependencies, build, test (including individual tests), lint, format, and start local services. State working directories and prerequisites. Use copyable code blocks.",
		"2. **Architecture and code map**: module responsibilities, typical request/build flow, conventions and layers, external dependencies, and generated files that should not be edited manually.",
		"3. **Repository-specific pitfalls**: non-obvious behavior, required workflows (commit format, linked configurations, synchronized copies), and common mistakes.",
		"",
		"Do not include:",
		"- Generic development advice such as writing unit tests, not committing secrets, or providing clear errors.",
		"- Directory trees, exhaustive file lists, or a repetition of the README.",
		"- Temporary information relevant only to the current task.",
		"",
		"Writing style:",
		"- Follow the existing file's language and style; use English for new files. Be concise and prefer useful facts over filler.",
	];
	if (!target.explicit) {
		lines.push(
			"- If AGENTS.md and CLAUDE.md both exist, or one symlinks to the other, **edit only the specified file**; do not duplicate its contents into the other.",
		);
	}
	lines.push(
		"- You may read other agent instructions (.cursorrules, .cursor/rules/, .github/copilot-instructions.md, .claude/) for missing information, but do not modify them.",
		"- Use write / edit tools at the absolute path above, not Bash cat/heredocs.",
		"- Finish with one or two sentences describing the changes.",
	);
	if (extra) lines.push("", `Additional requirements for this /init: ${extra}`);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("init", {
		description: "Analyze the repository and create/update its memory file (CLAUDE.md if present, otherwise AGENTS.md)",
		handler: async (args, ctx) => {
			const { file, extra } = parseArgs(args);
			// 判定必须发生在「发消息」那一刻：agent 正在跑时先等它结束（见文件头 ①）。
			if (!ctx.isIdle()) {
				if (ctx.hasUI) ctx.ui.notify("Waiting for the current turn to finish before starting /init…", "info");
				await ctx.waitForIdle();
			}
			const target = resolveTarget(ctx.cwd, file);
			if (ctx.hasUI) {
				ctx.ui.notify(`${target.exists ? "Update" : "Create"} ${target.display}（${target.path}）…`, "info");
			}
			pi.sendUserMessage(buildPrompt(target, ctx.cwd, extra));
		},
	});
}
