/**
 * Tests for index.ts — 端到端：pi 自己的扩展加载器真的加载本扩展，补丁真的落在 **pi 渲染用的
 * 那个** `Markdown` 类上，再用 pi 自己的 `AssistantMessageComponent` 渲染一条 assistant 消息，
 * 断言围栏消失、语法着色还在、**没有任何底色**。
 *
 * Run with:  node --test clients/pi/extensions/fenceless-code-block/index.test.ts
 *
 * 为什么非得绕这一圈（不直接 new 一个 Markdown 来渲染）：这个特性的**唯一**风险就是「补丁打在
 * 另一个类上」—— `pi` 命令跑的是 `dist/bundle/cli.js`，pi-tui 内联在 chunk 里，而扩展 import 到
 * 的是扩展加载器 aliases / virtualModules 给的那一份。只有真过一遍 pi 的加载器 + pi 自己的渲染
 * 组件，才能证明这两者**是同一个类**（链路见 `render.ts` 文件头）。
 * `render.test.ts` 覆盖纯逻辑与边界条件，这里只证明「装得上，而且作用在 pi 身上」。
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
const ESC = "\u001b";

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

interface LoadedExtension {
	handlers: Map<string, Handler[]>;
	commands: Map<string, unknown>;
	errors: Array<{ path: string; error: string }>;
}

interface PiApi {
	discoverAndLoadExtensions: (
		configuredPaths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
	getMarkdownTheme: () => Record<string, unknown>;
	initTheme: (name?: string) => void;
	AssistantMessageComponent: new (
		message: unknown,
		hideThinkingBlock: boolean,
		markdownTheme: unknown,
		hiddenThinkingLabel: string,
		outputPad: number,
		transformers: unknown[],
	) => { render(width: number): string[] };
}

let pi: PiApi | undefined;
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

function createTestBus(): { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void } {
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

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fenceless-code-block-"));
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

/** 用 pi 自己的加载器加载本扩展（`./render.ts` 的 import 也一起验证）。 */
async function loadExtension(workspace: { agentDir: string; projectDir: string }): Promise<LoadedExtension> {
	assert.ok(pi);
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

/** 走 pi 自己的组件渲染一条 assistant 文本消息（`outputPad = 1`，与真实渲染一致）。 */
function renderAssistantText(text: string, width = 80): string[] {
	assert.ok(pi);
	pi.initTheme("dark");
	// 真实路径上 pi 用的是 getMarkdownThemeWithSettings()（= 这里再合并设置里的缩进）。
	const markdownTheme = { ...pi.getMarkdownTheme(), codeBlockIndent: "  " };
	const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
	const component = new pi.AssistantMessageComponent(message, false, markdownTheme, "Thinking...", 1, []);
	return component.render(width);
}

/** 去掉 CSI 颜色与 OSC 133 标记（assistant 消息首尾各挂一个）。 */
const plainText = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;]*m/g, "");

test("扩展能被 pi 的加载器加载（本扩展不注册事件与命令）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		assert.equal(extension.handlers.size, 0, "补丁在模块求值时装好，不需要 session_start");
		assert.equal(extension.commands.size, 0, "本扩展不提供命令");
	} finally {
		workspace.cleanup();
	}
});

test("pi 渲染的代码块没有围栏，且不铺任何底色", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		await loadExtension(workspace);

		const lines = renderAssistantText("before\n\n```js\nconst x = 1;\n```\n\nafter");
		const plain = lines.map(plainText);

		assert.equal(plain.some((line) => line.includes("```")), false, "围栏不该出现");
		assert.equal(plain.some((line) => line.trim() === "js"), false, "语言标签不该单独占一行");

		const codeLine = lines.find((line) => plainText(line).includes("const x = 1;"));
		assert.ok(codeLine, "代码行应该在");
		assert.ok(codeLine.includes(`${ESC}[38;`), "语法着色不该被我们的渲染吃掉");
		assert.equal(codeLine.includes(`${ESC}[48;`), false, "代码行不该有底色");
		assert.equal(lines.some((line) => line.includes(`${ESC}[48;`)), false, "整条消息都不该出现底色 SGR");

		assert.equal(plainText(codeLine).trim(), "const x = 1;", "只留 pi 的缩进，行尾没有多余内容");
		assert.ok(plain.some((line) => line.includes("before")), "代码块前面的正文还在");
		assert.ok(plain.some((line) => line.includes("after")), "代码块后面的正文还在");
		for (const line of plain.filter((text) => text.trim() !== "")) {
			assert.equal(line.length, 80, "pi 的整行补白仍然生效");
		}
	} finally {
		workspace.cleanup();
	}
});
