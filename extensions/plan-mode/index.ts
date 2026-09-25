/**
 * pi-plan-mode — Claude Code 风格的 plan mode。
 *
 * 两态：bypass → plan（只读探索，模型出方案）。与 Claude Code 对齐：
 *
 *   - `exit_plan_mode` 的参数是**一份完整方案文本**（cc 的 `ExitPlanMode(plan)` 同形），
 *     不是一串结构化步骤。
 *   - 批准后**没有 execute 态**：扩展把方案落成计划文档（`.pi/plans/`，模型自己 write），
 *     写完即回 bypass、还原写权限，「按文档实施」是一次性交给模型的指令。进度也交还
 *     模型 —— 它认为该建任务清单就自己 `task_set`，扩展不再镜像步骤、不再记进度。
 *
 * ## 审批对话框（三选一）
 *
 *   写计划文档并实施   模型把方案写成 .pi/plans/<日期>-<slug>.md，写完自动收尾进实施
 *   只写计划文档       同上，但收尾指令是「报告路径就停，不要动手」
 *   打回               留在 plan 态，等用户反馈后重新提交
 *
 * 两条批准路线都经过**写文档子态**（`docWriting`，phase 仍是 plan）：`write` 被单独放回
 * 工具表，但 `tool_call` 钩子把它限死在计划文档那一个路径；`tool_result` 钩子看到这次
 * write 成功就自动收尾（不需要模型再调一次 exit_plan_mode）。
 *
 * ## 入口
 *
 *   shift+tab      切模式（正常 ⇄ plan）。pi 把它留给了内置的 app.thinking.cycle，
 *                  扩展抢不到（runner 会 skip 与内置冲突的 registerShortcut），所以
 *                  走 ctx.ui.onTerminalInput 在按键到达编辑器**之前**拦下并 consume。
 *                  代价是思考等级循环键被吃掉，本扩展首次启动时会把
 *                  ~/.pi/agent/keybindings.json 里的 app.thinking.cycle 改绑到 ctrl+shift+t
 *                  （只在该键仍是 pi 默认值时改；用户自己配过就尊重用户的选择）。
 *   /plan          手动切（等价于 shift+tab）
 *   /plan-status   看当前状态
 *   --plan         启动即进 plan mode
 *   自动进入       注册 enter_plan_mode 工具 —— 模型判断任务偏大时自己调用，
 *                  这就是 Claude Code 的机制（不是关键词启发式）。路由判据全在这个
 *                  工具的描述里（CC 同构：它的系统提示词里一句 plan 规则都没有），
 *                  全局 AGENTS.md 只留一条指针。模型路径还要过一道**用户同意弹框**
 *                  （CC 的 “must consent to entering plan mode”）：用户可以选「直接实施」
 *                  否掉，所以判据可以写松 —— 误判的代价是用户按一次键，不是白做一轮。
 *                  PI_PLAN_MODE_CONSENT=off 关掉这道弹框。
 *
 * ## 约束（收工具 + 拦 bash，两道独立的闸）
 *
 *   1. 工具集：进 plan 时把 edit / write / powershell 从活动工具里摘掉，退出时按
 *      进入前的快照**原样还原**。本机 pi 的工具表里有二十多个扩展动态注册的工具，
 *      硬编码白名单会把它们全吃掉，所以快照-还原是唯一安全的做法。写文档子态单独
 *      放回 write（`planModeToolSet(active, true)`）。
 *   2. tool_call 钩子：写类 bash（重定向 / rm / git commit / npm install …）不管在不在
 *      工具表里都被拦；写文档子态里 write 只许写计划文档那一个路径。拒绝原因作为
 *      工具错误结果回给模型。判定细节见 plan.ts。
 *
 * 这是给配合的模型用的护栏，不是沙箱 —— 见 plan.ts 文件头的取舍说明。
 *
 * ## 计划落地
 *
 * 状态存 `pi.appendEntry("plan-mode")`（不进模型上下文）；计划文档写进工作区的
 * `.pi/plans/`（被 .gitignore 排除 —— 计划是过程产物）。除此之外工作区不会多出任何东西。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	type PlanDocMode,
	type PlanState,
	cancelPlan,
	completeDocWrite,
	enterDocWriting,
	enterPlan,
	initialPlanState,
	inspectBashCommand,
	planModeToolSet,
	rejectPlan,
	restoredToolSet,
	submitPlan,
} from "./plan.ts";
import {
	buildDocWriteContext,
	buildDocWrittenMessage,
	buildPlanModeContext,
	buildRejectedMessage,
	truncatePlanForDialog,
} from "./plan-text.ts";
import { buildPlanDocPath } from "./plan-doc.ts";
import { STATUS_KEY, formatPlanStatus } from "./render.ts";
import { THINKING_FALLBACK_KEY, keybindingsPath, rebindThinkingKey } from "./keybinding.ts";

/** 关掉整个扩展。 */
const DISABLED = (process.env.PI_PLAN_MODE ?? "").trim().toLowerCase() === "off";
/** 只关自动进入（shift+tab 与 /plan 仍可用）。 */
const AUTO_DISABLED = (process.env.PI_PLAN_MODE_AUTO ?? "").trim().toLowerCase() === "off";
/** 关掉模型自动进入前的同意弹框（回到「调了就直接进」）。 */
const CONSENT_DISABLED = (process.env.PI_PLAN_MODE_CONSENT ?? "").trim().toLowerCase() === "off";

const ENTER_TOOL = "enter_plan_mode";
const EXIT_TOOL = "exit_plan_mode";
/** 会话里持久化状态的 custom entry 类型。 */
const ENTRY_TYPE = "plan-mode";

/** 审批对话框的三个选项（顺序即默认选中顺序：第一项是推荐路线）。 */
const CHOICE_EXECUTE = "Write plan and implement";
const CHOICE_DOC_ONLY = "Write plan only";
const CHOICE_REJECT = "Request changes";

/**
 * 同意弹框的两个选项（第一项是默认选中项 = 接受模型的请求）。
 *
 * 这是 Claude Code 的机制：它的 `EnterPlanMode` 是 `shouldDefer: true`，描述里明写
 * “This tool REQUIRES user approval - they must consent to entering plan mode”，弹框是
 * `Yes, enter plan mode` / `No, start implementing now`。正因为每次进入都要用户点头，
 * CC 才敢把判据写松（还留了 “err on the side of planning”）—— 误判的代价被弹框吸收了。
 * 没有这道弹框时，判据一松就直接变成打扰（实测 15.5% 的用户指令进了 plan）。
 */
const CONSENT_PLAN = "Enter plan mode (read-only exploration)";
const CONSENT_IMPL = "Implement directly";

/**
 * `enter_plan_mode` 的工具描述 = 全部路由判据。
 *
 * 判据只写在这里，全局 AGENTS.md 只留一条指针（Claude Code 同构：它的系统提示词里
 * 一句 plan 规则都没有，7 条正面条件 + 4 条豁免 + GOOD/BAD 示例全在工具描述里）。
 * 这样判据在模型决定要不要调这个工具的那一刻正好在眼前，而且不会与 AGENTS.md 漂移。
 * 结构照 CC：什么时候用（7 条）/ 什么时候不用（4 条豁免）/ 例子 / 注意。
 */
const ENTER_TOOL_DESCRIPTION = `Enter plan mode (read-only exploration): explain the design, wait for approval, then implement.

## When to use
Use for nontrivial implementation work involving any of:
1. Meaningful new features whose placement, behavior, or error handling is undecided.
2. Multiple substantially different approaches (Redis/memory/file caching; WS/SSE/polling).
3. Changes to existing behavior or structure with an undecided target design.
4. Architectural or technology tradeoffs.
5. Changes across more than 2-3 files.
6. Unclear requirements requiring exploration, profiling, or root-cause analysis.
7. User preferences determining the approach: enter plan mode first, explore, then ask informed questions.

## When not to use
Skip for small one/two-line fixes, a well-specified single function, detailed unambiguous user instructions, or pure research/exploration/review producing conclusions rather than changes.

## Examples
Use for authentication, database optimization, dark themes, or adding a profile deletion button that needs UI/API/error-handling decisions. Skip for README typos, a console.log, or identifying routing files.

## Notes
- Requires user consent. The dialog allows Implement directly instead.
- User-initiated shift+tab, /plan, or --plan needs no further consent.
- If brainstorming has not happened, read the brainstorming skill's SKILL.md from the available-skills list and follow it: clarify requirements and present 2-3 options with tradeoffs. In plan mode, do not write docs/superpowers/specs/ or commit: writes are blocked. exit_plan_mode submits the design and saves the approved plan under .pi/plans/. Use ask_user_question for clarification.`;

interface PersistedState {
	phase: PlanState["phase"];
	pending?: string;
	toolsBeforePlan?: string[];
	docMode?: PlanDocMode;
	docWriting?: boolean;
	pendingDocPath?: string;
	planSummary?: string;
}

/**
 * 把落盘条目里的 phase 收敛到当前联合类型，认不出的一律当 `"bypass"`。
 *
 * 白名单式判定兜住一切历史值：2026-09-23 的 `normal` → `bypass` 改名、2026-09-24 删掉
 * 的 `execute` 态（旧会话恢复出来当 bypass —— 那次批准没有留下任何扩展持有的状态，
 * 直接放行不会丢东西）。
 */
function normalizePhase(value: unknown): PlanState["phase"] {
	return value === "plan" ? "plan" : "bypass";
}

/** 落盘条目里的 docMode 同样白名单式收敛：认不出的当没选过。 */
function normalizeDocMode(value: unknown): PlanDocMode | undefined {
	return value === "execute-with-doc" || value === "doc-only" ? value : undefined;
}

/** 落盘条目里的 pending：2026-09-24 之前是步骤数组，现在只认字符串（旧计划丢弃）。 */
function normalizePending(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export default function planMode(pi: ExtensionAPI) {
	if (DISABLED) return;

	const state: PlanState = initialPlanState();
	/** 最近一次 ctx：onTerminalInput 回调拿不到 ctx，而 shift+tab 需要它。 */
	let currentCtx: ExtensionContext | undefined;
	/** 会话替换（/clear、/new、/resume）期间旧 ctx 会失效；渲染失败一律吞掉。 */
	let restoreInProgress = false;
	/** pi 自己的弹窗打开时不要抢键，交给弹窗。 */
	let dialogOpen = false;
	let thinkingKeyChecked = false;
	/** shift+tab 的原始输入监听器退订函数（防重入用，见 attachInputListener）。 */
	let inputUnsubscribe: (() => void) | null = null;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// =========================================================================
	// 渲染
	// =========================================================================

	function render(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, formatPlanStatus(ctx.ui.theme, state));
		} catch {
			// 会话替换窗口里 ctx 可能已被 pi 作废。渲染是尽力而为，绝不能让它打死进程
			// （本机 user-message-bar 扩展踩过同一个坑，代价是 pi 直接退出）。
		}
	}

	// =========================================================================
	// 持久化（只在会话条目里）
	// =========================================================================

	function persist(): void {
		const payload: PersistedState = {
			phase: state.phase,
			pending: state.pending,
			toolsBeforePlan: state.toolsBeforePlan,
			docMode: state.docMode,
			docWriting: state.docWriting,
			pendingDocPath: state.pendingDocPath,
			planSummary: state.planSummary,
		};
		pi.appendEntry(ENTRY_TYPE, payload);
	}

	/**
	 * 只认当前分支上的最新记录。
	 *
	 * 用 getBranch() 而不是 getEntries()：后者返回**全量**条目（`session-manager.js` 的
	 * `fileEntries.filter(...)`），包含 rewind / fork / 分支导航之后被丢弃的分支 —— 用它
	 * 会让一条已经不上分支的计划在下次启动时复活。pi 的 docs/extensions.md 也要求用
	 * getBranch() 重建分支敏感状态。
	 */
	function restore(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getBranch();
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index] as { type?: string; customType?: string; data?: PersistedState };
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !entry.data) continue;
			state.phase = normalizePhase(entry.data.phase);
			state.pending = normalizePending(entry.data.pending);
			state.toolsBeforePlan = entry.data.toolsBeforePlan;
			state.docMode = normalizeDocMode(entry.data.docMode);
			state.docWriting = entry.data.docWriting === true ? true : undefined;
			state.pendingDocPath = typeof entry.data.pendingDocPath === "string" ? entry.data.pendingDocPath : undefined;
			state.planSummary = typeof entry.data.planSummary === "string" ? entry.data.planSummary : undefined;
			break;
		}
		// plan 态恢复后工具表要跟着收回去（工具集本身不进会话条目，按当前表重算）。
		// 写文档子态里 write 要在场。
		if (state.phase === "plan") {
			if (!state.toolsBeforePlan) state.toolsBeforePlan = pi.getActiveTools();
			pi.setActiveTools(planToolSet(state.toolsBeforePlan, state.docWriting === true));
		}
	}

	// =========================================================================
	// 状态迁移
	// =========================================================================

	/**
	 * plan 阶段的活动工具：pi 的写工具 + 已经没用的 enter_plan_mode 都摘掉。
	 * `allowWrite` 是写文档子态的开关：单独放回 write（路径仍被 tool_call 钩子限死）。
	 */
	function planToolSet(active: readonly string[], allowWrite = false): string[] {
		return planModeToolSet(active, allowWrite).filter((name) => name !== ENTER_TOOL);
	}

	function enter(ctx: ExtensionContext | undefined, reason: "user" | "model"): void {
		if (state.phase === "plan") return;
		// 快照必须取在摘工具**之前** —— 退出时靠它原样还原（含二十多个扩展工具）
		const before = pi.getActiveTools();
		Object.assign(state, enterPlan(state, before));
		pi.setActiveTools(planToolSet(before));
		persist();
		render(ctx);
		if (ctx?.hasUI) {
			ctx.ui.notify(
				reason === "model"
					? "Entered plan mode (read-only) because this task needs planning. Press shift+tab to exit anytime."
					: "Entered plan mode: read-only exploration; the model will propose a design first. Toggle with shift+tab.",
				"info",
			);
		}
	}

	function leave(ctx: ExtensionContext | undefined, notify = true): void {
		const tools = restoredToolSet(state, pi.getActiveTools());
		Object.assign(state, cancelPlan(state));
		pi.setActiveTools(tools);
		persist();
		render(ctx);
		if (notify && ctx?.hasUI) ctx.ui.notify("Exited plan mode; write access restored.", "info");
	}

	function toggle(ctx: ExtensionContext | undefined): void {
		if (state.phase === "bypass") enter(ctx, "user");
		else leave(ctx);
	}

	// =========================================================================
	// shift+tab 抢键
	// =========================================================================

	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		dialogOpen = false;
		restoreInProgress = true;
		try {
			restore(ctx);
		} finally {
			restoreInProgress = false;
		}
		attachInputListener(ctx);

		if (pi.getFlag("plan") === true && state.phase !== "plan") enter(ctx, "user");
		render(ctx);

		if (!thinkingKeyChecked && (event.reason === "startup" || event.reason === "reload")) {
			thinkingKeyChecked = true;
			ensureThinkingKeyRebound(ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		currentCtx = undefined;
		inputUnsubscribe?.();
		inputUnsubscribe = null;
	});

	/**
	 * shift+tab 在到达编辑器**之前**被这里拦下。
	 *
	 * 只在「TUI + 空闲 + 没有扩展弹窗 + 不在会话切换窗口」时 consume：pi 的 picker
	 * （/model、/sessions 等）自己也吃 shift+tab，抢它会让人在弹窗里切不动选项。
	 * 忙碌时（流式中）不抢，让 pi 的思考等级循环照常工作 —— 这是刻意的：plan mode
	 * 只在你停下来的时候才切。
	 *
	 * 防重入很重要：`session_start` 会在 `/reload`、`/new`、`/resume` 时各跑一次，
	 * 每跑一次就多注册一个监听器的话，一次 shift+tab 会被切两次（等于没切）。
	 * pi 换会话时会 `clearExtensionTerminalInputListeners()` 清掉旧的，但 `/reload`
	 * 不保证清干净 —— 所以这里自己先退订上一次。
	 */
	function attachInputListener(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		inputUnsubscribe?.();
		inputUnsubscribe = null;
			try {
			inputUnsubscribe = ctx.ui.onTerminalInput((data) => {
				// 必须用 pi 自己的 matchesKey，**不能**手写 `data !== "\x1b[Z"`：
				// shift+tab 有三种编码 —— 裸 CSI（`\x1b[Z`）、Kitty 键盘协议的 CSI-u
				// （`\x1b[9;2u` 之类）与 xterm modifyOtherKeys。pi 启动时会主动启用
				// Kitty 协议（`terminal.js` 发 `\x1b[>{flags}u\x1b[?u\x1b[c` 并等回复），
				// 一旦启用，真实终端发的就不再是 `\x1b[Z` —— 硬编码比对会完全失效
				// （实测踩到：pty 里能切、真实 Ghostty 里按 shift+tab 没反应）。
				if (!matchesKey(data, "shift+tab")) return undefined;
				const current = currentCtx;
				if (!current || current.mode !== "tui") return undefined;
				if (dialogOpen || restoreInProgress) return undefined;
				if (!current.isIdle()) return undefined;
				toggle(current);
				return { consume: true };
			});
		} catch {
			// 宿主没有原始输入通道：shift+tab 不可用，/plan 仍然可用
		}
	}

	pi.on("ui_prompt_start", async () => {
		dialogOpen = true;
	});
	pi.on("ui_prompt_end", async () => {
		dialogOpen = false;
	});

	// =========================================================================
	// 命令
	// =========================================================================

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration → approval → write plan document)",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			toggle(ctx);
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show plan mode status",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			if (state.phase === "bypass") {
				ctx.ui.notify("plan mode: bypass (inactive)", "info");
				return;
			}
			const lines: string[] = [];
			if (state.docWriting) {
				lines.push(`plan mode: plan (writing document)`);
				lines.push(`Target document: ${state.pendingDocPath ?? "(path unavailable)"}`);
			} else {
				lines.push("plan mode: plan (read-only exploration)");
			}
			if (state.pending) {
				const first = state.pending.split("\n").find((line) => line.trim() !== "") ?? "";
				lines.push(`Plan awaiting approval: ${first.trim().slice(0, 60)} (total: ${state.pending.split("\n").length} lines)`);
			}
			if (state.planSummary) lines.push(`Summary: ${state.planSummary}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// =========================================================================
	// 自动进入：模型工具
	// =========================================================================

	if (!AUTO_DISABLED) {
		pi.registerTool({
			name: ENTER_TOOL,
			label: "Enter Plan Mode",
			description: ENTER_TOOL_DESCRIPTION,
			parameters: Type.Object({
				reason: Type.Optional(Type.String({ description: "Why this task needs planning first (one sentence)" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				currentCtx = ctx;
				const reason = typeof params.reason === "string" && params.reason.trim() !== "" ? params.reason.trim() : "";
				// 同意弹框只在模型路径：shift+tab / /plan / --plan 走 enter(ctx, "user")，
				// 那已经是用户自己的决定，再问一次是纯打扰。无 UI（pi -p）没有人会被打扰，
				// 也不弹 —— 保持既有 headless 行为。
				if (ctx.hasUI && !CONSENT_DISABLED) {
					const choice = await ctx.ui.select(
						`The model requests plan mode (read-only exploration).${reason ? `

Reason: ${reason}` : ""}\n\n` +
							`${CONSENT_PLAN}: explore read-only and propose a design; implementation starts only after your approval
` +
							`${CONSENT_IMPL}: skip planning and implement your instructions now`,
						[CONSENT_PLAN, CONSENT_IMPL],
					);
					// esc（undefined）当作否决，与 CC 的 “must consent” 一致 ——
					// 「嫌烦想跳过」这条最常见路径只需一个键。
					if (choice !== CONSENT_PLAN) {
						ctx.ui.notify("Skipped plan mode; implementing directly.", "info");
						return {
							content: [
								{
									type: "text",
									text: `The user chose direct implementation, without entering plan mode. Follow the user's instructions now; do not call again: ${ENTER_TOOL}。`,
								},
							],
							details: { phase: state.phase, consented: false },
						};
					}
				}
				enter(ctx, "model");
				return {
					content: [
						{
							type: "text",
							text: `Entered plan mode (read-only). ${reason ? `Reason: ${reason}。` : ""}
edit / write are disabled; Bash writes are blocked. Read the code first; use ask_user_question for decisions that need user input. When the design is ready, call ${EXIT_TOOL} to submit.`,
						},
					],
					details: { phase: state.phase, consented: true },
				};
			},
		});
	}

	// plan 阶段唯一的出口：提交计划给用户审批
	pi.registerTool({
		name: EXIT_TOOL,
		label: "Submit Plan",
		description:
			"Submit the design for user approval in plan mode. Do not modify files before calling. The user can approve implementation or request further planning.",
		parameters: Type.Object({
			plan: Type.String({
				description:
					"Complete user-facing design (Markdown): problem, current state and constraints, planned files and changes, and verification. Do not provide only step headings.",
			}),
			slug: Type.String({
				description:
					"Plan filename slug: 3-5 lowercase English words, digits, and hyphens, e.g. m5-entity-runtime or plan-doc-english-slug. Avoid Chinese, spaces, and punctuation; they are stripped, with plan as fallback. Filename: <date>-<slug>.md.",
			}),
			summary: Type.Optional(Type.String({ description: "One-sentence design summary" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;
			if (state.phase !== "plan") {
				return {
					content: [{ type: "text", text: `Not in plan mode (current: ${state.phase}); no plan submission is needed.` }],
					details: { accepted: false, phase: state.phase },
				};
			}
			if (state.docWriting) {
				return {
					content: [
						{
							type: "text",
							text: `Currently writing the plan document: use the write tool to save it to \`${state.pendingDocPath}\`. The extension finishes this phase after a successful write; do not call again: ${EXIT_TOOL}。`,
						},
					],
					details: { accepted: false, phase: state.phase, docWriting: true },
				};
			}

			const plan = typeof params.plan === "string" ? params.plan.trim() : "";
			if (plan === "") {
				return {
					content: [{ type: "text", text: "The plan is empty. Submit a complete design: problem, files to change, and verification." }],
					details: { accepted: false, phase: state.phase },
				};
			}
			const summary = typeof params.summary === "string" && params.summary.trim() !== "" ? params.summary.trim() : undefined;
			// slug 是文档名的来源；模型漏传时退回 summary（清洗后若全是中文仍会落到 `plan`）。
			const slug = typeof params.slug === "string" && params.slug.trim() !== "" ? params.slug.trim() : summary;

			Object.assign(state, submitPlan(state, plan, summary));
			persist();
			render(ctx);

			// confirm/select 对话框是一个不可滚动的 Text，主屏渲染又把视口钉在底部 ——
			// 长计划必然看不全。截到一屏放得下；被截掉的部分仍写进了终端缓冲区，用户
			// 上翻可看全文（弹窗期间重绘已冻结）。
			const dialogPlan = truncatePlanForDialog(
				plan,
				{
					rows: process.stdout.rows || Number(process.env.LINES) || 24,
					columns: process.stdout.columns || 80,
				},
				wrapTextWithAnsi,
			);
			// 非交互运行（`pi -p`）没有对话框可弹：自动按推荐路线（写文档并实施）走，
			// 比死锁好 —— 模型已经规划完，卡在这里只会让整个运行白跑。
			const choice = ctx.hasUI
				? await ctx.ui.select(`Approve this plan?

${dialogPlan}`, [CHOICE_EXECUTE, CHOICE_DOC_ONLY, CHOICE_REJECT])
				: CHOICE_EXECUTE;

			if (choice === undefined || choice === CHOICE_REJECT) {
				Object.assign(state, rejectPlan(state));
				persist();
				render(ctx);
				return {
					content: [{ type: "text", text: buildRejectedMessage() }],
					details: { accepted: false, phase: state.phase },
				};
			}

			const docMode: PlanDocMode = choice === CHOICE_DOC_ONLY ? "doc-only" : "execute-with-doc";
			// 路径在用户选路线的这一刻算好并钉死：撞名判定问的是文件系统，之后重算
			// 可能得到不同的 -2 后缀，模型就会往另一个文件写。
			const docPath = buildPlanDocPath({ cwd: ctx.cwd, slug, exists: existsSync });
			Object.assign(state, enterDocWriting(state, docMode, docPath));
			// 放回 write（其余写工具仍摘着）；write 的目标路径由 tool_call 钩子限死。
			if (!state.toolsBeforePlan) state.toolsBeforePlan = pi.getActiveTools();
			pi.setActiveTools(planToolSet(state.toolsBeforePlan, true));
			persist();
			render(ctx);
			return {
				content: [
					{
						type: "text",
						text: `The user approved the plan and selected '${choice}'. Use the write tool to save the plan document to \`${docPath}\` — the only file writable in this phase. After a successful write, the extension finishes this phase and provides the next instructions; do not call again: ${EXIT_TOOL}。`,
					},
				],
				details: { accepted: true, docMode, docPath },
			};
		},
	});

	// =========================================================================
	// 每轮注入上下文 + 拦截写操作
	// =========================================================================

	pi.on("before_agent_start", async (_event, ctx) => {
		currentCtx = ctx;
		if (state.phase !== "plan") return undefined;
		// 每轮重收一次：模型可能刚调过 enter_plan_mode，别的扩展也可能改过工具表
		if (!state.toolsBeforePlan) state.toolsBeforePlan = pi.getActiveTools();
		pi.setActiveTools(planToolSet(state.toolsBeforePlan, state.docWriting === true));
		if (state.docWriting && state.pendingDocPath) {
			return {
				message: {
					customType: "plan-doc-write-context",
					content: buildDocWriteContext(state.pendingDocPath, state.pending ?? "", state.planSummary),
					display: false,
				},
			};
		}
		return {
			message: {
				customType: "plan-mode-context",
				content: buildPlanModeContext(ctx.cwd),
				display: false,
			},
		};
	});

	/**
	 * 第二道闸：写类 bash 一律拦；写文档子态里 write 只许写计划文档那一个路径。
	 * 工具表里摘掉的是 edit / write / powershell（子态放回 write），bash 还在，
	 * 所以这道钩子才是拦住 `echo x > f` / `git commit` / `npm install` 的地方。
	 * 拒绝原因作为工具错误结果回给模型 —— 这就是它能看到的反馈。
	 */
	pi.on("tool_call", async (event, ctx) => {
		if (state.phase !== "plan") return undefined;

		if (event.toolName === "write") {
			// 非子态时 write 根本不在工具表里，这里是双保险
			if (!state.docWriting) {
				return {
					block: true,
					reason: `Files cannot be written during planning. Explain the design and submit it using ${EXIT_TOOL}, then wait for user approval.`,
				};
			}
			const target = typeof event.input.path === "string" ? event.input.path : "";
			if (resolve(ctx.cwd, target) !== state.pendingDocPath) {
				return {
					block: true,
					reason: `Only the plan document may be written in this phase: requested target is \`${resolve(ctx.cwd, target)}\`, but the plan document path is \`${state.pendingDocPath}\`. Write to the latter; wait for this phase to finish and write access to be restored before changing other files.`,
				};
			}
			return undefined;
		}

		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		const verdict = inspectBashCommand(command);
		if (verdict.ok) return undefined;
		return {
			block: true,
			reason: `${verdict.reason}
Currently in plan mode (read-only): explain the design and submit it using ${EXIT_TOOL}; write access returns after user approval.`,
		};
	});

	/**
	 * 写文档子态的自动收尾：模型用 write 把计划文档写成功的那一刻，状态回 bypass、
	 * 工具表还原，收尾指令（实施 / 只报告路径）**替换**掉 write 的普通成功文本 ——
	 * 模型在同一轮里就能看到接下来该做什么，不需要再调任何工具。
	 *
	 * 判定严格三重：write 工具 + 成功 + 路径正是钉死的那个。write 失败（isError）
	 * 不收尾，模型自己会看到错误并重试。
	 */
	pi.on("tool_result", async (event, ctx) => {
		currentCtx = ctx;
		if (state.phase !== "plan" || !state.docWriting) return undefined;
		if (event.toolName !== "write" || event.isError) return undefined;
		const target = typeof event.input.path === "string" ? event.input.path : "";
		if (resolve(ctx.cwd, target) !== state.pendingDocPath) return undefined;

		const outcome = completeDocWrite(state);
		if (!outcome) return undefined;
		// 还原要用旧状态里的快照 —— 必须在 Object.assign 之前取
		const tools = restoredToolSet(state, pi.getActiveTools());
		Object.assign(state, outcome.state);
		pi.setActiveTools(tools);
		persist();
		render(ctx);
		if (ctx.hasUI) ctx.ui.notify(`Plan document saved: ${outcome.docPath}`, "info");
		return {
			content: [{ type: "text", text: buildDocWrittenMessage(outcome.docMode, outcome.docPath) }],
		};
	});

	// 回到 bypass 之后，把陈旧的 plan 上下文从模型上下文里过滤掉（不该看到过期的指令）
	pi.on("context", async (event) => {
		if (state.phase !== "bypass") return undefined;
		return {
			messages: event.messages.filter((message) => {
				const type = (message as { customType?: string }).customType;
				return type !== "plan-mode-context" && type !== "plan-doc-write-context";
			}),
		};
	});
}

// =============================================================================
// 思考等级键改绑
// =============================================================================

/**
 * 启动时确保 thinking cycle 已让位；失败只提示不抛，也不反复重试。
 *
 * 三种情况：
 *   - 配置文件里已经绑到 fallback（本扩展写过的，或用户自己配的）→ **完全静默**
 *   - 绑到别的键（用户自己的选择）→ **完全静默**，尊重用户配置
 *   - 没有任何绑定 → 写入 fallback 并告知一次
 *   - 配置文件不是合法 JSON（读不动、不敢改）→ 提示用户手动处理
 */
function ensureThinkingKeyRebound(ctx: ExtensionContext): void {
	const path = keybindingsPath();
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		raw = "";
	}

	const { value, outcome } = rebindThinkingKey(raw, path);
	if (!outcome.changed) {
		// 已经绑过（无论是谁绑的）→ 静默。只有「配置坏了、我们不敢动」才需要提醒。
		if (outcome.needsAttention === true && ctx.hasUI) {
			ctx.ui.notify(
				`Plan mode uses shift+tab, but automatic remapping failed (${outcome.reason}). Manually remap app.thinking.cycle to ${THINKING_FALLBACK_KEY}（${path}）。`,
				"warning",
			);
		}
		return;
	}

	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, value, "utf8");
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Plan mode uses shift+tab; thinking-level cycling was remapped to ${THINKING_FALLBACK_KEY}（${path}; takes effect after /reload)`,
				"info",
			);
		}
	} catch {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Plan mode uses shift+tab. In ${path}, remap app.thinking.cycle to ${THINKING_FALLBACK_KEY}。`,
				"warning",
			);
		}
	}
}
