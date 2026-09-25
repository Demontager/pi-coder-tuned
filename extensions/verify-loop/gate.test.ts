/**
 * gate.ts 的验证：纯判定，直接 `node --test`。
 *
 *   node --test clients/pi/extensions/verify-loop/gate.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	countInjected,
	decideGate,
	DEFAULT_DOC_EXTENSIONS,
	DEFAULT_VERIFY_PATTERN,
	findRunStart,
	renderGateMessage,
	scanRun,
	STRICT_VERIFY_PATTERN,
	VERIFY_LOOP_CUSTOM_TYPE,
	type GateConfig,
	type GateMessage,
} from "./gate.ts";

// =============================================================================
// 构造投影消息的辅助函数
// =============================================================================

function user(text: string): GateMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): GateMessage {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolCalls(...calls: Array<{ name: string; args?: Record<string, unknown> }>): GateMessage {
	return {
		role: "assistant",
		content: calls.map((call, index) => ({
			type: "toolCall",
			id: `call-${index}-${call.name}`,
			name: call.name,
			arguments: call.args ?? {},
		})),
	};
}

function toolResult(): GateMessage {
	return { role: "toolResult", content: [{ type: "text", text: "ok" }] };
}

function injected(kind: string): GateMessage {
	return { role: "custom", customType: VERIFY_LOOP_CUSTOM_TYPE, content: "...", details: { kind, at: 1 } };
}

function config(overrides: Partial<GateConfig> = {}): GateConfig {
	return {
		mode: "block",
		verifyPattern: DEFAULT_VERIFY_PATTERN,
		docExtensions: [...DEFAULT_DOC_EXTENSIONS],
		blockCap: 2,
		...overrides,
	};
}

test("DEFAULT_VERIFY_PATTERN: 缺省是「任何 bash 都算」（undefined）", () => {
	assert.equal(DEFAULT_VERIFY_PATTERN, undefined);
});

// =============================================================================
// findRunStart / scanRun
// =============================================================================

test("findRunStart: 最后一条 user 消息是窗口起点", () => {
	const messages = [user("a"), assistantText("x"), user("b"), assistantText("y")];
	assert.equal(findRunStart(messages), 2);
});

test("findRunStart: 没有 user 消息时整个投影都是窗口", () => {
	const messages = [assistantText("x"), assistantText("y")];
	assert.equal(findRunStart(messages), -1);
});

test("findRunStart: 注入的 custom 消息不算 user（续跑链共用一个窗口）", () => {
	const messages = [user("a"), assistantText("x"), injected("gate"), assistantText("y")];
	assert.equal(findRunStart(messages), 0);
});

test("scanRun: 统计 mutation 与其后的验证", () => {
	const messages = [
		user("改一下"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantToolCalls({ name: "bash", args: { command: "node --test adapter/tests/*.test.js" } }),
		toolResult(),
	];
	const scan = scanRun(messages);
	assert.equal(scan.mutations.length, 1);
	assert.equal(scan.verificationsAfterLastMutation, 1);
});

test("scanRun: 验证在 mutation 之前不算数（FRESH evidence）", () => {
	const messages = [
		user("改一下"),
		assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
		toolResult(),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
	];
	const scan = scanRun(messages);
	assert.equal(scan.verificationsAfterLastMutation, 0);
});

test("scanRun: 新 mutation 让之前的验证过期", () => {
	const messages = [
		user("改一下"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
		toolResult(),
		assistantToolCalls({ name: "edit", args: { path: "src/b.js" } }),
		toolResult(),
	];
	const scan = scanRun(messages);
	assert.equal(scan.mutations.length, 2);
	assert.equal(scan.verificationsAfterLastMutation, 0);
});

test("scanRun: 窗口外的改动不算（上一轮的事不为本次作证）", () => {
	const messages = [
		user("第一轮"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		user("第二轮"),
		assistantText("好的"),
	];
	const scan = scanRun(messages);
	assert.equal(scan.mutations.length, 0);
});

test("scanRun: bash 里的写操作不算 mutation（已知边界）", () => {
	const messages = [
		user("改一下"),
		assistantToolCalls({ name: "bash", args: { command: "sed -i '' 's/a/b/' src/a.js" } }),
		toolResult(),
	];
	const scan = scanRun(messages, config());
	assert.equal(scan.mutations.length, 0);
});

test("scanRun: apply_patch / multiedit 也算 mutation（防未来/第三方注册）", () => {
	const messages = [
		user("改一下"),
		assistantToolCalls({ name: "apply_patch", args: {} }),
		toolResult(),
		assistantToolCalls({ name: "multiedit", args: { path: "src/c.js" } }),
		toolResult(),
	];
	const scan = scanRun(messages);
	assert.equal(scan.mutations.length, 2);
	assert.equal(scan.mutations[0].path, undefined);
	assert.equal(scan.mutations[1].path, "src/c.js");
});

// =============================================================================
// decideGate
// =============================================================================

test("decideGate: 改了文件没验证 → block", () => {
	const messages = [
		user("改一下"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantText("完成了"),
	];
	const decision = decideGate(messages, config());
	assert.equal(decision.action, "block");
	if (decision.action === "block") {
		assert.equal(decision.attempt, 1);
		assert.equal(decision.cap, 2);
		assert.deepEqual(decision.mutations, [{ tool: "edit", path: "src/a.js" }]);
	}
});

test("decideGate: 改完跑过验证 → pass", () => {
	const messages = [
		user("改一下"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantToolCalls({ name: "bash", args: { command: "node --test adapter/tests/*.test.js" } }),
		toolResult(),
		assistantText("完成了"),
	];
	assert.equal(decideGate(messages, config()).action, "pass");
});

test("decideGate: 失败的验证也算跑过（证据已在上下文里）", () => {
	const messages = [
		user("改一下"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
		{ role: "toolResult", content: [{ type: "text", text: "Command exited with code 1" }] },
		assistantText("测试挂了，我再看看"),
	];
	assert.equal(decideGate(messages, config()).action, "pass");
});

test("decideGate: 没改文件 → pass（纯问答不拦）", () => {
	const messages = [user("这段代码什么意思"), assistantText("解释如下")];
	assert.equal(decideGate(messages, config()).action, "pass");
});

test("decideGate: 只改文档 → pass（默认排除 .md/.txt）", () => {
	const messages = [
		user("更新文档"),
		assistantToolCalls({ name: "edit", args: { path: "AGENTS.md" } }),
		toolResult(),
		assistantText("改好了"),
	];
	assert.equal(decideGate(messages, config()).action, "pass");
});

test("decideGate: docExtensions 配空则文档也拦", () => {
	const messages = [
		user("更新文档"),
		assistantToolCalls({ name: "edit", args: { path: "AGENTS.md" } }),
		toolResult(),
		assistantText("改好了"),
	];
	assert.equal(decideGate(messages, config({ docExtensions: [] })).action, "block");
});

test("decideGate: mode=off → 永远 pass", () => {
	const messages = [
		user("改一下"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantText("完成了"),
	];
	assert.equal(decideGate(messages, config({ mode: "off" })).action, "pass");
});

test("decideGate: 已注入的 gate 消息达到上限 → 放行（CC 的 8 次强制放行）", () => {
	const messages = [
		user("改一下"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantText("完成了"),
		injected("gate"),
		assistantText("还是完成了"),
		injected("gate"),
		assistantText("坚持完成"),
	];
	assert.equal(decideGate(messages, config({ blockCap: 2 })).action, "pass");
});

test("decideGate: 已拦一次、又改了文件仍没验证 → 第二次 block", () => {
	const messages = [
		user("改一下"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantText("完成了"),
		injected("gate"),
		assistantToolCalls({ name: "edit", args: { path: "src/b.js" } }),
		toolResult(),
		assistantText("这次真完成了"),
	];
	const decision = decideGate(messages, config({ blockCap: 2 }));
	assert.equal(decision.action, "block");
	if (decision.action === "block") assert.equal(decision.attempt, 2);
});

test("decideGate: 自定义 verifyPattern 生效", () => {
	const messages = [
		user("改一下"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.py" } }),
		toolResult(),
		assistantToolCalls({ name: "bash", args: { command: "./check.sh" } }),
		toolResult(),
		assistantText("完成了"),
	];
	const custom = config({ verifyPattern: /check\.sh/i });
	assert.equal(decideGate(messages, custom).action, "pass");
});

test("decideGate: 缺省口径下任何 bash 调用都算证据（2026-09-25 活体误报的回归）", () => {
	// 模型改完 probe.js 跑的是 node -e 导入模块打印新值 —— 真证据，但不是测试形状。
	const messages = [
		user("改一下"),
		assistantToolCalls({ name: "edit", args: { path: "probe.js" } }),
		toolResult(),
		assistantToolCalls({ name: "bash", args: { command: "node --input-type=module -e \"import('./probe.js').then(m => console.log(m.VALUE))\"" } }),
		toolResult(),
		assistantText("完成了"),
	];
	assert.equal(decideGate(messages, config()).action, "pass", "缺省口径不应拦");
	assert.equal(decideGate(messages, config({ verifyPattern: STRICT_VERIFY_PATTERN })).action, "block", "strict 口径会拦");
});

test("decideGate: strict 口径认测试/构建/lint 形状", () => {
	const strict = config({ verifyPattern: STRICT_VERIFY_PATTERN });
	for (const command of ["node --test adapter/tests/*.test.js", "npm test", "pnpm run test", "pytest gateway/tests", "cargo test", "go build ./...", "tsc --noEmit", "eslint .", "make test"]) {
		const messages = [
			user("改一下"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantToolCalls({ name: "bash", args: { command } }),
			toolResult(),
		];
		assert.equal(decideGate(messages, strict).action, "pass", command);
	}
});

// =============================================================================
// countInjected / renderGateMessage
// =============================================================================

test("countInjected: 只数指定 kind 的注入消息", () => {
	const messages = [user("a"), injected("gate"), injected("goal-not-met"), injected("gate")];
	assert.equal(countInjected(messages, "gate"), 2);
	assert.equal(countInjected(messages, "goal-not-met"), 1);
	assert.equal(countInjected(messages, "goal-met"), 0);
});

test("renderGateMessage: 带文件清单与次数", () => {
	const text = renderGateMessage({
		action: "block",
		mutations: [
			{ tool: "edit", path: "src/a.js" },
			{ tool: "write", path: "src/a.js" },
			{ tool: "apply_patch" },
		],
		attempt: 1,
		cap: 2,
	});
	assert.match(text, /src\/a\.js/);
	assert.match(text, /\(apply_patch\)/);
	assert.match(text, /intervention 1\/2/);
	assert.match(text, /no command was run/);
});
