/**
 * auto-default-model 的验证：**不 mock pi**，而是用 pi 自己的扩展加载器（
 * `discoverAndLoadExtensions`）真加载 `index.ts`，再直接调用它注册的 `model_select` handler，
 * 最后检查假 agent 目录里的 `settings.json`。
 *
 * 这样测到的是真链路：扩展里 `import { SettingsManager } from "@earendil-works/pi-coding-agent"`
 * 这句走的正是 pi 加载器给扩展准备的 alias / virtualModules（import 失败会让 pi 的 loader 报错、
 * `extensions` 为空 —— 第一个用例就是在断言它），落盘走的也是真 `FileSettingsStorage`
 * （proper-lockfile + 只合并改动字段的读改写），而不是测试自己拼的假对象。
 *
 * 需要本机装过 pi（先从 `pi` 可执行文件的 shim 反查真正安装位置，再退回
 * `~/.pi/agent/npm/node_modules/`，或直接给 `PI_TEST_PI_ENTRY` 指路）；找不到就整体 skip，
 * 不假装通过。`~/.pi/agent/npm` 那份副本不能只看文件在不在：`pi update --extensions` 会把
 * 自动装进去的 `@earendil-works/pi-*` 同伴包剪掉，副本会变成 import 就报错的空壳。
 *
 *   node --test clients/pi/extensions/auto-default-model/default-model.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态，两个都能加载扩展。
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
const skip = piEntry === undefined ? "找不到本机 pi 的库入口（装过 pi 才有）" : false;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type Notify = { type: string | undefined; message: string };

/** 真加载扩展，返回它注册的 model_select handler。 */
async function loadModelSelectHandler(agentDir: string, projectDir: string): Promise<Handler> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
		) => Promise<{ extensions: Array<{ handlers: Map<string, Handler[]> }>; errors: Array<{ path: string; error: string }> }>;
	};
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir);
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	assert.equal(loaded.extensions.length, 1, "应该只加载到 auto-default-model 这一个扩展");
	const handler = loaded.extensions[0]?.handlers.get("model_select")?.[0];
	assert.ok(handler, "扩展应该注册了 model_select handler");
	return handler;
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-default-model-"));
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

function writeSettings(agentDir: string, settings: unknown, raw?: string): void {
	fs.writeFileSync(path.join(agentDir, "settings.json"), raw ?? `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function readSettings(agentDir: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"));
}

/** 驱动一次模型切换（默认 `/model` 选择器那条路径），返回 UI 收到的通知。 */
async function switchModel(
	agentDir: string,
	projectDir: string,
	provider: string,
	id: string,
	options: { source?: string; hasUI?: boolean } = {},
): Promise<{ notifications: Notify[]; fileExisted: boolean }> {
	const handler = await loadModelSelectHandler(agentDir, projectDir);
	const notifications: Notify[] = [];
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await handler(
			{
				type: "model_select",
				model: { provider, id },
				previousModel: { provider: "litellm-any", id: "qwen3.8-df-qd-claude" },
				source: options.source ?? "set",
			},
			{
				cwd: projectDir,
				hasUI: options.hasUI ?? false,
				ui: {
					notify: (message: string, type?: string) => {
						notifications.push({ message, type });
					},
				},
			},
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	return { notifications, fileExisted: fs.existsSync(path.join(agentDir, "settings.json")) };
}

test("切模型后把 defaultProvider/defaultModel 写成启动默认，settings.json 其它字段不动", { skip }, async () => {
	const workspace = makeWorkspace();
	try {
		writeSettings(workspace.agentDir, {
			theme: "coffee",
			defaultProvider: "litellm-any",
			defaultModel: "qwen3.8-df-qd-claude",
			markdown: { mermaid: "streaming" },
			packages: ["npm:pi-subagents"],
		});

		const { notifications, fileExisted } = await switchModel(workspace.agentDir, workspace.projectDir, "litellm-any", "deepseek-flash");

		assert.deepEqual(notifications, []);
		assert.equal(fileExisted, true);
		assert.deepEqual(readSettings(workspace.agentDir), {
			theme: "coffee",
			defaultProvider: "litellm-any",
			defaultModel: "deepseek-flash",
			markdown: { mermaid: "streaming" },
			packages: ["npm:pi-subagents"],
		});
	} finally {
		workspace.cleanup();
	}
});

test("settings.json 还不存在时按需创建（新机器）", { skip }, async () => {
	const workspace = makeWorkspace();
	try {
		assert.equal(fs.existsSync(path.join(workspace.agentDir, "settings.json")), false);

		await switchModel(workspace.agentDir, workspace.projectDir, "litellm-any", "deepseek-flash");

		assert.deepEqual(readSettings(workspace.agentDir), {
			defaultProvider: "litellm-any",
			defaultModel: "deepseek-flash",
		});
	} finally {
		workspace.cleanup();
	}
});

test("磁盘上已经是同一个模型就不写（不白动 settings.json）", { skip }, async () => {
	const workspace = makeWorkspace();
	try {
		// 紧凑格式 + 无换行：pi 自己的写入会重排成 2 空格缩进，所以「字节不变」= 真的一次都没写。
		const raw = '{"defaultProvider":"litellm-any","defaultModel":"deepseek-flash"}';
		writeSettings(workspace.agentDir, undefined, raw);

		await switchModel(workspace.agentDir, workspace.projectDir, "litellm-any", "deepseek-flash");

		assert.equal(fs.readFileSync(path.join(workspace.agentDir, "settings.json"), "utf-8"), raw);
	} finally {
		workspace.cleanup();
	}
});

test("source=restore（恢复旧会话带回的模型）不改全局默认", { skip }, async () => {
	const workspace = makeWorkspace();
	try {
		const raw = '{"defaultProvider":"litellm-any","defaultModel":"qwen3.8-df-qd-claude"}';
		writeSettings(workspace.agentDir, undefined, raw);

		await switchModel(workspace.agentDir, workspace.projectDir, "litellm-any", "deepseek-flash", { source: "restore" });

		assert.equal(fs.readFileSync(path.join(workspace.agentDir, "settings.json"), "utf-8"), raw);
	} finally {
		workspace.cleanup();
	}
});

test("PI_AUTO_DEFAULT_MODEL=off 整体关闭", { skip }, async () => {
	const workspace = makeWorkspace();
	try {
		const raw = '{"defaultProvider":"litellm-any","defaultModel":"qwen3.8-df-qd-claude"}';
		writeSettings(workspace.agentDir, undefined, raw);
		process.env.PI_AUTO_DEFAULT_MODEL = "off";
		try {
			await switchModel(workspace.agentDir, workspace.projectDir, "litellm-any", "deepseek-flash");
		} finally {
			delete process.env.PI_AUTO_DEFAULT_MODEL;
		}

		assert.equal(fs.readFileSync(path.join(workspace.agentDir, "settings.json"), "utf-8"), raw);
	} finally {
		workspace.cleanup();
	}
});

test("settings.json 坏掉时不当成写成功（notify 警告，文件保持原样）", { skip }, async () => {
	const workspace = makeWorkspace();
	try {
		const raw = "{ this is not json }";
		writeSettings(workspace.agentDir, undefined, raw);

		const { notifications } = await switchModel(workspace.agentDir, workspace.projectDir, "litellm-any", "deepseek-flash", {
			hasUI: true,
		});

		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]?.type, "warning");
		// 警告里要带上是哪个模型、以及 pi 记下的真实错误（解析失败原文），否则用户无从下手。
		assert.match(notifications[0]?.message ?? "", /deepseek-flash/);
		assert.match(notifications[0]?.message ?? "", /startup default model/);
		assert.equal(fs.readFileSync(path.join(workspace.agentDir, "settings.json"), "utf-8"), raw);
	} finally {
		workspace.cleanup();
	}
});
