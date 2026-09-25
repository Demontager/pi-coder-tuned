/**
 * Tests for headers-command.ts — 动态请求头（跑命令取 header）。
 *
 * Run with:  node --test clients/pi/extensions/mcp/headers-command.test.ts
 *
 * 两条边界最要紧，都直接断言：
 *   - **绝不泄露头值**：诊断只用 `describeHeaderNames`，解析失败也不能回显命令输出（输出可能是整段 token）。
 *   - **失败不致命**：命令挂了要抛一个可读错误给上层降级，而不是静默产出空头。
 * 真实命令执行用 `node -e`（不 mock exec），超时用例故意睡过头。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DEFAULT_HEADERS_COMMAND_TIMEOUT_MS,
	describeHeaderNames,
	headersSignature,
	mergeHeaders,
	parseHeadersOutput,
	resolveCommandHeaders,
} from "./headers-command.ts";

const SECRET = "s3cr3t-token-value";

describe("parseHeadersOutput", () => {
	it("扁平 JSON 对象", () => {
		const { headers, warnings } = parseHeadersOutput('{"Authorization":"Bearer x","X-Tenant":"acme"}');
		assert.deepEqual(headers, { Authorization: "Bearer x", "X-Tenant": "acme" });
		assert.deepEqual(warnings, []);
	});

	it("带 headers 包装的 JSON（有些 helper 会包一层）", () => {
		const { headers } = parseHeadersOutput('{"headers":{"Authorization":"Bearer x"},"expires_in":3600}');
		assert.deepEqual(headers, { Authorization: "Bearer x" });
	});

	it("Key: Value 行（手写命令最省事的形式）", () => {
		const { headers } = parseHeadersOutput("Authorization: Bearer x\nX-Tenant: acme\n");
		assert.deepEqual(headers, { Authorization: "Bearer x", "X-Tenant": "acme" });
	});

	it("值里的冒号不会被切开", () => {
		const { headers } = parseHeadersOutput("Authorization: Bearer a:b:c");
		assert.equal(headers.Authorization, "Bearer a:b:c");
	});

	it("非字符串值静默丢弃（expires_in 这类常见）", () => {
		const { headers, warnings } = parseHeadersOutput('{"Authorization":"Bearer x","expires_in":3600,"n":null}');
		assert.deepEqual(headers, { Authorization: "Bearer x" });
		assert.deepEqual(warnings, []);
	});

	it("空值记 warning 并丢弃", () => {
		const { headers, warnings } = parseHeadersOutput('{"Authorization":"","X-Ok":"y"}');
		assert.deepEqual(headers, { "X-Ok": "y" });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /Authorization value is empty/);
	});

	it("非法头名记 warning 并丢弃", () => {
		const { headers, warnings } = parseHeadersOutput('{"Bad Header":"x","Good":"y"}');
		assert.deepEqual(headers, { Good: "y" });
		assert.match(warnings[0] ?? "", /invalid characters/);
	});

	it("空输出 = 无头（不是错误）", () => {
		assert.deepEqual(parseHeadersOutput("   \n"), { headers: {}, warnings: [] });
	});

	it("无法解析时报错，且**不回显输出内容**", () => {
		assert.throws(
			() => parseHeadersOutput(`不给你解析 ${SECRET}`),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				assert.match(message, /Could not parse/);
				assert.ok(!message.includes(SECRET), "错误信息里不能出现命令输出");
				return true;
			},
		);
	});

	it("JSON 数组 / 裸标量 → 报错（不当成头行处理）", () => {
		assert.throws(() => parseHeadersOutput("[1,2]"), /Could not parse/);
		assert.throws(() => parseHeadersOutput("42"), /Could not parse/);
	});
});

describe("resolveCommandHeaders", () => {
	it("跑真实命令并解析 JSON 输出", async () => {
		const result = await resolveCommandHeaders({
			command: `node -e 'console.log(JSON.stringify({Authorization:"Bearer ${SECRET}"}))'`,
		});
		assert.deepEqual(result.headers, { Authorization: `Bearer ${SECRET}` });
		assert.deepEqual(result.names, ["Authorization"]);
	});

	it("非零退出 → 错误信息带第一行 stderr", async () => {
		await assert.rejects(
			() => resolveCommandHeaders({ command: "node -e 'console.error(\"token 过期了\"); process.exit(3)'" }),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				assert.match(message, /nonzero status/);
				assert.match(message, /token 过期了/);
				return true;
			},
		);
	});

	it("超过 timeout 直接失败（不会永远挂着）", async () => {
		await assert.rejects(
			() =>
				resolveCommandHeaders(
					{ command: "node -e 'setTimeout(()=>{}, 5000)'", timeoutMs: 150 },
					{},
				),
			(error: unknown) => {
				assert.match(error instanceof Error ? error.message : "", /timed out/);
				return true;
			},
		);
	});

	it("AbortSignal 能取消命令", async () => {
		const controller = new AbortController();
		const pending = resolveCommandHeaders(
			{ command: "node -e 'setTimeout(()=>{}, 5000)'", timeoutMs: 4000 },
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 50);
		await assert.rejects(pending);
	});

	it("默认超时是 10s（够跑一次钥匙串查询）", () => {
		assert.equal(DEFAULT_HEADERS_COMMAND_TIMEOUT_MS, 10_000);
	});

	it("命令输出多个头（Key: Value 形式）", async () => {
		const result = await resolveCommandHeaders({
			command: `printf 'Authorization: Bearer ${SECRET}\\nX-Tenant: acme\\n'`,
		});
		assert.deepEqual(result.headers, { Authorization: `Bearer ${SECRET}`, "X-Tenant": "acme" });
	});
});

describe("mergeHeaders", () => {
	it("动态头覆盖静态头（它是更新鲜的凭据）", () => {
		const merged = mergeHeaders({ Authorization: "Bearer old", "X-Static": "keep" }, { Authorization: "Bearer new" });
		assert.deepEqual(merged, { Authorization: "Bearer new", "X-Static": "keep" });
	});

	it("没有动态头时保持静态头不变", () => {
		assert.deepEqual(mergeHeaders({ A: "1" }, {}), { A: "1" });
	});
});

describe("describeHeaderNames / headersSignature", () => {
	it("只输出头名，绝不输出值", () => {
		const text = describeHeaderNames({ Authorization: `Bearer ${SECRET}`, "X-Tenant": "acme" });
		assert.equal(text, "Authorization, X-Tenant");
		assert.ok(!text.includes(SECRET));
	});

	it("无头时给一个明确的占位", () => {
		assert.equal(describeHeaderNames({}), "(none)");
	});

	it("签名与键序无关（用于判断头是否真的变了）", () => {
		assert.equal(headersSignature({ A: "1", B: "2" }), headersSignature({ B: "2", A: "1" }));
		assert.notEqual(headersSignature({ A: "1" }), headersSignature({ A: "2" }));
	});
});
