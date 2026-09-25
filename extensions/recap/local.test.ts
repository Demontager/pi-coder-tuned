import assert from "node:assert/strict";
import test from "node:test";
import { extractLocalRecap, usesLocalRecap } from "./local.ts";

test("auto selects extraction for loopback; extract also supports LAN endpoints", () => {
	for (const baseUrl of ["http://127.0.0.1:8080/v1", "http://127.2.3.4/v1", "http://LOCALHOST/v1", "http://[::1]:8080/v1"]) {
		assert.equal(usesLocalRecap({ baseUrl }, "auto"), true);
	}
	assert.equal(usesLocalRecap({ provider: "llama-local" }, "auto"), true);
	assert.equal(usesLocalRecap({ baseUrl: "https://localhost.example.com/v1" }, "auto"), false);
	assert.equal(usesLocalRecap({ baseUrl: "http://192.168.1.2:8080/v1" }, "extract"), true);
	assert.equal(usesLocalRecap({ provider: "llama-local" }, "model"), false);
});

test("extraction uses latest visible prose without reasoning, tool calls, or old answers", () => {
	const user = { type: "message", message: { role: "user", content: "Fix it" } };
	const answer = (content: unknown, rest = {}) => ({ type: "message", message: { role: "assistant", content, ...rest } });
	assert.equal(extractLocalRecap([user, answer([{ type: "thinking", thinking: "secret" }, { type: "text", text: "## Result\n**Fixed** `test_data`.\n- Tests pass." }])]), "Fixed test_data. Tests pass.");
	assert.equal(extractLocalRecap([answer("Old answer"), user]), "");
	for (const stopReason of ["aborted", "error", "toolUse"]) assert.equal(extractLocalRecap([user, answer("partial", { stopReason })]), "");
	assert.equal(extractLocalRecap([user, answer([{ type: "toolCall", name: "bash" }])]), "");
	assert.match(extractLocalRecap([user, answer("```c\nint x;\n```")]), /contains code/);
	assert.equal(extractLocalRecap([user, answer("<think>secret</think>Done.")]), "Done.");
	assert.equal([...extractLocalRecap([user, answer("word ".repeat(100))])].length, 120);
});
