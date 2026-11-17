/**
 * tool-diff — Claude Code-style diff rendering for the edit / write tools:
 * whole-line background (incl. the line-number gutter, see `layoutRows`) + number gutter +
 * inline highlight + syntax highlight.
 *
 * Why an extension is required — a theme cannot do this:
 *   pi's diff colors are only three **foreground** tokens (`toolDiffAdded` /
 *   `toolDiffRemoved` / `toolDiffContext`, see theme.d.ts's ThemeColor), and `Theme.bg()`
 *   only knows 7 ThemeBg entries (selectedBg / searchMatchBg / userMessageBg /
 *   customMessageBg / toolPendingBg / toolSuccessBg / toolErrorBg) — **none of them is a
 *   diff background**. So a theme can at most recolor +/- lines' foreground; it cannot make
 *   CC's "whole-line green / red background + a brighter inline background" look. Only the
 *   extension emitting ANSI itself can lay a background per row. The colors still **come
 *   from the skin**: custom keys in the skin's `colors` (`toolDiffAddedBg` /
 *   `toolDiffRemovedBg`) are parsed into the Theme all the same, and the extension reads
 *   them by key and swaps the foreground SGR for a background SGR — switching skins
 *   switches the backgrounds, see `DIFF_ADDED_BG_TOKEN`.
 *
 * Why `renderShell: "self"` is required:
 *   The default shell wraps the whole tool output in one Box and colors it **as a block** —
 *   tool-execution.js's `updateDisplay()` picks `toolPendingBg` / `toolErrorBg` /
 *   `toolSuccessBg` for bgFn by state. Per-row red backgrounds would land inside a green
 *   box — visual chaos. With `"self"` it goes through `selfRenderContainer` (the
 *   tool-execution.js:180 branch), a plain Container — `renderContainer instanceof Box` is
 *   false so bgFn is never applied, and the frame is entirely self-drawn.
 *   In self mode both renderCall and renderResult go into the same selfRenderContainer
 *   (in `updateDisplay()`), so the title row is not lost.
 *
 * Execution logic is fully delegated to the built-ins — only the rendering changes:
 *   `createEditTool(cwd)` / `createWriteTool(cwd)` are exported from the package root; the
 *   official example examples/extensions/built-in-tool-renderer.ts is this pattern.
 *   Renderers merge **per slot** (renderers/index.js `withBuiltInRenderers`:
 *   `renderCall: definition.renderCall ?? builtIn.renderCall`). Both tools **write their own
 *   renderCall** and leave only a one-line title: built-in edit's renderCall renders an
 *   args-based diff preview (`getEditCallRenderComponent`), built-in write's prints the whole
 *   `content` with syntax highlighting, and renderResult draws a card after execution — the
 *   same change would display twice. (An early version deliberately omitted edit's
 *   renderCall to inherit that streaming preview — it was removed precisely because of the
 *   duplication.)
 *   Registration spreads `{ ...originalTool }` rather than copying fields one by one:
 *   measured, edit carries `prepareArguments` (write does not), and neither has
 *   `promptSnippet` / `promptGuidelines` (both undefined — so the docs' "prompt metadata is
 *   not inherited" warning does not apply to these two). Spreading also keeps future fields
 *   like `executionMode` / `constrainedSampling` — hand-copying field names misses those
 *   first, and losing `executionMode` could make edits run concurrently and race files.
 *
 * The title row's streaming shape (sharing work with the bottom spinner):
 *   While streaming it is `Edit <path> ●` / `Write <path> ●` — the blinking `●` means
 *   "receiving the byte stream". The tool name is capitalized (`Edit` / `Write`) rather
 *   than pi's lowercase `edit` / `write`: this extension mimics Claude Code's look where
 *   tool titles are capitalized; the registered name is unaffected — display form only.
 *   Token counts do not scroll on the title row: the bottom spinner already counts the
 *   current segment's output (working-indicator/'s `↓ N tokens`) — counting twice is
 *   redundant.
 *   Once args complete, `●` disappears and the full form `<path> (+N -M)` returns (added
 *   green / removed red; a zero side is omitted).
 *   The line counts appear **only once, on the title row**: the result card's old
 *   `Added N lines, removed M lines` line was removed — the same change is not reported
 *   twice. The blink driver and its three stops are in `startBlink`.
 *   Rows whose result arrived but `argsComplete` is permanently false (interrupted rows,
 *   rows rendered from a restored history session) are recognized via `isPartial` — they
 *   neither blink nor draw the marker, or every history row would carry a static `●`; but
 *   they still count `+N -M` (their args are complete in the session log) or the history
 *   area would have no line counts at all.
 *
 * The title path truncates **from the head** (`title-row.ts`'s `truncateStartToWidth`):
 *   on overflow it keeps the path tail and folds the front into a `…`
 *   (`Edit …ions/rewind/checkpoints.ts (+3 -5)`) instead of clipping the tail together
 *   with `(+N -M)` — the filename and change size are what the row must convey; the leading
 *   directories mostly repeat cwd. The tail (`+N -M` / `●`) therefore stays fully visible:
 *   the tool name and tail are subtracted from the available width first, the path gets the
 *   rest.
 *
 *   The tail width must be **identical every frame** or the path jitters with it: the
 *   blink marker's off state uses a same-width space placeholder (it must not return an
 *   empty string — otherwise the budget jumps 2 columns every 500ms and the truncation
 *   window of a long path slides left and right, which reads as "the marker blinks and the
 *   filename blinks too" — measured live); five-digit counts inside `+N -M` collapse to
 *   `k` (`(+10043 -11133)` → `(+10k -11.1k)`) so two big numbers cannot eat the path.
 *   The layout itself lives in `tool-diff/title-row.ts` (pure logic, no pi imports,
 *   `node --test`-able); this file only wires up pi-tui's measure functions and the theme.
 *
 * Where `+N -M` comes from (at renderCall the tool has not run, so no result patch exists):
 *   edit sums `generateUnifiedPatch(oldText, newText)` per `edits` entry — the changes do
 *   not overlap, so the sum equals the whole-file patch's +/- count; write diffs the old
 *   content captured pre-execution against the new content the same way.
 *   The result caches into the row-level `state.stats` (`null` = computed but
 *   uncomputable) so no repaint re-runs the diff.
 *   pi has `computeEditsDiff(path, edits, cwd)` for authoritative numbers, but it is async
 *   while renderCall is a synchronous render entry that cannot wait — hence the sync
 *   per-edit summation.
 *
 * Zero new npm dependencies (consistent with the repo's other pi extensions, installed by
 * manual cp of a single file):
 *   - edit's diff data comes straight from pi's `EditToolDetails.patch` (a standard
 *     unified patch) — no structuredPatch needed.
 *   - write's `TDetails` is `undefined` (per `createWriteToolDefinition`'s signature), so
 *     no diff is available. Instead renderCall reads the old content (keyed by path,
 *     retried per frame — see `WriteState`) and diffs with the package-root-exported
 *     `generateUnifiedPatch(path, old, new)` — overwriting an existing file does not count
 *     the whole file as "added".
 *   - Syntax highlighting uses pi's own `highlightCode` / `getLanguageFromPath`, no
 *     @shikijs/cli. Measured: `highlightCode(code, lang)` returns the same line count as
 *     the input, and each line ends with `\x1b[39m` (not `\x1b[0m`) — critical for layering
 *     the background.
 *   - Inline diff implements its own LCS — no diff package.
 *
 * Two easy traps (both handled in code):
 *   1. **Character index != terminal columns**: the inline-highlight ranges are UTF-16
 *      character offsets from `computeWordRanges`, so the counter `injectBg` advances must
 *      count characters; but row width / wrapping / padding must use `visibleWidth()` in
 *      terminal columns (CJK = 2 columns). The two measures are used in different places —
 *      mixing them misaligns everything.
 *   2. **`\x1b[0m` clears the background too**: a full reset inside the syntax-highlighted
 *      string would cut the background. `injectBg` re-injects the current background after
 *      every `\x1b[0m`. Likewise foreground endings always use `\x1b[39m` (fg-only reset)
 *      rather than `\x1b[0m`, or the gutter's own reset would clear the row's background.
 *
 * Known tradeoffs (deliberate — do not "optimize" them away):
 *   - In 256color mode `getBgAnsi` / `getFgAnsi` return `48;5;N` / `38;5;N` — no RGB.
 *     The first version gave up the inline background there ("rather lose one emphasis
 *     layer than guess colors wrong"), but that tradeoff silently killed the whole feature
 *     on non-truecolor terminals with no signal to the user. It now goes through
 *     `deriveWordBg`'s 256-color branch — recovering RGB from the xterm palette (cube +
 *     gray ramp), blending, then quantizing back to the nearest palette entry, so inline
 *     backgrounds work in 256 colors too, just slightly coarser.
 *   - A wrapped row **skips inline highlighting**: the ranges are char offsets into the
 *     unwrapped text and do not line up on continuation rows.
 *   - Inline pairs are matched by similarity inside each block (longest common affix
 *     first, each row paired at most once), and abandoned above a 0.4 change ratio
 *     (CC Fallback.tsx's threshold) — on mass rewrites the whole-line background reads
 *     better than inline highlight.
 *   - LCS is O(n·m); long lines past the cap skip inline highlight outright.
 */

import type { EditToolDetails, ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	createEditTool,
	createWriteTool,
	generateUnifiedPatch,
	getLanguageFromPath,
	highlightCode,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
// The title row's layout (budget split / truncation / blink placeholder / count shrinking) lives in the sibling `tool-diff/` directory —
// a **pure module directory with no `index.ts`** (pi only loads `extensions/<name>.ts` and
// `extensions/<name>/index.ts`, so it is never picked up as an extension).
import { TitleRow, blinkSuffix, shortenPath, statsSuffix, type TitleRowDeps } from "./tool-diff/title-row.ts";

/** Max diff lines rendered in the collapsed state */
const PREVIEW_MAX_LINES = 60;
/**
 * Context lines kept around each change.
 *
 * pi's unified patches carry a fixed 4 context lines (`generateUnifiedPatch(path, old,
 * new, contextLines = 4)` — edit's `EditToolDetails.patch` is computed with the same
 * default). 4 rows is too much in narrow terminals, so everything narrows to 2 here —
 * see `collapseContextRuns`.
 */
const CONTEXT_LINES = 2;
/** Max diff lines rendered after ctrl+e expansion */
const EXPANDED_MAX_LINES = 150;
/** Above this size syntax highlighting is skipped (highlightCode has a cost) */
const MAX_HIGHLIGHT_CHARS = 32_000;
/** Max rows one line wraps into; beyond that a `›` truncation marker is used */
const MAX_WRAP_ROWS = 3;
/** Above this change ratio inline highlighting is abandoned (CC Fallback.tsx's threshold) */
const WORD_HIGHLIGHT_CHANGE_RATIO = 0.4;
/** The inline LCS's **character-count** product cap — beyond it we give up (O(n·m) cost; a 500×500-char DP table ≈ 1MB) */
const WORD_DIFF_CHAR_PRODUCT_LIMIT = 250_000;
/**
 * Inline background = how far the whole-line background blends toward that side's
 * foreground color.
 *
 * The blend target is the same-hue foreground; the larger the ratio the closer the inline
 * background gets to the text color: at 0.45, on pi-coder-summer-night's bright green
 * `#42774c` / bright red `#96424a`, syntax-highlighted foreground keeps only ≈2-3:1
 * contrast (dark tokens like comments drop to ≈1.1:1) — characters nearly unreadable.
 * At 0.30 the inline background is clearly brighter than the row background
 * (pi-coder-summer-night: `#052a02` → `#306137`, `#400404` → `#7d3036`, ΔE76 ≈ 22-23),
 * body contrast ≈4.1-4.3:1, and highlighted segments stand out at a glance; the cost is
 * dark tokens like comments falling to ≈1.5-1.9:1 — a bit washed out.
 */
const WORD_BG_BLEND = 0.30;

/**
 * The diff background token names — read **from the skin file**; no color value is
 * hardcoded in the extension.
 *
 * pi's theme schema has no diff-background token (`Theme.bg()` knows only 7 ThemeBg), but
 * **custom keys** in `colors` are parsed anyway: `createTheme()` splits the resolved (incl.
 * `vars` references) colors by key — anything outside the 7 ThemeBg names lands in the
 * `fgColors` table, and `getFgAnsi()` looks it up by key. So a skin writing
 * `"toolDiffAddedBg": "myAddedBg"` (`myAddedBg` being a custom var in the skin's `vars`)
 * is readable, and switching skins switches the background —
 * extension and skin are decoupled; color values exist only in the skin file.
 *
 * What comes back is a **foreground** SGR (`\x1b[38;…m`), and a background differs only by
 * prefix (`\x1b[48;…m`): pi's `fgAnsi` and `bgAnsi` (theme.js) are identical except that
 * one 38/48 digit, and truecolor/256color conversion is the same (`hexToRgb` / `hexTo256`)
 * — so swapping the prefix is a legal background with no color-mode math of our own.
 *
 * When a skin does not define these two tokens (pi's built-in dark / light, or someone
 * else's skin), `getFgAnsi` throws `Unknown theme color` and we fall back to the same
 * skin's `toolSuccessBg` / `toolErrorBg` —
 * still skin-derived, still nothing hardcoded.
 */
const DIFF_ADDED_BG_TOKEN = "toolDiffAddedBg";
const DIFF_REMOVED_BG_TOKEN = "toolDiffRemovedBg";
/** The file-size cap for write's old-content read — beyond it no diff is computed */
const OLD_CONTENT_MAX_BYTES = 200_000;
/**
 * The diff-cost cap for the title row's `+N -M` (sum of both sides' char counts) — beyond
 * it no stats are shown.
 * Same reason as `MAX_HIGHLIGHT_CHARS`: renderCall sits on the render path and jsdiff's
 * line diff is not cheap on huge texts — rather lose a footnote than stall a repaint.
 */
const STATS_MAX_CHARS = 200_000;

/** The streaming marker's blink interval (ms): on / off each take one interval, so the period is twice this */
const BLINK_INTERVAL_MS = 500;
/** The blink tick cap (≈5 minutes): the fallback when nothing else can stop the timer, see `startBlink` */
const BLINK_MAX_TICKS = 600;

/**
 * The leading indent of the title row and the one-line notes (Editing… / Applied / Error
 * / no changes).
 * The tool row used to sit flush-left, level with the assistant text above — no visual
 * hierarchy. One column in, the title / note / card form a level, matching pi's built-in
 * Box content paddingX=1 look.
 */
const INDENT = " ";

/**
 * The leading indent of diff rows and the hunk separator (`┄`) — aligning with codex's
 * diff look.
 * codex's number column is not flush-left; the whole diff block indents relative to the
 * tool title. Only 1 column here, matching the title / note INDENT — 4 columns (codex
 * verbatim) was tried, but narrow terminals lose too many columns to it and wrap far
 * more; 1 column is the compromise between hierarchy and usable width.
 * The top/bottom rules (`╌`) do **not** indent — see `dashedRule`.
 */
const DIFF_INDENT = " ";

const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";
const FULL_RESET = "\x1b[0m";

type DiffLineType = "add" | "del" | "ctx" | "sep";

interface DiffLine {
	type: DiffLineType;
	oldNum: number | null;
	newNum: number | null;
	content: string;
}

interface ParsedDiff {
	lines: DiffLine[];
	added: number;
	removed: number;
}

/** A bundle of SGR sequences, computed once per theme */
interface Sgr {
	BG_ADD: string;
	BG_DEL: string;
	BG_ADD_WORD: string;
	BG_DEL_WORD: string;
	FG_ADD: string;
	FG_DEL: string;
	FG_CTX: string;
	FG_NUM: string;
	FG_RULE: string;
}

/** The width-independent precomputed row — avoids re-running highlightCode on every width change */
interface PreparedRow {
	kind: "line" | "sep";
	type: DiffLineType;
	sign: string;
	numText: string;
	contentHL: string;
	ranges: readonly [number, number][] | undefined;
}

/**
 * The number gutter's total column width (indent + number + space + sign + space).
 * Order follows codex: number first, sign right after, code last —
 * an early implementation had sign first then number (`+ 340`), inconsistent with codex
 * (`95 +`).
 * Only 1 space between sign and body (codex uses 2 verbatim; narrowed to 1 per user
 * request).
 * Wrapped continuation rows must pad to this width so the code area aligns.
 */
function gutterWidthOf(numWidth: number): number {
	return DIFF_INDENT.length + numWidth + 3;
}

/** The blank gutter for wrapped continuation rows (no number or +- sign, background kept) */
function blankGutter(numWidth: number): string {
	return DIFF_INDENT + " ".repeat(numWidth + 3);
}

interface WordRanges {
	old: Array<[number, number]>;
	new: Array<[number, number]>;
}

/**
 * The blink fields in the row-level shared state (edit / write share).
 * pi's `context.state` is one per tool row (tool-execution.js's `rendererState`), and
 * renderCall / renderResult share the same object — so the timer handle lives here, where
 * the other slot can clear it.
 */
interface BlinkFields {
	blinkOn?: boolean;
	blinkTicks?: number;
	blinkTimer?: ReturnType<typeof setInterval> | null;
}

/** The title-row tail `(+N -M)` line counts */
interface DiffStats {
	added: number;
	removed: number;
}

/**
 * Row-level shared state: blink fields + the title-row stats cache (edit / write share).
 *
 * `stats` is tri-state: `undefined` = not computed yet, `null` = computed but
 * uncomputable (huge text / diff error), otherwise the result. `null` must be stored too,
 * or uncomputable rows re-run the diff every frame.
 */
interface RowState extends BlinkFields {
	stats?: DiffStats | null;
}

/** write's renderer shared state: the old content read pre-execution (`path` doubles as the "already captured" marker) */
interface WriteState extends RowState {
	oldContent?: string;
	path?: string;
}

// ---------------------------------------------------------------------------
// unified patch parsing
// ---------------------------------------------------------------------------

/**
 * Parse a standard unified patch. `---` / `+++` are file headers only before the first
 * hunk; every line after that is content — content lines can themselves start with `-` /
 * `+` (e.g. `--verbose`), and a global prefix check would mistake them for headers and
 * drop them.
 */
function parsePatch(patch: string): ParsedDiff {
	const lines: DiffLine[] = [];
	let added = 0;
	let removed = 0;
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;

	for (const rawWithCr of patch.split("\n")) {
		// a CRLF source file leaves a trailing \r on every line — it would jump the cursor back to column 0 and overwrite the drawn gutter
		const raw = rawWithCr.endsWith("\r") ? rawWithCr.slice(0, -1) : rawWithCr;

		if (raw.startsWith("@@")) {
			const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (match === null) continue;
			if (inHunk) lines.push({ type: "sep", oldNum: null, newNum: null, content: "" });
			inHunk = true;
			oldLine = Number(match[1]);
			newLine = Number(match[2]);
			continue;
		}

		if (!inHunk) {
			// everything before the first @@ is the header (diff --git / index / --- / +++)
			continue;
		}
		if (raw.startsWith("\\ No newline")) continue;

		const marker = raw[0];
		const text = raw.slice(1);
		if (marker === "+") {
			lines.push({ type: "add", oldNum: null, newNum: newLine, content: text });
			newLine += 1;
			added += 1;
		} else if (marker === "-") {
			lines.push({ type: "del", oldNum: oldLine, newNum: null, content: text });
			oldLine += 1;
			removed += 1;
		} else if (marker === " ") {
			lines.push({ type: "ctx", oldNum: oldLine, newNum: newLine, content: text });
			oldLine += 1;
			newLine += 1;
		}
	}

	return { lines: collapseContextRuns(lines), added, removed };
}

/**
 * Narrow runs of context lines down to `CONTEXT_LINES` on each side of a change.
 *
 * Why narrow after parsing instead of generating fewer lines: edit's patch comes from pi
 * (`EditToolDetails.patch`, context fixed at 4 internally) — the extension cannot change
 * its generation params. write's patch is computed here via `generateUnifiedPatch` and
 * could take `CONTEXT_LINES` directly, but jsdiff **re-splits hunks** on a different
 * context value (a gap only splits at > 2×context), so the same gap becomes one `┄` in
 * edit and two in write — both tools must take the same narrowing path for a consistent
 * look.
 *
 * Rules (aligned with unified-diff semantics):
 *   - context at a hunk's start: keep only the **last** CONTEXT_LINES rows right before
 *     the first change (earlier ones are dropped — the gutter already says where the file
 *     starts);
 *   - context at a hunk's end: keep only the **first** CONTEXT_LINES rows right after the
 *     last change;
 *   - a gap between two changes: kept whole at ≤ 2×CONTEXT_LINES (changes that close
 *     belong in one hunk), beyond that keep CONTEXT_LINES on each side and insert a `sep`
 *     (same visual as the cross-hunk separator).
 *
 * Display-only: `added` / `removed` still count the full patch (already computed in
 * parsePatch).
 */
function collapseContextRuns(lines: readonly DiffLine[]): DiffLine[] {
	const out: DiffLine[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) break;
		if (line.type !== "ctx") {
			out.push(line);
			i += 1;
			continue;
		}
		// a whole contiguous run of ctx lines
		let end = i;
		while (end < lines.length && lines[end]?.type === "ctx") end += 1;
		const run = lines.slice(i, end);
		// whether the neighbors are hunk boundaries (`sep`) or the patch's own start/end
		const atHunkStart = i === 0 || lines[i - 1]?.type === "sep";
		const atHunkEnd = end === lines.length || lines[end]?.type === "sep";

		if (atHunkStart && atHunkEnd) {
			// a hunk of nothing but context (cannot happen in reality — defensive)
			out.push(...run.slice(0, CONTEXT_LINES));
		} else if (atHunkStart) {
			out.push(...run.slice(Math.max(0, run.length - CONTEXT_LINES)));
		} else if (atHunkEnd) {
			out.push(...run.slice(0, CONTEXT_LINES));
		} else if (run.length > CONTEXT_LINES * 2) {
			out.push(...run.slice(0, CONTEXT_LINES));
			out.push({ type: "sep", oldNum: null, newNum: null, content: "" });
			out.push(...run.slice(run.length - CONTEXT_LINES));
		} else {
			out.push(...run);
		}
		i = end;
	}
	return out;
}

function maxLineNumber(lines: readonly DiffLine[]): number {
	let max = 0;
	for (const line of lines) {
		// both numbers must be checked: unified renders newNum for ctx/add and oldNum for del,
		// so counting only one overflows the gutter by a column on a pure-addition tail block
		const value = Math.max(line.oldNum ?? 0, line.newNum ?? 0);
		if (value > max) max = value;
	}
	return max;
}

// ---------------------------------------------------------------------------
// inline diff (own LCS, no dependencies)
// ---------------------------------------------------------------------------

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const [start, end] of ranges) {
		const last = out[out.length - 1];
		if (last !== undefined && last[1] >= start) last[1] = end;
		else out.push([start, end]);
	}
	return out;
}

/**
 * The inline LCS. Returns **char-offset ranges into the original texts** (UTF-16
 * indices), so the consumer (injectBg) must also advance by character, not columns.
 *
 * LCS runs by **character**, not by word. A word diff treats `computeTimeout` →
 * `computeTimeoutFromProfile` as two different tokens (whole-word replace — all 14+25
 * chars changed, ratio 0.47) and the pair dies at the 0.4 gate — yet that is the most
 * common code change: identifier lengthening / renaming / appended args. Char-level LCS
 * marks only the truly added `FromProfile` (11 chars, ratio 0.13) — far more accurate
 * highlight targets; measured on session logs, 131 of 339 one-del-one-add blocks (38.6%)
 * were being killed by the whole-word granularity.
 *
 * Two cost reductions (the O(n·m) DP table is expensive on long lines — like the
 * thousand-char table rows in this repo's README):
 *   1. Clip the common prefix/suffix first and run LCS only on **the middle stretch that
 *      actually differs**. Long lines usually change a small middle — clipping often
 *      leaves a few chars;
 *   2. Still too large after clipping (`WORD_DIFF_CHAR_PRODUCT_LIMIT`) → skip inline
 *      highlight, keep only the row background.
 * The DP table is a flat `Int32Array` (no `number[][]` — that is n+1 JS arrays, far more
 * expensive).
 */
function computeWordRanges(oldText: string, newText: string): WordRanges | undefined {
	if (oldText === newText) return undefined;

	// common affixes: char-identical heads/tails on both sides — not a change by definition
	let prefix = 0;
	const maxPrefix = Math.min(oldText.length, newText.length);
	while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix += 1;
	let oldEnd = oldText.length;
	let newEnd = newText.length;
	while (oldEnd > prefix && newEnd > prefix && oldText[oldEnd - 1] === newText[newEnd - 1]) {
		oldEnd -= 1;
		newEnd -= 1;
	}

	const oldMid = oldText.slice(prefix, oldEnd);
	const newMid = newText.slice(prefix, newEnd);
	const n = oldMid.length;
	const m = newMid.length;
	if (n * m > WORD_DIFF_CHAR_PRODUCT_LIMIT) return undefined;

	const width = m + 1;
	const dp = new Int32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i -= 1) {
		const row = i * width;
		const below = row + width;
		const oldChar = oldMid[i];
		for (let j = m - 1; j >= 0; j -= 1) {
			dp[row + j] =
				oldChar === newMid[j] ? dp[below + j + 1] + 1 : Math.max(dp[below + j], dp[row + j + 1]);
		}
	}

	const oldRanges: Array<[number, number]> = [];
	const newRanges: Array<[number, number]> = [];
	let oi = 0;
	let nj = 0;
	let changed = 0;

	while (oi < n && nj < m) {
		if (oldMid[oi] === newMid[nj]) {
			oi += 1;
			nj += 1;
		} else if (dp[(oi + 1) * width + nj] >= dp[oi * width + nj + 1]) {
			oldRanges.push([prefix + oi, prefix + oi + 1]);
			changed += 1;
			oi += 1;
		} else {
			newRanges.push([prefix + nj, prefix + nj + 1]);
			changed += 1;
			nj += 1;
		}
	}
	while (oi < n) {
		oldRanges.push([prefix + oi, prefix + oi + 1]);
		changed += 1;
		oi += 1;
	}
	while (nj < m) {
		newRanges.push([prefix + nj, prefix + nj + 1]);
		changed += 1;
		nj += 1;
	}

	// the ratio is measured against the **whole lines** (not the clipped middle): identical parts do not count as change, but the denominator uses full lengths —
	// "a small change inside a long line" and "a small change inside a short line" share one rule (CC's changed/total).
	const changeRatio = changed / (oldText.length + newText.length);
	if (changeRatio > WORD_HIGHLIGHT_CHANGE_RATIO) return undefined;
	return { old: mergeRanges(oldRanges), new: mergeRanges(newRanges) };
}

/**
 * A similarity proxy for two rows: the char sum of their common prefix + suffix. O(len),
 * used to choose pairs inside a block — no LCS.
 * Most code-line changes are "a small middle differs" or "a tail append", which affixes
 * reflect well; two unrelated lines score low on it.
 */
function commonAffixLength(a: string, b: string): number {
	const maxPrefix = Math.min(a.length, b.length);
	let prefix = 0;
	while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix += 1;
	let suffix = 0;
	while (suffix < maxPrefix - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
	return prefix + suffix;
}

/**
 * Pair rows inside one "N del + M add" block, each row paired at most once.
 *
 * An early version paired only on a strict 1-del-1-add block (abandoning the whole block
 * when `visible[i + 2]` was still an add), reasoning that "a `-` followed by several `+`
 * is a block replacement and inline highlight would mislead". The cost: multi-line
 * rewrites got no inline highlight at all — of ~670 adjacent -/+ blocks in the session
 * log only half were 1:1, and the other shape (1 del + N add / N del + M add) — ~330
 * blocks, 2500 changed lines — had only the row background.
 *
 * The pairing rule is **not** CC's "pair by position" (`wordDiff` pairs min-length
 * position-wise) but a block-local greedy similarity match: the D×A candidate pairs are
 * sorted by `commonAffixLength` descending and taken while both ends stay unpaired.
 * Positional pairing mispairs when the sides differ in count — e.g.
 *
 *     -const value = 1;
 *     +const extra = 'x';   ← a newly inserted line
 *     +const value = 2;
 *
 * positional pairing would pair `value = 1` with `extra = 'x'` (measured change ratio
 * 0.35 — right at the 0.4 gate — drawing two meaningless red/green fragments), while
 * similarity pairs it with `value = 2` and the highlight lands on that single digit.
 * Equal scores keep original order (`sort` is stable), so D=A with every line changed
 * degrades to positional pairing. Genuinely unpairable rows die at `computeWordRanges`'s
 * 0.4 gate and degrade to the row background — no misleading highlight.
 *
 * The returned map is keyed by **both the del-row and add-row indices**, each pointing at
 * its own side's ranges.
 * An early version keyed only by the del index, while prepareRows queries add rows by
 * their own index — so the added side's inline highlight always missed (the deleted side
 * worked) — asymmetric halves.
 */
function pairWordRanges(visible: readonly DiffLine[]): Map<number, readonly [number, number][]> {
	const out = new Map<number, readonly [number, number][]>();
	let i = 0;
	while (i < visible.length) {
		if (visible[i]?.type !== "del") {
			i += 1;
			continue;
		}
		// [i, delEnd) are contiguous deletions; [delEnd, addEnd) the additions right after
		let delEnd = i;
		while (visible[delEnd]?.type === "del") delEnd += 1;
		let addEnd = delEnd;
		while (visible[addEnd]?.type === "add") addEnd += 1;

		const candidates: Array<{ del: number; add: number; score: number }> = [];
		for (let d = i; d < delEnd; d += 1) {
			const del = visible[d];
			if (del === undefined) continue;
			for (let a = delEnd; a < addEnd; a += 1) {
				const add = visible[a];
				if (add === undefined) continue;
				candidates.push({ del: d, add: a, score: commonAffixLength(del.content, add.content) });
			}
		}
		// Array.prototype.sort is stable — equal scores keep positional order (equivalent to CC's positional pairing)
		candidates.sort((left, right) => right.score - left.score);

		const pairedDel = new Set<number>();
		const pairedAdd = new Set<number>();
		for (const candidate of candidates) {
			if (pairedDel.has(candidate.del) || pairedAdd.has(candidate.add)) continue;
			const del = visible[candidate.del];
			const add = visible[candidate.add];
			if (del === undefined || add === undefined) continue;
			pairedDel.add(candidate.del);
			pairedAdd.add(candidate.add);
			const ranges = computeWordRanges(del.content, add.content);
			if (ranges === undefined) continue;
			out.set(candidate.del, ranges.old);
			out.set(candidate.add, ranges.new);
		}
		i = addEnd > delEnd ? addEnd : delEnd;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

/**
 * xterm 256-color palette → RGB. In 256color mode `Theme` keeps only the index
 * (`38;5;N`), so the index must be expanded back to RGB before blending: 16-231 is the
 * 6×6×6 cube (steps 0 / 95 / 135 / 175 / 215 / 255), 232-255 the 24-step gray ramp
 * (8 + 10·n). 0-15 are the terminal's own system colors — different per terminal; taken
 * as xterm defaults here but **never matched into** (see `nearestXterm256`).
 */
const XTERM_256_RGB: readonly Rgb[] = (() => {
	const system: Rgb[] = [
		[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
		[0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
		[128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
		[0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
	];
	const levels = [0, 95, 135, 175, 215, 255];
	const cube: Rgb[] = [];
	for (let r = 0; r < 6; r += 1) {
		for (let g = 0; g < 6; g += 1) {
			for (let b = 0; b < 6; b += 1) cube.push([levels[r] ?? 0, levels[g] ?? 0, levels[b] ?? 0]);
		}
	}
	const ramp: Rgb[] = [];
	for (let n = 0; n < 24; n += 1) {
		const v = 8 + n * 10;
		ramp.push([v, v, v]);
	}
	return [...system, ...cube, ...ramp];
})();

/** Weighted squared distance between two RGBs (green weighted highest — the eye is most sensitive to it; same formula as pi's `rgbTo256`) */
function rgbDistance(a: Rgb, b: Rgb): number {
	const dr = a[0] - b[0];
	const dg = a[1] - b[1];
	const db = a[2] - b[2];
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

/**
 * Nearest 256-color index, same rules as pi's `rgbTo256`: find the nearest cube cell, then
 * compare against the gray ramp, **but the gray ramp may win only when the color is nearly
 * neutral (channel range < 10)**.
 * That saturation guard cannot be skipped: inline backgrounds carry hue (red=del /
 * green=add), and an unweighted nearest search quantizes `#287126` (a blended green row
 * background) into gray 239 (`#4e4e4e`) — a gray bar on a green row loses the semantics.
 *
 * The 16 system colors 0-15 do not participate: they are terminal-theme-defined and the
 * same index differs wildly between terminals.
 */
function nearestXterm256(rgb: Rgb): number {
	const levels = [0, 95, 135, 175, 215, 255];
	const closest = (value: number): number => {
		let index = 0;
		let best = Number.POSITIVE_INFINITY;
		for (let i = 0; i < levels.length; i += 1) {
			const distance = Math.abs(value - (levels[i] ?? 0));
			if (distance < best) {
				best = distance;
				index = i;
			}
		}
		return index;
	};

	const rIndex = closest(rgb[0]);
	const gIndex = closest(rgb[1]);
	const bIndex = closest(rgb[2]);
	const cubeIndex = 16 + 36 * rIndex + 6 * gIndex + bIndex;
	const cube: Rgb = [levels[rIndex] ?? 0, levels[gIndex] ?? 0, levels[bIndex] ?? 0];
	const cubeDistance = rgbDistance(rgb, cube);

	const grayValue = Math.round(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]);
	let grayIndex = 0;
	let grayDistance = Number.POSITIVE_INFINITY;
	for (let n = 0; n < 24; n += 1) {
		const value = 8 + n * 10;
		const distance = Math.abs(grayValue - value);
		if (distance < grayDistance) {
			grayDistance = distance;
			grayIndex = n;
		}
	}
	const gray = 8 + grayIndex * 10;
	const spread = Math.max(...rgb) - Math.min(...rgb);
	if (spread < 10 && rgbDistance(rgb, [gray, gray, gray]) < cubeDistance) return 232 + grayIndex;
	return cubeIndex;
}

/** `\x1b[38;2;…m` / `\x1b[48;2;…m` (truecolor) or `\x1b[38|48;5;Nm` (256-color index) → RGB */
function parseRgb(ansi: string): Rgb | undefined {
	const truecolor = ansi.match(/\x1b\[[34]8;2;(\d{1,3});(\d{1,3});(\d{1,3})m/);
	if (truecolor !== null) return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
	const indexed = ansi.match(/\x1b\[[34]8;5;(\d{1,3})m/);
	if (indexed !== null) return XTERM_256_RGB[Number(indexed[1])];
	return undefined;
}

/**
 * Read a diff background token from the skin and convert it to a background SGR (`38;…` →
 * `48;…`, see the comment above).
 * When the skin does not define it (`getFgAnsi` throws `Unknown theme color`) fall back to
 * `fallback`'s ThemeBg.
 * An empty color value makes pi return `\x1b[39m` (foreground reset) — no prefix to swap,
 * same fallback path.
 */
function diffBgFromTheme(theme: Theme, token: string, fallback: "toolSuccessBg" | "toolErrorBg"): string {
	let ansi: string;
	try {
		ansi = theme.getFgAnsi(token as ThemeColor);
	} catch {
		return theme.getBgAnsi(fallback);
	}
	if (!ansi.startsWith("\x1b[38;")) return theme.getBgAnsi(fallback);
	return ansi.replace("\x1b[38;", "\x1b[48;");
}

/**
 * Inline background = the row background blended toward that side's foreground —
 * skin-derived, nothing hardcoded.
 *
 * A 256-color index in (`48;5;N`) means **an index back out** — a 256-color terminal
 * likely drops a truecolor SGR as unknown, and emitting it anyway would be worse than
 * nothing. Quantizing back goes through `nearestXterm256`; coarser, but the blend
 * direction holds (the blend is strictly closer to the foreground than the row
 * background — quantization error cannot reverse that).
 */
function deriveWordBg(baseBgAnsi: string, fgAnsi: string): string {
	const base = parseRgb(baseBgAnsi);
	const fg = parseRgb(fgAnsi);
	if (base === undefined || fg === undefined) return baseBgAnsi;
	const r = Math.round(base[0] + (fg[0] - base[0]) * WORD_BG_BLEND);
	const g = Math.round(base[1] + (fg[1] - base[1]) * WORD_BG_BLEND);
	const b = Math.round(base[2] + (fg[2] - base[2]) * WORD_BG_BLEND);
	if (baseBgAnsi.startsWith("\x1b[48;5;")) return `\x1b[48;5;${nearestXterm256([r, g, b])}m`;
	return `\x1b[48;2;${r};${g};${b}m`;
}

function buildSgr(theme: Theme): Sgr {
	// row backgrounds come from the skin: the skin's custom toolDiffAddedBg / toolDiffRemovedBg first,
	// else the same skin's toolSuccessBg / toolErrorBg — neither path hardcodes a color value.
	const BG_ADD = diffBgFromTheme(theme, DIFF_ADDED_BG_TOKEN, "toolSuccessBg");
	const BG_DEL = diffBgFromTheme(theme, DIFF_REMOVED_BG_TOKEN, "toolErrorBg");
	const FG_ADD = theme.getFgAnsi("toolDiffAdded");
	const FG_DEL = theme.getFgAnsi("toolDiffRemoved");
	return {
		BG_ADD,
		BG_DEL,
		BG_ADD_WORD: deriveWordBg(BG_ADD, FG_ADD),
		BG_DEL_WORD: deriveWordBg(BG_DEL, FG_DEL),
		FG_ADD,
		FG_DEL,
		FG_CTX: theme.getFgAnsi("toolDiffContext"),
		FG_NUM: theme.getFgAnsi("dim"),
		FG_RULE: theme.getFgAnsi("dim"),
	};
}

/**
 * Layer a background over one line (possibly already syntax-highlighted), and swap the
 * given char ranges to the inline background.
 *
 * The counter advances by **character index** (same coordinate system as
 * `computeWordRanges`'s offsets), not terminal columns.
 * On `\x1b[0m` the background must be re-injected — a full reset clears it too.
 */
function injectBg(
	line: string,
	baseBg: string,
	ranges: readonly [number, number][] | undefined,
	wordBg: string,
): string {
	let out = baseBg;
	let charIndex = 0;
	let inWord = false;
	let rangeIndex = 0;
	let i = 0;

	while (i < line.length) {
		if (line[i] === "\x1b") {
			const end = line.indexOf("m", i);
			if (end !== -1) {
				const sequence = line.slice(i, end + 1);
				out += sequence;
				if (sequence === FULL_RESET) out += inWord ? wordBg : baseBg;
				i = end + 1;
				continue;
			}
		}

		let range = ranges?.[rangeIndex];
		while (range !== undefined && charIndex >= range[1]) {
			rangeIndex += 1;
			range = ranges?.[rangeIndex];
		}
		const want = range !== undefined && charIndex >= range[0] && charIndex < range[1];
		if (want !== inWord) {
			inWord = want;
			out += inWord ? wordBg : baseBg;
		}

		out += line[i] ?? "";
		charIndex += 1;
		i += 1;
	}

	return out + BG_RESET;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function highlightLines(source: readonly string[], language: string | undefined): string[] {
	if (language === undefined || source.length === 0) return [...source];
	const joined = source.join("\n");
	if (joined.length > MAX_HIGHLIGHT_CHARS) return [...source];
	try {
		const highlighted = highlightCode(joined, language);
		// a line count mismatch means no index mapping — fall back to the source text
		return highlighted.length === source.length ? highlighted : [...source];
	} catch {
		return [...source];
	}
}

/**
 * Width-independent preprocessing: syntax highlight + inline pairing + gutter text.
 * Highlighting is computed per side (old = ctx+del, new = ctx+add), same as CC / the
 * reference implementation.
 */
function prepareRows(
	s: Sgr,
	visible: readonly DiffLine[],
	language: string | undefined,
	gutterWidth: number,
): PreparedRow[] {
	const oldSource: string[] = [];
	const newSource: string[] = [];
	for (const line of visible) {
		if (line.type === "ctx" || line.type === "del") oldSource.push(line.content);
		if (line.type === "ctx" || line.type === "add") newSource.push(line.content);
	}
	const oldHL = highlightLines(oldSource, language);
	const newHL = highlightLines(newSource, language);
	const wordMap = pairWordRanges(visible);

	const rows: PreparedRow[] = [];
	let oi = 0;
	let ni = 0;
	for (let i = 0; i < visible.length; i += 1) {
		const line = visible[i];
		if (line === undefined) continue;

		if (line.type === "sep") {
			rows.push({ kind: "sep", type: "sep", sign: "", numText: "", contentHL: "", ranges: undefined });
			continue;
		}

		let contentHL: string;
		let ranges: readonly [number, number][] | undefined;
		if (line.type === "del") {
			contentHL = oldHL[oi] ?? line.content;
			oi += 1;
			ranges = wordMap.get(i);
		} else if (line.type === "add") {
			contentHL = newHL[ni] ?? line.content;
			ni += 1;
			ranges = wordMap.get(i);
		} else {
			// ctx exists on both sides — take the new side; both cursors advance
			contentHL = newHL[ni] ?? line.content;
			oi += 1;
			ni += 1;
		}

		const num = line.type === "del" ? line.oldNum : line.newNum;
		const numText =
			num === null ? " ".repeat(gutterWidth) : " ".repeat(Math.max(0, gutterWidth - String(num).length)) + String(num);
		const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";

		rows.push({ kind: "line", type: line.type, sign, numText, contentHL, ranges });
	}
	return rows;
}

/** Lay out by width: pad the background to full width, wrap when needed */
function layoutRows(s: Sgr, rows: readonly PreparedRow[], width: number, gutterWidth: number): string[] {
	// gutter = indent(DIFF_INDENT) + number(gutterWidth) + space(1) + sign(1) + space(1)
	const prefixWidth = gutterWidthOf(gutterWidth);
	const contentWidth = Math.max(1, width - prefixWidth);
	const out: string[] = [];

	for (const row of rows) {
		if (row.kind === "sep") {
			out.push(`${DIFF_INDENT}${s.FG_RULE}${"┄".repeat(Math.max(0, width - DIFF_INDENT.length))}${FG_RESET}`);
			continue;
		}

		const bg = row.type === "add" ? s.BG_ADD : row.type === "del" ? s.BG_DEL : "";
		const wordBg = row.type === "add" ? s.BG_ADD_WORD : row.type === "del" ? s.BG_DEL_WORD : "";
		const signFg = row.type === "add" ? s.FG_ADD : row.type === "del" ? s.FG_DEL : s.FG_CTX;
		// number first, sign second, one space between sign and body (`95 - code` / `94   code`).
		// the number shares the sign's color (a ctx line has no sign and keeps its dim).
		const numFg = row.type === "ctx" ? s.FG_NUM : signFg;
		const gutterText = `${DIFF_INDENT}${numFg}${row.numText}${FG_RESET} ${signFg}${row.sign}${FG_RESET} `;
		// the background starts at the **row's far left** (incl. DIFF_INDENT's 1 column); everything inside the gutter ends only with FG_RESET
		// (foreground-only reset), so the number / sign resets never clear the background — indent + gutter + code area
		// form one continuous background band instead of background only behind the code.
		const gutter = bg === "" ? gutterText : bg + gutterText;
		const blank = bg === "" ? blankGutter(gutterWidth) : bg + blankGutter(gutterWidth);

		const wrapped = wrapTextWithAnsi(row.contentHL, contentWidth);
		const limited = wrapped.length > MAX_WRAP_ROWS ? wrapped.slice(0, MAX_WRAP_ROWS) : wrapped;
		for (let r = 0; r < limited.length; r += 1) {
			const rowText = limited[r] ?? "";
			// skip inline highlighting on wrapped rows: the ranges are char offsets into the unwrapped text and do not line up
			const effectiveRanges = wrapped.length === 1 ? row.ranges : undefined;
			const hasMarker = wrapped.length > MAX_WRAP_ROWS && r === limited.length - 1;
			// the truncation marker takes 1 column, and the last wrapped row is already exactly contentWidth wide —
			// reducing the padding alone is not enough; the row must be clipped by 1 column or the whole row goes 1 over
			// (most visible with CJK wide chars: each takes 2 columns and the error is not masked by "one space short").
			const usable = hasMarker ? Math.max(1, contentWidth - 1) : contentWidth;
			const clipped = visibleWidth(rowText) > usable ? truncateToWidth(rowText, usable, "") : rowText;
			const padWidth = Math.max(0, usable - visibleWidth(clipped));
			// the marker sits inside the background so the hue spans the whole row instead of ending one column early
			const marker = hasMarker ? `${s.FG_CTX}›${FG_RESET}` : "";
			const bodyText = clipped + " ".repeat(padWidth) + marker;
			const body = bg === "" ? bodyText : injectBg(bodyText, bg, effectiveRanges, wordBg);
			// continuation rows carry no number or +- sign (codex-style): the gutter stays blank, the background alone shows the membership —
			// repeating the same number would read as separate changes. The gutter blanks but the background still fills,
			// or the wrapped part would be one column shorter than the first row.
			out.push((r === 0 ? gutter : blank) + body);
		}
	}
	return out;
}

/**
 * The top/bottom dashed rules: **flush-left**, full row width — they are the card's
 * border, not diff content, so they do not follow the diff rows' indent (an indented rule
 * would be a column narrower than the content and look unclosed). Width taken verbatim,
 * indent not subtracted.
 */
function dashedRule(s: Sgr, width: number): string {
	return `${s.FG_RULE}${"╌".repeat(Math.max(0, width))}${FG_RESET}`;
}

/**
 * The result-card component. `render(width)` is called every frame, so layouts are cached
 * per width;
 * syntax highlighting is computed at construction (width-independent), not per frame.
 */
class DiffCard {
	private readonly cache = new Map<number, string[]>();

	constructor(private readonly layout: (width: number) => string[]) {}

	render(width: number): string[] {
		const hit = this.cache.get(width);
		if (hit !== undefined) return hit;
		const lines = this.layout(width);
		this.cache.set(width, lines);
		return lines;
	}

	invalidate(): void {
		this.cache.clear();
	}
}

function buildDiffCard(
	theme: Theme,
	diff: ParsedDiff,
	language: string | undefined,
	expanded: boolean,
): DiffCard {
	const s = buildSgr(theme);
	const maxLines = expanded ? EXPANDED_MAX_LINES : PREVIEW_MAX_LINES;
	const visible = diff.lines.slice(0, maxLines);
	const hidden = diff.lines.length - visible.length;
	const gutterWidth = Math.max(2, String(maxLineNumber(visible)).length);
	const rows = prepareRows(s, visible, language, gutterWidth);

	return new DiffCard((width: number) => {
		// the line counts moved to the title row's `(+N -M)` — the card starts straight at the dashed rules,
		// no more `Added N lines, removed M lines` reporting the same change twice.
		if (rows.length === 0) return [];
		const out: string[] = [dashedRule(s, width)];
		out.push(...layoutRows(s, rows, width, gutterWidth));
		out.push(dashedRule(s, width));
		if (hidden > 0) {
			// the hint row has no background to lean on — overlong text would exceed the width outright, so it is truncated to fit
			out.push(
				DIFF_INDENT +
					truncateToWidth(
						theme.fg(
							"muted",
							`… ${hidden} more diff ${hidden === 1 ? "line" : "lines"}${expanded ? "" : " (ctrl+e to expand)"}`,
						),
						Math.max(1, width - DIFF_INDENT.length),
						"…",
					),
			);
		}
		return out;
	});
}


/**
 * The +/- line counts between two texts. Same `generateUnifiedPatch` + `parsePatch` as
 * the result card, so the title row's numbers and the card's rows use one rule.
 * Uncomputable (huge text / errors) → undefined, and the title row carries no footnote.
 */
function diffStatsOf(oldText: string, newText: string): DiffStats | undefined {
	if (oldText === newText) return { added: 0, removed: 0 };
	if (oldText.length + newText.length > STATS_MAX_CHARS) return undefined;
	try {
		// path only lands in the patch header, which parsePatch skips — an empty string suffices
		const parsed = parsePatch(generateUnifiedPatch("", oldText, newText));
		return { added: parsed.added, removed: parsed.removed };
	} catch {
		return undefined;
	}
}

/**
 * edit's line counts: diff each `edits` entry's oldText → newText and sum.
 * The changes land in non-overlapping regions, so the sum equals the whole-file patch's
 * +/- count (adjacent changes merged into one hunk by jsdiff only affect the context, not
 * the +/- counters).
 */
function editStats(args: unknown): DiffStats | undefined {
	const edits = (args as { edits?: unknown } | undefined)?.edits;
	if (!Array.isArray(edits) || edits.length === 0) return undefined;
	let added = 0;
	let removed = 0;
	for (const edit of edits) {
		const entry = edit as { oldText?: unknown; newText?: unknown } | undefined;
		if (entry === undefined || entry === null) continue;
		const stats = diffStatsOf(
			typeof entry.oldText === "string" ? entry.oldText : "",
			typeof entry.newText === "string" ? entry.newText : "",
		);
		if (stats === undefined) return undefined;
		added += stats.added;
		removed += stats.removed;
	}
	return { added, removed };
}

/** Stats are computed once and reused every frame (renderCall re-runs constantly: repaints, width changes, expand/collapse) */
function cachedStats(state: RowState | undefined, compute: () => DiffStats | undefined): DiffStats | undefined {
	if (state === undefined) return compute();
	if (state.stats === undefined) state.stats = compute() ?? null;
	return state.stats ?? undefined;
}


/**
 * Blink the title tail's `●` during streaming; returns the current phase (true = lit).
 *
 * Why a timer rather than "blink on each delta": in pi's tool-execution.js,
 * `context.invalidate()` = `ToolExecutionComponent.invalidate()` (→ `updateDisplay()`
 * re-calls renderCall) + `ui.requestRender()`, so flipping the phase + invalidate
 * self-drives repaints — a fixed cadence independent of delta arrival (a paused stream
 * does not freeze the phase).
 *
 * Three places stop the timer (the first two are the normal paths, the third a fallback):
 *   1. renderCall's `argsComplete` branch (the arg stream ended);
 *   2. `renderResult` (a result arrived). It also covers interrupted / errored rows —
 *      interactive-mode.js calls `updateResult` on every pending row at
 *      `stopReason=aborted|error` rather than `setArgsComplete`, so those rows never
 *      reach 1;
 *   3. The tick cap. It covers "a row has no result and `argsComplete` never comes": e.g.
 *      a session killed mid-tool-call and restored — that row's stopReason is not
 *      aborted/error and has no toolResult.
 *      (History rows with results do not go this way: renderCall's `isPartial` branch
 *      stops the timer on the spot.)
 *      A normal single-turn write/edit arg stream never approaches this cap.
 *
 * `unref()` keeps the timer from blocking process exit.
 */
function startBlink(state: BlinkFields, invalidate: () => void): boolean {
	if (state.blinkTimer === undefined || state.blinkTimer === null) {
		state.blinkOn = true;
		state.blinkTicks = 0;
		state.blinkTimer = setInterval(() => {
			state.blinkTicks = (state.blinkTicks ?? 0) + 1;
			if ((state.blinkTicks ?? 0) > BLINK_MAX_TICKS) {
				stopBlink(state);
				invalidate();
				return;
			}
			state.blinkOn = !(state.blinkOn ?? false);
			invalidate();
		}, BLINK_INTERVAL_MS);
		state.blinkTimer.unref?.();
	}
	return state.blinkOn !== false;
}

/** Stop the blink timer and settle to the off phase. Idempotent — safe with no timer running. */
function stopBlink(state: BlinkFields | undefined): void {
	if (state === undefined) return;
	if (state.blinkTimer !== undefined && state.blinkTimer !== null) clearInterval(state.blinkTimer);
	state.blinkTimer = null;
	state.blinkOn = false;
}


/**
 * The title row. An empty path omits the whole segment (the streaming start form is
 * `Edit ●` before the path parses out); an empty suffix is likewise omitted. The suffix
 * must be **already colored** — the blink marker needs its own color, and
 * `theme.fg("dim", <colored string>)`'s outer reset would eat the inner ANSI.
 * The path is the opposite: pass **plain text** — `TitleRow.render` truncates from the
 * head by width first, then colors.
 *
 * The layout deps explicitly wire pi-tui's measure/truncate functions (the pure module
 * side knows nothing of pi);
 * home is read once and kept (it cannot change mid-process).
 */
const TITLE_ROW_DEPS: TitleRowDeps = {
	widthOf: visibleWidth,
	truncateToWidth,
	home: homedir(),
	indent: INDENT,
};

function titleRow(theme: Theme, tool: string, path: string, suffix: string): TitleRow {
	return new TitleRow(TITLE_ROW_DEPS, theme, theme.fg("toolTitle", theme.bold(tool)), path, suffix);
}

/** A one-line note (Editing… / Error / Applied / Written / no changes).
 *  It occupies the same visual slot as the result card, so it carries the same indent —
 *  otherwise the same tool indents sometimes and not others. */
function noteLine(theme: Theme, color: "dim" | "error" | "success" | "muted", text: string): Text {
	return new Text(INDENT + theme.fg(color, text), 0, 0);
}

function firstText(result: { content: readonly { type: string; text?: string }[] }): string {
	const first = result.content[0];
	return first !== undefined && first.type === "text" ? first.text ?? "" : "";
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	const cwd = process.cwd();

	// --- edit: renderCall keeps only the title row, not the built-in diff preview ---
	const originalEdit = createEditTool(cwd);
	pi.registerTool({
		...originalEdit,
		renderShell: "self",
		renderCall(args, theme, context) {
			const path = String(args?.path ?? "");
			const state = context.state as RowState | undefined;
			// while loading, show the tool name + path + blinking `●` ("receiving the byte stream"); token counts do not scroll here —
			// the bottom spinner already counts the current segment's output (working-indicator/) — duplicating it.
			// `+N -M` shows only once args complete — mid-stream the edits array may not have parsed yet and the counts would keep jumping.
			// show path when present, omit when absent: measured, `parseStreamingJson` returns
			// **partial values** for unterminated strings (`{"path": "/a/b/ser` → `"/a/b/ser"`), so early in the stream a half-grown path appears char by char;
			// but path is the schema's first field and short — a few tokens close it,
			// after which the path is stable while content keeps streaming — so showing early beats never showing.
			// `isPartial` only turns false after `updateResult` (tool-execution.js) — exactly distinguishing
			// "really streaming" from "result arrived but argsComplete will never go true" — the latter being
			// interrupted rows and rows rendered from a restored history session (renderSessionItems never calls setArgsComplete).
			// such rows neither blink nor draw the marker (or every history row would carry a static `●`), but still count `+N -M`:
			// their args are complete in the session log — the history area cannot be without line counts.
			// without state, do not blink — but still draw the marker (a static marker beats no hint at all)
			if (!context.argsComplete && context.isPartial) {
				// the arg stream ended (or the result arrived): stop the timer, restore the full form (path + `+N -M`)
				const on = state === undefined ? true : startBlink(state, context.invalidate);
				return titleRow(theme, "Edit", path, blinkSuffix(theme, on));
			}
			// a result arrived → stop the timer (interrupted / errored rows come this way too); a partial result does not count — args may still be streaming.
			stopBlink(state);
			return titleRow(theme, "Edit", path, statsSuffix(theme, cachedStats(state, () => editStats(args))));
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			// --- write: its own renderCall (must read the old content pre-execution), renderResult draws the real diff ---
			if (!isPartial) stopBlink(context.state as RowState | undefined);
			if (isPartial) return noteLine(theme, "dim", "Editing…");

			if (context.isError) {
				return noteLine(theme, "error", firstText(result).split("\n")[0] || "Edit failed");
			}

			const details = result.details as EditToolDetails | undefined;
			const patch = details?.patch ?? details?.diff ?? "";
			if (patch === "") return noteLine(theme, "success", "Applied");

			const diff = parsePatch(patch);
			if (diff.lines.length === 0) return noteLine(theme, "success", "Applied");

			const path = String((context.args as { path?: unknown } | undefined)?.path ?? "");
			return buildDiffCard(theme, diff, getLanguageFromPath(path), expanded);
		},
	});

	// capture the old content before execution starts, and **re-capture on every path change**: mid-stream the path grows char by char
	const originalWrite = createWriteTool(cwd);
	pi.registerTool({
		...originalWrite,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as WriteState | undefined;
			const path = String(args?.path ?? "");
			// (`parseStreamingJson` returns partial values for unterminated strings) — a half path either fails stat
			// (looking like a new file, so an overwrite counts wholly as additions), or happens to hit another file.
			// re-keying on path means the last frame (`argsComplete`, earlier than `tool_execution_start`) always sees
			// the full path, so the final value is always right. Once executionStarted the write is done — reading then gives
			// the new content and the diff is empty — that window closing stops it for good.
			// missing (new file) or unreadable → treat as empty content; everything counts as added
			if (state !== undefined && path !== "" && !context.executionStarted && state.path !== path) {
				state.path = path;
				try {
					const absolute = resolvePath(context.cwd, path);
					const size = statSync(absolute).size;
					state.oldContent = size <= OLD_CONTENT_MAX_BYTES ? readFileSync(absolute, "utf-8") : "";
				} catch {
					// the old-content capture must run before the display branches below: it depends on "execution not started",
					state.oldContent = "";
				}
			}

			// not "args complete" — deferring to argsComplete could miss the pre-write window.
			// while loading, show the tool name + path + blinking `●` (same form as edit); token counts go to the bottom
			// spinner — no duplication on the title row. `isPartial` means the same as on the edit side.
			// the arg stream ended (or the result arrived): stop the timer, restore the full form (path + `+N -M`).
			if (!context.argsComplete && context.isPartial) {
				const on = state === undefined ? true : startBlink(state, context.invalidate);
				return titleRow(theme, "Write", path, blinkSuffix(theme, on));
			}
			// the stats diff the pre-execution old content against the args' new content — the same input pair renderResult
			// uses for the card, so the title's numbers and the card's rows cannot disagree.
			// a result arrived → stop the timer (interrupted / errored rows come this way too); a partial result does not count — args may still be streaming.
			stopBlink(state);
			const content = String(args?.content ?? "");
			const stats = cachedStats(state, () => diffStatsOf(state?.oldContent ?? "", content));
			return titleRow(theme, "Write", path, statsSuffix(theme, stats));
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			// a result arrived → stop the timer (interrupted / errored rows come this way too); a partial result does not count — args may still be streaming.
			if (!isPartial) stopBlink(context.state as WriteState | undefined);
			if (isPartial) return noteLine(theme, "dim", "Writing…");

			const text = firstText(result);
			if (context.isError || text.startsWith("Error")) {
				return noteLine(theme, "error", text.split("\n")[0] || "Write failed");
			}

			const state = context.state as WriteState | undefined;
			const path = String((context.args as { path?: unknown } | undefined)?.path ?? "");
			const content = String((context.args as { content?: unknown } | undefined)?.content ?? "");
			if (path === "" || content === "") return noteLine(theme, "success", "Written");

			const oldContent = state?.oldContent ?? "";
			if (oldContent === content) return noteLine(theme, "muted", "no changes");

			let patch: string;
			try {
				patch = generateUnifiedPatch(path, oldContent, content);
			} catch {
				return noteLine(theme, "success", "Written");
			}

			const diff = parsePatch(patch);
			if (diff.lines.length === 0) return noteLine(theme, "success", "Written");
			return buildDiffCard(theme, diff, getLanguageFromPath(path), expanded);
		},
	});
}
