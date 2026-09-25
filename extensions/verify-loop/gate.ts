/**
 * gate.ts — 验证闸的纯判定：「本轮改了文件，但最后一次改动之后没跑过验证命令」→ block。
 *
 * 这是 CC `Stop` hook 的确定性（`type: "command"`）形态在 pi 里的等价物：
 * CC 每次回合结束 fire Stop，hook 返回 `{"decision":"block","reason":...}` 阻止结束；
 * pi 的等价落点是 `agent_before_settle` 返回 `{entries, continue:true}`
 * （dist/core/agent-session.js:1142 `_runBeforeSettleBoundary`）。本文件只做判定，
 * 不发事件、不碰 pi —— 所以可以 `node --test` 直测。
 *
 * ## 判定输入
 *
 * `agent_before_settle` 事件的 `context.contextMessages`（模型可见投影，
 * `agent-session.js:_buildBoundaryContext` 构建）——**天然分支正确**：
 * rewind/分支导航后被丢弃的分支不在投影里，不需要增量状态。
 *
 * ## 「本轮」的界定，以及为什么拦截次数也从投影里数
 *
 * 投影里**最后一条 `role:"user"` 消息之后**的所有消息 = 本次 run。
 * 为什么不是整个投影：上一轮跑过的测试不能为本轮的改动作证
 * （verification-before-completion 的铁律是 FRESH evidence）。
 *
 * 拦截次数（CC 的 `stop_hook_active` + 连续 8 次上限）**不用内存计数器，而是数投影里
 * 已有的注入消息**。两个理由：
 *   1. `agent_start` 在每次边界续跑时都会再 fire 一次（`runAgentLoopContinue` 里
 *      `emit({type:"agent_start"})`），所以任何挂在 agent_start 上的复位都会在续跑链里
 *      把计数清零，上限失效；
 *   2. 从投影数出来的值天然分支正确、resume 后仍然正确，且不需要任何可变状态。
 *
 * 我们注入的是 `role:"custom"` 消息（不是 user），所以它**不会**把 run 窗口切断 ——
 * 整条续跑链共用一个窗口，正是 CC「同一 turn 内连续 block」的语义。
 *
 * ## mutation / verification 的口径（已知边界，与 destructive-guard 的词法口径同级）
 *
 * - mutation：assistant 消息里的 `toolCall` 块，工具名 ∈ MUTATION_TOOLS
 *   （`edit` / `write` / `apply_patch` / `multiedit` —— 后两个 pi 0.87.1 内置没有，
 *   dist/core/tools/ 只有 bash/edit/find/grep/ls/powershell/read/write，
 *   放进集合零成本，防未来或第三方注册），且目标路径不是纯文档
 *   （默认排除 `.md`/`.txt`：本仓库 AGENTS.md 编辑极频繁，不排除会把闸磨成噪音）。
 * - **bash 里的写操作（`sed -i` / 重定向 / 脚本改文件）不计为 mutation**——
 *   词法判定不做数据流分析，这是写进文档的已知边界，不是实现疏漏。
 * - verification：**任何一次 `bash` 调用**（成功或失败都算）。口径为什么这么宽，见下面
 *   「为什么 verification 是「跑过命令」而不是「跑过测试」」。
 */

/** 投影消息的最小结构鸭子类型（不 import pi，保持可单测）。 */
export interface GateMessage {
	role?: unknown;
	customType?: unknown;
	details?: unknown;
	content?: unknown;
}

interface ToolCallBlock {
	name: string;
	arguments: Record<string, unknown>;
}

/** 注入消息的 customType（index.ts 的 registerMessageRenderer 也用它）。 */
export const VERIFY_LOOP_CUSTOM_TYPE = "verify-loop";

/** 注入消息的种类，存在 `details.kind` 里 —— 拦截次数按种类分别数。 */
export type InjectKind = "gate" | "goal-not-met" | "goal-met" | "goal-impossible" | "goal-halted" | "goal-cap";

/** 会改文件的工具名。pi 0.87.1 内置只有 edit/write；其余是防未来/第三方。 */
export const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"]);

/**
 * 严格识别式：只认测试/构建/lint 形状的命令。
 *
 * **不是默认值** —— 默认口径是「跑过任何命令」（见下）。这个常量留给
 * `PI_VERIFY_PATTERN=strict` 与文档引用：想要「必须跑测试」的严格门时用它。
 */
export const STRICT_VERIFY_PATTERN =
	/\b(node\s+--test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+(run\s+)?test|pytest|python3?\s+-m\s+unittest|cargo\s+(test|build|check)|go\s+(test|build|vet)|tsc\b|eslint\b|biome\s+check|ruff\s+check|flake8\b|make\s+(test|build|check))\b/i;

/**
 * 默认验证口径：**任何一次 bash 调用都算证据**（`verifyPattern` 为 undefined）。
 *
 * ## 为什么不是「必须跑测试」
 *
 * 2026-09-25 第一次活体冒烟就量到了误报：模型改完 `probe.js` 之后跑的是
 * `node --input-type=module -e "import('./probe.js').then(m => console.log(m.VALUE))"`
 * —— 这是货真价实的 fresh evidence（导入改动后的模块、把新值打出来），但它不匹配
 * 任何测试运行器形状，于是闸**第二次**把它拦下，模型回了一句「我上一条已经运行过验证」
 * 又白跑一轮。实测记录在案，不是推演。
 *
 * 词法闸判不了「这条命令是不是一个*相关的*测试」—— 那需要语义判断，是 `/goal`
 * 评估器的活。所以两层分工：
 *
 *   - 闸（本文件）：**改动之后有没有对实际状态做过一次观察**（跑过命令、看到输出）。
 *     抓的是「什么都没跑就说完成」—— 也正是 issue #12 与
 *     verification-before-completion 要抓的那个形状。
 *   - `/goal` 评估器：**那次观察能不能证明条件成立**（语义层，CC 的 prompt hook）。
 *
 * 已知代价（写清楚，别当 bug 修）：模型跑一条 `ls` 也能过闸。CC 的 command 型
 * Stop hook 是同级的粗 —— 它就是用户写的那个脚本，判不了相关性。
 * 要严格门就 `PI_VERIFY_PATTERN=strict`（或给一个自己的正则）。
 */
export const DEFAULT_VERIFY_PATTERN: RegExp | undefined = undefined;

/** 默认排除的纯文档扩展名（改它们不触发闸）。 */
export const DEFAULT_DOC_EXTENSIONS = [".md", ".txt"];

export interface GateConfig {
	/** block / notify / off —— 由 index.ts 从 env 解析后传入。 */
	mode: "block" | "notify" | "off";
	/** 验证命令识别式；undefined = 任何 bash 调用都算（默认口径，见 DEFAULT_VERIFY_PATTERN）。 */
	verifyPattern: RegExp | undefined;
	/** 纯文档扩展名（改这些不算 mutation）。 */
	docExtensions: string[];
	/** 连续 block 上限（CC 通用上限 8；我们只有一条规则，默认 2）。 */
	blockCap: number;
}

export interface MutationEvent {
	tool: string;
	/** 目标路径；apply_patch 等拿不到单路径的记为 undefined。 */
	path?: string;
}

export interface GateScan {
	/** 扫描窗口内的全部工具调用数（goal 的无进展检测复用）。 */
	toolCallCount: number;
	mutations: MutationEvent[];
	/** 最后一次 mutation 之后出现的验证命令数。 */
	verificationsAfterLastMutation: number;
}

export type GateDecision =
	| { action: "pass"; reason: string }
	| { action: "block"; mutations: MutationEvent[]; attempt: number; cap: number };

/** 取 toolCall 块的 path 参数（edit/write 的 schema 都是 `path: string`）。 */
function toolCallPath(block: ToolCallBlock): string | undefined {
	const path = block.arguments?.path;
	return typeof path === "string" && path !== "" ? path : undefined;
}

function isDocPath(path: string | undefined, docExtensions: string[]): boolean {
	if (path === undefined) return false;
	const lower = path.toLowerCase();
	return docExtensions.some((ext) => lower.endsWith(ext));
}

function asToolCallBlocks(content: unknown): ToolCallBlock[] {
	if (!Array.isArray(content)) return [];
	const blocks: ToolCallBlock[] = [];
	for (const item of content) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as { type?: unknown; name?: unknown; arguments?: unknown };
		if (record.type !== "toolCall" || typeof record.name !== "string") continue;
		blocks.push({
			name: record.name,
			arguments: (typeof record.arguments === "object" && record.arguments !== null
				? record.arguments
				: {}) as Record<string, unknown>,
		});
	}
	return blocks;
}

/**
 * run 窗口起点：最后一条 `role:"user"` 消息的下标（不含它自己）。
 * 没有 user 消息时返回 -1（整个投影都算窗口）。
 *
 * 注意：我们注入的是 `role:"custom"`，**不算** user，所以续跑链共用一个窗口。
 */
export function findRunStart(messages: readonly GateMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i].role === "user") return i;
	}
	return -1;
}

/**
 * 数投影里已注入的某类消息条数（从 startIndex 之后算）。
 * 这就是 CC 的「本 turn 已连续 block 几次」，只是从证据里数而不是靠内存计数。
 */
export function countInjected(messages: readonly GateMessage[], kind: InjectKind, startIndex = findRunStart(messages)): number {
	let count = 0;
	for (let i = startIndex + 1; i < messages.length; i += 1) {
		const message = messages[i];
		if (message.role !== "custom" || message.customType !== VERIFY_LOOP_CUSTOM_TYPE) continue;
		const details = message.details as { kind?: unknown } | undefined;
		if (details?.kind === kind) count += 1;
	}
	return count;
}

/**
 * 扫描窗口内的工具调用事件。
 *
 * `startIndex` 缺省 = run 窗口起点；goal 的无进展检测传「上一条注入消息之后」
 * 来只看最新那一段续跑。
 */
export function scanRun(
	messages: readonly GateMessage[],
	config?: Pick<GateConfig, "verifyPattern" | "docExtensions">,
	startIndex?: number,
): GateScan {
	const verifyPattern = config?.verifyPattern ?? DEFAULT_VERIFY_PATTERN;
	const docExtensions = config?.docExtensions ?? [];
	const from = startIndex ?? findRunStart(messages);

	const scan: GateScan = { toolCallCount: 0, mutations: [], verificationsAfterLastMutation: 0 };
	for (let i = from + 1; i < messages.length; i += 1) {
		if (messages[i].role !== "assistant") continue;
		for (const block of asToolCallBlocks(messages[i].content)) {
			scan.toolCallCount += 1;
			if (block.name === "bash") {
				const command = block.arguments.command;
				if (typeof command !== "string") continue;
				// 默认口径：任何 bash 调用都算一次观察；配了识别式则只认匹配的。
				if (verifyPattern !== undefined && !verifyPattern.test(command)) continue;
				// 顺序统计：只有出现在最后一次 mutation 之后的验证才计数
				if (scan.mutations.length > 0) scan.verificationsAfterLastMutation += 1;
				continue;
			}
			if (MUTATION_TOOLS.has(block.name)) {
				const path = toolCallPath(block);
				if (isDocPath(path, docExtensions)) continue;
				scan.mutations.push({ tool: block.name, path });
				// 新的 mutation 让之前的验证过期
				scan.verificationsAfterLastMutation = 0;
			}
		}
	}
	return scan;
}

/**
 * 闸判定。调用方（index.ts）已经过滤了 `outcome !== "completed"`
 * （CC：abort 不触发 Stop，API 错误走 StopFailure）。
 */
export function decideGate(messages: readonly GateMessage[], config: GateConfig): GateDecision {
	if (config.mode === "off") return { action: "pass", reason: "off" };

	const alreadyBlocked = countInjected(messages, "gate");
	if (alreadyBlocked >= config.blockCap) return { action: "pass", reason: "cap" };

	const scan = scanRun(messages, config);
	if (scan.mutations.length === 0) return { action: "pass", reason: "no-mutation" };
	if (scan.verificationsAfterLastMutation > 0) return { action: "pass", reason: "verified" };

	return {
		action: "block",
		mutations: scan.mutations,
		attempt: alreadyBlocked + 1,
		cap: config.blockCap,
	};
}

/** 闸拦截消息（CC 的 reason —— 同时是给模型的指令和给用户看的 "Stop hook feedback"）。 */
export function renderGateMessage(decision: Extract<GateDecision, { action: "block" }>): string {
	const files = decision.mutations
		.map((mutation) => mutation.path ?? `(${mutation.tool})`)
		.filter((value, index, all) => all.indexOf(value) === index);
	const fileList = files.length > 0 ? files.join("、") : "（未识别到具体路径）";
	return (
		`你声称完成，但本次 run 的文件改动（${fileList}）之后没有跑过任何命令去观察实际结果。\n` +
		`请运行能证明这次改动正确的命令（测试 / 构建 / lint，或直接跑一下改过的代码把结果打出来）` +
		`并把输出贴出来；若确属无需验证的改动，明确说明原因。\n` +
		`这是第 ${decision.attempt}/${decision.cap} 次拦截；达到上限后不再拦截。`
	);
}
