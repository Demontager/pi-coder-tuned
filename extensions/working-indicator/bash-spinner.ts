/**
 * bash-spinner.ts — pure logic for the "bash executing `●`" at the tail of the working line:
 * shape, threshold, and the concurrency registry.
 *
 * Extracted for the same reason as `working-summary.ts`: the shape (`" ●"` and the equal-width
 * space placeholder), the color slot, the threshold and cadence constants, and the "when several
 * bashes run concurrently, which one holds the marker up" state machine are all pure decisions
 * that should not live between `index.ts`'s timers and `ctx.ui`. This module **does not import
 * pi / pi-tui** — `node --test` exercises every branch directly (see `bash-spinner.test.ts`);
 * the timer half (when to blink, when to repaint) lives in the extension.
 *
 * ## Requirement
 *
 * Original text: hang `●` **after** `⠼ Tools Calling (13m 59s)` — it appears once a bash
 * execution has run over 1 second and disappears when execution ends; while multiple bashes run
 * concurrently, it blinks as soon as **any** one crosses 1s and disappears only after **all**
 * bashes finish. Hence:
 *   - threshold and cadence reuse the retired bash first-row spinner (1s threshold, 500ms lit /
 *     500ms dark), and `●` no longer appears inside the bash command block (that first-row `$ ` →
 *     `● ` replacement was reverted per the requirement);
 *   - "holding" is **sticky** (see `BashRunTracker.markCrossed`): once any execution has really
 *     crossed the threshold, the marker stays until the **last** execution ends — otherwise with
 *     "a long command finished while a sibling still runs" the marker would blink off then on
 *     again, looking like a glitch and violating "disappears only after all bashes finish".
 *
 * ## The shape is always 2 columns
 *
 * Lit phase `" ●"` (leading space + marker), dark phase two spaces: **always 2 columns, always 2
 * characters, never an empty string**. If the dark phase were empty, each 500ms blink would shave
 * two columns off the line tail, the `layoutPromptSummary` gap would shift with it, and the
 * right-aligned prompt summary would bounce left and right — the same lesson recorded for
 * tool-diff's title-row `●`. Likewise, the marker segment counts wholly into `leftWidth`
 * (spliced into the left segment in `index.ts` before layout), so the summary position never
 * moves with the blink.
 */

/** Appearance threshold (ms): `●` starts blinking once an execution reaches it. */
export const BASH_SPINNER_DELAY_MS = 1000;
/** Milliseconds each of the lit / dark phases occupies (same cadence as tool-diff's `edit` / `write`). */
export const BASH_SPINNER_BLINK_MS = 500;
/** The marker character. 1 column wide (`visibleWidth("●") === 1`, verified — same source as statusline / tool-diff). */
export const BASH_SPINNER_MARKER = "●";
/** Visible width of the marker segment (= its char count): 1 leading space + 1 marker column. */
export const BASH_SPINNER_WIDTH = 2;
/**
 * Theme color slot. `dim` (the same slot the retired bash first-row spinner used): deeper than
 * the working line's default `muted` — a "secondary but visible" liveness point after the stats
 * segment that does not fight the body for attention.
 */
export const BASH_SPINNER_COLOR = "dim";

/**
 * The marker segment's text (**uncolored**; coloring happens in the extension per
 * `BASH_SPINNER_COLOR`). `on` = lit phase → `" ●"`; dark phase → two spaces. Both states have
 * equal width and char count (see the file header).
 */
export function bashSpinnerSuffix(on: boolean): string {
	return on ? ` ${BASH_SPINNER_MARKER}` : " ".repeat(BASH_SPINNER_WIDTH);
}

/**
 * Registry of concurrent bash executions: `toolCallId → start instant` (booked on
 * `tool_execution_start` / `_end`).
 *
 * The three entry points each own one job: `start` / `end` keep the books, `markCrossed(now)`
 * observes the threshold (and raises the sticky flag), `armDelay(now)` computes how long a
 * one-shot timer should wait during the "not yet at the threshold" stretch (so `●` appears
 * **exactly** at the threshold rather than at the next unrelated repaint — a non-streaming
 * command may see no upstream events at all while it executes).
 */
export class BashRunTracker {
	private readonly startedAt = new Map<string, number>();
	/** Whether any execution in this batch has crossed the threshold yet (sticky; see file header; reset when the registry empties). */
	private crossed = false;

	/** Book a bash that started executing. */
	start(toolCallId: string, now: number): void {
		this.startedAt.set(toolCallId, now);
	}

	/**
 * Unbook a finished bash. **When the last one finishes** the sticky flag resets along with it —
 * the marker waits for all executions to end before disappearing, and the next bash batch must
 * cross the threshold on its own rather than inherit it.
 */
	end(toolCallId: string): void {
		this.startedAt.delete(toolCallId);
		if (this.startedAt.size === 0) this.crossed = false;
	}

	/** Turn change / session replace / stale ctx: wipe the whole book; the marker disappears immediately. */
	clear(): void {
		this.startedAt.clear();
		this.crossed = false;
	}

	/** How many bashes are currently executing. */
	get size(): number {
		return this.startedAt.size;
	}

	/** Whether the marker should show (threshold crossed **and** an execution still running). */
	get shown(): boolean {
		return this.crossed && this.startedAt.size > 0;
	}

	/**
 * Observe once at the current instant: raise the sticky flag if any execution crossed the
 * threshold; return whether the marker should show. Called at every render opportunity
 * (event / seconds tick / cadence tick).
 */
	markCrossed(now: number): boolean {
		for (const startedAt of this.startedAt.values()) {
			if (now - startedAt >= BASH_SPINNER_DELAY_MS) this.crossed = true;
		}
		return this.shown;
	}

	/**
 * How many ms (≥ 0) until the earliest execution crosses the threshold; `null` = no scheduling
 * needed (no executions, or already crossed — the sticky flag is up). The newest execution's
 * deadline is never earlier than existing ones, so an in-flight schedule need not be re-armed
 * for a later `start`.
 */
	armDelay(now: number): number | null {
		if (this.crossed || this.startedAt.size === 0) return null;
		let earliest = Number.POSITIVE_INFINITY;
		for (const startedAt of this.startedAt.values()) earliest = Math.min(earliest, startedAt);
		return Math.max(0, earliest + BASH_SPINNER_DELAY_MS - now);
	}
}
