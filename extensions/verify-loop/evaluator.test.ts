/**
 * evaluator.ts 的验证：提示词构建与裁决解析，直接 `node --test`。
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

test("buildEvaluatorPrompt: 条件与对话都在里面", () => {
	const prompt = buildEvaluatorPrompt("所有测试通过", "user: 改一下\nassistant: 改好了");
	assert.match(prompt, /所有测试通过/);
	assert.match(prompt, /改好了/);
});

test("buildEvaluatorPrompt: 超长对话截头留尾（最近的才是判定依据）", () => {
	const conversation = `${"早".repeat(500)}\n${"晚".repeat(500)}`;
	const prompt = buildEvaluatorPrompt("条件", conversation, 600);
	assert.ok(prompt.length < conversation.length + 200);
	assert.match(prompt, /已截断/);
	assert.match(prompt, /晚/);
});

test("buildEvaluatorPrompt: 不超长时不截断", () => {
	const prompt = buildEvaluatorPrompt("条件", "短对话", DEFAULT_CONTEXT_CHARS);
	assert.ok(!prompt.includes("已截断"));
	assert.match(prompt, /短对话/);
});

test("EVALUATOR_SYSTEM_PROMPT: 声明无工具 + 三裁决 + JSON 输出", () => {
	assert.match(EVALUATOR_SYSTEM_PROMPT, /no tools/i);
	assert.match(EVALUATOR_SYSTEM_PROMPT, /met/);
	assert.match(EVALUATOR_SYSTEM_PROMPT, /not_met/);
	assert.match(EVALUATOR_SYSTEM_PROMPT, /impossible/);
	assert.match(EVALUATOR_SYSTEM_PROMPT, /JSON/);
});

// =============================================================================
// normalizeVerdict
// =============================================================================

test("normalizeVerdict: 三裁决的标准写法", () => {
	assert.equal(normalizeVerdict("met"), "met");
	assert.equal(normalizeVerdict("not_met"), "not_met");
	assert.equal(normalizeVerdict("impossible"), "impossible");
});

test("normalizeVerdict: 大小写 / 空格 / 连字符 / 下划线都归一", () => {
	assert.equal(normalizeVerdict("MET"), "met");
	assert.equal(normalizeVerdict(" Not Met "), "not_met");
	assert.equal(normalizeVerdict("not-met"), "not_met");
	assert.equal(normalizeVerdict("not met"), "not_met");
});

test("normalizeVerdict: CC prompt-hook 的 ok 写法也算 met", () => {
	assert.equal(normalizeVerdict("ok"), "met");
});

test("normalizeVerdict: 不认识的词返回 undefined（调用方 fail-open）", () => {
	assert.equal(normalizeVerdict("maybe"), undefined);
	assert.equal(normalizeVerdict(""), undefined);
});

// =============================================================================
// extractJsonObject
// =============================================================================

test("extractJsonObject: 裸 JSON", () => {
	assert.equal(extractJsonObject('{"verdict":"met"}'), '{"verdict":"met"}');
});

test("extractJsonObject: 包在 code fence 里", () => {
	assert.equal(extractJsonObject('```json\n{"verdict":"met","reason":"ok"}\n```'), '{"verdict":"met","reason":"ok"}');
});

test("extractJsonObject: 前后带杂字", () => {
	assert.equal(extractJsonObject('好的，我的判定是 {"verdict":"met","reason":"ok"} 以上。'), '{"verdict":"met","reason":"ok"}');
});

test("extractJsonObject: 字符串里的花括号不干扰配对", () => {
	const text = '{"verdict":"not_met","reason":"需要跑 {test} 命令"}';
	assert.equal(extractJsonObject(text), text);
});

test("extractJsonObject: 没有 JSON 返回 undefined", () => {
	assert.equal(extractJsonObject("我觉得已经完成了"), undefined);
});

// =============================================================================
// parseVerdict
// =============================================================================

test("parseVerdict: 标准回复", () => {
	assert.deepEqual(parseVerdict('{"verdict":"not_met","reason":"测试还没跑"}'), {
		verdict: "not_met",
		reason: "测试还没跑",
	});
});

test("parseVerdict: 带 code fence 与前后杂字", () => {
	const text = '判定如下：\n```json\n{"verdict": "met", "reason": "输出显示 34/34 通过"}\n```\n完毕';
	assert.deepEqual(parseVerdict(text), { verdict: "met", reason: "输出显示 34/34 通过" });
});

test("parseVerdict: 缺 reason 时给占位（不因为少字段就 fail）", () => {
	const parsed = parseVerdict('{"verdict":"impossible"}');
	assert.equal(parsed?.verdict, "impossible");
	assert.match(parsed?.reason ?? "", /未给出理由/);
});

test("parseVerdict: 空 reason 也给占位", () => {
	const parsed = parseVerdict('{"verdict":"met","reason":"   "}');
	assert.match(parsed?.reason ?? "", /未给出理由/);
});

test("parseVerdict: 超长 reason 截断到 1000 字符", () => {
	const parsed = parseVerdict(JSON.stringify({ verdict: "not_met", reason: "长".repeat(3000) }));
	assert.equal(parsed?.reason.length, 1000);
});

test("parseVerdict: verdict 不认识 → undefined（fail-open）", () => {
	assert.equal(parseVerdict('{"verdict":"perhaps","reason":"x"}'), undefined);
});

test("parseVerdict: 不是 JSON → undefined", () => {
	assert.equal(parseVerdict("条件已经达成了"), undefined);
});

test("parseVerdict: 坏 JSON → undefined", () => {
	assert.equal(parseVerdict('{"verdict":met,}'), undefined);
});

test("parseVerdict: 多个 JSON 对象取第一个", () => {
	assert.deepEqual(parseVerdict('{"verdict":"met","reason":"ok"} 后面还有 {"a":1}'), {
		verdict: "met",
		reason: "ok",
	});
});

test("parseVerdict: 顶层不是对象 → undefined", () => {
	assert.equal(parseVerdict('["met"]'), undefined);
});
