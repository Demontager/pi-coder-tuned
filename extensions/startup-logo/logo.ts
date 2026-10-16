/**
 * logo.ts — the startup logo glyphs (static)
 *
 * The glyph is the π mark at the top of `curl -fsSL https://pi.dev/install.sh | sh`, taken
 * from `npm:pi-claude-code-tui@0.1.14` (which itself copies the install script). Upstream
 * animates it over 22 frames; this repo only wants a static logo, so here **only the settled
 * frame's shape is kept** — the frame table, stroke progression, and base flicker are all
 * dropped.
 *
 * The shape is a 4×4 boolean grid (one cell = three `█`, filled / blank), easier to read and
 * to test than upstream's "1-based coordinates + per-frame colors" table.
 *
 * **Deliberately patches a cell upstream missed**: upstream's settled frame (phase 6) grid is
 * `3,2 3,3 3,4 4,2 4,4 5,2 5,3 6,2 6,5`, while its earlier frames (phase 4/5 and the white
 * flash frame) all include `(5,5)`. Without that cell the right leg breaks into "one
 * dangling foot" — glaring in static display (it flashes by unnoticed in the animation), so
 * it is clearly a typo in upstream's table. Here we draw the shape with `(5,5)` present.
 *
 * This file imports neither pi nor pi-tui: colors are fetched live by `index.ts` via
 * `theme.fg("accent", …)`, so `/theme` reskinning follows along; it also lets
 * `node --test clients/pi/extensions/startup-logo/*.test.ts` run directly.
 */

/** One cell = three block characters. */
export const MARK_CELL = "███";

/** Space placeholder (same width as `MARK_CELL`, keeping every line's visible width equal so the sidebar aligns). */
export const MARK_BLANK = " ".repeat(MARK_CELL.length);

/**
 * Left margin of the mark: one space before each line.
 *
 * Flush against the terminal's left edge looks too cramped; indent one space uniformly.
 * That space counts toward `MARK_WIDTH`, so the sidebar column and the narrow-terminal
 * decision follow along — callers need not add anything.
 */
export const MARK_INDENT = " ";

/** The 4×4 boolean grid, 1 = filled. Row order top-to-bottom, column order left-to-right. */
const MARK_GRID: readonly (readonly (0 | 1)[])[] = [
	[1, 1, 1, 0],
	[1, 0, 1, 0],
	[1, 1, 0, 1],
	[1, 0, 0, 1],
];

/** The mark's height (rows). */
export const MARK_ROWS = MARK_GRID.length;

/** The mark's body width (columns) × characters per cell = 12. */
export const MARK_COLS = MARK_GRID[0]!.length;
export const MARK_GLYPH_WIDTH = MARK_COLS * MARK_CELL.length;

/** Visible width per line (including the left margin) = 13. */
export const MARK_WIDTH = MARK_INDENT.length + MARK_GLYPH_WIDTH;

/** Single-cell query (out of bounds treated as blank), for unit tests and debugging. */
export function markCellFilled(row: number, col: number): boolean {
	return MARK_GRID[row]?.[col] === 1;
}

/**
 * The painter for one mark row: receives "is this cell filled" and returns a string with
 * **visible width 3**.
 *
 * Deliberately per-cell rather than "hand the whole row to one paint": wrapping the whole
 * row in color would swallow the trailing placeholder spaces into the color block, so the
 * "every line's visible width == MARK_WIDTH" invariant would no longer hold for the colored
 * version (the sidebar column would skew).
 *
 * The default painter returns uncolored `███` / spaces, convenient for unit tests.
 */
export type MarkCellPainter = (filled: boolean) => string;

export function markLines(paintCell: MarkCellPainter = (filled) => (filled ? MARK_CELL : MARK_BLANK)): string[] {
	return MARK_GRID.map((row) => MARK_INDENT + row.map((filled) => paintCell(filled === 1)).join(""));
}

/**
 * Attach the sidebar text (already colored) to the right of the mark, **vertically
 * centered** (2 lines land on rows 1 and 2).
 *
 * Premise: the incoming lines **already have visible width `MARK_WIDTH`** (guaranteed by
 * `markLines`), so simply appending to the line end aligns; no padding by string length
 * here — with ANSI inside, padding by length always skews. The left margin (`MARK_INDENT`)
 * is already counted in `MARK_WIDTH`, so the sidebar column shifts right with it; nothing
 * extra is needed here.
 *
 * **Trailing placeholder spaces are not trimmed**: they are part of the "every line is
 * `MARK_WIDTH` columns" invariant. Upstream's whole-row coloring makes trimming moot anyway
 * (the line tail is an ANSI reset, not whitespace, so `trimEnd` silently becomes a no-op);
 * so we never trim, keeping behavior independent of how the caller colors. These spaces have
 * no background, are invisible in the terminal, and pi truncates by width anyway.
 */
export function attachSideText(lines: readonly string[], side: readonly string[], gap = 2): string[] {
	if (lines.length === 0) return [];
	const start = Math.max(0, Math.floor((lines.length - side.length) / 2));
	return lines.map((line, i) => {
		const text = side[i - start];
		return i >= start && text ? `${line}${" ".repeat(gap)}${text}` : line;
	});
}

export interface HeaderSections {
	/** The colored logo lines (with sidebar text). */
	logo: readonly string[];
	/** The colored shortcut hint line (compact version of the built-in header's line). */
	hints?: string;
	/** The colored onboarding line. */
	onboarding?: string;
}

/**
 * The full header line order: logo → blank → hints → blank → onboarding.
 * A missing section leaves no extra blank lines (on narrow-terminal fallback the logo section is empty).
 */
export function composeHeaderLines(sections: HeaderSections): string[] {
	const lines = [...sections.logo];
	if (sections.hints) {
		if (lines.length > 0) lines.push("");
		lines.push(sections.hints);
	}
	if (sections.onboarding) {
		if (lines.length > 0) lines.push("");
		lines.push(sections.onboarding);
	}
	return lines;
}

/** Shorten an absolute path: under the home directory display as `~/...`. */
export function shortenPath(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}
