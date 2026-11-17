/**
 * read-path-collapse — compresses the read tool's title-row path: **always one line**;
 * on overflow a `…` prefix marks the elided prefix and the **filename tail** stays whole.
 *
 * The problem it solves: pi's built-in read title is `read <path>:<lines>` and the path
 * wraps via pi-tui's `Text` (`wrapTextWithAnsi`) — a **greedy word wrap** that bumps a
 * word not fitting the current line's leftover space **whole** to the next line before
 * breaking it. A long path is one whole "word" (no spaces inside), so on a measured
 * 79-column terminal
 *
 *     read
 *     ~/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:62-116
 *
 * renders as `read` alone on one line (4 columns used, seventy wasted) plus the path
 * split in two from the middle. Same root cause as the "early wrap" of `$ cp <78-col
 * path>` in `bash-command-collapse.ts`; there bash chose break-all hard wrapping (the
 * command text should stay as complete as possible), here the choice is **compress to one
 * line**: a path's information concentrates in the **tail** (filename + last few dirs) —
 * the `~/.pi/agent/npm/...` prefix is known to everyone, so dropping the prefix beats
 * taking two rows.
 *
 * ## The result shape
 *
 *     Read …@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:62-116
 *
 * - The `Read ` prefix (`toolTitle` color + bold) and the `:62-116` line range
 *   (`warning`) are kept verbatim;
 * - the path uses `text` color (same convention as `tool-diff.ts`'s `Edit <path>`),
 *   **not pi's built-in `accent`**: pi's `renderToolPath()` colors the path `accent`, and
 *   the title row is "verb + path" side by side — the moment a skin sets `accent` and
 *   `toolTitle` to the same palette color (pi-coder-catppuccin's mauve), both segments
 *   become the same color and the hierarchy disappears. So **even fitting short paths get
 *   recolored** (see `recolorToolPath`);
 * - the path fills **from the tail** backwards: directory levels are added leftwards
 *   until nothing more fits, then a `…` is prepended;
 * - when it fits (short paths) **pi's original render is kept structurally verbatim**
 *   (only the path color goes `accent` → `text`) — including the OSC 8 clickable
 *   hyperlink;
 * - on an extremely narrow terminal where even the last dir level does not fit, the tail
 *   is hard-clipped by grapheme (emoji / combining chars never split; CJK counts 2
 *   columns).
 *
 * ## Capitalized tool name (`Read`)
 *
 * pi's built-in read renderer writes lowercase `read`; this extension shows `Read` —
 * same convention as `tool-diff.ts`'s `Edit` / `Write` (mimicking Claude Code's tool
 * titles), **display form only**: the registered name, routing, and session-log text are
 * untouched. All three verb shapes (`read <path>:<lines>` / `read docs <label>` / `read
 * resource <label>`) plus the compressed self-drawn title are covered; the
 * `[skill] <dirname>` shape contains no verb and is kept verbatim. The replacement only
 * touches the **verb segment** and only on the **first line** (`capitalizeReadVerb` /
 * `capitalizeReadTitle`) — a file named something-read, or a `read ` fragment wrapped
 * onto a line start, cannot be miscapitalized. `PI_READ_COLLAPSE=off` only disables the
 * long-path compression; the name still capitalizes.
 *
 * ## The whole block's shell: `renderShell: "self"` + self-drawn left margin + status
 * dot (decided by the user 2026-09-21)
 *
 * The read block shares **one visual language** with `bash-command-collapse.ts`'s bash
 * block (that side is this section's prototype):
 *
 *   - `renderShell: "self"` — pi stops wrapping the block in `contentBox`, giving
 *     ① **no background** (none of pending's `toolPendingBg`, success's `toolSuccessBg`,
 *     or failure's `toolErrorBg` — "never painted", not "painted then erased" — the same
 *     trick as the bash side),
 *     ② **no top/bottom blank border rows** (the default shell is a `Box(1, 1)` and
 *     those blanks are what it paints).
 *     Only read changes this way — every other tool keeps pi's default shell (background
 *     + border blanks).
 *   - Left margin **1 → 2 columns** overall: the first row is the status dot `•` + a
 *     space, the other rows two spaces (`withHeadBar`).
 *     So the dot sits at column 0, `Read`'s `R` at column 2, and the result body at
 *     column 2 — one more column yielded than before.
 *   - The dot color follows the state: **while reading (pending / partial) `dim` gray,
 *     success `toolDiffAdded` green, failure `toolDiffRemoved` red** (same semantics as
 *     the bash side's `stateBarAnsi`).
 *
 * How: `renderCall` / `renderResult` each wrap pi's rendered component in the shell — a
 * `Box(0, 0)` **with no bgFn**, whose left edge the child draws itself (`withHeadBar`).
 * Three things not to assume:
 *   ① **The left margin hangs on the title component's first row** (`• ` first, two
 *      spaces after); the result body keeps the two-space indent — the same "command +
 *      result" tree as bash.
 *   ② Width: the `Box`'s `paddingX` is 0 and the child gets the full width — so inside
 *      the shell everything renders at `width - MARGIN_WIDTH - RIGHT_PAD` (margin + the
 *      trailing blank column), or the prefix pushes it over.
 *   ③ **"While reading" means `context.isPartial === true`** (after
 *      `tool_execution_start`, before the result — pi's partial state), and `isError`
 *      must be read from `context` — pi passes `{ content, details }` to the result
 *      renderer, **with no `isError` field** (the bash side hit the same trap).
 *
 * ## Take over rendering only when compression is needed (no full renderCall rewrite)
 *
 * The approach is **post-processing** pi's component: delegate to the built-in
 * `readRenderers.renderCall` for the `Text`, render it inside `render(width)`; **≤ 1
 * line → return verbatim** (pi's colors, `~` shortening, OSC 8 hyperlinks, `[skill]` /
 * `read docs` / `read resource` compact shapes, `(ctrl+o to expand)` hints all
 * preserved), **> 1 line → rebuild one compressed title row**. So short paths (the vast
 * majority of reads) keep pi's native rendering — this extension introduces zero
 * behavioral difference; only genuinely overlong paths switch to the compressed form.
 *
 * Two traps that must not be missed:
 *   1. **`lastComponent` must get the inner `Text`, never our wrapper** — built-in
 *      read.js does `context.lastComponent ?? new Text("", 0, 0)` then `setText()`; pi
 *      passes the previous renderCall's return (our wrapper) back as lastComponent, the
 *      wrapper has no setText, renderCall throws, and `updateDisplay()`'s try/catch
 *      **silently falls back** to `createCallFallback()` — a bare `read` title with the
 *      path gone. So the inner component lives in `context.state.innerText` across calls
 *      (same approach as `bash-command-collapse.ts`'s `state.innerComponent`).
 *   2. **The OSC 8 hyperlink switch must not come from our own pi-tui copy's
 *      `getCapabilities()`** — the pi-tui the extension imports is the npm/dist copy
 *      behind the loader alias; the `setCapabilityOverrides(settings)` pi's runtime
 *      (bundle) calls only touches the bundle copy's cache, while our copy self-detects
 *      from env — the two can disagree (a terminal without OSC 8 still judges true on
 *      our copy → link text gets eaten). Instead it is **detected from pi's rendered
 *      title**: a `\x1b]8;;` in pi's title string means hyperlinks are on, and our copy
 *      of the URL is rebuilt with pi-tui's `hyperlink()` (a pure string joiner that does
 *      not query capabilities).
 *
 * ## The compact shapes (`[skill]` / `read docs` / `read resource`)
 *
 * For SKILL.md, pi's own README/docs/examples, and AGENTS.md/CLAUDE.md-type files, pi
 * shows no full path but `[skill] <dirname>` / `read docs <relative label>` / `read
 * resource <relative path>` (`getCompactReadClassification`, module-private). Those
 * labels are usually short, but `read resource`'s label is a **cwd-relative path** and
 * can overflow too — so the compressed branch reproduces all three shapes
 * (`getReadmePath()` is package-root-exported, docs detection same source as pi), only
 * the label itself is compressed; the prefix and `(ctrl+o to expand)` hint stay.
 *
 * The hint's key name **must never come from pi's `keyHint` / `keyText`**: measured,
 * `keyHint` throws `Theme not initialized` (it reads the npm/dist copy's own theme
 * singleton — pi only initializes the bundle copy's), `keyText` returns "" (the copy's
 * keybindings table is empty), and a renderCall throw is silently caught into the
 * fallback. Instead `~/.pi/agent/keybindings.json`'s `app.tools.expand` is read,
 * defaulting to `ctrl+o` (same approach as `bash-command-collapse.ts`'s
 * `expandKeyText()`).
 * When the terminal is too narrow to leave `MIN_LABEL_WIDTH` columns for the label, the
 * hint row is dropped first and the budget recomputed — the hint is decorative, the
 * filename matters.
 *
 * ## Expanded state (ctrl+o)
 *
 * With `context.expanded` true, pi skips compact-shape detection (always the full path);
 * this extension likewise compresses only on overflow — identical rule — collapsed and
 * expanded wrap rules must agree or expanded would wrap early again.
 * Note expansion **does not affect the file content's** display (that is renderResult's
 * business, which this extension does not touch).
 *
 * Pure display layer: the tool-call args sent to the model, the session-log text, and
 * read's execution logic are completely unchanged (`execute` / `parameters` /
 * `description` / `promptSnippet` / `promptGuidelines` / `constrainedSampling` are all
 * inherited verbatim via `{ ...base }` from `createReadToolDefinition()`).
 *
 * Usage:
 *   PI_READ_COLLAPSE=off    disable long-path compression at startup (back to pi's
 *                           greedy wrap — long paths take two rows)
 */

import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, getReadmePath } from "@earendil-works/pi-coding-agent";
import { Box, hyperlink, Text, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** The elided-prefix marker. 1 column wide — `visibleWidth` measures 1. */
const ELLIPSIS = "…";
/** The fewest columns a compact-shape label keeps; below it the `(ctrl+o to expand)` hint is dropped and the budget recomputed. */
const MIN_LABEL_WIDTH = 12;
/** The resource filenames pi treats as "compact shape" (copied from read.js's COMPACT_RESOURCE_FILE_NAMES). */
const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/** The grapheme segmenter (pi-tui does not export its own instance — a local one; Node's built-in Intl.Segmenter). */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** pi's agent dir (`PI_CODING_AGENT_DIR` overrides, else `~/.pi/agent`). */
function resolveAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	return envDir ? (envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir) : join(homedir(), ".pi", "agent");
}

/**
 * The key-name text for `app.tools.expand` (default `ctrl+o`).
 *
 * pi's exported `keyText` / `keyHint` cannot be used — see the file header's "compact
 * shapes" section.
 */
function expandKeyText(): string {
	try {
		const parsed = JSON.parse(readFileSync(join(resolveAgentDir(), "keybindings.json"), "utf8"));
		const bound = parsed?.["app.tools.expand"];
		const keys = Array.isArray(bound) ? bound : [bound];
		const text = keys.filter((k: unknown): k is string => typeof k === "string" && k.trim() !== "").join("/");
		if (text) return text;
	} catch {
		// no config file / parse failure / no such binding — all take the default
	}
	return "ctrl+o";
}

/** pi's `str()`: a string verbatim, null/undefined → "", anything else → null (= invalid arg). */
function strArg(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

/** pi's `shortenPath()`: a `$HOME` prefix becomes `~` (note pi uses a bare startsWith — no separator required). */
function shortenPath(path: string): string {
	const home = homedir();
	if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

/**
 * The part of `resolveToCwd()` we need: strip a `@` prefix, expand `~`, resolve against
 * cwd.
 * pi also normalizes Unicode spaces (those narrow no-break spaces in macOS screenshot
 * names) — skipped here: it only affects paths containing such spaces, and we only use
 * this for the OSC 8 URL and compact-shape detection.
 */
function resolveAgainstCwd(rawPath: string, cwd: string): string {
	let normalized = rawPath;
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") return homedir();
	if (normalized.startsWith("~/")) return join(homedir(), normalized.slice(2));
	return isAbsolute(normalized) ? resolvePath(normalized) : resolvePath(cwd, normalized);
}

/**
 * pi's `resolvePath(input, baseDir)` (`utils/paths.js`) — **the argument order is the
 * reverse of node's `resolve`**.
 *
 * This file aliases node's `resolve` as `resolvePath` (to mirror pi's source shape), so
 * `resolvePath(filePath, cwd)` looks like pi's line but is actually node's
 * "base-first" semantics: when `filePath` is absolute node returns `cwd` outright and
 * the file is dropped. The consequence: `relative(cwd, cwd)` = `""` → the `inside`
 * check passes → the label degenerates to `"."` — and a resource file **outside** cwd
 * (`~/.pi/agent/AGENTS.md`) renders as `Read resource .:67-80` on the overlong
 * compression branch (reproduced live). Files inside cwd happen to be correct, so the
 * trap only shows when reading the global AGENTS.md.
 *
 * When replicating pi's function, replicate its signature — not its name.
 */
function resolveLikePi(input: string, baseDir: string): string {
	return isAbsolute(input) ? resolvePath(input) : resolvePath(baseDir, input);
}

/** pi's `getCwdRelativePath()`: a relative path inside cwd, undefined outside. */
function cwdRelativePath(filePath: string, cwd: string): string | undefined {
	const resolvedCwd = resolvePath(cwd);
	const resolved = resolveLikePi(filePath, resolvedCwd);
	const rel = relative(resolvedCwd, resolved);
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	return inside ? rel || "." : undefined;
}

/** pi's `formatPathRelativeToCwdOrAbsolute()`: relative inside cwd, absolute outside, always posix separators. */
function pathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
	const absolutePath = resolveLikePi(filePath, cwd);
	return (cwdRelativePath(absolutePath, cwd) ?? absolutePath).split(sep).join("/");
}

/** pi's `getPiDocsClassification()`: README.md / docs/** / examples/** inside the pi package. */
function piDocsLabel(absolutePath: string): string | undefined {
	try {
		const packageRoot = dirname(getReadmePath());
		const rel = relative(resolvePath(packageRoot), resolvePath(absolutePath));
		if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
		const label = rel.split(sep).join("/");
		if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) return label;
	} catch {
		// a getReadmePath() throw abandons the docs check (falls back to the full-path shape)
	}
	return undefined;
}

interface CompactClassification {
	kind: "skill" | "docs" | "resource";
	label: string;
}

/** A replication of pi's `getCompactReadClassification()` (module-private — can only be copied). */
function getCompactClassification(args: any, cwd: string): CompactClassification | undefined {
	const rawPath = strArg(args?.path);
	if (!rawPath) return undefined;
	const absolutePath = resolveAgainstCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	const docsLabel = piDocsLabel(absolutePath);
	if (docsLabel) return { kind: "docs", label: docsLabel };
	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) return { kind: "resource", label: pathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	return undefined;
}

/** pi's `formatReadLineRange()`: `:62-116` (warning color); no offset/limit → "". */
function formatReadLineRange(args: any, theme: any): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

/**
 * Take graphemes from the **right** until the budget is full.
 * The fallback for an extremely narrow terminal where even the last dir level does not
 * fit — hard-clipping by column would split emoji / combining chars in half; when a wide
 * char (CJK etc., 2 cols) cannot fit the remaining 1 column, stop before it (leaving 1
 * blank) — a grapheme is indivisible.
 */
function tailGraphemes(text: string, budget: number): string {
	if (budget <= 0) return "";
	let out = "";
	let used = 0;
	for (const { segment } of [...graphemeSegmenter.segment(text)].reverse()) {
		const w = visibleWidth(segment);
		if (used + w > budget) break;
		out = segment + out;
		used += w;
	}
	return out;
}

/**
 * Path compression: fits → verbatim; does not → add directory levels backwards **from
 * the tail** and prepend `…`.
 *
 * Deliberately keeps as many tail levels as fit rather than only the filename: at the
 * same column budget, `…core/extensions/loader.js` says which file was read better than
 * `…loader.js` (same-named files are common).
 */
function compressTail(text: string, budget: number): string {
	const width = Math.max(1, Math.floor(budget));
	if (visibleWidth(text) <= width) return text;
	const ellipsisWidth = visibleWidth(ELLIPSIS);
	// `/` on macOS / Linux; Windows `~C:\...` handled the same way (pi's shortenPath does not change separators)
	const separator = text.includes("/") ? "/" : "\\";
	const segments = text.split(separator);
	let tail = "";
	for (let i = segments.length - 1; i >= 0; i--) {
		const candidate = tail ? `${segments[i]}${separator}${tail}` : segments[i];
		if (visibleWidth(candidate) + ellipsisWidth > width) break;
		tail = candidate;
	}
	if (!tail) {
		// even the last dir level does not fit: hard-clip graphemes from the right
		return ELLIPSIS + tailGraphemes(segments[segments.length - 1] ?? "", width - ellipsisWidth);
	}
	return ELLIPSIS + tail;
}

/**
 * Detect whether pi has OSC 8 hyperlinks on: look for `\x1b]8;;` in the title string it
 * rendered.
 * The reason is in the file header — our own copy's `getCapabilities()` cannot be read.
 * `inner.text` is `Text`'s private field (TS-private, readable at runtime); absent it,
 * fall back to the rendered lines.
 */
function piTitleUsesHyperlink(inner: any, lines: string[]): boolean {
	const raw = typeof inner?.text === "string" ? inner.text : lines.join("\n");
	return raw.includes("\x1b]8;;");
}

/**
 * The foreground-reset sequence — every `theme.fg()` color segment ends with one, so the
 * first one in a row marks **the verb segment's end**.
 */
const FG_RESET = "\x1b[39m";

/** The SGR sequences (`theme.fg()` / `theme.bold()`'s output), only for measuring visible text. */
const SGR_SEQUENCE = /\x1b\[[0-9;]*m/g;

/**
 * Swap the title row's verb `read` for a capitalized `Read` (see the file header's
 * "capitalized tool name" section).
 *
 * Only touches the **verb segment** (line start to the first `\x1b[39m`, located the same
 * way as `recolorToolPath`), and requires the segment's visible text — SGR stripped — to
 * be exactly `read` or start with `read `:
 *   - `read <path>` / `read docs <label>` / `read resource <label>` hit;
 *   - `[skill] <dirname>`'s verb segment is `[skill]` — no verb, returned verbatim;
 *   - with colors off (no ANSI) the verb segment degenerates to the whole line, and the
 *     same condition still excludes `readme.md`-style wrap-continuation lines that start
 *     with `read` but no space; on a hit the first `read` in the line is the verb itself.
 */
function capitalizeReadVerb(line: string): string {
	const verbEnd = line.indexOf(FG_RESET);
	const head = verbEnd === -1 ? line : line.slice(0, verbEnd);
	const visible = head.replace(SGR_SEQUENCE, "");
	if (visible !== "read" && !visible.startsWith("read ")) return line;
	const at = head.indexOf("read");
	return head.slice(0, at) + "Read" + line.slice(at + "read".length);
}

/**
 * The entry over a title's line array: **first line only**. The verb can only appear on
 * the first line; continuation rows are all path / label, and a `read ` fragment there
 * (a dir/file name with a space wrapped to a line start) must not be miscapitalized.
 */
function capitalizeReadTitle(lines: string[]): string[] {
	if (lines.length === 0) return lines;
	const [first, ...rest] = lines;
	return [capitalizeReadVerb(first), ...rest];
}

/**
 * Swap the **path** color inside pi's rendered title row from `accent` to `text`.
 *
 * Why **replace the SGR** rather than rebuild the row: this branch (fitting short paths)
 * deliberately keeps pi's native render — wrapping, OSC 8 hyperlinks, `[skill]` /
 * `read docs` / `read resource` compact shapes, `(ctrl+o to expand)` hints are all pi's
 * own decisions; this extension only changes one color. In pi's read title, `accent` is
 * used only on the path (`renderToolPath()`) or a compact shape's label
 * (`formatCompactReadCall`'s docs / resource branches); a `skill` label goes through
 * `customMessageText` and is unaffected.
 *
 * **Only the segment after the verb is swapped**: the verb (`read`) is the row's first
 * color segment and the first `\x1b[39m` is its end; the `accent` after it is the path.
 * This is not cleverness for its own sake — when a skin sets `accent` and `toolTitle` to
 * the same palette color (upstream catppuccin's mauve does), a whole-row replacement
 * would recolor the verb to `text` too — both segments still identical — exactly the
 * symptom this extension exists to remove.
 *
 * When the two colors are the same (a skin setting `accent` = `text`), return verbatim
 * — no pointless rewriting; `getFgAnsi` returns the very sequence pi itself emits
 * (right in both truecolor and 256-color modes).
 */
function recolorToolPath(line: string, theme: any): string {
	const accent = theme.getFgAnsi("accent");
	const text = theme.getFgAnsi("text");
	if (!accent || accent === text) return line;
	const verbEnd = line.indexOf(FG_RESET);
	if (verbEnd === -1) return line.split(accent).join(text);
	const cut = verbEnd + FG_RESET.length;
	return line.slice(0, cut) + line.slice(cut).split(accent).join(text);
}

/** The compressed full-path shape: `read …<tail path>:<lines>`. */
function compressedPathTitle(args: any, theme: any, cwd: string, budget: number, hyperlinksEnabled: boolean): string {
	const prefix = `${theme.fg("toolTitle", theme.bold("Read"))} `;
	const range = formatReadLineRange(args, theme);
	const rawPath = strArg(args?.path);
	// aligned with pi's renderToolPath: null → `[invalid arg]`, empty → `...` (toolOutput color)
	if (rawPath === null) return `${prefix}${theme.fg("error", "[invalid arg]")}${range}`;
	if (!rawPath) return `${prefix}${theme.fg("toolOutput", "...")}${range}`;
	const styled = theme.fg("text", compressTail(shortenPath(rawPath), budget - visibleWidth(prefix) - visibleWidth(range)));
	const display = hyperlinksEnabled ? hyperlink(styled, pathToFileURL(resolveAgainstCwd(rawPath, cwd)).href) : styled;
	return prefix + display + range;
}

/** The compressed compact shapes: `[skill] …<label>` / `read docs …<label>` / `read resource …<label>`. */
function compressedCompactTitle(
	classification: CompactClassification,
	args: any,
	theme: any,
	budget: number,
	hyperlinksEnabled: boolean,
	cwd: string,
): string {
	const range = formatReadLineRange(args, theme);
	const hint = theme.fg("dim", ` (${expandKeyText()} to expand)`);
	const isSkill = classification.kind === "skill";
	const prefix = isSkill
		? theme.fg("customMessageLabel", "\x1b[1m[skill]\x1b[22m ")
		: `${theme.fg("toolTitle", theme.bold(`Read ${classification.kind}`))} `;
	// budget with the hint first; too narrow to leave MIN_LABEL_WIDTH for the label → drop the hint and recompute
	let suffix = hint;
	let labelBudget = budget - visibleWidth(prefix) - visibleWidth(range) - visibleWidth(hint);
	if (labelBudget < MIN_LABEL_WIDTH) {
		suffix = "";
		labelBudget = budget - visibleWidth(prefix) - visibleWidth(range);
	}
	const styled = theme.fg(isSkill ? "customMessageText" : "text", compressTail(classification.label, labelBudget));
	// docs / resource labels are package paths — they get hyperlinks too (a skill label is a dirname, not a path — none)
	const display =
		hyperlinksEnabled && !isSkill
			? hyperlink(styled, pathToFileURL(resolveAgainstCwd(classification.label, cwd)).href)
			: styled;
	return prefix + display + range + suffix;
}

/**
 * The left margin's total columns: **the dot / space column + one spacing column**
 * (decided by the user 2026-09-21: body shifted right one column).
 *
 * The first row is `•` + a space; the rest are two spaces. Body (title and result)
 * follows it. Same look as `bash-command-collapse.ts`'s `INDENT_WIDTH` (the extra column
 * beyond the gutter): both blocks' left edges align. **Changing this must change the bash
 * side too** — or the two tools' blocks slide one column apart.
 */
const MARGIN_WIDTH = 2;
/**
 * The body's right-side blank columns — the same convention as the bash block: body
 * never touches the terminal's right edge, one blank column trails.
 * So the child's body budget is `width - MARGIN_WIDTH - RIGHT_PAD` — with the left
 * margin attached it still lands 1 column short of the edge.
 */
const RIGHT_PAD = 1;
/** The left margin for non-first rows (all spaces). */
const MARGIN_BLANK = " ".repeat(MARGIN_WIDTH);

/**
 * The status dot `•` (U+2022, 1 column) + a foreground reset.
 *
 * All three slots are required by pi's theme schema (`dim` / `toolDiffAdded` /
 * `toolDiffRemoved`), and their **foreground** ANSI is taken; the trailing `\x1b[39m`
 * keeps the color from bleeding into the `Read` that follows — same origin as
 * `bash-command-collapse.ts`'s `stateBarAnsi` (same glyph `•` too).
 *
 * "While reading" = pending: after `tool_execution_start`, before the result (pi's
 * partial state).
 */
function stateBarAnsi(theme: any, isPartial: boolean, isError: boolean): string {
	const slot: ThemeColor = isPartial ? "dim" : isError ? "toolDiffRemoved" : "toolDiffAdded";
	return `${theme.getFgAnsi(slot)}\u2022\u001b[39m`;
}

/**
 * Hang `• ` on the **first row** and pad the rest with two spaces — same approach as
 * `bash-command-collapse.ts`'s `withHeadBar` (that side paints it on the command's first
 * row; here it goes on the `Read <path>` row).
 */
function withHeadBar(lines: string[], bar: string): string[] {
	return lines.map((line, index) => (index === 0 ? `${bar} ${line}` : MARGIN_BLANK + line));
}

/**
 * Pad every result-body line with the two-column margin — the same margin as the title
 * row, so the path column inside `Read <path>` aligns with the result body's columns.
 *
 * **Leading blank lines are stripped too** (`stripLeadingBlanks`): pi's read result body
 * is `new Text("\n" + …)`, and that `\n` would paint a whole blank row between title and
 * body. The bash side strips the same leading blank deliberately (three blank rows
 * otherwise); consistent here — the block is "title + tightly-following body": no
 * border blanks above/below, no blank line inside either (the user's 2026-09-21 look).
 */
function withBodyIndent(lines: string[]): string[] {
	const out = lines.slice();
	while (out.length > 0 && out[0]!.replace(/\x1b\[[0-9;]*m/g, "").trim() === "") out.shift();
	return out.map((line) => (line === "" ? line : MARGIN_BLANK + line));
}

/**
 * Wrap a block (title / result) in a `Box(0, 0)` **with no background**.
 *
 * The `Box` only does "fill the full width + leave the right-edge blank" — no
 * background, no border rows: exactly the user's "read block has no background, no
 * top/bottom blank rows" (see the file header's "block shell"). The child draws its own
 * left edge (2 columns), so the `render` passed in must render at `width - 2`.
 */
function shellFor(render: (width: number) => string[]) {
	const box = new Box(0, 0);
	box.addChild({
		render(width: number): string[] {
			return render(Math.max(1, width - MARGIN_WIDTH - RIGHT_PAD));
		},
		invalidate() {},
	});
	return box;
}

/**
 * The component wrapper: pi-rendered ≤ 1 line → verbatim; > 1 line → the compressed
 * title.
 * The compressed result caches by width — `render(width)` is called every frame and a
 * terminal resize recomputes automatically.
 */
function createCollapsedCallComponent(
	inner: any,
	options: {
		args: any;
		theme: any;
		cwd: string;
		expanded: boolean;
		isEnabled: () => boolean;
		/** The command still running (after `tool_execution_start`, before the result) → the dot is `dim`. */
		isPartial: boolean;
		/** This result is an error (`context.isError`) → the dot is `toolDiffRemoved`. */
		isError: boolean;
	},
) {
	// the cache stores **un-margined, uncolored** body rows; the margin (incl. color) is re-joined per render —
	// another state in the cache key would be easy to forget invalidating, and joining a two-column prefix is cheap.
	const cache = new Map<number, string[]>();
	// the margin's two columns are drawn by the box's child itself (`Box(0, 0)` does not subtract them), so `width` here is already
	// the body budget after margin + right-edge blank (see `shellFor`).
	return {
		render(width: number): string[] {
			const lines: string[] = inner.render(width);
			const body = (out: string[]) => withHeadBar(out, stateBarAnsi(options.theme, options.isPartial, options.isError));
			// the switch off → back to pi's native render (incl. path color, see `PI_READ_COLLAPSE=off`); the tool name still capitalizes
			if (!options.isEnabled()) return body(capitalizeReadTitle(lines));
			// not overlong (a short path — most reads) → only the path's color swaps to `text`; everything else stays pi's
			if (lines.length <= 1) return body(capitalizeReadTitle(lines.map((line) => recolorToolPath(line, options.theme))));
			const fixedWidth = visibleWidth(`${options.theme.fg("toolTitle", options.theme.bold("Read"))} `) + visibleWidth(ELLIPSIS);
			if (width - fixedWidth < 1) return body(capitalizeReadTitle(lines));
			const hit = cache.get(width);
			if (hit) return body(hit);
			const hyperlinksEnabled = piTitleUsesHyperlink(inner, lines);
			const classification = options.expanded ? undefined : getCompactClassification(options.args, options.cwd);
			const line = classification
				? compressedCompactTitle(classification, options.args, options.theme, width, hyperlinksEnabled, options.cwd)
				: compressedPathTitle(options.args, options.theme, options.cwd, width, hyperlinksEnabled);
			// extreme-narrow fallback: when the fixed parts (prefix + line range, or the compact hint) are already wider than the row,
			// the compressed title still overflows — pi's own wrapped render looks no worse then; hand it back.
			if (visibleWidth(line) > width) return body(capitalizeReadTitle(lines));
			// the cache stores **marginless** body rows; the margin (incl. status color) is re-joined inside `body`
			cache.set(width, [line]);
			return body([line]);
		},
		invalidate() {
			cache.clear();
			inner.invalidate?.();
		},
	};
}

export default function (pi: ExtensionAPI) {
	const enabled = process.env.PI_READ_COLLAPSE?.trim().toLowerCase() !== "off";

	// cwd is only a fallback: the built-in execute uses ctx.cwd (the session cwd of each call),
	// and renderCall uses context.cwd — this value is not read.
	const base = createReadToolDefinition(process.cwd());

	pi.registerTool({
		// spread rather than field-copy: `description` / `parameters` / `promptSnippet` /
		// `promptGuidelines` / `constrainedSampling` / `execute` all inherit verbatim
		// (prompt metadata does not inherit automatically — it must be carried explicitly).
		...base,
		// `renderShell: "self"`: pi stops wrapping in `contentBox` — so the read block has **no background**
		// and none of the default shell's two border rows (see the file header's "block shell"). The left margin is self-drawn
		// (`withHeadBar`) — same look as the bash block. **Only read is affected**: the other tools keep pi's default shell.
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state;
			// critical: the lastComponent handed to the built-in must be the **inner** Text, never our wrapper,
			// or the built-in's `setText()` throws and pi silently falls back to a bare `read` title (see the file header).
			const inner = base.renderCall?.(args, theme, { ...context, lastComponent: state.innerText }) ?? new Text("", 0, 0);
			state.innerText = inner;
			return shellFor(
				(logicalWidth) =>
					createCollapsedCallComponent(inner, {
						args,
						theme,
						cwd: context.cwd,
						expanded: context.expanded,
						isEnabled: () => enabled,
						// "while reading" = partial (after `tool_execution_start`, before the result)
						isPartial: context.isPartial === true,
						isError: context.isError === true,
					}).render(logicalWidth),
			);
		},
		// the result side goes into the same shell: every line of ``\n` + body` gets the two-space indent so it aligns with the title's margin;
		// no background / border rows either. `context.lastComponent` likewise gets the **inner** Text (same trap).
		renderResult(result, options, theme, context) {
			const state = context.state;
			const inner =
				base.renderResult?.(result, options, theme, { ...context, lastComponent: state.innerResultText }) ??
				new Text("", 0, 0);
			state.innerResultText = inner;
			return shellFor((logicalWidth) => withBodyIndent(inner.render(logicalWidth)));
		},
	});
}
