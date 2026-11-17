/**
 * web-search-tree — pure logic: reflow the **line arrays** produced by pi-web-access's
 * `pi_web_search` renderer into the same tree as `bash-command-collapse.ts` / `codemode-tree/`.
 *
 * This module imports neither pi nor pi-tui, so `node --test` runs it directly (the same
 * approach as `codemode-tree/render.ts` and `fenceless-code-block/render.ts`). Coloring uses
 * only the injected `theme.fg`.
 *
 * ## Target shape (user's decision, 2026-10-02)
 *
 * ```
 * • search 3 queries
 *   │ "wechat-local-mcp wechat re-sign codesign local database key principle"
 *   │ "macOS WeChat local database decrypt re-sign app get-task-allow
 *   │  extract SQLCipher key from memory"
 *   │ "PyWxDump macOS wechat database key obtain needed re-sign reason"
 *   │ 3/3 queries, 18 sources
 *   │ Providers used: Query 1: exa; Query 2: exa; Query 3: exa
 *   │
 *   └ ... (4 more lines, 6 total, ctrl+o to expand)
 * ```
 *
 * ## One deliberate difference from the bash / codemode blocks: `└ ` hangs on the LAST line
 *
 * The bash / codemode rule is "`└ ` hangs on the first substantial content line; the tree
 * lands there". That rule does not fit this tool, because a search block's **last line**
 * (`... (N more lines, M total, ctrl+o to expand)`) is the **only** doorway to the full
 * result — the sources / summaries live behind ctrl+o. Hanging `└ ` on the first line with
 * the hint line trailing behind it, indented, reads as "the tree ended; the rest is a tail";
 * in the user's sample, `└ ` sits right on the hint line.
 *
 * So this tool's rule is **last line carries `└ `, every line above carries `│ `** — the tree
 * stretches all the way down to the "there is more to expand" line, isomorphic to the
 * `background-tasks` body tree (`│` on all but the last line, `└` on the last). In collapsed
 * mode the last line is necessarily the ctrl+o hint; in expanded mode it is the last body
 * line. Both hold.
 *
 * ## What this extension actually changes (measured comparison, 2026-10-02)
 *
 * ```
 * package original (bg fill, blank lines above/below, no tree):   after takeover:
 *   blank line                                       ── self shell: no blank lines
 *   search 3 queries                                • search 3 queries
 *     "…first long query…"                           │   "…first long query…"
 *     "…second query wrapped…"                       │   "…second query wrapped…"
 * from memory                                        │ key from memory
 *                                                     │
 *  ... (12 more lines, 16 total, ctrl+o …)           └ ... (12 more lines, 16 total, ctrl+o …)
 *   blank line
 * ```
 *
 * Four things: ① no background fill and no boundary blank lines; ② the dot as the outcome
 * lamp (green / red); ③ tree structure glyphs; ④ **wrapped continuation lines also hang on
 * `│ `** (the package original attaches no prefix at the render layer, so continuations fall
 * to column 0 — the `from memory` line in the comparison output).
 *
 * **Query-value truncation is NOT something this extension fixes**: the package original
 * does **not** truncate query values either in `renderCall` (the three-dimensional query
 * names) or in the collapsed preview; those two `slice(0, 37)` / `slice(0, 52)` sites live in
 * the **streaming `currentQuery` line** and the **expanded curated list**. I first mistook the
 * former for "query names truncated to 40 columns" — wrong, and only the side-by-side
 * experiment made it clear. So the README must not say "this extension fixed truncation".
 */

/** The dot column: `• ` = 1 char + 1 space = 2 columns. */
export const MARGIN_WIDTH = 2;
/** Columns taken by the structure glyph: `│ ` / `└ ` = 1 box-drawing char + 1 space = 2 columns. */
export const GUTTER_WIDTH = 2;
/** Columns to subtract for child content: left margin + structure glyph (glyph at column 2, text at column 4). */
export const CONTENT_OFFSET = MARGIN_WIDTH + GUTTER_WIDTH;

/** Whitespace before the structure glyph (left margin): two spaces. `│` / `└` therefore land at column 2. */
export const GUTTER_LEAD = " ".repeat(MARGIN_WIDTH);
/** The text column after `│ ` / `└ `: 4 spaces (the same column as the bash / codemode blocks). */
export const BODY_INDENT = " ".repeat(CONTENT_OFFSET);
/** Indent of command continuation lines while "no result yet": two spaces (aligned with the `s` of `search`). */
export const LOOSE_INDENT = " ".repeat(MARGIN_WIDTH);

/** How wide the child component (the blob the package renderer produces) should render. */
export function contentWidth(totalWidth: number): number {
	return Math.max(1, totalWidth - CONTENT_OFFSET);
}

/** Strip SGR escape sequences — a line may contain nothing but color codes. */
function stripSgr(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Whether this (styled) line is blank. */
export function isBlankLine(line: string): boolean {
	return stripSgr(line).trim() === "";
}

/**
 * Which color slot the dot should use — three states, the same semantics as `codemode-tree`
 * and the bash side:
 *
 *   - executing (`isPartial`) → `dim` (grey) — consistent with bash / read (codemode uses
 *     `text` white, specially approved by the user on 2026-10-01; the search block was not
 *     granted that cell, so it follows the bash convention)
 *   - finished successfully → `toolDiffAdded` (the diff-added green, **the same color as the
 *     bash success dot**)
 *   - finished with failure → `toolDiffRemoved` (the diff-removed red)
 *
 * The verdict reads `context.isError` (pi does not pass an `isError` field when calling the
 * resultRenderer; it is only present in `getRenderContext` — reading `result.isError` always
 * yields undefined; the bash side stepped in this pit).
 */
export function stateDotSlot(isPartial: boolean, isError: boolean): "dim" | "toolDiffAdded" | "toolDiffRemoved" {
	if (isPartial) return "dim";
	return isError ? "toolDiffRemoved" : "toolDiffAdded";
}

/**
 * Whether this block failed — the **or** of three signals, because the package renderer
 * leaves different traces on different failure paths:
 *
 *   ① `context.isError`: pi's authoritative signal (tool threw / returned `isError: true`);
 *   ② an `Error:` / `Error：` line in the body: `pi_web_search` has several paths that
 *      **return normally** with `{ content: [{ text: "Error: …" }], details: { error } }`
 *      (instead of throwing); pi does not flag those as isError;
 *   ③ a non-empty `details.error`: the structured trace of the same shape — it is the first
 *      branch of `renderResult`.
 *
 * Using only ① leaves the ②③ paths showing a green dot (the user explicitly required on
 * 2026-10-02: "not successful means red"); using only ② misses the throwing paths. With the
 * or of all three, body lines starting with `Error:` are additionally dyed red by
 * `colorizeErrorLines`, corroborating the red dot.
 */
export function isFailureResult(isError: boolean, lines: string[], details: unknown): boolean {
	if (isError) return true;
	const d = details as { error?: unknown } | undefined;
	if (d && typeof d.error === "string" && d.error.trim() !== "") return true;
	return lines.some((line) => /^\s*Error[:：]/.test(stripSgr(line)));
}

/**
 * Dye `Error:` lines in the body red (`toolDiffRemoved`). The package renderer already colors
 * some branches with `error`; this only patches the ones it leaves alone (plain `Error: …`
 * text lines) — already-colored lines are detected via `stripSgr` and re-colored, because two
 * kinds of red (`error` / `toolDiffRemoved`) coexisting in one block looks garish; unify on
 * this extension's failure red.
 */
export function colorizeErrorLines(
	lines: string[],
	theme: { fg: (color: string, text: string) => string },
): string[] {
	return lines.map((line) => (/^\s*Error[:：]/.test(stripSgr(line)) ? theme.fg("toolDiffRemoved", stripSgr(line)) : line));
}

/**
 * Command side: attach tree prefixes to every line — first line `• ` (the dot is pre-colored
 * by the caller), the rest choose `│ ` (result arrived, the tree is connected) or a two-space
 * indent (still running, matching the bash "executing" look) per `connected`.
 *
 * Blank lines stay blank: padding blanks with spaces erases the "this line is empty"
 * information, and the outer blank check would have to strip ANSI and trim first.
 */
export function withCallGutter(lines: string[], dotAnsi: string, pipe: string, connected: boolean): string[] {
	const continuation = connected ? `${GUTTER_LEAD}${pipe}` : LOOSE_INDENT;
	return lines.map((line, index) => {
		if (index === 0) return `${dotAnsi} ${line}`;
		return line === "" ? "" : `${continuation}${line}`;
	});
}

/**
 * Result side: last line `└ `, other non-blank lines `│ ` (see "`└ ` hangs on the last line"
 * in the file header).
 *
 * Three points you must not take for granted:
 *
 *   ① **`└ ` is decided here only, rendering the whole block once**: the caller must stitch
 *      all children's lines into one array first (the package renderer splits the status line
 *      and the hint line into two children); drawing one tree per child would grow two corner
 *      glyphs.
 *   ② **when the last line is blank, search backwards**: expanded-mode bodies can end with a
 *      blank line (the package renderer's `lines.push("")`); hanging `└ ` on a blank line is
 *      wasted — and if no non-blank line exists at all, return an empty array.
 *   ③ **blank lines above `└ ` get `│ `, blank lines below are returned as-is**: the same
 *      rule as the bash side's `prefixTreeLines` (there, the original words were "blank lines
 *      above the fence also carry `│ `"). In the user's sample there is exactly one line
 *      holding **only `│`** between `Providers used: …` and `└ ... (4 more lines…)` — that is
 *      drawn here: it was a blank line, and once prefixed it became that vertical bar. Without
 *      the prefix, a blank line looks like the tree broke; drawing bars after `└ ` would look
 *      like the tree continues (the same trade-off on the bash side, reported by the user on
 *      2026-09-21).
 */
export function shapeResultLines(
	lines: string[],
	theme: { fg: (color: string, text: string) => string },
): string[] {
	if (lines.length === 0) return [];

	// Search backwards for the last non-blank line — that is where `└ ` lands.
	let last = lines.length - 1;
	while (last >= 0 && isBlankLine(lines[last]!)) last--;
	if (last < 0) return [];

	const pipe = `${GUTTER_LEAD}${theme.fg("muted", "│ ")}`;
	const corner = `${GUTTER_LEAD}${theme.fg("muted", "└ ")}`;

	return lines.map((line, index) => {
		if (index === last) return `${corner}${line}`;
		// Above `└ ` (not landed yet) → even blank lines get the bar; below, there is no
		// content anymore, return as-is.
		if (index > last) return line;
		if (isBlankLine(line)) return pipe;
		return `${pipe}${line}`;
	});
}

/**
 * In a failed block, swap the package's `success` green for failure red.
 *
 * The package's status line (`3/3 queries, 18 sources`) is painted **unconditionally** with
 * `theme.fg("success", …)` — it does not know this run failed. So a failed block shows the
 * self-contradictory "red dot + green status line" (measured: on the throwing path the status
 * line reads the green `undefined/undefined queries, 0 sources`, with the red dot right above
 * it). The user's 2026-10-02 rule is "not successful means red", so on failure the `success`
 * foreground in that stretch is swapped for this extension's failure red.
 *
 * What gets swapped is the **whole color span**: `theme.fg("success", x)` produces
 * `ESC[…m x ESC[39m` — the leading set-code must change, but the trailing reset `ESC[39m` is
 * shared with other spans (over-replacing would truncate the `muted` / `accent` after it).
 * So replace only **within that span**: after finding the `success` sequence, swap its
 * **opening code** up to the next `ESC[39m`. Measured shape:
 * `ESC[38;2;181;189;104m text ESC[39m` — one opening code per span; a direct swap suffices.
 *
 * `theme.getFgAnsi` yields exactly the sequence pi itself would emit (matches in both
 * truecolor and 256-color modes); when the two hues are identical (a skin sets `success` and
 * `toolDiffRemoved` to the same value) the line is returned untouched — the same approach as
 * `recolorToolPath` in `read-path-collapse.ts`.
 */
export function recolorSuccessToFailure(
	lines: string[],
	theme: { getFgAnsi?: (color: string) => string | undefined; fg: (color: string, text: string) => string },
): string[] {
	const success = theme.getFgAnsi?.("success");
	const failure = theme.getFgAnsi?.("toolDiffRemoved");
	if (!success || !failure || success === failure) return lines;
	// The trailing reset is shared with other spans and must not be swapped — swap only the
	// opening set-code at the start of the span.
	const reset = "\u001b[39m";
	return lines.map((line) => {
		if (!line.includes(success)) return line;
		let out = "";
		let index = 0;
		while (true) {
			const at = line.indexOf(success, index);
			if (at === -1) {
				out += line.slice(index);
				break;
			}
			const end = line.indexOf(reset, at);
			if (end === -1) {
				// no reset: the whole rest of the line is this color; swap all of it safely.
				out += line.slice(index, at) + failure + line.slice(at + success.length);
				break;
			}
			out += line.slice(index, at) + failure + line.slice(at + success.length, end);
			index = end;
		}
		return out;
	});
}

/**
 * Drop **trailing** blank lines. The package renderer ends expanded mode with
 * `lines.push("")` (at the tail of the summary and curated sections); those blank lines are
 * precisely the "blank line below" the user wanted gone on 2026-10-02. Collapsed mode is
 * unaffected — that block ends with the hint line, which is non-blank, so the trailing trim
 * never touches it.
 *
 * **Leading/inner blank lines are kept**: the package renderer splits `"\n... more lines"`
 * into a blank line + hint line, and the `│` between `Providers used: …` and `└ ...` in the
 * user's sample is exactly this blank line with its prefix (see `shapeResultLines`).
 * Deleting it would no longer be the shape the user asked for.
 */
export function trimTrailingBlanks(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && isBlankLine(lines[end - 1]!)) end--;
	return end === lines.length ? lines : lines.slice(0, end);
}
