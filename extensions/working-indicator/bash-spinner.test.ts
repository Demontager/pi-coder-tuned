/**
 * Tests for bash-spinner.ts — the shape of the "bash executing `●`" at the working line's tail
 * and the concurrency registry.
 *
 * Run with:  node --test clients/pi/extensions/working-indicator/bash-spinner.test.ts
 *
 * The module under test imports no pi / pi-tui — assertions compare plain text / plain state.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BASH_SPINNER_BLINK_MS,
	BASH_SPINNER_COLOR,
	BASH_SPINNER_DELAY_MS,
	BASH_SPINNER_MARKER,
	BASH_SPINNER_WIDTH,
	BashRunTracker,
	bashSpinnerSuffix,
} from "./bash-spinner.ts";

/** Visible width: this module only produces ASCII spaces and `●` (U+25CF, 1 column) — counting chars is enough. */
function widthOf(text: string): number {
	return [...text].length;
}

describe("bashSpinnerSuffix", () => {
	it("lit phase `\" ●\"`, dark phase two spaces (never returns an empty string)", () => {
		assert.equal(bashSpinnerSuffix(true), ` ${BASH_SPINNER_MARKER}`);
		assert.equal(bashSpinnerSuffix(false), " ".repeat(BASH_SPINNER_WIDTH));
		assert.notEqual(bashSpinnerSuffix(false), "");
	});

	it("both states equal width **and equal char count** (right-aligned summary never bounces with the blink)", () => {
		for (const text of [bashSpinnerSuffix(true), bashSpinnerSuffix(false)]) {
			assert.equal(widthOf(text), BASH_SPINNER_WIDTH);
			assert.equal([...text].length, BASH_SPINNER_WIDTH);
		}
	});

	it("returns **uncolored** plain text (the extension colors it by the color slot)", () => {
		for (const text of [bashSpinnerSuffix(true), bashSpinnerSuffix(false)]) {
			assert.doesNotMatch(text, /\x1b\[/);
		}
	});

	it("the color slot is dim (same slot the retired bash first-row spinner used)", () => {
		assert.equal(BASH_SPINNER_COLOR, "dim");
	});
});

describe("cadence constants", () => {
	it("threshold 1s, lit/dark 500ms each, divides evenly", () => {
		assert.equal(BASH_SPINNER_DELAY_MS, 1000);
		assert.equal(BASH_SPINNER_BLINK_MS, 500);
		assert.equal(BASH_SPINNER_DELAY_MS % BASH_SPINNER_BLINK_MS, 0);
	});
});

describe("BashRunTracker", () => {
	it("no bash running: not shown, no scheduling needed", () => {
		const runs = new BashRunTracker();
		assert.equal(runs.size, 0);
		assert.equal(runs.shown, false);
		assert.equal(runs.markCrossed(0), false);
		assert.equal(runs.armDelay(0), null);
	});

	it("hidden inside the threshold, shown exactly at the point (1000ms)", () => {
		const runs = new BashRunTracker();
		runs.start("a", 5_000);
		assert.equal(runs.markCrossed(5_999), false);
		assert.equal(runs.shown, false);
		assert.equal(runs.armDelay(5_999), 1);
		assert.equal(runs.markCrossed(6_000), true);
		assert.equal(runs.shown, true);
		assert.equal(runs.armDelay(6_000), null, "once the threshold is crossed, no more scheduling");
	});

	it("scheduled instant = the earliest execution's deadline, sliding to the next once the first finishes", () => {
		const runs = new BashRunTracker();
		runs.start("a", 0);
		runs.start("b", 500);
		assert.equal(runs.armDelay(0), 1_000, "both inside the threshold: wait for the earliest");
		runs.end("a");
		assert.equal(runs.armDelay(0), 1_500, "after a finishes, wait for b");
		assert.equal(runs.armDelay(1_500), 0, "already at the point is 0 — nothing further out");
	});

	it("stickiness: once a crossing execution finishes, same-batch ones still under the threshold keep holding the marker", () => {
		const runs = new BashRunTracker();
		runs.start("long", 0);
		runs.start("young", 900);
		assert.equal(runs.markCrossed(1_000), true, "long crossed the threshold");
		runs.end("long");
		assert.equal(runs.shown, true, "young is still running — the marker must not go out");
		assert.equal(runs.markCrossed(1_100), true, "young itself has not crossed — held up by stickiness");
		assert.equal(runs.armDelay(1_100), null, "threshold crossed — no scheduling for young");
		runs.end("young");
		assert.equal(runs.shown, false, "all bashes finished → the marker disappears");
		assert.equal(runs.size, 0);
	});

	it("disappears only when the last one finishes: two past-threshold runs in a batch, the first ending changes nothing", () => {
		const runs = new BashRunTracker();
		runs.start("a", 0);
		runs.start("b", 0);
		assert.equal(runs.markCrossed(1_000), true);
		runs.end("a");
		assert.equal(runs.shown, true);
		runs.end("b");
		assert.equal(runs.shown, false);
	});

	it("a new batch does not inherit the sticky flag: a fresh short command must cross the threshold itself", () => {
		const runs = new BashRunTracker();
		runs.start("a", 0);
		runs.markCrossed(1_000);
		runs.end("a");
		runs.start("b", 2_000);
		assert.equal(runs.markCrossed(2_100), false, "the previous batch's stickiness reset when the registry emptied");
		assert.equal(runs.shown, false);
		assert.equal(runs.armDelay(2_100), 900);
	});

	it("clear() wipes the whole book (turn change / session replace / stale ctx)", () => {
		const runs = new BashRunTracker();
		runs.start("a", 0);
		runs.markCrossed(1_000);
		runs.clear();
		assert.equal(runs.size, 0);
		assert.equal(runs.shown, false);
		assert.equal(runs.armDelay(1_000), null);
	});
});
