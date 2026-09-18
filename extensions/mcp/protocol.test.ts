/**
 * Tests for protocol.ts — JSON-RPC 编解码与 SSE 分帧。
 *
 * Run with:  node --test clients/pi/extensions/mcp/protocol.test.ts
 *
 * 这里只测「字节流 → 消息」的边界：半个 JSON、半个 SSE 事件、跨 chunk 的字段、\r\n。
 * 真实服务端的握手成功与否由 client.test.ts 的 stdio 端到端用例负责。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	createCancelledNotification,
	createLineDecoder,
	createSseDecoder,
	encodeStdioFrame,
	isJsonRpcRequestOrNotification,
	isJsonRpcResponse,
	JSONRPC_PARSE_ERROR,
	McpError,
	parseJsonRpcMessage,
	parseSseBlock,
	toErrorFromResponse,
} from "./protocol.ts";

describe("createLineDecoder", () => {
	it("把一个 chunk 里的多行都切出来", () => {
		const decode = createLineDecoder();
		assert.deepEqual(decode("a\nb\nc\n"), ["a", "b", "c"]);
	});

	it("半个 JSON 留在缓冲里，等下一块拼上再吐", () => {
		const decode = createLineDecoder();
		assert.deepEqual(decode('{"jsonrpc":"2.0",'), []);
		assert.deepEqual(decode('"id":1}\n'), ['{"jsonrpc":"2.0","id":1}']);
	});

	it("兼容 \\r\\n", () => {
		const decode = createLineDecoder();
		assert.deepEqual(decode("a\r\nb\r\n"), ["a", "b"]);
	});

	it("空行原样返回（调用方负责跳过）", () => {
		const decode = createLineDecoder();
		assert.deepEqual(decode("a\n\nb\n"), ["a", "", "b"]);
	});

	it("一行跨三个 chunk 也能拼出来", () => {
		const decode = createLineDecoder();
		decode("hel");
		decode("lo ");
		assert.deepEqual(decode("world\n"), ["hello world"]);
	});
});

describe("createSseDecoder", () => {
	it("按空行切事件，data 多行用 \\n 拼接", () => {
		const decode = createSseDecoder();
		const events = decode("event: message\ndata: a\ndata: b\n\n");
		assert.equal(events.length, 1);
		assert.equal(events[0]?.event, "message");
		assert.equal(events[0]?.data, "a\nb");
	});

	it("没有 event 字段的事件也算（MCP 的响应就是纯 data）", () => {
		const decode = createSseDecoder();
		const events = decode('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
		assert.equal(events.length, 1);
		assert.equal(events[0]?.event, undefined);
	});

	it("半个事件留在缓冲里", () => {
		const decode = createSseDecoder();
		assert.deepEqual(decode('data: {"a":'), []);
		assert.deepEqual(decode('1}\n\n'), [{ event: undefined, data: '{"a":1}', id: undefined }]);
	});

	it("忽略注释行（心跳）", () => {
		const decode = createSseDecoder();
		assert.deepEqual(decode(": ping\n\n"), []);
	});

	it("\\r\\n 分隔的事件也能切", () => {
		const decode = createSseDecoder();
		const events = decode("data: x\r\n\r\n");
		assert.equal(events[0]?.data, "x");
	});

	it("一个 chunk 里的多个事件都吐出来", () => {
		const decode = createSseDecoder();
		const events = decode("data: 1\n\ndata: 2\n\n");
		assert.deepEqual(events.map((event) => event.data), ["1", "2"]);
	});

	it("id 字段被保留", () => {
		const decode = createSseDecoder();
		assert.equal(decode("id: 42\ndata: x\n\n")[0]?.id, "42");
	});
});

describe("parseSseBlock", () => {
	it("只有 data 的块直接可用", () => {
		assert.deepEqual(parseSseBlock("data: hello"), { event: undefined, data: "hello", id: undefined });
	});

	it("去掉冒号后的单个空格，保留后续空格", () => {
		assert.equal(parseSseBlock("data:  two spaces")?.data, " two spaces");
	});

	it("没有 data 的块返回 undefined", () => {
		assert.equal(parseSseBlock("event: ping"), undefined);
	});
});

describe("encodeStdioFrame", () => {
	it("一行 JSON 加换行，消息里不会出现裸换行", () => {
		const frame = encodeStdioFrame({ jsonrpc: "2.0", id: 1, method: "x", params: { text: "a\nb" } });
		assert.ok(frame.endsWith("\n"));
		assert.equal(frame.trimEnd().split("\n").length, 1);
	});
});

describe("parseJsonRpcMessage", () => {
	it("解析成功", () => {
		const message = parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
		assert.ok(isJsonRpcResponse(message));
	});

	it("坏 JSON 抛带 parse error 码的 McpError", () => {
		assert.throws(
			() => parseJsonRpcMessage("{oops"),
			(error: unknown) => error instanceof McpError && error.code === JSONRPC_PARSE_ERROR,
		);
	});

	it("数组/字面量不是合法 JSON-RPC 消息", () => {
		assert.throws(() => parseJsonRpcMessage("[1,2]"), McpError);
		assert.throws(() => parseJsonRpcMessage("42"), McpError);
	});
});

describe("isJsonRpcResponse / isJsonRpcRequestOrNotification", () => {
	it("按 method 字段区分响应与请求", () => {
		assert.ok(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: {} } as never));
		assert.ok(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, error: { code: 1, message: "x" } } as never));
		assert.ok(!isJsonRpcResponse({ jsonrpc: "2.0", id: 1, method: "tools/list" } as never));
		assert.ok(isJsonRpcRequestOrNotification({ jsonrpc: "2.0", method: "notifications/initialized" } as never));
	});
});

describe("toErrorFromResponse", () => {
	it("把 data 拼进 message", () => {
		const error = toErrorFromResponse({ code: -32602, message: "bad params", data: { field: "x" } });
		assert.equal(error.code, -32602);
		assert.match(error.message, /bad params/);
		assert.match(error.message, /field/);
	});

	it("data 过长时截断，别让错误信息本身撑爆日志", () => {
		const error = toErrorFromResponse({ code: 1, message: "x", data: "y".repeat(2000) });
		assert.ok(error.message.length < 600);
		assert.match(error.message, /…/);
	});

	it("循环引用的 data 不会让拼消息本身抛异常", () => {
		const data: Record<string, unknown> = {};
		data.self = data;
		assert.doesNotThrow(() => toErrorFromResponse({ code: 1, message: "x", data }));
	});
});

describe("createCancelledNotification", () => {
	it("形状符合 notifications/cancelled", () => {
		const notification = createCancelledNotification(7, "timeout");
		assert.equal(notification.method, "notifications/cancelled");
		assert.deepEqual(notification.params, { requestId: 7, reason: "timeout" });
	});
});
