/**
 * Tests for config.ts — 全局 / 项目配置的发现、合并、归一化与环境变量展开。
 *
 * Run with:  node --test clients/pi/extensions/mcp/config.test.ts
 *
 * 用真实临时目录而不是 mock fs：向上查找 `.mcp.json` 这条路径是行为的一部分
 * （「近的赢」「找到就停」），拿 mock 断言调用序列反而更假。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	DEFAULT_HANDSHAKE_TIMEOUT_MS,
	DEFAULT_TOOL_TIMEOUT_MS,
	expandString,
	findProjectMcpConfigPath,
	globalMcpConfigPath,
	loadMcpConfig,
	normalizeServerEntry,
	type McpConfigIssue,
} from "./config.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mcp-config-test-"));
	tempDirs.push(dir);
	return dir;
}

/** 单条 server 条目的归一化助手（两个 describe 共用；server 名固定为 "test"）。 */
function normalizeEntry(
	raw: unknown,
	env: NodeJS.ProcessEnv = {},
): { server?: ReturnType<typeof normalizeServerEntry>; issues: McpConfigIssue[] } {
	const issues: McpConfigIssue[] = [];
	const server = normalizeServerEntry("test", raw, "/tmp/mcp.json", env, issues);
	return { server, issues };
}

/** 造一个「home」目录，全局配置写到 `<home>/.pi/agent/mcp.json`。 */
function writeGlobalConfig(home: string, config: unknown): void {
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "mcp.json"), JSON.stringify(config, null, 2));
}

after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("globalMcpConfigPath", () => {
	it("是 <home>/.pi/agent/mcp.json", () => {
		assert.equal(globalMcpConfigPath("/Users/x"), "/Users/x/.pi/agent/mcp.json");
	});
});

describe("findProjectMcpConfigPath", () => {
	it("从 cwd 往上找最近的 .mcp.json", () => {
		const root = makeTempDir();
		const nested = join(root, "a", "b", "c");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(root, "a", ".mcp.json"), "{}");
		assert.equal(findProjectMcpConfigPath(nested), join(root, "a", ".mcp.json"));
	});

	it("cwd 自己那层优先", () => {
		const root = makeTempDir();
		writeFileSync(join(root, ".mcp.json"), "{}");
		const nested = join(root, "a");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, ".mcp.json"), "{}");
		assert.equal(findProjectMcpConfigPath(nested), join(nested, ".mcp.json"));
	});

	it("找不到就返回 undefined", () => {
		const root = makeTempDir();
		assert.equal(findProjectMcpConfigPath(join(root, "nothing")), undefined);
	});
});

describe("loadMcpConfig", () => {
	it("全局 + 项目：同名 server 项目覆盖全局", () => {
		const home = makeTempDir();
		const project = makeTempDir();
		writeGlobalConfig(home, {
			mcpServers: {
				wechat: { command: "/global/bin", args: ["--global"] },
				other: { command: "/global/other" },
			},
		});
		writeFileSync(
			join(project, ".mcp.json"),
			JSON.stringify({ mcpServers: { wechat: { command: "/project/bin", args: ["--project"] } } }),
		);

		const result = loadMcpConfig({ cwd: project, homeDir: home, env: {} });
		assert.deepEqual(
			result.servers.map((server) => server.name).sort(),
			["other", "wechat"],
		);
		const wechat = result.servers.find((server) => server.name === "wechat");
		assert.equal(wechat?.transport, "stdio");
		assert.equal(wechat?.transport === "stdio" ? wechat.command : undefined, "/project/bin");
		assert.equal(result.sources.length, 2);
		assert.deepEqual(result.issues, []);
	});

	it("两个文件都没有时返回空结果（不是错误）", () => {
		const home = makeTempDir();
		const project = makeTempDir();
		const result = loadMcpConfig({ cwd: project, homeDir: home, env: {} });
		assert.deepEqual(result.servers, []);
		assert.deepEqual(result.sources, []);
		assert.deepEqual(result.issues, []);
	});

	it("坏 JSON 记 issue 但不抛", () => {
		const home = makeTempDir();
		const project = makeTempDir();
		writeFileSync(join(project, ".mcp.json"), "{ not json");
		const result = loadMcpConfig({ cwd: project, homeDir: home, env: {} });
		assert.equal(result.issues.length, 1);
		assert.match(result.issues[0]?.message ?? "", /不是合法 JSON/);
	});

	it("缺少 mcpServers 字段时给出可读的 issue", () => {
		const home = makeTempDir();
		const project = makeTempDir();
		writeFileSync(join(project, ".mcp.json"), JSON.stringify({ servers: {} }));
		const result = loadMcpConfig({ cwd: project, homeDir: home, env: {} });
		assert.match(result.issues[0]?.message ?? "", /mcpServers/);
	});

	it("保留配置里的书写顺序", () => {
		const home = makeTempDir();
		const project = makeTempDir();
		writeGlobalConfig(home, {
			mcpServers: { zebra: { command: "z" }, alpha: { command: "a" } },
		});
		const result = loadMcpConfig({ cwd: project, homeDir: home, env: {} });
		assert.deepEqual(result.servers.map((server) => server.name), ["zebra", "alpha"]);
	});

	it("支持 url 型（http）与 type: sse", () => {
		const home = makeTempDir();
		const project = makeTempDir();
		writeGlobalConfig(home, {
			mcpServers: {
				remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
				legacy: { type: "sse", url: "https://example.com/sse" },
			},
		});
		const result = loadMcpConfig({ cwd: project, homeDir: home, env: {} });
		const remote = result.servers.find((server) => server.name === "remote");
		const legacy = result.servers.find((server) => server.name === "legacy");
		assert.equal(remote?.transport, "http");
		assert.equal(legacy?.transport, "sse");
	});

	it("enabled: false / disabled: true 的条目保留但标为禁用", () => {
		const home = makeTempDir();
		const project = makeTempDir();
		writeGlobalConfig(home, {
			mcpServers: { a: { command: "x", enabled: false }, b: { command: "y", disabled: true } },
		});
		const result = loadMcpConfig({ cwd: project, homeDir: home, env: {} });
		assert.deepEqual(result.servers.map((server) => server.enabled), [false, false]);
	});
});

describe("normalizeServerEntry", () => {
	const normalize = normalizeEntry;

	it("stdio：command / args / env / cwd", () => {
		const { server } = normalize({
			command: "/bin/tool",
			args: ["--a", "b"],
			env: { FOO: "bar" },
			cwd: "/tmp/work",
		});
		assert.ok(server && server.transport === "stdio");
		assert.equal(server.command, "/bin/tool");
		assert.deepEqual(server.args, ["--a", "b"]);
		assert.deepEqual(server.env, { FOO: "bar" });
		assert.equal(server.cwd, "/tmp/work");
		assert.equal(server.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
	});

	it("timeout 可覆盖（毫秒）", () => {
		const { server } = normalize({ command: "x", timeout: 5000 });
		assert.equal(server?.timeoutMs, 5000);
	});

	it("非字符串 args 记为 issue 并跳过该元素", () => {
		const { server, issues } = normalize({ command: "x", args: ["ok", 42] });
		assert.deepEqual(server && server.transport === "stdio" ? server.args : [], ["ok"]);
		assert.match(issues[0]?.message ?? "", /args\[1\]/);
	});

	it("既没有 command 也没有 url → issue", () => {
		const { server, issues } = normalize({ type: "stdio" });
		assert.equal(server, undefined);
		assert.match(issues[0]?.message ?? "", /command/);
	});

	it("不是对象 → issue", () => {
		const { server, issues } = normalize("nope");
		assert.equal(server, undefined);
		assert.equal(issues.length, 1);
	});

	it("headers 里的非字符串值跳过", () => {
		const { server, issues } = normalize({ url: "https://x", headers: { Authorization: "Bearer a", bad: 1 } });
		assert.deepEqual(server && server.transport !== "stdio" ? server.headers : {}, { Authorization: "Bearer a" });
		assert.match(issues[0]?.message ?? "", /bad/);
	});
});

describe("headersCommand（动态请求头）", () => {
	it("http 服务器：解析 headersCommand 与默认超时", () => {
		const { server } = normalizeEntry({ url: "https://x/mcp", headersCommand: "/bin/get-token" });
		assert.ok(server && server.transport === "http");
		assert.equal(server.headersCommand, "/bin/get-token");
		assert.equal(server.headersCommandTimeoutMs, 10_000);
	});

	it("接受 Claude Code / Codex 的字段别名", () => {
		for (const key of ["headersHelper", "http_headers_helper"]) {
			const { server } = normalizeEntry({ url: "https://x/mcp", [key]: "/bin/get-token" });
			assert.equal(server && server.transport !== "stdio" ? server.headersCommand : undefined, "/bin/get-token");
		}
	});

	it("headersCommandTimeout 可覆盖", () => {
		const { server } = normalizeEntry({ url: "https://x/mcp", headersCommand: "cmd", headersCommandTimeout: 2500 });
		assert.equal(server?.headersCommandTimeoutMs, 2500);
	});

	it("命令里的 ${VAR} 会展开", () => {
		const { server } = normalizeEntry(
			{ url: "https://x/mcp", headersCommand: "get-token --profile ${PROFILE}" },
			{ PROFILE: "work" },
		);
		assert.equal(server?.headersCommand, "get-token --profile work");
	});

	it("sse 服务器也支持", () => {
		const { server } = normalizeEntry({ type: "sse", url: "https://x/sse", headersCommand: "cmd" });
		assert.equal(server && server.transport === "sse" ? server.headersCommand : undefined, "cmd");
	});

	it("stdio 服务器上写 headersCommand 会给一条 issue（而不是静默忽略）", () => {
		const { server, issues } = normalizeEntry({ command: "/bin/x", headersHelper: "cmd" });
		assert.equal(server?.transport, "stdio");
		assert.equal(issues.length, 1);
		assert.match(issues[0]?.message ?? "", /只对 http\/sse/);
	});
});

describe("expandString", () => {
	it("${VAR} 展开", () => {
		assert.equal(expandString("a-${TOKEN}-b", { TOKEN: "xyz" }), "a-xyz-b");
	});

	it("${VAR:-默认值} 在变量缺失时用默认值", () => {
		assert.equal(expandString("${TOKEN:-fallback}", {}), "fallback");
	});

	it("${VAR:-默认值} 在变量存在时用变量", () => {
		assert.equal(expandString("${TOKEN:-fallback}", { TOKEN: "real" }), "real");
	});

	it("空字符串算未定义（否则配置文件里的空值会静默吃掉默认值）", () => {
		assert.equal(expandString("${TOKEN:-fallback}", { TOKEN: "" }), "fallback");
	});

	it("未定义且无默认值时保留原文并记 issue", () => {
		const issues: McpConfigIssue[] = [];
		const result = expandString("${MISSING}", {}, { source: "/tmp/mcp.json", server: "s" }, issues);
		assert.equal(result, "${MISSING}");
		assert.equal(issues.length, 1);
		assert.match(issues[0]?.message ?? "", /MISSING/);
	});

	it("多个变量一起展开", () => {
		assert.equal(
			expandString("${A}/${B:-b}", { A: "a" }),
			"a/b",
		);
	});

	it("不碰 $VAR 这种没有花括号的写法（避免误伤命令行参数）", () => {
		assert.equal(expandString("$TOKEN", { TOKEN: "x" }), "$TOKEN");
	});
});

describe("默认超时", () => {
	it("工具调用与握手的默认值分开且都为正", () => {
		assert.ok(DEFAULT_TOOL_TIMEOUT_MS > 0);
		assert.ok(DEFAULT_HANDSHAKE_TIMEOUT_MS > 0);
		assert.ok(DEFAULT_HANDSHAKE_TIMEOUT_MS < DEFAULT_TOOL_TIMEOUT_MS);
	});
});
