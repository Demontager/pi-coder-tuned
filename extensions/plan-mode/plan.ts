/**
 * plan-mode 的纯逻辑层：三态状态机 + plan 阶段的 bash 写操作判定。
 *
 * 不 import pi / pi-tui，所以 `node --test clients/pi/extensions/plan-mode/plan.test.ts`
 * 能直接跑到每个分支。
 *
 * ## 状态机
 *
 *   normal ──shift+tab / enter_plan_mode──▶ plan ──exit_plan_mode + 用户批准──▶ execute
 *     ▲                                     │                                    │
 *     └───────── 用户拒绝 / shift+tab ───────┘◀──── 步骤全部 [DONE:n] ────────────┘
 *
 * plan 阶段进入时对 `pi.getActiveTools()` 做一次快照，退出时**原样还原**：本机 pi 的
 * 工具表里有二十多个扩展动态注册的工具（mcp / ask_user_question / task_set / task_update …），
 * 硬编码白名单会把它们全吃掉（官方 plan-mode 示例就是那么写的，所以这里没照抄）。
 *
 * ## bash 判定
 *
 * 判定「这条命令会不会改工作区」，粒度是**简单命令** —— 用 `;` `&` `|` `&&` `||` `(` `)`
 * 和换行切开，所以 `cat a.txt && rm -rf b` 会被 rm 那一段拦住，而不是被 `cat` 那一段放过。
 * 识别四类写操作：
 *
 *   1. 写重定向：`>` / `>>`（`2> f` 的 fd 前缀不算参数、`2>&1` 这种 fd 复制不算写入）
 *   2. 写命令：rm / mv / cp / sed -i / tee / dd / git commit / npm install / sudo …
 *   3. 全局危险参数：`--fix` / `--write` / `--in-place`（eslint --fix、prettier --write …）
 *   4. heredoc 正文先剥掉再判，免得「读一个 heredoc」里顺带出现的一句写命令被误判
 *
 * **这是给配合的模型用的护栏，不是沙箱。** 模型被明确告知 plan 阶段不能改动代码，这里
 * 只负责拦下它顺手打出的写操作并把原因回给它（错误结果就是模型的反馈）。要真正防住
 * 恶意写入得靠操作系统级沙箱，不在这个扩展的范围内。两个已知的漏网形状：双引号内的
 * `$(...)` 命令替换、以及 `npm run <script>` 这类由脚本内容决定副作用的命令 —— 都是
 * 刻意放行的（宁可放行也不要把正常探索全部拦死）。
 */

// =============================================================================
// 工具集
// =============================================================================

/** pi 的写工具（`powershell` 是 bash 在 Windows 侧的等价物）。 */
export const WRITE_TOOLS = ["edit", "write", "powershell"] as const;

/**
 * plan 阶段的活动工具：摘掉写工具，**其余原样保留**。
 * 顺序与去重都保持 pi 自己的口径，避免把动态注册的工具漏掉或重复。
 */
export function planModeToolSet(activeTools: readonly string[]): string[] {
	const hidden = new Set<string>(WRITE_TOOLS);
	return [...new Set(activeTools.filter((name) => !hidden.has(name)))];
}

// =============================================================================
// 状态机
// =============================================================================

export type PlanPhase = "normal" | "plan" | "execute";

export interface PlanStep {
	/** 计划里的原序号，`[DONE:n]` 指的就是它。 */
	step: number;
	text: string;
	done: boolean;
}

export interface PlanState {
	phase: PlanPhase;
	/** plan 阶段：进入前的活动工具快照，退出时原样还原。 */
	toolsBeforePlan?: string[];
	/** execute 阶段：正在执行的步骤。 */
	steps: PlanStep[];
	/** plan 阶段：模型提交上来、等用户审批的步骤。 */
	pending?: PlanStep[];
}

export function initialPlanState(): PlanState {
	return { phase: "normal", steps: [] };
}

/** 进 plan 模式。已在 plan 里则原样返回（不覆盖工具快照）。 */
export function enterPlan(state: PlanState, activeTools: readonly string[]): PlanState {
	if (state.phase === "plan") return state;
	return {
		phase: "plan",
		toolsBeforePlan: [...activeTools],
		steps: [],
		pending: undefined,
	};
}

/** 退出 plan 模式回到 normal，工具快照随之清空（还原动作由调用方执行）。 */
export function cancelPlan(state: PlanState): PlanState {
	return {
		phase: "normal",
		steps: [],
		pending: state.pending,
	};
}

/** 模型通过 exit_plan_mode 提交计划，等用户审批。 */
export function submitPlan(state: PlanState, steps: readonly PlanStep[]): PlanState {
	if (state.phase !== "plan") return state;
	return { ...state, pending: [...steps] };
}

/** 用户批准：进 execute，待审批的步骤变成执行中的步骤。 */
export function approvePlan(state: PlanState): PlanState {
	if (state.phase !== "plan" || !state.pending || state.pending.length === 0) return state;
	return {
		phase: "execute",
		steps: state.pending.map((step) => ({ ...step })),
		pending: undefined,
	};
}

/**
 * 用户打回：**留在 plan**（不是回 normal），继续等模型改方案。
 * 工具快照与 pending 都留着 —— 下一轮 `exit_plan_mode` 覆盖 pending 即可。
 */
export function rejectPlan(state: PlanState): PlanState {
	if (state.phase !== "plan") return state;
	return { ...state, pending: undefined };
}

/** execute 阶段标记完成步骤；返回标记了几条（调用方据此决定要不要重绘）。 */
export function applyDoneSteps(state: PlanState, doneSteps: readonly number[]): number {
	if (state.phase !== "execute" || doneSteps.length === 0) return 0;
	const wanted = new Set(doneSteps);
	let marked = 0;
	for (const item of state.steps) {
		if (item.done || !wanted.has(item.step)) continue;
		item.done = true;
		marked += 1;
	}
	return marked;
}

export function isPlanComplete(state: PlanState): boolean {
	return state.phase === "execute" && state.steps.length > 0 && state.steps.every((step) => step.done);
}

export function countDoneSteps(state: PlanState): number {
	return state.steps.filter((step) => step.done).length;
}

/**
 * 退出 plan 时要还原的工具集：优先用进入时的快照，没有快照就退回当前活动工具
 * （`--tools` 在会话中途被改过时，尊重新的加载结果比还原旧快照更合理）。
 */
export function restoredToolSet(state: PlanState, activeTools: readonly string[]): string[] {
	return state.toolsBeforePlan ? [...state.toolsBeforePlan] : [...activeTools];
}

// =============================================================================
// bash 判定
// =============================================================================

export interface BashVerdict {
	ok: boolean;
	/** 被拒的原因，会作为工具错误结果回给模型。 */
	reason?: string;
}

/** 一个简单命令：命令词 + 参数，以及它写到磁盘的重定向目标。 */
interface SimpleCommand {
	words: string[];
	writes: string[];
}

/**
 * 写完磁盘的命令词。只列**明确会改工作区**的；`npm run` / `make` 这类副作用取决于
 * 脚本内容的命令刻意不列（见文件头注释的取舍说明）。
 */
const WRITE_COMMANDS = new Set([
	"rm",
	"rmdir",
	"mv",
	"cp",
	"install",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"chgrp",
	"ln",
	"tee",
	"truncate",
	"dd",
	"shred",
	"patch",
	"sudo",
	"doas",
	"su",
	"kill",
	"pkill",
	"killall",
	"reboot",
	"shutdown",
	"systemctl",
	"service",
	"launchctl",
	"vi",
	"vim",
	"nvim",
	"nano",
	"emacs",
	"code",
	"subl",
	"make",
]);

/** `git` 的写子命令；`git status/log/diff/show/branch -a` 等读操作不在表里。 */
const GIT_WRITE_SUBCOMMANDS = new Set([
	"add",
	"commit",
	"push",
	"pull",
	"merge",
	"rebase",
	"reset",
	"checkout",
	"switch",
	"restore",
	"stash",
	"clean",
	"cherry-pick",
	"revert",
	"tag",
	"init",
	"clone",
	"rm",
	"mv",
	"apply",
	"am",
	"gc",
	"prune",
	"update-ref",
	"symbolic-ref",
	"worktree",
	"submodule",
]);

/** 包管理器的写子命令。 */
const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "bun", "pip", "pip3", "poetry", "gem", "cargo", "go", "composer", "brew"]);
const PACKAGE_WRITE_SUBCOMMANDS = new Set([
	"install",
	"i",
	"add",
	"remove",
	"rm",
	"uninstall",
	"ci",
	"link",
	"publish",
	"update",
	"upgrade",
	"get",
	"dlv",
]);

/** 系统包管理器：几乎每个子命令都会改系统。 */
const SYSTEM_PACKAGE_MANAGERS = new Set(["apt", "apt-get", "dnf", "yum", "apk", "pacman", "port", "macports"]);

/** 任何命令带上这些参数都算写操作。 */
const WRITE_FLAGS = new Set(["--fix", "--write", "--in-place", "--replace"]);

/**
 * 写了也不算改工作区的目标：`cmd 2>/dev/null` 是模型的口头禅，拦它纯属噪音。
 * 只列真正的黑洞设备，任何真实路径（包括 `/tmp/x`）都不在内。
 */
const HARMLESS_WRITE_TARGETS = new Set([
	"/dev/null",
	"/dev/stderr",
	"/dev/stdout",
	"/dev/tty",
	"/dev/zero",
	"nul",
]);

/** 会被当作透明前缀跳过的包装命令（`sudo -u root rm -rf x` 的 `rm` 也要认出来）。 */
const WRAPPER_COMMANDS = new Set(["env", "command", "nohup", "time", "nice", "xargs", "builtin", "exec"]);

/**
 * 判断一条 bash 命令在 plan 阶段是否允许执行。
 * 返回 `{ ok: false, reason }` 时调用方应把 reason 作为工具错误结果回给模型。
 */
export function inspectBashCommand(command: string): BashVerdict {
	const scanned = stripHeredocBodies(command);
	for (const simple of splitSimpleCommands(scanned)) {
		const writes = simple.writes.filter((target) => !HARMLESS_WRITE_TARGETS.has(target));
		if (writes.length > 0) {
			return blocked(`重定向写入到 ${writes.map(quote).join(", ")}`);
		}
		const verdict = inspectSimpleCommand(simple);
		if (!verdict.ok) return verdict;
	}
	return { ok: true };
}

function inspectSimpleCommand(simple: SimpleCommand): BashVerdict {
	const { head, args } = unwrap(simple.words);
	if (!head) return { ok: true };

	for (const arg of args) {
		if (!WRITE_FLAGS.has(arg)) continue;
		return blocked(`命令 \`${head}\` 带写参数 ${arg}`);
	}

	if (WRITE_COMMANDS.has(head)) {
		if (head === "systemctl" || head === "service" || head === "launchctl") {
			const action = args.find((arg) => !arg.startsWith("-"));
			if (!action || action === "status" || action === "show" || action === "list-units" || action === "is-active") {
				return { ok: true };
			}
			return blocked(`命令 \`${head} ${action}\``);
		}
		// `make --dry-run` / `-n` 只打印要跑什么，不改任何东西
		if (head === "make" && args.some((arg) => arg === "--dry-run" || arg === "--just-print" || arg === "-n")) {
			return { ok: true };
		}
		return blocked(`命令 \`${head}\``);
	}

	if (head === "git") {
		const sub = args.find((arg) => !arg.startsWith("-"));
		if (!sub || !GIT_WRITE_SUBCOMMANDS.has(sub)) return { ok: true };
		// `git branch -a` / `git config --get` 是读操作，明确放行；没带这些开关的写子命令不在 git 的写表里。
		return blocked(`命令 \`git ${sub}\``);
	}

	if (PACKAGE_MANAGERS.has(head)) {
		const sub = args.find((arg) => !arg.startsWith("-"));
		if (!sub || !PACKAGE_WRITE_SUBCOMMANDS.has(sub)) return { ok: true };
		return blocked(`命令 \`${head} ${sub}\``);
	}

	if (SYSTEM_PACKAGE_MANAGERS.has(head)) return blocked(`命令 \`${head}\``);

	// `sed` / `perl` / `awk` 只在带原地编辑开关时算写
	if (head === "sed" || head === "perl") {
		if (args.some((arg) => arg === "-i" || arg.startsWith("-i.") || arg === "--in-place")) {
			return blocked(`命令 \`${head} -i\``);
		}
	}

	// `find … -delete` / `-exec rm` 这类写操作挂在参数上
	if (head === "find" && args.some((arg) => arg === "-delete" || arg === "-exec" || arg === "-execdir")) {
		return blocked("命令 `find` 带写动作（-delete / -exec）");
	}

	// `truncate` 之类已在上表；这里兜住 `>| file` 之外的少见形状不额外处理。

	return { ok: true };
}

/** 跳过 `FOO=bar` 赋值与 `env`/`sudo` 之类包装命令，拿到真正的命令词与它的参数。 */
function unwrap(words: readonly string[]): { head: string; args: string[] } {
	let index = 0;
	while (index < words.length) {
		const word = words[index]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPER_COMMANDS.has(word)) {
			index += 1;
			continue;
		}
		// 包装命令自己的开关（`nice -n 10 rm`）跳过
		if (word.startsWith("-")) {
			index += 1;
			continue;
		}
		break;
	}
	const head = words[index]?.split("/").pop() ?? "";
	return { head, args: words.slice(index + 1) };
}

function blocked(reason: string): BashVerdict {
	return { ok: false, reason: `plan 阶段不执行写操作：${reason}` };
}

function quote(text: string): string {
	return /[\s"'`$]/.test(text) ? `"${text}"` : text;
}

/**
 * 按 shell 的简单命令边界切开，并做引号 / 转义感知。
 *
 * 已知取舍：双引号内的 `$(...)` 命令替换被当成普通文本（不切开），因为常见的
 * `echo "…" > file` 里 `>` 在引号外、已经被写重定向那条规则拦住了，为了它把引号内
 * 也拆开只会引入更多误判。
 */
export function splitSimpleCommands(command: string): SimpleCommand[] {
	const segments: SimpleCommand[] = [];
	let words: string[] = [];
	let writes: string[] = [];
	let token = "";
	let hasToken = false;
	let quote: '"' | "'" | null = null;
	/** 刚扫到的重定向：下一个词是它的目标，不是普通参数。 */
	let redirect: "write" | "read" | "dup" | null = null;

	// 只有真的推出去一个词才清掉「等重定向目标」的状态：`>  out.txt` 这种
	// 运算符与目标之间有空格时，空格处的 pushToken() 不能把状态提前清掉。
	const pushToken = () => {
		if (!hasToken) return;
		if (redirect === "write") writes.push(token);
		else if (redirect === null) words.push(token);
		// read / dup 的目标既不是参数也不是写入
		token = "";
		hasToken = false;
		redirect = null;
	};

	const endSegment = () => {
		pushToken();
		if (words.length > 0 || writes.length > 0) segments.push({ words, writes });
		words = [];
		writes = [];
		redirect = null;
	};

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;

		if (quote === "'") {
			if (char === "'") quote = null;
			else token += char;
			continue;
		}
		if (quote === '"') {
			if (char === "\\") {
				const next = command[index + 1];
				if (next !== undefined && '"\\$`'.includes(next)) {
					token += next;
					index += 1;
				} else {
					token += char;
				}
			} else if (char === '"') {
				quote = null;
			} else {
				token += char;
			}
			continue;
		}

		if (char === "\\") {
			const next = command[index + 1];
			if (next !== undefined) {
				token += next;
				hasToken = true;
				index += 1;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			hasToken = true;
			continue;
		}
		if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")" || char === "\n") {
			endSegment();
			continue;
		}
		if (char === " " || char === "\t" || char === "\r") {
			pushToken();
			continue;
		}
		if (char === ">" || char === "<") {
			// `2> f` 的数字前缀是文件描述符，不是命令词
			if (hasToken && /^\d+$/.test(token)) {
				token = "";
				hasToken = false;
			}
			while (command[index + 1] === char) index += 1;
			const dup = command[index + 1] === "&";
			if (dup) index += 1;
			redirect = char === ">" ? (dup ? "dup" : "write") : dup ? "dup" : "read";
			continue;
		}

		token += char;
		hasToken = true;
	}
	endSegment();

	return segments;
}

/**
 * 把 heredoc 正文换成空行（保留行结构），免得「读一段脚本」里的写命令被当成真的要执行。
 * 找不到结束分隔符时**原样返回**：宁可保留正文继续扫（偏保守），也不要因为解析不全而漏判。
 */
export function stripHeredocBodies(command: string): string {
	const lines = command.split("\n");
	const kept: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const heredoc = findHeredoc(line);
		kept.push(line);
		if (!heredoc) continue;

		const { delimiter, stripTabs } = heredoc;
		let end = index + 1;
		for (; end < lines.length; end += 1) {
			const candidate = lines[end]!;
			const body = stripTabs ? candidate.replace(/^\t+/, "") : candidate;
			if (body.trimEnd() === delimiter) break;
			kept.push("");
		}
		if (end >= lines.length) return command; // 没有结束符：整段原样返回
		kept.push(lines[end]!);
		index = end;
	}

	return kept.join("\n");
}

/** 在一行里找 `<<DELIM` / `<<-DELIM` / `<<'DELIM'`，返回分隔符。 */
function findHeredoc(line: string): { delimiter: string; stripTabs: boolean } | undefined {
	let quote: '"' | "'" | null = null;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index]!;
		if (quote) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char !== "<" || line[index + 1] !== "<") continue;
		if (line[index + 2] === "<") {
			index += 2; // here-string：没有正文
			continue;
		}
		let cursor = index + 2;
		const stripTabs = line[cursor] === "-";
		if (stripTabs) cursor += 1;
		while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
		const delimiter = readDelimiter(line, cursor);
		if (delimiter) return { delimiter, stripTabs };
		index = cursor;
	}
	return undefined;
}

function readDelimiter(line: string, start: number): string | undefined {
	const quote = line[start];
	if (quote === "'" || quote === '"') {
		const end = line.indexOf(quote, start + 1);
		if (end === -1) return undefined;
		const value = line.slice(start + 1, end);
		return value.length > 0 ? value : undefined;
	}
	const match = /^[^\s;&|<>()]+/.exec(line.slice(start));
	return match ? match[0] : undefined;
}
