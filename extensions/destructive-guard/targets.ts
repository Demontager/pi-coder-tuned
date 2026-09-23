/**
 * destructive-guard / targets.ts — 删除目标的抽取与判定。
 *
 * 纯函数，不碰文件系统、不 import pi（所以能直接 `node --test`）。判定口径来自
 * `~/.pi/agent/AGENTS.md` 的 `## Destructive actions`，这里把它变成代码。
 *
 * 为什么需要确定性检查：2026-09-23 的事故里，删除目标是**算出来的** ——
 *
 *     fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true })
 *
 * `s.log[0].x` 不存在 → `?? "/tmp"` 兜底 → `dirname("/tmp")` = `"/"`。这类错误不需要
 * “理解语义”就能发现，纯符号分析比 LLM 判定更可靠，也绕不过去。
 *
 * 词法解析（不解析符号链接）是刻意的：符号链接要访问磁盘才能跟上，而这里要的是
 * **确定性、可测、零副作用**。`/etc` 在 macOS 上是 `/private/etc` 的链接，两条路径
 * 都在保护表里，所以词法解析不吃亏。
 */

/** 判定的三档。`ok` 放行，`confirm` 问一次，`block` 直接拒绝。 */
export type Verdict = "ok" | "confirm" | "block";

/** 一条命中记录。 */
export interface Finding {
	/** 命令里原样的目标文本（可能带引号、变量）。 */
	target: string;
	/** 词法解析后的绝对路径；含未展开变量时为空串。 */
	resolved: string;
	verdict: Exclude<Verdict, "ok">;
	/** 规则名，展示用。 */
	rule: string;
	/** 一句人话。 */
	reason: string;
}

/** 一次删除调用点：哪个命令、删什么。 */
export interface DeleteSite {
	/** `rm` / `find` / `git clean` / `rsync` / `shred` / `truncate`。 */
	command: string;
	/** 目标原文，顺序同命令行。 */
	targets: string[];
	/** 所在片段（拆过 `&&` / `|` / `;` 之后），展示用。 */
	segment: string;
}

/**
 * 完全不能删的根：等它、是它的祖先，都命中 `block`。
 *
 * 只列“删掉就是灾难、且几乎不存在正当用途”的。**在里面**不算命中 ——
 * `/usr/local/bin/tsc` 是我自己装的，该删还能删；`/usr` 本身不行。
 */
export const HARD_ROOTS: readonly string[] = [
	"/",
	"/System",
	"/Library",
	"/Applications",
	"/Users",
	"/usr",
	"/bin",
	"/sbin",
	"/etc",
	"/private",
	"/private/etc",
	"/private/var",
	"/private/var/db",
	"/private/var/root",
	"/Volumes",
	"/opt",
	"/var",
];

/**
 * 在它里面也要问一句：系统所有的树。不在 `HARD_ROOTS` 里是因为 `/usr/local`（我自己装东西
 * 的地方）在 `/usr` 下 —— 整个 `/usr` 全拦会把正常安装也堵死。
 *
 * 同理 `/usr/local/bin/tsc` 这类具体文件是**我自己装的**，删它是正常运维，不该问；所以
 * 这一档只在目标是**目录层级较浅**时命中，深到具体文件就不问（见 `isInsideSystemTree`）。
 */
export const SYSTEM_TREES: readonly string[] = [
	"/System",
	"/Library",
	"/Applications",
	"/usr/local/Cellar",
	"/usr/local/lib",
	"/private/etc",
	"/private/var/db",
	"/private/var/root",
	"/Volumes",
];

/** 版本控制存储的根名：删掉就是丢掉只此一份的历史。 */
const VCS_DIRS = [".git", ".hg", ".svn"];

/** 认读的删除命令。 */
const DELETE_COMMANDS = new Set(["rm", "unlink", "shred", "truncate"]);

/**
 * 词法解析：去引号 → 展开 `~` → 相对路径拼 cwd → 消掉 `.` 与 `..`。
 *
 * 含未展开的变量（`$VAR` / `${...}` / `$(...)` / 反引号）时返回空串 —— 调用方据此
 * 判“目标未知”，而不是把一个假路径当成真路径。
 */
export function resolveLexical(raw: string, cwd: string, home: string): string {
	const unquoted = stripQuotes(raw);
	if (unquoted === "") return "";
	if (hasExpansion(unquoted)) return "";

	let path = unquoted;
	if (path === "~") path = home;
	else if (path.startsWith("~/")) path = home + path.slice(1);

	if (!path.startsWith("/")) path = cwd.replace(/\/+$/, "") + "/" + path;

	const out: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			out.pop();
			continue;
		}
		out.push(part);
	}
	return "/" + out.join("/");
}

/** 路径的段数（`/` 是 0 段，`/tmp` 是 1 段）。 */
export function componentCount(resolved: string): number {
	if (resolved === "" || resolved === "/") return 0;
	return resolved.split("/").filter((part) => part !== "").length;
}

/** 去掉最外层的成对引号。 */
export function stripQuotes(raw: string): string {
	let text = raw.trim();
	for (const quote of ['"', "'"]) {
		if (text.length >= 2 && text.startsWith(quote) && text.endsWith(quote)) {
			text = text.slice(1, -1);
		}
	}
	return text;
}

/** 是否含未展开的 shell 展开（变量、命令替换、反引号）。 */
export function hasExpansion(text: string): boolean {
	return text.includes("$") || text.includes("`");
}

/**
 * 判定单个目标。`cwd` / `home` 由调用方传入（保持纯函数）。
 */
export function evaluateTarget(raw: string, cwd: string, home: string): Finding | undefined {
	const text = stripQuotes(raw);
	const finding = (verdict: Exclude<Verdict, "ok">, rule: string, reason: string, resolved = ""): Finding => ({
		target: raw,
		resolved,
		verdict,
		rule,
		reason,
	});

	// 显式的主目录 / 根的同义词：不等解析就能判死。
	if (text === "/" ) return finding("block", "filesystem-root", "目标是文件系统根");
	if (text === "~" || text === "$HOME" || text === "${HOME}") {
		return finding("block", "home-root", "目标是主目录本身");
	}

	// 落点在删除目标上的兜底值：事故的直接成因。
	if (/\?\?|\|\||\$\{[A-Za-z_][A-Za-z0-9_]*:-/.test(text)) {
		return finding("confirm", "fallback-in-target", "删除目标里带了默认值兜底（取不到值时会落到默认路径）");
	}

	// 算出来的目标：dirname / basename / 变量 / 命令替换。
	if (/\bdirname\b|\bbasename\b/.test(text) || hasExpansion(text)) {
		return finding("confirm", "derived-target", "删除目标是算出来的，不是字面路径");
	}

	const resolved = resolveLexical(text, cwd, home);
	if (resolved === "") {
		return finding("confirm", "derived-target", "删除目标无法静态解析");
	}

	const depth = componentCount(resolved);
	if (depth < 2) {
		return finding("block", "top-level", `解析到 ${resolved}，只有 ${depth} 段路径（顶层目录不能作为删除目标）`, resolved);
	}

	if (resolved === home) {
		return finding("block", "home-root", "目标是主目录本身", resolved);
	}

	for (const root of HARD_ROOTS) {
		if (root === "/") continue;
		if (resolved === root) {
			return finding("block", "protected-root", `目标是受保护的根目录 ${root}`, resolved);
		}
		if (root.startsWith(resolved + "/")) {
			return finding("block", "ancestor-of-protected", `${resolved} 是受保护目录 ${root} 的上级`, resolved);
		}
	}

	for (const tree of SYSTEM_TREES) {
		if (resolved === tree || resolved.startsWith(tree + "/")) {
			return finding("confirm", "system-tree", `${resolved} 在系统目录 ${tree} 下`, resolved);
		}
	}

	for (const dir of VCS_DIRS) {
		if (resolved === dir || resolved.endsWith("/" + dir)) {
			return finding("confirm", "vcs-store", `${resolved} 是版本控制存储，删掉会丢掉只此一份的历史`, resolved);
		}
	}

	return undefined;
}

/**
 * 从一条 bash 命令里抽出所有删除调用点。
 *
 * 覆盖 `rm`（含 `-rf`/`-fr`/`--recursive`）、`find … -delete` 与 `find … -exec rm`、
 * `git clean -f`、`rsync --delete`、`shred`、`truncate`。只做词法切分，不执行任何东西。
 */
export function extractDeleteSites(command: string): DeleteSite[] {
	const sites: DeleteSite[] = [];
	for (const segment of splitSegments(command)) {
		const words = splitWords(segment);
		if (words.length === 0) continue;

		const head = words[0]!;
		const args = words.slice(1);

		if (DELETE_COMMANDS.has(head)) {
			const targets = nonFlagArgs(args);
			if (targets.length > 0) sites.push({ command: head, targets, segment });
			continue;
		}

		if (head === "find") {
			// 目标 = `find` 之后、第一个开关之前的路径（`-name` / `-delete` 这些都是开关）。
			const targets = args.filter((arg, index) => !arg.startsWith("-") && args.slice(0, index).every((prior) => !prior.startsWith("-")));
			const deletes = args.some((arg) => arg === "-delete" || arg === "-delete;");
			const execRms = /-exec\s+(rm|unlink|shred)\b/.test(segment);
			if ((deletes || execRms) && targets.length > 0) {
				sites.push({ command: "find", targets, segment });
			}
			continue;
		}

		if (head === "git") {
			const sub = args.find((arg) => !arg.startsWith("-"));
			if (sub === "clean" && args.some((arg) => /^-[a-zA-Z]*[fx]/.test(arg))) {
				sites.push({ command: "git clean", targets: ["."], segment });
			}
			continue;
		}

		if (head === "rsync" && args.includes("--delete")) {
			const positional = nonFlagArgs(args);
			const dest = positional.at(-1);
			if (dest !== undefined) sites.push({ command: "rsync --delete", targets: [dest], segment });
			continue;
		}
	}
	return sites;
}

/**
 * 对一条 bash 命令做完整判定，返回所有命中。
 *
 * `cwd` / `home` 用于解析相对路径与 `~`。
 */
export function inspectBash(command: string, cwd: string, home: string): Finding[] {
	const findings: Finding[] = [];
	for (const site of extractDeleteSites(command)) {
		for (const target of site.targets) {
			const finding = evaluateTarget(target, cwd, home);
			if (finding) findings.push(finding);
		}
	}
	return findings;
}

/** 按 shell 的 `;` `&&` `||` `|` `&` 与换行切片段，引号感知。 */
export function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let token = "";
	let quote: '"' | "'" | null = null;
	let depth = 0;

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;

		if (quote !== null) {
			token += char;
			if (quote === "'" && char === "'") quote = null;
			else if (quote === '"' && char === '"') quote = null;
			else if (quote === '"' && char === "\\" && index + 1 < command.length) {
				token += command[index + 1]!;
				index += 1;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			token += char;
			continue;
		}
		// 命令替换内部不切：`$(a; b)` 是一个词里的事。
		if (char === "$" && command[index + 1] === "(") depth += 1;
		if (char === ")" && depth > 0) depth -= 1;
		if (depth === 0 && (char === ";" || char === "\n" || char === "&" || char === "|")) {
			if (char === "&" && command[index + 1] === "&") index += 1;
			if (char === "|" && command[index + 1] === "|") index += 1;
			if (token.trim() !== "") segments.push(token.trim());
			token = "";
			continue;
		}
		token += char;
	}
	if (token.trim() !== "") segments.push(token.trim());
	return segments;
}

/** 把片段切成词，引号感知；引号保留在词里（判定时再剥）。 */
export function splitWords(segment: string): string[] {
	const words: string[] = [];
	let token = "";
	let hasToken = false;
	let quote: '"' | "'" | null = null;

	for (let index = 0; index < segment.length; index += 1) {
		const char = segment[index]!;

		if (quote !== null) {
			token += char;
			hasToken = true;
			if (quote === "'" && char === "'") quote = null;
			else if (quote === '"' && char === '"') quote = null;
			else if (quote === '"' && char === "\\" && index + 1 < segment.length) {
				token += segment[index + 1]!;
				index += 1;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			token += char;
			hasToken = true;
			continue;
		}
		if (char === " " || char === "\t") {
			if (hasToken) words.push(token);
			token = "";
			hasToken = false;
			continue;
		}
		// `>` `$(` 之类不在这里处理：本模块只关心“删什么”，不关心重定向。
		token += char;
		hasToken = true;
	}
	if (hasToken) words.push(token);
	return words;
}

/** 取非开关参数，`--` 之后一律算目标。 */
export function nonFlagArgs(args: readonly string[]): string[] {
	const out: string[] = [];
	let afterDoubleDash = false;
	for (const arg of args) {
		if (arg === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (!afterDoubleDash && arg.startsWith("-") && arg !== "-") continue;
		out.push(arg);
	}
	return out;
}
