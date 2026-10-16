/**
 * Thinking Window Extension (the filename stays thinking-collapse.ts)
 *
 * Renders the assistant's thinking block as **one continuously horizontally-scrolling
 * line** instead of a wall of reasoning text.
 * Pure display layer: the session / model-context text is completely unchanged.
 *
 * The shape is always:
 *
 *     Think: …newest tokens keep appending at the tail
 *
 * The design intent is "one unbroken token stream":
 *   - **no segmentation, no line breaks**: every newline inside the thinking (the model's
 *     own wraps, blank-line paragraph breaks, list items, inside code fences) is joined
 *     into this same line — when one paragraph ends, the next continues right where it
 *     ended, **never on a new line**. So the Think area scrolls one line from start to
 *     finish; no "restarting at a new line" motion is ever visible.
 *   - **at paragraph joints (blank lines in the source), CJK ↔ CJK gets a comma** so two
 *     paragraphs do not fuse into what reads like one sentence (`first,second`); when the
 *     previous paragraph already ends with punctuation nothing is added, and English /
 *     mixed text still follows the space rule.
 *     Wrap joints (no blank line) get no comma — or every model wrap would add one.
 *   - Over the terminal width, overflow chars drop **from the head** and a `…` goes at
 *     the line start; the tail is always the newest token. When it fits, everything
 *     shows — no `…`.
 *   - A `Think: ` label leads the line (flush-left, no vertical gutter), pinned at the
 *     front.
 *
 * There is deliberately **no** "short paragraph backfills to fill the row" logic: one
 * used to exist (when the last segment ran short, the squeezed-out beginning was pulled
 * back to fill the line, gated by `isStreaming` to only backfill once settled), but it
 * kept changing the row's composition and broke the "tokens keep flowing" feel — removed
 * entirely. Now a short thinking is short: trailing blank, no backfill.
 *
 * The label wraps `\x1b[23m` (italic off) + `\x1b[3m` (italic on) around itself — normal
 * label glyphs while the body keeps pi's italic + thinkingText color for thinking
 * blocks (the pair is omitted when the terminal lacks ANSI).
 *
 * Deliberately **no** `… (123 tokens hidden)` hint line anymore: the bottom spinner
 * already counts tokens.
 *
 * ## Hard no-wrap rule (this extension's core constraint)
 *
 * The emitted line must be **exactly one row** — pi must never re-wrap it: thinking
 * content is not read closely, so tidy format beats complete content, and dropping chars
 * (with `…`) beats a wrap. The full implementation and rationale for all-line joining,
 * head truncation, backtick pairing, and the exit fallback clip live in
 * `./thinking-collapse/window.ts` (that module **imports no pi / pi-tui**, width fn
 * injected — `node --test` runs it directly).
 *
 * Widths are measured with pi-tui's `visibleWidth` (the same implementation pi's own
 * renderers use), so the line this extension pre-trims is never wrapped twice by pi.
 *
 * **Deliberately no command registered**: the window has exactly this one form — no
 * state to toggle, no switch; `/thinking-collapse off | on | <n>` existed once and was
 * removed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { buildThinkingWindow } from "./thinking-collapse/window.ts";

/** When the terminal clearly lacks ANSI, do not embed control codes — `\x1b[23m` would print literally. */
function ansiCapable(): boolean {
	return process.env.TERM !== "dumb" && !process.env.NO_COLOR;
}

export default function (pi: ExtensionAPI) {
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant-thinking") return markdown;
		return buildThinkingWindow(markdown, context.availableWidth, visibleWidth, ansiCapable());
	});
}
