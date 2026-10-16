/**
 * window.ts — the pure logic of thinking's single-line continuously-scrolling window.
 *
 * Extracted from `thinking-collapse.ts` (that file imports pi everywhere — `node --test`
 * cannot import it): this module **imports no pi / pi-tui**; the visible-width function
 * `widthOf` is injected by the caller (pi-tui's `visibleWidth` at runtime — the same
 * implementation the renderers use, so measured widths match pi's actual wrapping
 * exactly), and `node --test` runs it directly:
 *
 * node --test clients/pi/extensions/thinking-collapse/window.test.ts
 *
 * The directory **shares thinking-collapse.ts's name and has no index.ts**: pi's
 * extension loader only accepts `extensions/<name>.ts` and `extensions/<name>/index.ts`
 * (`loader.js`'s `discoverExtensionsInDir` → `resolveExtensionEntries` skips a directory
 * with no entry) — so it is never loaded as an extension (same approach as `tool-diff/`).
 *
 * ## The display form: one unbroken scrolling line
 *
 * The whole thinking block **always renders as one row**; every token scrolls
 * continuously inside it:
 *
 * Think: …newest tokens keep appending at the tail
 *
 * - **no segmentation, no line breaks**: every newline inside the thinking (the model's
 * own wraps, blank-line paragraph breaks, between list items, inside code fences) is
 * joined into this **same** row — when one paragraph ends the next continues right
 * where it ended, never on a new line. So the Think area shows "one unbroken token
 * stream", not line-by-line refreshes.
 * - A `Think: ` label leads the row (7 columns, from column 0) — it belongs to the
 * "block head", always pinned at the front.
 * - What a joint gets depends on the characters on both sides (see `joinSeparator`),
 * and **two joint types are distinguished**:
 * - **wrap joints** (the model's own line wraps, between list items): nothing between
 * CJK, one space between English words;
 * - **paragraph joints** (blank lines in the source): CJK ↔ CJK additionally gets a
 * **comma** `` — or two paragraphs fuse into what reads like one sentence
 * (`end of first,start of second`). When the previous paragraph already ends with
 * punctuation (etc.) nothing is added; English / mixed still follows the
 * space rule.
 * - Over budget, overflow chars drop **from the head** and a `…` leads the row: as the
 * content keeps growing, earlier chars keep being pushed out of the viewport and the
 * tail is always the newest token. Fits → everything shows, no `…`.
 *
 * There is deliberately **no** "short paragraph backfills to fill the row" logic: one
 * used to exist (a short last segment pulled the squeezed-out beginning back to fill),
 * but it kept changing the row's composition mid-stream and broke the "tokens keep
 * flowing" feel — removed. Now a short thinking is short: trailing blank, no backfill.
 *
 * ## Hard no-wrap rule (this extension's core constraint — do not remove)
 *
 * The emitted line must be **exactly one row**: thinking is not read closely — tidy
 * format beats complete content — so dropping chars beats letting pi re-wrap. And pi
 * feeds this extension's return through marked once more, so the only construct that can
 * **merge** two visual rows into one over-wide line is an inline code span: marked's
 * codespan tokenizer turns newlines inside a code span **into spaces**
 * (`rules.inline.code` + `newLineCharGlobal`; measured `` `a\nb` `` → text `"a b"`),
 * the merged over-wide line then gets wrapped by pi at contentWidth — the wrap
 * continuation carries no label and looks like a row appearing out of nowhere — that is
 * the "wrap" seen on screen. So the backticks in the output line must **pair among
 * themselves**: `stripUnpairedBackticks` follows marked's own rule (`findCodeSpanEnd`)
 * and deletes unpaired backtick runs. Head truncation can cut a code span in half and
 * leave a stray closing backtick run — the same bug.
 * The exit also has a hard-clip fallback (`truncateTail`) — no output is over-wide under
 * any circumstances.
 */

/** The visible-width function: same semantics as pi-tui's `visibleWidth` (strips ANSI, wide chars count 2). */
export type WidthFn = (text: string) => number;

/** The first-row label: `Think: ` (7 columns, starting at column 0). */
export const HEADER_LABEL = "Think: ";

/** The ellipsis (1 column): leads a head-truncated row, marking the squeezed-out content to its left. */
export const ELLIPSIS = "…";

/** Italic off / on. The label wants normal glyphs while the body stays italic — a pair of SGRs around the label. */
export const ITALIC_OFF = "\u001b[23m";
export const ITALIC_ON = "\u001b[3m";

/** The content budget's floor (columns). On a terminal too narrow for the label, at least a `…` still fits. */
const MIN_CONTENT_WIDTH = 1;

/**
 * The punctuation a paragraph joint (a blank line in the source) adds between CJK ↔ CJK:
 * a comma.
 *
 * A comma, not a period: thinking paragraphs mostly "keep thinking" rather than "finish
 * a statement" — a period would cut the tone too hard.
 * Only **paragraph** joints get it; wrap joints keep the original rule (nothing between
 * CJK) — or every model wrap would add a comma.
 */
export const PARAGRAPH_JOIN_PUNCT = "，";

/** The fallback width (columns) when no sane available width exists. */
const DEFAULT_WIDTH = 80;

/** Every char treated as a line break: LF / CR / CRLF / NEL / VT / FF / line / paragraph separators. */
const LINE_BREAK_RE = /\r\n|[\n\r\u0085\u000b\u000c\u2028\u2029]/;

/** Runs of ≥2 spaces inside a line fold to 1 (a single space survives: the space between words means something). */
const SPACE_RUN_RE = / {2,}/g;

/** pi turns tabs into 3 spaces before markdown parsing; normalizing the same way here keeps widths honest. */
export function normalizeTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Wide characters (2 terminal columns): CJK ideographs, kana, hangul, fullwidth forms,
 * etc.
 * Pairs with `joinSeparator`'s "wide on both sides → no space" — the rule only needs to
 * cover "CJK prose" and does not have to match wcwidth cell for cell (a few cells off
 * only affects whether one space gets added).
 */
function isWideChar(ch: string): boolean {
	const c = ch.codePointAt(0) ?? 0;
	return (
		(c >= 0x1100 && c <= 0x115f) ||
		(c >= 0x2e80 && c <= 0xa4cf) || // incl. CJK symbols & punctuation 0x3000-0x303f
		(c >= 0xac00 && c <= 0xd7a3) ||
		(c >= 0xf900 && c <= 0xfaff) ||
		(c >= 0xfe30 && c <= 0xfe6f) ||
		(c >= 0xff00 && c <= 0xff60) || // fullwidth forms (incl. fullwidth punctuation)
		(c >= 0xffe0 && c <= 0xffe6)
	);
}

/**
 * CJK punctuation (… and full/halfwidth forms): no space eaten on
 * either side.
 * Inside the fullwidth block, letters and digits must be excluded (`` is
 * prose, not punctuation).
 */
function isCjkPunct(ch: string): boolean {
	const c = ch.codePointAt(0) ?? 0;
	if (c >= 0x3000 && c <= 0x303f) return true; // CJK symbols & punctuation
	if (c >= 0xfe30 && c <= 0xfe6f) return true; // vertical/small forms
	if (c >= 0xff61 && c <= 0xff65) return true; // halfwidth katakana punctuation 
	if (c < 0xff01 || c > 0xff60) return false; // the fullwidth forms block
	const digit = c >= 0xff10 && c <= 0xff19;
	const upper = c >= 0xff21 && c <= 0xff3a;
	const lower = c >= 0xff41 && c <= 0xff5a;
	return !digit && !upper && !lower;
}

/** No space after these at a line end: opening brackets / quotes / backtick / dash-ellipsis family. */
const NO_SPACE_AFTER = new Set(["(", "[", "{", "<", '"', "'", "`", "…", "—", "–", "·", "$"]);

/**
 * No space before these at a line start: closing brackets / closing punctuation / quotes
 * / path & extension separators.
 * Deliberately **excludes** `-` and `_` — a line starting with them is more likely a
 * `--verbose` flag or ordinary prose, and skipping the space would glue it to the
 * previous word.
 */
const NO_SPACE_BEFORE = new Set([")", "]", "}", ">", ",", ".", ";", ":", "!", "?", "%", '"', "'", "`", "…"]);

/** The last code point of a string (never splits a surrogate pair). */
function lastCodePoint(text: string): string {
	if (text === "") return "";
	const end = text.length;
	const start = prevCodePointStart(text, end);
	return text.slice(start, end);
}

/** The first code point of a string. */
function firstCodePoint(text: string): string {
	if (text === "") return "";
	const first = text.charCodeAt(0);
	if (first >= 0xd800 && first <= 0xdbff && text.length >= 2) return text.slice(0, 2);
	return text.slice(0, 1);
}

/** Step back one code point from `end`, returning its start index (a surrogate pair steps whole). */
function prevCodePointStart(text: string, end: number): number {
	if (end <= 1) return 0;
	const low = text.charCodeAt(end - 1);
	if (low >= 0xdc00 && low <= 0xdfff && end >= 2) {
		const high = text.charCodeAt(end - 2);
		if (high >= 0xd800 && high <= 0xdbff) return end - 2;
	}
	return end - 1;
}

/**
 * What to put where two lines join. The goal is reading like the original sentence: no
 * space at CJK wrap joints, one space between English words, and punctuation follows its
 * own typography (a space after an ASCII comma, none before a closing bracket).
 *
 * `paragraphBreak = true` marks a **paragraph joint** (a blank line in the source), not a
 * wrap joint: CJK ↔ CJK then gets a comma, visually separating "two paragraphs" (or they
 * fuse into what reads like one sentence). When the previous paragraph already ends
 * with punctuation (etc., or an ASCII closer) nothing is added — that punctuation
 * already breaks the paragraphs.
 */
function joinSeparator(prevEnd: string, nextStart: string, paragraphBreak = false): string {
	if (prevEnd === "" || nextStart === "") return "";
	if (isCjkPunct(prevEnd) || isCjkPunct(nextStart)) return "";
	if (paragraphBreak && isWideChar(prevEnd) && isWideChar(nextStart)) return PARAGRAPH_JOIN_PUNCT;
	if (isWideChar(prevEnd) && isWideChar(nextStart)) return "";
	if (NO_SPACE_AFTER.has(prevEnd)) return "";
	if (NO_SPACE_BEFORE.has(nextStart)) return "";
	return " ";
}

/**
 * Join **all source lines** of a thinking into one continuous row (indent dropped,
 * space-runs folded, each joint filled per the chars on both sides and whether it is a
 * paragraph joint). Blank lines (paragraph splits) produce no newline — they only mark
 * the next join as a paragraph joint — so a paragraph's end continues straight into the
 * next paragraph's start, with a comma between CJK. This is the joining layer of "one
 * unbroken token stream".
 * The input is the raw `body.split(LINE_BREAK_RE)` result (**incl.** the empty entries —
 * they are the paragraph markers).
 */
export function joinAllLines(lines: readonly string[]): string {
	let out = "";
	let paragraphBreak = false;
	for (const line of lines) {
		const collapsed = line.trim().replace(SPACE_RUN_RE, " ");
		if (collapsed === "") {
			// a blank line = a paragraph split. Only meaningful once content exists (leading blanks produce no joint).
			if (out !== "") paragraphBreak = true;
			continue;
		}
		if (out === "") {
			out = collapsed;
			continue;
		}
		out += joinSeparator(lastCodePoint(out), firstCodePoint(collapsed), paragraphBreak) + collapsed;
		paragraphBreak = false;
	}
	return out;
}

/**
 * Find the end (exclusive) of the inline code span starting at `start`; -1 when it never
 * pairs.
 *
 * The rule mirrors marked's codespan tokenizer (`/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/`):
 * opener and closer must have equal backtick counts, the closer must not be followed by
 * another backtick, and the content's first char must not be a backtick.
 * Only by matching marked's own judgment does "paired on my side" equal "a code span in
 * marked's eyes" — deleting stray backticks then produces no cross-row code span.
 */
export function findCodeSpanEnd(text: string, start: number): number {
	let openerLength = 0;
	while (text[start + openerLength] === "`") openerLength++;
	const contentStart = start + openerLength;
	let i = contentStart;
	while (i < text.length) {
		if (text[i] !== "`") {
			i++;
			continue;
		}
		let closerLength = 0;
		while (text[i + closerLength] === "`") closerLength++;
		// the content's last char can never be a backtick (we only stop at backticks) — only the first needs checking.
		const content = text.slice(contentStart, i);
		if (closerLength === openerLength && text[i + closerLength] !== "`" && content[0] !== "`") {
			return i + closerLength;
		}
		i += closerLength;
	}
	return -1;
}

/**
 * Delete unpaired backticks (each whole run together); paired code spans stay verbatim.
 *
 * Why they must go: marked pairs code spans over the **whole markdown** — a stray
 * backtick in one output row pairs with one in another row into a cross-row code span,
 * whose internal newlines become spaces, merging the two rows into one over-wide line
 * that pi then wraps (the continuation carrying no label).
 * marked renders a stray backtick as a literal anyway — deleting it only turns
 * "displayed as a bare backtick" into "not displayed", and the row's content was
 * already head-truncated, so the cost is negligible.
 */
export function stripUnpairedBackticks(text: string): string {
	if (!text.includes("`")) return text;
	let out = "";
	let changed = false;
	let i = 0;
	while (i < text.length) {
		if (text[i] === "`") {
			const end = findCodeSpanEnd(text, i);
			if (end > i) {
				out += text.slice(i, end);
				i = end;
				continue;
			}
			let run = i;
			while (text[run] === "`") run++;
			i = run;
			changed = true;
			continue;
		}
		out += text[i];
		i++;
	}
	return changed ? out : text;
}

/**
 * Truncate **from the head** to maxWidth columns: keep the tail, replace dropped chars
 * with one `…`.
 *
 * Measures backwards by **code point** (never splits a surrogate pair); zero-width chars
 * (combining / ZW*) cost no budget and ride along with the char before them.
 * A wide char straddling the boundary is dropped whole — one column under beats over.
 */
export function clipToTail(text: string, maxWidth: number, widthOf: WidthFn, ellipsis = ELLIPSIS): string {
	if (maxWidth <= 0) return "";
	if (widthOf(text) <= maxWidth) return text;
	const budget = maxWidth - widthOf(ellipsis);
	if (budget <= 0) return "";
	let used = 0;
	let i = text.length;
	while (i > 0) {
		const start = prevCodePointStart(text, i);
		const width = widthOf(text.slice(start, i));
		if (width > 0 && used + width > budget) break;
		used += width;
		i = start;
	}
	return ellipsis + text.slice(i);
}

/**
 * Truncate **from the tail** to maxWidth columns (keep the head; the clipped part
 * becomes one `…`). The exit fallback clip.
 *
 * When the cut lands exactly on whitespace, that whitespace goes too: the space in
 * `the …` is just half-cut whitespace carrying no information — dropping it may leave
 * the row 1 column short of budget (invisible to the eye).
 */
export function truncateTail(text: string, maxWidth: number, widthOf: WidthFn, ellipsis = ELLIPSIS): string {
	if (maxWidth <= 0) return "";
	if (widthOf(text) <= maxWidth) return text;
	const budget = maxWidth - widthOf(ellipsis);
	if (budget <= 0) return "";
	let out = "";
	let used = 0;
	for (const ch of text) {
		const width = widthOf(ch);
		if (used + width > budget) break;
		out += ch;
		used += width;
	}
	return out.replace(/\s+$/, "") + ellipsis;
}

/**
 * Compress a thinking body into **one continuously scrolling row**. Exported for direct
 * test calls.
 *
 * @param markdown        the thinking block's raw text (pi joins multiple blocks with `\n\n`)
 * @param availableWidth  the content width pi gives transform (Markdown's 1-col padding on each side already deducted)
 * @param widthOf         the visible-width function (pi-tui's `visibleWidth` at runtime)
 * @param ansi            whether to embed the italic off/on control codes
 */
export function buildThinkingWindow(
	markdown: string,
	availableWidth: number,
	widthOf: WidthFn,
	ansi = true,
): string {
	const body = normalizeTabs(markdown).trim();
	if (body === "") return markdown;

	// all source lines (incl. blank-line paragraph splits) join into one row: a paragraph's end continues straight into the next's start — no newlines.
	const line = joinAllLines(body.split(LINE_BREAK_RE));
	if (line === "") return markdown;

	const width = Math.max(8, Math.floor(availableWidth) || DEFAULT_WIDTH);

	const italicOff = ansi ? ITALIC_OFF : "";
	const italicOn = ansi ? ITALIC_ON : "";
	// too narrow for "label + `…` + ≥1 column of body" → drop the label: the body matters more than the marker,
	// otherwise the label (7 columns) eats the whole row and nothing is left.
	const useLabel = width >= widthOf(HEADER_LABEL) + widthOf(ELLIPSIS) + MIN_CONTENT_WIDTH;
	const label = useLabel ? HEADER_LABEL : "";
	const budget = Math.max(MIN_CONTENT_WIDTH, width - widthOf(label));

	// head-truncation scrolling: show all when it fits; drop overflow from the head and lead with `…` — the tail is always the newest token.
	let content = stripUnpairedBackticks(clipToTail(line, budget, widthOf));
	// fallback: the output row must never exceed the width under any circumstance (clip the tail if it does).
	if (widthOf(label) + widthOf(content) > width) {
		content = truncateTail(content, width - widthOf(label), widthOf);
	}
	content = stripUnpairedBackticks(content);

	// the label wants normal glyphs (pi's italic off, then back on); with no label the body keeps the italic.
	return label === "" ? content : italicOff + label + italicOn + content;
}
