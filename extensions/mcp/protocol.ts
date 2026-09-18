/**
 * protocol.ts — MCP 的线路层：JSON-RPC 2.0 消息编解码 + SSE 事件解析。
 *
 * 纯逻辑，不 import pi / node（`TextDecoder` 之外不碰宿主 API），所以可以直接 `node --test`。
 * 拆出来的理由：stdio 传输的「按行切 JSON」和 HTTP 传输的「按空行切 SSE 事件」是本扩展里
 * 唯一两处「上游给的字节流可能在任何位置断开」的地方 —— 半行 JSON、半截 SSE 事件都必须缓冲到
 * 下一块 chunk 再处理，边界错误在这里最容易埋雷，单独测最省事。
 *
 * 事实来源（实测，非推断）：
 *   - stdio 帧格式 = 一行一个 JSON-RPC 消息，行内不含裸换行（MCP spec "stdio" transport）
 *   - 对真实 wechat-local-mcp 进程握手成功，返回 protocolVersion 2025-06-18，12 个工具
 *   - streamable HTTP 的响应既可能是 `application/json`（整包一个消息）也可能是
 *     `text/event-stream`（一个或多个 `message` 事件），两条路都要能解析
 */

/** MCP 当前协议版本（客户端在 initialize 里声明的版本；服务端可回一个它支持的版本）。 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const JSONRPC_VERSION = "2.0";

/** JSON-RPC 错误码。自定义码从 -32000 起（协议保留区间）。 */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export interface JsonRpcRequest {
	jsonrpc: typeof JSONRPC_VERSION;
	id: number;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: typeof JSONRPC_VERSION;
	method: string;
	params?: unknown;
}

export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcSuccessResponse {
	jsonrpc: typeof JSONRPC_VERSION;
	id: number | string;
	result: unknown;
}

export interface JsonRpcErrorResponse {
	jsonrpc: typeof JSONRPC_VERSION;
	id: number | string | null;
	error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** 传输层/服务端返回的错误。`code` 保留 JSON-RPC 错误码，HTTP 传输失败用 `HTTP_ERROR`。 */
export class McpError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "McpError";
		this.code = code;
		this.data = data;
	}
}

/** 连接级失败（进程退出、HTTP 断流、握手失败）统一用这个，便于上层区分「调用失败」与「通道没了」。 */
export class McpConnectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpConnectionError";
	}
}

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
	return typeof message === "object" && message !== null && "id" in message && !("method" in message);
}

export function isJsonRpcRequestOrNotification(
	message: JsonRpcMessage,
): message is JsonRpcRequest | JsonRpcNotification {
	return typeof message === "object" && message !== null && "method" in message;
}

/** 把消息序列化成 stdio 传输的一帧（单行 JSON + 换行）。 */
export function encodeStdioFrame(message: JsonRpcMessage): string {
	return `${JSON.stringify(message)}\n`;
}

/**
 * 按行切分 stdio 帧。
 *
 * 返回一个「喂 chunk、吐整行」的闭包：调用方把每次 `data` 事件原样喂进来，拿到的才是完整行。
 * 不做 JSON.parse —— 解析失败要由调用方决定是「丢弃这行」还是「当成协议错误断开」。
 * 兼容 `\r\n`（Windows 上的 MCP server）。
 */
export function createLineDecoder(): (chunk: string) => string[] {
	let buffer = "";
	return (chunk: string): string[] => {
		buffer += chunk;
		const lines: string[] = [];
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			let line = buffer.slice(0, index);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			lines.push(line);
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
		}
		return lines;
	};
}

export interface SseEvent {
	event?: string;
	data: string;
	id?: string;
}

/**
 * 按 SSE 规范切分事件流。
 *
 * 只实现我们需要的部分：`event:` / `data:` 字段、多行 data 用 `\n` 拼接、空行结束一个事件、
 * 以 `:` 开头的注释行忽略（有些服务端用注释做心跳）。`retry:` 等字段忽略。
 * 关键点是**增量**：半个事件必须留在缓冲里等下一块 chunk，不能提前切出去。
 */
export function createSseDecoder(): (chunk: string) => SseEvent[] {
	let buffer = "";
	return (chunk: string): SseEvent[] => {
		buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const events: SseEvent[] = [];
		let separator = buffer.indexOf("\n\n");
		while (separator >= 0) {
			const block = buffer.slice(0, separator);
			buffer = buffer.slice(separator + 2);
			const parsed = parseSseBlock(block);
			if (parsed) events.push(parsed);
			separator = buffer.indexOf("\n\n");
		}
		return events;
	};
}

/** 解析一个已经切完整的 SSE 事件块。只有 `data` 的事件也算合法（MCP 的响应就是这种）。 */
export function parseSseBlock(block: string): SseEvent | undefined {
	const dataLines: string[] = [];
	let event: string | undefined;
	let id: string | undefined;
	for (const line of block.split("\n")) {
		if (!line || line.startsWith(":")) continue;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		switch (field) {
			case "event":
				event = value;
				break;
			case "data":
				dataLines.push(value);
				break;
			case "id":
				id = value;
				break;
			default:
				break;
		}
	}
	if (dataLines.length === 0) return undefined;
	return { event, data: dataLines.join("\n"), id };
}

/** 解析一行 stdio 帧 / 一个 SSE data 载荷里的 JSON-RPC 消息。 */
export function parseJsonRpcMessage(raw: string): JsonRpcMessage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new McpError(
			JSONRPC_PARSE_ERROR,
			`invalid JSON-RPC payload: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new McpError(JSONRPC_INVALID_REQUEST, "JSON-RPC payload must be an object");
	}
	return parsed as JsonRpcMessage;
}

/**
 * 把 JSON-RPC 错误响应转成 Error。
 *
 * `data` 里往往有服务端给的细节（例如 MCP 的 `{"uri": ...}` 或 python 的 traceback 摘要），
 * 拼进 message 里对模型更有用，但别让 message 长到失控。
 */
export function toErrorFromResponse(error: JsonRpcErrorObject): McpError {
	const detail = formatErrorData(error.data);
	const message = detail ? `${error.message} (${detail})` : error.message;
	return new McpError(error.code, message, error.data);
}

function formatErrorData(data: unknown): string | undefined {
	if (data === undefined || data === null) return undefined;
	const text = typeof data === "string" ? data : safeStringify(data);
	if (!text) return undefined;
	return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/** 稳定序列化：循环引用、BigInt 等都不能让「拼错误信息」这件事自己再抛异常。 */
export function safeStringify(value: unknown): string {
	try {
		const json = JSON.stringify(value);
		return json === undefined ? String(value) : json;
	} catch {
		return String(value);
	}
}

/** 纯文本化一个 JSON-RPC 消息（调试日志用，避免把 base64 图片整个打出来）。 */
export function summarizeMessage(message: JsonRpcMessage): string {
	if (isJsonRpcResponse(message)) {
		return "error" in message ? `error ${message.error.code}` : "result";
	}
	return message.method;
}

/** 用于 `notifications/cancelled`（客户端取消在途请求）。 */
export function createCancelledNotification(requestId: number | string, reason: string): JsonRpcNotification {
	return { jsonrpc: JSONRPC_VERSION, method: "notifications/cancelled", params: { requestId, reason } };
}
