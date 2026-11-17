import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MARK_BLANK,
	MARK_CELL,
	MARK_COLS,
	MARK_GLYPH_WIDTH,
	MARK_INDENT,
	MARK_ROWS,
	MARK_WIDTH,
	attachSideText,
	composeHeaderLines,
	markCellFilled,
	markLines,
	shortenPath,
} from "./logo.ts";

/** Strip ANSI — only geometry is being looked at. */
const plain = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, "");

test("the mark is a 4×4 grid, 12 wide; one leading blank makes the row 13", () => {
	assert.equal(MARK_CELL, "███");
	assert.equal(MARK_BLANK, "   ");
	assert.equal(MARK_INDENT, " ");
	assert.equal(MARK_ROWS, 4);
	assert.equal(MARK_COLS, 4);
	assert.equal(MARK_GLYPH_WIDTH, 12);
	assert.equal(MARK_WIDTH, MARK_INDENT.length + MARK_GLYPH_WIDTH);
	assert.equal(MARK_WIDTH, 13);
});

test("markLines' four-row shape (incl. the cell added back) and the left-side blank", () => {
	assert.deepEqual(markLines(), [
		" █████████   ", // the top bar: three filled cells
		" ███   ███   ", // left leg + the right leg's upper body
		" ██████   ███", // left leg + the inner fill + right leg (the (5,5) cell upstream's settled frame missed)
		" ███      ███", // left leg + the right leg's foot
	]);
	for (const line of markLines()) {
		assert.ok(line.startsWith(MARK_INDENT), "every row must lead with one space — never touch the left edge");
		assert.equal(line.length, MARK_WIDTH, "every row's visible width must match, or the side text goes crooked");
	}
});

test("markCellFilled agrees with the grid table; out of bounds counts as blank", () => {
	markLines().forEach((line, row) => {
		for (let col = 0; col < MARK_COLS; col++) {
			assert.equal(
				markCellFilled(row, col),
				line.slice(MARK_INDENT.length + col * 3, MARK_INDENT.length + col * 3 + 3) === MARK_CELL,
				`(${row},${col}) colors differently from the whole-row render`,
			);
		}
	});
	assert.equal(markCellFilled(9, 9), false);
	assert.equal(markCellFilled(-1, 0), false);
});

test("the right leg is not a dangling foot (regression: upstream phase 6 missed the (2,3) cell)", () => {
	// the last row's rightmost cell filled → the row above's rightmost must be filled too, or the leg is broken
	assert.equal(markCellFilled(MARK_ROWS - 1, MARK_COLS - 1), true);
	assert.equal(markCellFilled(MARK_ROWS - 2, MARK_COLS - 1), true);
});

test("attachSideText: two side texts land on rows 1 and 2; the rest stay verbatim and equal-width", () => {
	const out = attachSideText(markLines().map((l) => `[${l}]`), ["V", "C"]);
	assert.equal(out.length, MARK_ROWS);
	assert.equal(out[1], `[${markLines()[1]}]  V`);
	assert.equal(out[2], `[${markLines()[2]}]  C`);
	assert.equal(out[0], `[${markLines()[0]}]`);
	assert.equal(out[3], `[${markLines()[3]}]`);
});

test("attachSideText: ANSI plays no part in column math", () => {
	const colored = markLines().map((l) => `\x1b[38;2;121;214;193m${l}\x1b[39m`);
	const out = attachSideText(colored, ["A", "B"]);
	// a side-text row: ANSI-stripped, the side text lands right after the full width + 2 spaces
	for (const [i, text] of [
		[1, "A"],
		[2, "B"],
	] as const) {
		const stripped = plain(out[i]!);
		assert.equal(stripped, `${markLines()[i]}  ${text}`);
		assert.equal(stripped.indexOf(text), MARK_WIDTH + 2);
	}
	// rows without side text stay the same full width
	assert.equal(plain(out[0]!), " █████████   ");
	assert.equal(plain(out[0]!).length, MARK_WIDTH);
});

test("attachSideText: empty side text / more texts than rows / zero rows — none blows up", () => {
	const lines = markLines();
	assert.deepEqual(attachSideText(lines, []), [...lines]);
	assert.equal(attachSideText(lines, ["a", "b", "c", "d", "e"]).length, MARK_ROWS);
	assert.deepEqual(attachSideText([], ["a"]), []);
	// the empty-string slot takes no space: only one row gets text, the rest stay equal-width
	const blanked = attachSideText(lines, ["", "only"]);
	assert.equal(blanked.filter((l) => l.endsWith("only")).length, 1);
	assert.equal(blanked.filter((l) => l.endsWith("only") && l !== blanked[blanked.findIndex((x) => x.endsWith("only"))]).length, 0);
});

test("every row's visible width is exactly MARK_WIDTH (side text or not — the side column stays straight)", () => {
	for (const line of markLines()) assert.equal(plain(line).length, MARK_WIDTH);
	for (const line of markLines((f) => (f ? `\x1b[31m${MARK_CELL}\x1b[39m` : MARK_BLANK))) {
		assert.equal(plain(line).length, MARK_WIDTH);
	}
});

test("composeHeaderLines: exactly one blank row between sections, none left by a missing section", () => {
	assert.deepEqual(composeHeaderLines({ logo: ["a", "b"], hints: "h", onboarding: "o" }), ["a", "b", "", "h", "", "o"]);
	assert.deepEqual(composeHeaderLines({ logo: ["a"], hints: "h" }), ["a", "", "h"]);
	assert.deepEqual(composeHeaderLines({ logo: [], hints: "h", onboarding: "o" }), ["h", "", "o"]);
	assert.deepEqual(composeHeaderLines({ logo: [] }), []);
	assert.deepEqual(composeHeaderLines({ logo: [], onboarding: "o" }), ["o"]);
});

test("shortenPath: shortened inside home, verbatim outside", () => {
	assert.equal(shortenPath("/Users/bachi", "/Users/bachi"), "~");
	assert.equal(shortenPath("/Users/bachi/jaylli/litellm-any", "/Users/bachi"), "~/jaylli/litellm-any");
	assert.equal(shortenPath("/tmp/x", "/Users/bachi"), "/tmp/x");
	// same prefix but a different directory (/Users/bachix) must not be shortened as a sub-path
	assert.equal(shortenPath("/Users/bachix", "/Users/bachi"), "/Users/bachix");
	assert.equal(shortenPath("/srv/app", undefined), "/srv/app");
});
