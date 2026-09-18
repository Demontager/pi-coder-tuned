/**
 * client.ts — 最小可用的 MCP 客户端：三种传输 + 一次握手 + 两个方法（tools/list、tools/call）。
 *
 * 为什么自己实现而不是依赖 `@modelcontextprotocol/sdk`：
 *   1. 本仓库的 pi 扩展全是零 npm 依赖（pi 只保证 pi / pi-tui / typebox 三个 peer 可解析），
 *      引 SDK 就得在 `~/.pi/agent/extensions/mcp/` 下铺 node_modules，装/同步成本陡增；
 *   2. 我们要的协议面窄得可怜 —— newline-JSON 的 stdio、一个 POST、一个 SSE 流 ——
 *      SDK 里真正用得上的部分不到 400 行，其余是 OAuth / sampling / elicitation / tasks。
 * 已实测：对着真实 `wechat-local-mcp` 进程完成 initialize → tools/list → tools/call。
 *
 * 支持的传输：
 *   - `stdio`：spawn 子进程，一行一个 JSON-RPC（MCP spec）。默认路径。
 *   - `http`：streamable HTTP（2025-06-18）—— 每条消息一个 POST，响应可能是
 *     `application/json` 整包，也可能是 `text/event-stream`；`Mcp-Session-Id` 往返。
 *   - `sse`：旧版 HTTP+SSE（2024-11-05）—— GET 长连接收 `endpoint` 事件，再往该 URL POST。
 *
 * 刻意不做：OAuth（只支持静态 headers）、sampling / elicitation / roots（服务端反向请求
 * 一律回「不支持」错误，避免对端傻等）、progress 通知透传、`notifications/tools/list_changed`
 * 热更新（会话期工具表不变；改了配置用 `/mcp reload`）。
 *
 * 诊断输出不走 stdout/stderr：interactive pi 里往 stderr 写会直接糊在输入框上
 * （仓库里 subagent-log-guard 就是为这个存在的）。这里全部经 `onDiagnostic` 回调交给上层
 * 收在内存环形缓冲里，由 `/mcp` 状态和工具报错带出来。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
	describeHeaderNames,
	headersSignature,
	mergeHeaders,
	resolveCommandHeaders,
} from "./headers-command.ts";
import {
	createCancelledNotification,
	createLineDecoder,
	createSseDecoder,
	encodeStdioFrame,
	JSONRPC_METHOD_NOT_FOUND,
	McpConnectionError,
	McpError,
	MCP_PROTOCOL_VERSION,
	parseJsonRpcMessage,
	toErrorFromResponse,
	type JsonRpcMessage,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
} from "./protocol.ts";
import {
	DEFAULT_HANDSHAKE_TIMEOUT_MS,
	type McpRemoteServer,
	type McpServerConfig,
	type McpStdioServer,
} from "./config.ts";

/** 保留多少行 stderr 用于报错（stdio server 的报错都走 stderr，不读就等于看不见）。 */
const STDERR_KEEP_LINES = 20;

/** close() 时给子进程的宽限期，超时就 SIGKILL。 */
const STDIO_KILL_GRACE_MS = 2000;

/** 请求超时（自定错误码，与 JSON-RPC 保留区间不冲突）。 */
const REQUEST_TIMEOUT_CODE = -32001;

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: Record<string, unknown>;
}

export interface McpToolCallResult {
	content: unknown[];
	isError: boolean;
	structuredContent?: unknown;
}

interface TransportHandlers {
	onMessage: (message: JsonRpcMessage) => void;
	onClose: (error: McpConnectionError) => void;
}

interface McpTransport {
	readonly label: string;
	start(): Promise<void>;
	send(message: JsonRpcMessage): Promise<void>;
	close(): Promise<void>;
}

interface PendingRequest {
	method: string;
	resolve: (response: JsonRpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
	abortListener?: () => void;
	signal?: AbortSignal;
}

export interface McpClientOptions {
	/** 覆盖握手超时（毫秒），默认 20s。 */
	handshakeTimeoutMs?: number;
	/** 服务端 stderr / 协议异常等诊断信息（默认丢弃）。 */
	onDiagnostic?: (line: string, server: string) => void;
}

/** 一个已握手的 MCP 会话。请求按 id 相关，单连接串行发送、并行等待。 */
export class McpClient {
	readonly serverName: string;
	readonly config: McpServerConfig;
	readonly transportLabel: string;

	/** initialize 的结果，握手时写入。 */
	serverInfo: { name?: string; version?: string } = {};
	protocolVersion: string = MCP_PROTOCOL_VERSION;
	capabilities: Record<string, unknown> = {};

	private readonly transport: McpTransport;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly diagnostician: (line: string) => void;
	private nextId = 1;
	private closed = false;

	private constructor(config: McpServerConfig, transport: McpTransport, options: McpClientOptions) {
		this.config = config;
		this.serverName = config.name;
		this.transport = transport;
		this.transportLabel = describeTransport(config);
		this.diagnostician = (line: string) => options.onDiagnostic?.(line, config.name);
	}

	/** 建立传输 → initialize → notifications/initialized。失败抛 McpConnectionError / McpError。 */
	static async connect(config: McpServerConfig, options: McpClientOptions = {}): Promise<McpClient> {
		// 先建 client 再建 transport：handlers 里的 current 变量在两个对象之间搭桥，
		// 避免「传输要先有消息处理器、处理器要先有 client」这个循环。
		let current: McpClient | undefined;
		const handlers: TransportHandlers = {
			onMessage: (message) => current?.handleMessage(message),
			onClose: (error) => current?.handleClose(error),
		};
		const transport: McpTransport =
			config.transport === "stdio"
				? new StdioTransport(config, handlers, options)
				: config.transport === "sse"
					? new LegacySseTransport(config, handlers, options)
					: new StreamableHttpTransport(config, handlers, options);
		const client = new McpClient(config, transport, options);
		current = client;

		try {
			await transport.start();
			const response = await client.request(
				"initialize",
				{
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "pi-mcp", version: "0.1.0" },
				},
				{ timeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS },
			);
			const result = (response.result ?? {}) as Record<string, unknown>;
			const serverInfo = (result.serverInfo ?? {}) as { name?: string; version?: string };
			if (serverInfo && typeof serverInfo === "object") client.serverInfo = serverInfo;
			if (typeof result.protocolVersion === "string") client.protocolVersion = result.protocolVersion;
			if (result.capabilities && typeof result.capabilities === "object") {
				client.capabilities = result.capabilities as Record<string, unknown>;
			}
			client.notify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
			return client;
		} catch (error) {
			await transport.close().catch(() => {});
			if (error instanceof McpError || error instanceof McpConnectionError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new McpConnectionError(`${config.name}: ${client.transportLabel} 连接失败：${message}`);
		}
	}

	async listTools(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpToolInfo[]> {
		const response = await this.request("tools/list", {}, {
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
		});
		const result = (response.result ?? {}) as { tools?: unknown };
		const tools = Array.isArray(result.tools) ? result.tools : [];
		return tools
			.filter(
				(tool): tool is Record<string, unknown> =>
					typeof tool === "object" && tool !== null && typeof (tool as { name?: unknown }).name === "string",
			)
			.map((tool) => ({
				name: tool.name as string,
				description: typeof tool.description === "string" ? tool.description : undefined,
				inputSchema: tool.inputSchema,
				annotations:
					typeof tool.annotations === "object" && tool.annotations !== null
						? (tool.annotations as Record<string, unknown>)
						: undefined,
			}));
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		options: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<McpToolCallResult> {
		const response = await this.request("tools/call", { name, arguments: args }, {
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
		});
		const result = (response.result ?? {}) as { content?: unknown; isError?: unknown; structuredContent?: unknown };
		return {
			content: Array.isArray(result.content) ? result.content : [],
			isError: result.isError === true,
			structuredContent: result.structuredContent,
		};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.rejectAll(new McpConnectionError(`${this.serverName}: 连接已关闭`));
		await this.transport.close().catch(() => {});
	}

	get isClosed(): boolean {
		return this.closed;
	}

	private notify(message: JsonRpcNotification): void {
		if (this.closed) return;
		void this.transport.send(message).catch((error) => {
			this.diagnostician(`通知 ${message.method} 发送失败：${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private request(
		method: string,
		params: unknown,
		options: { signal?: AbortSignal; timeoutMs: number },
	): Promise<JsonRpcResponse> {
		if (this.closed) return Promise.reject(new McpConnectionError(`${this.serverName}: 连接已关闭`));
		if (options.signal?.aborted) {
			return Promise.reject(new McpConnectionError(`${this.serverName}: 请求在发送前已被取消`));
		}
		const id = this.nextId;
		this.nextId += 1;
		const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

		return new Promise<JsonRpcResponse>((resolve, reject) => {
			const pending: PendingRequest = { method, resolve, reject, timer: undefined, signal: options.signal };
			if (options.timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					if (!this.pending.delete(id)) return;
					this.sendCancel(id, `timeout after ${options.timeoutMs}ms`);
					reject(new McpError(REQUEST_TIMEOUT_CODE, `${this.serverName}: ${method} 超时（${options.timeoutMs}ms）`));
				}, options.timeoutMs);
				pending.timer.unref?.();
			}
			if (options.signal) {
				pending.abortListener = () => {
					if (!this.pending.delete(id)) return;
					this.sendCancel(id, "client aborted");
					reject(new McpConnectionError(`${this.serverName}: ${method} 已取消`));
				};
				options.signal.addEventListener("abort", pending.abortListener, { once: true });
			}
			this.pending.set(id, pending);
			void this.transport.send(message).catch((error) => {
				this.settle(id, undefined, error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	private sendCancel(requestId: number, reason: string): void {
		if (this.closed) return;
		void this.transport.send(createCancelledNotification(requestId, reason)).catch(() => {});
	}

	private settle(id: number, response?: JsonRpcResponse, error?: Error): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.abortListener && pending.signal) pending.signal.removeEventListener("abort", pending.abortListener);
		if (error) {
			pending.reject(error);
			return;
		}
		if (!response) {
			pending.reject(new McpConnectionError(`${this.serverName}: ${pending.method} 没有拿到响应`));
			return;
		}
		if ("error" in response) {
			pending.reject(toErrorFromResponse(response.error));
			return;
		}
		pending.resolve(response);
	}

	private rejectAll(error: Error): void {
		for (const id of [...this.pending.keys()]) this.settle(id, undefined, error);
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (!("method" in message)) {
			const response = message as JsonRpcResponse;
			const id = typeof response.id === "number" ? response.id : Number(response.id);
			if (Number.isFinite(id)) this.settle(id, response);
			return;
		}

		// 服务端反向请求（sampling / elicitation / roots / ping）：一律明确回「不支持」，
		// 否则对端会一直等一个永远不会来的答案。
		if ("id" in message) {
			const request = message as JsonRpcRequest;
			void this.transport
				.send({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: JSONRPC_METHOD_NOT_FOUND, message: `pi 未实现服务端请求 ${request.method}` },
				})
				.catch(() => {});
			this.diagnostician(`忽略服务端请求 ${request.method}（未实现）`);
			return;
		}

		if (message.method === "notifications/message") {
			const params = message.params as { level?: string; data?: unknown } | undefined;
			this.diagnostician(`[${params?.level ?? "log"}] ${formatLogData(params?.data)}`);
		}
	}

	private handleClose(error: McpConnectionError): void {
		if (this.closed) return;
		this.closed = true;
		this.rejectAll(error);
	}
}

function formatLogData(data: unknown): string {
	if (typeof data === "string") return data;
	try {
		return JSON.stringify(data);
	} catch {
		return String(data);
	}
}

export function describeTransport(config: McpServerConfig): string {
	if (config.transport === "stdio") return `${config.command} ${config.args.join(" ")}`.trim();
	return `${config.transport} ${config.url}`;
}

/** stdio：一行一帧的 JSON-RPC。 */
class StdioTransport implements McpTransport {
	readonly label: string;
	private readonly config: McpStdioServer;
	private readonly handlers: TransportHandlers;
	private readonly options: McpClientOptions;
	private child: ChildProcessWithoutNullStreams | undefined;
	private readonly decoder = createLineDecoder();
	private readonly stderrLines: string[] = [];
	private closed = false;

	constructor(config: McpStdioServer, handlers: TransportHandlers, options: McpClientOptions) {
		this.config = config;
		this.handlers = handlers;
		this.options = options;
		this.label = describeTransport(config);
	}

	async start(): Promise<void> {
		const { config } = this;
		this.child = spawn(config.command, config.args, {
			cwd: config.cwd,
			env: { ...process.env, ...config.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => {
			for (const line of this.decoder(chunk)) {
				if (!line.trim()) continue;
				try {
					this.handlers.onMessage(parseJsonRpcMessage(line));
				} catch (error) {
					this.diagnostician(
						`stdout 上的数据不是 JSON-RPC，已忽略：${line.slice(0, 200)}（${error instanceof Error ? error.message : String(error)}）`,
					);
				}
			}
		});

		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			for (const line of chunk.split("\n")) {
				if (!line.trim()) continue;
				this.stderrLines.push(line);
				if (this.stderrLines.length > STDERR_KEEP_LINES) this.stderrLines.shift();
				this.diagnostician(line);
			}
		});

		this.child.on("error", (error) => {
			this.handlers.onClose(new McpConnectionError(`${config.name}: 子进程启动失败：${error.message}`));
		});
		this.child.on("exit", (code, signal) => {
			if (this.closed) return;
			this.handlers.onClose(
				new McpConnectionError(
					`${config.name}: 子进程退出（code=${code ?? "null"} signal=${signal ?? "null"}）${this.stderrTail()}`,
				),
			);
		});
	}

	async send(message: JsonRpcMessage): Promise<void> {
		const child = this.child;
		if (!child || this.closed) throw new McpConnectionError(`${this.config.name}: 子进程不可用`);
		await new Promise<void>((resolve, reject) => {
			child.stdin.write(encodeStdioFrame(message), (error) => (error ? reject(error) : resolve()));
		});
	}

	async close(): Promise<void> {
		const child = this.child;
		this.closed = true;
		if (!child) return;
		await new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				resolve();
				return;
			}
			const killTimer = setTimeout(() => child.kill("SIGKILL"), STDIO_KILL_GRACE_MS);
			killTimer.unref?.();
			child.once("exit", () => {
				clearTimeout(killTimer);
				resolve();
			});
			// MCP stdio 服务端（FastMCP 等）看到 stdin EOF 就会自己退出，先关管道再补信号。
			try {
				child.stdin.end();
			} catch {
				// 管道已经坏了：下面还有信号兜底。
			}
			child.kill("SIGTERM");
		});
	}

	private stderrTail(): string {
		if (this.stderrLines.length === 0) return "";
		return `\nstderr:\n${this.stderrLines.join("\n")}`;
	}

	private diagnostician(line: string): void {
		this.options.onDiagnostic?.(line, this.config.name);
	}
}

/**
 * 动态请求头的状态机（两个远程传输共用）。
 *
 * 三件事：① 每次连接只跑一次头命令（`ensure`）；② 401/403 时可以重跑一次，**只有头真的变了**
 * 才让调用方重试请求（否则重试一次还是同样结果，白跑）；③ 失败不抛异常 —— 退回静态 headers
 * 继续连，把原因存在 `lastError` 里，等真被拒时拼进错误信息（否则用户只看到 401，不知道是命令挂了）。
 */
class DynamicHeaderResolver {
	private readonly config: McpRemoteServer;
	private readonly report: (line: string) => void;
	private resolved = false;
	private dynamic: Record<string, string> = {};
	private signature = "";
	private failure: string | undefined;

	constructor(config: McpRemoteServer, report: (line: string) => void) {
		this.config = config;
		this.report = report;
	}

	get current(): Record<string, string> {
		return this.dynamic;
	}

	/** 头命令的最近一次失败原因（成功或无命令时为 undefined）。 */
	errorSuffix(): string {
		return this.failure ? `（头命令失败：${this.failure}）` : "";
	}

	async ensure(signal?: AbortSignal): Promise<void> {
		if (this.resolved) return;
		this.resolved = true;
		await this.refresh("", signal);
	}

	/** 重跑命令；返回头是否发生了变化。 */
	async refresh(reason: string, signal?: AbortSignal): Promise<boolean> {
		const command = this.config.headersCommand;
		if (!command) return false;
		try {
			const result = await resolveCommandHeaders(
				{ command, timeoutMs: this.config.headersCommandTimeoutMs },
				{ signal },
			);
			for (const warning of result.warnings) this.report(`头命令：${warning}`);
			const nextSignature = headersSignature(result.headers);
			const changed = nextSignature !== this.signature;
			this.dynamic = result.headers;
			this.signature = nextSignature;
			this.failure = undefined;
			this.report(`${reason}头命令取到 ${result.names.length} 个头（${describeHeaderNames(result.headers)}）`);
			return changed;
		} catch (error) {
			this.failure = error instanceof Error ? error.message : String(error);
			this.report(`头命令失败：${this.failure}（改用静态 headers 继续）`);
			return false;
		}
	}
}

/** streamable HTTP（2025-06-18）：每条消息一个 POST，响应可能是 JSON 或一个 SSE 流。 */
class StreamableHttpTransport implements McpTransport {
	readonly label: string;
	private readonly config: McpRemoteServer;
	private readonly handlers: TransportHandlers;
	private readonly options: McpClientOptions;
	private readonly dynamicHeaders: DynamicHeaderResolver;
	private sessionId: string | undefined;
	private closed = false;
	private readonly inFlight = new Set<AbortController>();

	constructor(config: McpRemoteServer, handlers: TransportHandlers, options: McpClientOptions) {
		this.config = config;
		this.handlers = handlers;
		this.options = options;
		this.label = describeTransport(config);
		this.dynamicHeaders = new DynamicHeaderResolver(config, (line) => options.onDiagnostic?.(line, config.name));
	}

	async start(): Promise<void> {
		// 无长连接可建：会话状态在第一次 POST 的 Mcp-Session-Id 响应头里。
	}

	async send(message: JsonRpcMessage): Promise<void> {
		if (this.closed) throw new McpConnectionError(`${this.config.name}: 连接已关闭`);
		const isRequest = "method" in message && "id" in message;
		const controller = new AbortController();
		this.inFlight.add(controller);
		try {
			await this.dynamicHeaders.ensure(controller.signal);
			let response = await this.post(message, controller.signal);

			// 401/403：头可能是过期的（命令去取新 token），重跑一次；只有头真的变了才值得重试。
			if (isRequest && (response.status === 401 || response.status === 403)) {
				const changed = await this.dynamicHeaders.refresh(`HTTP ${response.status} 后`, controller.signal);
				if (changed) {
					await response.arrayBuffer().catch(() => undefined);
					response = await this.post(message, controller.signal);
				}
			}

			const sessionId = response.headers.get("mcp-session-id");
			if (sessionId) this.sessionId = sessionId;

			if (!response.ok) {
				const body = await safeReadText(response);
				throw new McpConnectionError(
					`${this.config.name}: HTTP ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}` +
						this.dynamicHeaders.errorSuffix(),
				);
			}

			// 通知 / 客户端对服务端请求的回复：服务端一般回 202 空 body。
			if (!isRequest) {
				await response.arrayBuffer().catch(() => undefined);
				return;
			}

			const contentType = response.headers.get("content-type") ?? "";
			if (contentType.includes("text/event-stream")) {
				await this.consumeSseBody(response);
				return;
			}

			const text = await safeReadText(response);
			if (!text.trim()) {
				throw new McpConnectionError(`${this.config.name}: HTTP 响应为空（期望 JSON-RPC 响应）`);
			}
			this.handlers.onMessage(parseJsonRpcMessage(text));
		} finally {
			this.inFlight.delete(controller);
		}
	}

	private post(message: JsonRpcMessage, signal: AbortSignal): Promise<Response> {
		return fetch(this.config.url, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(message),
			signal,
		});
	}

	private async consumeSseBody(response: Response): Promise<void> {
		const body = response.body;
		if (!body) throw new McpConnectionError(`${this.config.name}: SSE 响应没有 body`);
		const reader = body.getReader();
		const decoder = new TextDecoder();
		const sse = createSseDecoder();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				for (const event of sse(decoder.decode(value, { stream: true }))) {
					if (event.event && event.event !== "message") continue;
					const data = event.data.trim();
					if (!data || data === "[DONE]") continue;
					let message: JsonRpcMessage | undefined;
					try {
						message = parseJsonRpcMessage(data);
					} catch (error) {
						this.options.onDiagnostic?.(`SSE 事件不是 JSON-RPC：${String(error)}`, this.config.name);
						continue;
					}
					this.handlers.onMessage(message);
					// 响应到手就可以收工：有的服务端会把 SSE 流挂着不关（后续只发通知）。
					if (!("method" in message) && "id" in message) return;
				}
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
	}

	private headers(): Record<string, string> {
		// 顺序即优先级：协议头最高，其次是头命令取来的动态头，最后是配置里的静态头。
		return {
			...mergeHeaders(this.config.headers, this.dynamicHeaders.current),
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": MCP_PROTOCOL_VERSION,
			...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const controller of this.inFlight) controller.abort();
		this.inFlight.clear();
	}
}

/** 旧版 HTTP+SSE（2024-11-05）：GET 长连接 + 独立 POST 端点。 */
class LegacySseTransport implements McpTransport {
	readonly label: string;
	private readonly config: McpRemoteServer;
	private readonly handlers: TransportHandlers;
	private readonly options: McpClientOptions;
	private readonly dynamicHeaders: DynamicHeaderResolver;
	private endpoint: string | undefined;
	private streamController: AbortController | undefined;
	private closed = false;
	private readonly inFlight = new Set<AbortController>();
	private ready: Promise<void> | undefined;

	constructor(config: McpRemoteServer, handlers: TransportHandlers, options: McpClientOptions) {
		this.config = config;
		this.handlers = handlers;
		this.options = options;
		this.label = describeTransport(config);
		this.dynamicHeaders = new DynamicHeaderResolver(config, (line) => options.onDiagnostic?.(line, config.name));
	}

	async start(): Promise<void> {
		// GET 长连接要带着头发出去，所以先解析动态头再开流。
		await this.dynamicHeaders.ensure();
		this.ready = this.openStream();
		await this.ready;
	}

	/** 打开 GET 长连接，等首个 `endpoint` 事件把 POST 地址交出来。 */
	private openStream(): Promise<void> {
		const controller = new AbortController();
		this.streamController = controller;
		let resolveReady: () => void = () => {};
		let rejectReady: (error: Error) => void = () => {};
		const ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});

		void (async () => {
			try {
				const response = await fetch(this.config.url, {
					method: "GET",
					headers: { ...mergeHeaders(this.config.headers, this.dynamicHeaders.current), accept: "text/event-stream" },
					signal: controller.signal,
				});
				if (!response.ok || !response.body) {
					throw new McpConnectionError(
						`${this.config.name}: SSE 连接失败 HTTP ${response.status}${this.dynamicHeaders.errorSuffix()}`,
					);
				}
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				const sse = createSseDecoder();
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					for (const event of sse(decoder.decode(value, { stream: true }))) {
						if (event.event === "endpoint") {
							this.endpoint = new URL(event.data.trim(), this.config.url).toString();
							resolveReady();
							continue;
						}
						const data = event.data.trim();
						if (!data) continue;
						try {
							this.handlers.onMessage(parseJsonRpcMessage(data));
						} catch (error) {
							this.options.onDiagnostic?.(`SSE 事件不是 JSON-RPC：${String(error)}`, this.config.name);
						}
					}
				}
				if (!this.closed) this.handlers.onClose(new McpConnectionError(`${this.config.name}: SSE 流已关闭`));
			} catch (error) {
				if (this.closed) return;
				const failure = error instanceof Error ? error : new Error(String(error));
				if (!this.endpoint) rejectReady(failure);
				else this.handlers.onClose(new McpConnectionError(`${this.config.name}: SSE 流中断：${failure.message}`));
			}
		})();

		// 等不到 endpoint 就不必挂死：用 config.timeoutMs 做上限。
		const timer = setTimeout(
			() => rejectReady(new McpConnectionError(`${this.config.name}: 等待 SSE endpoint 超时`)),
			this.config.timeoutMs,
		);
		timer.unref?.();
		return ready.finally(() => clearTimeout(timer));
	}

	async send(message: JsonRpcMessage): Promise<void> {
		if (this.closed) throw new McpConnectionError(`${this.config.name}: 连接已关闭`);
		await this.ready;
		const isRequest = "method" in message && "id" in message;
		const controller = new AbortController();
		this.inFlight.add(controller);
		try {
			let response = await this.post(message, controller.signal);
			// 与 streamable HTTP 同一套：401/403 重跑一次头命令，头变了才重试（GET 流不重建）。
			if (isRequest && (response.status === 401 || response.status === 403)) {
				const changed = await this.dynamicHeaders.refresh(`HTTP ${response.status} 后`, controller.signal);
				if (changed) {
					await response.arrayBuffer().catch(() => undefined);
					response = await this.post(message, controller.signal);
				}
			}
			if (!response.ok) {
				const body = await safeReadText(response);
				throw new McpConnectionError(
					`${this.config.name}: HTTP ${response.status}${body ? ` — ${body.slice(0, 300)}` : ""}` +
						this.dynamicHeaders.errorSuffix(),
				);
			}
			await response.arrayBuffer().catch(() => undefined);
		} finally {
			this.inFlight.delete(controller);
		}
	}

	private post(message: JsonRpcMessage, signal: AbortSignal): Promise<Response> {
		return fetch(this.endpoint as string, {
			method: "POST",
			headers: {
				...mergeHeaders(this.config.headers, this.dynamicHeaders.current),
				"content-type": "application/json",
			},
			body: JSON.stringify(message),
			signal,
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		this.streamController?.abort();
		for (const controller of this.inFlight) controller.abort();
		this.inFlight.clear();
	}
}

async function safeReadText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}
