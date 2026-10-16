/**
 * Tests for title-row.ts — the `Edit` / `Write` title row's pure layout (budget split,
 * width truncation, blink placeholder, count shrinking).
 *
 * Run with:  node --test clients/pi/extensions/tool-diff/title-row.test.ts
 *
 * The module under test imports no pi / pi-tui (width and truncate functions are
 * injected), so fake implementations are fed: ASCII = 1 column, CJK = 2 columns; `●`
 * (U+25CF) and `…` are both 1 column — verified identical to pi-tui's `visibleWidth`
 * (`visibleWidth("●") === 1`). The theme's `fg` is the identity, so assertions read
 * plain text directly.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BLINK_MARKER,
	ELLIPSIS,
	TitleRow,
	blinkSuffix,
	formatCount,
	shortenPath,
	statsSuffix,
	truncateStartToWidth,
	type TitleRowDeps,
	type TitleTheme,
} from "./title-row.ts";

/** The identity theme: no coloring — assertions compare plain text. */
const plainTheme: TitleTheme = { fg: (_color, text) => text };

/** The fake width function: common CJK fullwidth ranges count 2 columns, the rest 1. */
function widthOf(text: string): number {
	let width = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
}

/** The fake truncator (production gets pi-tui's truncateToWidth): a hard tail clip is enough. */
function truncateToWidth(text: string, width: number, ellipsis = ELLIPSIS): string {
	if (widthOf(text) <= width) return text;
	let out = "";
	let used = 0;
	for (const ch of text) {
		const w = widthOf(ch);
		if (used + w > width - widthOf(ellipsis)) break;
		out += ch;
		used += w;
	}
	return out + ellipsis;
}

function deps(home = "/Users/me"): TitleRowDeps {
	return { widthOf, truncateToWidth, home, indent: " " };
}

/** A deep path that must head-truncate to fit 90 columns. */
const LONG_PATH =
	"/Users/me/work/project/packages/renderer/src/components/inner/deep/deeper/deepest/final/renderer-impl.ts";

function titleLine(path: string, suffix: string, width: number, rowDeps: TitleRowDeps = deps()): string {
	return new TitleRow(rowDeps, plainTheme, "Write", path, suffix).render(width)[0] ?? "";
}

describe("blinkSuffix: the off state is a same-width placeholder", () => {
	it("keeps the same visible width in both phases so the path budget cannot move", () => {
		assert.equal(widthOf(blinkSuffix(plainTheme, true)), 1);
		assert.equal(widthOf(blinkSuffix(plainTheme, false)), 1);
		assert.equal(widthOf(blinkSuffix(plainTheme, true)), widthOf(blinkSuffix(plainTheme, false)));
	});

	it("renders the marker only while the phase is on (the dark phase is blank)", () => {
		assert.equal(blinkSuffix(plainTheme, true), BLINK_MARKER);
		assert.equal(blinkSuffix(plainTheme, false).trim(), "");
	});
});

describe("TitleRow: an overlong path does not wobble during the blink (regression)", () => {
	it("renders the same line in both blink phases, modulo the marker itself", () => {
		const on = titleLine(LONG_PATH, blinkSuffix(plainTheme, true), 90);
		const off = titleLine(LONG_PATH, blinkSuffix(plainTheme, false), 90);
		// the only difference between the states is the marker char — before the fix the off state was an empty string, the budget jumped 2 columns per frame,
		// and the truncation window slid left and right (`…ccccc` vs `…ccccccc`) — the filename visibly "blinked"
		assert.equal(on.replace(BLINK_MARKER, " "), off);
		assert.equal(widthOf(on), widthOf(off));
	});

	it("keeps the file name and the line width stable across a sweep of widths", () => {
		for (let width = 40; width <= 140; width += 1) {
			const on = titleLine(LONG_PATH, blinkSuffix(plainTheme, true), width);
			const off = titleLine(LONG_PATH, blinkSuffix(plainTheme, false), width);
			assert.ok(widthOf(on) <= width, `line wider than ${width}: ${JSON.stringify(on)}`);
			assert.equal(on.replace(BLINK_MARKER, " "), off, `path moved at width ${width}`);
			// the path always keeps its tail: no matter how narrow, the filename stays whole
			assert.ok(on.replace(BLINK_MARKER, " ").trimEnd().endsWith("renderer-impl.ts"), `no file name at width ${width}`);
		}
	});

	it("keeps the tail (file name) visible while dropping the head of a long path", () => {
		const line = titleLine(LONG_PATH, blinkSuffix(plainTheme, true), 90);
		assert.ok(line.startsWith(" Write "), line);
		assert.ok(line.includes(ELLIPSIS), line);
		assert.ok(line.includes("/final/renderer-impl.ts"), line);
		assert.ok(!line.includes("/Users/me/work"), line);
	});
});

describe("TitleRow: the tool name and tail are always whole", () => {
	it("keeps a wide stats suffix intact and truncates the path instead", () => {
		const line = titleLine(LONG_PATH, statsSuffix(plainTheme, { added: 123456, removed: 9999 }), 90);
		assert.ok(line.endsWith("(+123k -9999)"), line);
		assert.ok(line.includes(ELLIPSIS), line);
		assert.ok(widthOf(line) <= 90, line);
	});

	it("falls back to whole-line truncation when the path budget runs out", () => {
		const line = titleLine(LONG_PATH, blinkSuffix(plainTheme, true), 8);
		assert.equal(widthOf(line) <= 8, true, line);
		assert.ok(line.includes("Write"), line);
		// on whole-row truncation the two states again differ only in the marker: the tail is a same-width space — the budget never jumps
		const off = titleLine(LONG_PATH, blinkSuffix(plainTheme, false), 8);
		assert.equal(line.replace(BLINK_MARKER, " "), off);
	});

	it("renders the streaming-start form (no path yet) without a dangling separator", () => {
		assert.equal(titleLine("", blinkSuffix(plainTheme, true), 60).trimEnd(), " Write ●");
	});
});

describe("TitleRow: path and indent", () => {
	it("shortens the home prefix and honours a custom indent", () => {
		const line = titleLine("/Users/me/work/project/src/index.ts", "", 60, {
			...deps(),
			indent: "   ",
		});
		assert.equal(line, "   Write ~/work/project/src/index.ts");
	});

	it("colors the path with the text token, after truncation (ANSI never reaches the measurer)", () => {
		const calls: Array<[string, string]> = [];
		const recordingTheme: TitleTheme = {
			fg: (color, text) => {
				calls.push([color, text]);
				return text;
			},
		};
		new TitleRow(deps(), recordingTheme, "Write", LONG_PATH, "").render(90);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.[0], "text");
		assert.ok(calls[0]?.[1].startsWith(ELLIPSIS), calls[0]?.[1]);
	});
});

describe("formatCount", () => {
	it("keeps counts below 10k exact", () => {
		assert.equal(formatCount(0), "0");
		assert.equal(formatCount(1), "1");
		assert.equal(formatCount(9999), "9999");
	});

	it("abbreviates counts at or above 10k with a k suffix", () => {
		assert.equal(formatCount(10_000), "10k");
		assert.equal(formatCount(10_043), "10k");
		assert.equal(formatCount(11_133), "11.1k");
		assert.equal(formatCount(10_450), "10.5k");
		assert.equal(formatCount(99_999), "100k");
		assert.equal(formatCount(123_456), "123k");
		assert.equal(formatCount(1_234_567), "1235k");
	});
});

describe("statsSuffix", () => {
	/** A theme recording fg calls, to assert the color tokens used. */
	function recorder(): { theme: TitleTheme; calls: Array<[string, string]> } {
		const calls: Array<[string, string]> = [];
		return {
			calls,
			theme: {
				fg: (color, text) => {
					calls.push([color, text]);
					return text;
				},
			},
		};
	}

	it("returns an empty string when there is nothing to report", () => {
		assert.equal(statsSuffix(plainTheme, undefined), "");
		assert.equal(statsSuffix(plainTheme, { added: 0, removed: 0 }), "");
	});

	it("omits the side that is zero", () => {
		assert.equal(statsSuffix(plainTheme, { added: 3, removed: 0 }), "(+3)");
		assert.equal(statsSuffix(plainTheme, { added: 0, removed: 5 }), "(-5)");
	});

	it("shows both sides with the diff color tokens", () => {
		const { theme, calls } = recorder();
		assert.equal(statsSuffix(theme, { added: 3, removed: 5 }), "(+3 -5)");
		assert.deepEqual(calls, [
			["toolDiffAdded", "+3"],
			["toolDiffRemoved", "-5"],
			["dim", "("],
			["dim", ")"],
		]);
	});

	it("abbreviates huge counts (the tail must stay narrow)", () => {
		assert.equal(statsSuffix(plainTheme, { added: 10_043, removed: 11_133 }), "(+10k -11.1k)");
	});
});

describe("shortenPath", () => {
	it("shortens the home prefix at a path boundary only", () => {
		assert.equal(shortenPath("/Users/me/work/index.ts", "/Users/me"), "~/work/index.ts");
		assert.equal(shortenPath("/Users/me", "/Users/me"), "~");
		// `/Users/melo` must not shorten to `~lo`
		assert.equal(shortenPath("/Users/melo/index.ts", "/Users/me"), "/Users/melo/index.ts");
	});

	it("leaves the path alone without a home directory or outside of it", () => {
		assert.equal(shortenPath("/tmp/renderer.ts", ""), "/tmp/renderer.ts");
		assert.equal(shortenPath("/tmp/renderer.ts", "/Users/me"), "/tmp/renderer.ts");
	});
});

describe("truncateStartToWidth", () => {
	it("returns the text unchanged when it fits", () => {
		assert.equal(truncateStartToWidth("abcdef", 6, widthOf), "abcdef");
	});

	it("keeps the tail and marks the dropped head with an ellipsis", () => {
		assert.equal(truncateStartToWidth("abcdef", 4, widthOf), "…def");
		assert.equal(truncateStartToWidth("abcdef", 1, widthOf), ELLIPSIS);
	});

	it("returns nothing when there is no room at all", () => {
		assert.equal(truncateStartToWidth("abcdef", 0, widthOf), "");
		assert.equal(truncateStartToWidth("abcdef", -3, widthOf), "");
	});

	it("measures CJK characters as two columns", () => {
		assert.equal(truncateStartToWidth("路径文件名", 5, widthOf), "…件名");
	});
});
