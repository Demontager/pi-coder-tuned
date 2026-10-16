/**
 * explored-group / render — how the `Explored` group block is drawn.
 *
 * Target shape (user's decision, 2026-10-06, after the fourth revision):
 *
 *     • Explored
 *       └ Search "bashOutput" in clients/pi
 *         **Read** …/ttt/CLAUDE.md, …/ttt/package.json      ← bold = native read tool
 *         Read …/bg-tasks/bg_3.log                          ← not bold = bash (cat/tail)
 *
 * ## Bold = native `read` tool (user's decision, 2026-10-06)
 *
 * `cat f` and the native `read({path: f})` both produce the phrase `Read f`, indistinguishable
 * on screen — yet they are two entirely different things. So **only the native `read` tool**'s
 * line has a bold `Read` verb; Reads derived from bash (`cat` / `sed -n` / `head` / `tail` …)
 * are **not bold**.
 *
 * **Only the word `Read` is bold**; the path / line span after it is never bold.
 *
 * This marker holds because of one hard constraint in `buildEntries`: **consecutive reads merge
 * into one line split by source** — whenever the source changes (native↔bash) a new line starts,
 * so **a single line never mixes sources**, and "is this line bold" fully answers "did the model
 * call the native tool". (Second round, 2026-10-06: groups no longer split by family, so this
 * guarantee moved from "different groups" down to "different lines".)
 *
 * ## The `└ ` appears exactly once per block (user's decision, third round, 2026-10-06)
 *
 * Only the **first line** carries `└ `; all later lines (subsequent member lines, and the
 * continuation lines folded out of a merged `read` line) indent by four spaces and draw no more
 * corners — the same "one `└ ` per block" language as the bash / codemode / web-search result trees.
 *
 * ## Line merging: consecutive `read`s merge into one line, segmented by source
 *
 * The user explicitly asked: "reading two files at once" should show as `└ Read a, b`. Rules:
 *   - Consecutive **read** members (any source) merge onto the same line, separated by `, ` —
 *     but **a source change starts a new line**: `**Read** a, b` and `Read c` each get their own
 *     line (preserving the bold semantics, see the file header)
 *   - Everything else (search / list / git) gets **one line per call**
 *
 * Merging is by **width**, not by fixed count: fill one line, then start the next. Continuation
 * lines folded out of overflow **redraw `Read `** (`Read` is this line's verb; without redrawing
 * it the line is a bare list of paths) but **never redraw `└ `**; the continuation line's `Read`
 * is equally bold (it is still that native call's verb).
 *
 * ## Status is expressed only by **the dot on the group header**
 *
 * The user made it explicit on 2026-10-06: **no check marks in lines, no dots either**. The whole
 * group's status is carried by the single `•` on the header:
 *
 *   | Group status | Dot |
 *   |---|---|
 *   | some member still running | `text` slot — white |
 *   | all finished, no errors | `toolDiffAdded` — green |
 *   | any member errored | `toolDiffRemoved` — red |
 *
 * This is the same idea as "tool blocks get no check marks": status is painted by color alone,
 * never written out as literal markers.
 *
 * ## Expanded mode
 *
 * With `ctrl+o` expanded, `… +N` is not folded; all lines are shown. **The full content of member
 * blocks** in this mode is the responsibility of each member's own renderer — `renderCall`
 * checks `context.expanded`, and expanded members no longer render 0 lines (wiring in
 * `bash-command-collapse.ts` / `read-path-collapse.ts`).
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { phraseForToolCall } from "./phrases.ts";
import { groupOf, type Group, type GroupMember } from "./registry.ts";

/** Maximum member rows drawn per group (the rest fold into a `… +N` line); the expanded mode does not fold. */
export const GROUP_MAX_ROWS = 5;
/** Member line prefix: `└ ` (tree corner + space = 2 columns). Appears **exactly once per block**, on the first line. */
const ROW_PREFIX = "└ ";
/** Leading indent for lines after the first: whitespace the width of `└ `, so text aligns with the first line. */
const ROW_INDENT = "  ";
/** Separator between entries on a merged line. */
const JOINER = ", ";
/** Group header text (user's choice: just "Explored"). */
const TITLE = "Explored";

/** A component that draws nothing (used by member blocks). */
export const EMPTY_COMPONENT = {
	render(): string[] {
		return [];
	},
	invalidate(): void {},
};

/** The dot color slot for group status. */
export type GroupDotSlot = "text" | "toolDiffAdded" | "toolDiffRemoved";

/**
 * The group's synthesized status → dot color slot (user's decision, 2026-10-06):
 * white (`text`) while any member is still running; red when done with errors; green otherwise.
 */
export function groupDotSlot(group: Group): GroupDotSlot {
	if (group.members.some((m) => m.status === "error")) return "toolDiffRemoved";
	if (group.members.some((m) => m.status === "running")) return "text";
	return "toolDiffAdded";
}

/**
 * This member's current status (written by `index.ts` at `tool_execution_end`).
 *
 * A `read`'s path **does not carry the `Read ` prefix** — the merged line draws it once itself
 * (`Read a, b`); having each entry carry it too would produce `Read a, Read b`. Other categories
 * are one line each, with the prefix coming from their phrase.
 */
function labelFor(member: GroupMember, cwd: string | undefined): string {
	const phrase = phraseForToolCall(member.toolName, member.args, cwd) ?? member.toolName;
	if (member.kind === "read" && phrase.startsWith("Read ")) return phrase.slice("Read ".length);
	return phrase;
}

/**
 * Arrange members into "logical lines": each consecutive `read` is one entry; every other
 * category contributes one entry per member.
 *
 * Returns **entries**, not final lines — width splitting happens at render time (entries may be
 * split across lines).
 */
interface RowEntry {
	text: string;
	/** Whether this entry is a read-merged line (decides whether a wrapped line redraws the `Read ` verb). */
	isRead: boolean;
	/**
	 * Whether this entry's member is the **native `read` tool** — if so, the word `Read` is bold.
	 *
	 * Judged by **this line's own source**: when consecutive reads merge, a source change starts a
	 * new line (see `buildEntries`), so a line only ever holds one source; the first member's
	 * `toolName` is enough to decide.
	 */
	boldRead: boolean;
}

/** A final line after wrapping. */
interface OutputRow {
	text: string;
	/** The leading `Read ` is a native tool's verb → bold only it (not the path). */
	boldRead: boolean;
	/** Comes from a read entry (native or bash) → the line span gets colored (see `paintReadSpans`). */
	isRead: boolean;
}

function buildEntries(group: Group, cwd: string | undefined): RowEntry[] {
	const entries: RowEntry[] = [];
	let reads: string[] = [];
	let readsAreNative = false;
	const flush = () => {
		if (reads.length === 0) return;
		entries.push({ text: `Read ${reads.join(JOINER)}`, isRead: true, boldRead: readsAreNative });
		reads = [];
		readsAreNative = false;
	};
	for (const member of group.members) {
		// Members whose arguments have not finished streaming **do not enter the tree** (user's
		// decision, 2026-10-07: "once the bash command finishes streaming … output directly as the
		// collapsed Search"). Without this filter, the in-line text would grow token by token with
		// the model: `└ bash` → `Search "auth"` → `Search "authorization" in proxy/`.
		// The bit is set in `markMemberReady`; a not-ready member's own block also renders 0
		// lines, so genuinely nothing appears on screen.
		if (!member.ready) continue;
		if (member.kind === "read") {
			const isNative = member.toolName === "read";
			// A source change starts a new line: one line must hold one source,
			// otherwise "bold = native tool" immediately loses its meaning
			if (reads.length > 0 && isNative !== readsAreNative) flush();
			if (reads.length === 0) readsAreNative = isNative;
			reads.push(labelFor(member, cwd));
			continue;
		}
		flush();
		entries.push({ text: labelFor(member, cwd), isRead: false, boldRead: false });
	}
	flush();
	return entries;
}

/**
 * Wrap entries into final lines by width (break-all, same semantics as the bash side's
 * `hardWrapRows`: **fill until it genuinely does not fit, then break** — no premature wrapping,
 * avoiding "a mostly-empty line tail").
 *
 * A read-merged line (`Read a, b, c`) first strips `Read `, splits by `, `, and lays the pieces
 * out one by one; continuation lines across breaks **redraw** `Read ` (`Read` is this line's
 * verb; without redrawing it the line is a bare list of paths). `└ ` is not drawn here — only
 * the first line of the block carries it (see the file header).
 *
 * When a single entry **alone exceeds the width** (a long path in a narrow terminal),
 * `hardWrap` applies a hard break — otherwise that line would overflow the terminal and have its
 * tail cut off by pi's renderer (measured at a fixed 40 columns).
 *
 * **Bold only passes the flag here; no ANSI is built**: wrap widths are computed on the
 * **color-stripped visible text**; building ANSI inside `layoutRows` would drag escape sequences
 * into `visibleWidth` and `hardWrap`'s character loop, breaking the width arithmetic on the spot.
 * Coloring is done centrally in `paintRow`.
 */
/**
 * The intermediate shape after wrapping: **preserves "which file it belongs to"**.
 *
 * Flattening each piece's wrap results directly (the earlier `flatMap`) loses ownership, so a
 * continuation chunk looks identical to "the next file" in the main loop — the user's 2026-10-07
 * report "after the first Read wraps, a second Read pops up on the next line" was exactly this:
 * `cat <77-char file name>` wraps into two chunks at 79 columns, and the second chunk got its own
 * `Read ` prefix. A second symptom of the same cause is sneakier: a tail fragment of entry A
 * gets treated as an independent entry and stitched with the real `b.ts` into `Read z, b.ts`
 * (looks like two files were read; actually A was cut up plus a nonexistent name appeared).
 */
interface Chunk {
	text: string;
	/** Whether this is the first chunk of its **file** — only the first chunk carries the `Read ` verb; continuations just indent. */
	startsItem: boolean;
}

function layoutRows(entries: RowEntry[], budget: number): OutputRow[] {
	const rows: OutputRow[] = [];
	for (const entry of entries) {
		if (!entry.isRead) {
			for (const text of hardWrap(entry.text, budget)) rows.push({ text, boldRead: false, isRead: false });
			continue;
		}
		// Each file is first hard-wrapped on its own (spans kept whole by `wrapReadPiece`), then
		// chunks get first/continuation markers. The first chunk always fills `hardWrap`'s budget,
		// so continuation chunks naturally cannot piggyback anything and must own their line.
		const chunks: Chunk[] = entry.text
			.slice("Read ".length)
			.split(JOINER)
			.flatMap((piece) =>
				wrapReadPiece(piece, Math.max(1, budget - "Read ".length), budget)
					.map((text, index) => ({ text, startsItem: index === 0 })));
		let current = "";
		// Whether the current line draws a `Read ` prefix: only when "this line starts from a new
		// file". Wrap continuations of the same file own a line and carry no prefix (user's
		// decision, 2026-10-07).
		let prefixed = false;
		const flush = () => {
			if (current === "") return;
			rows.push({
				text: prefixed ? `Read ${current}` : current,
				boldRead: prefixed && entry.boldRead,
				isRead: true,
			});
			current = "";
			prefixed = false;
		};
		for (const chunk of chunks) {
			if (!chunk.startsItem) {
				// Continuation chunk: flush whatever the current line holds first; this chunk
				// owns a line with no prefix
				flush();
				current = chunk.text;
				prefixed = false;
				continue;
			}
			if (prefixed) {
				const candidate = `${current}${JOINER}${chunk.text}`;
				if (visibleWidth(`Read ${candidate}`) <= budget) {
					current = candidate;
					continue;
				}
			}
			// A new file arrives: continuation lines must not piggyback; always start fresh
			// (with Read)
			flush();
			current = chunk.text;
			prefixed = true;
		}
		flush();
	}
	return rows;
}

/**
 * Wrap one read piece with the **line-number span kept whole** (splitting `100-169` across lines
 * both loses the span and leaves half-colored output).
 *
 * How: the path part wraps break-all as usual, then the span is appended to the last chunk; if
 * it does not fit, that chunk is re-wrapped with room reserved for the span. The span is this
 * line's only structured information; it is worth giving up the character-level fill for it.
 *
 * "Span" is recognized by the trailing ` digits[-digits]` shape, the same convention as
 * `paintReadSpans` — the two must agree, otherwise you get half-processed cases like "wrapping
 * sees a span, coloring does not". The cost: a file named `notes 2024` (space + pure digits, no
 * extension) is treated as having a span (a bit of extra color / one extra wrapped line, purely
 * cosmetic; zero occurrences in the whole measured corpus).
 */
function wrapReadPiece(piece: string, budget: number, rowBudget: number): string[] {
	const match = piece.match(/ (\d+(?:-\d+)?)$/);
	if (!match || match.index === undefined) return hardWrap(piece, budget);
	const span = match[0];
	const head = piece.slice(0, match.index);
	const room = budget - visibleWidth(span);
	// Terminal so narrow that even "Read + span" does not fit (`room <= 0`) → fall back to
	// character-level wrapping; there is no better option
	if (room <= 0 || visibleWidth(`Read ${span}`) > rowBudget) return hardWrap(piece, budget);

	const chunks = hardWrap(head, budget);
	const last = chunks.pop() ?? "";
	if (visibleWidth(last + span) <= budget) {
		chunks.push(last + span);
		return chunks;
	}
	// The last chunk is too long; appending would overflow → re-wrap only this chunk with the
	// span's width reserved; earlier chunks stay untouched
	const tail = hardWrap(last, room);
	const tailLast = tail.pop() ?? "";
	return [...chunks, ...tail, tailLast + span];
}

/** break-all hard wrap (fill by visible columns, then break). */
function hardWrap(text: string, budget: number): string[] {
	if (budget < 1) return [text];
	const out: string[] = [];
	let current = "";
	let used = 0;
	for (const ch of [...text]) {
		const width = visibleWidth(ch);
		if (used + width > budget && current !== "") {
			out.push(current);
			current = "";
			used = 0;
		}
		current += ch;
		used += width;
	}
	if (current !== "" || out.length === 0) out.push(current);
	return out;
}

/**
 * Color the line-number spans on read lines: digits in `warning`, the hyphen between them in the
 * **foreground color** (user's decision, 2026-10-07).
 *
 * The hyphen uses the `text` slot — that is the theme's `fg` variable (`colors.text: "fg"`), i.e.
 * the normal body color; `theme.fg("fg", …)` throws `Unknown theme color: fg`, the slot name is
 * `text`. The user asked for foreground instead of `dim` so the hyphen's brightness matches the
 * path text (`dim` is a deliberately darkened tier).
 *
 * Done on **plain text** (width and wrapping must not be polluted by ANSI, see the comment in
 * `layoutRows`), so coloring happens only here and never affects any line's width.
 *
 * Each `, `-separated piece is handled on its own — a merged line `Read a.ts 100-169, b.ts 1-45`
 * needs both spans colored.
 *
 * Why a "trailing pattern" instead of passing the span down as a structured field: wrapping is
 * break-all, so a span can legitimately end up split across two lines (narrow terminals); its
 * exact position does not exist after wrapping. The pattern anchors on "space + pure digits" at
 * the piece's tail, so paths like `cat v2` (no space) are never mistakenly hit.
 */
function paintReadSpans(text: string, theme: any): string {
	return text
		.split(JOINER)
		.map((piece) => {
			const match = piece.match(/ (\d+)(?:(-)(\d+))?$/);
			if (!match || match.index === undefined) return piece;
			const head = piece.slice(0, match.index);
			const start = theme.fg("warning", match[1]!);
			if (match[2] === undefined) return `${head} ${start}`;
			return `${head} ${start}${theme.fg("text", match[2])}${theme.fg("warning", match[3]!)}`;
		})
		.join(JOINER);
}

/**
 * Assemble a line into its final text: when `Read` is a native tool's verb, **only that word**
 * is bold (user's decision, 2026-10-06); the path is not bold; line-number spans are colored per
 * `paintReadSpans` above (native and bash Reads treated alike).
 *
 * Coloring goes through `theme.bold` / `theme.fg`; this is also the only place the block gets
 * colored — `layoutRows` only passes flags and builds no ANSI (reasoning in its own comment).
 */
function paintRow(row: OutputRow, theme: any): string {
	const text = row.isRead ? paintReadSpans(row.text, theme) : row.text;
	if (!row.boldRead) return text;
	// Only the leading `Read ` can be here (`layoutRows` sets this flag only on read entries)
	return `${theme.bold("Read")}${text.slice("Read".length)}`;
}

/**
 * The `Explored` tree component.
 *
 * Recomputed each frame at the current width (the row list is short and pure string assembly),
 * so member additions and status changes show up immediately — caching would need its own
 * invalidation machinery, not worth it.
 *
 * Width budget: the block's left margin is 2 columns (aligning `• ` with the other tool blocks),
 * and the line prefix `└ ` takes another 2.
 */
export function createGroupTree(options: {
	groupId: string;
	theme: any;
	cwd: string | undefined;
	/** `ctrl+o` expanded mode: do not fold `… +N`. */
	expanded: boolean;
}) {
	return {
		render(width: number): string[] {
			const group = groupOf(options.groupId);
			if (!group || group.members.length === 0) return [];
			// No line ready yet (arguments all still streaming) → **draw not even the group
			// header**: what the user wanted on 2026-10-07 is "it appears once the command
			// finishes streaming", not an empty shell `• Explored` popping up first and growing
			// lines slowly. When members become ready they `notifyLeader` to wake this render,
			// so nothing gets missed.
			if (!group.members.some((m) => m.ready)) return [];
			const theme = options.theme;
			const dot = `${theme.getFgAnsi(groupDotSlot(group))}\u2022\u001b[39m`;
			const lines: string[] = [`${dot} ${theme.fg("toolTitle", theme.bold(TITLE))}`];

			const rowBudget = Math.max(1, width - 4); // left margin 2 + `└ ` 2
			const rows = layoutRows(buildEntries(group, options.cwd), rowBudget);
			const shown = options.expanded ? rows : rows.slice(0, GROUP_MAX_ROWS);
			const hidden = rows.length - shown.length;

			for (const [index, row] of shown.entries()) {
				const prefix = index === 0 ? ROW_PREFIX : ROW_INDENT;
				lines.push(`  ${theme.fg("muted", prefix)}${paintRow(row, theme)}`);
			}
			if (hidden > 0) {
				lines.push(`  ${ROW_INDENT}${theme.fg("muted", `… +${hidden}`)}`);
			}
			return lines;
		},
		invalidate(): void {},
	};
}
