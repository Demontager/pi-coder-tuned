import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const piEntry = process.env.PI_TEST_PI_ENTRY;

test("stop-hook measures complete runs and renders stable, width-safe results", {
	skip: !piEntry && "Set PI_TEST_PI_ENTRY to test with Pi's real extension loader",
}, async (t) => {
	const pi = await import(pathToFileURL(piEntry!).href);
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stop-hook-"));
	t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
	const loaded = await pi.discoverAndLoadExtensions(
		[path.resolve(import.meta.dirname, "../stop-hook.ts")], scratch, scratch,
		{ emit() {}, on() { return () => {}; } },
	);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	const widgets = new Map<string, any>();
	let now = 0;
	let draws = 0;
	let random = 0;
	t.mock.method(performance, "now", () => now);
	t.mock.method(Math, "random", () => { draws++; return random; });
	const ctx: any = {
		mode: "tui",
		ui: { setWidget(key: string, factory: any) {
			if (factory === undefined) widgets.delete(key);
			else widgets.set(key, factory({}, { fg: (_slot: string, text: string) => text }));
		} },
	};
	async function emit(name: string, event: any = {}, context = ctx) {
		for (const handler of extension.handlers.get(name) ?? []) await handler(event, context);
	}
	const result = () => widgets.get("stop-hook").render(100).join("\n").trim();
	await emit("session_start");
	await emit("input", { source: "interactive" });
	now = 1000;
	await emit("agent_start");
	await emit("tool_execution_start");
	await emit("agent_end");
	assert.equal(widgets.size, 0, "agent_end is not final");
	now = 60000;
	await emit("input", { source: "interactive", streamingBehavior: "steer" });
	await emit("input", { source: "interactive", streamingBehavior: "followUp" });
	await emit("agent_start");
	await emit("tool_execution_start");
	await emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
	now = 134000;
	await emit("agent_settled");
	assert.equal(result(), "✦ Done in 2m 14s. Used 2 tool calls.");
	assert.equal(draws, 1);
	for (let width = 1; width <= 100; width++) {
		for (const line of widgets.get("stop-hook").render(width)) {
			assert.ok([...stripVTControlCharacters(line)].length <= width, `width ${width}: ${JSON.stringify(line)}`);
		}
	}
	assert.equal(draws, 1, "rendering must not change the random label");
	await emit("agent_settled");
	assert.equal(draws, 1, "duplicate settlement must not create a new result");

	for (const [i, word] of ["Done", "Cooked", "Brewed", "Built", "Baked", "Crafted"].entries()) {
		random = (i + 0.5) / 6;
		await emit("input", { source: "interactive" });
		assert.equal(widgets.size, 0);
		await emit("agent_start");
		now += 61000;
		await emit("agent_settled");
		assert.equal(result(), `✦ ${word} in 1m 1s. Used 0 tool calls.`);
	}
	await emit("agent_start"); // Extension-initiated run, no interactive input.
	assert.equal(widgets.size, 0);
	await emit("tool_execution_start");
	now += 3661000;
	await emit("agent_settled");
	assert.equal(result(), "✦ Crafted in 1h 1m 1s. Used 1 tool call.");

	for (const [reason, label] of [["aborted", "Interrupted"], ["error", "Failed"]]) {
		await emit("agent_start");
		await emit("message_end", { message: { role: "assistant", stopReason: reason } });
		await emit("agent_settled");
		assert.equal(result(), `✦ ${label} in 0s. Used 0 tool calls.`);
	}
	for (const event of ["session_tree", "session_shutdown", "session_start"]) {
		await emit("agent_start");
		await emit(event);
		await emit("agent_settled");
		assert.equal(widgets.size, 0, `${event} clears in-flight state`);
	}
	const noUi: any = { mode: "json", get ui() { throw new Error("No UI in JSON mode"); } };
	await emit("input", { source: "interactive" }, noUi);
	await emit("agent_start", {}, noUi);
	await emit("agent_settled", {}, noUi);
	assert.equal(widgets.size, 0);
});
