/**
 * widget.ts — the list rendering, styled after @tintinweb/pi-tasks.
 *
 * The style elements copied over (pi-tasks `src/ui/task-widget.ts`):
 *   - one header row: `● N tasks (X done, Y in progress, Z open)`, all accent
 *   - task rows indented two spaces, format `  <glyph> <dim #id> <text>`
 *   - done: success-colored glyph + dim strikethrough text
 *   - in progress: accent star-spinner frame + accent text + ellipsis (still running)
 *   - pending: uncolored glyph (◻) + plain text
 *   - overflow: `    … and N more`, dim
 *   - each line truncates to the terminal width with "..." (three ASCII dots), not
 *     "…" — pi-tasks's `truncation` default, whose comment says it is pi-tui's own
 *     default.
 *
 * **All colors go through theme.fg()** — not one hardcoded color, so the palette
 * follows the pi theme; a theme change needs nothing here.
 *
 * Before 2026-09-24 the header was not drawn while plan-mode mirrored entries
 * existed (that mirroring was removed together with plan-mode's execute state — the
 * header is always drawn again).
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { countByStatus, type State } from "./types.ts";

export const GLYPHS = {
	header: "●",
	pending: "◻",
	inProgress: "◼",
	done: "✔",
	overflow: "…",
	truncation: "...",
} as const;

/** pi-tasks's star-spinner frame sequence, used verbatim. */
// the final ✽ of pi-tasks's original sequence was deliberately dropped — it is heavier than the frames before it and looks abrupt mid-spin.
export const SPINNER = ["+", "✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼"] as const;

/** pi-tasks's DEFAULT_MAX_VISIBLE_TASKS. Beyond it folds into "… and N more". */
export const MAX_VISIBLE = 10;

export function buildWidgetLines(state: State, frame: number, theme: Theme, width: number): string[] {
	const tasks = state.tasks;
	if (tasks.length === 0) return [];

	const safeWidth = Math.max(1, width);
	const truncate = (line: string): string => truncateToWidth(line, safeWidth, GLYPHS.truncation);

	const { done, inProgress, pending } = countByStatus(state);
	const parts: string[] = [];
	if (done > 0) parts.push(`${done} done`);
	if (inProgress > 0) parts.push(`${inProgress} in progress`);
	if (pending > 0) parts.push(`${pending} open`);
	const noun = tasks.length === 1 ? "task" : "tasks";
	const statusText = `${tasks.length} ${noun} (${parts.join(", ")})`;

	// the header is always drawn: it is the only totals row of the block. (Before 2026-09-24 it was hidden
	// while plan-mode mirrored entries existed — that mirroring was removed with plan-mode's execute state.)
	const lines: string[] = [truncate(`${theme.fg("accent", GLYPHS.header)} ${theme.fg("accent", statusText)}`)];

	const visible = tasks.slice(0, MAX_VISIBLE);
	const hidden = tasks.length - visible.length;

	for (const task of visible) {
		const dimId = theme.fg("dim", `#${task.id}`);

		if (task.status === "done") {
			// a done task: success glyph + dim strikethrough text (id and text struck through together)
			const glyph = theme.fg("success", GLYPHS.done);
			lines.push(truncate(`  ${glyph} ${theme.fg("dim", theme.strikethrough(`#${task.id} ${task.text}`))}`));
			continue;
		}

		if (task.status === "in_progress") {
			// in progress: the star frame turns with `frame`; accent text + ellipsis means not finished
			const glyph = theme.fg("accent", SPINNER[frame % SPINNER.length]);
			lines.push(truncate(`  ${glyph} ${dimId} ${theme.fg("accent", task.text + GLYPHS.overflow)}`));
			continue;
		}

		lines.push(truncate(`  ${GLYPHS.pending} ${dimId} ${task.text}`));
	}

	if (hidden > 0) {
		lines.push(truncate(theme.fg("dim", `    ${GLYPHS.overflow} and ${hidden} more`)));
	}

	return lines;
}

