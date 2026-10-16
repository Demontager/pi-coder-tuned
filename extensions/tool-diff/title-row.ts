/**
 * title-row.ts — the pure layout logic of the `Edit` / `Write` title row
 * (`Edit <path> (+3 -5)`).
 * The tool name comes from the caller (`titleRow(theme, "Edit", …)`); this module knows
 * no tools, only widths.
 *
 * Two reasons it was extracted from `tool-diff.ts`:
 *
 *   1. **Testability**. This is pure string layout (budget split + width truncation) but
 *      sat inside a 1300-line `tool-diff.ts` that imports pi everywhere — `node --test`
 *      could not even import it. Extracted, this module **imports no pi / pi-tui**: the
 *      width function `widthOf`, the truncator `truncateToWidth`, home dir, and indent all
 *      inject via `deps` (same approach as `working-summary.ts`) — a fake ASCII=1 / CJK=2
 *      measure function exercises every branch.
 *   2. **The "long path jittering with the blink" scene lives right here**. The path
 *      budget = available width − tool name − tail, and while streaming the tail is the
 *      blinking `●` — lit / unlit take 2 and 0 columns, so the budget changed every 500ms
 *      and the truncation window slid 2 columns each way: "the filename blinked by
 *      itself". The fix is in `blinkSuffix` (a same-width off-state placeholder).
 *
 * The module sits in `extensions/tool-diff/` — a **same-named directory** (`tool-diff.ts`
 * and `tool-diff/` coexist): the directory has no `index.ts`, and pi's loader only accepts
 * `extensions/<name>.ts` and `extensions/<name>/index.ts` (loader.js's
 * `discoverExtensionsInDir` → `resolveExtensionEntries` skips a directory with no entry)
 * — so it is never loaded as an extension.
 */

/** The ellipsis for head truncation. 1 column wide. */
export const ELLIPSIS = "…";
/** The streaming marker char. 1 column (`visibleWidth("●") === 1`, verified). */
export const BLINK_MARKER = "●";

/** The theme subset the render needs (`Theme.fg`'s method signature is **bivariant** — a real `Theme` assigns directly). */
export interface TitleTheme {
	fg(color: string, text: string): string;
}

/** The title-row tail `(+N -M)` line counts. */
export interface TitleStats {
	added: number;
	removed: number;
}

/**
 * The layout dependencies (all injected — that is why this module imports no pi / pi-tui).
 *
 * `widthOf` / `truncateToWidth` get pi-tui's `visibleWidth` / `truncateToWidth` at runtime
 * (the same implementations the renderers use — measured widths match pi's actual
 * wrapping exactly); `home` gets `os.homedir()`; `indent` gets the caller's title indent.
 */
export interface TitleRowDeps {
	/** Visible width (ANSI escapes ignored, CJK counts 2 columns) */
	widthOf(text: string): number;
	/** Truncate **from the tail** to a visible width (ANSI-safe); the overflow becomes one ellipsis */
	truncateToWidth(text: string, width: number, ellipsis: string): string;
	/** The home directory (`""` = no `~` shortening) */
	home?: string;
	/** The title indent, default one space */
	indent?: string;
}

/**
 * The blink marker's colored tail. **The off state returns a same-width space, never an
 * empty string.**
 *
 * Why no empty string: `TitleRow`'s path budget = available width − tool name − tail
 * (separator space + marker); a tail that swings between "lit = 2 cols / unlit = 0 cols"
 * is **a budget jumping 2 columns every 500ms**. With a short path it is invisible; with a
 * path long enough to truncate, the truncation window slides with it — measured: every
 * blink cycle the path's front half (the part after `…`) and the filename's position both
 * shift 2 columns — "the marker blinks and the filename blinks too".
 * With a space placeholder both states are the same width, the path is constant, and only
 * the marker itself flickers.
 */
export function blinkSuffix(theme: TitleTheme, on: boolean): string {
	return theme.fg("dim", on ? BLINK_MARKER : " ");
}

/**
 * How counts display: above ten thousand collapse to `k` (`10043` → `10k`, `11133` →
 * `11.1k`).
 *
 * The tail `(+N -M)` is the part of this row **that must not be truncated**, but two
 * five-digit counts side by side eat 13+ columns — columns a narrow terminal should give
 * the path. At `k` it takes at most 5-6 columns and the path's budget stays stable
 * (bigger writes skew further; display only — no counting rule changes).
 * Below ten thousand the count shows verbatim — `+1043` is both more precise and shorter
 * than `+1.0k`.
 */
export function formatCount(count: number): string {
	if (!Number.isFinite(count) || count < 10_000) return String(count);
	const thousands = count / 1000;
	if (thousands < 100) {
		const rounded = Math.round(thousands * 10) / 10;
		return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
	}
	return `${Math.round(thousands)}k`;
}

/**
 * The title-row tail `(+3 -5)`: additions green, removals red (reusing the diff's
 * `toolDiffAdded` / `toolDiffRemoved` — same colors as the card's +/- rows), parens stay
 * dim. A zero side is omitted; both zero (no changes / uncomputable) returns "" —
 * empty parens look worse than none.
 */
export function statsSuffix(theme: TitleTheme, stats: TitleStats | undefined): string {
	if (stats === undefined) return "";
	const parts: string[] = [];
	if (stats.added > 0) parts.push(theme.fg("toolDiffAdded", `+${formatCount(stats.added)}`));
	if (stats.removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${formatCount(stats.removed)}`));
	if (parts.length === 0) return "";
	return `${theme.fg("dim", "(")}${parts.join(" ")}${theme.fg("dim", ")")}`;
}

/** Shorten a home-dir prefix to `~`, matching the built-in tool-title convention */
export function shortenPath(path: string, home: string): string {
	if (home === "" || !path.startsWith(home)) return path;
	const rest = path.slice(home.length);
	// only shorten at a boundary: `~` itself or `~/...` — `/Users/bachir/...` must not become `~r/...`
	if (rest === "" || rest.startsWith("/")) return `~${rest}`;
	return path;
}

/**
 * Truncate **from the head** to a column width: keep the tail, replace the dropped chars
 * with a single `…`.
 * Walks by **code point** (not UTF-16 units), so surrogate pairs never split in half;
 * width measured per char via `widthOf`, so CJK / emoji at 2 columns are counted right.
 */
export function truncateStartToWidth(
	text: string,
	maxWidth: number,
	widthOf: (text: string) => number,
	ellipsis = ELLIPSIS,
): string {
	if (maxWidth <= 0) return "";
	if (widthOf(text) <= maxWidth) return text;
	const budget = maxWidth - widthOf(ellipsis);
	if (budget <= 0) return ellipsis;
	const chars = Array.from(text);
	let used = 0;
	let start = chars.length;
	for (let i = chars.length - 1; i >= 0; i -= 1) {
		const charWidth = widthOf(chars[i] ?? "");
		if (used + charWidth > budget) break;
		used += charWidth;
		start = i;
	}
	return ellipsis + chars.slice(start).join("");
}

/**
 * The title-row component. A `Text` would wrap a long path into two or three rows (tool
 * name / path / counts on separate lines) — so it lays out by width into **always one
 * row**.
 *
 * Layout priority: the tool name and the tail (`(+N -M)` / blinking `●`) **always show
 * whole**; the path takes the leftover width and truncates from the head on overflow. The
 * tail carries the row's information — truncating it is meaningless; only when not even a
 * single path char fits do we fall back to whole-row tail truncation (keeping at least
 * the tool name).
 */
export class TitleRow {
	// fields declared explicitly and assigned in the constructor — **no parameter properties** (`constructor(private readonly x)`):
	// Node's type stripping does not support them (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), and this module must import under
	// `node --test`.
	private readonly deps: TitleRowDeps;
	private readonly theme: TitleTheme;
	/** The already-colored tool name */
	private readonly tool: string;
	/** The plain-text path (uncolored) — truncated by width first, colored after; ANSI text would be measured as visible chars */
	private readonly path: string;
	/** The already-colored tail */
	private readonly suffix: string;

	constructor(deps: TitleRowDeps, theme: TitleTheme, tool: string, path: string, suffix: string) {
		this.deps = deps;
		this.theme = theme;
		this.tool = tool;
		this.path = path;
		this.suffix = suffix;
	}

	render(width: number): string[] {
		const { widthOf } = this.deps;
		const indent = this.deps.indent ?? " ";
		// the indent takes 1 column, so the body's budget shrinks by it — otherwise the row goes one over
		const available = Math.max(1, width - widthOf(indent));
		const path = this.path === "" ? "" : shortenPath(this.path, this.deps.home ?? "");
		const toolWidth = widthOf(this.tool);
		// the tail and the path each take one separator space
		const suffixWidth = this.suffix === "" ? 0 : 1 + widthOf(this.suffix);
		const pathBudget = available - toolWidth - suffixWidth - (path === "" ? 0 : 1);

		if (path === "" || pathBudget < 1) {
			const fallback = [this.tool, path === "" ? "" : this.theme.fg("text", path), this.suffix]
				.filter((part) => part !== "")
				.join(" ");
			return [indent + this.deps.truncateToWidth(fallback, available, ELLIPSIS)];
		}

		const shown = this.theme.fg("text", truncateStartToWidth(path, pathBudget, widthOf));
		const tail = this.suffix === "" ? "" : ` ${this.suffix}`;
		return [indent + `${this.tool} ${shown}${tail}`];
	}

	invalidate(): void {}
}
