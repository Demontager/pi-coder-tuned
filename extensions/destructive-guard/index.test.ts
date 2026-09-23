/**
 * Tests for index.ts — destructive-guard 的接线（用 pi 自己的加载器真实加载）。
 *
 * Run with:  node --test clients/pi/extensions/destructive-guard/index.test.ts
 *
 * 覆盖的是**接线**而不是判定逻辑（判定在 targets.test.ts / writes.test.ts 里）。所以断言
 * 集中在：pi 的加载器真的能装好这个扩展、危险调用真的被 block、无害调用真的放行、非交互
 * 环境 fail closed、`PI_DESTRUCTIVE_GUARD` 的四个模式各自生效。
 *
 * 找不到本机 pi 的库入口就整体 skip（不假装通过）—— 同 plan-mode/index.test.ts。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/** pi 的库入口（非 CLI）。判定方式是能不能真 import，不是路径存不存在。 */
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
const skip = piEntry === undefined ? SKIP : false;

/** 钩子返回值。 */
interface Verdict {
	block?: boolean;
	reason?: string;
}

interface Harness {
	call: (toolName: string, input: Record<string, unknown>) => Promise<Verdict>;
	notifies: string[];
	selects: string[];
	cleanup: () => void;
}

/**
 * 用 pi 的加载器真实加载扩展，返回一个把 tool_call 喂进去的 runner。
 *
 * 注意 `session_start` 会在 `call` 之前被触发一次 —— 扩展在工厂期读一次模式、在
 * `session_start` 再读一次，所以要测模式开关必须走这条路（改环境变量后重开一个 harness）。
 */
async function loadHarness(options: { hasUI?: boolean; selectAnswer?: string } = {}): Promise<Harness> {
	const { hasUI = true, selectAnswer = "取消" } = options;
	const pi = (await import(pathToFileURL(piEntry!).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dg-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });

	const bus = { on: () => () => undefined, emit: () => undefined };
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, bus);
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const extension = loaded.extensions[0];
	assert.ok(extension, "应该加载到一个扩展");

	const notifies: string[] = [];
	const selects: string[] = [];
	const ctx = {
		mode: "tui",
		hasUI,
		cwd: projectDir,
		ui: {
			notify: (text: string) => notifies.push(text),
			select: async (prompt: string) => {
				selects.push(prompt);
				return selectAnswer;
			},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};

	// session_start 也要跑：扩展在那里重读模式。
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, ctx);
	}

	return {
		notifies,
		selects,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
		async call(toolName: string, input: Record<string, unknown>): Promise<Verdict> {
			for (const handler of extension.handlers.get("tool_call") ?? []) {
				const verdict = (await handler({ toolName, input }, ctx)) as Verdict | undefined;
				if (verdict?.block) return verdict;
			}
			return {};
		},
	};
}

interface LoadedExtension {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>;
}

/** 每次测试前后清掉模式变量，避免互相污染。 */
function withMode<T>(mode: string | undefined, run: () => Promise<T>): Promise<T> {
	const prior = process.env.PI_DESTRUCTIVE_GUARD;
	if (mode === undefined) delete process.env.PI_DESTRUCTIVE_GUARD;
	else process.env.PI_DESTRUCTIVE_GUARD = mode;
	return run().finally(() => {
		if (prior === undefined) delete process.env.PI_DESTRUCTIVE_GUARD;
		else process.env.PI_DESTRUCTIVE_GUARD = prior;
	});
}

test("危险删除命令被拦下", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const verdict = await guard.call("bash", { command: "rm -rf /" });
		assert.equal(verdict.block, true, "rm -rf / 必须被拦");
		assert.match(verdict.reason ?? "", /destructive-guard/);
	} finally {
		guard.cleanup();
	}
});

test("受保护目录的上级被拦下", { skip }, async () => {
	const guard = await loadHarness();
	try {
		assert.equal((await guard.call("bash", { command: "rm -rf /Users" })).block, true);
		assert.equal((await guard.call("bash", { command: "rm -rf /usr" })).block, true);
		assert.equal((await guard.call("bash", { command: "rm -rf /etc" })).block, true);
	} finally {
		guard.cleanup();
	}
});

test("事故形态（dirname + 兜底值）被拦下", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const verdict = await guard.call("bash", { command: "rm -rf $(dirname /tmp)" });
		assert.equal(verdict.block, true, "算出来的目标必须被拦");
	} finally {
		guard.cleanup();
	}
});

test("工作目录内的正常删除放行", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const cwd = process.cwd();
		assert.deepEqual(await guard.call("bash", { command: `rm -rf ${cwd}/dist` }), {});
		assert.deepEqual(await guard.call("bash", { command: "rm -f /tmp/scratch.log" }), {});
		assert.deepEqual(await guard.call("bash", { command: "ls -la /usr" }), {});
		assert.deepEqual(await guard.call("bash", { command: "git status" }), {});
	} finally {
		guard.cleanup();
	}
});

test("写入危险删除代码被拦下", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const verdict = await guard.call("write", {
			path: "verify.mjs",
			content: 'fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true });',
		});
		assert.equal(verdict.block, true, "事故那行代码必须被拦");
	} finally {
		guard.cleanup();
	}
});

test("写入正常删除代码放行", { skip }, async () => {
	const guard = await loadHarness();
	try {
		assert.deepEqual(await guard.call("write", { path: "clean.mjs", content: 'fs.rmSync("/tmp/va-1", { recursive: true });' }), {});
		assert.deepEqual(await guard.call("write", { path: "read.mjs", content: "const text = fs.readFileSync(p, 'utf8');" }), {});
	} finally {
		guard.cleanup();
	}
});

test("edit 的新文本也检查", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const verdict = await guard.call("edit", { path: "a.mjs", oldText: "x", newText: "shutil.rmtree(os.path.dirname(p))" });
		assert.equal(verdict.block, true);
	} finally {
		guard.cleanup();
	}
});

test("非交互环境 fail closed（confirm 也拒）", { skip }, async () => {
	const guard = await loadHarness({ hasUI: false });
	try {
		// 这条属于 confirm 档；没有 UI 可用时不能默认放行。
		const verdict = await guard.call("bash", { command: "rm -rf $UNSET/*" });
		assert.equal(verdict.block, true, "非交互时必须拒");
	} finally {
		guard.cleanup();
	}
});

test("有 UI 时 confirm 档会问一次，回答“取消”则拦", { skip }, async () => {
	const guard = await loadHarness({ hasUI: true, selectAnswer: "取消" });
	try {
		const verdict = await guard.call("bash", { command: "rm -rf $UNSET/*" });
		assert.equal(guard.selects.length, 1, "应该弹了一次确认");
		assert.equal(verdict.block, true, "选取消必须拦");
	} finally {
		guard.cleanup();
	}
});

test("有 UI 时回答“确认删除”则放行", { skip }, async () => {
	const guard = await loadHarness({ hasUI: true, selectAnswer: "确认删除" });
	try {
		const verdict = await guard.call("bash", { command: "rm -rf $UNSET/*" });
		assert.equal(guard.selects.length, 1);
		assert.equal(verdict.block, undefined, "用户确认后应放行");
	} finally {
		guard.cleanup();
	}
});

test("block 档不弹窗，直接拒", { skip }, async () => {
	await withMode("block", async () => {
		const guard = await loadHarness({ hasUI: true });
		try {
			const verdict = await guard.call("bash", { command: "rm -rf $UNSET/*" });
			assert.equal(verdict.block, true);
			assert.equal(guard.selects.length, 0, "block 档不该弹窗");
		} finally {
			guard.cleanup();
		}
	});
});

test("notify 档只通知不拦", { skip }, async () => {
	await withMode("notify", async () => {
		const guard = await loadHarness({ hasUI: true });
		try {
			const verdict = await guard.call("bash", { command: "rm -rf /" });
			assert.equal(verdict.block, undefined, "notify 档不该拦");
			assert.equal(guard.notifies.length, 1, "应该通知一次");
		} finally {
			guard.cleanup();
		}
	});
});

test("off 档完全不管", { skip }, async () => {
	await withMode("off", async () => {
		const guard = await loadHarness({ hasUI: true });
		try {
			assert.deepEqual(await guard.call("bash", { command: "rm -rf /" }), {});
			assert.equal(guard.notifies.length, 0);
			assert.equal(guard.selects.length, 0);
		} finally {
			guard.cleanup();
		}
	});
});

test("非删除类工具不检查", { skip }, async () => {
	const guard = await loadHarness();
	try {
		assert.deepEqual(await guard.call("read", { path: "/etc/hosts" }), {});
		assert.deepEqual(await guard.call("task_set", { tasks: ["a"] }), {});
	} finally {
		guard.cleanup();
	}
});
