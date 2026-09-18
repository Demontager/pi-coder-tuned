/**
 * Tests for tools.ts — 命名、schema 归一化、MCP 内容块到 pi 内容块的映射、截断。
 *
 * Run with:  node --test clients/pi/extensions/mcp/tools.test.ts
 *
 * 这里覆盖的是「模型实际看到什么」：名字能不能被原样回传、图片有没有被降级、
 * 超长输出有没有在保住开头的前提下截断。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	formatBytes,
	mcpContentToPiContent,
	MAX_TOOL_NAME_LENGTH,
	normalizeInputSchema,
	piToolName,
	toolDescription,
	toolPromptSnippet,
	truncateText,
} from "./tools.ts";

describe("piToolName", () => {
	it("用 Claude Code 的 mcp__<server>__<tool> 形状", () => {
		assert.equal(piToolName("wechat-local", "wechat_status"), "mcp__wechat-local__wechat_status");
	});

	it("非法字符（点、空格、斜杠）替换成下划线", () => {
		assert.equal(piToolName("my server", "a.b/c"), "mcp__my_server__a_b_c");
	});

	it("超过 64 字符时截断并接哈希后缀", () => {
		const name = piToolName("server", "t".repeat(120));
		assert.ok(name.length <= MAX_TOOL_NAME_LENGTH, `长度 ${name.length} 超过上限`);
		assert.match(name, /^mcp__server__t+_[0-9a-f]{6}$/);
	});

	it("截断后不同工具名仍然可区分（哈希不同）", () => {
		const a = piToolName("server", `${"x".repeat(100)}a`);
		const b = piToolName("server", `${"x".repeat(100)}b`);
		assert.notEqual(a, b);
	});

	it("名字相同则结果稳定（哈希不是随机的）", () => {
		assert.equal(piToolName("s", "t".repeat(100)), piToolName("s", "t".repeat(100)));
	});

	it("空名兜底成下划线，不产生非法工具名", () => {
		assert.equal(piToolName("", ""), "mcp______");
	});
});

describe("normalizeInputSchema", () => {
	it("标准 schema 原样通过（保留 required 与其它关键字）", () => {
		const schema = normalizeInputSchema({
			type: "object",
			properties: { chat: { type: "string" } },
			required: ["chat"],
			additionalProperties: false,
		});
		assert.equal(schema.type, "object");
		assert.deepEqual(schema.required, ["chat"]);
		assert.equal(schema.additionalProperties, false);
	});

	it("缺 schema / null / 数组 → 空对象 schema", () => {
		for (const input of [undefined, null, [], "x"]) {
			assert.deepEqual(normalizeInputSchema(input), { type: "object", properties: {} });
		}
	});

	it("没写 type 但有 properties 时补上 type: object", () => {
		const schema = normalizeInputSchema({ properties: { a: { type: "string" } } });
		assert.equal(schema.type, "object");
		assert.deepEqual(Object.keys(schema.properties as object), ["a"]);
	});

	it("type 不是 object（例如 string）时退回空对象 schema", () => {
		assert.deepEqual(normalizeInputSchema({ type: "string" }), { type: "object", properties: {} });
	});

	it("保留 $defs 这类扩展关键字", () => {
		const schema = normalizeInputSchema({ type: "object", properties: {}, $defs: { X: { type: "string" } } });
		assert.deepEqual(schema.$defs, { X: { type: "string" } });
	});
});

describe("toolDescription / toolPromptSnippet", () => {
	it("把服务端描述与注解提示拼在一起", () => {
		const description = toolDescription("wechat-local", {
			name: "wechat_status",
			description: "检查微信状态",
			annotations: { readOnlyHint: true },
		});
		assert.match(description, /检查微信状态/);
		assert.match(description, /server: wechat-local/);
		assert.match(description, /只读/);
	});

	it("没有描述时也能给出 server 归属", () => {
		assert.match(toolDescription("s", { name: "t" }), /MCP 工具（server: s）/);
	});

	it("破坏性注解会提示模型", () => {
		assert.match(toolDescription("s", { name: "t", annotations: { destructiveHint: true } }), /可能破坏数据/);
	});

	it("snippet 是单行且限长", () => {
		const snippet = toolPromptSnippet(`多行\n描述  带   空白 ${"x".repeat(200)}`);
		assert.ok(snippet && !snippet.includes("\n"));
		assert.ok(snippet.length <= 101, `snippet 长度 ${snippet.length}`);
	});

	it("没有描述时不给 snippet", () => {
		assert.equal(toolPromptSnippet(undefined), undefined);
		assert.equal(toolPromptSnippet("   "), undefined);
	});

	it("中文长描述硬切（CJK 没有词边界）", () => {
		const snippet = toolPromptSnippet("中".repeat(300));
		assert.ok(snippet && snippet.length <= 101);
	});
});

describe("mcpContentToPiContent", () => {
	it("文本块原样保留，顺序不变", () => {
		const result = mcpContentToPiContent([
			{ type: "text", text: "第一段" },
			{ type: "text", text: "第二段" },
		]);
		assert.deepEqual(result.content, [
			{ type: "text", text: "第一段" },
			{ type: "text", text: "第二段" },
		]);
		assert.equal(result.text, "第一段\n第二段");
		assert.deepEqual(result.notes, []);
	});

	it("图片映射成 pi 的 ImageContent", () => {
		const result = mcpContentToPiContent([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
		assert.deepEqual(result.content[0], { type: "image", data: "AAAA", mimeType: "image/png" });
	});

	it("缺 data/mimeType 的图片降级成文本说明", () => {
		const result = mcpContentToPiContent([{ type: "image" }]);
		assert.equal(result.content[0]?.type, "text");
		assert.deepEqual(result.notes.length, 1);
	});

	it("audio 降级成文本说明", () => {
		const result = mcpContentToPiContent([{ type: "audio", data: "AA", mimeType: "audio/wav" }]);
		assert.match((result.content[0] as { text: string }).text, /音频/);
	});

	it("resource 带 text 时内容直出", () => {
		const result = mcpContentToPiContent([
			{ type: "resource", resource: { uri: "file:///a.txt", text: "文件内容" } },
		]);
		assert.deepEqual(result.content, [{ type: "text", text: "文件内容" }]);
	});

	it("resource 带图片 blob 时转成图片块", () => {
		const result = mcpContentToPiContent([
			{ type: "resource", resource: { uri: "file:///a.png", mimeType: "image/png", blob: "AAAA" } },
		]);
		assert.deepEqual(result.content[0], { type: "image", data: "AAAA", mimeType: "image/png" });
	});

	it("二进制 resource 降级成说明并标注体积", () => {
		const result = mcpContentToPiContent([
			{ type: "resource", resource: { uri: "file:///a.bin", mimeType: "application/octet-stream", blob: "AAECAw==" } },
		]);
		assert.match((result.content[0] as { text: string }).text, /a\.bin/);
		assert.equal(result.notes.length, 1);
	});

	it("resource_link 变成一行文本", () => {
		const result = mcpContentToPiContent([{ type: "resource_link", uri: "https://x/a", name: "名字" }]);
		assert.match((result.content[0] as { text: string }).text, /https:\/\/x\/a/);
		assert.match((result.content[0] as { text: string }).text, /名字/);
	});

	it("未知内容块不静默丢弃", () => {
		const result = mcpContentToPiContent([{ type: "wat", value: 1 }]);
		assert.match((result.content[0] as { text: string }).text, /不支持的 MCP 内容块 wat/);
	});

	it("空数组 → 空内容（由调用方兜底）", () => {
		assert.deepEqual(mcpContentToPiContent([]).content, []);
	});
});

describe("truncateText", () => {
	it("短文本原样返回", () => {
		const result = truncateText("hello");
		assert.equal(result.truncated, false);
		assert.equal(result.text, "hello");
	});

	it("超行数时保留开头并给出说明", () => {
		const text = Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n");
		const result = truncateText(text, { maxLines: 3 });
		assert.equal(result.truncated, true);
		assert.match(result.text, /line 0/);
		assert.doesNotMatch(result.text, /line 4/);
		assert.match(result.text, /输出已截断/);
		assert.equal(result.totalLines, 10);
	});

	it("超字节数时也在字符边界截断（不产生半个 UTF-8 字符）", () => {
		const text = "中".repeat(100); // 每个 3 字节
		const result = truncateText(text, { maxBytes: 30 });
		assert.equal(result.truncated, true);
		assert.ok(!result.text.includes("\uFFFD"));
		assert.ok(result.text.startsWith("中"));
	});

	it("报告原始体积与行数，便于模型判断要不要缩小查询", () => {
		const result = truncateText(`${"x".repeat(100)}\n`, { maxBytes: 10 });
		assert.equal(result.totalBytes, 101);
		assert.equal(result.totalLines, 2);
	});

	it("恰好等于上限时不截断", () => {
		assert.equal(truncateText("abc", { maxBytes: 3, maxLines: 1 }).truncated, false);
	});
});

describe("formatBytes", () => {
	it("按量级给 B / KB / MB", () => {
		assert.equal(formatBytes(512), "512B");
		assert.equal(formatBytes(2048), "2.0KB");
		assert.equal(formatBytes(3 * 1024 * 1024), "3.0MB");
	});
});
