/**
 * Tests for spinner-frames.ts — the working spinner rainbow frame table's layout, dedup, and
 * theme fingerprint.
 *
 * Run with:  node --test clients/pi/extensions/working-indicator/spinner-frames.test.ts
 *
 * The module under test imports no pi / pi-tui — assertions compare each frame string's
 * "color prefix + braille char" pair.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DEFAULT_FRAMES_PER_COLOR,
	SPINNER_COLOR_TOKENS,
	SPINNER_FRAMES,
	SPINNER_INTERVAL_MS,
	buildSpinnerPalette,
	type SpinnerColorize,
} from "./spinner-frames.ts";

/** Each of the seven slots gets a distinguishable "color"; `fg`'s shape is "color prefix + original". */
const DISTINCT: Record<string, string> = Object.fromEntries(
	SPINNER_COLOR_TOKENS.map((token, index) => [token, `<c${index}>`]),
);

/** An independent implementation matching the module's rule, used to cross-check the table period (testing the lcm property, not copying the formula). */
function gcd(a: number, b: number): number {
	return b === 0 ? a : gcd(b, a % b);
}

/** Independent algorithm for the table period: lcm(braille frame count, frames-per-color × color count). */
function expectedPeriod(framesPerColor: number, colorCount: number): number {
	const colorCycle = framesPerColor * colorCount;
	return (10 * colorCycle) / gcd(10, colorCycle);
}

/** Fake theme: `colorize(token, text)` → `color + text` (same shape as `theme.fg`; colors differ by prefix). */
function fakeTheme(colors: Record<string, string>): SpinnerColorize {
	return (token, text) => `${colors[token] ?? `<${token}>`}${text}`;
}

/** Recover the color prefix from a frame string (the braille frames are all in the BMP, one UTF-16 unit each). */
function colorOf(frame: string, colors: Record<string, string>): string {
	for (const color of Object.values(colors)) {
		if (frame.startsWith(color) && frame.length === color.length + 1) return color;
	}
	throw new Error(`no known color prefix in frame: ${frame}`);
}

/** Recover the braille char from a frame string. */
function frameOf(frame: string): string {
	return frame.at(-1) as string;
}

/** Color segments: consecutive same-color frames merge into one run. */
function colorRuns(frames: string[], colors: Record<string, string>): Array<{ color: string; length: number }> {
	const runs: Array<{ color: string; length: number }> = [];
	for (const frame of frames) {
		const color = colorOf(frame, colors);
		const last = runs.at(-1);
		if (last !== undefined && last.color === color) last.length += 1;
		else runs.push({ color, length: 1 });
	}
	return runs;
}

/**
 * The **phase** inside one revolution where colors change (frame no. % 10): a single-element
 * set = every revolution changes at the same braille position; multiple elements = the change
 * point drifts per revolution (when `framesPerColor` does not divide 10).
 */
function changePhases(frames: string[], colors: Record<string, string>): Set<number> {
	const phases = new Set<number>();
	for (const [index, frame] of frames.entries()) {
		if (index === 0) continue;
		if (colorOf(frame, colors) !== colorOf(frames[index - 1] as string, colors)) {
			phases.add(index % SPINNER_FRAMES.length);
		}
	}
	return phases;
}

describe("buildSpinnerPalette frame-table layout", () => {
	it("with no config uses the seven slots at 19 frames each (defaults), period 1330 frames", () => {
		const palette = buildSpinnerPalette(fakeTheme(DISTINCT));
		assert.deepEqual(palette.tokens, [...SPINNER_COLOR_TOKENS]);
		assert.equal(DEFAULT_FRAMES_PER_COLOR, 19);
		assert.equal(SPINNER_INTERVAL_MS, 80);
		// 19 frames × 80ms = 1520ms ≈ one color change per 1.5s; period = lcm(10, 19 × 7) = 1330 frames ≈ 106s.
		assert.equal(palette.frames?.length, 1330);
		assert.equal(palette.frames?.length, expectedPeriod(19, 7));
	});

	it("rotation unchanged: frame i's braille is pi's default sequence's i % 10", () => {
		const frames = buildSpinnerPalette(fakeTheme(DISTINCT)).frames as string[];
		for (const [index, frame] of frames.entries()) {
			assert.equal(frameOf(frame), SPINNER_FRAMES[index % SPINNER_FRAMES.length]);
		}
	});

	it("colors advance by frame count: each run is exactly framesPerColor frames, in tokens order", () => {
		const runs = colorRuns(buildSpinnerPalette(fakeTheme(DISTINCT)).frames as string[], DISTINCT);
		assert.equal(runs.length, 70); // 1330 frames / 19 per run
		assert.ok(runs.every((run) => run.length === DEFAULT_FRAMES_PER_COLOR));
		for (const [index, run] of runs.entries()) {
			assert.equal(run.color, DISTINCT[SPINNER_COLOR_TOKENS[index % SPINNER_COLOR_TOKENS.length] as string]);
		}
	});

	it("the default table wraps seamlessly: the last frame is the revolution's last braille + the palette's last color, and change-point phases sweep all 10 positions", () => {
		const frames = buildSpinnerPalette(fakeTheme(DISTINCT)).frames as string[];
		const last = frames[frames.length - 1] as string;
		assert.equal(frameOf(last), SPINNER_FRAMES[9]);
		assert.equal(colorOf(last, DISTINCT), DISTINCT["toolTitle"]);
		assert.equal(frameOf(frames[0] as string), SPINNER_FRAMES[0]);
		assert.equal(colorOf(frames[0] as string, DISTINCT), DISTINCT["accent"]);

		// 19 is coprime with the 10-frame braille revolution: each color-change point lands one step further inside the revolution, sweeping all 10 positions
		// (table period lcm(10, 19 × 7) = 1330 frames ≈ 106s — far longer than one palette lap's 133 frames).
		assert.equal(frames.length, DEFAULT_FRAMES_PER_COLOR * SPINNER_COLOR_TOKENS.length * 10);
		assert.equal(changePhases(frames, DISTINCT).size, SPINNER_FRAMES.length);
	});

	it("framesPerColor is tunable: 1 = every frame, 3 = period 210 frames with a per-revolution drifting change point", () => {
		const perFrame = buildSpinnerPalette(fakeTheme(DISTINCT), { framesPerColor: 1 });
		assert.equal(perFrame.frames?.length, expectedPeriod(1, 7));
		assert.ok(colorRuns(perFrame.frames as string[], DISTINCT).every((run) => run.length === 1));

		const holdThree = buildSpinnerPalette(fakeTheme(DISTINCT), { framesPerColor: 3 });
		assert.equal(holdThree.frames?.length, expectedPeriod(3, 7));
		assert.ok(colorRuns(holdThree.frames as string[], DISTINCT).every((run) => run.length === 3));
		// 3 does not divide 10: the change point is not at one braille position (more than one phase = the ribbon drifts inside the revolution).
		assert.ok(changePhases(holdThree.frames as string[], DISTINCT).size > 1);
	});

	it("invalid framesPerColor: 0 / negative / NaN / Infinity fall back to the default; fractions are floored", () => {
		for (const [value, hold] of [
			[0, DEFAULT_FRAMES_PER_COLOR],
			[-3, DEFAULT_FRAMES_PER_COLOR],
			[Number.NaN, DEFAULT_FRAMES_PER_COLOR],
			[Number.POSITIVE_INFINITY, DEFAULT_FRAMES_PER_COLOR],
			[2.9, 2],
		] as const) {
			const palette = buildSpinnerPalette(fakeTheme(DISTINCT), { framesPerColor: value });
			assert.equal(colorRuns(palette.frames as string[], DISTINCT)[0]?.length, hold, `framesPerColor=${value}`);
			assert.equal(palette.frames?.length, expectedPeriod(hold, 7), `framesPerColor=${value}`);
		}
	});

	it("tokens can shrink to a subset: two slots × 5 frames each → period lcm(10, 10) = 10 frames", () => {
		const palette = buildSpinnerPalette(fakeTheme(DISTINCT), { framesPerColor: 5, tokens: ["accent", "warning"] });
		assert.deepEqual(palette.tokens, ["accent", "warning"]);
		assert.equal(palette.frames?.length, expectedPeriod(5, 2));
		assert.deepEqual(
			colorRuns(palette.frames as string[], DISTINCT).map((run) => run.color),
			[DISTINCT["accent"], DISTINCT["warning"]],
		);
	});
});

describe("buildSpinnerPalette color dedup and degradation", () => {
	it("two slots sharing a color under the current theme keep only one (no two consecutive same-color runs)", () => {
		// measured collision on pi-coder-summer-night: success == toolDiffAdded, warning == toolTitle.
		const theme = fakeTheme({
			...DISTINCT,
			toolDiffAdded: DISTINCT["success"] as string,
			toolTitle: DISTINCT["warning"] as string,
		});
		const palette = buildSpinnerPalette(theme);
		assert.deepEqual(palette.tokens, ["accent", "success", "warning", "syntaxKeyword", "toolDiffRemoved"]);
		assert.equal(palette.frames?.length, expectedPeriod(19, 5));

		const runs = colorRuns(palette.frames as string[], DISTINCT);
		assert.ok(runs.every((run) => run.length === 19));
		for (const [index, run] of runs.entries()) {
			assert.notEqual(run.color, runs[index + 1]?.color, `run ${index} has the same color as the next run`);
		}
		// the collider dropped is the later slot (dedup keeps the first occurrence).
		assert.ok(!palette.tokens.includes("toolDiffAdded"));
		assert.ok(!palette.tokens.includes("toolTitle"));
	});

	it("with only one color left, no frame table is issued (the caller keeps pi's default spinner)", () => {
		const allSame = fakeTheme(Object.fromEntries(SPINNER_COLOR_TOKENS.map((token) => [token, "<all>"])));
		const palette = buildSpinnerPalette(allSame);
		assert.equal(palette.frames, null);
		assert.deepEqual(palette.tokens, ["accent"]);
	});

	it("an identity theme (NO_COLOR / non-TUI) is also monochrome → frames is null", () => {
		const identity: SpinnerColorize = (_token, text) => text;
		assert.equal(buildSpinnerPalette(identity).frames, null);
	});

	it("the fingerprint changes with the theme and stays stable within one (reinstall decisions rely on it)", () => {
		const first = buildSpinnerPalette(fakeTheme(DISTINCT)).signature;
		assert.equal(buildSpinnerPalette(fakeTheme(DISTINCT)).signature, first);
		assert.notEqual(buildSpinnerPalette(fakeTheme({ ...DISTINCT, accent: "<other>" })).signature, first);

		// a slot dropped by dedup (its color collided with the previous slot) does not affect the fingerprint — it is not in the rotation.
		const signatureWithDropped = (dropped: string): string =>
			buildSpinnerPalette(
				fakeTheme({ ...DISTINCT, toolDiffAdded: dropped, toolTitle: DISTINCT["warning"] as string }),
			).signature;
		assert.equal(
			signatureWithDropped(DISTINCT["accent"] as string),
			signatureWithDropped(DISTINCT["success"] as string),
		);
	});

	it("the color probe is non-empty text (an empty string cannot distinguish slots)", () => {
		const probes: string[] = [];
		buildSpinnerPalette((token, text) => {
			probes.push(text);
			return `${token}${text}`;
		});
		assert.ok(probes.length >= SPINNER_COLOR_TOKENS.length);
		assert.ok(probes.every((text) => text.length > 0));
	});
});
