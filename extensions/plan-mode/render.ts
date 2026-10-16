/**
 * plan-mode's display layer: the statusline text.
 *
 * Imports no pi / pi-tui — colors come through the injected `fg(slot, text)`, so `node --test`
 * asserts each text directly.
 *
 * ## Why a single `setStatus` key
 *
 * The local statusline extension splices other extensions' `ctx.ui.setStatus()` texts into a
 * second row (`formatExtensionStatuses`, max 5, ` | ` separated) — the fewer keys the better.
 * Both states share the `plan-mode` key: plan gets its text, bypass sends `undefined` to clear
 * it, leaving no gap on the second row.
 *
 * After the execute state was deleted on 2026-09-24 **there is no steps widget anymore** — a
 * plan is a markdown document with no per-step checkboxes; progress belongs to the model (it
 * calls `task_set` itself if it wants a task list — that is simple-task's widget's job).
 *
 * ## Colors
 *
 * The status row uses `warning` (matching the "waiting for your call" semantics), the
 * doc-writing sub-state uses `accent` — both semantic slots present in all three themes; no
 * hard-coded color values.
 */

import type { PlanPhase } from "./plan.ts";

export const STATUS_KEY = "plan-mode";

export interface PlanTheme {
	fg(color: string, text: string): string;
}

export interface PlanStatusSource {
	phase: PlanPhase;
	/** plan state: the model has submitted, awaiting user approval. */
	pending?: string;
	/** plan state: the doc-writing sub-state. */
	docWriting?: boolean;
}

/**
 * The text for statusline's second row. **Both states have text** — bypass shows too, so
 * "which mode am I in" always has a fixed display slot (this cell used to belong to
 * simple-task's `✔ n/N`, which duplicated the widget above the editor — it was yielded to
 * the mode indicator).
 *
 *   ⏵ bypass                  normal mode (full access)
 *   ⏸ plan                    waiting for the model to submit a plan
 *   ⏸ plan · awaiting approval  submitted, awaiting user approval
 *   ⏸ plan · writing doc        doc-writing sub-state (model turning the plan into a file)
 */
export function formatPlanStatus(theme: PlanTheme, source: PlanStatusSource): string {
	if (source.phase === "plan") {
		const label = theme.fg("warning", "⏸");
		if (source.docWriting) {
			return `${label} ${theme.fg("warning", "plan")} ${theme.fg("accent", "· writing document")}`;
		}
		if (source.pending) return `${label} ${theme.fg("warning", "plan")} ${theme.fg("muted", "· awaiting approval")}`;
		return `${label} ${theme.fg("warning", "plan")}`;
	}
	// bypass: `toolDiffRemoved` (the deleted-line foreground) instead of `dim` — that slot resolves to red in all three skins
	// (ayu #D95757 / catppuccin #F38BA8 / summer-night #e27878), making "full access" instantly visible: protection off,
	// not "nothing enabled".
	// note **plan's color is unchanged** (warning) — that is the state to read carefully.
	return `${theme.fg("toolDiffRemoved", "⏵")} ${theme.fg("toolDiffRemoved", "bypass")}`;
}
