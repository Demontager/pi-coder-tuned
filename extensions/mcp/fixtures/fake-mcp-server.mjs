/**
 * fake-mcp-server.mjs — client.test.ts 用的假 MCP stdio 服务端。
 *
 * 只实现测试需要的那部分协议：newline-JSON 的 initialize / tools/list / tools/call，
 * 外加几个「难形状」的返回值（图片、resource、错误、超时、退出、未实现方法）。
 * 事实基准是真实 wechat-local-mcp 的响应形状（protocolVersion 2025-06-18）。
 */

const TOOLS = [
	{
		name: "echo",
		description: "回显传入的参数（JSON 文本）",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string" }, nested: { type: "object" } },
			required: ["text"],
		},
		annotations: { readOnlyHint: true },
	},
	{ name: "no_schema", description: "没有 inputSchema 的工具" },
	{ name: "fail", description: "返回 isError: true", inputSchema: { type: "object", properties: {} } },
	{
		name: "image",
		description: "返回一个 image 内容块",
		inputSchema: { type: "object", properties: {} },
	},
	{ name: "resource", description: "返回 resource 内容块", inputSchema: { type: "object", properties: {} } },
	{ name: "delay", description: "延迟 N 毫秒后返回", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
	{ name: "exit", description: "直接退出进程", inputSchema: { type: "object", properties: {} } },
	{ name: "stderr", description: "往 stderr 写一行再返回", inputSchema: { type: "object", properties: {} } },
	{ name: "server_request", description: "向客户端发一个反向请求再返回", inputSchema: { type: "object", properties: {} } },
];

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let buffer = "";
let nextServerRequestId = 1000;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handleLine(line);
		index = buffer.indexOf("\n");
	}
});

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleLine(line) {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}

	// 客户端对我们反向请求的回复（错误响应也要看得见）。
	if (!("method" in message) && "id" in message && message.id >= 1000) {
		process.stderr.write(
			`server request ${message.id} answered: ${message.error ? `error ${message.error.code}` : "result"}\n`,
		);
		return;
	}
	if (!("method" in message)) return;

	if (message.method === "notifications/cancelled") {
		process.stderr.write(`cancelled request ${message.params?.requestId}: ${message.params?.reason}\n`);
		return;
	}
	if (!("id" in message)) return;

	switch (message.method) {
		case "initialize":
			respond(message.id, {
				protocolVersion: "2025-06-18",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "fake-mcp-server", version: "9.9.9" },
			});
			return;
		case "tools/list":
			respond(message.id, { tools: TOOLS });
			return;
		case "tools/call":
			handleCall(message);
			return;
		default:
			respondError(message.id, -32601, `Method not found: ${message.method}`);
	}
}

function handleCall(message) {
	const name = message.params?.name;
	const args = message.params?.arguments ?? {};
	switch (name) {
		case "echo":
			respond(message.id, { content: [{ type: "text", text: JSON.stringify(args) }] });
			return;
		case "fail":
			respond(message.id, {
				content: [{ type: "text", text: "工具内部失败了" }],
				isError: true,
			});
			return;
		case "image":
			respond(message.id, {
				content: [
					{ type: "text", text: "这是一张图片" },
					{ type: "image", data: PNG, mimeType: "image/png" },
					{ type: "audio", data: "AAAA", mimeType: "audio/wav" },
					{ type: "resource", resource: { uri: "file:///tmp/x.txt", mimeType: "text/plain", text: "resource 文本" } },
					{ type: "resource", resource: { uri: "file:///tmp/big.bin", mimeType: "application/octet-stream", blob: "AAECAw==" } },
					{ type: "resource_link", uri: "https://example.com/a", name: "链接名" },
				],
			});
			return;
		case "resource":
			respond(message.id, { content: [{ type: "resource", resource: { uri: "x", blob: "AAECAw==" } }] });
			return;
		case "delay": {
			const ms = typeof args.ms === "number" ? args.ms : 100;
			setTimeout(() => respond(message.id, { content: [{ type: "text", text: `延迟 ${ms}ms` }] }), ms);
			return;
		}
		case "exit":
			setTimeout(() => process.exit(3), 10);
			respond(message.id, { content: [{ type: "text", text: "bye" }] });
			return;
		case "server_request": {
			// 反向请求：客户端应该回一个「未实现」错误，而不是傻等。
			send({ jsonrpc: "2.0", id: nextServerRequestId++, method: "roots/list" });
			respond(message.id, { content: [{ type: "text", text: "server request sent" }] });
			return;
		}
		case "stderr":
			process.stderr.write("这是一行诊断输出\n");
			respond(message.id, { content: [{ type: "text", text: "ok" }] });
			return;
		default:
			respondError(message.id, -32602, `Unknown tool: ${name}`);
	}
}
