/**
 * Tests for keybinding.ts — the thinking-level cycle's rebind rules.
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/keybinding.test.ts
 *
 * The single most important thing: when the user configured `app.thinking.cycle` themselves,
 * **not one character may change**. An extension silently overwriting the user's key config is
 * obnoxious, so the "do not touch" cases matter more than the "rebind correctly" ones.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { THINKING_FALLBACK_KEY, THINKING_KEYBINDING_ID, keybindingsPath, rebindThinkingKey } from "./keybinding.ts";

const PATH = "/tmp/agent/keybindings.json";

describe("rebindThinkingKey: should change", () => {
	it("empty config → generate a new config containing only this entry", () => {
		const { value, outcome } = rebindThinkingKey("", PATH);
		assert.equal(outcome.changed, true);
		assert.equal(outcome.path, PATH);
		assert.equal(outcome.reason, undefined);
		const parsed = JSON.parse(value) as Record<string, string>;
		assert.equal(parsed[THINKING_KEYBINDING_ID], THINKING_FALLBACK_KEY);
	});

	it("whitespace only → treated as empty config", () => {
		assert.equal(rebindThinkingKey("   \n", PATH).outcome.changed, true);
	});

	it("other existing bindings are preserved", () => {
		const raw = `${JSON.stringify({ "tui.input.newLine": "ctrl+j", "app.suspend": "ctrl+z" }, null, 2)}\n`;
		const { value, outcome } = rebindThinkingKey(raw, PATH);
		assert.equal(outcome.changed, true);
		const parsed = JSON.parse(value) as Record<string, string>;
		assert.equal(parsed["tui.input.newLine"], "ctrl+j", "the user's existing bindings must stay");
		assert.equal(parsed["app.suspend"], "ctrl+z");
		assert.equal(parsed[THINKING_KEYBINDING_ID], THINKING_FALLBACK_KEY);
	});

	it("the output ends with a newline (no no-newline-at-eof in diffs)", () => {
		assert.ok(rebindThinkingKey("", PATH).value.endsWith("\n"));
	});
});

describe("rebindThinkingKey: should not change", () => {
	it("user already configured the thinking cycle → touch nothing, no notice", () => {
		const raw = `${JSON.stringify({ [THINKING_KEYBINDING_ID]: "ctrl+t" }, null, 2)}\n`;
		const { value, outcome } = rebindThinkingKey(raw, PATH);
		assert.equal(outcome.changed, false);
		assert.equal(value, raw);
		assert.match(outcome.reason ?? "", /already has a binding/);
		assert.notEqual(outcome.needsAttention, true, "this is the desired state — must not notify the user");
	});

	it("previously rebound (value already the fallback) → idempotent, no rewrite", () => {
		const raw = `${JSON.stringify({ [THINKING_KEYBINDING_ID]: THINKING_FALLBACK_KEY }, null, 2)}\n`;
		assert.equal(rebindThinkingKey(raw, PATH).outcome.changed, false);
	});

	it("config is not valid JSON → untouched, and the user is asked to handle it", () => {
		const raw = "{ this is not JSON";
		const { value, outcome } = rebindThinkingKey(raw, PATH);
		assert.equal(outcome.changed, false);
		assert.equal(value, raw);
		assert.match(outcome.reason ?? "", /JSON/);
		assert.equal(outcome.needsAttention, true, "unreadable and untouchable → the user should be told");
	});

	it("config is JSON but not an object (array / string / null) → untouched", () => {
		for (const raw of ["[1, 2]", '"hello"', "null", "42"]) {
			const { value, outcome } = rebindThinkingKey(raw, PATH);
			assert.equal(outcome.changed, false, `must not change: ${raw}`);
			assert.equal(value, raw);
		}
	});
});

describe("keybindingsPath", () => {
	it("defaults to <agentDir>/keybindings.json", () => {
		const path = keybindingsPath({ PI_CODING_AGENT_DIR: "/custom/agent" } as NodeJS.ProcessEnv);
		assert.equal(path, "/custom/agent/keybindings.json");
	});

	it("falls back to ~/.pi/agent without the env var", () => {
		const path = keybindingsPath({} as NodeJS.ProcessEnv);
		assert.match(path, /\.pi\/agent\/keybindings\.json$/);
	});
});
