/**
 * evaluator.ts — /goal 评估器的纯函数：提示词构建、对话截尾、裁决解析。
 *
 * CC 原型（code.claude.com/docs/en/goal，已核实）：
 *   - 评估器是**小快模型**（默认 Haiku），**没有工具权限**，
 *     "It doesn't run commands or read files independently, so write the condition
 *     as something Claude's own output can demonstrate" —— 它只读对话内容判定。
 *   - 输入 = 条件 + 到目前为止的对话；输出 = 三裁决之一 + 短理由。
 *
 * pi 落点：index.ts 用一次独立的 `ctx.modelRegistry.complete()`（不带工具）调用，
 * 与主对话互不相干（recap / working-indicator 已验证的模式）。本文件只管
 * 提示词与解析，不发请求 —— 可 `node --test` 直测。
 *
 * **fail-open 原则**：评估调用失败 / 超时 / 解析不出裁决时，index.ts 放行回合
 * （CC 的 hook 失败同样不拦回合）。评估器是增强，不该因为自己坏了把 pi 弄停摆。
 */

import type { Verdict } from "./goal.ts";

/** 评估器系统提示词：只许三裁决 + 理由，JSON 输出。 */
export const EVALUATOR_SYSTEM_PROMPT = `You are a completion-condition evaluator for an AI coding agent.
You judge whether a stated condition currently holds, based ONLY on the conversation transcript you are given.
You have no tools: you cannot run commands or read files. Evidence must already appear in the transcript.

Respond with a single JSON object and nothing else:
{"verdict": "met" | "not_met" | "impossible", "reason": "<one short sentence>"}

- "met": the transcript contains concrete evidence that the condition holds (e.g. a test run with passing output, a shown file content, an exit code).
- "not_met": the condition may still be satisfiable; explain in one sentence what is missing or what to do next.
- "impossible": the condition can never be satisfied (contradiction, nonexistent target, explicitly out of reach).

Judge strictly: claims without evidence are "not_met".`;

/** 对话序列化给评估器时的字符上限（`PI_GOAL_CONTEXT_CHARS` 可覆盖）。 */
export const DEFAULT_CONTEXT_CHARS = 120_000;

/**
 * 构建评估提示词。
 *
 * `conversation` 是 `serializeConversation(convertToLlm(投影消息))` 的结果
 * （pi 包根导出的两个函数）——已经过 LLM 视角的消息序列化成可读文本。
 * 超长时**截头留尾**：最近的对话才是判定依据。
 */
export function buildEvaluatorPrompt(condition: string, conversation: string, maxChars = DEFAULT_CONTEXT_CHARS): string {
	const trimmed = conversation.length > maxChars ? `…（更早的对话已截断）\n${conversation.slice(-maxChars)}` : conversation;
	return `Completion condition to judge:
<condition>
${condition}
</condition>

Conversation transcript so far:
<transcript>
${trimmed}
</transcript>

Respond with the JSON verdict object only.`;
}

/**
 * 解析评估器回复。容错：裸 JSON、包在 code fence 里、前后带杂字都试着抽出来；
 * verdict 不认识的词一律 fail（调用方按 fail-open 放行）。
 */
export function parseVerdict(text: string): { verdict: Verdict; reason: string } | undefined {
	const candidate = extractJsonObject(text);
	if (candidate === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as { verdict?: unknown; reason?: unknown };
	const verdict = normalizeVerdict(typeof record.verdict === "string" ? record.verdict : "");
	if (verdict === undefined) return undefined;
	const reason = typeof record.reason === "string" && record.reason.trim() !== "" ? record.reason.trim() : "(评估器未给出理由)";
	return { verdict, reason: reason.slice(0, 1000) };
}

/** 把评估器可能输出的各种写法归一到三裁决。 */
export function normalizeVerdict(raw: string): Verdict | undefined {
	const value = raw.trim().toLowerCase().replace(/[\s_-]+/g, "_");
	if (value === "met" || value === "ok" || value === "done" || value === "satisfied") return "met";
	if (value === "not_met" || value === "notmet" || value === "not met") return "not_met";
	if (value === "impossible" || value === "infeasible" || value === "unsatisfiable") return "impossible";
	return undefined;
}

/** 从文本里抽出第一个看起来完整的 JSON 对象（code fence / 前后杂字都能抽）。 */
export function extractJsonObject(text: string): string | undefined {
	const fenceMatch = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(text);
	if (fenceMatch?.[1]) return fenceMatch[1];
	const start = text.indexOf("{");
	if (start === -1) return undefined;
	// 从第一个 { 起按括号配对找结束（字符串内的括号不计）
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const char = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}
