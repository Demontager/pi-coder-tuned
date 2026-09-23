/**
 * pi-plan-mode — Claude Code 风格的 plan mode。
 *
 * 三态：normal → plan（只读探索，模型出方案）→ execute（批准后按步骤执行）。
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
 *   /plan-status   看当前状态与步骤
 *   --plan         启动即进 plan mode
 *   自动进入       注册 enter_plan_mode 工具 —— 模型判断任务偏大时自己调用，
 *                  这就是 Claude Code 的机制（不是关键词启发式）
 *
 * ## 约束（收工具 + 拦 bash，两道独立的闸）
 *
 *   1. 工具集：进 plan 时把 edit / write / powershell 从活动工具里摘掉，退出时按
 *      进入前的快照**原样还原**。本机 pi 的工具表里有二十多个扩展动态注册的工具，
 *      硬编码白名单会把它们全吃掉，所以快照-还原是唯一安全的做法。
 *   2. tool_call 钩子：写类 bash（重定向 / rm / git commit / npm install …）不管在不在
 *      工具表里都被拦，拒绝原因作为工具错误结果回给模型。判定细节见 plan.ts。
 *
 * 这是给配合的模型用的护栏，不是沙箱 —— 见 plan.ts 文件头的取舍说明。
 *
 * ## 计划落地
 *
 * 全在会话里：计划经 `exit_plan_mode` 的工具参数进来，进度存 `pi.appendEntry("plan-mode")`
 * （不进模型上下文、不写工作区），状态行与步骤 widget 走 setStatus / setWidget。工作区里
 * 不会多出任何文件。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	type PlanState,
	type PlanStep,
	applyDoneSteps,
	approvePlan,
	cancelPlan,
	countDoneSteps,
	enterPlan,
	initialPlanState,
	inspectBashCommand,
	isPlanComplete,
	planModeToolSet,
	rejectPlan,
	restoredToolSet,
	submitPlan,
} from "./plan.ts";
import {
	buildExecuteContext,
	buildPlanModeContext,
	extractDoneSteps,
	stripDoneMarkers,
} from "./plan-text.ts";
import { STATUS_KEY, STEPS_WIDGET_KEY, formatPlanStatus, formatStepLines } from "./render.ts";
import { THINKING_FALLBACK_KEY, keybindingsPath, rebindThinkingKey } from "./keybinding.ts";
import {
	type PlanMirrorItem,
	type TaskMirrorState,
	SYNC_TASKS_EVENT,
	TASK_STATE_EVENT,
	hasMirrorItems,
	mirroredDoneSteps,
} from "../simple-task/plan-mirror.ts";

/** 关掉整个扩展。 */
const DISABLED = (process.env.PI_PLAN_MODE ?? "").trim().toLowerCase() === "off";
/** 只关自动进入（shift+tab 与 /plan 仍可用）。 */
const AUTO_DISABLED = (process.env.PI_PLAN_MODE_AUTO ?? "").trim().toLowerCase() === "off";

const ENTER_TOOL = "enter_plan_mode";
const EXIT_TOOL = "exit_plan_mode";
/** 会话里持久化状态的 custom entry 类型。 */
const ENTRY_TYPE = "plan-mode";

interface PersistedState {
	phase: PlanState["phase"];
	steps: PlanStep[];
	pending?: PlanStep[];
	toolsBeforePlan?: string[];
}

export default function planMode(pi: ExtensionAPI) {
	if (DISABLED) return;

	const state: PlanState = initialPlanState();
	/**
	 * simple-task 最近一次广播回来的状态（契约见 `../simple-task/plan-mirror.ts`）。
	 *
	 * 执行期的进度以它为准：批准计划时步骤被镜像进清单，之后模型用 `task_update` 推进，
	 * 镜像回来的状态就是状态行的真相源。undefined 表示本会话里没装 simple-task ——
	 * 那时退回自己的 `[DONE:n]` 计数（仍然比假装有进度强）。
	 */
	let mirrorState: TaskMirrorState | undefined;
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
		description: "启动即进入 plan mode（只读探索）",
		type: "boolean",
		default: false,
	});

	// =========================================================================
	// 渲染
	// =========================================================================

	function render(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, formatPlanStatus(ctx.ui.theme, statusSource()));
			// 执行期**不画自己的步骤清单**：步骤已经镜像进 simple-task 的清单，
			// 用户手里应该只有一份进度表（Claude Code 也是这个分工：计划批完，
			// 留下来的只有任务列表）。plan 阶段仍画待批的步骤 —— 那时还没有清单。
			ctx.ui.setWidget(
				STEPS_WIDGET_KEY,
				state.phase === "execute" ? undefined : formatStepLines(ctx.ui.theme, state, visibleWidth),
			);
		} catch {
			// 会话替换窗口里 ctx 可能已被 pi 作废。渲染是尽力而为，绝不能让它打死进程
			// （本机 user-message-bar 扩展踩过同一个坑，代价是 pi 直接退出）。
		}
	}

	/**
	 * 状态行与 widget 共用的视图：把镜像回来的完成情况合进自己的 steps。
	 *
	 * 不能直接改 `state.steps[].done` —— 那是 `[DONE:n]` 的记账（也是 `isPlanComplete`
	 * 与持久化的依据）；用视图覆盖，两个信号源就不需要互相写对方的状态。
	 */
	function statusSource(): PlanState {
		if (state.phase !== "execute" || mirrorState === undefined) return state;
		const done = mirroredDoneSteps(mirrorState);
		if (done.size === 0) return state;
		return { ...state, steps: state.steps.map((step) => (done.has(step.step) ? { ...step, done: true } : step)) };
	}

	/** 当前完成步数（镜像优先，回退到自己的记账）。 */
	function doneCount(): number {
		return statusSource().steps.filter((step) => step.done).length;
	}

	// =========================================================================
	// 与 simple-task 的镜像（契约见 simple-task/plan-mirror.ts）
	// =========================================================================

	/**
	 * 把当前步骤全量发给 simple-task。**只在 execute 阶段发**：批准前用户手里只有待批
	 * 的计划，还不该多出一份清单（Claude Code 也是批准后才建任务列表）。
	 *
	 * 清空走 `clearMirror()` —— 刻意不写「phase 不是 execute 就发空数组」：那样执行完毕
	 * 回到 normal 时会顺手把清单抹掉，用户反而看不到刚跑完的 ✔ 列表。
	 */
	function syncMirror(): void {
		if (state.phase !== "execute") return;
		const items: PlanMirrorItem[] = state.steps.map((step) => ({
			step: step.step,
			text: step.text,
			done: step.done,
		}));
		emitMirror(items);
	}

	/** 放弃计划（退出 plan / 打回重拟 / 重新进 plan）：把镜像从清单里清掉。 */
	function clearMirror(): void {
		emitMirror([]);
	}

	function emitMirror(items: PlanMirrorItem[]): void {
		try {
			pi.events.emit(SYNC_TASKS_EVENT, items);
		} catch {
			// 事件总线不可用不致命：镜像只是显示层的唯一进度表，不参与持久化
		}
	}

	/**
	 * 镜像状态回来：只要"完成了几步"真的变了就重绘并检查收尾。
	 *
	 * `persist()` 也跟上 —— `/resume` 后步骤仍是完成的，否则重开会话时状态行会回退
	 * （镜像本身也会掉，因为 simple-task 的清单纯属显示层）。
	 */
	function applyMirrorState(incoming: TaskMirrorState): void {
		const before = mirrorState;
		mirrorState = incoming;
		if (state.phase !== "execute") return;

		const done = mirroredDoneSteps(incoming);
		const beforeDone = mirroredDoneSteps(before);
		const changed =
			done.size !== beforeDone.size || [...done].some((step) => !beforeDone.has(step));
		if (!changed) return;

		// 镜像认下来了就写进自己的记账（否则 `[DONE:n]` 与镜像会各说各话，
		// 而 `isPlanComplete` 只看 state.steps）。这条 persist **不回推镜像**：
		// 变化本来就是镜像带回来的，回推只会多一条没人要的全量快照。
		const marked = applyDoneSteps(state, [...done]);
		if (marked > 0) persist({ syncMirror: false });
		render(currentCtx);
		if (isPlanComplete(state)) completePlan(currentCtx);
	}

	// =========================================================================
	// 持久化（只在会话条目里，不碰工作区）
	// =========================================================================

	function persist(options: { syncMirror?: boolean } = {}): void {
		const payload: PersistedState = {
			phase: state.phase,
			steps: state.steps,
			pending: state.pending,
			toolsBeforePlan: state.toolsBeforePlan,
		};
		pi.appendEntry(ENTRY_TYPE, payload);
		// 持久化是唯一的状态变更出口：顺手把镜像同步一次，两边的"完成了几步"
		// 就不会因为某条分支忘了发事件而漂移。
		// 唯一的例外是镜像自己带回来的进度 —— 那次变化本来就是从镜像来的，回推只会
		// 多一条没人要的全量快照（回调里传 `syncMirror: false`）。
		if (options.syncMirror !== false) syncMirror();
	}

	/**
	 * 只认当前分支上的最新记录。
	 *
	 * 用 getBranch() 而不是 getEntries()：后者返回**全量**条目（`session-manager.js` 的
	 * `fileEntries.filter(...)`），包含 rewind / fork / 分支导航之后被丢弃的分支 —— 用它
	 * 会让一条已经不上分支的计划在下次启动时复活（实测：活动分支上没有任何计划，状态行却
	 * 显示 `▶ 0/1 executing`）。pi 的 docs/extensions.md 也要求用 getBranch() 重建
	 * 分支敏感状态。
	 */
	function restore(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getBranch();
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index] as { type?: string; customType?: string; data?: PersistedState };
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !entry.data) continue;
			state.phase = entry.data.phase ?? "normal";
			state.steps = entry.data.steps ?? [];
			state.pending = entry.data.pending;
			state.toolsBeforePlan = entry.data.toolsBeforePlan;
			break;
		}
		// plan 态恢复后工具表要跟着收回去（工具集本身不进会话条目，按当前表重算）
		if (state.phase === "plan") {
			if (!state.toolsBeforePlan) state.toolsBeforePlan = pi.getActiveTools();
			pi.setActiveTools(planToolSet(state.toolsBeforePlan));
		}
		// execute 态恢复后重建镜像：simple-task 的清单是**进程内**状态，重开 pi 就没了，
		// 而计划本身还在。它那边的 `reconstruct` 只在 session_start 跑，那时我们还没发；
		// 所以这里主动推一次全量快照，之后它的广播会带回真实完成情况。
		if (state.phase === "execute") syncMirror();
	}

	// =========================================================================
	// 状态迁移
	// =========================================================================

	/** plan 阶段的活动工具：pi 的写工具 + 已经没用的 enter_plan_mode 都摘掉。 */
	function planToolSet(active: readonly string[]): string[] {
		return planModeToolSet(active).filter((name) => name !== ENTER_TOOL);
	}

	function enter(ctx: ExtensionContext | undefined, reason: "user" | "model"): void {
		if (state.phase === "plan") return;
		// 快照必须取在摘工具**之前** —— 退出时靠它原样还原（含二十多个扩展工具）
		const before = pi.getActiveTools();
		Object.assign(state, enterPlan(state, before));
		pi.setActiveTools(planToolSet(before));
		// 执行期再次进 plan = 重新规划：旧计划的镜像条目必须一起清掉，否则屏幕上是
		// 「状态行 ⏸ plan + 清单里的旧计划」，两个方案同屏。（`leave()` 也会清，
		// 但它只覆盖退出路径。）
		clearMirror();
		persist();
		render(ctx);
		if (ctx?.hasUI) {
			ctx.ui.notify(
				reason === "model"
					? "模型判断这个任务需要先规划，已进入 plan mode（只读）。shift+tab 可随时退出。"
					: "已进入 plan mode：只读探索，模型会先给方案。shift+tab 切换。",
				"info",
			);
		}
	}

	function leave(ctx: ExtensionContext | undefined, notify = true): void {
		const tools = restoredToolSet(state, pi.getActiveTools());
		Object.assign(state, cancelPlan(state));
		state.toolsBeforePlan = undefined;
		pi.setActiveTools(tools);
		// 用户主动退出 = 放弃这个计划：清单里的镜像条目一起清掉
		// （persist() 里的自动同步只认 execute，这里必须显式发）。
		clearMirror();
		persist();
		render(ctx);
		if (notify && ctx?.hasUI) ctx.ui.notify("已退出 plan mode，写权限恢复。", "info");
	}

	function toggle(ctx: ExtensionContext | undefined): void {
		if (state.phase === "normal") enter(ctx, "user");
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

	/** simple-task 广播回来的清单状态（进度真相源）。 */
	pi.events.on(TASK_STATE_EVENT, (data) => {
		const incoming = data as TaskMirrorState | undefined;
		if (!incoming || !Array.isArray(incoming.items)) return;
		applyMirrorState(incoming);
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
		description: "切换 plan mode（只读探索 → 批准 → 执行）",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			toggle(ctx);
		},
	});

	pi.registerCommand("plan-status", {
		description: "显示 plan mode 状态与步骤",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			const phase =
				state.phase === "normal" ? "normal（未启用）" : state.phase === "plan" ? "plan（只读探索）" : "execute（执行中）";
			const steps = state.phase === "plan" ? state.pending ?? [] : state.steps;
			if (steps.length === 0) {
				ctx.ui.notify(`plan mode: ${phase}\n（还没有步骤）`, "info");
				return;
			}
			const list = steps.map((step) => `${step.done ? "☑" : "☐"} ${step.step}. ${step.text}`).join("\n");
			ctx.ui.notify(`plan mode: ${phase}\n${list}`, "info");
		},
	});

	// =========================================================================
	// 自动进入：模型工具
	// =========================================================================

	if (!AUTO_DISABLED) {
		pi.registerTool({
			name: ENTER_TOOL,
			label: "Enter Plan Mode",
			description:
				"进入 plan mode（只读探索）。当任务需要改动多个文件、涉及架构或接口选择、或者你还没弄清该怎么做时先调用它，把方案讲清楚再动手。用户也可以自己按 shift+tab 进入。",
			parameters: Type.Object({
				reason: Type.Optional(Type.String({ description: "为什么这个任务需要先规划（一句话）" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				currentCtx = ctx;
				enter(ctx, "model");
				const reason = typeof params.reason === "string" && params.reason.trim() !== "" ? params.reason.trim() : "";
				return {
					content: [
						{
							type: "text",
							text: `已进入 plan mode（只读）。${reason ? `原因：${reason}。` : ""}\nedit / write 已停用，bash 里的写操作会被拦下。先读代码；需要用户拍板的选择用 ask_user_question 问；方案想清楚后调用 ${EXIT_TOOL} 提交。`,
						},
					],
					details: { phase: state.phase },
				};
			},
		});
	}

	// plan 阶段唯一的出口：提交计划给用户审批
	pi.registerTool({
		name: EXIT_TOOL,
		label: "Submit Plan",
		description:
			"在 plan mode 里把方案提交给用户审批。调用前不要试图改动任何文件。提交后用户决定批准（进入执行）还是打回（继续规划）。",
		parameters: Type.Object({
			steps: Type.Array(Type.Object({ text: Type.String({ description: "这一步具体做什么（改哪个文件、加什么），一句话" }) }), {
				description: "按顺序排列的计划步骤",
				minItems: 1,
			}),
			summary: Type.Optional(Type.String({ description: "方案的一句话总结" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;
			if (state.phase !== "plan") {
				return {
					content: [{ type: "text", text: `现在不在 plan mode（当前：${state.phase}），不需要提交计划。` }],
					details: { accepted: false, phase: state.phase },
				};
			}

			const steps: PlanStep[] = params.steps
				.map((step, index) => ({ step: index + 1, text: step.text.trim(), done: false }))
				.filter((step) => step.text !== "");
			if (steps.length === 0) {
				return {
					content: [{ type: "text", text: "计划是空的。请写出至少一个具体步骤（改哪个文件、做什么）再提交。" }],
					details: { accepted: false, phase: state.phase },
				};
			}

			Object.assign(state, submitPlan(state, steps));
			persist();
			render(ctx);

			const planList = steps.map((step) => `${step.step}. ${step.text}`).join("\n");
			// 非交互运行（`pi -p`）没有对话框可弹：自动批准比死锁好 —— 模型已经规划完，
			// 卡在这里只会让整个运行白跑。
			const approved = ctx.hasUI ? await ctx.ui.confirm("批准这个计划？", planList) : true;

			if (!approved) {
				Object.assign(state, rejectPlan(state));
				persist();
				render(ctx);
				return {
					content: [
						{
							type: "text",
							text: `用户没有批准这个计划，仍在 plan mode（只读）。请根据用户的下一条反馈调整方案；改好后再调用 ${EXIT_TOOL}。`,
						},
					],
					details: { accepted: false, phase: state.phase },
				};
			}

			const tools = restoredToolSet(state, pi.getActiveTools());
			Object.assign(state, approvePlan(state));
			state.toolsBeforePlan = undefined;
			pi.setActiveTools(tools);
			// persist() 里就会把步骤镜像给 simple-task（唯一进度表），
			// 同时清掉自己上次广播的镜像状态 —— 接着靠它回传的真实状态算进度。
			mirrorState = undefined;
			persist();
			render(ctx);
			return {
				content: [
					{
						type: "text",
						text: `用户已批准计划，写权限已恢复。步骤已同步到会话任务清单（#1..#${steps.length}），那是唯一的进度表：每步开始前 \`task_update #n → in_progress\`，做完再 \`task_update #n → done\`（或者按老习惯在回复里带 \`[DONE:n]\`，它等价于直接标 done）。\n\n${planList}`,
					},
				],
				details: { accepted: true, steps: state.steps },
			};
		},
	});

	// =========================================================================
	// 每轮注入上下文 + 拦截写操作
	// =========================================================================

	pi.on("before_agent_start", async (_event, ctx) => {
		currentCtx = ctx;
		if (state.phase === "plan") {
			// 每轮重收一次：模型可能刚调过 enter_plan_mode，别的扩展也可能改过工具表
			if (!state.toolsBeforePlan) state.toolsBeforePlan = pi.getActiveTools();
			pi.setActiveTools(planToolSet(state.toolsBeforePlan));
			return {
				message: {
					customType: "plan-mode-context",
					content: buildPlanModeContext(ctx.cwd),
					display: false,
				},
			};
		}
		if (state.phase === "execute" && state.steps.some((step) => !step.done)) {
			return {
				message: {
					customType: "plan-execute-context",
					content: buildExecuteContext(state.steps),
					display: false,
				},
			};
		}
		return undefined;
	});

	/**
	 * 第二道闸：写类 bash 一律拦。工具表里摘掉的是 edit / write，bash 还在，
	 * 所以这道钩子才是拦住 `echo x > f` / `git commit` / `npm install` 的地方。
	 * 拒绝原因作为工具错误结果回给模型 —— 这就是它能看到的反馈。
	 */
	pi.on("tool_call", async (event) => {
		if (state.phase !== "plan") return undefined;
		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		const verdict = inspectBashCommand(command);
		if (verdict.ok) return undefined;
		return {
			block: true,
			reason: `${verdict.reason}\n现在是 plan mode（只读阶段）：先把方案写清楚并用 ${EXIT_TOOL} 提交，等用户批准后写权限会恢复。`,
		};
	});

	/**
	 * 进度追踪 + 清掉给用户看的 `[DONE:n]` 标记。
	 *
	 * 两件事必须在同一个钩子里按顺序做完：先在**清理前**的原文里提标记，再把清理后的
	 * 消息还给 pi。反过来（turn_end 里提）就不行了 —— message_end 已经把标记删掉了。
	 */
	pi.on("message_end", async (event, ctx) => {
		currentCtx = ctx;
		if (state.phase !== "execute") return undefined;
		if (event.message.role !== "assistant") return undefined;

		const raw = messageText(event.message);
		const marked = applyDoneSteps(state, extractDoneSteps(raw));
		if (marked > 0) {
			persist();
			render(ctx);
			if (isPlanComplete(state)) completePlan(ctx);
		}

		// 清理只影响用户看到与存进会话的文本；进度已经在上面记进状态了
		const content = event.message.content;
		if (!Array.isArray(content)) return undefined;
		let changed = false;
		const next = content.map((block) => {
			if (block.type !== "text") return block;
			const cleaned = stripDoneMarkers(block.text);
			if (cleaned === block.text) return block;
			changed = true;
			return { ...block, text: cleaned };
		});
		return changed ? { message: { ...event.message, content: next } } : undefined;
	});

	/**
	 * 每轮开始前按「镜像还在不在」重推一次。
	 *
	 * 判据必须看**清单里还有没有镜像条目**，不能看「自己有没有 done 步」：模型违规
	 * `task_set` 或 `/tasks clear` 会整体冲掉镜像，而那时自己往往一个 done 步都没有 ——
	 * 旧判据会让镜像永远回不来，状态行冻在 `▶ 0/N`。反过来，已有 done 步时旧判据把镜像
	 * 塞回模型的新清单，同屏又是两段清单一份数字。
	 *
	 * `turn_start` 在上一轮的任务工具调用**之后**、本轮 LLM 请求之前，正好是重推点。
	 */
	pi.on("turn_start", async () => {
		if (state.phase !== "execute") return;
		if (mirrorState && hasMirrorItems(mirrorState.items)) return;
		syncMirror();
	});

	/** 全部步骤完成：报一句、状态回 normal、工具表还原。 */
	function completePlan(ctx: ExtensionContext | undefined): void {
		const done = Math.max(countDoneSteps(state), doneCount());
		const total = state.steps.length;
		pi.sendMessage(
			{ customType: "plan-complete", content: `**计划执行完毕** ✓ ${done}/${total} 步。`, display: true },
			{ triggerTurn: false },
		);
		const tools = restoredToolSet(state, pi.getActiveTools());
		state.phase = "normal";
		state.steps = [];
		state.pending = undefined;
		state.toolsBeforePlan = undefined;
		pi.setActiveTools(tools);
		// 账清了就不再同步镜像（persist() 只认 execute）—— 列表留在屏幕上供用户回看。
		persist();
		render(ctx);
	}

	// 回到 normal 之后，把陈旧的 plan 上下文从模型上下文里过滤掉（不该看到过期的指令）
	pi.on("context", async (event) => {
		if (state.phase !== "normal") return undefined;
		return {
			messages: event.messages.filter((message) => {
				const type = (message as { customType?: string }).customType;
				return type !== "plan-mode-context" && type !== "plan-execute-context";
			}),
		};
	});
}

// =============================================================================
// 辅助
// =============================================================================

function messageText(message: unknown): string {
	const content = (message as { content?: unknown })?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
		.join("\n");
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
				`plan mode 占用了 shift+tab，但无法自动改绑（${outcome.reason}）。请手动把 app.thinking.cycle 改绑到 ${THINKING_FALLBACK_KEY}（${path}）。`,
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
				`plan mode 占用了 shift+tab；思考等级循环已改绑到 ${THINKING_FALLBACK_KEY}（${path}，/reload 后生效）`,
				"info",
			);
		}
	} catch {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`plan mode 占用了 shift+tab。请在 ${path} 里把 app.thinking.cycle 改绑到 ${THINKING_FALLBACK_KEY}。`,
				"warning",
			);
		}
	}
}
