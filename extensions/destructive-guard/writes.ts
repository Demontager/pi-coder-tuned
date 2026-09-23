/**
 * destructive-guard / writes.ts — 检查**写入内容**里的删除代码。
 *
 * 为什么要单独一层：2026-09-23 的事故里，bash 钩子看不见危险 —— 危险的是**更早写进去的
 * 那行代码**，而“运行脚本”那一步看起来只是 `node verify-a.mjs`，完全无害。Claude Code
 * 的分类器有对应规则（`WRITTEN FILE EXECUTION`）：
 *
 *   "A file write or edit is itself an action to evaluate. Judge the written or edited
 *    content against the BLOCK rules now, at write time ... do not defer to a later
 *    execution."
 *
 * 本模块只做一件事：从写入的文本里认出“删除目标由兜底值或路径运算得出”这种**事故形态**。
 * 它刻意不做完整数据流分析 —— 目标是少误报、抓得住真形态。
 *
 * 纯函数，不 import pi，可直接 `node --test`。
 */

/** 一条命中。 */
export interface WriteFinding {
	/** 命中的行号（从 1 起）。 */
	line: number;
	/** 命中的那行原文（截断到 160 字符）。 */
	text: string;
	/** 规则名。 */
	rule: string;
	/** 一句人话。 */
	reason: string;
}

/** 删除类 API 的名字。 */
const DELETE_APIS = [
	"rmSync",
	"rm",
	"rmdirSync",
	"rmdir",
	"unlinkSync",
	"unlink",
	"shutil.rmtree",
	"os.remove",
	"os.removedirs",
	"Remove-Item",
];

/** 路径运算函数：把它们用在删除目标上就是“推导出来的目标”。 */
const PATH_OPS = ["dirname", "basename", "resolve", "normalize", "join", "relative"];

/**
 * 检查一段文本（文件内容、patch 的新文本）里有没有危险的删除调用。
 *
 * 命中的形态：
 *   1. 删除调用 + 同一行里出现兜底值（`??` / `||` / `getattr(..., default)`）
 *   2. 删除调用 + 同一行里出现路径运算（`dirname(...)` / `join(...)` / `resolve(...)`）
 *   3. 删除调用 + 同一行里出现 `..` 或裸的 `/`（`rmSync("/")`）
 *   4. shell 侧：`rm -rf $VAR`、`rm -rf "$VAR"/*`、`rm -rf ${VAR:-/}` 这类变量目标
 *
 * 返回全部命中；调用方决定问还是拦。
 */
export function inspectWrittenContent(content: string): WriteFinding[] {
	const findings: WriteFinding[] = [];
	const lines = content.split("\n");

	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index]!;
		// 注释行与明显的文档行不算：它们不执行。
		const text = raw.trim();
		if (text === "" || text.startsWith("//") || text.startsWith("#") || text.startsWith("*")) continue;

		const api = DELETE_APIS.find((name) => text.includes(name));
		if (api === undefined) continue;

		const line = index + 1;
		const snippet = raw.length > 160 ? raw.slice(0, 160) + "…" : raw;

		// 形态 1：兜底值出现在删除调用所在行。
		if (/\?\?|\|\|/.test(text)) {
			findings.push({
				line,
				text: snippet,
				rule: "fallback-in-delete",
				reason: `${api} 所在行带了兜底值（\`??\` / \`||\`）：取不到值时会把实参换成默认路径，而这个默认路径往往不是你想删的`,
			});
			continue;
		}

		// 形态 2：删除目标由路径运算算出。
		const op = PATH_OPS.find((name) => new RegExp(`\\b${name}\\s*\\(`).test(text));
		if (op !== undefined) {
			findings.push({
				line,
				text: snippet,
				rule: "derived-delete-target",
				reason: `${api} 的目标来自 ${op}() 的返回值，不是字面路径：解析结果必须显式核对后才能删`,
			});
			continue;
		}

		// 形态 3：裸根 / 上跳。
		// `..` 段只看“是否有上跳段”，不管引号形状：真正危不危险由解析出的绝对路径决定，
		// 这里只是第一道筛子。
		if (
			new RegExp(`${api}\\s*\\(\\s*["'\`]\\/["'\`]`).test(text) ||
			/(^|[^\w.])["`']?\.\.[/"`'\s]/.test(text)
		) {
			findings.push({
				line,
				text: snippet,
				rule: "root-or-parent-delete",
				reason: `${api} 的目标是根目录或 \`..\` 上跳`,
			});
			continue;
		}

		// 形态 4：shell 变量目标。
		if (/\brm\b[^\n]*\$(?:\{?[A-Za-z_][A-Za-z0-9_]*\}?)/.test(text)) {
			findings.push({
				line,
				text: snippet,
				rule: "shell-variable-target",
				reason: "shell 删除命令的目标是变量：变量为空时会退化成 `rm -rf /*` 这类形态",
			});
			continue;
		}

		// 形态 5：PowerShell 递归删除的目标不是字面量。
		// `Remove-Item` 的路径参数不带逗号，看不出边界，所以只判“有没有字面量”。
		if (api === "Remove-Item" && /-Recurse|-Force/i.test(text)) {
			const hasLiteral = /Remove-Item[^\n]*["'][A-Za-z]:[\\/]|Remove-Item[^\n]*["']\//.test(text);
			if (!hasLiteral) {
				findings.push({
					line,
					text: snippet,
					rule: "derived-delete-target",
					reason: "Remove-Item -Recurse 的目标不是字面路径（变量或表达式）：递归删除前必须先把目标解析并核对",
				});
			}
		}
	}

	return findings;
}

/**
 * 从一行里抽出工具调用的目标参数（用于报错信息里展示“它会删什么”）。
 * 找不到返回 undefined。
 */
export function firstStringArg(text: string, api: string): string | undefined {
	const index = text.indexOf(api);
	if (index < 0) return undefined;
	const after = text.slice(index + api.length);
	const match = /^\s*\(\s*(["'`])([^"'`]*)\1/.exec(after);
	return match?.[2];
}
