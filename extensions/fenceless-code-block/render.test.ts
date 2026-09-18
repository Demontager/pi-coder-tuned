/**
 * Tests for render.ts — 代码块去围栏的纯逻辑（行渲染 + 原型补丁）。
 *
 * Run with:  node --test clients/pi/extensions/fenceless-code-block/render.test.ts
 *
 * 被测模块不 import pi / pi-tui（量度、折行、Markdown 类都是注入的），所以这里喂假实现：
 * ASCII = 1 列、CJK 全角 = 2 列（口径与 pi-tui 的 visibleWidth 一致）；折行是朴素的按列硬切
 * （输入不含 ANSI，正好等价于 wrapTextWithAnsi 在"没有可断词"情形下的结果）；"Markdown 类"
 * 只是个带 theme 字段和 renderToken 的假类，用来验证补丁的接线（转发、幂等、读实例上的主题）。
 * 真实的端到端链路（pi 自己的加载器 → pi 自己的渲染组件）在 `index.test.ts`。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFencelessCodeBlocks, renderCodeBlockLines } from "./render.ts";

const ESC = "\u001b";
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");
/** CJK 全角区间（够这几条用例用；口径与 pi-tui 的 visibleWidth 一致）。 */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;
const charWidth = (ch: string): number => (WIDE.test(ch) ? 2 : 1);
const measure = (text: string): number => [...stripAnsi(text)].reduce((sum, ch) => sum + charWidth(ch), 0);
/** 朴素折行：按列硬切。输入不含 ANSI，够用。 */
const wrap = (text: string, width: number): string[] => {
	if (measure(text) <= width) return [text];
	const pieces: string[] = [];
	let current = "";
	let used = 0;
	for (const ch of text) {
		const w = charWidth(ch);
		if (used > 0 && used + w > width) {
			pieces.push(current);
			current = "";
			used = 0;
		}
		current += ch;
		used += w;
	}
	pieces.push(current);
	return pieces;
};

describe("renderCodeBlockLines", () => {
	it("围栏不参与：正文按缩进铺开", () => {
		assert.deepEqual(renderCodeBlockLines("a\nbb", 10, { measure, wrap }), ["  a", "  bb"]);
	});

	it("行尾不补白：补白交给 pi 的 Markdown.render()，这里只保证不超过 width", () => {
		const lines = renderCodeBlockLines("a", 10, { measure, wrap });
		assert.deepEqual(lines, ["  a"], "末尾不该有我们加的空格");
		for (const line of lines) assert.ok(measure(line) <= 10);
	});

	it("不注入任何自己的转义（没有底色、没有额外的 SGR）", () => {
		for (const line of renderCodeBlockLines("a\nbb", 10, { measure, wrap })) {
			assert.equal(line.includes(ESC), false, "没有高亮时返回的应该是纯文本");
		}
	});

	it("长行自己先折，每行都不超过 width（外层不会再有第二次折行）", () => {
		const lines = renderCodeBlockLines("xxxxxxxxxx", 6, { measure, wrap });
		assert.deepEqual(lines, ["  xxxx", "  xxxx", "  xx"]);
		for (const line of lines) assert.ok(measure(line) <= 6);
	});

	it("缩进放不下时丢缩进，行宽仍然不超过 width", () => {
		const lines = renderCodeBlockLines("abcdef", 3, { measure, wrap, indent: "    " });
		assert.deepEqual(lines, ["abc", "def"]);
		for (const line of lines) assert.ok(measure(line) <= 3);
	});

	it("空代码块 / 高亮返回空数组都至少留一行", () => {
		assert.deepEqual(renderCodeBlockLines("", 4, { measure, wrap }), ["  "], "空代码块留一行，只带缩进");
		assert.deepEqual(
			renderCodeBlockLines("a", 4, { measure, wrap, highlight: () => [] }),
			["  a"],
			"高亮没产出时退回纯文本，不能一行都不画",
		);
	});

	it("语言标签与正文一起交给高亮函数", () => {
		const seen: Array<[string, string | undefined]> = [];
		const lines = renderCodeBlockLines("const x = 1;", 40, {
			measure,
			wrap,
			lang: "js",
			highlight: (code, lang) => {
				seen.push([code, lang]);
				return [`<hl>${code}</hl>`];
			},
		});
		assert.deepEqual(seen, [["const x = 1;", "js"]]);
		assert.deepEqual(lines, ["  <hl>const x = 1;</hl>"], "着色行原样保留，不再包一层");
	});

	it("没有高亮函数时用兜底着色（等价官方渲染器的 else 分支）", () => {
		assert.deepEqual(renderCodeBlockLines("a", 8, { measure, wrap, fallbackStyle: (text) => `[${text}]` }), ["  [a]"]);
	});

	it("CJK 按两列计：折行按列，不按字符", () => {
		assert.deepEqual(renderCodeBlockLines("中文中文", 10, { measure, wrap }), ["  中文中文"]);
		// 可用宽度 6 列时装不下 8 列正文：切成 6 + 2。
		assert.deepEqual(renderCodeBlockLines("中文中文", 8, { measure, wrap }), ["  中文中", "  文"]);
	});
});

interface FakeCalls {
	forwarded: unknown[][];
}

/** 假 Markdown 类：renderToken 记下参数并返回可辨认的文本。 */
function makeFakeMarkdown(theme: Record<string, unknown> = {}) {
	const calls: FakeCalls = { forwarded: [] };
	class FakeMarkdown {
		theme: Record<string, unknown>;
		constructor() {
			this.theme = theme;
		}
		renderToken(token: { type?: string }, width: number, nextType?: string, styleContext?: unknown): string[] {
			calls.forwarded.push([token, width, nextType, styleContext]);
			return [`<<original ${token?.type}>>`];
		}
	}
	return { FakeMarkdown, calls };
}

describe("installFencelessCodeBlocks", () => {
	it("只接管 code token：其它 token 连参数一起原样转给内置渲染器", () => {
		const { FakeMarkdown, calls } = makeFakeMarkdown();
		assert.equal(installFencelessCodeBlocks({ Markdown: FakeMarkdown, measure, wrap }), true);

		const md = new FakeMarkdown();
		const context = { marker: 1 };
		assert.deepEqual(md.renderToken({ type: "paragraph" }, 12, "space", context), ["<<original paragraph>>"]);
		assert.deepEqual(calls.forwarded, [[{ type: "paragraph" }, 12, "space", context]]);
	});

	it("code token 渲染成无围栏的行，并把 lang 交给实例主题上的高亮", () => {
		const { FakeMarkdown } = makeFakeMarkdown({
			codeBlockIndent: "  ",
			highlightCode: (code: string, lang?: string) => [`<${lang}>${code}`],
		});
		installFencelessCodeBlocks({ Markdown: FakeMarkdown, measure, wrap });

		assert.deepEqual(new FakeMarkdown().renderToken({ type: "code", text: "const x = 1;", lang: "js" }, 20), [
			"  <js>const x = 1;",
		]);
	});

	it("采信实例 theme 上的 codeBlockIndent", () => {
		const { FakeMarkdown } = makeFakeMarkdown({ codeBlockIndent: "    " });
		installFencelessCodeBlocks({ Markdown: FakeMarkdown, measure, wrap });
		assert.deepEqual(new FakeMarkdown().renderToken({ type: "code", text: "a" }, 6), ["    a"]);
	});

	it("装了两次只包一层（/reload 幂等）", () => {
		const { FakeMarkdown } = makeFakeMarkdown({ codeBlockIndent: "  " });
		assert.equal(installFencelessCodeBlocks({ Markdown: FakeMarkdown, measure, wrap }), true);
		assert.equal(installFencelessCodeBlocks({ Markdown: FakeMarkdown, measure, wrap }), false);
		assert.deepEqual(new FakeMarkdown().renderToken({ type: "code", text: "a" }, 4), ["  a"]);
	});

	it("nextType 不是 space 时补一个空行", () => {
		const { FakeMarkdown } = makeFakeMarkdown({ codeBlockIndent: "  " });
		installFencelessCodeBlocks({ Markdown: FakeMarkdown, measure, wrap });

		assert.deepEqual(new FakeMarkdown().renderToken({ type: "code", text: "a" }, 3, "space"), ["  a"]);
		assert.deepEqual(new FakeMarkdown().renderToken({ type: "code", text: "a" }, 3, "paragraph"), ["  a", ""]);
	});

	it("原型没有 renderToken 时什么都不做、不抛", () => {
		const Markdown = { prototype: {} as Record<string | symbol, unknown> };
		assert.equal(installFencelessCodeBlocks({ Markdown, measure, wrap }), false);
		assert.equal(Object.keys(Markdown.prototype).length, 0);
	});
});
