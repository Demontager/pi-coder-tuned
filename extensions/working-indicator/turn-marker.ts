/**
 * turn-marker.ts — pure text logic for the "end marker" line that replaces the spinner after a turn ends.
 *
 * Requirement (user's decision, 2026-10-07): when a turn finishes, the spinner disappears
 * without a trace; instead, it should turn in place into a static line saying "how long this
 * turn ran and when it ended", shaped like
 *
 *     ✻ Churned for 3m 37s · done 11:52 PM
 *
 * The landing spot is `working-indicator/index.ts` (which holds the turn clock
 * `turnStartedAt`); this file only handles the **text** — no UI, no pi / pi-tui imports — so
 * `node --test` runs it directly:
 *
 *     node --test clients/pi/extensions/working-indicator/turn-marker.test.ts
 *
 * Four decisions (all the user's; check here before changing any):
 *   - **the verb is picked at random**: a table of ten words, one random pick per turn (not
 *     round-robin, not fixed);
 *   - **leading `✻`**: the same six-pointed star as Claude Code's turn-end line (not a
 *     literal `*`, not recap's `✦`);
 *   - **color dim**: the whole line (including `✻`) uses `dim`, the same tier as the
 *     `Recap:` label in the recap line — quieter than the summary body (`text`) and the `✦`
 *     (`accent`), fitting its role as a "trace", not a "conclusion";
 *   - **only on normal completion**: drawn only when `outcome === "completed"`; ESC / errors
 *     keep the current behavior.
 *
 * The duration is not formatted here: it reuses index.ts's `formatDuration` (the same wording
 * as the seconds tick on the spinner: `<60s`→`42s`, `≥60s`→`1m 23s`, `≥1h`→`1h 23m 32s`),
 * computed by the caller and passed in — both numbers share one origin, so the end duration
 * the user sees can never disagree with the spinner's last frame.
 */

/**
 * The end-marker verb table. The user's ten words, in original order (including the
 * hyphenated spelling of `Ping-ponging`); capitalization and word forms (`Churned` mixed
 * with `Grinding`) are copied verbatim, no normalization.
 */
export const TURN_MARKER_VERBS = [
	"Churned",
	"Spun",
	"Thrashed",
	"Grinding",
	"Chugging",
	"Ping-ponging",
	"Looping",
	"Fizzling",
	"Flickering",
	"Stalled",
] as const;

/** The leading glyph: the same six-pointed star as Claude Code's turn-end line (user's decision, 2026-10-07). */
export const TURN_MARKER_GLYPH = "✻";

/**
 * The end marker's widget key. It lands in the widget area above the editor (the same area as
 * the recap summary / task list; pi gives that area a leading blank line), right on the line
 * where the spinner used to be visible.
 */
export const TURN_MARKER_WIDGET_KEY = "turn-end";

/** A `Math.random`-compatible number source; unit tests feed fixed values to pin the boundaries. */
export type RandomFn = () => number;

/**
 * Pick one verb at random. `random()` by convention returns `[0, 1)`, but an injected fake
 * (or a future implementation) may yield 1 — the index is clamped so it can never go out of
 * bounds into `undefined`: the end marker is a turn's last stroke and must not blow up in the
 * rendering layer over a random number.
 */
export function pickTurnVerb(random: RandomFn = Math.random): string {
	const raw = Math.floor(random() * TURN_MARKER_VERBS.length);
	const index = Math.min(TURN_MARKER_VERBS.length - 1, Math.max(0, raw));
	return TURN_MARKER_VERBS[index];
}

/**
 * The end time: `11:52 PM` (12-hour clock, zero-padded minutes, uppercase `AM`/`PM`).
 *
 * Deliberately hand-written instead of `toLocaleTimeString`: the requirement is exactly this
 * one shape, and handwriting is immune to ICU / locale environment (this machine's `zh-CN`
 * yields `23:52`, while the rest of the status line is all English). Midnight and noon show
 * as `12:00 AM` / `12:00 PM` per convention (the `hours % 12 === 0` special case maps to 12).
 */
export function formatEndClock(date: Date): string {
	const hours = date.getHours();
	const minutes = date.getMinutes();
	const period = hours < 12 ? "AM" : "PM";
	const hour12 = hours % 12 === 0 ? 12 : hours % 12;
	return `${hour12}:${String(minutes).padStart(2, "0")} ${period}`;
}

/**
 * The full line shape: `✻ <verb> for <duration> · done <clock>`.
 * All three pieces are ready-made text computed by the caller (the verb from `pickTurnVerb`,
 * the duration from `formatDuration`, the clock from `formatEndClock`); this only assembles
 * them into the fixed shape — the shape itself is unit-tested.
 */
export function formatTurnMarker(verb: string, duration: string, clock: string): string {
	return `${TURN_MARKER_GLYPH} ${verb} for ${duration} · done ${clock}`;
}
