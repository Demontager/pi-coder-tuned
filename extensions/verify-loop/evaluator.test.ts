/**
 * Checks for evaluator.ts: prompt building and verdict parsing, directly `node --test`.
 *
 *   node --test clients/pi/extensions/verify-loop/evaluator.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	buildEvaluatorPrompt,
	DEFAULT_CONTEXT_CHARS,
	EVALUATOR_SYSTEM_PROMPT,
	extractJsonObject,
	normalizeVerdict,
	parseVerdict,
} from "./evaluator.ts";

// =============================================================================
// buildEvaluatorPrompt
// =============================================================================

test("buildEvaluatorPrompt: the condition and conversation are both inside", () => {
	const prompt = buildEvaluatorPrompt("all tests pass", "user: change it\nassistant: done");
	assert.match(prompt, /all tests pass/);
	assert.match(prompt, /done/);
});

test("buildEvaluatorPrompt: an overlong conversation is head-truncated (the most recent is the judging basis)", () => {
	const conversation = `${"early".repeat(500)}\n${"late".repeat(500)}`;
	const prompt = buildEvaluatorPrompt("condition", conversation, 600);
	assert.ok(prompt.length < conversation.length + 200);
	assert.match(prompt, /truncated/);
	assert.match(prompt, /late/);
});

test("buildEvaluatorPrompt: no truncation under the cap", () => {
	const prompt = buildEvaluatorPrompt("condition", "short conversation", DEFAULT_CONTEXT_CHARS);
	assert.ok(!prompt.includes("truncated"));
	assert.match(prompt, /short conversation/);
});

test("EVALUATOR_SYSTEM_PROMPT: declares no tools + three verdicts + JSON output", () => {
	assert.match(EVALUATOR_SYSTEM_PROMPT, /no tools/i);
	assert.match(EVALUATOR_SYSTEM_PROMPT, /met/);
	assert.match(EVALUATOR_SYSTEM_PROMPT, /not_met/);
	assert.match(EVALUATOR_SYSTEM_PROMPT, /impossible/);
	assert.match(EVALUATOR_SYSTEM_PROMPT, /JSON/);
});

// =============================================================================
// normalizeVerdict
// =============================================================================

test("normalizeVerdict: the standard spellings of the three verdicts", () => {
	assert.equal(normalizeVerdict("met"), "met");
	assert.equal(normalizeVerdict("not_met"), "not_met");
	assert.equal(normalizeVerdict("impossible"), "impossible");
});

test("normalizeVerdict: case / spaces / hyphens / underscores all normalize", () => {
	assert.equal(normalizeVerdict("MET"), "met");
	assert.equal(normalizeVerdict(" Not Met "), "not_met");
	assert.equal(normalizeVerdict("not-met"), "not_met");
	assert.equal(normalizeVerdict("not met"), "not_met");
});

test("normalizeVerdict: CC prompt-hook's ok spelling counts as met", () => {
	assert.equal(normalizeVerdict("ok"), "met");
});

test("normalizeVerdict: unrecognized words return undefined (callers fail open)", () => {
	assert.equal(normalizeVerdict("maybe"), undefined);
	assert.equal(normalizeVerdict(""), undefined);
});

// =============================================================================
// extractJsonObject
// =============================================================================

test("extractJsonObject: bare JSON", () => {
	assert.equal(extractJsonObject('{"verdict":"met"}'), '{"verdict":"met"}');
});

test("extractJsonObject: wrapped in a code fence", () => {
	assert.equal(extractJsonObject('```json\n{"verdict":"met","reason":"ok"}\n```'), '{"verdict":"met","reason":"ok"}');
});

test("extractJsonObject: stray text before and after", () => {
	assert.equal(extractJsonObject('Alright, my verdict is {"verdict":"met","reason":"ok"} — done.'), '{"verdict":"met","reason":"ok"}');
});

test("extractJsonObject: braces inside strings do not disturb pairing", () => {
	const text = '{"verdict":"not_met","reason":"need to run {test} command"}';
	assert.equal(extractJsonObject(text), text);
});

test("extractJsonObject: no JSON returns undefined", () => {
	assert.equal(extractJsonObject("I think it is done already"), undefined);
});

// =============================================================================
// parseVerdict
// =============================================================================

test("parseVerdict: a standard reply", () => {
	assert.deepEqual(parseVerdict('{"verdict":"not_met","reason":"tests not run yet"}'), {
		verdict: "not_met",
		reason: "tests not run yet",
	});
});

test("parseVerdict: with a code fence and stray text around", () => {
	const text = 'Verdict as follows:\n```json\n{"verdict": "met", "reason": "output shows 34/34 passing"}\n```\nDone';
	assert.deepEqual(parseVerdict(text), { verdict: "met", reason: "output shows 34/34 passing" });
});

test("parseVerdict: a missing reason gets a placeholder (does not fail over one field)", () => {
	const parsed = parseVerdict('{"verdict":"impossible"}');
	assert.equal(parsed?.verdict, "impossible");
	assert.match(parsed?.reason ?? "", /provided no reason/);
});

test("parseVerdict: an empty reason gets a placeholder too", () => {
	const parsed = parseVerdict('{"verdict":"met","reason":"   "}');
	assert.match(parsed?.reason ?? "", /provided no reason/);
});

test("parseVerdict: an overlong reason is clipped to 1000 chars", () => {
	const parsed = parseVerdict(JSON.stringify({ verdict: "not_met", reason: "long".repeat(3000) }));
	assert.equal(parsed?.reason.length, 1000);
});

test("parseVerdict: unrecognized verdict → undefined (fail-open)", () => {
	assert.equal(parseVerdict('{"verdict":"perhaps","reason":"x"}'), undefined);
});

test("parseVerdict: not JSON → undefined", () => {
	assert.equal(parseVerdict("the condition is met"), undefined);
});

test("parseVerdict: broken JSON → undefined", () => {
	assert.equal(parseVerdict('{"verdict":met,}'), undefined);
});

test("parseVerdict: multiple JSON objects → the first wins", () => {
	assert.deepEqual(parseVerdict('{"verdict":"met","reason":"ok"} followed by {"a":1}'), {
		verdict: "met",
		reason: "ok",
	});
});

test("parseVerdict: top level not an object → undefined", () => {
	assert.equal(parseVerdict('["met"]'), undefined);
});
