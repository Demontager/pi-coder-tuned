/**
 * Tests for client.ts — 三种传输的真实端到端用例。
 *
 * Run with:  node --test clients/pi/extensions/mcp/client.test.ts
 *
 * stdio 用的是真正 spawn 出来的 fixture 子进程（fixtures/fake-mcp-server.mjs），HTTP/SSE 用的是
 * 测试里现起的 node:http 服务 —— 不 mock 传输层，因为这一层的坑几乎全在「字节怎么流」上：
 * 半个 JSON、SSE 响应体、session id 往返、进程中途退出、超时与取消。
 *
 * 真实 wechat-local-mcp 的手感由 `npm run mcp:probe`（scripts/mcp-probe.mjs）验证，
 * 不放进单测：那需要本机微信数据。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { McpClient } from "./client.ts";
import { McpConnectionError, McpError, MCP_PROTOCOL_VERSION } from "./protocol.ts";
import type { McpRemoteServer, McpStdioServer } from "./config.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
const TOKEN_HELPER = fileURLToPath(new URL("./fixtures/token-helper.mjs", import.meta.url));

function stdioConfig(overrides: Partial<McpStdioServer> = {}): McpStdioServer {
	return {
		name: "fake",
		transport: "stdio",
		command: process.execPath,
		args: [FIXTURE],
		env: {},
		timeoutMs: 5000,
		enabled: true,
		source: "test",
		...overrides,
	};
}

const clients: McpClient[] = [];
const servers: Server[] = [];

async function connectStdio(overrides: Partial<McpStdioServer> = {}, diagnostics: string[] = []): Promise<McpClient> {
	const client = await McpClient.connect(stdioConfig(overrides), {
		handshakeTimeoutMs: 5000,
		onDiagnostic: (line) => diagnostics.push(line),
	});
	clients.push(client);
	return client;
}

after(async () => {
	await Promise.all(clients.map((client) => client.close().catch(() => {})));
	await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("stdio transport", () => {
	it("完成握手并读出 serverInfo / 能力 / 工具表", async () => {
		const client = await connectStdio();
		assert.equal(client.serverInfo.name, "fake-mcp-server");
		assert.equal(client.serverInfo.version, "9.9.9");
		assert.equal(client.protocolVersion, "2025-06-18");
		assert.deepEqual(Object.keys(client.capabilities), ["tools"]);

		const tools = await client.listTools();
		assert.equal(tools.length, 9);
		assert.equal(tools[0]?.name, "echo");
		assert.equal(tools[0]?.annotations?.readOnlyHint, true);
		// 没有 inputSchema 的工具也要能列出来（index.ts 那边会给它兜一个空对象 schema）。
		assert.equal(tools.find((tool) => tool.name === "no_schema")?.inputSchema, undefined);
	});

	it("tools/call 把参数原样送到服务端并把文本取回来", async () => {
		const client = await connectStdio();
		const result = await client.callTool("echo", { text: "你好", nested: { a: 1 } });
		assert.equal(result.isError, false);
		assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), {
			text: "你好",
			nested: { a: 1 },
		});
	});

	it("isError: true 的结果照原样返回（由上层决定怎么报给模型）", async () => {
		const client = await connectStdio();
		const result = await client.callTool("fail", {});
		assert.equal(result.isError, true);
		assert.equal((result.content[0] as { text: string }).text, "工具内部失败了");
	});

	it("服务端返回 JSON-RPC 错误时抛 McpError 并保留错误码", async () => {
		const client = await connectStdio();
		await assert.rejects(
			() => client.callTool("nope", {}),
			(error: unknown) => error instanceof McpError && error.code === -32602 && /Unknown tool/.test(error.message),
		);
	});

	it("超过 timeout 的调用抛超时错误，并发出 cancelled 通知", async () => {
		const diagnostics: string[] = [];
		const client = await connectStdio({ timeoutMs: 250 }, diagnostics);
		await assert.rejects(
			() => client.callTool("delay", { ms: 3000 }),
			(error: unknown) => error instanceof McpError && /timed out/.test(error.message),
		);
		// fixture 收到 notifications/cancelled 会往 stderr 写一行，经 onDiagnostic 回到这里。
		await waitFor(() => diagnostics.some((line) => line.startsWith("cancelled request")));
	});

	it("AbortSignal 取消在途调用", async () => {
		const diagnostics: string[] = [];
		const client = await connectStdio({ timeoutMs: 10_000 }, diagnostics);
		const controller = new AbortController();
		const pending = client.callTool("delay", { ms: 3000 }, { signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		await assert.rejects(pending, (error: unknown) => error instanceof McpConnectionError && /cancelled/.test(error.message));
		await waitFor(() => diagnostics.some((line) => line.startsWith("cancelled request")));
	});

	it("子进程退出时在途请求被拒（不是永远挂着）", async () => {
		const client = await connectStdio();
		// exit 工具会先回响应再退出，所以这里等的是「连接变成关闭」这件事。
		await client.callTool("exit", {}).catch(() => undefined);
		await waitFor(() => client.isClosed);
		assert.equal(client.isClosed, true);
		await assert.rejects(() => client.callTool("echo", { text: "x" }), McpConnectionError);
	});

	it("采集子进程 stderr 作为诊断信息", async () => {
		const diagnostics: string[] = [];
		const client = await connectStdio({}, diagnostics);
		await client.callTool("stderr", {});
		await waitFor(() => diagnostics.includes("这是一行诊断输出"));
	});

	it("回复服务端的反向请求（回「未实现」而不是傻等）", async () => {
		const diagnostics: string[] = [];
		const client = await connectStdio({}, diagnostics);
		await client.callTool("server_request", {});
		await waitFor(() => diagnostics.some((line) => /answered: error -32601/.test(line)));
	});

	it("close() 之后再次调用直接失败", async () => {
		const client = await connectStdio();
		await client.close();
		assert.equal(client.isClosed, true);
		await assert.rejects(() => client.listTools(), McpConnectionError);
	});

	it("command 不存在时给出可读的连接错误", async () => {
		await assert.rejects(
			() =>
				McpClient.connect(stdioConfig({ command: "/nonexistent/mcp-binary-xyz" }), {
					handshakeTimeoutMs: 3000,
				}),
			(error: unknown) =>
				error instanceof McpConnectionError && /subprocess failed to start|connection failed/.test(error.message),
		);
	});
});

describe("streamable HTTP transport", () => {
	it("JSON 响应：握手 + 工具调用，并带上 session id 与协议版本头", async () => {
		const seen: Array<{ headers: IncomingMessage["headers"]; body: unknown }> = [];
		const http = await startHttpServer((req, res, body) => {
			seen.push({ headers: req.headers, body });
			const message = body as { id?: number; method?: string };
			if (message.method === "initialize") {
				res.setHeader("mcp-session-id", "sess-42");
				respondJson(res, 200, {
					jsonrpc: "2.0",
					id: message.id,
					result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-fake", version: "1.0" } },
				});
				return;
			}
			if (message.method === "notifications/initialized") {
				res.writeHead(202).end();
				return;
			}
			if (message.method === "tools/list") {
				respondJson(res, 200, {
					jsonrpc: "2.0",
					id: message.id,
					result: { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] },
				});
				return;
			}
			respondJson(res, 200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "pong" }] } });
		});
		const client = await McpClient.connect({ ...http.config, name: "http-fake" });
		clients.push(client);

		const tools = await client.listTools();
		assert.equal(tools[0]?.name, "ping");
		const result = await client.callTool("ping", {});
		assert.equal((result.content[0] as { text: string }).text, "pong");

		const notInitialize = seen.filter((entry) => (entry.body as { method?: string }).method !== "initialize");
		assert.ok(notInitialize.length > 0);
		for (const entry of notInitialize) {
			assert.equal(entry.headers["mcp-session-id"], "sess-42");
			assert.equal(entry.headers["mcp-protocol-version"], MCP_PROTOCOL_VERSION);
		}
	});

	it("SSE 响应体（且流不主动结束）也能拿到响应", async () => {
		const http = await startHttpServer((req, res, body) => {
			const message = body as { id?: number; method?: string };
			if (message.method === "initialize") {
				respondJson(res, 200, {
					jsonrpc: "2.0",
					id: message.id,
					result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "sse-body", version: "1.0" } },
				});
				return;
			}
			if (message.method === "notifications/initialized") {
				res.writeHead(202).end();
				return;
			}
			// 响应走 SSE，之后**不关流**：客户端必须自己收工。
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } })}\n\n`);
		});
		const client = await McpClient.connect({ ...http.config, name: "sse-body" });
		clients.push(client);
		assert.deepEqual(await client.listTools(), []);
		// 上一个请求的 SSE 流还挂着（服务端没关），下一个请求照样发得出去。
		const second = await client.callTool("anything", {});
		assert.deepEqual(second.content, []);
	});

	it("HTTP 错误状态给出带状态码与 body 的错误", async () => {
		const http = await startHttpServer((_req, res) => {
			respondJson(res, 500, { error: "backend exploded" });
		});
		await assert.rejects(
			() => McpClient.connect({ ...http.config, name: "broken" }, { handshakeTimeoutMs: 2000 }),
			(error: unknown) => error instanceof McpConnectionError && /HTTP 500/.test(error.message) && /backend exploded/.test(error.message),
		);
	});

	it("空响应体被视为协议错误", async () => {
		const http = await startHttpServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" }).end();
		});
		await assert.rejects(
			() => McpClient.connect({ ...http.config, name: "empty" }, { handshakeTimeoutMs: 2000 }),
			(error: unknown) => error instanceof McpConnectionError && /empty HTTP response/.test(error.message),
		);
	});
});

describe("legacy SSE transport", () => {
	it("GET 流里的 endpoint 事件 + POST 到该端点 + 响应从流里回来", async () => {
		const streams = new Set<ServerResponse>();
		const http = await startHttpServer((req, res, body) => {
			if (req.method === "GET") {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write("event: endpoint\ndata: /messages?session=abc\n\n");
				streams.add(res);
				res.on("close", () => streams.delete(res));
				return;
			}
			const message = body as { id?: number; method?: string };
			res.writeHead(202).end();
			if (message.method === "notifications/initialized") return;
			const result =
				message.method === "initialize"
					? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "legacy-sse", version: "1.0" } }
					: { tools: [{ name: "old_tool", description: "老协议工具", inputSchema: { type: "object", properties: {} } }] };
			const payload = `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`;
			for (const stream of streams) stream.write(payload);
		});

		const client = await McpClient.connect({ ...http.config, transport: "sse", name: "legacy" });
		clients.push(client);
		assert.equal(client.serverInfo.name, "legacy-sse");
		assert.equal(client.protocolVersion, "2024-11-05");
		const tools = await client.listTools();
		assert.equal(tools[0]?.name, "old_tool");
	});
});

describe("dynamic headers (headersCommand)", () => {
	const tempDirs: string[] = [];

	function counterPath(): string {
		const dir = mkdtempSync(join(tmpdir(), "mcp-header-test-"));
		tempDirs.push(dir);
		return join(dir, "token-count");
	}

	after(() => {
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	});

	/** 只放行指定的 Authorization 值，其余一律 401 —— 这正是头命令要解决的场景。 */
	async function startTokenGatedServer(expected: string): Promise<{
		config: McpRemoteServer;
		received: string[];
		requests: () => number;
	}> {
		const received: string[] = [];
		let requests = 0;
		const http = await startHttpServer((req, res, body) => {
			requests += 1;
			const auth = req.headers["authorization"] ?? "";
			received.push(auth);
			if (auth !== expected) {
				res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
				return;
			}
			const message = body as { id?: number; method?: string };
			if (message.method === "initialize") {
				respondJson(res, 200, {
					jsonrpc: "2.0",
					id: message.id,
					result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "gated", version: "1.0" } },
				});
				return;
			}
			if (message.method === "notifications/initialized") {
				res.writeHead(202).end();
				return;
			}
			respondJson(res, 200, {
				jsonrpc: "2.0",
				id: message.id,
				result: { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] },
			});
		});
		return { config: { ...http.config, name: "gated", headersCommandTimeoutMs: 10_000 }, received, requests: () => requests };
	}

	it("命令取来的头在首次请求前就已生效，且每次连接只跑一次", async () => {
		const counter = counterPath();
		const gated = await startTokenGatedServer("Bearer token-1");
		const client = await McpClient.connect({
			...gated.config,
			headersCommand: `${process.execPath} ${TOKEN_HELPER} --file ${counter}`,
		});
		clients.push(client);
		const tools = await client.listTools();
		assert.equal(tools[0]?.name, "ping");
		// initialize / notifications / tools-list 三个请求带的是同一个 token：命令只在连接时跑了一次。
		assert.ok(gated.received.every((value) => value === "Bearer token-1"));
		assert.equal(readFileSync(counter, "utf8").trim(), "1");
	});

	it("401 后重跑命令，头变了就用新头重试一次", async () => {
		const counter = counterPath();
		const gated = await startTokenGatedServer("Bearer token-2");
		const client = await McpClient.connect({
			...gated.config,
			headersCommand: `${process.execPath} ${TOKEN_HELPER} --file ${counter}`,
		});
		clients.push(client);
		assert.equal(client.serverInfo.name, "gated");
		assert.deepEqual(gated.received.slice(0, 2), ["Bearer token-1", "Bearer token-2"]);
		assert.equal(readFileSync(counter, "utf8").trim(), "2");
	});

	it("命令每次返回同一个头时不重试", async () => {
		const gated = await startTokenGatedServer("Bearer never-matches");
		await assert.rejects(
			() =>
				McpClient.connect({
					...gated.config,
					headersCommand: `${process.execPath} ${TOKEN_HELPER} --fixed token-1`,
				}),
			(error: unknown) => error instanceof McpConnectionError && /HTTP 401/.test(error.message),
		);
		assert.equal(gated.requests(), 1, "头没变化就不该重试");
	});

	it("头命令失败：记诊断、退回静态 headers 继续连", async () => {
		const diagnostics: string[] = [];
		const gated = await startTokenGatedServer("Bearer static-token");
		const client = await McpClient.connect(
			{
				...gated.config,
				headers: { Authorization: "Bearer static-token" },
				headersCommand: `${process.execPath} ${TOKEN_HELPER} --fail`,
			},
			{ onDiagnostic: (line) => diagnostics.push(line) },
		);
		clients.push(client);
		assert.equal(client.serverInfo.name, "gated");
		assert.ok(
			// fixture 往 stderr 写的是 "token 服务连不上"，runCommand 把它拼进错误信息。
			diagnostics.some((line) => line.includes("Header command failed") && line.includes("token 服务连不上")),
			`诊断里应记录头命令失败：${diagnostics.join(" | ")}`,
		);
	});

	it("被 401 拒绝时，错误信息里包含头命令的失败原因", async () => {
		const gated = await startTokenGatedServer("Bearer static-token");
		await assert.rejects(
			() =>
				McpClient.connect({
					...gated.config,
					headers: { Authorization: "Bearer wrong-static" },
					headersCommand: `${process.execPath} ${TOKEN_HELPER} --fail`,
				}),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				assert.match(message, /HTTP 401/);
			assert.match(message, /header command failed/i);
				return true;
			},
		);
	});

	it("`Key: Value` 行格式的命令输出也能用", async () => {
		const gated = await startTokenGatedServer("Bearer token-fixed");
		const client = await McpClient.connect({
			...gated.config,
			headersCommand: `${process.execPath} ${TOKEN_HELPER} --lines`,
		});
		clients.push(client);
		assert.equal(client.serverInfo.name, "gated");
	});

	it("旧版 SSE：GET 长连接与 POST 都带上动态头", async () => {
		const streams = new Set<ServerResponse>();
		const http = await startHttpServer((req, res, body) => {
			if ((req.headers["authorization"] ?? "") !== "Bearer token-1") {
				res.writeHead(401).end();
				return;
			}
			if (req.method === "GET") {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write("event: endpoint\ndata: /messages\n\n");
				streams.add(res);
				res.on("close", () => streams.delete(res));
				return;
			}
			const message = body as { id?: number; method?: string };
			res.writeHead(202).end();
			if (message.method === "notifications/initialized") return;
			const result =
				message.method === "initialize"
					? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "legacy-gated", version: "1.0" } }
					: { tools: [] };
			for (const stream of streams) {
				stream.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
			}
		});
		const client = await McpClient.connect({
			...http.config,
			transport: "sse",
			name: "legacy-gated",
			headersCommand: `${process.execPath} ${TOKEN_HELPER} --fixed token-1`,
		});
		clients.push(client);
		assert.equal(client.serverInfo.name, "legacy-gated");
		assert.deepEqual(await client.listTools(), []);
	});
});

interface HttpFixture {
	config: McpRemoteServer;
	close: () => Promise<void>;
}

type HttpHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void;

async function startHttpServer(handler: HttpHandler): Promise<HttpFixture> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body: unknown;
			try {
				body = raw ? JSON.parse(raw) : undefined;
			} catch {
				body = raw;
			}
			handler(req, res, body);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const base = `http://127.0.0.1:${port}`;
	return {
		config: {
			name: "http",
			transport: "http",
			url: `${base}/mcp`,
			headers: {},
			timeoutMs: 5000,
			enabled: true,
			source: "test",
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
	res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
}

/** 轮询等待条件成立，避免给超时/退出这类异步动作硬编码 sleep。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("waitFor 超时");
}
