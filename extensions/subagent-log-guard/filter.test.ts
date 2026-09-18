/**
 * Tests for filter.ts — the "[pi-subagents] …" stderr-chunk classifier behind subagent-log-guard.
 *
 * Run with:  node --test clients/pi/extensions/subagent-log-guard/filter.test.ts
 *
 * filter.ts never imports pi / pi-tui (that is the point of the split), so these tests need
 * nothing but node:test. The classifier is deliberately prefix-only: pi-subagents formats one
 * console.warn call into one "text + newline" write, so a real diagnostic always starts the
 * chunk — and a `[pi-subagents]` mention in the middle of someone else's write must survive.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chunkToText, splitSubagentDiagnostics, SUBAGENT_LOG_PREFIX } from "./filter.ts";

/** The real line that smeared a live session (pulled verbatim from a runner.stderr.log). */
const REAL_DIAGNOSTIC =
	`${SUBAGENT_LOG_PREFIX} Agent 'researcher': host runtime tool availability omitted [web_search, fetch_content, ` +
	"get_search_content, source_check]. Requested tool names: [read, write, web_search, fetch_content, " +
	"get_search_content, source_check, contact_supervisor]; effective tool allowlist: [read, write, " +
	"contact_supervisor]. This is a non-fatal tool-plan diagnostic, not verification of the child's runtime " +
	"tool menu.\n";

describe("splitSubagentDiagnostics", () => {
	it("captures a real diagnostic and strips the prefix plus the trailing newline", () => {
		const { passThrough, captured } = splitSubagentDiagnostics(REAL_DIAGNOSTIC);
		assert.equal(passThrough, "");
		assert.equal(captured.length, 1);
		assert.ok(captured[0]?.startsWith("Agent 'researcher': host runtime tool availability omitted"));
		assert.ok(captured[0]?.endsWith("runtime tool menu."));
		assert.ok(!captured[0]?.includes(SUBAGENT_LOG_PREFIX));
	});

	it("passes ordinary stderr through untouched, byte for byte", () => {
		const text = "Error: something exploded\n";
		const { passThrough, captured } = splitSubagentDiagnostics(text);
		assert.equal(passThrough, text);
		assert.deepEqual(captured, []);
	});

	it("keeps a mid-chunk mention of the prefix instead of swallowing the whole write", () => {
		// e.g. an extension echoing a log file line, or the model quoting the package name.
		const text = `see ${SUBAGENT_LOG_PREFIX} lines in runner.stderr.log\n`;
		const { passThrough, captured } = splitSubagentDiagnostics(text);
		assert.equal(passThrough, text);
		assert.deepEqual(captured, []);
	});

	it("captures a multi-line diagnostic as one entry (no continuation line leaks out)", () => {
		const text = `${SUBAGENT_LOG_PREFIX} first line\nsecond line\n`;
		const { passThrough, captured } = splitSubagentDiagnostics(text);
		assert.equal(passThrough, "");
		assert.deepEqual(captured, ["first line\nsecond line"]);
	});

	it("handles a prefix-only write without inventing content", () => {
		const { passThrough, captured } = splitSubagentDiagnostics(`${SUBAGENT_LOG_PREFIX}\n`);
		assert.equal(passThrough, "");
		assert.deepEqual(captured, [""]);
	});

	it("handles an empty write", () => {
		const { passThrough, captured } = splitSubagentDiagnostics("");
		assert.equal(passThrough, "");
		assert.deepEqual(captured, []);
	});
});

describe("chunkToText", () => {
	it("returns string chunks as-is", () => {
		assert.equal(chunkToText("plain"), "plain");
	});

	it("decodes Buffer / Uint8Array chunks the way console writes them", () => {
		const buffer = Buffer.from(REAL_DIAGNOSTIC, "utf8");
		assert.equal(chunkToText(buffer), REAL_DIAGNOSTIC);
		const { captured } = splitSubagentDiagnostics(chunkToText(buffer));
		assert.equal(captured.length, 1);
	});

	it("keeps multi-byte characters intact across a Buffer boundary", () => {
		assert.equal(chunkToText(Buffer.from("工具调用失败\n", "utf8")), "工具调用失败\n");
	});
});
