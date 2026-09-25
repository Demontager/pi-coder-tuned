/**
 * verify-loop 的装配验证：纯判定在 gate/goal/evaluator 各自的测试里；
 * 这里**不 mock pi**，用 pi 自己的扩展加载器（`discoverAndLoadExtensions`）真加载
 * `index.ts`，然后直接驱动它注册的 `agent_before_settle` handler 与 `/goal` 命令。
 *
 * 加载器给的 runtime 上 `appendEntry` / `sendUserMessage` 是抛错桩
 * （loader.js 的 notInitialized），但包装函数在**调用时**才读 runtime 属性，
 * 所以测试里直接替换成记录器即可（runner.bindCore 在真 pi 里做的就是这件事）。
 *
 *   node --test clients/pi/extensions/verify-loop/index.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { VERIFY_LOOP_CUSTOM_TYPE } from "./gate.ts";
import { GOAL_ENTRY_TYPE } from "./goal.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

// =============================================================================
// 找到本机 pi 的库入口（core-rules/index.test.ts 同源）
// =============================================================================

async function findPiLibraryEntry(): Promise<string | undefined> {
	const candidates: string[] = [];
	if (process.env.PI_TEST_PI_ENTRY) candidates.push(process.env.PI_TEST_PI_ENTRY);

	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const shimPath = path.join(dir, "pi");
		try {
			const real = fs.realpathSync(shimPath);
			if (real !== shimPath) candidates.push(path.join(path.dirname(real), "index.js"));
		} catch {
			// 不是符号链接 / 不存在：看下面的 shim 脚本
		}
		try {
			const match = /^# cmd-shim-target=(.+)$/m.exec(fs.readFileSync(shimPath, "utf8"));
			if (match?.[1]) candidates.push(path.join(path.dirname(match[1].trim()), "index.js"));
		} catch {
			// 读不到这个 shim：跳过
		}
	}

	const packageDir = path.join(os.homedir(), ".pi/agent/npm/node_modules/@earendil-works/pi-coding-agent");
	candidates.push(path.join(packageDir, "dist/bundle/index.js"), path.join(packageDir, "dist/index.js"));

	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			await import(pathToFileURL(candidate).href);
			return candidate;
		} catch {
			// 空壳副本：换下一个候选
		}
	}
	return undefined;
}

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? "找不到本机 pi 的库入口（装过 pi 才有）" : false;

// =============================================================================
// 投影消息构造
// =============================================================================

type Message = Record<string, unknown>;

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): Message {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolCalls(...calls: Array<{ name: string; args?: Record<string, unknown> }>): Message {
	return {
		role: "assistant",
		content: calls.map((call, index) => ({
			type: "toolCall",
			id: `call-${index}-${call.name}`,
			name: call.name,
			arguments: call.args ?? {},
		})),
	};
}

function toolResult(): Message {
	return { role: "toolResult", content: [{ type: "text", text: "ok" }] };
}

// =============================================================================
// 加载与驱动
// =============================================================================

interface LoadedExtension {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	messageRenderers: Map<string, unknown>;
}

interface Harness {
	/** 驱动 agent_before_settle，返回 BoundaryResult。 */
	settle(messages: Message[], outcome?: "completed" | "aborted" | "error"): Promise<unknown>;
	/** 跑 /goal 命令。 */
	goal(args: string): Promise<void>;
	/** 驱动 session_start（重建 goal）。 */
	startSession(branchEntries?: unknown[]): Promise<void>;
	/** 记录到的 appendEntry 调用。 */
	appended: Array<{ customType: string; data: unknown }>;
	/** 记录到的 sendUserMessage 调用。 */
	sentUserMessages: Array<{ content: string; options?: unknown }>;
	/** 记录到的 notify。 */
	notifies: string[];
	/** setStatus 记录。 */
	statuses: Array<{ key: string; text: string | undefined }>;
	/** 评估调用记录（可注入裁决）。 */
	evaluations: Array<{ prompt: string; systemPrompt: string }>;
	/** 下一次评估返回的原始文本（undefined = 评估失败）。 */
	evaluatorReply: string | undefined;
}

async function loadHarness(
	env: Record<string, string | undefined> = {},
	options: { activeSubagents?: number } = {},
): Promise<Harness> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }>; runtime: Record<string, unknown> }>;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-verify-loop-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });

	// env 隔离：保存 → 覆盖 → 加载 → 还原（配置在工厂里一次性读取）。
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(env)) {
		saved[key] = process.env[key];
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}

	let loaded: Awaited<ReturnType<typeof pi.discoverAndLoadExtensions>>;
	try {
		// 子代理探测用的假总线：对 `status` 请求回「没有子代理在跑」。
		// 不回的话 `hasActiveSubagentWork` 会等满 1s 超时（fail-open 结果一样，但每个用例慢 1s）。
		const bus = createFakeEventBus(options.activeSubagents ?? 0);
		loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, bus);
	} finally {
		for (const key of Object.keys(saved)) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}

	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const extension = loaded.extensions[0];
	assert.ok(extension, "应该加载到 verify-loop 扩展");

	const harness: Harness = {
		appended: [],
		sentUserMessages: [],
		notifies: [],
		statuses: [],
		evaluations: [],
		evaluatorReply: undefined,
		settle: async () => undefined,
		goal: async () => undefined,
		startSession: async () => undefined,
	};

	// runner.bindCore 的测试等价物：把抛错桩换成记录器。
	loaded.runtime.appendEntry = (customType: string, data: unknown) => {
		harness.appended.push({ customType, data });
	};
	loaded.runtime.sendUserMessage = (content: string, options?: unknown) => {
		harness.sentUserMessages.push({ content, options });
	};

	let branchEntries: unknown[] = [];

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: projectDir,
		isIdle: () => true,
		signal: undefined,
		ui: {
			notify: (text: string) => harness.notifies.push(text),
			setStatus: (key: string, text: string | undefined) => harness.statuses.push({ key, text }),
		},
		sessionManager: {
			getBranch: () => branchEntries,
			buildContextEntries: () => branchEntries,
		},
		model: { provider: "litellm-any", id: "deepseek-flash" },
		modelRegistry: {
			find: () => ({ provider: "litellm-any", id: "qwen3.8-flash" }),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
			complete: async (_model: unknown, context: { systemPrompt?: string; messages: Array<{ content: Array<{ text?: string }> }> }) => {
				harness.evaluations.push({
					systemPrompt: context.systemPrompt ?? "",
					prompt: context.messages[0]?.content?.map((part) => part.text ?? "").join("") ?? "",
				});
				if (harness.evaluatorReply === undefined) throw new Error("evaluator unavailable");
				return { content: [{ type: "text", text: harness.evaluatorReply }] };
			},
		},
	};

	const settleHandler = extension.handlers.get("agent_before_settle")?.[0];
	const startHandler = extension.handlers.get("session_start")?.[0];
	const goalCommand = extension.commands.get("goal");
	assert.ok(settleHandler, "应该注册 agent_before_settle handler");
	assert.ok(goalCommand, "应该注册 /goal 命令");
	assert.ok(extension.messageRenderers.get(VERIFY_LOOP_CUSTOM_TYPE), "应该注册注入消息的渲染器");

	harness.settle = async (messages, outcome = "completed") =>
		settleHandler(
			{ type: "agent_before_settle", outcome, entries: [], continue: false, context: { contextMessages: messages } },
			ctx,
		);
	harness.goal = async (args) => goalCommand.handler(args, ctx);
	harness.startSession = async (entries = []) => {
		branchEntries = entries;
		if (startHandler) await startHandler({ type: "session_start", reason: "startup" }, ctx);
	};
	return harness;
}

function lastDraft(result: unknown): { customType?: string; content?: string; display?: boolean; details?: { kind?: string } } | undefined {
	const entries = (result as { entries?: unknown[] } | undefined)?.entries;
	if (!entries || entries.length === 0) return undefined;
	return entries[entries.length - 1] as { customType?: string; content?: string; display?: boolean; details?: { kind?: string } };
}

/**
 * 假的 pi 事件总线：只认 pi-subagents 的 RPC 频道，回 `fleet.totalActive = <n>`。
 * recap/subagents.ts 的 `isSubagentWorkActive` 读的就是这个字段。
 */
function createFakeEventBus(active = 0): { on: (channel: string, handler: (data: unknown) => void) => () => void; emit: (channel: string, data: unknown) => void } {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
		emit(channel, data) {
			const request = data as { requestId?: string; method?: string };
			if (channel !== "subagents:rpc:v1:request" || request.method !== "status") return;
			const replyChannel = `subagents:rpc:v1:reply:${request.requestId}`;
			for (const handler of handlers.get(replyChannel) ?? []) {
				handler({ success: true, data: { fleet: { totalActive: active } } });
			}
		},
	};
}

// =============================================================================
// 闸（CC 的 command 型 Stop hook）
// =============================================================================

test(
	"改了文件没验证 → block：注入 gate 消息并 continue",
	{ skip },
	async () => {
		const harness = await loadHarness();
		const messages = [
			user("改一下"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("完成了"),
		];
		const result = (await harness.settle(messages)) as { continue?: boolean } | undefined;
		assert.equal(result?.continue, true, "应该强制续跑一轮");
		const draft = lastDraft(result);
		assert.equal(draft?.customType, VERIFY_LOOP_CUSTOM_TYPE);
		assert.equal(draft?.details?.kind, "gate");
		assert.equal(draft?.display, true, "CC 的 Stop hook feedback 用户可见");
		assert.match(draft?.content ?? "", /no command was run/);
		assert.match(draft?.content ?? "", /src\/a\.js/);
	},
);

test(
	"改完跑过验证 → 放行",
	{ skip },
	async () => {
		const harness = await loadHarness();
		const messages = [
			user("改一下"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantToolCalls({ name: "bash", args: { command: "node --test adapter/tests/*.test.js" } }),
			toolResult(),
			assistantText("完成了"),
		];
		assert.equal(await harness.settle(messages), undefined);
	},
);

test(
	"aborted / error outcome 不触发闸（CC：abort 不触发 Stop，API 错误走 StopFailure）",
	{ skip },
	async () => {
		const harness = await loadHarness();
		const messages = [
			user("改一下"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("完成了"),
		];
		assert.equal(await harness.settle(messages, "aborted"), undefined);
		assert.equal(await harness.settle(messages, "error"), undefined);
	},
);

test(
	"PI_VERIFY_LOOP=notify → 只提示不拦",
	{ skip },
	async () => {
		const harness = await loadHarness({ PI_VERIFY_LOOP: "notify" });
		const messages = [
			user("改一下"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("完成了"),
		];
		const result = await harness.settle(messages);
		assert.equal(result, undefined, "notify 模式不应 continue");
		assert.ok(harness.notifies.some((text) => text.includes("[verify-loop]")), "应该有提示");
	},
);

test(
	"PI_VERIFY_LOOP=off → 什么都不做",
	{ skip },
	async () => {
		const harness = await loadHarness({ PI_VERIFY_LOOP: "off" });
		const messages = [
			user("改一下"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("完成了"),
		];
		assert.equal(await harness.settle(messages), undefined);
		assert.equal(harness.notifies.length, 0);
	},
);

test(
	"连续拦截达到上限 → 放行（CC 的强制放行）",
	{ skip },
	async () => {
		const harness = await loadHarness({ PI_VERIFY_LOOP_CAP: "1" });
		const messages = [
			user("改一下"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("完成了"),
			{ role: "custom", customType: VERIFY_LOOP_CUSTOM_TYPE, content: "...", details: { kind: "gate", at: 1 } },
			assistantText("还是完成了"),
		];
		assert.equal(await harness.settle(messages), undefined, "已拦过一次（上限 1）应放行");
	},
);

// =============================================================================
// /goal 命令
// =============================================================================

test(
	"/goal <条件>：落盘 + 指示器 + 立刻起一轮（条件即 directive）",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("临时文件里包含 HELLO");
		assert.equal(harness.appended.length, 1);
		assert.equal(harness.appended[0].customType, GOAL_ENTRY_TYPE);
		assert.equal((harness.appended[0].data as { condition: string }).condition, "临时文件里包含 HELLO");
		assert.equal(harness.sentUserMessages.length, 1, "CC：设定 goal 立即起一轮");
		assert.match(harness.sentUserMessages[0].content, /临时文件里包含 HELLO/);
		assert.ok(harness.statuses.some((s) => s.key === "verify-goal" && s.text === "◎ /goal active"));
	},
);

test(
	"/goal clear：清除并记录",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("条件A");
		await harness.goal("clear");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { condition: string }).condition, "");
		assert.ok(harness.notifies.some((text) => text.startsWith("Goal cleared")));
	},
);

test(
	"/goal stop 等别名同样清除",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("条件A");
		await harness.goal("stop");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { condition: string }).condition, "");
	},
);

test(
	"/goal（无参）：显示状态，不触发评估",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("条件A");
		harness.notifies.length = 0;
		await harness.goal("");
		assert.ok(harness.notifies.some((text) => text.includes("条件A")));
		assert.equal(harness.evaluations.length, 0);
	},
);

// =============================================================================
// 评估循环（CC 的 prompt 型 Stop hook / /goal 评估器）
// =============================================================================

async function settleWithGoal(harness: Harness, messages: Message[]): Promise<{ continue?: boolean } | undefined> {
	return (await harness.settle(messages)) as { continue?: boolean } | undefined;
}

test(
	"goal 活跃 + 未达成 → 注入裁决并续跑",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("所有测试通过");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"没看到测试输出"}';

		const messages = [
			user("开始"),
			assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
			toolResult(),
			assistantText("应该好了"),
		];
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, true, "未达成应续跑");
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-not-met");
		assert.match(draft?.content ?? "", /没看到测试输出/);
		assert.equal(harness.evaluations.length, 1, "评估器被调用一次");
		assert.match(harness.evaluations[0].prompt, /所有测试通过/, "条件在评估提示词里");
		assert.match(harness.evaluations[0].prompt, /\[Assistant\]/, "对话序列化在评估提示词里");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { evaluatedTurns: number }).evaluatedTurns, 1, "评估轮数落盘");
	},
);

test(
	"goal 达成 → 记录 achieved 条目、不再续跑",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("所有测试通过");
		harness.evaluatorReply = '{"verdict":"met","reason":"输出显示 34/34 通过"}';

		const messages = [
			user("开始"),
			assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
			toolResult(),
			assistantText("全过了"),
		];
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, undefined, "达成不应续跑");
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-met");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { status: string }).status, "achieved");

		// 达成后不再评估
		harness.evaluations.length = 0;
		await settleWithGoal(harness, [...messages, assistantText("继续别的")]);
		assert.equal(harness.evaluations.length, 0);
	},
);

test(
	"goal 不可能 → 清除并记录",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("让太阳从西边升起");
		harness.evaluatorReply = '{"verdict":"impossible","reason":"物理上不可能"}';

		const messages = [user("开始"), assistantText("这做不到")];
		const result = await settleWithGoal(harness, messages);
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-impossible");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { status: string }).status, "impossible");
	},
);

test(
	"评估器失败 → fail-open 放行（CC：hook 失败不拦回合）",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("所有测试通过");
		harness.evaluatorReply = undefined; // complete() 抛错

		const messages = [user("开始"), assistantText("完成了")];
		const result = await settleWithGoal(harness, messages);
		assert.equal(result, undefined, "评估失败应放行");
		assert.ok(harness.notifies.some((text) => text.includes("evaluation failed")));
	},
);

test(
	"评估器回的不是裁决 → fail-open 放行",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("所有测试通过");
		harness.evaluatorReply = "我觉得应该差不多了吧";

		const messages = [user("开始"), assistantText("完成了")];
		assert.equal(await settleWithGoal(harness, messages), undefined);
	},
);

test(
	"续跑次数到上限 → 停循环、goal 保留（CC 的 8 次强制放行）",
	{ skip },
	async () => {
		const harness = await loadHarness({ PI_GOAL_CAP: "2" });
		await harness.goal("所有测试通过");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"还差"}';

		const messages: Message[] = [user("开始")];
		for (let i = 0; i < 2; i += 1) {
			messages.push(
				{ role: "custom", customType: VERIFY_LOOP_CUSTOM_TYPE, content: "...", details: { kind: "goal-not-met", at: 1 } },
				assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
				toolResult(),
				assistantText("继续"),
			);
		}
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, undefined, "到上限不再续跑");
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-cap");
		assert.match(draft?.content ?? "", /condition is retained/);
	},
);

test(
	"连续无进展（只回文字不调工具）→ 停循环、goal 保留（CC 的无进展检测）",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("所有测试通过");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"还差"}';

		const messages: Message[] = [user("开始")];
		for (let i = 0; i < 2; i += 1) {
			messages.push(
				{ role: "custom", customType: VERIFY_LOOP_CUSTOM_TYPE, content: "...", details: { kind: "goal-not-met", at: 1 } },
				assistantText("我觉得已经完成了"),
			);
		}
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, undefined, "无进展不再续跑");
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-halted");
		assert.match(draft?.content ?? "", /no progress/);
		assert.equal(harness.evaluations.length, 0, "halt 判定在评估之前，不花模型调用");
	},
);

test(
	"后台子代理还在跑 → 本轮跳过评估（CC：background work defers evaluation）",
	{ skip },
	async () => {
		const harness = await loadHarness({}, { activeSubagents: 1 });
		await harness.goal("所有测试通过");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"还差"}';

		const messages = [user("开始"), assistantText("发出去了，等子代理")];
		assert.equal(await settleWithGoal(harness, messages), undefined, "子代理在跑时不评估也不续跑");
		assert.equal(harness.evaluations.length, 0);
	},
);

// =============================================================================
// 会话生命周期
// =============================================================================

test(
	"session_start：从分支条目恢复活跃 goal（CC：resume 恢复）",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.startSession([
			{ type: "custom", customType: GOAL_ENTRY_TYPE, data: { condition: "所有测试通过", setAt: 1, status: "active", evaluatedTurns: 3 } },
		]);
		assert.ok(harness.statuses.some((s) => s.key === "verify-goal" && s.text === "◎ /goal active"), "恢复后指示器应亮起");

		// 恢复的 goal 参与评估
		harness.evaluatorReply = '{"verdict":"met","reason":"done"}';
		const result = await settleWithGoal(harness, [user("继续"), assistantText("好了")]);
		assert.equal(lastDraft(result)?.details?.kind, "goal-met");
	},
);

test(
	"session_start：已达成的 goal 不恢复（CC：不恢复已达成/已清除的 goal）",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.startSession([
			{ type: "custom", customType: GOAL_ENTRY_TYPE, data: { condition: "旧条件", setAt: 1, status: "achieved", evaluatedTurns: 1 } },
		]);
		assert.ok(!harness.statuses.some((s) => s.key === "verify-goal" && s.text === "◎ /goal active"));
		assert.equal(await settleWithGoal(harness, [user("继续"), assistantText("好了")]), undefined);
	},
);

test(
	"闸与 goal 同时在场：闸优先（先补验证，再谈 goal）",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("所有测试通过");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"还差"}';

		const messages = [
			user("开始"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("完成了"),
		];
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, true);
		assert.equal(lastDraft(result)?.details?.kind, "gate", "闸先于 goal 评估");
		assert.equal(harness.evaluations.length, 0, "闸 block 时不花评估调用");
	},
);
