/**
 * Tests for working-indicator/index.ts — 「长提示词异步请模型压成一句话」这条链路。
 *
 * Run with:  node --test clients/pi/extensions/working-indicator/index.test.ts
 *
 * pi 自己的扩展加载器真的加载 `index.ts`（所以 `./summary-request.ts` 的 import、
 * 事件注册面都在覆盖范围内），假的是扩展外面的一切：ctx（录制 `setWorkingMessage`
 * 与 `modelRegistry.complete`）和事件总线的另一端。模型调用是手动 resolve 的
 * promise，于是「旧请求回来时新提示词已经就位」这类时序能被精确摆出来。
 *
 * 终端宽度：`process.stdout.columns` 在测试进程里是 undefined，`terminalWidth()` 退回
 * 80；于是可用宽度 = min(40 - 2, 76 - 34 - 1 - 2) = 38 列，触发线是 45.6 列（默认倍数 1.2）。
 * 用例里的长提示词都远超它、短提示词都远低于它。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	DEFAULT_FRAMES_PER_COLOR,
	SPINNER_COLOR_TOKENS,
	SPINNER_FRAMES,
	SPINNER_INTERVAL_MS,
} from "./spinner-frames.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态。
 *
 * 先从 `pi` 可执行文件反查**真正的安装位置**（pnpm/npm 的 shim 脚本里留有
 * `# cmd-shim-target=<绝对路径>`；npm 在 Unix 上则是符号链接，两种都试），再退回
 * `~/.pi/agent/npm` 那份副本 —— 后者是**扩展包的安装根**，`pi update --extensions` 会用
 * `--config.auto-install-peers=false` 把自动装进去的 `@earendil-works/pi-*` 同伴包剪掉，
 * 于是那份副本只剩空壳（文件都在、import 报 `ERR_MODULE_NOT_FOUND`；2026-09 升
 * pi-subagents 0.68.0 时实测踩到）。
 *
 * 判定方式是**能不能真 import**，不是路径存不存在 —— 只有真 import 一次才分得清空壳。
 * 全都不行就返回 undefined，调用方整体 skip（不假装通过）。
 */
async function findPiLibraryEntry(): Promise<string | undefined> {
	const candidates: string[] = [];
	if (process.env.PI_TEST_PI_ENTRY) candidates.push(process.env.PI_TEST_PI_ENTRY);

	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const shimPath = path.join(dir, "pi");
		try {
			// npm 的 shim 是符号链接
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
const skip = piEntry === undefined ? SKIP : false;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface TestBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

function createTestBus(): TestBus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set<(data: unknown) => void>();
			handlers.set(channel, set);
			set.add(handler);
			return () => {
				set.delete(handler);
			};
		},
		emit(channel, data) {
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
}

/** 一次 `modelRegistry.complete` 调用的记录。 */
interface CompleteCall {
	/** 请求提示词（user 消息里的文本）。 */
	prompt: string;
	maxTokens: number | undefined;
	temperature: number | undefined;
	/** 手动放行这次调用。 */
	resolve: (text: string) => void;
	/** 让这次调用失败（模型报错 / 超时）。 */
	reject: (error: Error) => void;
}

interface Recorder {
	completes: CompleteCall[];
	/** 每次 `setWorkingMessage(<string>)` 记一条。 */
	workingMessages: string[];
	/** 无参 `setWorkingMessage()`（回合结束恢复默认）次数。 */
	resets: number;
}

interface ContextOptions {
	/** 主题 `fg` 实现；缺省恒等（保持既有布局用例的宽度口径）。 */
	themeFg?: (color: string, text: string) => string;
	/** 每次 `setWorkingIndicator` 记一条（`undefined` = 无参调用，即恢复 pi 默认帧）。 */
	onIndicator?: (options: { frames?: string[]; intervalMs?: number } | undefined) => void;
}

/** 取请求上下文里的 user 文本（请求体形状由 `summary-request.ts` 决定）。 */
function promptTextOf(context: unknown): string {
	const messages = (context as { messages?: Array<{ content?: Array<{ text?: string }> }> }).messages ?? [];
	return messages.map((message) => message.content?.map((block) => block.text ?? "").join("") ?? "").join("");
}

function createContext(recorder: Recorder, options: ContextOptions = {}): unknown {
	return {
		mode: "tui",
		hasUI: true,
		model: { provider: "test", id: "test-model" },
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {} }),
			complete: (_model: unknown, context: unknown, options: { maxTokens?: number; temperature?: number }) =>
				new Promise((resolve, reject) => {
					recorder.completes.push({
						prompt: promptTextOf(context),
						maxTokens: options?.maxTokens,
						temperature: options?.temperature,
						resolve: (text: string) => resolve({ content: [{ type: "text", text }] }),
						reject,
					});
				}),
		},
		ui: {
			theme: { fg: options.themeFg ?? ((_color: string, text: string) => text) },
			setWorkingIndicator: (indicator?: { frames?: string[]; intervalMs?: number }) =>
				options.onIndicator?.(indicator),
			setWorkingMessage: (message?: string) => {
				if (message === undefined) recorder.resets += 1;
				else recorder.workingMessages.push(message);
			},
		},
	};
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-working-indicator-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	return {
		agentDir,
		projectDir,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

interface LoadedExtension {
	handlers: Map<string, Handler[]>;
	errors: Array<{ path: string; error: string }>;
}

/** 用 pi 自己的加载器加载本扩展（`./summary-request.ts` 等 import 也一起验证）。 */
async function loadExtension(workspace: { agentDir: string; projectDir: string }): Promise<LoadedExtension> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
	};
	const loaded = await pi.discoverAndLoadExtensions(
		[EXTENSION_PATH],
		workspace.projectDir,
		workspace.agentDir,
		createTestBus(),
	);
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.ok(extension);
	return extension;
}

function handlersOf(extension: LoadedExtension): {
	input: Handler;
	agentStart: Handler;
	agentSettled: Handler;
	shutdown: Handler;
} {
	const input = extension.handlers.get("input")?.[0];
	const agentStart = extension.handlers.get("agent_start")?.[0];
	const agentSettled = extension.handlers.get("agent_settled")?.[0];
	const shutdown = extension.handlers.get("session_shutdown")?.[0];
	assert.ok(input, "应该注册了 input");
	assert.ok(agentStart, "应该注册了 agent_start");
	assert.ok(agentSettled, "应该注册了 agent_settled");
	assert.ok(shutdown, "应该注册了 session_shutdown");
	return { input, agentStart, agentSettled, shutdown };
}

/** 等谓词成立；超时把「在等什么」一并报出来。 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`等不到：${what}（超时 ${timeoutMs}ms）`);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 远超 76 列触发线的多行中文提示词。 */
const LONG_PROMPT = [
	"帮我优化一下 working 行尾的提示词摘要",
	"现在长提示词被生硬地截断，看不出在干什么",
	"希望超过可显示宽度时让模型压成一句话",
	"而且这个请求要和主任务并行，不要互相影响",
].join("\n");

test("长提示词异步请求一次摘要，回来后替换行尾原文；请求不阻塞主回合", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, agentSettled, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);

		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);

		assert.equal(recorder.completes.length, 1, "长提示词应该发一次摘要请求");
		const call = recorder.completes[0];
		assert.ok(call);
		// 请求里带上了算好的目标长度（38 列可用 × 0.9 = 34）与列宽口径。
		assert.match(call.prompt, /34 display columns/);
		assert.match(call.prompt, /CJK\/full-width character counts as 2 columns/);
		// 压平后的原文整段都在（多行 → 一句）。
		assert.ok(call.prompt.includes("帮我优化一下 working 行尾的提示词摘要"));
		// 不传 temperature：本机这些路由在 0 温度下会退化成停不下来的长思考（实测）。
		assert.equal(call.temperature, undefined);
		// maxTokens 必须容下强制 thinking（网关给这些路由写死了 thinking: enabled，关不掉）。
		assert.ok((call.maxTokens ?? 0) >= 512, `maxTokens 应给 thinking 留足份额，实际 ${call.maxTokens}`);

		// 摘要还没回来：先显示的是截断后的原文。
		const before = recorder.workingMessages.at(-1) ?? "";
		assert.match(before, /✦ /);
		assert.ok(!before.includes("模型压缩"), "模型还没回包时不该凭空出现摘要");

		call.resolve("把行尾长提示词交给模型压成一句话");

		await waitFor(
			() => (recorder.workingMessages.at(-1) ?? "").includes("把行尾长提示词交给模型压成一句话"),
			"摘要替换成模型返回的一句话",
		);
		const after = recorder.workingMessages.at(-1) ?? "";
		assert.ok(after.includes("✦ "), "摘要仍带 `✦ ` 前缀");
		assert.ok(!after.includes("希望超过可显示宽度时"), "摘要应该顶掉原文，而不是两者并存");

		await agentSettled({}, ctx);
		assert.equal(recorder.resets, 1, "回合结束应恢复 pi 默认文案");
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("请求不阻塞 input：模型永不回包时 input handler 也立刻返回", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		const startedAt = Date.now();
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		const elapsed = Date.now() - startedAt;
		assert.equal(recorder.completes.length, 1, "请求已发出");
		assert.ok(elapsed < 500, `input handler 不能等模型（耗时 ${elapsed}ms）`);

		// 请求一直挂着也不影响后续事件：回合照常结束。
		await handlersOf(extension).agentSettled({}, ctx);
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("短提示词不请求；同一条消息重复 input 也不重复请求", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: "hi", source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await delay(50);
		assert.equal(recorder.completes.length, 0, "短提示词整段放得下，不该请求");

		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 1, "第一次长提示词请求");
		// 扩展命令的 sendUserMessage 会让同一条消息走两次 input。
		await input({ text: LONG_PROMPT, source: "extension" }, ctx);
		await delay(50);
		assert.equal(recorder.completes.length, 1, "同一条文本重复触发不该重新请求");

		// 换一条真正不同的长提示词才会发第二次。
		await input({ text: `${LONG_PROMPT}（第二版）`, source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 2, "新提示词的第二次请求");
		assert.ok(recorder.completes[1]?.prompt.includes("（第二版）"));

		// 会话被替换后，同一条文本必须重新请求（去重键不能跨会话留着）。
		await shutdown({}, ctx);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 3, "新会话里的同一条提示词");
	} finally {
		workspace.cleanup();
	}
});

test("新提示词作废旧请求：旧摘要回来也不会顶掉新的", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "第一条提示词的请求");
		await input({ text: `${LONG_PROMPT} 改成模型压缩`, source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 2, "第二条提示词的请求");

		// 旧请求后回来：必须被丢弃（abort + 序号两道护栏）。
		recorder.completes[0]?.resolve("第一条的摘要");
		await delay(50);
		assert.ok(
			!recorder.workingMessages.some((message) => message.includes("第一条的摘要")),
			"过期摘要绝不能显示",
		);

		recorder.completes[1]?.resolve("第二条的摘要");
		await waitFor(
			() => (recorder.workingMessages.at(-1) ?? "").includes("第二条的摘要"),
			"当前提示词的摘要",
		);

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("摘要超长只截断、不重试：每个提示词始终只请求一次", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "摘要请求");
		const overlong = "这是一段远超可用宽度的模型摘要".repeat(20);
		recorder.completes[0]?.resolve(overlong);

		await waitFor(
			() => (recorder.workingMessages.at(-1) ?? "").includes("…"),
			"超长摘要被截断补省略号",
		);
		const message = recorder.workingMessages.at(-1) ?? "";
		assert.ok(!message.includes("这是一段远超可用宽度的模型摘要这是一段"), "超长摘要应被截掉大半");
		// 等过一个 1s tick，确认没有任何「第二次请求」。
		await delay(1_200);
		assert.equal(recorder.completes.length, 1, "回来的摘要再长也不重试");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("模型报错 / 不支持的上下文里静默退回截断后的原文", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "摘要请求");
		recorder.completes[0]?.reject(new Error("boom"));

		await delay(100);
		const message = recorder.workingMessages.at(-1) ?? "";
		assert.ok(message.includes("✦ "), "失败后仍显示摘要段（这里是截断后的原文）");
		assert.ok(message.includes("帮我优化"), "原文前缀还在");
		assert.equal(recorder.completes.length, 1, "失败不重试");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

// ---------------------------------------------------------------------------
// spinner 幻彩帧（`spinner-frames.ts` + index.ts 的三个安装时机）
// ---------------------------------------------------------------------------

/** 七色假主题；`colors` 就地改就是「换肤」（`theme.fg` 的 live proxy 替身）。 */
function createMutableTheme(): { colors: Record<string, string>; fg: (color: string, text: string) => string } {
	const colors: Record<string, string> = Object.fromEntries(
		SPINNER_COLOR_TOKENS.map((token, index) => [token, `<c${index}>`]),
	);
	return { colors, fg: (color, text) => `${colors[color] ?? `<${color}>`}${text}` };
}

/** 一次 `setWorkingIndicator` 调用的记录（`undefined` = 无参调用，即恢复 pi 默认帧）。 */
type IndicatorCall = { frames?: string[]; intervalMs?: number } | undefined;

test("回合开始装上幻彩帧表：十帧盲文 × 七色、间隔 80ms、每色 19 帧（≈1.5s）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const theme = createMutableTheme();
		const calls: IndicatorCall[] = [];
		const ctx = createContext(recorder, { themeFg: theme.fg, onIndicator: (o) => calls.push(o) });

		await agentStart({}, ctx);

		const installed = calls.at(-1);
		assert.ok(installed, "agent_start 应该装一次 indicator");
		assert.equal(installed.intervalMs, SPINNER_INTERVAL_MS);
		const frames = installed.frames as string[];
		// 帧表周期 = lcm(10, 19 × 7) = 1330：既是一轮调色板的整数倍，也是盲文圈长的整数倍（回绕不跳色）。
		assert.equal(frames.length, 1330);
		assert.equal(frames.length % (DEFAULT_FRAMES_PER_COLOR * SPINNER_COLOR_TOKENS.length), 0);
		assert.equal(frames.length % SPINNER_FRAMES.length, 0);
		for (const [index, frame] of frames.entries()) {
			assert.equal(frame.at(-1), SPINNER_FRAMES[index % SPINNER_FRAMES.length]);
			assert.equal(
				frame.slice(0, -1),
				theme.colors[
					SPINNER_COLOR_TOKENS[
						Math.floor(index / DEFAULT_FRAMES_PER_COLOR) % SPINNER_COLOR_TOKENS.length
					] as string
				],
			);
		}

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("换主题后一秒内重装帧表：指纹没变不重装、变了才重装", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, shutdown } = handlersOf(extension);
		const messageUpdate = extension.handlers.get("message_update")?.[0];
		assert.ok(messageUpdate, "应该注册了 message_update");
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const theme = createMutableTheme();
		const calls: IndicatorCall[] = [];
		const ctx = createContext(recorder, { themeFg: theme.fg, onIndicator: (o) => calls.push(o) });

		await agentStart({}, ctx);
		assert.equal(calls.length, 1, "回合开始装一次");

		// 主题没变：每个流式 delta 都跑的 refresh 不该反复重装（重装会复位动画相位）。
		await messageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "hi" } }, ctx);
		await messageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "!" } }, ctx);
		assert.equal(calls.length, 1, "指纹没变就不该重装");

		// 换肤：下一次 refresh 现读到的新颜色让指纹变化 → 重装。
		theme.colors.accent = "<new-accent>";
		await messageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "?" } }, ctx);
		assert.equal(calls.length, 2, "换肤后应该重装一次");
		const refreshed = calls[1]?.frames?.[0] as string;
		assert.ok(refreshed.startsWith("<new-accent>"), `新帧表应该用新主题的颜色，实际 ${refreshed}`);

		// 再刷新也不会重复装。
		await messageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "?" } }, ctx);
		assert.equal(calls.length, 2, "同主题下不该再装");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("问卷结束时补装彩帧（ask-user-question 的冻结会把它换成 pi 默认帧）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, shutdown } = handlersOf(extension);
		const toolEnd = extension.handlers.get("tool_execution_end")?.[0];
		assert.ok(toolEnd, "应该注册了 tool_execution_end");
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const theme = createMutableTheme();
		const calls: IndicatorCall[] = [];
		const ctx = createContext(recorder, { themeFg: theme.fg, onIndicator: (o) => calls.push(o) });

		await agentStart({}, ctx);
		const afterStart = calls.length;

		// 别的工具结束不碰 indicator（每次工具结束都重装会把动画相位按工具调用切碎）。
		await toolEnd({ toolCallId: "1", toolName: "bash" }, ctx);
		assert.equal(calls.length, afterStart, "非问卷工具不该重装");

		// 问卷结束：补装一次彩帧（questionnaire 的 finally 已经无参恢复成 pi 默认帧）。
		await toolEnd({ toolCallId: "2", toolName: "ask_user_question" }, ctx);
		assert.equal(calls.length, afterStart + 1, "问卷结束应该补装");
		assert.equal((calls.at(-1)?.frames as string[]).length, 1330);

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("单色主题（NO_COLOR / 恒等 fg）不下发帧表，而是无参交回 pi 默认 spinner", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const calls: IndicatorCall[] = [];
		// 不传 themeFg：既有 fake ctx 的恒等主题，七个色槽取出来是同一个颜色。
		const ctx = createContext(recorder, { onIndicator: (o) => calls.push(o) });

		await agentStart({}, ctx);

		assert.equal(calls.length, 1, "仍然要交回一次控制权");
		assert.equal(calls[0], undefined, "单色主题应恢复 pi 默认帧而不是装一张假动画");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});
