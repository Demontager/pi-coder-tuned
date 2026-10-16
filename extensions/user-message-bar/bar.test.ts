/**
 * Tests for bar.ts — the pure logic: the left padding cell becomes the bar
 * (that cell follows the message background), one space goes before the
 * text, and the freed columns are eaten equally from the trailing padding;
 * background-slot→foreground color resolution; the patch is idempotent.
 *
 * Run with:  node --test clients/pi/extensions/user-message-bar/bar.test.ts
 *
 * Hand-written fake rows are used (shaped after `UserMessageComponent.render`'s
 * real output: a `\x1b[48;…m` head, a `\x1b[49m` tail, and a `\x1b]133;A\x07`
 * before a restored session's first row) — the assertions only strip ANSI and
 * compare strings, so no pi / pi-tui is needed. The real chain (the patch
 * landing on the class pi renders with) is in `index.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { BAR_GLYPH, BAR_INDENT, addBarToLine, installUserMessageBar, resolveBarAnsi } from "./bar.ts";

const BG = "\u001b[48;2;27;28;29m";
const BG_RESET = "\u001b[49m";
const FG = "\u001b[38;2;198;200;209m";
const FG_RESET = "\u001b[39m";
const ZONE = "\u001b]133;A\u0007";
const BAR = "\u001b[38;2;45;44;93m\u258e\u001b[39m";

/** The visible text with all zero-width sequences stripped (these fixtures are all same-width chars — length is the column count). */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

test("glyph and indent: default `▎` (U+258E), one space before the text", () => {
	assert.equal(BAR_GLYPH, "\u258e");
	assert.equal(BAR_INDENT, 1);
});

test("a normal row: the left padding space becomes the bar, one space before the text, the tail padding loses one column", () => {
	const line = `${BG} ${FG}hi${FG_RESET}    ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(result, `${BG}${BAR} ${FG}hi${FG_RESET}   ${BG_RESET}`);
	assert.equal(plain(result), `${BAR_GLYPH} hi   `, "one space after the bar, text verbatim, one column off the tail");
	assert.equal(plain(result).length, plain(line).length, "width unchanged");
});

test("the bar follows the message background: no background-toggle sequences — it sits inside the Box's background", () => {
	const line = `${BG} ${FG}hi${FG_RESET}    ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	// the bar sits right after the background sequence: the background block's left edge stays merged — no notch
	assert.equal(result.startsWith(`${BG}${BAR}`), true, "the bar lands right after the background");
	assert.equal(result.includes(BG_RESET + BAR), false, "no background-close inserted before the bar");
	assert.equal(result.split(BG_RESET).length - 1, 1, "only the tail's one 49m (none added)");
	assert.equal(result.split(BG).length - 1, 1, "only the head's one 48m (no restore inserted)");
});

test("a long row (one padding column left at the tail — the Box's minimal case) also fits: bar + space replace padding + that column", () => {
	const line = `${BG} ${FG}body-exact-width${FG_RESET} ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(plain(result), `${BAR_GLYPH} body-exact-width`, "the one tail padding column was eaten");
	assert.equal(plain(result).length, plain(line).length, "width unchanged");
});

test("an empty padding row (the box's top/bottom blanks) also eats the first cell — the text space comes out of the padding", () => {
	const line = `${BG}${" ".repeat(20)}${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(plain(result), `${BAR_GLYPH}${" ".repeat(19)}`);
	assert.equal(plain(result).length, 20);
});

test("the OSC 133 zone marker and background sequences stay before the bar", () => {
	const line = `${ZONE}${BG} ab${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(result, `${ZONE}${BG}${BAR}ab${BG_RESET}`, "the zone marker and background prefixes kept verbatim");
	assert.equal(plain(result), `${BAR_GLYPH}ab`, "no tail padding to borrow → this row skips the extra space (never widen)");
});

test("the OSC 133 zone marker does not disturb the tail-padding detection", () => {
	const line = `${ZONE}${BG} ab${BG_RESET}   `;
	const result = addBarToLine(line, BAR);

	assert.equal(result, `${ZONE}${BG}${BAR} ab${BG_RESET}  `, "the usual space after the bar, one column off the tail padding");
	assert.equal(plain(result).length, plain(line).length);
});

test("outputPad = 0: even the bar itself borrows a tail column, plus one space before the text", () => {
	const line = `${BG}${FG}ab${FG_RESET}   ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	// the head's background + foreground prefixes both count as zero-width: the bar lands after them, before the text
	assert.equal(result, `${BG}${FG}${BAR} ab${FG_RESET} ${BG_RESET}`);
	assert.equal(plain(result).length, plain(line).length, "width unchanged");
});

test("outputPad = 0 with one tail column left: the bar is kept, the extra space is not", () => {
	const line = `${BG}${FG}ab${FG_RESET} ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(result, `${BG}${FG}${BAR}ab${FG_RESET}${BG_RESET}`);
	assert.equal(plain(result), `${BAR_GLYPH}ab`);
	assert.equal(plain(result).length, plain(line).length, "width unchanged");
});

test("outputPad = 0 with text filling the row exactly: rather no bar than a wider row", () => {
	const line = `${BG}${FG}exactfit${FG_RESET}${BG_RESET}`;
	assert.equal(addBarToLine(line, BAR), line);
});

test("the indent is adjustable (the indent parameter) — and never widens", () => {
	const line = `${BG} ${FG}ab${FG_RESET}      ${BG_RESET}`;
	assert.equal(plain(addBarToLine(line, BAR, 3)), `${BAR_GLYPH}   ab   `, "three spaces: the tail loses three columns");
	assert.equal(plain(addBarToLine(line, BAR, 99)).length, plain(line).length, "asking for more than the padding → degrades to bar-only at most");
});

test("spaces inside the text are not padding (content follows) — no chars eaten", () => {
	const line = `${BG}${FG}a b${FG_RESET}${BG_RESET}`;
	assert.equal(addBarToLine(line, BAR), line, "text at the head, no tail padding → returned verbatim");
});

test("empty and escape-only rows do not throw — verbatim", () => {
	assert.equal(addBarToLine("", BAR), "");
	assert.equal(addBarToLine(BG_RESET, BAR), BG_RESET);
});

test("color: the default slot is the accent (a foreground slot — no conversion)", () => {
	const theme = {
		getFgAnsi: (name: string) => {
			if (name === "accent") return "\u001b[38;2;137;184;194m"; // #89b8c2 = summer-night's teal
			throw new Error(`Unknown theme color: ${name}`);
		},
		getBgAnsi: (name: string) => {
			throw new Error(`Unknown theme background color: ${name}`);
		},
	};
	assert.equal(resolveBarAnsi(theme), "\u001b[38;2;137;184;194m");
});

test("color: the background slot selectedBg converts to a foreground (38/48 equivalent)", () => {
	const theme = {
		getFgAnsi: (name: string) => {
			throw new Error(`Unknown theme color: ${name}`);
		},
		getBgAnsi: (name: string) => {
			assert.equal(name, "selectedBg");
			return "\u001b[48;2;45;44;93m";
		},
	};
	assert.equal(resolveBarAnsi(theme), "\u001b[38;2;45;44;93m");
});

test("color: a 256-color skin likewise only swaps the 38/48 digit", () => {
	const theme = {
		getFgAnsi: () => {
			throw new Error("Unknown theme color");
		},
		getBgAnsi: () => "\u001b[48;5;17m",
	};
	assert.equal(resolveBarAnsi(theme), "\u001b[38;5;17m");
});

test("color: an explicitly named slot (e.g. toolDiffAdded) takes that foreground directly", () => {
	const theme = {
		getFgAnsi: (name: string) => (name === "toolDiffAdded" ? "\u001b[38;2;137;184;194m" : (() => { throw new Error("no"); })()),
		getBgAnsi: () => {
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(theme, "toolDiffAdded"), "\u001b[38;2;137;184;194m");
});

test("color: a missing preferred slot falls back selectedBg → toolDiffAdded; none at all → undefined", () => {
	const noAccent = {
		getFgAnsi: (name: string) => {
			if (name === "toolDiffAdded") return "\u001b[38;2;1;2;3m";
			throw new Error("no");
		},
		getBgAnsi: () => {
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(noAccent), "\u001b[38;2;1;2;3m", "accent and selectedBg both missing → toolDiffAdded");

	// a common old skin: selectedBg but no accent — should land on selectedBg's 38 conversion
	const legacy = {
		getFgAnsi: (name: string) => {
			throw new Error("no");
		},
		getBgAnsi: (name: string) => {
			if (name === "selectedBg") return "\u001b[48;2;45;44;93m";
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(legacy), "\u001b[38;2;45;44;93m", "accent missing → selectedBg");

	const empty = {
		getFgAnsi: () => {
			throw new Error("no");
		},
		getBgAnsi: () => {
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(empty), undefined);
	assert.equal(resolveBarAnsi(undefined), undefined);
});

test("the patch: one wrapper only — a repeat install just swaps the color source", () => {
	let renderCalls = 0;
	class Fake {
		render(width: number): string[] {
			renderCalls += 1;
			return [`${BG} body${" ".repeat(Math.max(0, width - 5))}${BG_RESET}`];
		}
	}

	const first = installUserMessageBar({
		UserMessageComponent: Fake as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => ({ getFgAnsi: () => "\u001b[38;2;1;2;3m", getBgAnsi: () => "" }),
		glyph: "|",
	});
	assert.equal(first, true);

	const second = installUserMessageBar({
		UserMessageComponent: Fake as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => ({ getFgAnsi: () => "\u001b[38;2;4;5;6m", getBgAnsi: () => "" }),
		glyph: "|",
	});
	assert.equal(second, false, "the second call must not wrap again");

	const lines = new Fake().render(10);
	assert.equal(renderCalls, 1, "the original render ran only once");
	assert.equal(lines.length, 1);
	assert.equal(plain(lines[0]), "| body    ", "only a bar (+ one indent) was added — with the new color source");
	assert.equal(lines[0].includes("\u001b[38;2;4;5;6m"), true, "the color source was updated");
});

test("the patch: an unresolvable color → returned verbatim (no throw, no bar)", () => {
	class Fake {
		render(): string[] {
			return [`${BG} body${BG_RESET}`];
		}
	}
	installUserMessageBar({
		UserMessageComponent: Fake as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => undefined,
		glyph: "|",
	});
	assert.deepEqual(new Fake().render(), [`${BG} body${BG_RESET}`]);
});

test("the patch: a prototype without render → nothing happens", () => {
	class Weird {}
	const installed = installUserMessageBar({
		UserMessageComponent: Weird as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => ({ getFgAnsi: () => "\u001b[38;2;1;2;3m", getBgAnsi: () => "" }),
	});
	assert.equal(installed, false);
});
