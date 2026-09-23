/**
 * Tests for index.ts — plan-mode 的事件接线（用 pi 自己的加载器真实加载）。
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/index.test.ts
 *
 * pi 的扩展加载器真的加载 `index.ts`（所以 `./plan.ts` / `./plan-text.ts` / `./render.ts`
 * 的 import 与注册面都在覆盖范围内），假的是扩展外面的一切：ctx（录制 setStatus /
 * setWidget / notify / onTerminalInput / isIdle）、pi 的 API（录制 setActiveTools /
 * appendEntry / sendMessage）、以及会话条目。
 *
 * 覆盖的是**接线**而不是纯逻辑（纯逻辑在 plan.test.ts / plan-text.test.ts /
 * render.test.ts 里）。所以断言集中在：谁在什么时候改了活动工具、状态行写了什么、
 * swap 键什么时候被 consume、写命令什么时候被拦。渲染细节不在这里重复测。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { THINKING_FALLBACK_KEY } from "./keybinding.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态。
 * 判定方式是**能不能真 import**（`~/.pi/agent/npm` 那份副本可能是被剪过的空壳），
 * 全都不行就整体 skip，不假装通过。与 working-indicator/index.test.ts 同一套做法。
 */
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
			// 不是符号链接：看下面的 shim 脚本
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
type InputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

interface LoadedExtension {
	handlers: Map<string, Handler[]>;
	tools: Map<string, unknown>;
	shortcuts: Map<string, unknown>;
	flags: Map<string, unknown>;
	errors: Array<{ path: string; error: string }>;
	/** 测试挂上去的：真实的活动工具数组（runtime.getActiveTools 读的就是它）。 */
	__activeTools: string[];
	__runtime: RuntimeLike;
	/** 测试挂上去的：模拟 simple-task 广播一次状态快照。 */
	__emitTaskState: (data: unknown) => void;
}

/** 默认活动工具：含 pi 的写工具与两个模拟的扩展/ MCP 工具。 */
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "ls", "task_set", "mcp__x__y"];

function createTestBus(rec?: Recorder): {
	emit: (channel: string, data: unknown) => void;
	on: (channel: string, handler: (data: unknown) => void) => () => void;
} {
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
			rec?.emits.push({ channel, data });
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
}

async function loadExtension(
	agentDir: string,
	projectDir: string,
	rec: Recorder,
	flagValues?: Map<string, unknown>,
): Promise<LoadedExtension> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{
			extensions: LoadedExtension[];
			errors: Array<{ path: string; error: string }>;
			runtime: RuntimeLike;
		}>;
	};

	// 用 pi 自己的加载器把扩展装好，拿到它共用的那个 runtime，再把 action 方法接上。
	// 于是测试走的是扩展真实会调用的那条路（`pi.setActiveTools()` 会打到我们接的录制器），
	// 而不是另造一个假 pi 对象 —— 假的 pi 无法验证「扩展调的到底是不是 pi 的 API」。
	const bus = createTestBus(rec);
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, bus);
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.ok(extension);
	// 测试用：模拟 simple-task 广播状态快照（正式契约见 simple-task/plan-mirror.ts）。
	(extension as unknown as { __emitTaskState: (data: unknown) => void }).__emitTaskState = (data) =>
		bus.emit("simple-task:state", data);

	const active: string[] = [...DEFAULT_TOOLS];
	Object.assign(loaded.runtime, {
		sendMessage: async (message: { content: string }) => {
			rec.messages.push(message);
		},
		sendUserMessage: async () => {},
		appendEntry: (customType: string, data: unknown) => {
			rec.entries.push({ customType, data });
		},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [...active],
		getAllTools: () => [],
		setActiveTools: (names: string[]) => {
			active.length = 0;
			active.push(...names);
			rec.toolSets.push([...names]);
		},

		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => true,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
	});

	// `pi.getFlag()` 读 runtime.flagValues；默认值在扩展注册 flag 时就已经写进去了，
	// 这里只覆盖测试显式指定的那几项。
	if (flagValues) {
		for (const [name, value] of flagValues) loaded.runtime.flagValues?.set(name, value);
	}

	extension.__activeTools = active;
	extension.__runtime = loaded.runtime;
	return extension;
}

interface RuntimeLike {
	flagValues?: Map<string, unknown>;
	setActiveTools?: (names: string[]) => void;
}


interface Recorder {
	/** 每次 setStatus 记一条 `key=值`（undefined 记为 `key=<undefined>`）。 */
	statuses: string[];
	/** 每次 setWidget 记一条 `key=行数`（undefined 记为 `<undefined>`）。 */
	widgets: string[];
	notifies: string[];
	/** 录制的工具集变更，按发生顺序。 */
	toolSets: string[][];
	entries: Array<{ customType: string; data: unknown }>;
	messages: Array<{ content: string }>;
	/** 扩展广播出去的事件（plan-mode → simple-task 的镜像同步）。 */
	emits: Array<{ channel: string; data: unknown }>;
}

interface ContextOptions {
	hasUI?: boolean;
	mode?: string;
	idle?: boolean;
	confirmResult?: boolean;
	/** 已经存在的活动工具（默认一份含扩展工具的清单）。 */
	activeTools?: string[];
	/** sessionManager 返回的条目；`getBranch()` 与 `getEntries()` 都取它。 */
	entries?: unknown[];
	flagValues?: Map<string, unknown>;
}

function makeContext(extension: LoadedExtension, recorder: Recorder, options: ContextOptions = {}) {
	const inputHandlers: InputHandler[] = [];

	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		cwd: "/repo",
		isIdle: () => options.idle ?? true,
		sessionManager: {
			getEntries: () => options.entries ?? [],
			getBranch: () => options.entries ?? [],
		},
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				strikethrough: (text: string) => text,
			},
			setStatus: (key: string, value: string | undefined) => {
				recorder.statuses.push(`${key}=${value === undefined ? "<undefined>" : value}`);
			},
			setWidget: (key: string, content: string[] | undefined) => {
				recorder.widgets.push(`${key}=${content === undefined ? "<undefined>" : content.length}`);
			},
			notify: (message: string) => {
				recorder.notifies.push(message);
			},
			confirm: async () => options.confirmResult ?? true,
			onTerminalInput: (handler: InputHandler) => {
				inputHandlers.push(handler);
				return () => {
					const index = inputHandlers.indexOf(handler);
					if (index !== -1) inputHandlers.splice(index, 1);
				};
			},
		},
		/**
		 * 测试用：按 pi 的真实行为广播一次按键 —— 所有在册监听器都会收到，
		 * 任一返回 `consume` 就短路（`TuiBase.handleTerminalInput` 的语义）。
		 * 所以「重复注册」不会被这里掩盖：注册两次就会切两次。
		 */
		__feedInput: (data: string) => {
			for (const handler of [...inputHandlers]) {
				const result = handler(data);
				if (result?.consume) return result;
			}
			return undefined;
		},
		/** 测试用：当前在册的监听器数量（验证防重入）。 */
		__listenerCount: () => inputHandlers.length,
	};

	return { ctx, getActiveTools: () => [...extension.__activeTools] };
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-mode-"));
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

function recorder(): Recorder {
	return { statuses: [], widgets: [], notifies: [], toolSets: [], entries: [], messages: [], emits: [] };
}

function handlerOf(extension: LoadedExtension, name: string): Handler {
	const handler = extension.handlers.get(name)?.[0];
	assert.ok(handler, `应该注册了 ${name}`);
	return handler;
}

interface RegisteredTool {
	definition: {
		name: string;
		execute: (
			toolCallId: string,
			params: unknown,
			signal: unknown,
			onUpdate: unknown,
			ctx: unknown,
		) => Promise<unknown>;
	};
}

/** 取注册的工具定义（pi 存的是 `{ definition, sourceInfo }`）。 */
function toolOf(extension: LoadedExtension, name: string): RegisteredTool {
	const tool = extension.tools.get(name);
	assert.ok(tool, `应该注册了工具 ${name}`);
	return tool as RegisteredTool;
}

/** 调用工具（`execute` 在 `definition` 上）。 */
function callTool(
	extension: LoadedExtension,
	name: string,
	params: unknown,
	ctx: unknown,
): Promise<{ content: Array<{ text: string }> }> {
	const tool = toolOf(extension, name);
	return tool.definition.execute("call-1", params, undefined, undefined, ctx) as Promise<{ content: Array<{ text: string }> }>;
}

const sessionStart = (extension: LoadedExtension, ...args: Parameters<Handler>) => handlerOf(extension, "session_start")(...args);
const beforeAgentStart = (extension: LoadedExtension, ...args: Parameters<Handler>) => handlerOf(extension, "before_agent_start")(...args);
const toolCall = (extension: LoadedExtension, ...args: Parameters<Handler>) => handlerOf(extension, "tool_call")(...args);
const messageEnd = (extension: LoadedExtension, ...args: Parameters<Handler>) => handlerOf(extension, "message_end")(...args);

/** 启动一个会话（session_start + before_agent_start，模拟一次完整回合的前半段）。 */
async function startSession(
	extension: LoadedExtension,
	recorder: Recorder,
	options: ContextOptions = {},
): Promise<SessionHarness> {
	setActiveToolsOf(extension, options.activeTools ?? DEFAULT_TOOLS);
	const harness = makeContext(extension, recorder, options);
	await sessionStart(extension, { reason: "startup" }, harness.ctx);
	await beforeAgentStart(extension, { prompt: "hi", systemPrompt: "", systemPromptOptions: {} }, harness.ctx);
	return harness;
}

interface SessionHarness {
	ctx: Record<string, unknown> & { __feedInput: (data: string) => { consume?: boolean } | undefined };
	getActiveTools: () => string[];
}

/** 把 pi 那侧的活动工具表设成给定值（模拟会话启动时的加载结果）。 */
function setActiveToolsOf(extension: LoadedExtension, tools: string[]): void {
	extension.__runtime.setActiveTools?.(tools);
}

// =============================================================================
// 加载与注册面
// =============================================================================

test("扩展能被 pi 的加载器加载，并注册两个工具与一条命令", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		assert.ok(extension.tools.has("enter_plan_mode"), "应注册 enter_plan_mode");
		assert.ok(extension.tools.has("exit_plan_mode"), "应注册 exit_plan_mode");
		assert.equal(extension.shortcuts.size, 0, "shift+tab 走原始输入拦截，不该注册快捷键");
		assert.ok(extension.flags.has("plan"), "应注册 --plan flag");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// shift+tab
// =============================================================================

test("shift+tab 在空闲时切进 plan 并 consume；写工具被摘掉、扩展工具保留", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = harness.ctx.__feedInput("\x1b[Z");
		assert.deepEqual(result, { consume: true }, "shift+tab 必须被吃掉，否则会落到编辑器上");
		assert.deepEqual(harness.getActiveTools(), ["read", "bash", "grep", "ls", "task_set", "mcp__x__y"]);
		assert.ok(rec.statuses.at(-1)?.includes("plan"), `状态行应显示 plan，实际 ${rec.statuses.at(-1)}`);
	} finally {
		workspace.cleanup();
	}
});

test("三种 shift+tab 编码都能切（裸 CSI / Kitty CSI-u / modifyOtherKeys）", { skip, timeout: 30_000 }, async () => {
	// 回归：`shift+tab` 有三种编码，硬编码比对其中一种会在启用了 Kitty 键盘协议的终端上完全失效
	// （实测踩到：pty 里能切、真实 Ghostty 里按 shift+tab 没反应）。必须走 pi 自己的 matchesKey。
	const encodings: Array<[string, string]> = [
		["裸 CSI", "\x1b[Z"],
		["Kitty CSI-u", "\x1b[9;2u"],
		["xterm modifyOtherKeys", "\x1b[27;2;9~"],
	];
	for (const [label, sequence] of encodings) {
		const workspace = makeWorkspace();
		try {
			const rec = recorder();
			const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
			const harness = await startSession(extension, rec);

			const result = harness.ctx.__feedInput(sequence);
			assert.deepEqual(result, { consume: true }, `${label} 应该被 consume`);
			assert.ok(!harness.getActiveTools().includes("write"), `${label} 应该切进 plan`);
			assert.match(rec.statuses.at(-1) ?? "", /plan/, `${label} 状态行应显示 plan`);
		} finally {
			workspace.cleanup();
		}
	}
});

test("再按一次 shift+tab 退出，活动工具原样还原", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		const before = harness.getActiveTools();

		harness.ctx.__feedInput("\x1b[Z");
		harness.ctx.__feedInput("\x1b[Z");

		assert.deepEqual(harness.getActiveTools(), before, "退出后必须逐字还原（含扩展工具）");
		assert.match(rec.statuses.at(-1) ?? "", /⏵ normal/, "退出后回到 normal 模式指示");
	} finally {
		workspace.cleanup();
	}
});

test("重复 session_start 不叠加监听器（一次 shift+tab 只切一次）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec);

		// /reload、/new、/resume 都会再跑一次 session_start。
		await sessionStart(extension, { reason: "startup" }, harness.ctx);
		await sessionStart(extension, { reason: "reload" }, harness.ctx);
		await sessionStart(extension, { reason: "new" }, harness.ctx);

		// 三次 session_start 之后仍然只有一个在册监听器 —— 否则 pi 广播时会被切多次。
		const count = (harness.ctx as unknown as { __listenerCount: () => number }).__listenerCount();
		assert.equal(count, 1, `监听器不该叠加，实际在册 ${count} 个`);

		// 一次 shift+tab 只切一次 → 进 plan（而不是切两次回到 normal）。
		const result = harness.ctx.__feedInput("\x1b[Z");
		assert.deepEqual(result, { consume: true });
		assert.ok(!harness.getActiveTools().includes("write"), "一次按键应该只切一次：应停在 plan 态");
		const status = rec.statuses.at(-1) ?? "";
		assert.ok(status.includes("plan"), `状态行应是 plan，实际 ${status}`);
	} finally {
		workspace.cleanup();
	}
});

test("其它按键与忙碌时不抢键（不 consume）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);

		// 普通字符
		const busy = await startSession(extension, rec);
		assert.equal(busy.ctx.__feedInput("a"), undefined);
		assert.equal(busy.ctx.__feedInput("tab"), undefined, "裸 tab 不是 shift+tab");
		assert.deepEqual(busy.getActiveTools(), busy.getActiveTools(), "工具表不该被改");

		// 流式中（不空闲）：让 pi 的思考等级循环照常工作
		const streaming = await startSession(extension, rec, { idle: false });
		assert.equal(streaming.ctx.__feedInput("\x1b[Z"), undefined, "忙碌时不抢键");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// 模型自动进入
// =============================================================================

test("enter_plan_mode 工具让模型自己进 plan，并回一段说明", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = await callTool(extension, "enter_plan_mode", { reason: "要改多个文件" }, harness.ctx);

		assert.match(result.content[0]!.text, /已进入 plan mode/);
		assert.match(result.content[0]!.text, /exit_plan_mode/, "要告诉模型怎么出去");
		assert.ok(!harness.getActiveTools().includes("write"), "进 plan 后写工具必须停用");
	} finally {
		workspace.cleanup();
	}
});

test("--plan flag 让会话启动就进 plan", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec, new Map([["plan", true]]));
		const harness = makeContext(extension, rec);

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		assert.ok(!harness.getActiveTools().includes("edit"), "--plan 应摘掉写工具");
		assert.ok(rec.notifies.some((message) => message.includes("plan mode")), "应提示已进入");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// exit_plan_mode：批准 / 打回
// =============================================================================

const PLAN_STEPS = [{ text: "改 plan.ts" }, { text: "补测试" }];

test("提交计划并被批准：进 execute、工具还原、状态行显示进度", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		const before = harness.getActiveTools();

		harness.ctx.__feedInput("\x1b[Z");
		const result = await callTool(extension, "exit_plan_mode", { steps: PLAN_STEPS }, harness.ctx);

		assert.match(result.content[0]!.text, /已批准/);
		assert.deepEqual(harness.getActiveTools(), before, "批准后写权限必须回来");
		const status = rec.statuses.at(-1) ?? "";
		assert.ok(status.includes("0/2") || status.includes("execute"), `状态行应显示执行进度，实际 ${status}`);
	} finally {
		workspace.cleanup();
	}
});

test("用户打回：留在 plan（只读），并要求模型改方案", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, { confirmResult: false });

		harness.ctx.__feedInput("\x1b[Z");
		const result = await callTool(extension, "exit_plan_mode", { steps: PLAN_STEPS }, harness.ctx);

		assert.match(result.content[0]!.text, /没有批准/);
		assert.ok(!harness.getActiveTools().includes("write"), "打回后仍然是只读");
	} finally {
		workspace.cleanup();
	}
});

test("不在 plan 时调 exit_plan_mode：明确拒绝，不改变状态", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = await callTool(extension, "exit_plan_mode", { steps: PLAN_STEPS }, harness.ctx);
		assert.match(result.content[0]!.text, /不在 plan mode/);
	} finally {
		workspace.cleanup();
	}
});

test("空计划被拒绝", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");

		const result = await callTool(extension, "exit_plan_mode", { steps: [{ text: "   " }] }, harness.ctx);
		assert.match(result.content[0]!.text, /空的/);
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// 写操作拦截
// =============================================================================

test("plan 阶段写类 bash 被拦下并把原因回给模型；只读命令放行", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");

		const blocked = (await toolCall(
			extension,
			{ toolName: "bash", toolCallId: "t1", input: { command: "rm -rf dist" } },
			harness.ctx,
		)) as { block?: boolean; reason?: string };
		assert.equal(blocked.block, true);
		assert.match(blocked.reason ?? "", /plan mode/);
		assert.match(blocked.reason ?? "", /exit_plan_mode/, "要告诉模型正确的出路");

		const allowed = await toolCall(
			extension,
			{ toolName: "bash", toolCallId: "t2", input: { command: "git status" } },
			harness.ctx,
		);
		assert.equal(allowed, undefined, "只读命令不该被拦");

		const writeTool = await toolCall(
			extension,
			{ toolName: "write", toolCallId: "t3", input: { path: "/repo/a.txt", content: "x" } },
			harness.ctx,
		);
		assert.equal(writeTool, undefined, "工具表已摘掉 write；这里不重复拦（避免双重报错）");
	} finally {
		workspace.cleanup();
	}
});

test("normal 态不拦写命令", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		assert.equal(await toolCall(extension, { toolName: "bash", toolCallId: "t4", input: { command: "rm -rf dist" } }, harness.ctx), undefined);
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// 进度追踪
// =============================================================================

test("[DONE:n] 推进进度、从助手消息里清掉；全部完成自动回到 normal", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		const before = harness.getActiveTools();

		harness.ctx.__feedInput("\x1b[Z");
		await callTool(extension, "exit_plan_mode", { steps: PLAN_STEPS }, harness.ctx);

		// 第一步完成
		const first = (await messageEnd(
			extension,
			{ message: { role: "assistant", content: [{ type: "text", text: "第一步好了 [DONE:1]" }] } },
			harness.ctx,
		)) as { message?: { content: Array<{ text: string }> } } | undefined;
		assert.ok(first?.message, "带标记的消息应被改写");
		assert.ok(!first.message.content[0]!.text.includes("[DONE:1]"), "标记不该留在用户看到的文本里");
		assert.ok(!rec.messages.some((message) => message.content.includes("执行完毕")), "还没做完不该报名");

		// 第二步完成 → 自动收尾
		await messageEnd(
			extension,
			{ message: { role: "assistant", content: [{ type: "text", text: "第二步好了 [DONE:2]" }] } },
			harness.ctx,
		);
		assert.ok(rec.messages.some((message) => message.content.includes("执行完毕")), "全部完成应报一句");
		assert.match(rec.statuses.at(-1) ?? "", /⏵ normal/, "完成后回到 normal 模式指示");
		assert.deepEqual(harness.getActiveTools(), before, "完成后工具表回到进入前的样子");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// 与 simple-task 的镜像（唯一进度表）
// =============================================================================

/** 取最后一次发往 simple-task 的镜像快照。 */
function lastMirror(rec: Recorder): Array<{ step: number; text: string; done: boolean }> | undefined {
	const hit = [...rec.emits].reverse().find((e) => e.channel === "plan-mode:sync-tasks");
	return hit ? (hit.data as Array<{ step: number; text: string; done: boolean }>) : undefined;
}

/** 模拟 simple-task 广播回来的状态（带 `plan:` 前缀的镜像条目）。 */
function taskState(items: Array<{ step: number; status: "pending" | "in_progress" | "done" }>) {
	return {
		items: items.map((item) => ({ id: item.step, text: `plan: ${item.step}. 步骤`, status: item.status })),
	};
}

test("批准计划时把步骤镜像给 simple-task，且不再画自己的步骤 widget", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");

		// plan 阶段待批时仍由自己画（enter 时还没有步骤，所以是 undefined；提交后才出现）
		rec.widgets.length = 0;
		rec.emits.length = 0;
		await callTool(extension, "exit_plan_mode", { steps: PLAN_STEPS }, harness.ctx);

		assert.deepEqual(
			lastMirror(rec),
			[
				{ step: 1, text: "改 plan.ts", done: false },
				{ step: 2, text: "补测试", done: false },
			],
			"批准后应把全量步骤镜像出去（simple-task 据此建 #1..#2）",
		);
		assert.ok(
			rec.widgets.includes("plan-steps=2"),
			`提交待批时应自己画步骤，实际 ${JSON.stringify(rec.widgets)}`,
		);
		assert.equal(
			rec.widgets.at(-1),
			"plan-steps=<undefined>",
			`批准（execute）后不该再画自己的步骤清单（只有一份进度表），实际 ${JSON.stringify(rec.widgets)}`,
		);
	} finally {
		workspace.cleanup();
	}
});

test("task_update 的进度通过 simple-task 广播回来驱动状态行", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");
		await callTool(extension, "exit_plan_mode", { steps: PLAN_STEPS }, harness.ctx);
		assert.match(rec.statuses.at(-1) ?? "", /0\/2/, "刚批准时是 0/2");

		// simple-task 广播「第 1 步完成」：状态行必须跟着走，且不需要模型写 [DONE:n]
		extension.__emitTaskState(taskState([{ step: 1, status: "done" }, { step: 2, status: "in_progress" }]));
		assert.match(rec.statuses.at(-1) ?? "", /1\/2/, `状态行应显示 1/2，实际 ${rec.statuses.at(-1)}`);

		// 全部完成 → 自动收尾、回 normal、工具还原
		extension.__emitTaskState(taskState([{ step: 1, status: "done" }, { step: 2, status: "done" }]));
		assert.ok(rec.messages.some((m) => m.content.includes("执行完毕")), "全部完成应报一句");
		assert.match(rec.statuses.at(-1) ?? "", /⏵ normal/, "完成后回到 normal 模式指示");
	} finally {
		workspace.cleanup();
	}
});

test("手建任务不推进计划进度（id 撞上步号也不算）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");
		await callTool(extension, "exit_plan_mode", { steps: PLAN_STEPS }, harness.ctx);

		extension.__emitTaskState({ items: [{ id: 1, text: "手建的任务", status: "done" }] });
		assert.match(rec.statuses.at(-1) ?? "", /0\/2/, `手建任务不该被当成计划的第 1 步，实际 ${rec.statuses.at(-1)}`);
	} finally {
		workspace.cleanup();
	}
});

test("[DONE:n] 仍会推进，并把带标记的进度重新镜像出去", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");
		await callTool(extension, "exit_plan_mode", { steps: PLAN_STEPS }, harness.ctx);
		rec.emits.length = 0;

		await messageEnd(
			extension,
			{ message: { role: "assistant", content: [{ type: "text", text: "好了 [DONE:1]" }] } },
			harness.ctx,
		);

		assert.match(rec.statuses.at(-1) ?? "", /1\/2/, `[DONE:1] 应推进到 1/2，实际 ${rec.statuses.at(-1)}`);
		assert.equal(lastMirror(rec)?.[0]?.done, true, "推进后要重发镜像，让任务清单同步");
	} finally {
		workspace.cleanup();
	}
});

test("退出 plan 时清掉镜像（手建任务保留在 simple-task 那边）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");
		await callTool(extension, "exit_plan_mode", { steps: PLAN_STEPS }, harness.ctx);
		rec.emits.length = 0;

		harness.ctx.__feedInput("\x1b[Z"); // 退出
		assert.deepEqual(lastMirror(rec), [], "退出时应广播空快照清掉镜像");
	} finally {
		workspace.cleanup();
	}
});

test("没带标记的助手消息不改写、不推进", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");
		await callTool(extension, "exit_plan_mode", { steps: PLAN_STEPS }, harness.ctx);

		const untouched = await messageEnd(
			extension,
			{ message: { role: "assistant", content: [{ type: "text", text: "普通回复" }] } },
			harness.ctx,
		);
		assert.equal(untouched, undefined, "没有标记就不该改写消息");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// 状态恢复（/resume）
// =============================================================================

test("会话恢复：plan 态与步骤从会话条目还原，工具表跟着收回", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const entries = [
			{
				type: "custom",
				customType: "plan-mode",
				data: {
					phase: "plan",
					steps: [],
					pending: [{ step: 1, text: "恢复出来的步骤", done: false }],
					toolsBeforePlan: ["read", "bash", "edit", "write", "grep"],
				},
			},
		];
		const harness = makeContext(extension, rec, {
			entries,
		});

		await sessionStart(extension, { reason: "resume" }, harness.ctx);

		assert.ok(!harness.getActiveTools().includes("edit"), "恢复后写工具必须仍被摘掉");
		assert.ok(!harness.getActiveTools().includes("write"));
		const status = rec.statuses.at(-1) ?? "";
		assert.ok(status.includes("plan"), `状态行应回到 plan，实际 ${status}`);
	} finally {
		workspace.cleanup();
	}
});

test("会话恢复：execute 态还原步骤进度", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const entries = [
			{
				type: "custom",
				customType: "plan-mode",
				data: {
					phase: "execute",
					steps: [
						{ step: 1, text: "已完成", done: true },
						{ step: 2, text: "未完成", done: false },
					],
				},
			},
		];
		const harness = makeContext(extension, rec, { entries });

		await sessionStart(extension, { reason: "resume" }, harness.ctx);

		const status = rec.statuses.at(-1) ?? "";
		assert.ok(status.includes("1/2"), `状态行应显示 1/2，实际 ${status}`);
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// 上下文注入与过滤
// =============================================================================

test("plan 态注入只读上下文（display: false），normal 态把它过滤掉", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		// normal：没有注入
		const normal = (await beforeAgentStart(
			extension,
			{ prompt: "hi", systemPrompt: "", systemPromptOptions: {} },
			harness.ctx,
		)) as { message?: { customType: string; display: boolean; content: string } } | undefined;
		assert.equal(normal, undefined, "normal 态不该注入");

		// 进 plan 后注入
		harness.ctx.__feedInput("\x1b[Z");
		const inPlan = (await beforeAgentStart(
			extension,
			{ prompt: "hi", systemPrompt: "", systemPromptOptions: {} },
			harness.ctx,
		)) as { message?: { customType: string; display: boolean; content: string } } | undefined;
		assert.ok(inPlan?.message, "plan 态应注入上下文");
		assert.equal(inPlan.message.display, false, "注入内容不该出现在用户界面上");
		assert.match(inPlan.message.content, /PLAN MODE/);

		// normal 态过滤
		harness.ctx.__feedInput("\x1b[Z");
		const context = (await handlerOf(extension, "context")(
			{ messages: [{ customType: "plan-mode-context" }, { role: "user", content: "hi" }] },
			harness.ctx,
		)) as { messages: unknown[] } | undefined;
		assert.equal(context?.messages.length, 1, "旧的 plan 上下文应被过滤掉");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// 思考键改绑的接线（纯逻辑在 keybinding.test.ts 里覆盖）
// =============================================================================

test("启动时把 thinking cycle 改绑到 fallback 键（写进 agentDir 的 keybindings.json）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec);

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		const written = fs.readFileSync(path.join(workspace.agentDir, "keybindings.json"), "utf8");
		const parsed = JSON.parse(written) as Record<string, string>;
		assert.equal(parsed["app.thinking.cycle"], THINKING_FALLBACK_KEY);
		assert.ok(rec.notifies.some((message) => message.includes(THINKING_FALLBACK_KEY)), "应告知用户改绑了");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		workspace.cleanup();
	}
});

test("已经有 keybindings.json 时保留其它绑定", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		fs.writeFileSync(path.join(workspace.agentDir, "keybindings.json"), `${JSON.stringify({ "tui.input.newLine": "ctrl+j" }, null, 2)}\n`);
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);

		await sessionStart(extension, { reason: "startup" }, makeContext(extension, rec).ctx);

		const written = JSON.parse(fs.readFileSync(path.join(workspace.agentDir, "keybindings.json"), "utf8")) as Record<string, string>;
		assert.equal(written["tui.input.newLine"], "ctrl+j");
		assert.equal(written["app.thinking.cycle"], THINKING_FALLBACK_KEY);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		workspace.cleanup();
	}
});

test("用户自己配过 thinking cycle 时启动不碰文件", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		const raw = `${JSON.stringify({ "app.thinking.cycle": "ctrl+t" }, null, 2)}\n`;
		fs.writeFileSync(path.join(workspace.agentDir, "keybindings.json"), raw);
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);

		await sessionStart(extension, { reason: "startup" }, makeContext(extension, rec).ctx);

		assert.equal(fs.readFileSync(path.join(workspace.agentDir, "keybindings.json"), "utf8"), raw, "文件必须原样不动");
		assert.deepEqual(rec.notifies, [], "已经绑好了就不该再提示（每次启动都提醒会变成噪音）");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		workspace.cleanup();
	}
});

test("上次改绑过（已绑到 fallback）时启动也静默", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		fs.writeFileSync(
			path.join(workspace.agentDir, "keybindings.json"),
			`${JSON.stringify({ "app.thinking.cycle": THINKING_FALLBACK_KEY }, null, 2)}\n`,
		);
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);

		await sessionStart(extension, { reason: "startup" }, makeContext(extension, rec).ctx);

		assert.deepEqual(rec.notifies, [], "已经是 fallback 绑定了，不该提示");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		workspace.cleanup();
	}
});

test("执行期重新进 plan 时清掉镜像（状态行与清单不再各说各话）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");
		await callTool(extension, "exit_plan_mode", { steps: PLAN_STEPS }, harness.ctx);
		// 单扩展环境里没有 simple-task 的 task_update，用它的广播代替（等价于「第 1 步完成」）
		extension.__emitTaskState(taskState([{ step: 1, status: "done" }, { step: 2, status: "pending" }]));
		rec.emits.length = 0;

		await callTool(extension, "enter_plan_mode", { reason: "重新规划" }, harness.ctx);

		assert.deepEqual(lastMirror(rec), [], "重进 plan 时应广播空快照清掉旧镜像");
	} finally {
		workspace.cleanup();
	}
});

test("模型违规 task_set 清掉镜像后，turn_start 会把镜像重新推回去", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");
		await callTool(extension, "exit_plan_mode", { steps: PLAN_STEPS }, harness.ctx);
		// 模拟模型重建了清单（镜像条目被冲掉），此时自己还没有任何 done 步
		extension.__emitTaskState({ items: [{ id: 1, text: "模型自己写的", status: "pending" }] });
		rec.emits.length = 0;

		await handlerOf(extension, "turn_start")({}, harness.ctx);

		assert.ok(
			(lastMirror(rec)?.length ?? 0) > 0,
			`镜像不在清单里时 turn_start 应重推（旧判据「自己没有 done 步就不推」会让状态行冻死在 0/N），实际 ${JSON.stringify(lastMirror(rec))}`,
		);
	} finally {
		workspace.cleanup();
	}
});

test("镜像驱动的推进不产生多余的全量快照（回声 persist 被跳过）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");
		await callTool(extension, "exit_plan_mode", { steps: PLAN_STEPS }, harness.ctx);
		rec.entries.length = 0;
		rec.emits.length = 0;

		// simple-task 广播「第 1 步完成」→ plan-mode 记账并回写，但不应再触发一次 syncMirror
		extension.__emitTaskState(taskState([{ step: 1, status: "done" }, { step: 2, status: "pending" }]));

		assert.equal(rec.entries.length, 1, `应只写 1 条 plan-mode 快照，实际 ${rec.entries.length}`);
		assert.equal(
			rec.emits.filter((e) => e.channel === "plan-mode:sync-tasks").length,
			0,
			"进度由镜像驱动时不该回推镜像（回声）",
		);
	} finally {
		workspace.cleanup();
	}
});
