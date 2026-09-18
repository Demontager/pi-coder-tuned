/**
 * Tests for title-row.ts — `Edit` / `Write` 标题行的纯排版（预算分配、按宽度截断、闪烁占位、行数缩略）。
 *
 * Run with:  node --test clients/pi/extensions/tool-diff/title-row.test.ts
 *
 * 被测模块不 import pi / pi-tui（宽度与截断函数都是注入的），所以这里喂假实现：
 * ASCII = 1 列、CJK = 2 列；`●`（U+25CF）与 `…` 都是 1 列 —— 与 pi-tui 的 `visibleWidth`
 * 已核对一致（`visibleWidth("●") === 1`）。主题的 `fg` 换成恒等函数，断言里直接看纯文本。
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

/** 恒等主题：不着色，断言直接比对纯文本。 */
const plainTheme: TitleTheme = { fg: (_color, text) => text };

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

/** 假截断函数（生产环境传 pi-tui 的 truncateToWidth）：从尾部硬切，够用。 */
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

/** 一条必须从头部截断才能放进 90 列的深层路径。 */
const LONG_PATH =
	"/Users/me/work/project/packages/renderer/src/components/inner/deep/deeper/deepest/final/renderer-impl.ts";

function titleLine(path: string, suffix: string, width: number, rowDeps: TitleRowDeps = deps()): string {
	return new TitleRow(rowDeps, plainTheme, "Write", path, suffix).render(width)[0] ?? "";
}

describe("blinkSuffix: 灭态等宽占位", () => {
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

describe("TitleRow: 闪烁期间超长路径不摆动（回归）", () => {
	it("renders the same line in both blink phases, modulo the marker itself", () => {
		const on = titleLine(LONG_PATH, blinkSuffix(plainTheme, true), 90);
		const off = titleLine(LONG_PATH, blinkSuffix(plainTheme, false), 90);
		// 两态的唯一差别是标记字符 —— 修复前灭态是空串，预算每帧跳 2 列，
		// 截断窗口跟着左右挪（`…ccccc` vs `…ccccccc`），观感就是"文件名也在闪"
		assert.equal(on.replace(BLINK_MARKER, " "), off);
		assert.equal(widthOf(on), widthOf(off));
	});

	it("keeps the file name and the line width stable across a sweep of widths", () => {
		for (let width = 40; width <= 140; width += 1) {
			const on = titleLine(LONG_PATH, blinkSuffix(plainTheme, true), width);
			const off = titleLine(LONG_PATH, blinkSuffix(plainTheme, false), width);
			assert.ok(widthOf(on) <= width, `line wider than ${width}: ${JSON.stringify(on)}`);
			assert.equal(on.replace(BLINK_MARKER, " "), off, `path moved at width ${width}`);
			// 路径永远保留尾部：无论宽度多窄，文件名都能完整看到
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

describe("TitleRow: 工具名与尾部永远完整", () => {
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
		// 退回整行截断时两态同样只差标记：尾部是等宽空格，预算不会跳
		const off = titleLine(LONG_PATH, blinkSuffix(plainTheme, false), 8);
		assert.equal(line.replace(BLINK_MARKER, " "), off);
	});

	it("renders the streaming-start form (no path yet) without a dangling separator", () => {
		assert.equal(titleLine("", blinkSuffix(plainTheme, true), 60).trimEnd(), " Write ●");
	});
});

describe("TitleRow: 路径与缩进", () => {
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
	/** 记录 fg 调用的主题，用来断言着色 token。 */
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
		// `/Users/melo` 不该被缩成 `~lo`
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
