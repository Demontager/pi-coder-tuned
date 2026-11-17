/**
 * spinner-frames.ts — the working spinner's "rainbow" frame table: the same family of braille
 * frames cycling through a palette of colors.
 *
 * Extracted for the same reason as `working-summary.ts` / `bash-spinner.ts`: how the frame table
 * is laid out (cycle length, which color frame i takes), how the palette is deduplicated, and
 * what the theme fingerprint is — all pure computation that should not live between `index.ts`'s
 * ctx and its timers. This module **does not import pi / pi-tui** — `node --test` exercises
 * every branch directly (see `spinner-frames.test.ts`); the half that installs the frame table
 * (when to install, when to reinstall) lives in the extension.
 *
 * ## Why colors can only be pre-baked
 *
 * pi's `Loader` has exactly one coloring path: the default ten braille frames go through
 * `spinnerColorFn` (`theme.fg("accent", frame)` when not embedded), so the whole spinner is
 * forever one color — precisely what this extension changes. In the extension's entry point
 * `ctx.ui.setWorkingIndicator({ frames, intervalMs })`, **custom frames are rendered verbatim**
 * (pi 0.85.1's Loader: `renderIndicatorVerbatim = indicator !== undefined`; when true,
 * `getRenderedIndicator()` returns the frame string as-is, skipping `spinnerColorFn`) — meaning
 * the color must be carried by the frame string itself. So "one color per frame" can only be done
 * by baking ANSI sequences into the frame table; the cost is that after a theme change the table
 * does not update by itself — it must be reinstalled (reinstall = call `setWorkingIndicator`
 * again; whether to is decided by `signature`).
 *
 * ## How the frame table is laid out
 *
 * The Loader bumps the frame-table index +1 modulo its length every `intervalMs` (default 80) —
 * **the table's order is the animation order**. Flatten "ten braille frames × several colors"
 * into a one-dimensional array, where index i means:
 *
 *     braille = SPINNER_FRAMES[i % 10]                        (rotation unchanged, same speed as pi's default)
 *     color   = colors[floor(i / framesPerColor) % colors.length]
 *
 * Color advances **by frame count**, not every frame: default `framesPerColor = 19`. 1500ms is
 * not a multiple of 80ms; 19 frames = 1520ms is the closest value to the requirement (color
 * change every 1.5s; off by 1.3%). Evolution: first version 5 frames / 400ms felt fast → 10
 * frames / 800ms (halved) → 19 frames / 1520ms. One frame per color (`framesPerColor = 1`,
 * 80ms) is a strobe, not a rainbow; much higher is "stuck half a day" — `PI_SPINNER_COLOR_HOLD`
 * tunes it by frame count.
 *
 * The one-dimensional table must have a period or colors jump at wraparound: period =
 * lcm(10, framesPerColor × color count), so i and i+period align in both (braille, color).
 * Default 19 frames × 7 colors: one palette lap is 133 frames (10.6s, 13.3 braille
 * revolutions); the table period is lcm(10, 133) = 1330 frames (~106s). Since 19 and the
 * 10-frame revolution are coprime, each color-change point lands one step further inside the
 * revolution and the phase sweeps all 10 positions — visually a ribbon of drifting color where
 * change points never land on the same braille frame. To pin color changes to a fixed braille
 * position (change every revolution / every two), set `framesPerColor` to a multiple of 10
 * (e.g. 10 / 20) at the cost of locking the palette period to the rotation period.
 *
 * ## The palette
 *
 * Seven color slots per the requirement: accent / success / warning / syntaxKeyword /
 * toolDiffAdded / toolDiffRemoved / toolTitle (the formal token names for "keyword / added /
 * removed / tool" in the theme catalog), in exactly this order. After a theme change **actual
 * colors may collide** (measured on pi-coder-summer-night: success and toolDiffAdded are both
 * #8cd6a7, warning and toolTitle both #e9c16f); colliding slots are deduplicated by `fg`'s
 * rendered output — keeping them would paint two consecutive stretches the same color and look
 * like the animation froze. When only one color survives dedup (monochrome theme / NO_COLOR),
 * `frames = null`: the caller keeps pi's default spinner rather than installing an "animation"
 * whose every frame looks identical.
 */

/** A theme interface using only `fg` — mirrors `index.ts`'s `WorkingMessageTheme` shape without importing back. */
export type SpinnerColorize = (token: string, text: string) => string;

/** pi's default ten braille frames (order = rotation direction). The table reuses them: the animation reads as the same family as before. */
export const SPINNER_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * pi's default frame interval (ms). Custom frames must supply their own interval (or they fall
 * back to pi's default — same value but a dependency on pi's implementation detail), so it is
 * pinned here and kept aligned with pi's `DEFAULT_INTERVAL_MS` — it is also the conversion
 * basis for "how long a color lasts" (`framesPerColor × SPINNER_INTERVAL_MS`).
 */
export const SPINNER_INTERVAL_MS = 80;

/** Theme color slots in the rotation, in requirement order (the "rainbow" sequence). */
export const SPINNER_COLOR_TOKENS: readonly string[] = [
	"accent",
	"success",
	"warning",
	"syntaxKeyword",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolTitle",
];

/**
 * Frames each color lasts (default 19 frames × 80ms = 1520ms ≈ one color change per 1.5s).
 * 1500ms is not a multiple of 80ms; 19 is the nearest frame count (1520ms, off by 1.3%).
 */
export const DEFAULT_FRAMES_PER_COLOR = 19;

/**
 * Color-probe character: handing `fg` a non-empty text returns "this slot's colored result",
 * used to compare whether two slots resolve to the same color under the current theme (`fg`'s
 * return carries the ANSI prefix — slot names alone cannot be compared).
 */
const COLOR_PROBE = "x";

export interface SpinnerPalette {
	/** The slots that actually rotate after dedup (original order preserved). */
	tokens: string[];
	/** Theme fingerprint: stable under the same theme + palette; guaranteed to change after a theme / palette change. */
	signature: string;
	/** The frame table (colored, one string per frame); `null` = the current theme cannot produce two distinguishable colors. */
	frames: string[] | null;
}

function gcd(a: number, b: number): number {
	let left = Math.abs(a);
	let right = Math.abs(b);
	while (right > 0) {
		const next = left % right;
		left = right;
		right = next;
	}
	return left;
}

/** Frame-table period (in frames): the lcm of the braille revolution (10) and the color cycle (frames-per-color × color count). */
function spinnerFramePeriod(framesPerColor: number, colorCount: number): number {
	const colorCycle = framesPerColor * colorCount;
	return (colorCycle / gcd(SPINNER_FRAMES.length, colorCycle)) * SPINNER_FRAMES.length;
}

/** Non-integer / <1 / non-finite values all fall back to the default (an env-parsed number can still be NaN). */
function normalizeFramesPerColor(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) && value >= 1
		? Math.floor(value)
		: DEFAULT_FRAMES_PER_COLOR;
}

/**
 * Compute the rainbow frame table for the current theme.
 *
 * Colors dedupe by **rendered output** (`colorize(token, COLOR_PROBE)`), not slot names — two
 * slots may resolve to the same color under the current theme (see file header). Fewer than two
 * colors left → `frames: null`.
 */
export function buildSpinnerPalette(
	colorize: SpinnerColorize,
	options: { framesPerColor?: number; tokens?: readonly string[] } = {},
): SpinnerPalette {
	const tokens = options.tokens ?? SPINNER_COLOR_TOKENS;
	const framesPerColor = normalizeFramesPerColor(options.framesPerColor);

	const seen = new Set<string>();
	const kept: string[] = [];
	const probes: string[] = [];
	for (const token of tokens) {
		const probe = colorize(token, COLOR_PROBE);
		if (seen.has(probe)) continue;
		seen.add(probe);
		kept.push(token);
		probes.push(probe);
	}
	const signature = probes.join("\n");
	if (kept.length < 2) return { tokens: kept, signature, frames: null };

	const frames: string[] = [];
	const period = spinnerFramePeriod(framesPerColor, kept.length);
	for (let index = 0; index < period; index += 1) {
		const token = kept[Math.floor(index / framesPerColor) % kept.length] as string;
		const frame = SPINNER_FRAMES[index % SPINNER_FRAMES.length] as string;
		frames.push(colorize(token, frame));
	}
	return { tokens: kept, signature, frames };
}
