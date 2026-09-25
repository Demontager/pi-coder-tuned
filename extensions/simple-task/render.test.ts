/**
 * Tests for the task tool block shape (simple-task/index.ts) — 端到端：pi 自己的扩展加载器
 * 真的加载本扩展，再用 pi 自己的 `ToolExecutionComponent` 渲染真实的 task 工具块，
 * 对渲染出来的**行**做断言。
 *
 * Run with:  node --test clients/pi/extensions/simple-task/render.test.ts
 *
 * 为什么必须绕这一圈：这个特性的全部价值在于「用户屏幕上长什么样」，而屏幕上的行是
 * `ToolExecutionComponent` → `renderCall` / `renderResult` → 壳（contentBox / selfRenderContainer）
 * 一层层叠出来的。只断言 `renderShell === "self"` 会漏掉「self 模式下底色真的没画上去」这一半。
 *
 * 断言口径（用户 2026-09-26 定：task 块与 bash 块同一套壳）：
 *   - 三个工具（`task_set` / `task_update` / `task_get`）都声明 `renderShell: "self"`；
 *   - 整块**没有任何底色**（pending / 成功 / 失败三种底都不画 —— 与 bash / read 块同一手法：
 *     selfRenderContainer 是纯 Container，bgFn 套不上去，扩展自己也不画）；
 *   - 整块**没有上下边界空行与左右 padding**（pi 默认壳 `Box(1, 1)` 画的那些全没了）：
 *     块的第 0 行是 pi self 模式固定的那一行留白（`render()` 里 `lines.push("")`），
 *     第 1 行就是工具标题本身，最后一行是结果本身；
 *   - 标题与结果正文都从**列 0** 起（没有默认壳的左 padding）；
 *   - 其他工具照旧走默认壳（有底色）—— 有专门的对照断言。
 * 找不到本机 pi 的库入口就整体 skip（不假装通过）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态。
 * 与 bash / read 两个 render.test.ts 同一套查找逻辑：先从 `pi` 可执行文件反查安装位置，
 * 再退回 `~/.pi/agent/npm` 那份副本 —— 判定方式是能不能真 import。
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

/**
 * pi 自带的 chalk 在模块求值时就定好「要不要输出样式」（非 TTY 下默认关掉）。
 * 底色断言看的是 SGR 序列，必须在 import pi 之前设 FORCE_COLOR。
 */
if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

interface ToolDefinitionLike {
	renderShell?: string;
	renderCall?: (...args: any[]) => any;
	renderResult?: (...args: any[]) => any;
	execute?: (
		toolCallId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
}

interface PiApi {
	discoverAndLoadExtensions: (
		configuredPaths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{
		extensions: Array<{ tools: Map<string, { definition: ToolDefinitionLike }> }>;
		errors: Array<{ path: string; error: string }>;
	}>;
	createEventBus: () => unknown;
	initTheme: (name?: string, interactive?: boolean) => void;
	ToolExecutionComponent: new (
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: unknown,
		toolDefinition: ToolDefinitionLike | undefined,
		ui: { requestRender(): void },
		cwd: string,
	) => {
		setArgsComplete?: () => void;
		markExecutionStarted: () => void;
		updateResult: (result: unknown, isPartial?: boolean) => void;
		render: (width: number) => string[];
	};
}

let pi: PiApi | undefined;
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

/** 剥掉所有 ANSI / OSC 转义，只留可见文本（断言直接看这个）。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** 底色判定：行首带背景 SGR 序列（`48;2;…` / `40-47` / `100-107`）就算有底色。 */
const hasBg = (line: string): boolean => /\u001b\[(?:4[0-7]|10[0-7]|48[;:])/.test(line);

let cached: { projectDir: string; tools: Map<string, { definition: ToolDefinitionLike }> } | undefined;
let cleanup: (() => void) | undefined;

if (pi) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-shape-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	cleanup = () => fs.rmSync(root, { recursive: true, force: true });

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const tools = loaded.extensions[0]?.tools;
	assert.ok(tools, "本扩展必须注册工具");
	pi.initTheme("dark");
	cached = { projectDir, tools };
}

test.after(() => cleanup?.());

/** 渲染一个 task 工具块：与 pi 的调用顺序一致（setArgsComplete → markExecutionStarted → updateResult）。 */
function renderBlock(name: string, args: unknown, result?: { content: unknown[]; details?: unknown; isError?: boolean }): string[] {
	assert.ok(pi && cached);
	const definition = cached.tools.get(name)?.definition;
	assert.ok(definition, `本扩展必须注册 ${name} 工具`);
	const component = new pi.ToolExecutionComponent(name, "call-1", args, {}, definition, { requestRender() {} }, cached.projectDir);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	if (result) component.updateResult(result, false);
	return component.render(79);
}

/** 三个工具各自的样例参数与成功结果（details 里的 state 供 renderResult 读计数）。 */
const SAMPLES: Record<string, { args: unknown; result: { content: unknown[]; details: unknown } }> = {
	task_set: {
		args: { tasks: ["a", "b", "c"] },
		result: {
			content: [{ type: "text", text: "Task list set with 3 task(s)." }],
			details: {
				action: "set",
				state: { active: true, nextId: 4, tasks: [
					{ id: 1, text: "a", status: "pending" },
					{ id: 2, text: "b", status: "done" },
					{ id: 3, text: "c", status: "pending" },
				] },
			},
		},
	},
	task_update: {
		args: { id: 2, status: "done" },
		result: {
			content: [{ type: "text", text: "Task #2 → done." }],
			details: { action: "update", state: { active: true, nextId: 4, tasks: [] } },
		},
	},
	task_get: {
		args: {},
		result: {
			content: [{ type: "text", text: "[x] #2 b" }],
			details: {
				action: "get",
				state: { active: true, nextId: 4, tasks: [
					{ id: 1, text: "a", status: "pending" },
					{ id: 2, text: "b", status: "done" },
					{ id: 3, text: "c", status: "pending" },
				] },
			},
		},
	},
};

test("三个工具都声明 renderShell: \"self\"", { skip }, () => {
	assert.ok(cached);
	for (const name of ["task_set", "task_update", "task_get"]) {
		assert.equal(cached.tools.get(name)?.definition.renderShell, "self", `${name} 必须自带 self 壳`);
	}
});

test("整块没有任何底色（pending / 成功 / 失败三种底都不画）", { skip }, () => {
	assert.ok(cached);
	for (const [name, sample] of Object.entries(SAMPLES)) {
		const pending = renderBlock(name, sample.args);
		const success = renderBlock(name, sample.args, sample.result);
		const failed = renderBlock(name, sample.args, { content: [{ type: "text", text: "boom" }], details: {}, isError: true });
		for (const [label, lines] of [["执行中", pending], ["成功", success], ["失败", failed]] as Array<[string, string[]]>) {
			const painted = lines.filter(hasBg);
			assert.deepEqual(painted, [], `${name} ${label}：task 块不该有任何底色行：${JSON.stringify(painted.map(plain))}`);
			// 内容本身还在（别把"没底色"做成"整块没了"）
			assert.equal(lines.map(plain).some((line) => line.includes(name)), true, `${name} ${label}：标题行该还在`);
		}
	}

	// 对照：其他工具（不给 toolDefinition，走 pi 的通用渲染路径）底色照旧。
	// 钉住「只去 task 的」那半边：别的工具仍走 ToolExecutionComponent 自己的 contentBox + bgFn。
	assert.ok(pi);
	const other = new pi.ToolExecutionComponent("read", "call-other", { path: "/tmp/x" }, {}, undefined, { requestRender() {} }, cached!.projectDir);
	other.updateResult({ content: [{ type: "text", text: "file content" }], details: {} }, false);
	assert.equal(other.render(79).some(hasBg), true, "其他工具的底色必须还在");
});

test("无边界空行：标题是块的第一行、结果是最后一行，正文顶格列 0", { skip }, () => {
	for (const [name, sample] of Object.entries(SAMPLES)) {
		for (const [label, lines] of [
			["执行中", renderBlock(name, sample.args)],
			["成功", renderBlock(name, sample.args, sample.result)],
		] as Array<[string, string[]]>) {
			const visible = lines.map(plain);
			// 首行是 pi self 模式的固定留白（render() 里 lines.push("")），它不是块的一部分
			assert.equal(visible[0], "", `${name} ${label}：第 0 行是 pi 的固定留白`);
			// 块的第一行就是工具标题，顶格列 0（没有默认壳的左 padding）
			assert.equal(visible[1]!.startsWith(name), true, `${name} ${label}：第 1 行就该是顶格的标题：${JSON.stringify(visible)}`);
			// 最后一行是内容本身（没有下边界空行）
			assert.notEqual(visible[visible.length - 1]!.trim(), "", `${name} ${label}：最后一行不该是空行：${JSON.stringify(visible)}`);
			// 结果行也顶格列 0
			if (visible.length > 2) {
				assert.equal(visible[2]!.startsWith(" ") || visible[2]!.trim() === "", false, `${name} ${label}：结果行不该有左缩进：${JSON.stringify(visible[2])}`);
			}
		}
	}
});
