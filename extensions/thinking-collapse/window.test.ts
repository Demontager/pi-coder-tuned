/**
 * Tests for window.ts — thinking 单行连续滚动窗口的纯逻辑（全行拼接、头部截断、反引号配对、兜底截断）。
 *
 * Run with:  node --test clients/pi/extensions/thinking-collapse/window.test.ts
 *
 * 被测模块不 import pi / pi-tui（宽度函数 `widthOf` 是注入的），所以这里喂假实现：
 * ASCII = 1 列、CJK 全角 = 2 列、`…` 也是 1 列 —— 与 pi-tui 的 `visibleWidth`
 * 已核对一致。断言直接比对纯文本。
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

/** 假宽度函数：CJK 常见全角区间按 2 列，其余按 1 列。 */
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

/** 生产调用：不开 ANSI（断言直接看纯文本）。 */
function render(markdown: string, availableWidth: number): string {
	return buildThinkingWindow(markdown, availableWidth, widthOf, false);
}

const FIRST_PREFIX = HEADER_LABEL;

/** 断言某条出口行的反引号**自身配对**（marked 不会拿它跟别的行配成跨行 code span）。 */
function assertBalancedBackticks(line: string): void {
	let i = 0;
	while (i < line.length) {
		if (line[i] !== "`") {
			i++;
			continue;
		}
		const end = findCodeSpanEnd(line, i);
		assert.notEqual(end, -1, `落单的反引号：${JSON.stringify(line)}`);
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
		// 空行是段落分隔：跳过后上一段的结尾直接接续下一段的开头（ASCII 之间仍是空格）
		assert.equal(joinAllLines(["first para", "", "second para"]), "first para second para");
	});

	it("inserts a comma at a CJK paragraph break", () => {
		// 段落接缝处中文 ↔ 中文补逗号，把两段在视觉上分开
		assert.equal(joinAllLines(["第一段", "", "第二段"]), "第一段，第二段");
		assert.equal(joinAllLines(["第一段", "", "", "第二段"]), "第一段，第二段");
	});

	it("does not double up punctuation at a paragraph break", () => {
		// 上一段末尾已有标点（CJK 或 ASCII 收尾标点）就不重复补
		assert.equal(joinAllLines(["第一段。", "", "第二段"]), "第一段。第二段");
		assert.equal(joinAllLines(["ends.", "", "Next"]), "ends. Next");
	});

	it("keeps the space rule for ascii and mixed paragraph breaks", () => {
		assert.equal(joinAllLines(["English ends", "", "Next starts"]), "English ends Next starts");
		assert.equal(joinAllLines(["中文结尾", "", "English starts"]), "中文结尾 English starts");
	});

	it("does not insert a comma at an intra-paragraph line break", () => {
		// 段内折行（没有空行）不补逗号：中文之间仍直接接续
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
		// 贪心取到 "ab " 后把尾巴上的空格去掉（这一行会短 1 列，但不会出现 `the …` 这种悬空空格）
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
			assert.equal(out.split("\n").length, 1, `出现了换行：${JSON.stringify(out)}`);
		}
	});

	it("joins paragraphs with no break so the next one continues the previous line", () => {
		// 空行分段被跳过：上一段结尾直接接续下一段开头；ASCII 之间补空格，中文段落接缝补逗号
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
		// 行尾永远是原文的结尾（最新写下的 token）
		const tail = line.slice(FIRST_PREFIX.length + 1);
		assert.ok(text.endsWith(tail), `tail ${JSON.stringify(tail)} 不是原文后缀`);
	});

	it("does not pad a short last paragraph up to a full line", () => {
		// 短 thinking 不回填：行尾就是最新内容本身，不会把被顶出去的开头拉回来拼满
		// 全 CJK：预算 33 列 = `…`(1) + 14 个「中」(28) + 段落逗号 `，`(2) + `短`(2)
		const line = render("中".repeat(60) + "\n\n短", 40);
		assert.equal(line, `${FIRST_PREFIX}${ELLIPSIS}${"中".repeat(14)}，短`);
		assert.ok(line.endsWith("短"), `行尾必须是最新内容：${JSON.stringify(line)}`);
	});

	it("leaves the tail blank when a short final paragraph does not fill the line", () => {
		// 定型后也不补行：整行宽度就是内容本身，明显不满就留白
		const line = render("开头写了一些内容\n\n尾", 60);
		assert.equal(line, `${FIRST_PREFIX}开头写了一些内容，尾`);
		assert.ok(widthOf(line) < 60, `不该被补满整行：${widthOf(line)}`);
	});

	it("renders the same scrolling line while streaming and after it settles", () => {
		// 没有 isStreaming 分支了：流式与定型是同一套逻辑，形态只随内容长度变化
		const md = "第一段的内容\n\n第二段的内容\n\n尾";
		assert.equal(render(md, 60), render(md, 60));
		assert.equal(render(md, 60), `${FIRST_PREFIX}第一段的内容，第二段的内容，尾`);
	});

	it("grows the tail token by token without ever restarting the line", () => {
		// 逐 token 追加：行尾始终是最新内容，前缀单调延长（或被 `…` 顶掉头部），不另起一行
		const head = "第一段的内容在这里写了不少字\n\n第二段也写了一些内容\n\n";
		let previous = "";
		for (const tail of ["尾", "尾巴", "尾巴收", "尾巴收尾了"]) {
			const line = render(head + tail, 60);
			assert.equal(line.split("\n").length, 1);
			assert.ok(line.endsWith(tail), `行尾不是最新 token：${JSON.stringify(line)}`);
			if (previous !== "") assert.ok(widthOf(line) >= widthOf(previous), "行宽不该回退");
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
				assert.equal(line.split("\n").length, 1, `出现了换行：${JSON.stringify(line)}`);
				assert.ok(widthOf(line) <= width, `宽度 ${widthOf(line)} > ${width}：${JSON.stringify(line)}`);
			}
		}
	});

	it("keeps backticks balanced inside the line so marked cannot merge lines", () => {
		// 头部截断会切在 code span 中间：落单的闭合反引号必须被删掉
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
		// 标签 `Think: ` = 7 列，宽度 12 → 正文预算 5 → `…` + 4 个字符
		assert.equal(render(text, 12), `${FIRST_PREFIX}…ghij`);
	});

	it("drops the label instead of overflowing when the terminal is too narrow for it", () => {
		// 宽度 8 < 标签 7 列 + `…` + 1 列正文：丢掉标签，正文独占整行
		const line = render("abcdefghij", 8);
		assert.equal(line, `${ELLIPSIS}defghij`);
		assert.ok(widthOf(line) <= 8);
	});

	it("renders no bar gutter", () => {
		const line = render("x".repeat(60) + "\n\nshort", 40);
		assert.ok(line.startsWith(HEADER_LABEL), `标签必须顶格：${JSON.stringify(line)}`);
		assert.ok(!line.includes("│"), `不该有竖线：${JSON.stringify(line)}`);
	});
});
