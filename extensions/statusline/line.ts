/**
 * line.ts — pure formatting of the statusline's main row / status row
 *
 * This module **imports no pi / pi-tui** (it describes the needed fields via minimal
 * structural interfaces), so `node --test` can drive every branch with fakes; pi's
 * real `Theme` / `ExtensionContext` / `ReadonlyFooterDataProvider` are structurally
 * compatible and index.ts passes them in verbatim.
 */

/** The pi `Theme.fg` subset (the method is declared bivariant — a real Theme assigns directly). */
export interface StatuslineTheme {
	fg(color: string, text: string): string;
}

/** The ctx pieces the main row needs (`thinkingLevel` is a live getter on pi's ctx — optional and can throw). */
export interface StatuslineSource {
	model: { id?: string } | undefined;
	thinkingLevel?: string;
	getContextUsage(): { tokens?: number | null; contextWindow?: number; percent: number | null | undefined } | undefined;
}

/** The footerData pieces needed. */
export interface StatuslineGitSource {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

export interface DiffStat {
	added: number;
	deleted: number;
}

export interface StatuslineState {
	streaming: boolean;
	/** Read-only on the render path — only index.ts's event callbacks mutate it. */
	activeTools: Map<string, number>;
	/** undefined = not read yet / not a git repo. */
	diffStat: DiffStat | undefined;
}

export const SEPARATOR = " | ";
export const ELLIPSIS = "…";
/**
 * The model segment's prefix icon (replaces the earlier `Model:` text label — 4
 * columns saved).
 * Deliberately **uncolored**: an emoji is a self-colored glyph, and a `theme.fg` wrap
 * only adds a pair of ANSI codes with no visual effect. pi-tui's `visibleWidth`
 * measures it as 2 columns (RGI emoji), matching real terminals — `truncateToWidth`'s
 * math is unaffected.
 * Carries VS16 (U+FE0F) to force emoji presentation: a bare `\u26a1` also measures 2
 * columns in pi-tui, but VS16 guarantees individual terminals/fonts do not render it
 * as a monochrome narrow glyph (which would misalign the width rule by 1 column).
 */
export const MODEL_ICON = "⚡️";
/**
 * The branch segment's prefix icon: `ᗌ` (U+15CC, CANADIAN SYLLABICS CARRIER RE —
 * the glyph happens to look like a fork).
 * It replaced the private-use Powerline / Nerd Font glyph U+E0A0 — that codepoint is
 * just an invisible box where the font lacks it (earlier candidates were `⎇`(U+2387)
 * and `⑂`(U+2442, OCR FORK)). The source still writes the escape and tests pin the
 * codepoint, preventing a future swap to a lookalike (same block's `ᗋ`(U+15CB) /
 * `ᗍ`(U+15CD) / `ᗎ`(U+15CE) look nearly identical).
 * pi-tui's `visibleWidth` measures it 1 column, East Asian Width = Neutral (not
 * Ambiguous), so `truncateToWidth`'s budget needs no change and no CJK-width
 * 2-column misalignment exists.
 * Glyph availability (scanned every local font with fontTools on 2026-09-20): none
 * of the Ghostty font stack's three fonts (`Lyth Mono Term` / `JetBrainsMonoNL Nerd
 * Font Mono` / `Maple Mono SC NF`) **has** U+15CC — it falls back to the system;
 * macOS covers it via `Euphemia UCAS` (advance ≈ 0.98 cells) and
 * `Noto Sans CanAborig`, so it never drops to a missing-glyph box; the terminal lays
 * glyphs out at fixed cell width, so a 0.98 advance does not hurt alignment. If it
 * ever shows as a box somewhere without such fallback fonts, fall back to U+2442
 * (Lyth Mono Term has it) or U+E0A0 (Nerd Fonts have it).
 */
export const BRANCH_ICON = "\u15cc";
/** The leading indent: the row is never flush-left. */
export const LEADING_INDENT = " ";
/** This extension's own setStatus key (for clearing leftovers; also skipped at render). */
export const STATUSLINE_KEY = "statusline";
/**
 * Status keys forced to the front, in this array's order; everything else follows
 * in registration order.
 *
 * Why not plain registration order: **the mode indicator must sit at the row's
 * start**. It follows segments that grow (path, checkpoint counts…), and row two is
 * "truncate-only, never wrap" — at the tail one long path would push it out of
 * sight. Registration order follows the order pi loads extensions in (directory
 * alphabetical) — writing it there means a rename changes it; too fragile.
 */
export const STATUS_PRIORITY = ["plan-mode"] as const;
const MAX_STATUS_ITEMS = 5;

/** The main row: `⚡️ x/xhigh | Ctx 0.0% | \u15cc branch | (+a,-b)[ | status]` — segments already colored. */
export function formatMainLine(
	theme: StatuslineTheme,
	source: StatuslineSource,
	git: StatuslineGitSource,
	state: StatuslineState,
): string {
	const branch = git.getGitBranch();
	const segments = [
		formatModelSegment(theme, source),
		formatContextSegment(theme, source),
		formatBranchSegment(theme, branch),
		formatDiffSegment(theme, branch, state.diffStat),
		formatStateSegment(theme, state),
	].filter((segment): segment is string => Boolean(segment));
	return segments.join(dim(theme, SEPARATOR));
}

/**
 * The footer's full output: one main row (+ an optional status row), always leading
 * with one space, truncating to ellipsis on overflow, never wrapping.
 * `truncate` is pi-tui's `truncateToWidth` injected by index.ts (ANSI /
 * wide-char safe), so even this key rule is asserted in unit tests.
 */
export function composeFooterLines(
	theme: StatuslineTheme,
	source: StatuslineSource,
	git: StatuslineGitSource,
	state: StatuslineState,
	width: number,
	truncate: (text: string, width: number, ellipsis: string) => string,
): string[] {
	if (width <= 0) return [];
	const lines = [`${LEADING_INDENT}${formatMainLine(theme, source, git, state)}`];
	const statuses = formatExtensionStatuses(theme, git);
	if (statuses) lines.push(`${LEADING_INDENT}${statuses}`);
	return lines.map((line) => truncate(line, width, ELLIPSIS));
}

/**
 * The second row: other extensions' `ctx.ui.setStatus()` texts (mode indicator /
 * cwd / rewind checkpoint …).
 * Text arriving with its own ANSI renders verbatim (those extensions already
 * colored it); uncolored text gets muted.
 *
 * Order: `STATUS_PRIORITY` first (the mode indicator leads the row), the rest in
 * registration order.
 */
export function formatExtensionStatuses(theme: StatuslineTheme, git: StatuslineGitSource): string {
	const entries = [...git.getExtensionStatuses().entries()].filter(
		([key, value]) => key !== STATUSLINE_KEY && value.trim().length > 0,
	);

	const rank = (key: string): number => {
		const index = (STATUS_PRIORITY as readonly string[]).indexOf(key);
		return index === -1 ? STATUS_PRIORITY.length : index;
	};
	// stable ordering: equal ranks keep Map insertion order (`Array.prototype.sort` is stable on modern V8)
	const ordered = entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => rank(a.entry[0]) - rank(b.entry[0]) || a.index - b.index)
		.map((wrapped) => wrapped.entry);

	const visible = ordered
		.slice(0, MAX_STATUS_ITEMS)
		.map(([, value]) => (hasAnsi(value) ? value : theme.fg("muted", value.trim())));
	return visible.join(dim(theme, SEPARATOR));
}

/** Model icon + id + reasoning level: `⚡️ qwen3.8-flash/xhigh` (id in accent, slash dim, level in syntaxFunction); unreadable level (stale ctx) → just the id. */
function formatModelSegment(theme: StatuslineTheme, source: StatuslineSource): string {
	const id = readModel(source)?.id ?? "no-model";
	const level = readThinkingLevel(source);
	const suffix = level ? `${dim(theme, "/")}${theme.fg("syntaxFunction", level)}` : "";
	return `${MODEL_ICON} ${theme.fg("accent", id)}${suffix}`;
}

function formatContextSegment(theme: StatuslineTheme, source: StatuslineSource): string {
	const usage = readContextUsage(source);
	const percent = typeof usage?.percent === "number" && Number.isFinite(usage.percent) ? usage.percent : null;
	const percentText = percent === null ? "?" : `${percent.toFixed(1)}%`;
	const tokens = usage?.tokens;
	const capacity = usage?.contextWindow ?? readModel(source)?.contextWindow;
	const count = (value: number | null | undefined) => {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
		if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
		if (value >= 1000) return `${Math.round(value / 1000)}k`;
		return Math.round(value).toString();
	};
	const counts = tokens != null || capacity != null ? `${count(tokens)}/${count(capacity)} ` : "";
	return `${dim(theme, "Ctx")} ${dim(theme, counts)}${theme.fg(contextColor(percent), percentText)}`;
}

function formatBranchSegment(theme: StatuslineTheme, branch: string | null): string {
	if (!branch) return "";
	return `${dim(theme, BRANCH_ICON)} ${theme.fg("accent", branch)}`;
}

function formatDiffSegment(
	theme: StatuslineTheme,
	branch: string | null,
	diffStat: DiffStat | undefined,
): string {
	if (!branch) return "";
	return `${dim(theme, "(")}${theme.fg("success", `+${diffStat?.added ?? 0}`)}${dim(theme, ",")}${theme.fg("error", `-${diffStat?.deleted ?? 0}`)}${dim(theme, ")")}`;
}

/** The trailing state segment: a tool running → its name (with a count when concurrent), else streaming → thinking, idle → the segment is absent; the whole segment is warning-colored. */
function formatStateSegment(theme: StatuslineTheme, state: StatuslineState): string | undefined {
	const active = [...state.activeTools.entries()];
	if (active.length > 0) {
		const [name, count] = active[0] ?? ["tool", 1];
		const suffix = count > 1 ? `×${count}` : active.length > 1 ? `+${active.length - 1}` : "";
		return theme.fg("warning", `${name}${suffix}`);
	}
	return state.streaming ? theme.fg("warning", "thinking") : undefined;
}

function contextColor(percent: number | null): string {
	if (percent === null) return "dim";
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

/** ctx getters can throw after a session swap (stale ctx) — the statusline is not worth a broken render. */
function readContextUsage(
	source: StatuslineSource,
): ReturnType<StatuslineSource["getContextUsage"]> {
	try {
		return source.getContextUsage();
	} catch {
		return undefined;
	}
}

/** thinkingLevel can also throw on a stale ctx — always falls back to "no level". */
function readThinkingLevel(source: StatuslineSource): string | undefined {
	try {
		const level = source.thinkingLevel;
		return typeof level === "string" && level.length > 0 ? level : undefined;
	} catch {
		return undefined;
	}
}

/** ctx.model can throw on a stale ctx too — always read through here. */
function readModel(
	source: StatuslineSource,
): { id?: string; contextWindow?: number } | undefined {
	try {
		return source.model;
	} catch {
		return undefined;
	}
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/;

function hasAnsi(value: string): boolean {
	return ANSI_PATTERN.test(value);
}

function dim(theme: StatuslineTheme, text: string): string {
	return theme.fg("dim", text);
}
