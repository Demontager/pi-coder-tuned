/**
 * summary-request.ts — pure logic for "when the prompt is too long, ask the model to compress it
 * into one line": trigger decision, request prompt, reply cleanup.
 *
 * Background is in `working-summary.ts`'s header comment: the spinner line's tail cell only fits
 * a few dozen columns, and a long prompt truncated by visible width keeps only its first few
 * characters ("help me look…") — nearly zero information. So `working-indicator.ts` does more
 * than flatten/cache the prompt on `input`: it **asynchronously** sends one model request asking
 * it to state what this prompt does in a single line. The request runs parallel to the main
 * round and blocks nothing; when it comes back the summary replaces the text, and on
 * failure/absence the truncated original keeps showing — the summary is strictly an enhancement.
 *
 * ## Trigger conditions (`planSummaryRequest`)
 *
 * Worth one request whenever the original does not fit. Two cases (default ratio 1):
 *
 *   prompt width ≤ available width → the whole thing fits; `layoutPromptSummary` shows it in full, no request
 *   prompt width > available width → request a summary (even one column over — truncation loses the
 *                                    tail, and the tail is usually "what to change / change into
 *                                    what", which is more informative squeezed into one line)
 *
 * The ratio is `triggerRatio` (`PI_WORKING_SUMMARY_TRIGGER`, default 1): 1 = compress whenever it
 * does not fit; 1.2 / 2 serves "do not want to spend a thinking request on every over-long
 * prompt" — 1.2 ≈ compress only when truncation would lose nearly a fifth of the original, 2 =
 * only when more than half is lost. Widths are always **visible columns** (the caller measures
 * with pi-tui's `visibleWidth` and passes them in), not char counts — a Han character is 2
 * columns, so char-count checks would call every Chinese prompt "fine".
 *
 * ## Target length (`targetWidth`)
 *
 * The available width (`availableSummaryTextWidth`, the same math the render uses) multiplied by
 * `TARGET_WIDTH_RATIO` yields the column count demanded of the model, along with the accounting
 * rule (Han 2 columns / ASCII 1). The ten-percent headroom covers "the model cannot count
 * exactly": better slightly short and fully displayed than clipped mid-sentence at the edge.
 * Below `MIN_REQUEST_BUDGET` available columns, no request at all — a line squeezed under ten
 * columns carries no information, just as unreadable as the truncated original.
 *
 * **No follow-up when overlong (the caller's guarantee, not this file's logic)**: a summary that
 * comes back too long is **not** retried — `layoutPromptSummary` truncates it by visible width
 * with a trailing `…`. Asking again would only make this cell's content jump back and forth, and
 * the second answer would likely still be long — the requirement verbatim: "do not request a
 * second time; just truncate normally". (Retrying after failure is a separate matter, owned by
 * `index.ts`: that is "got no result", not "result too long".)
 *
 * ## Cleanup (`cleanSummaryText`)
 *
 * Model output is untrusted text: it may emit extra lines, add a "Summary:" label, wrap the
 * whole thing in quotes or `**`, or ramble to hundreds of characters. Cleanup does only the
 * minimal display-level work:
 *
 *   - **Take only the first usable line**. The model sometimes writes a "Summary:" label then
 *     the body on the next line, so each line is cleaned, lines that clean to empty are skipped
 *     (label lines, code-fence markers), and the first non-empty result wins. Deliberately not a
 *     whole-text join — when the model adds a second paragraph of explanation, a join would
 *     squeeze the commentary into the cell too.
 *   - Each line goes through `flattenPrompt` (reusing the flattening: strip ANSI / zero-width
 *     chars, collapse whitespace, strip list bullets and heading marks), so a model's `- ` prefix
 *     or quotes never reach the display.
 *   - Strip whole-text wrapping quotes (ASCII and CJK paired marks), `**bold**` wrappers, and
 *     "Summary:"-style label prefixes. At most three rounds, so stacked decorations like
 *     `**"Summary: xx"**` still come clean.
 *   - Hard char cap `MAX_SUMMARY_TEXT_CHARS` (cut on code points, never half a surrogate pair).
 *     The display layer truncates again by visible width; this only keeps a "model returned a
 *     hundred thousand chars" from dragging memory and width computation.
 *
 * This file imports no pi / pi-tui (widths arrive pre-measured by the caller), so `node --test`
 * runs it directly (see `summary-request.test.ts`).
 */

import { flattenPrompt } from "./working-summary.ts";

/**
 * Trigger ratio: request a summary only when the prompt width exceeds the available width times
 * this ratio. Default 1 = request whenever it does not fit (even one column over) — the policy
 * is "more than the display area means summarize", with no "slightly over, make do with
 * truncation" tier. Larger values serve the "do not want to spend a thinking request on every
 * over-long prompt" preference: 1.2 ≈ compress only when truncation loses nearly a fifth, 2 =
 * only when more than half is lost.
 */
export const DEFAULT_TRIGGER_RATIO = 1;

/** Target width as a fraction of available width: one-tenth headroom so a slightly over-long model answer is not clipped mid-sentence. */
export const TARGET_WIDTH_RATIO = 0.9;

/** Available width below this many columns is not worth a request: a line under ten columns carries no information, as unreadable as the truncated original. */
export const MIN_REQUEST_BUDGET = 10;

/**
 * Prompt length cap fed to the model (chars). The flattened original is already capped at
 * `MAX_PROMPT_SCAN_CHARS` (4000); this trims once more: the model only needs the semantics of
 * the leading stretch, later detail adds nothing to "say what it does in one line", and a
 * larger request body is slower.
 */
export const MAX_REQUEST_INPUT_CHARS = 2000;

/** Char cap on the cleaned summary (in code points). The display layer truncates by visible width separately; this only guards against a runaway model. */
export const MAX_SUMMARY_TEXT_CHARS = 200;

export interface SummaryRequestPlan {
	/** Whether this prompt is worth one model request. */
	needed: boolean;
	/** The target width (visible columns) demanded of the model; meaningless when `needed` is false. */
	targetWidth: number;
}

export interface SummaryRequestPlanOptions {
	/** The flattened prompt's width (visible columns, measured by the caller with `visibleWidth`). */
	promptWidth: number;
	/** The available width for the summary body (visible columns, from `availableSummaryTextWidth`). */
	budgetWidth: number;
	/** Trigger ratio, default `DEFAULT_TRIGGER_RATIO`. */
	triggerRatio?: number;
	/** Available-width floor, default `MIN_REQUEST_BUDGET`. */
	minBudget?: number;
}

/**
 * Decide "whether to request" and "how long the model should write". Pure function: every input
 * is a pre-measured column count, nothing is measured here.
 * The condition is strict greater-than (`promptWidth > budget * ratio`): at exactly the
 * threshold no request is made — the same open/closed direction as "fits → no request".
 */
export function planSummaryRequest(opts: SummaryRequestPlanOptions): SummaryRequestPlan {
	const budget = Math.floor(opts.budgetWidth);
	const minBudget = opts.minBudget ?? MIN_REQUEST_BUDGET;
	const triggerRatio = opts.triggerRatio ?? DEFAULT_TRIGGER_RATIO;
	// the target width is just "available width minus a tenth": narrow cells where `budget < minBudget` are already blocked below,
	// so no separate target floor is needed (only one of the two thresholds ever takes effect).
	const targetWidth = Math.max(1, Math.floor(budget * TARGET_WIDTH_RATIO));
	if (budget < minBudget) return { needed: false, targetWidth };
	return { needed: opts.promptWidth > budget * triggerRatio, targetWidth };
}

/** Truncate by code points (never half a surrogate pair): when too long, append `…` to show "clipped". */
function clipToPoints(text: string, maxPoints: number): string {
	const points = [...text];
	if (points.length <= maxPoints) return text;
	return `${points.slice(0, maxPoints).join("")}…`;
}

/**
 * Assemble the request prompt (the text of a single user message). The model is asked to:
 *   1. emit one line, no newlines, no quotes, no markdown, no "Summary:" label, no explanation;
 *   2. stay under `targetWidth` display columns (with the Han 2 / ASCII 1 accounting given),
 *      preferring short over long;
 *   3. keep "what to do + the object", dropping greetings / background / examples / repetition;
 *   4. answer in the same language as the original.
 *
 * Rule 4 does not hard-code Chinese: giving a Chinese summary for an English prompt reads
 * awkward, so letting the model follow the original is more natural.
 */
export function buildSummaryRequestPrompt(prompt: string, targetWidth: number): string {
	const input = clipToPoints(prompt, MAX_REQUEST_INPUT_CHARS);
	return [
		"You label user prompts in a terminal status bar: say in one short line what the user is asking for.",
		"",
		"Rules:",
		`- Output a single line, at most about ${targetWidth} display columns wide. A CJK/full-width character counts as 2 columns, an ASCII character as 1. Stay clearly under the limit rather than at it.`,
		'- No line breaks, no quotes, no markdown, no label like "Summary:", no explanation — only that line.',
		"- Keep the action and its main object. Drop greetings, background, examples and repeated detail.",
		"- Write in the same language as the input.",
		"",
		"Input:",
		input,
	].join("\n");
}

/** The label words themselves ("Summary" and friends). */
const LABEL_TEXT = "(?:summary|prompt summary|recap|title|label|摘要|总结|概括|简述|一句话摘要)";

/**
 * Label prefix: `Summary:` — tolerant of both bold wrappings (`**Summary:**` and `**Summary**:`)
 * — the trailing bold run after the separator is consumed too, or a stray `**` leaks into the
 * summary body.
 */
const LABEL_PREFIX_RE = new RegExp(
	`^(?:\\*\\*|__)?${LABEL_TEXT}(?:\\*\\*|__)?\\s*[:：]\\s*(?:\\*\\*|__)?\\s*`,
	"i",
);

/** A whole line that is only the label (`Summary` / `**Summary**`): not summary content, skip the line. */
const LABEL_ONLY_RE = new RegExp(`^(?:\\*\\*|__)?${LABEL_TEXT}(?:\\*\\*|__)?\\s*[:：]?$`, "i");

/** Paired wrapping quotes / book-title marks (ASCII straight quotes and CJK paired marks). */
const WRAPPING_QUOTES: ReadonlyArray<readonly [string, string]> = [
	["\"", "\""],
	["'", "'"],
	["“", "”"],
	["‘", "’"],
	["「", "」"],
	["『", "』"],
	["《", "》"],
	["`", "`"],
];

/** Strip one layer of decoration: label prefix → wrapping quotes → wrapping `**`/`__`. */
function stripDecoration(text: string): string {
	let out = text.replace(LABEL_PREFIX_RE, "").trim();
	for (const [open, close] of WRAPPING_QUOTES) {
		if (out.length > open.length + close.length && out.startsWith(open) && out.endsWith(close)) {
			const inner = out.slice(open.length, out.length - close.length).trim();
			if (inner !== "") {
				out = inner;
				break;
			}
		}
	}
	return out.replace(/^(\*\*|__)(.+)\1$/, "$2").trim();
}

/**
 * Clean a model reply (rules in the file header). An empty return means the request produced no
 * usable result — the caller treats that as "show no summary" (the truncated original keeps
 * showing); no retry, no error.
 */
export function cleanSummaryText(raw: string): string {
	// take the first line that cleans to non-empty: label lines ("Summary:"), code-fence marker lines clean to empty
	// and fall through naturally; when the model splits the body across lines only the first is taken — commentary stays out.
	for (const line of raw.split(/\r\n|[\n\r\u0085\u000b\u000c\u2028\u2029]/)) {
		let text = flattenPrompt(line);
		if (text === "") continue;
		// decorations can stack (`**"Summary: xx"**`): iterate until stable, capped at four rounds as a fallback.
		for (let round = 0; round < 4; round++) {
			const next = stripDecoration(text);
			if (next === text) break;
			text = next;
		}
		if (text === "" || LABEL_ONLY_RE.test(text)) continue;
		return clipToPoints(text, MAX_SUMMARY_TEXT_CHARS);
	}
	return "";
}
