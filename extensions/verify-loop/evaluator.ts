/**
 * evaluator.ts — the /goal evaluator's pure functions: prompt building, conversation
 * tail-truncation, verdict parsing.
 *
 * The CC prototype (code.claude.com/docs/en/goal, verified):
 *   - the evaluator is a **small fast model** (default Haiku) with **no tool permissions**,
 *     "It doesn't run commands or read files independently, so write the condition
 *     as something Claude's own output can demonstrate" — it judges only from the
 *     conversation content.
 *   - input = the condition + the conversation so far; output = one of three verdicts + a
 *     short reason.
 *
 * The pi landing spot: index.ts makes one standalone `ctx.modelRegistry.complete()` call
 * (no tools), independent of the main conversation (the pattern recap / working-indicator
 * already proved). This file only does prompts and parsing — no requests — so it is directly
 * `node --test`-able.
 *
 * **Fail-open**: when the evaluation call fails / times out / yields no parsable verdict,
 * index.ts lets the turn finish (CC's hook failure also does not block the turn). The
 * evaluator is an enhancement — it must not stall pi by breaking itself.
 */

import type { Verdict } from "./goal.ts";

/** The evaluator's system prompt: only the three verdicts + a reason, JSON output. */
export const EVALUATOR_SYSTEM_PROMPT = `You are a completion-condition evaluator for an AI coding agent.
You judge whether a stated condition currently holds, based ONLY on the conversation transcript you are given.
You have no tools: you cannot run commands or read files. Evidence must already appear in the transcript.

Respond with a single JSON object and nothing else:
{"verdict": "met" | "not_met" | "impossible", "reason": "<one short sentence>"}

- "met": the transcript contains concrete evidence that the condition holds (e.g. a test run with passing output, a shown file content, an exit code).
- "not_met": the condition may still be satisfiable; explain in one sentence what is missing or what to do next.
- "impossible": the condition can never be satisfied (contradiction, nonexistent target, explicitly out of reach).

Judge strictly: claims without evidence are "not_met".`;

/** The char cap for the serialized conversation handed to the evaluator (`PI_GOAL_CONTEXT_CHARS` overrides). */
export const DEFAULT_CONTEXT_CHARS = 120_000;

/**
 * Build the evaluation prompt.
 *
 * `conversation` is the result of `serializeConversation(convertToLlm(projected messages))`
 * (two functions exported from the pi package root) — the LLM-view messages serialized into
 * readable text.
 * On overflow **cut the head, keep the tail**: the most recent conversation is the
 * judging basis.
 */
export function buildEvaluatorPrompt(condition: string, conversation: string, maxChars = DEFAULT_CONTEXT_CHARS): string {
	const trimmed = conversation.length > maxChars ? `… (earlier conversation truncated)
${conversation.slice(-maxChars)}` : conversation;
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
 * Parse the evaluator's reply. Forgiving: bare JSON, wrapped in a code fence, or surrounded
 * by stray text are all tried;
 * an unrecognized verdict word fails outright (the caller lets the turn pass per fail-open).
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
	const reason = typeof record.reason === "string" && record.reason.trim() !== "" ? record.reason.trim() : "(evaluator provided no reason)";
	return { verdict, reason: reason.slice(0, 1000) };
}

/** Normalize the evaluator's various phrasings down to the three verdicts. */
export function normalizeVerdict(raw: string): Verdict | undefined {
	const value = raw.trim().toLowerCase().replace(/[\s_-]+/g, "_");
	if (value === "met" || value === "ok" || value === "done" || value === "satisfied") return "met";
	if (value === "not_met" || value === "notmet" || value === "not met") return "not_met";
	if (value === "impossible" || value === "infeasible" || value === "unsatisfiable") return "impossible";
	return undefined;
}

/** Extract the first complete-looking JSON object from text (handles code fences / stray text). */
export function extractJsonObject(text: string): string | undefined {
	const fenceMatch = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(text);
	if (fenceMatch?.[1]) return fenceMatch[1];
	const start = text.indexOf("{");
	if (start === -1) return undefined;
	// find the closer by paren-pair counting from the first { (parens inside strings do not count)
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
