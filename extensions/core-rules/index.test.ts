/**
 * core-rules 的验证：纯判定（decision.ts）直接测；注入链路**不 mock pi**，
 * 用 pi 自己的扩展加载器（`discoverAndLoadExtensions`）真加载 `index.ts`，
 * 再直接调用它注册的 `before_agent_start` handler，ctx 只给一个假的
 * `sessionManager.buildContextEntries()`。
 *
 * 需要本机装过 pi；找不到库入口就整体 skip，不假装通过
 * （harness 与 auto-default-model/default-model.test.ts 同源）。
 *
 *   node --test clients/pi/extensions/core-rules/index.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { decideInjection, renderBody, REPLACEMENT_NOTICE } from "./decision.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

// =============================================================================
// 纯判定（decision.ts）
// =============================================================================

test("decideInjection: 文件缺失 → 静默跳过", () => {
	assert.deepEqual(decideInjection(undefined, []), { action: "skip", reason: "no-rules-file" });
	assert.deepEqual(decideInjection(undefined, ["abc"]), { action: "skip", reason: "no-rules-file" });
});

test("decideInjection: 空投影（会话开始 / 已被压缩掉）→ 注入，不带替换声明", () => {
	assert.deepEqual(decideInjection("abc", []), { action: "inject", replacement: false });
});

test("decideInjection: 最新 hash 相同 → 跳过", () => {
	assert.deepEqual(decideInjection("abc", ["old", "abc"]), { action: "skip", reason: "unchanged" });
});

test("decideInjection: hash 变了 → 带替换声明重注入", () => {
	assert.deepEqual(decideInjection("new", ["old"]), { action: "inject", replacement: true });
});

test("decideInjection: 前文存在但 hash 不可知（旧格式条目）→ 保守重注入", () => {
	assert.deepEqual(decideInjection("abc", [undefined]), { action: "inject", replacement: true });
});

test("renderBody: 替换声明只拼在重注入时", () => {
	assert.equal(renderBody("RULES", false), "RULES");
	assert.equal(renderBody("RULES", true), `${REPLACEMENT_NOTICE}\n\nRULES`);
});

// =============================================================================
// 经 pi loader 的真链路
// =============================================================================

/**
 * pi 的库入口（非 CLI）：先从 `pi` 可执行文件的 shim 反查真正安装位置，
 * 再退回 `~/.pi/agent/npm/node_modules/` 那份副本；判定方式是**能不能真 import**。
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

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? "找不到本机 pi 的库入口（装过 pi 才有）" : false;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/** 真加载扩展，返回它注册的 before_agent_start handler（可能不存在）。 */
async function loadHandler(agentDir: string): Promise<Handler | undefined> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
		) => Promise<{ extensions: Array<{ handlers: Map<string, Handler[]> }>; errors: Array<{ path: string; error: string }> }>;
	};
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], agentDir, agentDir);
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	assert.equal(loaded.extensions.length, 1, "应该只加载到 core-rules 这一个扩展");
	return loaded.extensions[0]?.handlers.get("before_agent_start")?.[0];
}

function makeAgentDir(rulesText?: string): { agentDir: string; cleanup: () => void } {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-rules-"));
	if (rulesText !== undefined) fs.writeFileSync(path.join(agentDir, "AGENTS.core.md"), rulesText, "utf-8");
	return { agentDir, cleanup: () => fs.rmSync(agentDir, { recursive: true, force: true }) };
}

/** 驱动一次 before_agent_start；entries 是假的模型可见投影。 */
async function run(handler: Handler, entries: unknown[]): Promise<unknown> {
	return handler(
		{ type: "before_agent_start", prompt: "test", systemPromptOptions: {} },
		{ sessionManager: { buildContextEntries: () => entries } },
	);
}

/** 投影里一条 core-rules custom_message 条目。 */
function coreRulesEntry(hash?: string): Record<string, unknown> {
	return { type: "custom_message", customType: "core-rules", content: "...", display: false, details: hash === undefined ? {} : { hash } };
}

test(
	"空投影 → 注入规则全文（无替换声明），details 带 hash",
	{ skip },
	async () => {
		const { agentDir, cleanup } = makeAgentDir("# RULES\nbe safe");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const handler = await loadHandler(agentDir);
			assert.ok(handler, "扩展应该注册了 before_agent_start handler");
			const result = (await run(handler, [])) as { message?: Record<string, unknown> } | undefined;
			assert.ok(result?.message, "空投影应该注入");
			assert.equal(result.message.customType, "core-rules");
			assert.equal(result.message.display, false);
			assert.equal(result.message.content, "# RULES\nbe safe");
			assert.match(String((result.message.details as { hash: string }).hash), /^[0-9a-f]{16}$/);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			cleanup();
		}
	},
);

test(
	"投影里已有同 hash → 跳过",
	{ skip },
	async () => {
		const text = "# RULES\nbe safe";
		const { agentDir, cleanup } = makeAgentDir(text);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const handler = await loadHandler(agentDir);
			assert.ok(handler);
			const { createHash } = await import("node:crypto");
			const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
			const result = await run(handler, [{ type: "user", content: "hi" }, coreRulesEntry(hash)]);
			assert.equal(result, undefined, "同 hash 不应重复注入");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			cleanup();
		}
	},
);

test(
	"hash 变了 → 带替换声明重注入",
	{ skip },
	async () => {
		const { agentDir, cleanup } = makeAgentDir("# RULES v2");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const handler = await loadHandler(agentDir);
			assert.ok(handler);
			const result = (await run(handler, [coreRulesEntry("stalehash0000000")])) as { message?: Record<string, unknown> } | undefined;
			assert.ok(result?.message, "hash 变更应该重注入");
			assert.ok(
				String(result.message.content).startsWith(REPLACEMENT_NOTICE + "\n\n"),
				"重注入必须带替换声明",
			);
			assert.ok(String(result.message.content).endsWith("# RULES v2"));
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			cleanup();
		}
	},
);

test(
	"规则文件缺失 → 静默跳过",
	{ skip },
	async () => {
		const { agentDir, cleanup } = makeAgentDir(); // 不写 AGENTS.core.md
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const handler = await loadHandler(agentDir);
			assert.ok(handler);
			assert.equal(await run(handler, []), undefined, "文件缺失不应注入");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			cleanup();
		}
	},
);

test(
	"PI_CORE_RULES=off → 不注册 handler",
	{ skip },
	async () => {
		const { agentDir, cleanup } = makeAgentDir("# RULES");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousOff = process.env.PI_CORE_RULES;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_CORE_RULES = "off";
		try {
			const handler = await loadHandler(agentDir);
			assert.equal(handler, undefined, "off 时不应注册 before_agent_start handler");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousOff === undefined) delete process.env.PI_CORE_RULES;
			else process.env.PI_CORE_RULES = previousOff;
			cleanup();
		}
	},
);
