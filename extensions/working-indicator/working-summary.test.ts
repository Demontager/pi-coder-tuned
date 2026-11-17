/**
 * Tests for working-summary.ts — the flattening + pure layout logic of the spinner line's
 * right-aligned prompt summary.
 *
 * Run with:  node --test clients/pi/extensions/working-indicator/working-summary.test.ts
 *
 * The module under test imports no pi / pi-tui (the width function is injected), so this test
 * feeds a trivial fake width function: ASCII/halfwidth = 1 column, CJK fullwidth = 2 columns —
 * consistent with pi-tui `visibleWidth` on the characters these cases involve (`…`, `✦` are
 * both 1 column).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DEFAULT_MIN_GAP,
	MAX_PROMPT_SCAN_CHARS,
	MIN_SUMMARY_TEXT_WIDTH,
	SUMMARY_MARKER,
	availableSummaryTextWidth,
	fitToWidth,
	flattenPrompt,
	layoutPromptSummary,
} from "./working-summary.ts";

/** Fake width function: the usual CJK fullwidth ranges count 2 columns, everything else 1 (incl. `…` / `✦`). */
function fakeWidth(text: string): number {
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

const MARKER_WIDTH = fakeWidth(`${SUMMARY_MARKER} `); // "✦ " = 2

describe("flattenPrompt: line joining", () => {
	it("joins multiple lines into one compact line", () => {
		assert.equal(flattenPrompt("hello\nworld"), "hello world");
		assert.equal(flattenPrompt("hello\r\nworld"), "hello world");
		assert.equal(flattenPrompt("hello\rworld"), "hello world");
	});

	it("treats unicode line/paragraph separators and VT/FF as line breaks", () => {
		assert.equal(flattenPrompt("a\u2028b"), "a b");
		assert.equal(flattenPrompt("a\u2029b"), "a b");
		assert.equal(flattenPrompt("a\u0085b"), "a b");
		assert.equal(flattenPrompt("a\u000bb"), "a b");
		assert.equal(flattenPrompt("a\u000cb"), "a b");
	});

	it("does not insert a space between two CJK characters at a line break", () => {
		assert.equal(flattenPrompt("我要优化\n这个模块"), "我要优化这个模块");
		assert.equal(flattenPrompt("第一行\n第二行\n第三行"), "第一行第二行第三行");
	});

	it("inserts one space for CJK/ASCII mixed boundaries", () => {
		assert.equal(flattenPrompt("优化\nmodule"), "优化 module");
		assert.equal(flattenPrompt("the\n模块"), "the 模块");
	});

	it("keeps a space after ASCII sentence punctuation", () => {
		assert.equal(flattenPrompt("hello,\nworld"), "hello, world");
		assert.equal(flattenPrompt("done.\nNext step"), "done. Next step");
	});

	it("does not insert a space around CJK punctuation", () => {
		assert.equal(flattenPrompt("他说：\n「你好」"), "他说：「你好」");
		assert.equal(flattenPrompt("好的，\n谢谢"), "好的，谢谢");
	});

	it("does not break paths or bracket pairs split across lines", () => {
		assert.equal(flattenPrompt("working-summary\n.ts"), "working-summary.ts");
		assert.equal(flattenPrompt("call(\n)"), "call()");
		assert.equal(flattenPrompt("arr[\n0]"), "arr[0]");
	});

	it("skips blank lines without adding extra spaces", () => {
		assert.equal(flattenPrompt("a\n\n\nb"), "a b");
		assert.equal(flattenPrompt("a\n   \n\t\nb"), "a b");
	});

	it("summarizes prompts that start with blank lines (old code returned nothing)", () => {
		assert.equal(flattenPrompt("\n\nworld"), "world");
		assert.equal(flattenPrompt("   \nworld"), "world");
	});
});

describe("flattenPrompt: whitespace compaction", () => {
	it("strips indentation (leading/trailing whitespace of each line)", () => {
		assert.equal(flattenPrompt("  a\n\t\tb\n     c"), "a b c");
	});

	it("collapses runs of 2+ spaces into one, keeps single spaces", () => {
		assert.equal(flattenPrompt("a     b"), "a b");
		assert.equal(flattenPrompt("a  b"), "a b");
		assert.equal(flattenPrompt("a b c"), "a b c");
	});

	it("turns tabs into a single space instead of gluing words", () => {
		assert.equal(flattenPrompt("a\tb"), "a b");
		assert.equal(flattenPrompt("a\t\tb"), "a b");
	});

	it("normalizes unicode spaces to a regular space", () => {
		assert.equal(flattenPrompt("a\u00a0b"), "a b"); // NBSP
		assert.equal(flattenPrompt("a\u3000b"), "a b"); // ideographic space
		assert.equal(flattenPrompt("a\u2003b"), "a b"); // em space
	});

	it("removes zero-width characters that would pollute width math", () => {
		assert.equal(flattenPrompt("a\u200bb"), "ab");
		assert.equal(flattenPrompt("\ufeffhello"), "hello");
		assert.equal(flattenPrompt("a\u200db"), "ab");
	});

	it("trims surrounding whitespace of the whole prompt", () => {
		assert.equal(flattenPrompt("  hello  "), "hello");
	});
});

describe("flattenPrompt: noise removal", () => {
	it("strips ANSI escape sequences", () => {
		assert.equal(flattenPrompt("\u001b[31mred\u001b[0m text"), "red text");
		assert.equal(flattenPrompt("\u001b]0;title\u0007body"), "body");
	});

	it("removes control characters", () => {
		assert.equal(flattenPrompt("a\u0000b\u001fc"), "abc");
	});

	it("strips markdown list bullets, blockquotes and headings", () => {
		assert.equal(flattenPrompt("- one\n- two"), "one two");
		assert.equal(flattenPrompt("* one\n* two"), "one two");
		assert.equal(flattenPrompt("1. a\n2. b"), "a b");
		assert.equal(flattenPrompt("> quoted\n> text"), "quoted text");
		assert.equal(flattenPrompt("# Title\nbody"), "Title body");
		assert.equal(flattenPrompt("> - nested item"), "nested item");
	});

	it("does not strip bullets when there is no following whitespace", () => {
		assert.equal(flattenPrompt("-1"), "-1");
		assert.equal(flattenPrompt("**bold** text"), "**bold** text");
	});

	it("drops code-fence marker lines but keeps the fenced content", () => {
		assert.equal(flattenPrompt("```ts\nconst x = 1\n```"), "const x = 1");
		assert.equal(flattenPrompt("```\nplain\n```"), "plain");
	});

	it("drops horizontal-rule lines", () => {
		assert.equal(flattenPrompt("a\n---\nb"), "a b");
		assert.equal(flattenPrompt("a\n***\nb"), "a b");
	});

	it("returns empty string for empty / whitespace-only / noise-only prompts", () => {
		assert.equal(flattenPrompt(""), "");
		assert.equal(flattenPrompt("   \n\t\n  "), "");
		assert.equal(flattenPrompt("```\n```"), "");
		assert.equal(flattenPrompt("---"), "");
	});
});

describe("flattenPrompt: scan cap", () => {
	it("only scans the first MAX_PROMPT_SCAN_CHARS characters", () => {
		const prompt = "x".repeat(MAX_PROMPT_SCAN_CHARS + 500);
		const flat = flattenPrompt(prompt);
		assert.equal(flat.length, MAX_PROMPT_SCAN_CHARS);
	});

	it("does not leave a lone surrogate when the cap cuts a pair", () => {
		// an explicit odd cap guarantees the cut lands mid surrogate pair
		const flat = flattenPrompt("😀😀😀", 5);
		assert.equal(flat, "😀😀");
		const last = flat.charCodeAt(flat.length - 1);
		assert.ok(!(last >= 0xd800 && last <= 0xdbff), "no lone high surrogate at the end");
	});
});

describe("fitToWidth", () => {
	it("returns text unchanged when it fits", () => {
		assert.equal(fitToWidth("hello", 10, fakeWidth), "hello");
		assert.equal(fitToWidth("hello", 5, fakeWidth), "hello");
	});

	it("truncates ASCII to the longest fitting prefix", () => {
		assert.equal(fitToWidth("hello world", 5, fakeWidth), "hello");
		assert.equal(fitToWidth("hello", 1, fakeWidth), "h");
	});

	it("never splits a double-width character", () => {
		// the CJK fixture: 2 columns per char — width 5 fits 2 chars (4 columns); a 3rd would reach 6.
		assert.equal(fitToWidth("我要优化", 5, fakeWidth), "我要");
		assert.equal(fitToWidth("我要优化", 4, fakeWidth), "我要");
		assert.equal(fitToWidth("我要优化", 3, fakeWidth), "我");
	});

	it("returns empty string for non-positive maxWidth", () => {
		assert.equal(fitToWidth("hello", 0, fakeWidth), "");
		assert.equal(fitToWidth("hello", -3, fakeWidth), "");
	});

	it("does not split surrogate pairs", () => {
		const emoji = "😀😀😀"; // each code point is 2 UTF-16 units (the fake width function counts it as 1 column)
		const fitted = fitToWidth(emoji, 1, fakeWidth);
		assert.equal(fitted, "😀");
		assert.ok(!fitted.endsWith("\ud83d"));
	});
});

describe("availableSummaryTextWidth", () => {
	it("is the width the layout actually gives the summary text", () => {
		const text = "x".repeat(300);
		for (const totalWidth of [40, 60, 100, 137]) {
			const avail = availableSummaryTextWidth({ leftWidth: 13, totalWidth, widthOf: fakeWidth });
			const layout = layoutPromptSummary({
				promptText: text,
				leftWidth: 13,
				totalWidth,
				widthOf: fakeWidth,
			});
			assert.ok(layout, `width ${totalWidth}`);
			// the truncated body (incl. `…`) fills the available width exactly.
			assert.equal(fakeWidth(layout.summaryText), avail, `width ${totalWidth}`);
		}
	});

	it("is capped by maxWidth like the layout is", () => {
		const avail = availableSummaryTextWidth({ leftWidth: 13, totalWidth: 200, maxWidth: 50, widthOf: fakeWidth });
		assert.equal(avail, 50 - MARKER_WIDTH);
	});

	it("goes to zero / negative when there is no room left", () => {
		assert.equal(availableSummaryTextWidth({ leftWidth: 70, totalWidth: 70, widthOf: fakeWidth }), -MARKER_WIDTH - DEFAULT_MIN_GAP);
		assert.ok(availableSummaryTextWidth({ leftWidth: 90, totalWidth: 70, widthOf: fakeWidth }) < 0);
	});

	it("honours a custom marker and minGap like the layout does", () => {
		const marker = "記"; // 2 columns under the fake width function
		const avail = availableSummaryTextWidth({
			leftWidth: 10,
			totalWidth: 60,
			widthOf: fakeWidth,
			marker,
			minGap: 5,
		});
		assert.equal(avail, 60 - 10 - 5 - fakeWidth(`${marker} `));
	});
});

describe("layoutPromptSummary", () => {

	const leftWidth = fakeWidth("Working (23s)"); // 13

	it("shows a short prompt in full, right-aligned via gap", () => {
		const layout = layoutPromptSummary({
			promptText: "hi",
			leftWidth,
			totalWidth: 60,
			widthOf: fakeWidth,
		});
		assert.ok(layout);
		assert.equal(layout.summaryText, "hi"); // fits → no ellipsis
		// right-align invariant: left segment + gap + "✦ " + summary === budget
		assert.equal(leftWidth + layout.gap + MARKER_WIDTH + fakeWidth(layout.summaryText), 60);
		assert.ok(layout.gap >= DEFAULT_MIN_GAP);
	});

	it("truncates a long prompt and appends the ellipsis", () => {
		const text = "a".repeat(200);
		const layout = layoutPromptSummary({
			promptText: text,
			leftWidth,
			totalWidth: 60,
			widthOf: fakeWidth,
		});
		assert.ok(layout);
		assert.ok(layout.summaryText.endsWith("…"));
		// truncation lands the gap exactly on the floor
		assert.equal(layout.gap, DEFAULT_MIN_GAP);
		assert.equal(leftWidth + layout.gap + MARKER_WIDTH + fakeWidth(layout.summaryText), 60);
	});

	it("truncates the whole flattened paragraph, not just the first line", () => {
		// a short first line with the information in later lines — the summary must reach past the first line.
		const flat = flattenPrompt("修 bug\n" + "细节内容".repeat(200));
		const layout = layoutPromptSummary({
			promptText: flat,
			leftWidth,
			totalWidth: 60,
			widthOf: fakeWidth,
		});
		assert.ok(layout);
		assert.ok(layout.summaryText.startsWith("修 bug 细节内容"), layout.summaryText);
		assert.ok(layout.summaryText.endsWith("…"));
	});

	it("keeps the right-align invariant when truncation lands inside a CJK char", () => {
		// an all-CJK line: the cut may fall one column short; the slack must fold into the gap, not overflow.
		const text = "我要优化这个很长的提示词".repeat(4);
		for (const totalWidth of [40, 41, 42, 43, 60, 79]) {
			const layout = layoutPromptSummary({
				promptText: text,
				leftWidth,
				totalWidth,
				widthOf: fakeWidth,
			});
			if (layout === null) continue;
			assert.equal(
				leftWidth + layout.gap + MARKER_WIDTH + fakeWidth(layout.summaryText),
				totalWidth,
				`width ${totalWidth}`,
			);
			assert.ok(layout.gap >= DEFAULT_MIN_GAP, `width ${totalWidth}`);
			assert.ok(fakeWidth(layout.summaryText) <= totalWidth, `width ${totalWidth}`);
		}
	});

	it("drops trailing spaces before the ellipsis", () => {
		const layout = layoutPromptSummary({
			promptText: "hello world and beyond",
			leftWidth,
			totalWidth: 13 + DEFAULT_MIN_GAP + MARKER_WIDTH + 6, // summary body budget exactly 6
			widthOf: fakeWidth,
		});
		assert.ok(layout);
		assert.equal(layout.summaryText, "hello…"); // not "hello …"
	});

	it("returns null when the prompt is empty", () => {
		assert.equal(
			layoutPromptSummary({ promptText: "", leftWidth, totalWidth: 80, widthOf: fakeWidth }),
			null,
		);
	});

	it("returns null when there is no room for the summary", () => {
		// the budget is entirely eaten by the left segment
		assert.equal(
			layoutPromptSummary({
				promptText: "hi",
				leftWidth: 70,
				totalWidth: 70,
				widthOf: fakeWidth,
			}),
			null,
		);
		// remaining width below the summary-body floor (after 2-column marker + 1-column minGap, under MIN_SUMMARY_TEXT_WIDTH)
		const tight = leftWidth + DEFAULT_MIN_GAP + MARKER_WIDTH + MIN_SUMMARY_TEXT_WIDTH - 1;
		assert.equal(
			layoutPromptSummary({
				promptText: "hi there",
				leftWidth,
				totalWidth: tight,
				widthOf: fakeWidth,
			}),
			null,
		);
		// exactly at the floor it can show
		const ok = tight + 1;
		assert.ok(
			layoutPromptSummary({
				promptText: "hi there",
				leftWidth,
				totalWidth: ok,
				widthOf: fakeWidth,
			}),
		);
	});

	it("honors a custom minGap", () => {
		const layout = layoutPromptSummary({
			promptText: "x".repeat(100),
			leftWidth,
			totalWidth: 60,
			widthOf: fakeWidth,
			minGap: 8,
		});
		assert.ok(layout);
		assert.equal(layout.gap, 8);
		assert.equal(leftWidth + 8 + MARKER_WIDTH + fakeWidth(layout.summaryText), 60);
	});

	it("caps the summary segment at maxWidth even when there is room to spare", () => {
		const layout = layoutPromptSummary({
			promptText: "x".repeat(200),
			leftWidth,
			totalWidth: 100,
			widthOf: fakeWidth,
			maxWidth: 50,
		});
		assert.ok(layout);
		// the whole segment (marker + body) stays under the cap
		assert.ok(MARKER_WIDTH + fakeWidth(layout.summaryText) <= 50);
		// the right-align invariant still holds; the headroom folds into the gap (gap far above the floor)
		assert.equal(leftWidth + layout.gap + MARKER_WIDTH + fakeWidth(layout.summaryText), 100);
		assert.ok(layout.gap > DEFAULT_MIN_GAP);
		assert.ok(layout.summaryText.endsWith("…"));
	});

	it("shows a short line in full when it fits within maxWidth", () => {
		const layout = layoutPromptSummary({
			promptText: "hi",
			leftWidth,
			totalWidth: 100,
			widthOf: fakeWidth,
			maxWidth: 50,
		});
		assert.ok(layout);
		assert.equal(layout.summaryText, "hi");
		assert.equal(leftWidth + layout.gap + MARKER_WIDTH + 2, 100);
	});

	it("returns null when maxWidth leaves no room for the minimum text", () => {
		assert.equal(
			layoutPromptSummary({
				promptText: "hi there",
				leftWidth,
				totalWidth: 100,
				widthOf: fakeWidth,
				maxWidth: MARKER_WIDTH + MIN_SUMMARY_TEXT_WIDTH - 1,
			}),
			null,
		);
		// exactly at the floor it can show
		assert.ok(
			layoutPromptSummary({
				promptText: "hi there",
				leftWidth,
				totalWidth: 100,
				widthOf: fakeWidth,
				maxWidth: MARKER_WIDTH + MIN_SUMMARY_TEXT_WIDTH,
			}),
		);
	});

	it("honors a custom marker with a different width", () => {
		const marker = "記"; // CJK — 2 columns under the fake width function (+ the space = a 3-column prefix)
		const layout = layoutPromptSummary({
			promptText: "x".repeat(100),
			leftWidth,
			totalWidth: 60,
			widthOf: fakeWidth,
			marker,
		});
		assert.ok(layout);
		assert.equal(
			leftWidth + layout.gap + fakeWidth(`${marker} `) + fakeWidth(layout.summaryText),
			60,
		);
	});

	it("holds the invariant across a sweep of widths and prompts", () => {
		const lines = [
			"short",
			"/init 我要优化这个模块的加载过程",
			"x".repeat(300),
			"中英 mixed 内容 with 一些 words 和标点符号，测试截断",
			flattenPrompt("多行\n提示词\nmixed with 一些内容，压平后整段参与截断测试"),
		];
		for (const line of lines) {
			for (let totalWidth = 10; totalWidth <= 140; totalWidth++) {
				// cover both shapes at once: uncapped and half-screen cap (same as index.ts's arguments)
				for (const maxWidth of [undefined, Math.floor(totalWidth / 2)]) {
					const layout = layoutPromptSummary({
						promptText: line,
						leftWidth,
						totalWidth,
						widthOf: fakeWidth,
						maxWidth,
					});
					if (layout === null) continue;
					const tag = `line=${JSON.stringify(line.slice(0, 8))} width=${totalWidth} max=${maxWidth}`;
					assert.equal(
						leftWidth + layout.gap + MARKER_WIDTH + fakeWidth(layout.summaryText),
						totalWidth,
						tag,
					);
					assert.ok(layout.gap >= DEFAULT_MIN_GAP, tag);
					if (maxWidth !== undefined) {
						assert.ok(MARKER_WIDTH + fakeWidth(layout.summaryText) <= maxWidth, tag);
					}
					// the summary is either the whole line (fits) or ends with the ellipsis (truncated)
					if (layout.summaryText !== line) {
						assert.ok(layout.summaryText.endsWith("…"), tag);
					}
				}
			}
		}
	});
});
