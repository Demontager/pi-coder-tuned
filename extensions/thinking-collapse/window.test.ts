/**
 * Tests for window.ts — the thinking single-line scrolling window's pure logic (all-line
 * joining, head truncation, backtick pairing, fallback clipping).
 *
 * Run with:  node --test clients/pi/extensions/thinking-collapse/window.test.ts
 *
 * The module under test imports no pi / pi-tui (the width function `widthOf` is
 * injected), so a fake is fed: ASCII = 1 column, CJK fullwidth = 2 columns, `…` is also
 * 1 column — verified identical to pi-tui's `visibleWidth`. Assertions compare plain
 * text directly.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	ELLIPSIS,
	HEADER_LABEL,
	ITALIC_OFF,
	buildThinkingWindow,
	clipToTail,
	findCodeSpanEnd,
	joinAllLines,
	normalizeTabs,
	stripUnpairedBackticks,
	truncateTail,
} from "./window.ts";

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

/** The production call: ANSI off (assertions read plain text). */
function render(markdown: string, availableWidth: number): string {
	return buildThinkingWindow(markdown, availableWidth, widthOf, false);
}

const FIRST_PREFIX = HEADER_LABEL;

/** Assert that an output row's backticks **pair among themselves** (marked cannot pair it with another row's into a cross-row code span). */
function assertBalancedBackticks(line: string): void {
	let i = 0;
	while (i < line.length) {
		if (line[i] !== "`") {
			i++;
			continue;
		}
		const end = findCodeSpanEnd(line, i);
		assert.notEqual(end, -1, `unpaired backtick: ${JSON.stringify(line)}`);
		i = end;
	}
}

describe("normalizeTabs", () => {
	it("tabs become three spaces like pi's markdown renderer", () => {
		assert.equal(normalizeTabs("a\tb"), "a   b");
	});
});

describe("joinAllLines", () => {
	it("joins ascii lines with exactly one space", () => {
		assert.equal(joinAllLines(["hello", "world"]), "hello world");
	});

	it("keeps a single spaces inside a line but collapses runs", () => {
		assert.equal(joinAllLines(["a b", "c   d"]), "a b c d");
	});

	it("drops indentation and blank-ish lines", () => {
		assert.equal(joinAllLines(["    indented", "   ", "next"]), "indented next");
	});

	it("does not add a space between two wide characters", () => {
		assert.equal(joinAllLines(["用户在问", "这个操作的流程"]), "用户在问这个操作的流程");
	});

	it("does not add a space around CJK punctuation", () => {
		assert.equal(joinAllLines(["显示逻辑，", "现在是四行"]), "显示逻辑，现在是四行");
		assert.equal(joinAllLines(["看这里：", "下一行"]), "看这里：下一行");
	});

	it("does not add a space after an opening bracket or before a closing one", () => {
		assert.equal(joinAllLines(["call(", ")"]), "call()");
		assert.equal(joinAllLines(["summary", ".ts"]), "summary.ts");
	});

	it("does add a space after an ascii comma or in mixed text", () => {
		assert.equal(joinAllLines(["hello,", "world"]), "hello, world");
		assert.equal(joinAllLines(["看这个 file", "下一行"]), "看这个 file 下一行");
	});

	it("skips blank lines so paragraphs run together with no break", () => {
		// blank lines are paragraph splits: skipped, the previous paragraph's end continues straight into the next's start (a space between ASCII)
		assert.equal(joinAllLines(["first para", "", "second para"]), "first para second para");
	});

	it("inserts a comma at a CJK paragraph break", () => {
		// a paragraph joint between CJK ↔ CJK gets a comma — the two paragraphs separate visually
		assert.equal(joinAllLines(["第一段", "", "第二段"]), "第一段，第二段");
		assert.equal(joinAllLines(["第一段", "", "", "第二段"]), "第一段，第二段");
	});

	it("does not double up punctuation at a paragraph break", () => {
		// when the previous paragraph already ends with punctuation (CJK or an ASCII closer) nothing is added
		assert.equal(joinAllLines(["第一段。", "", "第二段"]), "第一段。第二段");
		assert.equal(joinAllLines(["ends.", "", "Next"]), "ends. Next");
	});

	it("keeps the space rule for ascii and mixed paragraph breaks", () => {
		assert.equal(joinAllLines(["English ends", "", "Next starts"]), "English ends Next starts");
		assert.equal(joinAllLines(["中文结尾", "", "English starts"]), "中文结尾 English starts");
	});

	it("does not insert a comma at an intra-paragraph line break", () => {
		// a wrap joint (no blank line) gets no comma: CJK still joins directly
		assert.equal(joinAllLines(["用户在问", "这个操作的流程"]), "用户在问这个操作的流程");
	});
});

describe("stripUnpairedBackticks", () => {
	it("keeps a balanced code span", () => {
		assert.equal(stripUnpairedBackticks("a `code` b"), "a `code` b");
	});

	it("drops a dangling closer left behind by a head clip", () => {
		assert.equal(stripUnpairedBackticks("xt here` and more"), "xt here and more");
	});

	it("drops a dangling opener", () => {
		assert.equal(stripUnpairedBackticks("a `code and more"), "a code and more");
	});

	it("keeps balanced runs next to a dropped run", () => {
		assert.equal(stripUnpairedBackticks("`a` `b"), "`a` b");
	});

	it("handles multi-backtick runs with the same rule as marked", () => {
		assert.equal(stripUnpairedBackticks("``a`` `b"), "``a`` b");
		assert.equal(stripUnpairedBackticks("`a`` b`"), "`a`` b`");
	});
});

describe("clipToTail / truncateTail", () => {
	it("returns the text unchanged when it fits", () => {
		assert.equal(clipToTail("abc", 3, widthOf), "abc");
		assert.equal(truncateTail("abc", 3, widthOf), "abc");
	});

	it("keeps the tail behind an ellipsis", () => {
		assert.equal(clipToTail("abcdef", 4, widthOf), "…def");
	});

	it("keeps the head before an ellipsis", () => {
		assert.equal(truncateTail("abcdef", 4, widthOf), "abc…");
	});

	it("drops a boundary space instead of leaving it floating before the ellipsis", () => {
		// greedily reaches "ab " then drops the trailing space (the row ends 1 column short, but no `the …` dangling space)
		assert.equal(truncateTail("ab cdef", 4, widthOf), "ab" + ELLIPSIS);
	});

	it("never exceeds the budget when a wide char straddles the boundary", () => {
		assert.equal(clipToTail("ab中文", 4, widthOf), "…文");
		assert.ok(widthOf(clipToTail("ab中文", 4, widthOf)) <= 4);
		assert.ok(widthOf(clipToTail("ab中", 3, widthOf)) <= 3);
	});

	it("returns nothing when there is no room for the ellipsis", () => {
		assert.equal(clipToTail("abcdef", 1, widthOf), "");
		assert.equal(clipToTail("abcdef", 0, widthOf), "");
	});
});

describe("buildThinkingWindow", () => {
	it("renders one paragraph as a labelled single line", () => {
		assert.equal(render("hello world", 40), `${FIRST_PREFIX}hello world`);
	});

	it("trims the body and normalizes tabs", () => {
		assert.equal(render("\n  a\tb  \n", 40), `${FIRST_PREFIX}a b`);
	});

	it("returns the original markdown when there is nothing to show", () => {
		assert.equal(render("   \n\n  ", 40), "   \n\n  ");
		assert.equal(render("", 40), "");
	});

	it("always outputs exactly one line, no matter how many paragraphs the thinking has", () => {
		for (const md of ["a\n\nb\n\nc\n\nd\n\ne", "a\nb\nc", "一段\n\n二段\n\n三段", "x".repeat(500)]) {
			const out = render(md, 40);
			assert.equal(out.split("\n").length, 1, `a newline appeared: ${JSON.stringify(out)}`);
		}
	});

	it("joins paragraphs with no break so the next one continues the previous line", () => {
		// blank-line paragraph splits are skipped: the previous paragraph's end continues into the next's start; a space between ASCII, a comma at a CJK paragraph joint
		assert.equal(render("first para\n\nsecond para\n\nthird", 60), `${FIRST_PREFIX}first para second para third`);
		assert.equal(render("第一段\n\n第二段", 60), `${FIRST_PREFIX}第一段，第二段`);
	});

	it("keeps a paragraph on one line by joining its own newlines", () => {
		assert.equal(render("line one\nline two", 40), `${FIRST_PREFIX}line one line two`);
	});

	it("keeps the whole thinking when it fits, without an ellipsis", () => {
		assert.equal(render("short thinking", 40), `${FIRST_PREFIX}short thinking`);
	});

	it("pushes the front out and marks it with an ellipsis when the thinking is too wide", () => {
		const text = "one two three four five six seven";
		const line = render(text, 20);
		assert.ok(line.startsWith(FIRST_PREFIX + ELLIPSIS));
		assert.ok(widthOf(line) <= 20);
		// the tail is always the source's end (the newest token written)
		const tail = line.slice(FIRST_PREFIX.length + 1);
		assert.ok(text.endsWith(tail), `tail ${JSON.stringify(tail)} is not a suffix of the source`);
	});

	it("does not pad a short last paragraph up to a full line", () => {
		// a short thinking is not backfilled: the tail is the newest content itself — the squeezed-out head is not pulled back
		// all CJK: a 33-column budget = `…`(1) + 14 CJK chars (28) + the paragraph comma (2) + a final char (2)
		const line = render("中".repeat(60) + "\n\n短", 40);
		assert.equal(line, `${FIRST_PREFIX}${ELLIPSIS}${"中".repeat(14)}，短`);
		assert.ok(line.endsWith("短"), `the tail must hold the newest content: ${JSON.stringify(line)}`);
	});

	it("leaves the tail blank when a short final paragraph does not fill the line", () => {
		// no backfill once settled either: the row width is the content itself — visibly short stays blank
		const line = render("开头写了一些内容\n\n尾", 60);
		assert.equal(line, `${FIRST_PREFIX}开头写了一些内容，尾`);
		assert.ok(widthOf(line) < 60, `must not be backfilled to full width: ${widthOf(line)}`);
	});

	it("renders the same scrolling line while streaming and after it settles", () => {
		// no isStreaming branch left: streaming and settled are one logic — the shape only follows content length
		const md = "第一段的内容\n\n第二段的内容\n\n尾";
		assert.equal(render(md, 60), render(md, 60));
		assert.equal(render(md, 60), `${FIRST_PREFIX}第一段的内容，第二段的内容，尾`);
	});

	it("grows the tail token by token without ever restarting the line", () => {
		// appended token by token: the tail is always the newest content, the prefix grows monotonically (or `…` pushes out the head) — never a new line
		const head = "第一段的内容在这里写了不少字\n\n第二段也写了一些内容\n\n";
		let previous = "";
		for (const tail of ["尾", "尾巴", "尾巴收", "尾巴收尾了"]) {
			const line = render(head + tail, 60);
			assert.equal(line.split("\n").length, 1);
			assert.ok(line.endsWith(tail), `the tail is not the newest token: ${JSON.stringify(line)}`);
			if (previous !== "") assert.ok(widthOf(line) >= widthOf(previous), "the row width must not regress");
			previous = line;
		}
	});

	it("keeps the rendered line within the available width", () => {
		const cases = [
			"a".repeat(200),
			"中文".repeat(80),
			"first `code span` tail",
			"first para\n\n" + "中文English mixed 混排 ".repeat(20),
			"x".repeat(30) + "\n\n" + "y".repeat(30) + "\n\n" + "z".repeat(30),
			"中文".repeat(60) + "\n\n尾",
			"`cut code span`\n\n尾\n\n再一段",
			"head `span` tail\n\n" + "x".repeat(3),
		];
		for (const text of cases) {
			for (const width of [8, 12, 20, 40, 80]) {
				const line = render(text, width);
				assert.equal(line.split("\n").length, 1, `a newline appeared: ${JSON.stringify(line)}`);
				assert.ok(widthOf(line) <= width, `width ${widthOf(line)} > ${width}: ${JSON.stringify(line)}`);
			}
		}
	});

	it("keeps backticks balanced inside the line so marked cannot merge lines", () => {
		// head truncation can cut a code span in half: the stray closing-backtick run must be deleted
		const text = "aaaa `inline code` bbbb\n\ncccc `another one` dddd";
		const line = render(text, 24);
		assert.equal(line.split("\n").length, 1);
		assertBalancedBackticks(line);
	});

	it("does not leak an empty line when the content ends with a paragraph break", () => {
		assert.equal(render("done thinking\n\n", 40), `${FIRST_PREFIX}done thinking`);
	});

	it("wraps the label in italic-off/on codes when ansi is enabled", () => {
		const line = buildThinkingWindow("x", 40, widthOf, true);
		assert.equal(line, `${ITALIC_OFF}${FIRST_PREFIX}${"\u001b[3m"}x`);
	});

	it("keeps the content budget narrower by the label width", () => {
		const text = "abcdefghij";
		// the label `Think: ` = 7 columns; width 12 → body budget 5 → `…` + 4 chars
		assert.equal(render(text, 12), `${FIRST_PREFIX}…ghij`);
	});

	it("drops the label instead of overflowing when the terminal is too narrow for it", () => {
		// width 8 < label 7 columns + `…` + 1 column of body: the label is dropped, the body owns the row
		const line = render("abcdefghij", 8);
		assert.equal(line, `${ELLIPSIS}defghij`);
		assert.ok(widthOf(line) <= 8);
	});

	it("renders no bar gutter", () => {
		const line = render("x".repeat(60) + "\n\nshort", 40);
		assert.ok(line.startsWith(HEADER_LABEL), `the label must be flush-left: ${JSON.stringify(line)}`);
		assert.ok(!line.includes("│"), `no vertical bar: ${JSON.stringify(line)}`);
	});
});
