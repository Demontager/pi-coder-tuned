/**
 * Tests for prompt-editor.ts — `!` bash 模式在**真编辑器**上的渲染契约。
 *
 * Run with:  node --test clients/pi/extensions/prompt-editor/render.test.ts
 *
 * pi 自己的扩展加载器真的加载 `../prompt-editor.ts`（语法、import 面、session_start 注册都在
 * 覆盖范围内），假的只有编辑器外面的一切：tui 只要 `terminal.rows` 与 `requestRender()`，
 * 主题的 `borderColor` 是恒等函数，keybindings 的 `matches` 一律 false。于是
 * 「gutter 换成 `!`、正文里输入的 `!` 不再显示、光标进不到被摘掉的那一列、点选跨过那一列、
 * 退格删掉 `!` 就退出模式」这条链能被逐行 / 逐光标列断言。纯逻辑另在 `bash-prompt.test.ts`。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"prompt-editor.ts",
);
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态。
 *
 * 先从 `pi` 可执行文件反查**真正的安装位置**（pnpm/npm 的 shim 脚本里留有
 * `# cmd-shim-target=<绝对路径>`；npm 在 Unix 上则是符号链接，两种都试），再退回
 * `~/.pi/agent/npm` 那份副本 —— 后者是**扩展包的安装根**，`pi update --extensions` 会用
 * `--config.auto-install-peers=false` 把自动装进去的 `@earendil-works/pi-*` 同伴包剪掉，
 * 于是那份副本只剩空壳（文件都在、import 报 `ERR_MODULE_NOT_FOUND`）。
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

function createTestBus(): {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
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
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
}

interface EditorLike {
	setText(text: string): void;
	getText(): string;
	getCursor(): { line: number; col: number };
	handleInput(data: string): void;
	handleMouse(event: Record<string, unknown>): unknown;
	render(width: number): string[];
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-editor-"));
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

/**
 * 用 pi 自己的加载器加载扩展，再调用它注册的 session_start，抓出编辑器工厂并实例化。
 * 编辑器外面全部是假的：`paddingX: 0` 的 Editor 只需要 `tui.terminal.rows`，
 * 主题只需要一个恒等的 `borderColor`，keybindings 只需要一个永远不命中的 `matches`
 * （Editor 自己的键位走 pi-tui 的全局默认表，所以 Ctrl+A / 退格都是真按真绑定的行为）。
 */
async function mountEditor(): Promise<EditorLike> {
	const workspace = makeWorkspace();
	try {
		const pi = (await import(pathToFileURL(piEntry as string).href)) as {
			discoverAndLoadExtensions: (
				configuredPaths: string[],
				cwd: string,
				agentDir?: string,
				eventBus?: unknown,
			) => Promise<{
				extensions: Array<{ handlers: Map<string, Handler[]> }>;
				errors: Array<{ path: string; error: string }>;
			}>;
		};
		const loaded = await pi.discoverAndLoadExtensions(
			[EXTENSION_PATH],
			workspace.projectDir,
			workspace.agentDir,
			createTestBus(),
		);
		assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
		const extension = loaded.extensions[0];
		assert.ok(extension, "扩展应该被加载");
		const sessionStart = extension.handlers.get("session_start")?.[0];
		assert.ok(sessionStart, "扩展应该注册 session_start");

		let factory: ((tui: unknown, theme: unknown, keybindings: unknown) => EditorLike) | undefined;
		const ctx = {
			hasUI: true,
			cwd: workspace.projectDir,
			ui: {
				setEditorComponent(next: typeof factory) {
					factory = next;
				},
			},
		};
		await sessionStart({}, ctx);
		assert.ok(factory, "session_start 应该注册编辑器工厂");

		return factory(
			{ terminal: { rows: 40 }, requestRender() {} },
			{ borderColor: (text: string) => text },
			{ matches: () => false },
		);
	} finally {
		workspace.cleanup();
	}
}

/** 去掉 CSI 与 APC（CURSOR_MARKER）转义，剩下纯文本。 */
function plainLines(lines: string[]): string[] {
	return lines.map((line) =>
		line
			.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "")
			.replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""),
	);
}

/** Editor.handleMouse 要的完整事件形状；x / y 是组件内坐标。 */
function mouseClick(x: number, y: number): Record<string, unknown> {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 40,
		height: 40,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}

test("普通输入：gutter 是 ❯，正文原样", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("hello");

	const lines = plainLines(editor.render(40));
	assert.ok(lines[1]?.startsWith("❯ hello"), `第一行正文应是 "❯ hello"：${JSON.stringify(lines[1])}`);
	assert.equal(lines[1]?.length, 40, "每行都要满宽（gutter + contentWidth）");
	assert.equal(lines[0]?.length, 40, "上边框也要满宽");
});

test("`!` 开头：gutter 换成 !，正文里输入的 ! 不再显示", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!ls -la");

	const lines = plainLines(editor.render(40));
	assert.ok(lines[1]?.startsWith("! ls -la"), `gutter 应是 "! " 且正文紧接其后：${JSON.stringify(lines[1])}`);
	assert.equal(lines[1]?.includes("!ls"), false, "正文里不能再出现那个 `!`");
	assert.equal(lines[1]?.length, 40, "摘掉一列后要补回满宽");
	assert.equal(lines[0]?.length, 40, "上边框不受影响");
});

test("`!!`（不进上下文）只藏第一个 !，第二个留在正文里可见", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!!ls");

	const lines = plainLines(editor.render(40));
	assert.ok(lines[1]?.startsWith("! !ls"), `第二个 "!" 要留在正文里：${JSON.stringify(lines[1])}`);
	assert.equal(lines[1]?.length, 40);
});

test("正文只剩 `!` 时按退格退出模式：gutter 自己变回 ❯", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!");
	assert.ok(plainLines(editor.render(40))[1]?.startsWith("! "), "先进入 bash 模式");

	editor.handleInput("\x7f"); // backspace
	assert.equal(editor.getText(), "", "退格删掉了那个 `!`");
	assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
	assert.ok(
		plainLines(editor.render(40))[1]?.startsWith("❯ "),
		"退出模式后 gutter 自然回到 ❯",
	);
});

test("Ctrl+A 把光标挡在隐藏的 `!` 之后：继续打字不会顶掉 bash 模式", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!ls");

	editor.handleInput("\x01"); // ctrl+a
	assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, "光标不该落到被摘掉的那一列");

	editor.handleInput("c");
	assert.equal(editor.getText(), "!cls", "插入点在第 1 列之后，`!` 还在最前面");
	assert.ok(plainLines(editor.render(40))[1]?.startsWith("! cls"), "仍然是 bash 模式的画法");
});

test("普通正文的 Ctrl+A 不受影响：光标可以到第 0 列", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("ls");

	editor.handleInput("\x01"); // ctrl+a
	assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
});

test("点选：正文左移一列后坐标仍然对得上（点 gutter 也会被挡回第 1 列）", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!ls");
	editor.render(40); // handleMouse 依赖最近一次 render 的宽度与行数

	// 可见正文：gutter 占 x=0/1，`l` 在 x=2，`s` 在 x=3
	editor.handleMouse(mouseClick(3, 1));
	assert.deepEqual(editor.getCursor(), { line: 0, col: 2 }, "点在 `s` 上 → 光标在 `s` 之前");

	editor.handleMouse(mouseClick(2, 1));
	assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, "点在 `l` 上 → 光标在 `l` 之前");

	editor.handleMouse(mouseClick(0, 1));
	assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, "点 gutter（隐藏列）被挡回第 1 列");
});
