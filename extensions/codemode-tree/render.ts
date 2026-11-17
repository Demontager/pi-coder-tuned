/**
 * codemode-tree — pure logic: reflow the **line arrays** produced by pi's built-in codemode
 * renderers into a tree.
 *
 * This module imports neither pi nor pi-tui, so `node --test` runs it directly (the same
 * approach as `fenceless-code-block/render.ts` and `user-message-bar/bar.ts`). Coloring uses
 * only the injected `theme.fg`.
 *
 * ## Target shape (user's decision, 2026-10-01; isomorphic to the tree in
 * `bash-command-collapse.ts`)
 *
 * ```
 * • codemode
 *   │ const PI_PKG = "…";
 *   │ const cmds = [
 *   │ … (8 more lines, ctrl+o to expand)
 *   │
 *   └ ✓ bash {"command":"grep -n …"} 158ms
 *     ✓ bash {"command":"grep -rn …"} 382ms
 *
 *     $ grep -n "can explain its own features"
 *     … (36 more lines, ctrl+o to expand)
 * ```
 *
 * Three dot states (user's decision, 2026-10-01): white while executing (`text`) / green on
 * success (`toolDiffAdded`, same color as bash) / red on failure (`toolDiffRemoved`) — see
 * `stateDotSlot`.
 *
 * ## Columns (pinned by measurement; must align column-for-column with the bash / read blocks)
 *
 * | Element | Column | Occupied by |
 * | --- | --- | --- |
 * | dot `•` | 0 | left margin (`MARGIN_WIDTH` = 2) |
 * | `codemode` / `│` / `└` | 2 | after the left margin |
 * | text after `│ ` `└ ` | 4 | the gutter takes 2 more columns |
 *
 * So **all child content renders at `width - 4`** (`CONTENT_OFFSET`) — the command side too,
 * even though it carries only 2 columns of indent while "no result yet" (those two columns are
 * deliberately left empty): budget for the widest prefix so the wrap width does not jump the
 * moment the result arrives (the bash side hit the same "premature wrap / wrap jump", see its
 * file header).
 *
 * ## Why "post-process line arrays" instead of "parse the result ourselves"
 *
 * The nested-call list in the result (`✓ bash {…} 158ms`), the cost summary line, the output
 * preview, and the truncation hints are all drawn by the built-in renderers, and
 * `getTextOutput` is not exported from the package root — parsing `result.content` ourselves
 * would replicate the built-in logic and silently drift as pi upgrades. So the entry
 * (`index.ts`) **delegates once** to the built-in's two renderers to get the rendered lines,
 * then reflows them with this module: we own the shape; the line contents always follow pi.
 */

/** The dot column: `• ` = 1 char + 1 space = 2 columns. */
export const MARGIN_WIDTH = 2;
/** Columns taken by the structure glyph: `│ ` / `└ ` = 1 box-drawing char + 1 space = 2 columns. */
export const GUTTER_WIDTH = 2;
/** Columns to subtract for child content: left margin + structure glyph (glyph at column 2, text at column 4). */
export const CONTENT_OFFSET = MARGIN_WIDTH + GUTTER_WIDTH;

/** Whitespace before the structure glyph (left margin): two spaces. `│` / `└` therefore land at column 2. */
export const GUTTER_LEAD = " ".repeat(MARGIN_WIDTH);
/** The text column after `│ ` / `└ `: 4 spaces (the same column as the bash block). */
export const BODY_INDENT = " ".repeat(CONTENT_OFFSET);
/** Indent of command continuation lines while "no result yet": two spaces (aligned with the `c` of `codemode`). */
export const LOOSE_INDENT = " ".repeat(MARGIN_WIDTH);

/** How wide the child component (the blob pi's built-in renderer produces) should render. */
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
 * Which color slot the dot should use (user's decision, 2026-10-01) — three states:
 *
 *   - executing (`isPartial`) → `text` (the normal foreground / white; explicitly requested
 *     by the user, **unlike bash's `dim`**)
 *   - finished successfully → `toolDiffAdded` (the diff-added green, **same color as the bash
 *     success dot**)
 *   - finished with failure (script `isError`) → `toolDiffRemoved` (the diff-removed red)
 *
 * The middle green slot is `toolDiffAdded` and **not** `success`: the bash / read green dots
 * both use `toolDiffAdded`; taking `success` would differ from them in some skins (invisible
 * while the two happen to share a value, exposed the moment the skin changes).
 *
 * The verdict reads `context.isError` (pi does not pass an `isError` field when calling the
 * resultRenderer; it is only present in getRenderContext — reading `result.isError` always
 * yields undefined).
 */
export function stateDotSlot(isPartial: boolean, isError: boolean): "text" | "toolDiffAdded" | "toolDiffRemoved" {
	if (isPartial) return "text";
	return isError ? "toolDiffRemoved" : "toolDiffAdded";
}

/**
 * Truncation hint lines — every "N more entries hidden, press ctrl+o to expand" spelling used
 * by the built-in renderers must be recognized here.
 *
 * Both ellipses must match: `...` is pi `truncateToWidth`'s spelling; `…` is pi's preview
 * component's own.
 *
 * The noun comes in **two** kinds, both seen in practice (missing one would hang `└ ` wrongly
 * on a hint line — spotted by the user in a big example, 2026-10-01):
 *   - `lines` — the code preview (`… (N more lines, …)`, `expandHint(theme, n, "lines")`) and
 *     the output preview (`... (N earlier lines, …)`, the bash side has the same)
 *   - `calls` — the collapse hint of the **nested-call list** (`... (N earlier calls, …)`,
 *     appears only in codemode)
 *
 * So the skeleton is "`(digits [word] <lines|calls>`" — the middle word cell is optional
 * (`(2 earlier calls)` / `(5 lines)` have both occurred); it must not hard-code
 * `earlier`/`more`. It is a **structural hint line**: it should carry `│ ` rather than eat
 * the `└ `.
 */
export function isExpandHintLine(line: string): boolean {
	return /^\s*(?:\.\.\.|…)\s*\(\d+\s+(?:\S+\s+)?(?:lines?|calls?)\b/.test(stripSgr(line));
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
 * Result side: draw the result's whole line array as a tree — the **first substantial content
 * line** carries `└ `, the lines **above** it (separator blanks, truncation hints) carry
 * `│ `, and every line **below** it takes the four-space indent (the tree lands there).
 *
 * Same rule set as the bash side's `prefixTreeLines`; four points you must not take for
 * granted:
 *
 *   ① **`└ ` appears exactly once per block**: the caller must first stitch all children's
 *      lines into one array before handing them to this function (the built-in renderer
 *      splits the nested-call list and the `Text("\n" + output)` into two children); drawing
 *      one tree per child would grow two corner glyphs.
 *   ② **hint lines carry `│ ` instead of eating `└ `**: `… (35 lines, ctrl+o to expand)` marks
 *      "more below"; `└ ` must be reserved for the first real content line, otherwise the
 *      whole block is hints and no content is visible.
 *   ③ **blank lines above `└ ` get `│ `, below get nothing**: the blank above is the separator
 *      drawn by the built-in renderer's `Spacer(1)` (the one cell between command and result;
 *      in the user's sample it is a lone `│`); left completely empty it would break the tree;
 *      the blank below is already after the tree lands, and drawing a bar there would look
 *      like the tree continues.
 *   ④ **the leading blank line also carries `│ `**: the first line of `inner.render()` is that
 *      `Spacer(1)` blank — it is **the start of the result section**, not the whole block's
 *      upper boundary (that boundary is drawn by pi's self shell; see the notes in
 *      `index.ts`).
 *
 * When there are only hint lines and no substantial content (no script output and no nested
 * calls), the hint lines are kept with `│ ` — dropping the block would throw away the only
 * clue that "there is content to expand".
 */
export function shapeResultLines(lines: string[], theme: { fg: (color: string, text: string) => string }): string[] {
	if (lines.length === 0) return [];

	// The first substantial content line (skipping blanks and hint lines)
	let start = 0;
	while (start < lines.length && (isBlankLine(lines[start]!) || isExpandHintLine(lines[start]!))) start++;

	const pipe = `${GUTTER_LEAD}${theme.fg("muted", "│ ")}`;
	const corner = `${GUTTER_LEAD}${theme.fg("muted", "└ ")}`;

	// Only hint lines, no substantial content: keep the stretch with `│ `, do not drop content.
	// But when there is **not even one hint line** (all-blank input), return an empty array —
	// pi's `updateDisplay()` sets `hideComponent` based on "neither renderer produced
	// anything"; returning a lone empty `│` here would make the block waste a line.
	if (start >= lines.length) {
		if (!lines.some(isExpandHintLine)) return [];
		return lines.map((line) => (isBlankLine(line) ? pipe : `${pipe}${line}`));
	}

	return lines.map((line, index) => {
		if (index === start) return `${corner}${line}`;
		if (index < start) return isBlankLine(line) ? pipe : `${pipe}${line}`;
		return isBlankLine(line) ? "" : `${BODY_INDENT}${line}`;
	});
}
