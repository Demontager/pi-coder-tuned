/**
 * destructive-guard / writes.ts — 检查一段**可执行文本**里的危险删除调用。
 *
 * 为什么要单独一层：2026-09-23 的事故里，bash 钩子看不见危险 —— 危险的是**更早写进去的
 * 那行代码**，而“运行脚本”那一步看起来只是 `node verify-a.mjs`，完全无害。Claude Code
 * 的分类器有对应规则（`WRITTEN FILE EXECUTION`）：
 *
 *   "A file write or edit is itself an action to evaluate. Judge the written or edited
 *    content against the BLOCK rules now, at write time ... do not defer to a later
 *    execution."
 *
 * 本模块只做一件事：从文本里认出“删除目标由兜底值或路径运算得出”这种**事故形态**，
 * 它刻意不做完整数据流分析 —— 目标是少误报、抓得住真形态。
 *
 * ## 2026-09-23 之后的收紧（误报治理）
 *
 * 第一版用的是**子串**匹配：`text.includes("rm")` + 同一行出现 `||` 就报警。回归到本机
 * 全部会话后，58 处命中里只有极少数是真代码 —— 谈论删除的文档、断言守卫行为的测试、
 * 守卫自己的错误文案全部在内（`const form = a || b` 也会命中）。判定于是改成三条：
 *
 *   1. **必须是真调用**：`api(` 且标识符左侧是边界（`confirm(` / `transform(` 不算），
 *      shell 侧必须是 `rm -rf` 这类带开关的命令词（散文里的 “rm 那一段” 不算）。
 *   2. **危险目标必须落在参数区间内**：`??` / `||` / `dirname()` / 变量 / 裸根 / `..`
 *      必须出现在那个调用的括号里（跨行也算），而不是同一行里各说各的。
 *   3. **分级**：目标文件不可执行（`.md` / `.html` / `.json` …）或命中落在字符串字面量里
 *      且同行没有执行汇（eval / execSync / sh -c …）时降为 `info` —— 记录但不弹窗。
 *
 * 第三闸（`index.ts` 里的运行时检查）也复用这里的检查器：即将被 `node <script>` 跑的
 * 脚本文件，内容和“刚写进去的内容”面对的是同一套判据。
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
	/**
	 * `confirm` 需要用户确认；`block` 直接拒；`info` 只记录（不可执行的目标文件、或字符串字面量里的引用）。
	 * 调用方按“最严的一条”决定怎么做。
	 */
	severity: WriteSeverity;
}

/** 命中的轻重。 */
export type WriteSeverity = "block" | "confirm" | "info";

/** 检查选项。 */
export interface WriteInspectOptions {
	/** 这段文本要写到哪里 / 是哪个脚本文件（用于判断目标能否执行）。 */
	targetPath?: string;
	/**
	 * 字面量目标的判定器（由调用方注入，典型是 `targets.ts` 的 `evaluateTarget`）。
	 * 注入而不是 import：本模块要保持可直接 `node --test`、不依赖 cwd/home。
	 * 返回 `undefined` 表示这个字面量目标放行。
	 */
	evaluateLiteral?: (literal: string) => { rule: string; reason: string; verdict: "block" | "confirm" } | undefined;
}

/** 删除类 API 的名字（按长度降序，避免 `rmSync` 被 `rm` 抢走）。 */
const DELETE_APIS = [
	"os.removedirs",
	"shutil.rmtree",
	"rmdirSync",
	"unlinkSync",
	"os.remove",
	"rmSync",
	"rmdir",
	"unlink",
];

/** 路径运算函数：把它们用在删除目标上就是“推导出来的目标”。 */
const PATH_OPS = /\b(dirname|basename|resolve|normalize|join|relative)\s*\(/;

/** 目标里的兜底值（事故的直接成因）。 */
const FALLBACK = /\?\?|\|\|/;

/** 变量 / 命令替换 / 模板串。 */
const EXPANSION = /\$\{|\$[A-Za-z_]|`/;

/** 上跳段：`..` 单独成段（`...rest` 与 `?.` 都不算）。 */
const PARENT_SEGMENT = /(^|[^\w.])\.\.([^\w.]|$)/;

/** 裸根目标：`("/")` / `('/')` / `(\`/\`)`。 */
const BARE_ROOT = /[(,]\s*["'`]\/["'`]\s*[,)]/;

/** shell 侧的删除命令词：必须带开关（散文里的 “rm 那一段” 不算）。
 * 前缀允许引号/反引号 —— `execSync("rm -rf $D")` 与模板串里的命令都是真命令；
 * 纯引文靠下面的“字面量降级”处理，不在这里分。 */
const SHELL_DELETE = /(?:^|[;&|(]|\s|["'`])(?:sudo\s+)?(rm|unlink|shred)\s+(-[^\s]+)([^;&|]*)/;

/** PowerShell 的递归删除。 */
const POWERSHELL_DELETE = /Remove-Item\b[^\n]*-(?:Recurse|Force)\b/i;

/** 同行出现这些就是“这段文本会被执行”，字符串里也不再当成纯数据。 */
const EXEC_SINK = /\b(exec|execSync|spawn|spawnSync|execFile|fork|eval|Function|os\.system|popen|subprocess|child_process|system)\b|\b(sh|bash|zsh)\s+-c\b/;

/**
 * 不执行代码的目标文件扩展名：写进这些文件的内容不会跑起来。
 * 只列**确实不执行**的；`.json` / `.svg` / `.xml` 都是数据，`.html` 里的脚本不会
 * 因为写入而运行。
 */
const NON_EXECUTABLE_EXTENSIONS = new Set([
	".md",
	".markdown",
	".mdx",
	".txt",
	".rst",
	".html",
	".htm",
	".xml",
	".svg",
	".json",
	".jsonl",
	".ndjson",
	".csv",
	".tsv",
	".log",
	".diff",
	".patch.txt",
]);

/** 目标文件是否不会执行其中内容。没给路径时按“会执行”处理（宁可问一句）。 */
export function isNonExecutableTarget(targetPath: string | undefined): boolean {
	if (targetPath === undefined || targetPath === "") return false;
	const lower = targetPath.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot < 0) return false;
	return NON_EXECUTABLE_EXTENSIONS.has(lower.slice(dot));
}

/** 一处字符串/模板字面量区间。 */
export interface QuotedRange {
	start: number;
	end: number;
	kind: '"' | "'" | "`";
	/** 模板串里有没有 `${…}`：有就是真代码（会拼进命令），不是引文。 */
	interpolates: boolean;
}

/**
 * 扫描全文，标出落在字符串/模板字面量里的区间。
 * 模板串额外带上 `interpolates`：含 `${…}` 的模板串是真代码（会被拼进命令），不是引文。
 */
export function quotedRanges(content: string): QuotedRange[] {
	const ranges: QuotedRange[] = [];
	let quote: '"' | "'" | "`" | null = null;
	let start = 0;

	for (let index = 0; index < content.length; index += 1) {
		const char = content[index]!;
		if (quote === null) {
			if (char === '"' || char === "'" || char === "`") {
				quote = char;
				start = index;
			}
			continue;
		}
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === quote) {
			const body = content.slice(start + 1, index);
			ranges.push({ start, end: index + 1, kind: quote, interpolates: quote === "`" && body.includes("${") });
			quote = null;
		}
	}
	if (quote !== null) {
		const body = content.slice(start + 1);
		ranges.push({ start, end: content.length, kind: quote, interpolates: quote === "`" && body.includes("${") });
	}
	return ranges;
}

function insideRanges(ranges: readonly QuotedRange[], index: number): QuotedRange | undefined {
	return ranges.find((range) => index >= range.start && index < range.end);
}

/** 从 `open`（指向 `(`）扫到配对的 `)`，返回区间文本。扫不到就吃到串尾。 */
export function balancedRegion(content: string, open: number): string {
	let depth = 0;
	let quote: '"' | "'" | "`" | null = null;

	for (let index = open; index < content.length; index += 1) {
		const char = content[index]!;
		if (quote !== null) {
			if (char === "\\") {
				index += 1;
				continue;
			}
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) return content.slice(open, index + 1);
		}
	}
	return content.slice(open);
}

/** 这段参数区间里有没有“目标算出来的”形态；返回命中的规则名。 */
function classifyRegion(region: string): { rule: string; reason: string } | undefined {
	if (FALLBACK.test(region)) {
		return {
			rule: "fallback-in-delete",
			reason: "删除调用的参数里有兜底值（`??` / `||`）：取不到值时会把实参换成默认路径，而这个默认路径往往不是你想删的",
		};
	}
	if (PATH_OPS.test(region)) {
		const op = PATH_OPS.exec(region)?.[1] ?? "dirname";
		return {
			rule: "derived-delete-target",
			reason: `删除目标来自 ${op}() 的返回值，不是字面路径：解析结果必须显式核对后才能删`,
		};
	}
	if (EXPANSION.test(region)) {
		return {
			rule: "derived-delete-target",
			reason: "删除目标是变量 / 命令替换 / 模板串算出来的，执行前无法静态知道具体路径",
		};
	}
	if (BARE_ROOT.test(region) || PARENT_SEGMENT.test(region.replace(/["'`]/g, " "))) {
		return { rule: "root-or-parent-delete", reason: "删除目标是根目录或 `..` 上跳" };
	}
	return undefined;
}

/**
 * 调用里第一个字面量参数（`rmSync("/Users", …)` 的 `/Users`）。
 * 取不到或不是字面量就返回 undefined。
 */
export function firstLiteralArg(region: string): string | undefined {
	const open = region.indexOf("(");
	if (open < 0) return undefined;
	const after = region.slice(open + 1).replace(/^\s+/, "");
	const match = /^(["'`])([^"'`]*)\1/.exec(after);
	if (!match) return undefined;
	const body = match[2] ?? "";
	// 模板串里的变量不是字面量
	if (body.includes("${")) return undefined;
	return body;
}

/** 第 `index` 个字符所在行号（从 1 起）。 */
function lineAt(content: string, index: number): number {
	let line = 1;
	for (let cursor = 0; cursor < index; cursor += 1) {
		if (content[cursor] === "\n") line += 1;
	}
	return line;
}

/** 行原文（用于展示）。 */
function lineText(content: string, line: number): string {
	const raw = content.split("\n")[line - 1] ?? "";
	return raw.length > 160 ? raw.slice(0, 160) + "…" : raw;
}

/** 这一行是不是注释/文档行（不执行）。 */
function isCommentLine(text: string): boolean {
	const trimmed = text.trim();
	return (
		trimmed === "" ||
		trimmed.startsWith("//") ||
		trimmed.startsWith("#") ||
		trimmed.startsWith("*") ||
		trimmed.startsWith("/*") ||
		trimmed.startsWith("<!--") ||
		trimmed.startsWith(">")
	);
}

/** 去掉文档标记，避免 `<code>rm -rf b</code>` 这类引文被当成命令词。
 * 只剥**不插值**的反引号片段：带 `${…}` 的模板串是真代码（`execSync(\`rm -rf ${D}\`)`），
 * 剥掉它等于把真命令丢了。 */
function stripDocMarkup(text: string): string {
	return text
		.replace(/<code>[\s\S]*?<\/code>/gi, " ")
		.replace(/<pre>[\s\S]*?<\/pre>/gi, " ")
		.replace(/`([^`]*)`/g, (whole, body: string) => (body.includes("${") ? whole : " "));
}

/**
 * 检查一段文本里有没有危险的删除调用。
 *
 * 返回全部命中；调用方按 `severity` 决定弹窗还是只记录。
 */
export function inspectWrittenContent(content: string, options: WriteInspectOptions = {}): WriteFinding[] {
	if (content === "") return [];

	const findings: WriteFinding[] = [];
	const quoted = quotedRanges(content);
	const downgradeAll = isNonExecutableTarget(options.targetPath);

	const push = (line: number, rule: string, reason: string, literal = false, forced?: WriteSeverity): void => {
		const raw = content.split("\n")[line - 1] ?? "";
		if (isCommentLine(raw)) return;
		findings.push({
			line,
			text: lineText(content, line),
			rule,
			reason,
			severity: forced ?? (downgradeAll || literal ? "info" : "confirm"),
		});
	};

	// ---- 形态一：真正的删除 API 调用（跨行也算） ----
	for (const api of DELETE_APIS) {
		const escaped = api.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		// 前面的字符不能是标识符的一部分（`myrmSync(` 不算），但 `.` 必须放行 ——
		// `fs.rmSync(` / `os.remove(` 正是方法调用形态。
		const pattern = new RegExp(`(?:^|[^\\w])${escaped}\\s*\\(`, "g");
		for (const match of content.matchAll(pattern)) {
			const start = match.index + match[0].length - 1;
			const region = balancedRegion(content, start);
			const line = lineAt(content, match.index);
			const hit = classifyRegion(region);
			if (hit) {
				const where = insideRanges(quoted, match.index);
				// 字符串里的引用不拦（除非同行有执行汇），但带 `${…}` 的模板串是真代码。
				const literal =
					where !== undefined &&
					!where.interpolates &&
					!EXEC_SINK.test(content.split("\n")[line - 1] ?? "");
				push(line, hit.rule, hit.reason, literal);
				continue;
			}

			// 字面量目标：`fs.rmSync("/Users")` / `fs.rmSync("/")` 这类必须由调用方注入的
			// 判定器（保护根表）来判，本模块自己不知道哪些是受保护目录。
			const literalArg = firstLiteralArg(region);
			const verdict = literalArg === undefined ? undefined : options.evaluateLiteral?.(literalArg);
			if (verdict === undefined) continue;
			push(line, verdict.rule, verdict.reason, false, verdict.verdict);
		}
	}

	// ---- 形态二：shell 删除命令（写进脚本的 `rm -rf $VAR`） ----
	content.split("\n").forEach((raw, index) => {
		const text = stripDocMarkup(raw);
		if (isCommentLine(text)) return;

		const shell = SHELL_DELETE.exec(text);
		if (shell) {
			const flags = shell[2] ?? "";
			const target = shell[3] ?? "";
			const recursive = /[rR]/.test(flags.replace(/^--/, ""));
			const risky = EXPANSION.test(target) || /(^|[^\w.])\.\.([^\w.]|$)/.test(target) || /^["'`]?\/["'`]?$/.test(target.trim());
			if (recursive && risky) {
				// 引号里的引用同样降级（带 `${…}` 的模板串除外）。
				const at = text.indexOf("rm ") >= 0 ? raw.indexOf("rm ") : raw.indexOf(shell[1] ?? "rm");
				const where = insideRanges(quoted, Math.max(0, at));
				const literal = where !== undefined && !where.interpolates && !EXEC_SINK.test(text);
				push(
					index + 1,
					"shell-variable-target",
					"shell 删除命令的目标是变量或上跳路径：变量为空时会退化成 `rm -rf /*` 这类形态",
					literal,
				);
			}
		}

		if (POWERSHELL_DELETE.test(text)) {
			const hasLiteral = /Remove-Item[^\n]*["'][A-Za-z]:[\\\/]|Remove-Item[^\n]*["']\//.test(text);
			if (!hasLiteral) {
				push(index + 1, "derived-delete-target", "Remove-Item -Recurse 的目标不是字面路径（变量或表达式）：递归删除前必须先把目标解析并核对");
			}
		}
	});

	return findings;
}

/** 命中的最严一级（没有命中时返回 `info`）。 */
export function worstSeverity(findings: readonly WriteFinding[]): WriteSeverity {
	if (findings.some((finding) => finding.severity === "block")) return "block";
	return findings.some((finding) => finding.severity === "confirm") ? "confirm" : "info";
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
