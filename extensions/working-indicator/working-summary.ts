/**
 * working-summary.ts — pure-text flattening + pure layout logic for the right-aligned "prompt
 * summary" on the spinner line.
 *
 * `working-indicator.ts` appends a summary of the current turn's prompt to the right of the
 * spinner text (`Working (23s)` / `Tools Calling (…)`) — the **whole prompt flattened into one
 * line**, then its leading characters plus `…` — like:
 *
 *      ⠧ Working (23s)                        ✦ /init I want to optimize…
 *
 * This file imports no pi / pi-tui modules — width computation goes through the injected
 * `widthOf` (the caller passes pi-tui's `visibleWidth`, the same implementation the renderer
 * uses, so measured widths strictly match what pi wraps on; tests feed a trivial ASCII=1 /
 * CJK=2 fake). So `node --test` runs it directly:
 *
 *     node --test clients/pi/extensions/working-indicator/working-summary.test.ts
 *
 * ## Flattening (`flattenPrompt`)
 *
 * A multi-line prompt should display as **one normal sentence**, not just its first line — the
 * first line is often only a few characters ("help me look", "fix this"); all the information
 * is in later lines. Rules:
 *
 *   - Newlines, indents, tabs, and space runs all collapse: leading/trailing whitespace is
 *     stripped (the indent vanishes) and within a line **runs of ≥2 spaces collapse to 1**, a
 *     single space preserved (the space between words is meaningful). Deliberately not the
 *     literal "more than two collapses" implementation — that would turn 3 spaces into 1 but
 *     keep 2 as 2, non-monotonic: longer runs end up narrower.
 *   - The line-join separator is decided by **both sides' characters** (`joinSeparator`), aiming
 *     to read like the original sentence:
 *       both sides wide chars (CJK) → no space (a Chinese line break has no space to begin with)
 *       either side CJK punct      → no space (CJK commas/periods/brackets etc. — no space on either side)
 *       line ends in open bracket/quote → no space (`call(` + `)` → `call()`)
 *       line starts with close bracket/closing punct → no space (`summary` + `.ts` → `summary.ts`, the path stays unbroken)
 *       everything else (incl. after ASCII commas, mixed CJK/Latin) → one space (`hello,` + `world` → `hello, world`)
 *   - All kinds of "invisible dirt" normalized: `\r\n` / `\r` / `\u2028` / `\u2029` / `\u0085` /
 *     `\v` / `\f` all count as line breaks; NBSP / ideographic space / `\u2000-\u200a` Unicode
 *     spaces count as ordinary spaces; zero-width chars (`\u200b` / `\ufeff` / bidi marks) are
 *     deleted — they take no display space but poison the width math and skew the right
 *     alignment; ANSI escape sequences (which come along when pasting from a terminal) are
 *     stripped wholesale, or truncation may cut mid-sequence and render mojibake; the rest of
 *     the control chars are deleted.
 *   - Markdown layout noise stripped: code-fence marker lines (` ```ts ` — **the code body
 *     inside the fence is kept**), horizontal rules (`---` / `***` / `___`), blockquote marks
 *     `> `, heading marks `## `, list marks `- ` / `* ` / `+ ` / `1. `. Flattened to one line
 *     they are just junk characters.
 *   - Blank lines (including runs between paragraphs) produce no extra space; a prompt that
 *     starts with a blank line still summarizes normally (the old implementation took the first
 *     line and judged this case "no summary" outright).
 *   - Only the first `MAX_PROMPT_SCAN_CHARS` characters are scanned: a summary shows at most
 *     half a screen, so more scanning is wasted work, and this function runs on every `input`
 *     event (a prompt can be a tens-of-KB paste). If the cut lands mid surrogate pair, the
 *     orphaned high surrogate is dropped.
 *
 * Two things deliberately **not** done (both would mangle normal content): "un-hyphenating"
 * line-end dashes (`opti-` + `mization` → `optimization`) — indistinguishable from a line that
 * really ends in `-`; and seamless joining of URLs across lines — detection unreliable, normal
 * spacing rules apply.
 *
 * ## Layout (`layoutPromptSummary`)
 *
 * Given the left segment's visible width, the whole line's visible-width budget, and the
 * flattened prompt, compute the summary text (truncated to visible width, `…` appended when
 * needed) and the space count between the left segment and the summary, so the summary lands
 * **exactly right-aligned to the row end**.
 *
 * Why right-alignment is computed by "counting spaces" rather than left to the renderer: pi's
 * working message goes through the `Text` component's word-wrap (`wrapTextWithAnsi`), which
 * only emits a verbatim single line when **whole-line visible width ≤ wrap width** (in-line
 * spaces preserved); once overlong it wraps at a space to the second row and `trimEnd`s trailing
 * spaces. So the total width here is made **exactly** fill the budget: no wrap, and the summary
 * reaches the right edge. The `totalWidth` the caller passes must already exclude the columns
 * the spinner and the Text's horizontal padding occupy (see `SPINNER_AND_PADDING_COLUMNS` in
 * working-indicator.ts).
 *
 * Truncation rule: applied to the **whole flattened prompt** (not the first line). If it fits,
 * it shows in full (no ellipsis); if not, the longest fitting prefix plus one `…`. The `…`
 * always counts (measured by `widthOf`); when the cut lands inside a wide char (CJK = 2
 * columns), the rule is one column short rather than over — the spared column folds into the
 * gap automatically and the summary still right-aligns. There is also a separate
 * **whole-segment width cap** (`maxWidth`, the caller passes half the terminal width): no
 * matter how much room is left on the line, the summary segment (`✦ ` + text) never exceeds it
 * — otherwise on a wide terminal a long prompt squeezes the status text on the left half down
 * to a few columns; the headroom the cap frees likewise folds into the gap, right-alignment
 * unchanged.
 *
 * The available width itself (`availableSummaryTextWidth`) is public: `summary-request.ts`
 * needs the same number when asking the model for a summary — first compute "how many columns
 * this cell fits", then decide whether a request is worth it and how long the model should
 * write. Render and request share one width math, so the target length the model receives never
 * mismatches what can actually display.
 */

/** Visible-width function: same semantics as pi-tui's `visibleWidth` (strips ANSI, wide chars count 2 columns). */
export type WidthFn = (text: string) => number;

/** The marker glyph before the summary. Its visible width is measured at runtime with `widthOf` — never assumed to be 1 column. */
export const SUMMARY_MARKER = "✦";

/** Minimum gap (columns) between the left segment and the summary. Right-alignment pushes the summary to the row end naturally; this is only the floor on narrow terminals. */
export const DEFAULT_MIN_GAP = 1;

/** The summary body (excluding the `✦ ` prefix) must be at least this wide to be worth showing, or the whole summary is omitted. */
export const MIN_SUMMARY_TEXT_WIDTH = 4;

/**
 * How many raw characters (UTF-16 units) flattening scans at most. A summary displays at most
 * half a screen (a few hundred columns); the scan cap is only a backstop for "tens-of-KB
 * pastes", keeping the per-`input`-event computation cheap.
 */
export const MAX_PROMPT_SCAN_CHARS = 4000;

/** The ellipsis appended when truncating. */
const ELLIPSIS = "…";

/* eslint-disable no-control-regex -- the regexes below must match control characters / escape sequences themselves */

/** ANSI / VT escape sequences: CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), and two-char escapes. */
const ANSI_RE =
	/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Zero-width / invisible format chars: invisible on screen but would poison the width math. */
const ZERO_WIDTH_RE = /[\u200b\u200c\u200d\u200e\u200f\u2060\u2061-\u2064\ufeff]/g;

/** Unicode whitespace (excluding ASCII space and tab): all normalized to a plain space. */
const UNICODE_SPACE_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

/** Every char treated as a line break: LF / CR / CRLF / NEL / VT / FF / line separator / paragraph separator. */
const LINE_BREAK_RE = /\r\n|[\n\r\u0085\u000b\u000c\u2028\u2029]/g;

/** Remaining in-line control chars (line breaks and tabs handled in an earlier step). */
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/* eslint-enable no-control-regex */

/** Code-fence marker line (` ``` ` / `~~~`, optional language tag): the line itself is dropped; fenced body kept. */
const FENCE_LINE_RE = /^(?:`{3,}|~{3,})[^\s`~]*$/;
/** Horizontal rule (`---` / `***` / `___`, optional spaces): the whole line is dropped. */
const RULE_LINE_RE = /^(?:[-*_]\s*){3,}$/;
/** Blockquote marker `> ` (nests as `> > `). */
const BLOCKQUOTE_RE = /^(?:>\s?)+/;
/** ATX heading marker `# ` … `###### `. */
const HEADING_RE = /^#{1,6}\s+/;
/** List markers: `- ` / `* ` / `+ ` / `• ` and `1. ` / `2) ` (whitespace required after the marker, to avoid mangling `-1` / `**bold**`). */
const LIST_BULLET_RE = /^(?:[-*+•·]\s+|\d{1,3}[.)]\s+)/;

/** In-line runs of ≥2 spaces collapse to 1 (single space preserved). */
const SPACE_RUN_RE = / {2,}/g;

/**
 * Wide chars (2 terminal columns): CJK ideographs, kana, hangul, fullwidth forms, etc.
 * Pairs with `joinSeparator`'s "both sides wide → no space" — the rule only needs to cover
 * "CJK body text", not match wcwidth tables cell-for-cell (a few cells' difference only
 * changes whether one space is added).
 */
function isWideChar(ch: string): boolean {
	const c = ch.codePointAt(0) ?? 0;
	return (
		(c >= 0x1100 && c <= 0x115f) ||
		(c >= 0x2e80 && c <= 0xa4cf) || // includes CJK punctuation 0x3000-0x303f
		(c >= 0xac00 && c <= 0xd7a3) ||
		(c >= 0xf900 && c <= 0xfaff) ||
		(c >= 0xfe30 && c <= 0xfe6f) ||
		(c >= 0xff00 && c <= 0xff60) || // fullwidth forms (incl. fullwidth punctuation)
		(c >= 0xffe0 && c <= 0xffe6)
	);
}

/**
 * CJK punctuation (ideographic comma/period, brackets, book-title marks, ellipsis — and their fullwidth/halfwidth forms): takes no
 * space on either side.
 * Within the fullwidth block, letters and digits must be excluded (fullwidth `ABC123` is text, not
 * punctuation).
 */
function isCjkPunct(ch: string): boolean {
	const c = ch.codePointAt(0) ?? 0;
	if (c >= 0x3000 && c <= 0x303f) return true; // CJK symbols and punctuation
	if (c >= 0xfe30 && c <= 0xfe6f) return true; // vertical/small forms
	if (c >= 0xff61 && c <= 0xff65) return true; // halfwidth katakana punctuation
	if (c < 0xff01 || c > 0xff60) return false; // the fullwidth-forms block
	const digit = c >= 0xff10 && c <= 0xff19;
	const upper = c >= 0xff21 && c <= 0xff3a;
	const lower = c >= 0xff41 && c <= 0xff5a;
	return !digit && !upper && !lower;
}

/** Line-end chars that suppress the join space: open brackets / open quotes / backtick / dashes & ellipsis family. */
const NO_SPACE_AFTER = new Set(["(", "[", "{", "<", "\"", "'", "`", "…", "—", "–", "·", "$"]);
/**
 * Line-start chars that suppress the join space: close brackets / closing punctuation / quotes /
 * path & extension separators.
 * Deliberately **excludes** `-` and `_` — lines starting with those are more likely `--verbose`-style
 * args or plain body text; joining without a space would glue them into the previous word.
 */
const NO_SPACE_BEFORE = new Set([
	")",
	"]",
	"}",
	">",
	",",
	".",
	";",
	":",
	"!",
	"?",
	"%",
	"\"",
	"'",
	"`",
	"…",
]);

/**
 * What to put at the seam of two lines. The goal is reading like the original sentence: no
 * space at a Chinese line break, one space between English words, and punctuation follows its
 * own typesetting habits (a space after an ASCII comma, none before a close bracket).
 */
function joinSeparator(prevEnd: string, nextStart: string): string {
	if (prevEnd === "" || nextStart === "") return "";
	if (isCjkPunct(prevEnd) || isCjkPunct(nextStart)) return "";
	if (isWideChar(prevEnd) && isWideChar(nextStart)) return "";
	if (NO_SPACE_AFTER.has(prevEnd)) return "";
	if (NO_SPACE_BEFORE.has(nextStart)) return "";
	return " ";
}

/** The last code point of a string (never half a surrogate pair). */
function lastChar(text: string): string {
	if (text === "") return "";
	const last = text.charCodeAt(text.length - 1);
	if (last >= 0xdc00 && last <= 0xdfff && text.length >= 2) {
		return text.slice(-2);
	}
	return text.slice(-1);
}

/** The first code point of a string. */
function firstChar(text: string): string {
	if (text === "") return "";
	const first = text.charCodeAt(0);
	if (first >= 0xd800 && first <= 0xdbff && text.length >= 2) {
		return text.slice(0, 2);
	}
	return text.slice(0, 1);
}

/**
 * Strip one line of Markdown layout noise. Returns null when the whole line should be dropped
 * (fence marker / rule). Order: drop-or-keep first, then strip blockquote → heading → list
 * markers in turn (combined forms like `> - item` come clean too).
 */
function stripLineChrome(line: string): string | null {
	if (FENCE_LINE_RE.test(line) || RULE_LINE_RE.test(line)) return null;
	return line
		.replace(BLOCKQUOTE_RE, "")
		.replace(HEADING_RE, "")
		.replace(LIST_BULLET_RE, "")
		.trim();
}

/**
 * Flatten a whole prompt into one compact line (rules in the file header). An empty prompt, or
 * one made entirely of whitespace and layout noise, returns "" — the caller treats that as "no
 * summary".
 */
export function flattenPrompt(prompt: string, maxScanChars: number = MAX_PROMPT_SCAN_CHARS): string {
	if (prompt === "") return "";
	let src = maxScanChars > 0 && prompt.length > maxScanChars ? prompt.slice(0, maxScanChars) : prompt;
	// the scan cap may land mid surrogate pair: drop the orphaned high surrogate so code-point iteration never sees half a character.
	const tail = src.charCodeAt(src.length - 1);
	if (tail >= 0xd800 && tail <= 0xdbff) src = src.slice(0, -1);

	src = src.replace(ANSI_RE, "").replace(ZERO_WIDTH_RE, "").replace(UNICODE_SPACE_RE, " ");

	let out = "";
	for (const rawLine of src.split(LINE_BREAK_RE)) {
		// a tab counts as "one space" rather than being deleted outright: deleting `a\tb` would glue the words into `ab`.
		const cleaned = rawLine.replace(/\t/g, " ").replace(CONTROL_RE, "").trim();
		if (cleaned === "") continue; // blank / indent-only line: produces no extra space
		const content = stripLineChrome(cleaned);
		if (content === null || content === "") continue;
		out += joinSeparator(lastChar(out), firstChar(content)) + content;
	}
	return out.replace(SPACE_RUN_RE, " ").trim();
}

/** Grapheme splitting: use `Intl.Segmenter` when available (surrogate pairs / combining chars stay whole); fall back to code points. */
const graphemeSegmenter =
	typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: null;

function graphemes(text: string): string[] {
	if (graphemeSegmenter !== null) {
		return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
	}
	return [...text];
}

/**
 * Truncate text to the longest prefix whose visible width does not exceed `maxWidth` (advances
 * by grapheme, never half a character). Returns the text verbatim when it fits. `widthOf(prefix)`
 * is measured segment by segment rather than summing per-char widths, so combining/wide-char
 * boundary judgment matches the renderer's.
 */
export function fitToWidth(text: string, maxWidth: number, widthOf: WidthFn): string {
	if (maxWidth <= 0) return "";
	if (widthOf(text) <= maxWidth) return text;
	let out = "";
	for (const segment of graphemes(text)) {
		const next = out + segment;
		if (widthOf(next) > maxWidth) break;
		out = next;
	}
	return out;
}

export interface PromptSummaryLayout {
	/** The truncated summary body (may carry a trailing `…`), without the `✦ ` prefix. */
	summaryText: string;
	/** Spaces to add between the left segment and `✦` (≥ minGap, making the row fill totalWidth exactly). */
	gap: number;
}

export interface SummaryTextWidthOptions {
	/** The left segment's (spinner text's) visible width (ANSI colors do not count). */
	leftWidth: number;
	/** The whole working message's visible-width budget (already net of spinner and padding columns). */
	totalWidth: number;
	/** The visible-width function (the caller passes pi-tui's visibleWidth). */
	widthOf: WidthFn;
	/** The summary marker glyph, default `✦`. */
	marker?: string;
	/** Minimum gap between the left segment and the summary, default 1 column. */
	minGap?: number;
	/**
 * Visible-width cap for the summary segment (`marker` + space + body); unbounded by default
 * (constrained only by totalWidth).
 */
	maxWidth?: number;
}

export interface PromptSummaryOptions extends SummaryTextWidthOptions {
	/** The flattened prompt (see `flattenPrompt`); an empty string returns null directly. */
	promptText: string;
	/** Minimum usable width for the summary body — below it the whole summary is omitted, default 4 columns. */
	minTextWidth?: number;
}

/**
 * Visible columns available to the summary body (excluding the `✦ ` prefix): budget − left
 * segment − min gap − marker prefix, further capped by `maxWidth` (the whole-segment cap). A
 * return ≤ 0 means this cell cannot hold a summary.
 *
 * Both the render (`layoutPromptSummary`) and "should we ask the model to summarize / how long"
 * (`summary-request.ts`) build on it, and the two must produce the same number — otherwise a
 * summary written for 40 columns lands in a 20-column slot.
 */
export function availableSummaryTextWidth(opts: SummaryTextWidthOptions): number {
	const marker = opts.marker ?? SUMMARY_MARKER;
	const minGap = opts.minGap ?? DEFAULT_MIN_GAP;
	const markerWidth = opts.widthOf(`${marker} `);
	let avail = opts.totalWidth - opts.leftWidth - minGap - markerWidth;
	if (opts.maxWidth !== undefined) {
		avail = Math.min(avail, opts.maxWidth - markerWidth);
	}
	return avail;
}

/**
 * Compute the right-aligned layout. Returns null when it does not fit (left segment too wide /
 * terminal too narrow / empty prompt); the caller should show only the left segment.
 *
 * Invariants (always hold when non-null; unit tests assert each):
 *   leftWidth + gap + widthOf(marker + " ") + widthOf(summaryText) === totalWidth
 *   gap ≥ minGap
 */
export function layoutPromptSummary(opts: PromptSummaryOptions): PromptSummaryLayout | null {
	const marker = opts.marker ?? SUMMARY_MARKER;
	const minGap = opts.minGap ?? DEFAULT_MIN_GAP;
	const minTextWidth = opts.minTextWidth ?? MIN_SUMMARY_TEXT_WIDTH;
	const text = opts.promptText;
	if (text === "") return null;

	const widthOf = opts.widthOf;
	const markerWidth = widthOf(`${marker} `); // the layout only needs its width (available width is computed by the helper)
	// all headroom (unused columns) folds into the gap: with a short summary it pushes the summary to the row end (right-align);
	// with a truncated summary it lands exactly at (or slightly above) minGap.
	const avail = availableSummaryTextWidth(opts);
	if (avail < minTextWidth) return null;

	let summaryText: string;
	if (widthOf(text) <= avail) {
		// the whole thing fits: show it in full, no ellipsis (user requirement: short prompts fully right-aligned).
		summaryText = text;
	} else {
		// does not fit: leave room for the ellipsis then truncate; trim end-of-line spaces after the cut, avoiding "abc …".
		const budget = avail - widthOf(ELLIPSIS);
		summaryText = `${fitToWidth(text, budget, widthOf).trimEnd()}${ELLIPSIS}`;
	}

	// the gap eats all headroom: with a short summary it pushes the summary to the row end (right-align),
	// with a truncated summary it lands exactly at (or slightly above) minGap.
	const gap = opts.totalWidth - opts.leftWidth - markerWidth - widthOf(summaryText);
	if (gap < minGap) return null; // defense: unreachable in theory (avail already guarantees it)
	return { summaryText, gap };
}
