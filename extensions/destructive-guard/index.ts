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
 * ## 三道闸
 *
 * 1. **bash / powershell**：抽出删除目标，套 AGENTS.md 那套断言（少于两段路径 / 受保护
 *    根 / 受保护根的祖先 / 系统树 / VCS 存储根 / 兜底值与路径运算）。命令首部的包装
 *    （`sudo` / `env` / `nice` …）会被跳过去，命令里的**内联代码**（`node -e '…'` /
 *    `sh -c '…'` / `python3 -c '…'`）与**从 stdin 喂给解释器的 heredoc 正文**
 *    （`sh - <<EOF … EOF`）会被当子命令再判一次 —— 事故形态就在那里。
 * 2. **write / edit**：检查**要写进去的内容**里有没有上面的删除形态。事故的危险代码是
 *    更早写进文件的，“运行脚本”那一步看起来完全无害 —— Claude Code 的分类器有对应规则
 *    （`WRITTEN FILE EXECUTION`：写本身就是一次动作，按执行时判），这道闸是同一个意思。
 * 3. **运行脚本前**：`node verify-a.mjs` / `bash deploy.sh` / `./x.mjs` 这类命令，在执行
 *    前把**那个文件读进来**跑同一套检查。这是事故那一行的唯一有效拦截点 ——
 *    “运行一个脚本”在命令词上看不出任何危险，危险在文件内容里。
 *
 * ## 2026-09-23 第二次事故（同一天，给这个扩展加闸三的过程中）
 *
 * `~/.zshrc`、`~/.gitconfig`、`~/.zprofile`、`~/.pi/agent/sessions/` 全被删掉，而当时的
 * 两道闸对**每一个**被删目标都是放行：保护表只护“根”本身（`/`、`$HOME`、`/Users`），
 * 根**里面**的东西一律不拦；AGENTS.md 写了“工作目录之外要先确认”，代码里却从未实现
 * （`evaluateTarget` 收了 `cwd` 只用来拼相对路径）；`git reset --hard` 这类毁掉未提交
 * 工作的命令也不在认读范围里 —— 那次正是它把刚写好的闸三回滚掉了。
 *
 * 补的三处：`outside-workdir`（工作目录之外且不是临时目录 → confirm）、
 * `self-protection`（守卫自己的目录与全局规则文件 → block）、
 * `vcs-history-loss`（`git reset --hard` / `checkout --` / `restore` / `stash drop`）。
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
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
	evaluateTarget,
	expandQuotedWords,
	extractInlineCode,
	extractStdinScript,
	inspectBash,
	inspectCommand,
	splitSegments,
	splitWords,
	stripQuotes,
	unwrapCommand,
	type Finding,
} from "./targets.ts";
import { inspectWrittenContent, worstSeverity, type WriteFinding, type WriteSeverity } from "./writes.ts";

/** 运行模式。 */
type Mode = "on" | "off" | "block" | "notify";

/** 每次会话的统计，`/destructive-guard` 用。 */
interface Stats {
	checked: number;
	blocked: number;
	confirmed: number;
	allowed: number;
	notified: number;
	/** 用户选了“先预览要删什么”（也是一种拦下，但模型会先列清单）。 */
	previewed: number;
	/** 运行时检查（闸三）看过的脚本文件数。 */
	runtimeChecked: number;
	/** 想读但没读到的脚本文件（不存在 / 太大 / 不是字面路径）；只计数，不拦。 */
	runtimeSkipped: number;
	/** 只记录、没拦的命中（不可执行目标上的写入、引文）。 */
	noted: number;
}

/** 钩子返回值。 */
interface Verdict {
	block: true;
	reason: string;
}

/** 钩子上下文里本扩展用到的那一部分。 */
interface GuardContext {
	hasUI?: boolean;
	cwd?: string;
	ui: {
		notify: (text: string, level: string) => void;
		select: (prompt: string, options: string[]) => Promise<string>;
	};
}

/** 写类工具的参数名 → 内容字段。`edit` 用的是 old/new 两段。 */
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch"]);

/** 脚本文件的体积上限：超过就不读（避免把大文件拉进内存，也避免卡住工具调用）。 */
export const SCRIPT_READ_LIMIT_BYTES = 64 * 1024;

/** 解释器 → 它的“跑一个文件”形态。 */
const SCRIPT_INTERPRETERS = new Set([
	"node",
	"deno",
	"bun",
	"python",
	"python3",
	"ruby",
	"perl",
	"php",
	"bash",
	"sh",
	"zsh",
	"dash",
	"ksh",
]);

/** 直接可执行的脚本后缀（`./deploy.sh`）。 */
const EXECUTABLE_SCRIPT_SUFFIXES = [".sh", ".bash", ".zsh", ".mjs", ".cjs", ".js", ".py", ".rb", ".pl", ".php"];

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

/**
 * 把命中渲染成**给人看的弹框正文**：只留删除片段、解析出的具体路径、一句人话理由。
 *
 * 与 `renderFindings`（给模型看的、带 `[rule]` 标签）分开，因为两者受众不同：
 * 模型需要规则名去对应纪律，人只需要知道“要删什么、为什么拦我、我该怎么办”。
 *
 * `command` 是整条原始命令，只用来判断要不要额外给一行上下文：单段命令里
 * “所在命令”就是 `rm -rf <目标>` 本身，再说一遍只是噪声；链式命令（`&&` / `;` / `|`）
 * 里才需要告诉用户是哪一段。
 *
 * `limit` 是弹框高度的上限：pi 的 `ExtensionSelectorComponent` **不滚动**，而 pi-tui 只画
 * 文档的最后 `terminal.rows` 行 —— 弹框比终端高时**被切掉的是顶部**（标题和“要删什么”）。
 * 所以这里硬性限条数，剩下的归到一行“还有 N 处”。
 */
export function renderFindingsForHuman(findings: readonly Finding[], command = "", limit = 3): string {
	const seen = new Set<string>();
	const unique: Finding[] = [];
	for (const finding of findings) {
		// 同一目标只说一次（链式命令里可能重复命中）。
		const key = `${finding.target}\u0000${finding.resolved}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(finding);
	}
	if (unique.length === 0) return "";

	// 只有链式命令才值得多给一行上下文。
	const showSegment = splitSegments(command).length > 1;

	const shown = unique.slice(0, limit);
	const blocks = shown.map((finding) => {
		const lines: string[] = [];
		lines.push(`  要删：${truncateMiddle(finding.target, 100)}`);
		if (finding.resolved && finding.resolved !== finding.target) {
			lines.push(`  实际路径：${finding.resolved}`);
		}
		if (showSegment && finding.segment && finding.segment.trim() !== finding.target.trim()) {
			lines.push(`  所在命令：${truncateMiddle(finding.segment.trim(), 100)}`);
		}
		lines.push(`  为什么拦：${finding.reason}`);
		return lines.join("\n");
	});

	const rest = unique.length - shown.length;
	if (rest > 0) blocks.push(`  … 还有 ${rest} 处同类命中（选“取消”后让模型逐条列给你看）`);
	return blocks.join("\n\n");
}

/** 长命令中间省略，保留头尾（弹框里整条命令可能很长）。 */
export function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const keep = Math.max(8, Math.floor((max - 3) / 2));
	return `${text.slice(0, keep)} … ${text.slice(text.length - keep)}`;
}

/** 把写入侧的命中渲染成理由。 */
export function renderWriteFindings(findings: readonly WriteFinding[]): string {
	return findings
		.map((finding) => `  第 ${finding.line} 行 [${finding.rule}] ${finding.reason}\n    ${finding.text}`)
		.join("\n");
}

/** 写入侧命中的人话版：行号 + 那行代码 + 为什么拦。同样限条数（弹框不滚动）。 */
export function renderWriteFindingsForHuman(findings: readonly WriteFinding[], limit = 3): string {
	const shown = findings.slice(0, limit);
	const blocks = shown.map(
		(finding) => `  第 ${finding.line} 行：${truncateMiddle(finding.text.trim(), 100)}\n  为什么拦：${finding.reason}`,
	);
	const rest = findings.length - shown.length;
	if (rest > 0) blocks.push(`  … 还有 ${rest} 处同类命中`);
	return blocks.join("\n\n");
}

/**
 * 从一条 bash 命令里抽出“即将被当脚本跑的文件”。
 *
 * 三种形态：`node verify-a.mjs` / `python3 x.py`（解释器 + 文件）、`./deploy.sh`
 * （直接执行的脚本）、以及**内联代码里的**同名调用（`sh -c 'node a.mjs'`）。
 * 只认**字面路径**：变量拼出来的路径读不了，也不该猜。
 */
export function extractScriptTargets(command: string, depth = 2): string[] {
	const out: string[] = [];
	for (const segment of splitSegments(command)) {
		const words = expandQuotedWords(splitWords(segment));
		if (words.length === 0) continue;
		const { head, args } = unwrapCommand(words);
		const positional = args.filter((arg) => !arg.startsWith("-"));
		const first = positional[0];

		if (SCRIPT_INTERPRETERS.has(head)) {
			// `node -e '…'` 是内联代码（闸一管），不是文件
			const inline = args.some((arg) => ["-e", "--eval", "-c", "-p", "--print"].includes(arg));
			if (!inline && first !== undefined && first !== "-" && first !== "/dev/stdin") {
				const target = stripQuotes(first);
				if (!target.includes("$") && !target.includes("`")) out.push(target);
			}
			continue;
		}

		// `./x.sh` / `../x.py` / `/abs/path/x.mjs`：命令词本身就是脚本文件。
		// `unwrapCommand` 会把 `/x/y` 拍成 `y`，所以这里看第一个原始词。
		const rawHead = stripQuotes(words[0] ?? "");
		if (rawHead.startsWith("./") || rawHead.startsWith("../") || rawHead.startsWith("/")) {
			if (EXECUTABLE_SCRIPT_SUFFIXES.some((suffix) => rawHead.toLowerCase().endsWith(suffix))) {
				out.push(rawHead);
				continue;
			}
		}
	}

	// `sh -c 'node a.mjs'`：内联代码里还可能有脚本调用。
	if (depth > 0) {
		for (const run of [...extractInlineCode(command), ...extractStdinScript(command)]) {
			for (const nested of extractScriptTargets(run.code, depth - 1)) {
				if (!out.includes(nested)) out.push(nested);
			}
		}
	}
	return out;
}

/** 读一个即将被执行的脚本；读不到就返回 undefined（只计数，不拦）。 */
export function readScriptForInspection(target: string, cwd: string): { path: string; content: string } | undefined {
	try {
		const resolved = path.resolve(cwd, target);
		const stat = statSync(resolved);
		if (!stat.isFile() || stat.size > SCRIPT_READ_LIMIT_BYTES) return undefined;
		return { path: resolved, content: readFileSync(resolved, "utf8") };
	} catch {
		return undefined;
	}
}

/**
 * 闸一：删除类命令（含内联代码与 heredoc 正文）。
 *
 * 返回 `undefined` 表示放行，否则是拦下的钩子结果。
 */
async function checkBashCommand(
	command: string,
	cwd: string,
	home: string,
	ctx: GuardContext,
	stats: Stats,
	mode: Mode,
): Promise<Verdict | undefined> {
	const inspected = inspectCommand(command, cwd, home);
	const findings = inspected.findings;
	const textFindings = inspected.textFindings.filter((finding) => finding.severity !== "info");

	if (findings.length === 0 && textFindings.length === 0) {
		stats.checked += 1;
		stats.allowed += 1;
		return undefined;
	}

	stats.checked += 1;
	const hardest = worstTextSeverity(findings, textFindings);
	const body = [renderFindingsForHuman(findings, command), renderWriteFindingsForHuman(textFindings)]
		.filter((part) => part !== "")
		.join("\n\n");
	const rawBody = [renderFindings(findings), renderWriteFindings(textFindings)]
		.filter((part) => part !== "")
		.join("\n\n");

	if (mode === "notify") {
		stats.notified += 1;
		if (ctx.hasUI) ctx.ui.notify(`destructive-guard 本会拦下：\n${body}`, "warning");
		return undefined;
	}

	if (hardest === "block" || mode === "block") {
		stats.blocked += 1;
		return {
			block: true,
			reason:
				`destructive-guard 拦下了这条删除：\n${rawBody}\n\n` +
				`如果确实要删，请说明目标与理由，并改用能逐级确认的形式（先列出内容再删，或用可恢复的移动/改名）。`,
		};
	}

	// confirm：TUI 里问一次；非交互环境 fail closed。
	if (!ctx.hasUI) {
		stats.blocked += 1;
		return {
			block: true,
			reason: `destructive-guard 拦下了这条删除（当前环境无法向你确认，按 fail-closed 拒绝）：\n${rawBody}`,
		};
	}

	const choice = await ctx.ui.select(
		`⚠️ destructive-guard：这条命令里有删除动作，执行前需要你确认\n\n` +
			`${body}\n\n` +
			`选“取消”不会删任何东西；选“先预览”会让模型先把要删的内容列出来给你看。`,
		["取消", "先预览要删什么", "确认删除"],
	);
	if (choice === "确认删除") {
		stats.confirmed += 1;
		return undefined;
	}
	if (choice === "先预览要删什么") {
		stats.previewed += 1;
		return {
			block: true,
			reason:
				`destructive-guard：用户要求先预览。请不要直接执行这条删除，` +
				`先用只读命令（ls / find 不带 -delete / du / git clean -n）把将要删除的具体路径列出来给用户看，` +
				`得到确认后再改用字面路径执行。命中原因：\n${rawBody}`,
		};
	}
	stats.blocked += 1;
	return { block: true, reason: "destructive-guard：用户取消了这条删除。" };
}

/** shell 侧与文本侧合起来的最严一档。 */
function worstTextSeverity(findings: readonly Finding[], textFindings: readonly WriteFinding[]): "block" | "confirm" {
	if (findings.some((finding) => finding.verdict === "block")) return "block";
	if (worstSeverity(textFindings) === "block") return "block";
	return "confirm";
}

/**
 * 闸三：`node verify-a.mjs` / `bash deploy.sh` / `./x.mjs` 这类命令，执行前把文件读进来判一次。
 *
 * 返回 `undefined` 表示放行（没命中 / 只读到了 info 级），否则返回拦下的钩子结果。
 */
async function checkScriptTargets(
	command: string,
	cwd: string,
	home: string,
	ctx: GuardContext,
	stats: Stats,
	mode: Mode,
): Promise<Verdict | undefined> {
	const targets = extractScriptTargets(command);
	if (targets.length === 0) return undefined;

	for (const target of targets) {
		const script = readScriptForInspection(target, cwd);
		if (script === undefined) {
			// 读不到就放行（不存在 / 太大 / 不是文件）：这是护栏不是沙箱，
			// 对一个读不到的路径弹窗只会变成噪音。
			stats.runtimeSkipped += 1;
			continue;
		}
		stats.runtimeChecked += 1;

		const scriptDir = path.dirname(script.path);
		const textFindings = inspectWrittenContent(script.content, {
			targetPath: script.path,
			evaluateLiteral: (literal) => toLiteralVerdict(evaluateTarget(literal, scriptDir, home)),
		}).filter((finding) => finding.severity !== "info");
		const shellFindings = inspectBash(script.content, path.dirname(script.path), home);
		if (textFindings.length === 0 && shellFindings.length === 0) continue;

		const hardest = worstTextSeverity(shellFindings, textFindings);
		const body = [renderFindingsForHuman(shellFindings, command, 2), renderWriteFindingsForHuman(textFindings, 2)]
			.filter((part) => part !== "")
			.join("\n\n");
		const rawBody = [renderFindings(shellFindings), renderWriteFindings(textFindings)]
			.filter((part) => part !== "")
			.join("\n\n");

		if (mode === "notify") {
			stats.notified += 1;
			if (ctx.hasUI) ctx.ui.notify(`destructive-guard 本会拦下即将运行的脚本 ${script.path}：\n${body}`, "warning");
			continue;
		}

		if (hardest === "block" || mode === "block" || !ctx.hasUI) {
			stats.blocked += 1;
			return {
				block: true,
				reason:
					`destructive-guard 拦下了即将运行的脚本 ${script.path}：它里面有危险的删除调用。\n${rawBody}\n\n` +
					`请先把目标改成字面路径、核对解析后的绝对路径，再运行。`,
			};
		}

		const choice = await ctx.ui.select(
			`⚠️ destructive-guard：即将运行的脚本里有危险的删除调用\n\n` +
				`文件：${script.path}\n\n${body}\n\n` +
				`这是 2026-09-23 事故的形态（危险代码早写进脚本，运行那一步看起来无害）。`,
			["取消", "确认运行"],
		);
		if (choice !== "确认运行") {
			stats.blocked += 1;
			return { block: true, reason: `destructive-guard：用户取消了运行 ${script.path}。` };
		}
		stats.confirmed += 1;
	}
	return undefined;
}

/** 把闸一的判定结果转成写入侧注入器要的形状。 */
function toLiteralVerdict(finding: Finding | undefined): { rule: string; reason: string; verdict: "block" | "confirm" } | undefined {
	if (finding === undefined) return undefined;
	return { rule: finding.rule, reason: finding.reason, verdict: finding.verdict };
}

export default function (pi: ExtensionAPI) {
	let mode = readMode();
	const stats: Stats = {
		checked: 0,
		blocked: 0,
		confirmed: 0,
		allowed: 0,
		notified: 0,
		previewed: 0,
		runtimeChecked: 0,
		runtimeSkipped: 0,
		noted: 0,
	};

	pi.registerCommand("destructive-guard", {
		description: "Show destructive-guard status and what it has caught this session",
		handler: async (_args, ctx) => {
			const lines = [
				`模式：${mode}${mode === "notify" ? "（只通知，不拦）" : ""}${mode === "block" ? "（confirm 也直接拒）" : ""}`,
				`本会话检查过 ${stats.checked} 次删除动作`,
				`拒绝 ${stats.blocked} · 要求先预览 ${stats.previewed} · 确认后放行 ${stats.confirmed} · 放行 ${stats.allowed} · 仅通知 ${stats.notified}`,
				`运行前审过的脚本 ${stats.runtimeChecked} 个 · 读不到而跳过 ${stats.runtimeSkipped} 个 · 只记录未拦 ${stats.noted} 处`,
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

		// pi 给的 cwd 比 `process.cwd()` 准（工具调用随会话/子代理走）。
		const cwd = ctx.cwd ?? process.cwd();
		const home = homedir();
		const guardCtx: GuardContext = { hasUI: ctx.hasUI, cwd, ui: ctx.ui };

		// ---- 闸一：删除类命令（含内联代码与 heredoc 正文） ----
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = typeof event.input?.command === "string" ? event.input.command : "";
			if (command !== "") {
				const verdict = await checkBashCommand(command, cwd, home, guardCtx, stats, mode);
				if (verdict !== undefined) return verdict;
			}
		}

		// ---- 闸三：即将被执行的脚本文件 ----
		// `node verify-a.mjs` 在命令词上看不出任何危险，危险在文件内容里。
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = typeof event.input?.command === "string" ? event.input.command : "";
			if (command !== "") {
				const verdict = await checkScriptTargets(command, cwd, home, guardCtx, stats, mode);
				if (verdict !== undefined) return verdict;
			}
		}

		// ---- 闸二：写入内容里的删除代码 ----
		if (!WRITE_TOOLS.has(event.toolName)) return undefined;

		const blocks = contentFields(event.input);
		if (blocks.length === 0) return undefined;

		const targetPath = writeTargetPath(event.input);
		const all = blocks.flatMap((block) =>
			inspectWrittenContent(block, {
				targetPath,
				evaluateLiteral: (literal) =>
					toLiteralVerdict(
						evaluateTarget(literal, targetPath === undefined ? cwd : path.dirname(path.resolve(cwd, targetPath)), home),
					),
			}),
		);
		if (all.length === 0) return undefined;

		// 不可执行目标（`.md` / `.html` …）上的命中只记录：写进去的散文不会跑。
		const findings = all.filter((finding) => finding.severity !== "info");
		if (findings.length === 0) {
			stats.noted += 1;
			return undefined;
		}

		stats.checked += 1;

		if (mode === "notify") {
			stats.notified += 1;
			if (ctx.hasUI) ctx.ui.notify(`destructive-guard 本会拦下这段写入：\n${renderWriteFindingsForHuman(findings)}`, "warning");
			return undefined;
		}

		if (worstSeverity(findings) === "block" || mode === "block" || !ctx.hasUI) {
			stats.blocked += 1;
			const why = [
				"destructive-guard 拦下了写入：这段代码里的删除调用有危险形态。",
				renderWriteFindings(findings),
				"",
				"这不是“不许删文件”，而是这几个写法本身就会算错目标（" +
					"2026-09-23 的一次事故正是 fs.rmSync(path.dirname(x ?? \"/tmp\")) " +
					"退化成 rm -rf /）。",
				"请改成：字面目标 + 删除前核对解析后的绝对路径 + 命中保护表就中止。",
			].join("\n");
			return { block: true, reason: why };
		}

		const choice = await ctx.ui.select(
			`⚠️ destructive-guard：要写进${writeTargetLabel(event.input)}的代码里有危险的删除调用\n\n` +
				`${renderWriteFindingsForHuman(findings)}\n\n` +
				`这不是“不许删文件”，而是这几个写法本身就会算错目标（事故里就是 dirname(x ?? "/tmp") 退化成 rm -rf /）。`,
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

/** 写入目标的展示名（弹框里告诉用户是哪个文件）。 */
export function writeTargetLabel(input: unknown): string {
	if (typeof input !== "object" || input === null) return "文件";
	const record = input as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath", "filename"]) {
		const value = record[key];
		if (typeof value === "string" && value !== "") return ` ${value}`;
	}
	return "文件";
}

/** 写入目标路径（判“不可执行目标”用）。取不到就返回 undefined。 */
export function writeTargetPath(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath", "filename"]) {
		const value = record[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return undefined;
}
