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

import { inspectWrittenContent, type WriteFinding } from "./writes.ts";

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
	/** 这个目标所在的命令片段（拆过 `&&` / `|` / `;` 之后），展示用。 */
	segment?: string;
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

/** 一段被解释器直接执行的源码（内联代码或 heredoc 正文）。 */
export interface InlineRun {
	/** `node` / `sh` / `python3` … */
	interpreter: string;
	/** 会被执行的源码正文。 */
	code: string;
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

/**
 * 临时根：`mktemp -d` 的产物落在这里，是“本会话自己创建的”路径的实际代理。
 *
 * AGENTS.md 的断言是“工作目录之外、**且不是本会话创建的**”才要确认；“本会话创建的”
 * 静态判不出来，而临时目录是它唯一可靠的近似 —— 守卫自己的测试、调试脚本全在这里，
 * 每次都弹窗等于没有守卫。`/tmp` 与 `/private/tmp` 都列：macOS 上前者是后者的链接，
 * 而本模块刻意不解析符号链接。`/var/tmp` 与 `/private/var/tmp` 同理补上：它是 macOS 自带
 * bash 3.2 的 heredoc 临时目录（编译期写死，`TMPDIR` 改不动），与 seatbelt 边界的
 * `TEMP_WRITE_ROOTS` 保持同一套名单，否则两边对「什么算临时目录」的口径会漂移。
 */
const TEMP_ROOTS: readonly string[] = [
	"/tmp",
	"/private/tmp",
	"/var/folders",
	"/private/var/folders",
	"/var/tmp",
	"/private/var/tmp",
];

/**
 * 守卫必须保护自己的路径后缀 / 文件名。
 *
 * 2026-09-23 第二次事故里，`rm -rf ~/.pi/agent/extensions/destructive-guard` 与
 * `rm -f ~/.pi/agent/AGENTS.md` 都是**放行**的 —— 守卫看不见自己，也看不见定义它的那份
 * 纪律。删掉前者等于当场解除武装，删掉后者等于把判定口径的出处抹掉，所以这一档是
 * `block` 而不是 `confirm`。
 */
const SELF_PROTECTED_SUFFIXES: readonly string[] = [
	"/extensions/destructive-guard",
	"/extensions/destructive-guard/",
];

/** 守卫自己的文件名（落在 agent 目录下时受保护）。 */
const SELF_PROTECTED_BASENAMES: readonly string[] = ["AGENTS.md"];

/** agent 目录里“删掉就等于解除武装”的子树。 */
const SELF_PROTECTED_AGENT_SUBTREES: readonly string[] = ["/extensions", "/rewind", "/sessions"];

/** 认读的删除命令。 */
const DELETE_COMMANDS = new Set(["rm", "unlink", "shred", "truncate"]);

/**
 * 会被当作透明前缀跳过的包装命令（`sudo -u root rm -rf x` 的 `rm` 也要认出来）。
 * 与 plan-mode 的表一致：这些命令自己不改动任何东西，真正的动作在后面。
 */
const WRAPPER_COMMANDS = new Set(["sudo", "doas", "env", "command", "nohup", "time", "nice", "xargs", "builtin", "exec"]);

/** 包装命令里“消耗一个值”的开关：`nice -n 10 rm` 的 `10`、`env -u HOME rm` 的 `HOME`。 */
const WRAPPER_VALUE_FLAGS = new Set(["-n", "-u", "-C", "-S", "-s", "--user", "--unset", "--chdir"]);

/** 解释器 → 内联代码开关。`node -e` / `sh -c` / `python3 -c` 里的代码就是即将执行的东西。 */
const INLINE_CODE_FLAGS: Readonly<Record<string, readonly string[]>> = {
	node: ["-e", "--eval", "-p", "--print"],
	sh: ["-c"],
	bash: ["-c"],
	zsh: ["-c"],
	dash: ["-c"],
	ksh: ["-c"],
	python: ["-c"],
	python3: ["-c"],
	ruby: ["-e"],
	perl: ["-e"],
};

/**
 * 跳过 `FOO=bar` 赋值与包装命令，拿到真正的命令词与参数。
 * `sudo` 自己的开关（`-u root`）连着它的值一起丢掉。
 */
export function unwrapCommand(words: readonly string[]): { head: string; args: string[] } {
	let index = 0;
	while (index < words.length) {
		const word = words[index]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			index += 1;
			continue;
		}
		const name = word.split("/").pop() ?? "";
		if (WRAPPER_COMMANDS.has(name)) {
			index += 1;
			// 包装命令自己的开关与它消耗的值
			while (index < words.length) {
				const flag = words[index]!;
				if (flag === "--") {
					index += 1;
					break;
				}
				if (!flag.startsWith("-")) break;
				index += WRAPPER_VALUE_FLAGS.has(flag) ? 2 : 1;
			}
			continue;
		}
		break;
	}
	const head = words[index]?.split("/").pop() ?? "";
	return { head, args: words.slice(index + 1) };
}

/**
 * 把 shell 词还原成它实际传给子进程的文本。
 *
 * 与 `stripQuotes` 的区别：双引号里的 `\"` / `\\` / `\$` / ``\` `` 会被 shell 吃掉
 * 转义符（`sh -c "node -e 'fs.rmSync(\"/Users\")'"` 里的子命令真的是
 * `fs.rmSync("/Users")`），这里要把那一层去掉，否则内联代码会被判成语法错误。
 */
export function unquoteShellWords(raw: string): string {
	let text = raw.trim();
	for (let round = 0; round < 8; round += 1) {
		let peeled = false;
		if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
			// 双引号：只吃掉对 `"` `\\` `\$` ``\` `` 的转义，其他反斜杠原样保留
			text = text.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
			peeled = true;
		} else if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
			// 单引号：里面没有任何转义
			text = text.slice(1, -1);
			peeled = true;
		}
		if (!peeled) break;
	}
	return text;
}

/**
 * 把“整体被引号包住、剥完还是一个命令行”的词补上一份展开态：
 * `sh -c "node -e '…'"` 的第三段展开后是 `node -e '…'`，内联代码才能抽出来。
 *
 * 只给 `unwrapCommand` 用（抽内联代码），**不碰 `splitWords`** —— 那里多出来的词
 * 会被 `extractDeleteSites` 当成真目标，凭空造出 `node` / `-e` 这种不是路径的东西。
 */
export function expandQuotedWords(words: readonly string[]): string[] {
	const out: string[] = [];
	for (const word of words) {
		out.push(word);
		const peeled = unquoteShellWords(word);
		if (peeled !== word && peeled.includes(" ")) out.push(peeled);
	}
	return out;
}

/**
 * 从片段里抽出“即将被解释器执行的内联代码”。
 *
 * 事故形态在闸一的盲区里：`node -e 'fs.rmSync(path.dirname(x ?? "/tmp"))'`、
 * `sh -c 'rm -rf $DIR'`、`python3 -c 'shutil.rmtree(os.path.dirname(p))'` 这些命令的
 * 危险不在命令词上，而在解释器的参数里。把内联代码当子命令再扫一遍，盲区就补上了。
 */
export function extractInlineCode(command: string): InlineRun[] {
	const found: InlineRun[] = [];
	for (const segment of splitSegments(command)) {
		const words = splitWords(segment);
		if (words.length === 0) continue;
		const { head, args } = unwrapCommand(expandQuotedWords(words));
		const flags = INLINE_CODE_FLAGS[head];
		if (flags === undefined) continue;

		for (let index = 0; index < args.length; index += 1) {
			const flag = unquoteShellWords(args[index]!);
			if (!flags.includes(flag)) continue;
			const code = args[index + 1];
			if (code === undefined) break;
			found.push({ interpreter: head, code: unquoteShellWords(code) });
			break;
		}
	}
	return found;
}

/**
 * 从 `interpreter - <<EOF … EOF` 这种“把脚本从 stdin 喂给解释器”的形态里取正文。
 * 与内联代码同理：正文才是真正要跑的东西。
 */
export function extractStdinScript(command: string): InlineRun[] {
	const found: InlineRun[] = [];
	const lines = command.split("\n");

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const match = /^\s*([A-Za-z_][\w.\-/]*)\b[^\n]*?<<-?\s*(["']?)([A-Za-z_][\w]*)\2/.exec(line);
		if (!match) continue;
		const interpreter = (match[1] ?? "").split("/").pop() ?? "";
		if (INLINE_CODE_FLAGS[interpreter] === undefined) continue;

		const delimiter = match[3] ?? "";
		const body: string[] = [];
		for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
			if (lines[cursor]!.trim() === delimiter) {
				index = cursor;
				break;
			}
			body.push(lines[cursor]!);
		}
		if (body.length > 0) found.push({ interpreter, code: body.join("\n") });
	}
	return found;
}

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

/** 去掉最外层的成对引号（**多层**：`"'code'"` 要剥到 `code`）。 */
export function stripQuotes(raw: string): string {
	let text = raw.trim();
	// 嵌套引号（`sh -c "node -e '…'"`）需要剥多轮。每轮必须成对才继续，
	// 所以 `"a" + "b"` 这类拼接到一半的串不会越剥越短。
	for (let round = 0; round < 8; round += 1) {
		let peeled = false;
		for (const quote of ['"', "'"]) {
			if (text.length >= 2 && text.startsWith(quote) && text.endsWith(quote)) {
				text = text.slice(1, -1).trim();
				peeled = true;
			}
		}
		if (!peeled) break;
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
	if (text === "/" ) return finding("block", "filesystem-root", "The target is the filesystem root");
	if (text === "~" || text === "$HOME" || text === "${HOME}") {
		return finding("block", "home-root", "The target is the home directory itself");
	}

	// 落点在删除目标上的兜底值：事故的直接成因。
	if (/\?\?|\|\||\$\{[A-Za-z_][A-Za-z0-9_]*:-/.test(text)) {
		return finding("confirm", "fallback-in-target", "The deletion target has a fallback value (a missing value falls back to a default path)");
	}

	// 算出来的目标：dirname / basename / 变量 / 命令替换。
	if (/\bdirname\b|\bbasename\b/.test(text) || hasExpansion(text)) {
		return finding(
			"confirm",
			"derived-target",
			"The deletion target is computed (variable / $(…) / dirname, etc.) and cannot be determined statically. Resolve and verify the exact path before deleting",
		);
	}

	const resolved = resolveLexical(text, cwd, home);
	if (resolved === "") {
		return finding("confirm", "derived-target", "The deletion target cannot be resolved statically (variable or command substitution); the exact path is unknown before execution");
	}

	const depth = componentCount(resolved);
	if (depth < 2) {
		return finding("block", "top-level", `Resolves to ${resolved}, with only ${depth} path components (top-level directories cannot be deletion targets)`, resolved);
	}

	if (resolved === home) {
		return finding("block", "home-root", "The target is the home directory itself", resolved);
	}

	for (const root of HARD_ROOTS) {
		if (root === "/") continue;
		if (resolved === root) {
			return finding("block", "protected-root", `The target is the protected root ${root}`, resolved);
		}
		if (root.startsWith(resolved + "/")) {
			return finding("block", "ancestor-of-protected", `${resolved} is an ancestor of the protected directory ${root}`, resolved);
		}
	}

	for (const tree of SYSTEM_TREES) {
		if (resolved === tree || resolved.startsWith(tree + "/")) {
			return finding("confirm", "system-tree", `${resolved} is inside the system directory ${tree}`, resolved);
		}
	}

	for (const dir of VCS_DIRS) {
		if (resolved === dir || resolved.endsWith("/" + dir)) {
			return finding("confirm", "vcs-store", `${resolved} is version-control storage; deleting it loses the only copy of history`, resolved);
		}
	}

	// 守卫自己：删掉它等于当场解除武装，所以是 block 而不是 confirm。
	const selfFinding = evaluateSelfProtection(resolved, home);
	if (selfFinding !== undefined) return finding("block", selfFinding.rule, selfFinding.reason, resolved);

	// AGENTS.md 的第三条断言：工作目录之外、且不是本会话创建的路径，先确认。
	// “本会话创建的”静态判不出来，临时目录是它唯一可靠的近似（见 TEMP_ROOTS）。
	// 只在 **主目录子树** 内触发：两次事故的全部损失面都在 `$HOME` 里，而
	// `/usr/local/bin/tsc` 这类包管理器地盘每次确认只是噪音（AGENTS.md 也明说它可删）。
	const outside = evaluateOutsideWorkdir(resolved, cwd, home);
	if (outside !== undefined) return finding("confirm", outside.rule, outside.reason, resolved);

	return undefined;
}

/** 解析后的路径是不是守卫自己（或定义守卫的那份纪律）。 */
function evaluateSelfProtection(resolved: string, home: string): { rule: string; reason: string } | undefined {
	for (const suffix of SELF_PROTECTED_SUFFIXES) {
		if (resolved.endsWith(suffix.replace(/\/$/, ""))) {
			return {
				rule: "self-protection",
				reason: `${resolved} is destructive-guard's own directory; deleting it disables this guard`,
			};
		}
	}

	const agentDir = `${home}/.pi/agent`;
	if (resolved === agentDir || resolved.startsWith(`${agentDir}/`)) {
		const rest = resolved.slice(agentDir.length);
		const basename = rest.split("/").filter(Boolean).at(-1) ?? "";
		if (SELF_PROTECTED_BASENAMES.includes(basename) && rest.split("/").filter(Boolean).length === 1) {
			return {
				rule: "self-protection",
				reason: `${resolved} is a global rules file used by destructive-guard; deleting it removes the policy source`,
			};
		}
		for (const subtree of SELF_PROTECTED_AGENT_SUBTREES) {
			if (rest === subtree || rest.startsWith(`${subtree}/`)) {
				return {
					rule: "self-protection",
					reason: `${resolved} is in Pi's agent directory${subtree}: it contains extensions, session records, and rewind snapshots; deletion destroys both safeguards and recovery data`,
				};
			}
		}
	}
	return undefined;
}

/** 解析后的路径是不是“工作目录之外、又不在临时目录里”。 */
function evaluateOutsideWorkdir(
	resolved: string,
	cwd: string,
	home: string,
): { rule: string; reason: string } | undefined {
	if (!isUnder(resolved, home)) return undefined;
	if (isUnder(resolved, cwd)) return undefined;
	if (TEMP_ROOTS.some((root) => isUnder(resolved, root))) return undefined;

	return {
		rule: "outside-workdir",
		reason:
			`${resolved} is outside the working directory (${cwd}); the full impact is not visible from here. ` +
			`Confirm the exact path before execution (AGENTS.md, Destructive actions, assertion 3)`,
	};
}

/** `child` 是不是 `parent` 本身或它的子路径（按已解析的绝对路径比）。 */
export function isUnder(child: string, parent: string): boolean {
	if (parent === "" || parent === "/") return false;
	const base = parent.replace(/\/+$/, "");
	return child === base || child.startsWith(`${base}/`);
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

		const unwrapped = unwrapCommand(expandQuotedWords(words));
		const head = unwrapped.head;
		const args = unwrapped.args;

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
 * 一条命令的完整判定结果：shell 侧的删除目标 + 文本侧的删除 API 调用。
 *
 * 两者必须一起看：`sh -c 'rm -rf $D'` 命中前者，`node -e 'fs.rmSync(dirname(x))'` 命中
 * 后者，而它们的危险程度相同。
 */
export interface CommandInspection {
	/** shell 侧（`rm` / `find -delete` / 内联代码里剥出来的子命令）。 */
	findings: Finding[];
	/** 文本侧（`fs.rmSync(…)` / `shutil.rmtree(…)` / 写进脚本的 `rm -rf $VAR`）。 */
	textFindings: WriteFinding[];
}

/**
 * 对一条 bash 命令做完整判定：命令本身 + 它即将交给解释器执行的内联代码 / heredoc 正文。
 *
 * 事故形态（`node -e 'fs.rmSync(path.dirname(x ?? "/tmp"))'`）不在命令词上，只有把内联
 * 代码当子命令递归判一次才能看见；深度限制避免恶意嵌套。
 */
export function inspectCommand(command: string, cwd: string, home: string, depth = 2): CommandInspection {
	const findings = inspectBash(command, cwd, home);
	const textFindings = inspectWrittenContent(command, {
		evaluateLiteral: (literal) => {
			const finding = evaluateTarget(literal, cwd, home);
			if (finding === undefined) return undefined;
			return { rule: finding.rule, reason: finding.reason, verdict: finding.verdict };
		},
	});

	if (depth <= 0) return { findings, textFindings };

	for (const run of [...extractInlineCode(command), ...extractStdinScript(command)]) {
		if (run.code.trim() === "") continue;
		const nested = inspectCommand(run.code, cwd, home, depth - 1);
		for (const finding of nested.findings) {
			if (finding.segment === undefined) finding.segment = `${run.interpreter} -c`;
			if (!findings.includes(finding)) findings.push(finding);
		}
		for (const finding of nested.textFindings) {
			// 去重带上 severity：外层“整条命令”的命中多半是 info 级（内联代码被 shell 引号包着），
			// 不能因此把递归出来的 confirm 级命中吞掉。
			const key = `${finding.line}\u0000${finding.rule}\u0000${finding.severity}`;
			if (!textFindings.some((prior) => `${prior.line}\u0000${prior.rule}\u0000${prior.severity}` === key)) {
				textFindings.push({ ...finding, reason: `[${run.interpreter} -c] ${finding.reason}` });
			}
		}
	}

	return { findings, textFindings };
}

/**
 * 丢掉**未提交工作**的 git 命令。
 *
 * 与路径删除不同，它们的目标不是文件系统上的某个路径，而是工作区/暂存区/stash 里
 * 只此一份的内容，所以单独成一个提取器（不硬塞进 target 模型）。
 *
 * 2026-09-23 第二次事故里，刚写好的“闸三”就是被一条 `git reset` 打回 HEAD 的 ——
 * 而当时的 `extractDeleteSites` 对它返回空数组，门禁连看都没看一眼。
 */
export function extractGitHistoryLoss(command: string): Finding[] {
	const findings: Finding[] = [];

	for (const segment of splitSegments(command)) {
		const words = splitWords(segment);
		if (words.length === 0) continue;
		const { head, args } = unwrapCommand(words);
		if (head !== "git") continue;

		const positional = args.filter((arg) => !arg.startsWith("-"));
		const sub = positional[0];
		if (sub === undefined) continue;

		const push = (rule: string, reason: string): void => {
			findings.push({ target: segment.trim(), resolved: "", verdict: "confirm", rule, reason, segment });
		};

		if (sub === "reset" && args.some((arg) => arg === "--hard")) {
			push(
				"vcs-history-loss",
				"git reset --hard discards all uncommitted working-tree and staged changes, which have no saved stash or commit",
			);
			continue;
		}

		// `git checkout -- <path>`：丢弃工作区改动。
		// 只认带 `--` 分隔符的形态 —— `git checkout <branch>` / `git checkout -b <branch>` 是
		// 切分支，不丢东西；`--` 是“后面是路径不是分支”的可靠信号。
		if (sub === "checkout" && args.includes("--")) {
			push("vcs-history-loss", "git checkout -- discards uncommitted working-tree changes that may have no other copy");
			continue;
		}

		if (sub === "restore") {
			push("vcs-history-loss", "git restore discards uncommitted working-tree/staged changes that may have no other copy");
			continue;
		}

		if (sub === "stash" && (positional[1] === "drop" || positional[1] === "clear")) {
			push("vcs-history-loss", `git stash ${positional[1]} discards stashed work; the stash may be its only copy`);
			continue;
		}

		if (sub === "branch" && args.some((arg) => /^-[a-zA-Z]*D/.test(arg) || arg === "--delete" || arg === "--force")) {
			push("vcs-history-loss", "git branch -D removes a branch with unmerged commits that may have no other reference");
			continue;
		}
	}
	return findings;
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
			if (finding) {
				finding.segment = site.segment;
				findings.push(finding);
			}
		}
	}
	findings.push(...extractGitHistoryLoss(command));
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
		// 命令/参数替换（`$(...)` / `${...}` / 反引号）整体算一个词。
		// 不这么做的话 `rm -rf $(dirname "$LOG")` 会被空格切成 `$(dirname` 和 `"$LOG")`
		// 两个碎片，弹框里就显示出不是路径的东西。
		if ((char === "$" && (segment[index + 1] === "(" || segment[index + 1] === "{")) || char === "`") {
			const end = scanSubstitution(segment, index);
			token += segment.slice(index, end);
			hasToken = true;
			index = end - 1;
			continue;
		}
		if (char === " " || char === "\t") {
			if (hasToken) words.push(token);
			token = "";
			hasToken = false;
			continue;
		}
		// `>` 之类不在这里处理：本模块只关心“删什么”，不关心重定向。
		token += char;
		hasToken = true;
	}
	if (hasToken) words.push(token);
	return words;
}

/**
 * 从 `start`（指向 `$(` / `${` / 反引号）扫到匹配的结束符之后，返回结束索引（exclusive）。
 * 引号感知、括号计数；扫不到匹配符就吃到串尾（宁可多并一个词，也不要切出碎片）。
 */
export function scanSubstitution(segment: string, start: number): number {
	const open = segment[start]!;
	if (open === "`") {
		for (let index = start + 1; index < segment.length; index += 1) {
			if (segment[index] === "\\") {
				index += 1;
				continue;
			}
			if (segment[index] === "`") return index + 1;
		}
		return segment.length;
	}
	const isParen = segment[start + 1] === "(";
	const openChar = isParen ? "(" : "{";
	const closeChar = isParen ? ")" : "}";
	let depth = 0;
	let quote: '"' | "'" | null = null;
	// 跳过前导 `$`。
	let index = segment[start] === "$" ? start + 1 : start;
	for (; index < segment.length; index += 1) {
		const char = segment[index]!;
		if (quote !== null) {
			if (char === "\\") {
				index += 1;
				continue;
			}
			if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === openChar) depth += 1;
		else if (char === closeChar) {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return segment.length;
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
