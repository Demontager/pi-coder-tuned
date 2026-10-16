/**
 * Checks for gate.ts: pure judgment, directly `node --test`.
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
// Helpers building projection messages
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

test("DEFAULT_VERIFY_PATTERN: the default is \"any bash call counts\" (undefined)", () => {
	assert.equal(DEFAULT_VERIFY_PATTERN, undefined);
});

// =============================================================================
// findRunStart / scanRun
// =============================================================================

test("findRunStart: the last user message is the window start", () => {
	const messages = [user("a"), assistantText("x"), user("b"), assistantText("y")];
	assert.equal(findRunStart(messages), 2);
});

test("findRunStart: with no user message the whole projection is the window", () => {
	const messages = [assistantText("x"), assistantText("y")];
	assert.equal(findRunStart(messages), -1);
});

test("findRunStart: injected custom messages are not user (the continuation chain shares one window)", () => {
	const messages = [user("a"), assistantText("x"), injected("gate"), assistantText("y")];
	assert.equal(findRunStart(messages), 0);
});

test("scanRun: counts mutations and the verifications after them", () => {
	const messages = [
		user("change it"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantToolCalls({ name: "bash", args: { command: "node --test adapter/tests/*.test.js" } }),
		toolResult(),
	];
	const scan = scanRun(messages);
	assert.equal(scan.mutations.length, 1);
	assert.equal(scan.verificationsAfterLastMutation, 1);
});

test("scanRun: a verification before the mutation does not count (FRESH evidence)", () => {
	const messages = [
		user("change it"),
		assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
		toolResult(),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
	];
	const scan = scanRun(messages);
	assert.equal(scan.verificationsAfterLastMutation, 0);
});

test("scanRun: a new mutation expires earlier verifications", () => {
	const messages = [
		user("change it"),
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

test("scanRun: changes outside the window do not count (last turn's work cannot vouch for this one)", () => {
	const messages = [
		user("round one"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		user("round two"),
		assistantText("ok"),
	];
	const scan = scanRun(messages);
	assert.equal(scan.mutations.length, 0);
});

test("scanRun: writes inside bash are not mutations (known boundary)", () => {
	const messages = [
		user("change it"),
		assistantToolCalls({ name: "bash", args: { command: "sed -i '' 's/a/b/' src/a.js" } }),
		toolResult(),
	];
	const scan = scanRun(messages, config());
	assert.equal(scan.mutations.length, 0);
});

test("scanRun: apply_patch / multiedit count as mutations (future/third-party registrations)", () => {
	const messages = [
		user("change it"),
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

test("decideGate: files changed, no verification → block", () => {
	const messages = [
		user("change it"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantText("done"),
	];
	const decision = decideGate(messages, config());
	assert.equal(decision.action, "block");
	if (decision.action === "block") {
		assert.equal(decision.attempt, 1);
		assert.equal(decision.cap, 2);
		assert.deepEqual(decision.mutations, [{ tool: "edit", path: "src/a.js" }]);
	}
});

test("decideGate: verification ran after the change → pass", () => {
	const messages = [
		user("change it"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantToolCalls({ name: "bash", args: { command: "node --test adapter/tests/*.test.js" } }),
		toolResult(),
		assistantText("done"),
	];
	assert.equal(decideGate(messages, config()).action, "pass");
});

test("decideGate: a failed verification still counts (the evidence is in the context)", () => {
	const messages = [
		user("change it"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
		{ role: "toolResult", content: [{ type: "text", text: "Command exited with code 1" }] },
		assistantText("the tests failed, checking again"),
	];
	assert.equal(decideGate(messages, config()).action, "pass");
});

test("decideGate: no files changed → pass (pure Q&A is not gated)", () => {
	const messages = [user("what does this code do"), assistantText("here is the explanation")];
	assert.equal(decideGate(messages, config()).action, "pass");
});

test("decideGate: docs-only edits → pass (.md/.txt excluded by default)", () => {
	const messages = [
		user("update docs"),
		assistantToolCalls({ name: "edit", args: { path: "AGENTS.md" } }),
		toolResult(),
		assistantText("done"),
	];
	assert.equal(decideGate(messages, config()).action, "pass");
});

test("decideGate: an empty docExtensions also gates docs", () => {
	const messages = [
		user("update docs"),
		assistantToolCalls({ name: "edit", args: { path: "AGENTS.md" } }),
		toolResult(),
		assistantText("done"),
	];
	assert.equal(decideGate(messages, config({ docExtensions: [] })).action, "block");
});

test("decideGate: mode=off → always pass", () => {
	const messages = [
		user("change it"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantText("done"),
	];
	assert.equal(decideGate(messages, config({ mode: "off" })).action, "pass");
});

test("decideGate: enough injected gate messages → pass (CC's forced release)", () => {
	const messages = [
		user("change it"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantText("done"),
		injected("gate"),
		assistantText("still done"),
		injected("gate"),
		assistantText("insists done"),
	];
	assert.equal(decideGate(messages, config({ blockCap: 2 })).action, "pass");
});

test("decideGate: blocked once, files changed again without verification → a second block", () => {
	const messages = [
		user("change it"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
		toolResult(),
		assistantText("done"),
		injected("gate"),
		assistantToolCalls({ name: "edit", args: { path: "src/b.js" } }),
		toolResult(),
		assistantText("really done this time"),
	];
	const decision = decideGate(messages, config({ blockCap: 2 }));
	assert.equal(decision.action, "block");
	if (decision.action === "block") assert.equal(decision.attempt, 2);
});

test("decideGate: a custom verifyPattern takes effect", () => {
	const messages = [
		user("change it"),
		assistantToolCalls({ name: "edit", args: { path: "src/a.py" } }),
		toolResult(),
		assistantToolCalls({ name: "bash", args: { command: "./check.sh" } }),
		toolResult(),
		assistantText("done"),
	];
	const custom = config({ verifyPattern: /check\.sh/i });
	assert.equal(decideGate(messages, custom).action, "pass");
});

test("decideGate: under the default rule any bash call counts (regression for the 2026-09-25 live false positive)", () => {
	// after editing probe.js the model ran a node -e import that printed the new value — real evidence, but no test-runner shape.
	const messages = [
		user("change it"),
		assistantToolCalls({ name: "edit", args: { path: "probe.js" } }),
		toolResult(),
		assistantToolCalls({ name: "bash", args: { command: "node --input-type=module -e \"import('./probe.js').then(m => console.log(m.VALUE))\"" } }),
		toolResult(),
		assistantText("done"),
	];
	assert.equal(decideGate(messages, config()).action, "pass", "the default rule must not block");
	assert.equal(decideGate(messages, config({ verifyPattern: STRICT_VERIFY_PATTERN })).action, "block", "the strict rule would block");
});

test("decideGate: the strict rule recognizes test/build/lint shapes", () => {
	const strict = config({ verifyPattern: STRICT_VERIFY_PATTERN });
	for (const command of ["node --test adapter/tests/*.test.js", "npm test", "pnpm run test", "pytest gateway/tests", "cargo test", "go build ./...", "tsc --noEmit", "eslint .", "make test"]) {
		const messages = [
			user("change it"),
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

test("countInjected: counts only injected messages of the given kind", () => {
	const messages = [user("a"), injected("gate"), injected("goal-not-met"), injected("gate")];
	assert.equal(countInjected(messages, "gate"), 2);
	assert.equal(countInjected(messages, "goal-not-met"), 1);
	assert.equal(countInjected(messages, "goal-met"), 0);
});

test("renderGateMessage: carries the file list and the count", () => {
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
