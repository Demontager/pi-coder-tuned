/**
 * plan-mode's text layer: the context injected for the model, and plan truncation for the
 * approval dialog.
 *
 * Imports no pi / pi-tui, so it is directly unit-testable.
 *
 * ## The plan's shape: a markdown document, not a step list
 *
 * `exit_plan_mode`'s argument mirrors Claude Code's `ExitPlanMode(plan)` — what the model
 * hands up is the **complete plan text** it wants the user to see. Before 2026-09-24 this was
 * `steps: [{text}]`, a leftover of the "extension holds execution progress" era: steps had to
 * mirror into a task list, progress was tracked as `[DONE:n]`, and the status row reported
 * `▶ n/N`. With progress handed back to the model, structured steps have only display value
 * left (the doc-name slug now comes from `exit_plan_mode`'s `slug` parameter instead of being
 * scraped from the plan text), and a markdown section covers that too — keeping steps would
 * only push the model to shred the plan into one-line items, losing the background and
 * trade-offs (exactly what the plan document exists to keep).
 *
 * ## Why not "extract a plan from the reply's prose"
 *
 * The official plan-mode example scans replies for a `Plan:` section and pulls a numbered
 * list; this extension does not — the only entry for a plan is the `exit_plan_mode` tool
 * argument. A tool call is an unambiguous signal; one extra call is worth eliminating a whole
 * class of false positives.
 */

import type { PlanDocMode } from "./plan.ts";

// =============================================================================
// Plan truncation for the approval dialog
// =============================================================================

/**
 * Rows the dialog occupies besides the plan body. Measured on
 * `ExtensionSelectorComponent.render(100)`'s output: 2 borders + 4 blank + 1 title + the
 * option rows + 1 shortcut hint. Three choices is one row more than two, so the base is
 * **11**. Below `NARROW_COLUMNS` the hint row wraps to two lines — one more (measured
 * W=40 → 12).
 */
const DIALOG_CHROME_LINES = 11;
const DIALOG_CHROME_LINES_NARROW = 12;
const NARROW_COLUMNS = 50;

/**
 * Rows still reserved **below** the dialog: 2 statusline rows (main + extension statuses) +
 * 1 belowEditor widget row + 2 rows of headroom.
 *
 * Why reserve: pi uses main-screen rendering (`tui-main-screen.js`) — every repaint pins the
 * viewport to `bufferLength - height`, i.e. **only the last `height` rows ever show**. The
 * dialog sits at `editorContainer` in the component tree, with `widgetContainerBelow` and
 * `footerContainer` beneath it — whatever they occupy is subtracted from the dialog's
 * visible rows. Without the reserve, the dialog's top (the plan's beginning) scrolls off.
 */
const BELOW_DIALOG_RESERVE = 5;

/** `Text`'s horizontal padding (`paddingX = 1` at construction): body usable width = terminal columns − 2. */
const DIALOG_PADDING_X = 1;

/** The trailing hint line appended after truncation takes 1 row. */
const HINT_LINES = 1;

/** The dialog's measure-and-render capabilities (injected by the caller; this module imports no pi-tui). */
export interface DialogMetrics {
	/** Terminal rows (`process.stdout.rows`, same source as pi-tui `terminal.js`). */
	rows: number;
	/** Terminal columns (`process.stdout.columns`). */
	columns: number;
}

/** Wrapping capability: injecting pi-tui's `wrapTextWithAnsi` gives exactly the dialog's row counts. */
export type WrapFn = (text: string, width: number) => string[];

/** The row budget and body column width the dialog leaves for the plan. */
export function dialogPlanBudget(metrics: DialogMetrics): { budget: number; contentWidth: number } {
	const contentWidth = Math.max(8, metrics.columns - DIALOG_PADDING_X * 2);
	const chrome = metrics.columns < NARROW_COLUMNS ? DIALOG_CHROME_LINES_NARROW : DIALOG_CHROME_LINES;
	return { budget: metrics.rows - chrome - BELOW_DIALOG_RESERVE, contentWidth };
}

/**
 * Truncate a full plan to a height the approval dialog fits in one screen.
 *
 * ## Why truncate
 *
 * `ctx.ui.select(title, options)` is pi's `ExtensionSelectorComponent`: it packs "title +
 * body" into **one non-scrollable `Text`**, `handleInput` only knows ↑↓/enter/esc — no scroll
 * keys — and the main-screen render pins the viewport to the bottom. A long plan is
 * guaranteed unreadable in full; that is not a bug but the component's design boundary.
 *
 * Combined with "freeze repaints during dialogs" (working-indicator subscribes
 * `ui_prompt_start`), the clipped portion still lands in the terminal buffer (`render()` does
 * not crop to screen height), so the user can scroll back for the full text.
 *
 * ## How rows are counted
 *
 * No home-grown wrap estimation — `wrap` is injected by the caller as pi-tui's
 * `wrapTextWithAnsi`, giving row counts identical to the dialog's real render (CJK per-char
 * breaks and hard long-word breaks both count correctly). This module therefore still imports
 * no pi-tui; tests inject a trivial wrapper.
 *
 * The plan is markdown, so height accumulates **per line** (a line takes at least one row;
 * blank lines count too — paragraph spacing is part of readability and squashing it makes
 * things worse).
 */
export function truncatePlanForDialog(plan: string, metrics: DialogMetrics, wrap: WrapFn): string {
	const lines = plan.replace(/\r\n/g, "\n").split("\n");
	const { budget, contentWidth } = dialogPlanBudget(metrics);
	const heights = lines.map((line) => Math.max(1, wrap(line, contentWidth).length));
	const total = heights.reduce((sum, height) => sum + height, 0);

	// fits → return verbatim — short plans take this path, untouched.
	if (total <= budget) return lines.join("\n");

	// the budget cannot even hold "one line + the hint line" (extremely short terminal): emit only the hint, guaranteed within budget.
	if (budget <= HINT_LINES) return `… Plan has ${lines.length} lines (terminal too short; scroll up to read the full plan)`;

	const usable = budget - HINT_LINES;
	const kept: string[] = [];
	let used = 0;
	let fullyKept = 0;

	for (let index = 0; index < lines.length; index++) {
		const height = heights[index]!;
		if (used + height > usable) {
			// the very first line does not fit (it wraps taller than usable): clip it by width so the user gets something, not an empty box.
			if (kept.length === 0) {
				kept.push(truncateToColumns(lines[index]!, usable * contentWidth, wrap));
				fullyKept = 1;
			}
			break;
		}
		kept.push(lines[index]!);
		used += height;
		fullyKept += 1;
	}

	const hidden = lines.length - fullyKept;
	if (hidden > 0) kept.push(`… plus ${hidden} lines (scroll up to read the full plan)`);
	return kept.join("\n");
}

/** Clip by column width: take the first N rows of the injected wrap's output, rejoin, and append an ellipsis. */
function truncateToColumns(text: string, maxColumns: number, wrap: WrapFn): string {
	if (maxColumns <= 0) return "…";
	const wrapped = wrap(text, Math.max(1, maxColumns));
	const first = wrapped[0] ?? "";
	return first.length > 0 ? `${first}…` : "…";
}

// =============================================================================
// Prompts
// =============================================================================

/**
 * The context injected every round during plan (`display: false` — invisible to the user,
 * visible to the model).
 *
 * Three things are spelled out: this is a read-only phase, what can be done, and that
 * `exit_plan_mode` must be called to submit at the end. Rather than abstract demands like
 * "do not modify anything", the concrete path is given (read the code → ask the user via
 * tools → submit the plan).
 */
export function buildPlanModeContext(cwd: string): string {
	return `[PLAN MODE]

You are in read-only exploration. edit / write are unavailable, and Bash writes (redirection, rm, mv, sed -i, git commit, npm install, etc.) are blocked with an explanation. You are not stuck: develop the design first.

Working directory: ${cwd}

In plan mode:
- Read as much context as needed using read / grep / find / ls / read-only Bash.
- Use ask_user_question for choices requiring user input.
- Do not bypass restrictions by writing another way, committing, or installing dependencies.

When ready, call exit_plan_mode with a complete Markdown design: problem, current state and constraints, files and proposed changes, and verification. Include the background discovered during exploration, not just step headings. Supply a 3-5 word lowercase English slug, e.g. m5-entity-runtime, for the approved document filename.
The user decides whether to approve. Write access is unavailable beforehand; do not claim changes are already made.`;
}

// =============================================================================
// Doc-writing sub-state
// =============================================================================

/**
 * The context injected every round during the doc-writing sub-state (`display: false`).
 *
 * The user picked a with-document route in the approval box, and the model must now **turn
 * the submitted plan into a file**. This section is the route's single enforcement point —
 * the document's content is driven entirely by it, so three things must leave no ambiguity:
 *
 *   1. **Where to write**: `docPath` is the absolute path the extension computed
 *      (`.pi/plans/YYYY-MM-DD-<slug>.md`); the model must not pick its own — the `tool_call`
 *      hook only allows this one path, and writing elsewhere gets refused.
 *   2. **What to write**: organize the full `plan` into a document. The reader is "a
 *      zero-context executor" (possibly a fresh session, possibly someone else), so the
 *      background found during exploration, the files involved, and how each step is verified
 *      must all be there — not the plan compressed into one-line steps.
 *   3. **Done when written**: no more tool calls needed. The extension sees the write succeed
 *      in `tool_result` and wraps up automatically (back to bypass, write access restored),
 *      handing the wrap-up instruction to the model.
 *
 * **The boundary is unchanged** and must be said: still read-only — bash writes stay blocked,
 * and the only writable thing is this one plan file (via the write tool). Otherwise the model
 * would take "approved" as license to start editing code — while the doc-only route must not
 * execute at all.
 */
export function buildDocWriteContext(docPath: string, plan: string, summary?: string): string {
	const summaryLine = typeof summary === "string" && summary.trim() !== "" ? summary.trim() : "(no summary provided)";
	return `[WRITE PLAN DOC]

The user approved this design and requested a plan document first.

**Target file (use this exact path)**: \`${docPath}\`
Use the write tool. This is the only writable file in this phase. Everything else remains read-only: edit is unavailable and Bash writes are blocked.
**Do not start changing code.** Writing the plan does not start implementation.

Design summary: ${summaryLine}

Full submitted design (format as a document; retain background and tradeoffs):

${plan}

Write for an implementer with **no prior context** (another session or person). Suggested structure:

\`\`\`markdown
# <Plan title>

## Summary
<Problem and solution in one paragraph>

## Background
<Current behavior, reasons for changes, constraints and pitfalls>

## Files
<Files to change/create and their responsibilities>

## Implementation steps
<Ordered changes: functions, fields, edge cases>

## Verification
<Test commands, expected results, manual checks>

## Risks and open questions
<Tradeoffs, unresolved points, pitfalls; None if absent>
\`\`\`

Stop after this write. **Do not call exit_plan_mode or other tools again.** The extension detects the saved document, finishes this phase, and provides the next instructions.`;
}

// =============================================================================
// Wrap-up instructions
// =============================================================================

/**
 * The instruction handed to the model after the plan document lands (the tool-result text).
 *
 * The two routes differ only in "what happens next", but **both must report the document
 * path** — it is the only persistent artifact of this planning and the user must see where
 * it is at a glance.
 *
 * `doc-only`'s wording has to be extra firm: by wrap-up time write access is already restored
 * (returning to bypass is the only moment the tool set is restored), so the model is fully
 * capable of casually starting to edit — while the user explicitly chose "write the document
 * only". So this is not "please don't" — it is "stop".
 *
 * `execute-with-doc` explicitly does **not** demand a task list: progress is the model's own
 * call (the core of this change — the extension no longer mirrors steps or holds progress).
 * It is only told where the doc is and that it can consult it.
 */
export function buildDocWrittenMessage(docMode: PlanDocMode, docPath: string): string {
	if (docMode === "doc-only") {
		return `Plan document saved: \`${docPath}\`

The user selected **document only, no implementation**. Although write access is restored, **stop now**: report the document path. Do not change code, create a task list, or continue. Wait for the user to request implementation.`;
	}
	return `Plan document saved: \`${docPath}\`

The user approved implementation; write access is restored. Follow this document:
- It is the authoritative plan. Read it for background, tradeoffs, and verification; it survives context compaction.
- Use task_set when useful for multi-step, cross-file work or progress visibility; omit it for one or two simple actions.
- Perform the documented verification and report results.`;
}

/**
 * The instruction handed to the model when the user sends the plan back (the tool-result
 * text).
 *
 * Stays in plan state (read-only), waiting for the user's next feedback. Wording matches
 * Claude Code: not "you failed" but "the user has feedback — revise accordingly".
 */
export function buildRejectedMessage(): string {
	return `The user did not approve the plan. Remain in plan mode (read-only). Revise it based on the user's next feedback, then resubmit with exit_plan_mode.`;
}
