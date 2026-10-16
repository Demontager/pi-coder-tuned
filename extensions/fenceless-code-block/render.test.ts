/**
 * Tests for render.ts — the fenceless code block's pure logic (row
 * rendering + the prototype patch).
 *
 * Run with:  node --test clients/pi/extensions/fenceless-code-block/render.test.ts
 *
 * The module under test imports no pi / pi-tui (measure, wrap, and the
 * Markdown class are all injected), so fakes are fed here: ASCII = 1
 * column, CJK full-width = 2 (the same rule as pi-tui's visibleWidth);
 * wrapping is a naive column cut (the input has no ANSI — equivalent to
 * wrapTextWithAnsi's "no breakable words" result); the "Markdown class" is
 * a fake with a theme field and renderToken, verifying the patch's wiring
 * (forwarding, idempotence, reading the theme off the instance).
 * The real end-to-end chain (pi's own loader → pi's own render component)
 * is in `index.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFencelessCodeBlocks, renderCodeBlockLines } from "./render.ts";

const ESC = "\u001b";
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");
/** The CJK full-width ranges (enough for these cases; the same rule as pi-tui's visibleWidth). */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;
const charWidth = (ch: string): number => (WIDE.test(ch) ? 2 : 1);
const measure = (text: string): number => [...stripAnsi(text)].reduce((sum, ch) => sum + charWidth(ch), 0);
/** A naive wrap: a hard cut by columns. No ANSI in the input — sufficient. */
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
	it("no fences involved: the body lays out at the indent", () => {
		assert.deepEqual(renderCodeBlockLines("a\nbb", 10, { measure, wrap }), ["  a", "  bb"]);
	});

	it("no tail padding: padding is pi's Markdown.render()'s job — here only width is guaranteed", () => {
		const lines = renderCodeBlockLines("a", 10, { measure, wrap });
		assert.deepEqual(lines, ["  a"], "no spaces we added at the tail");
		for (const line of lines) assert.ok(measure(line) <= 10);
	});

	it("no escapes of our own injected (no background, no extra SGR)", () => {
		for (const line of renderCodeBlockLines("a\nbb", 10, { measure, wrap })) {
			assert.equal(line.includes(ESC), false, "no highlight → plain text returned");
		}
	});

	it("long rows wrap here first — every row within width (the outer layer wraps no second time)", () => {
		const lines = renderCodeBlockLines("xxxxxxxxxx", 6, { measure, wrap });
		assert.deepEqual(lines, ["  xxxx", "  xxxx", "  xx"]);
		for (const line of lines) assert.ok(measure(line) <= 6);
	});

	it("the indent drops when it cannot fit — the row still stays within width", () => {
		const lines = renderCodeBlockLines("abcdef", 3, { measure, wrap, indent: "    " });
		assert.deepEqual(lines, ["abc", "def"]);
		for (const line of lines) assert.ok(measure(line) <= 3);
	});

	it("an empty code block / an empty highlight output still leaves one row", () => {
		assert.deepEqual(renderCodeBlockLines("", 4, { measure, wrap }), ["  "], "an empty code block leaves one row — indent only");
		assert.deepEqual(
			renderCodeBlockLines("a", 4, { measure, wrap, highlight: () => [] }),
			["  a"],
			"empty highlight output falls back to plain text — never zero rows",
		);
	});

	it("the language tag goes to the highlight function with the body", () => {
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
		assert.deepEqual(lines, ["  <hl>const x = 1;</hl>"], "highlighted rows pass through verbatim — no extra wrapping");
	});

	it("no highlight function → the fallback styling (equivalent to the official renderer's else branch)", () => {
		assert.deepEqual(renderCodeBlockLines("a", 8, { measure, wrap, fallbackStyle: (text) => `[${text}]` }), ["  [a]"]);
	});

	it("CJK counts two columns: wrapping goes by columns, not chars", () => {
		assert.deepEqual(renderCodeBlockLines("中文中文", 10, { measure, wrap }), ["  中文中文"]);
		// 6 usable columns cannot hold an 8-column body: cut to 6 + 2.
		assert.deepEqual(renderCodeBlockLines("中文中文", 8, { measure, wrap }), ["  中文中", "  文"]);
	});
});

interface FakeCalls {
	forwarded: unknown[][];
}

/** A fake Markdown class: renderToken records its args and returns recognizable text. */
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
	it("only code tokens are taken over: other tokens forward verbatim with their args", () => {
		const { FakeMarkdown, calls } = makeFakeMarkdown();
		assert.equal(installFencelessCodeBlocks({ Markdown: FakeMarkdown, measure, wrap }), true);

		const md = new FakeMarkdown();
		const context = { marker: 1 };
		assert.deepEqual(md.renderToken({ type: "paragraph" }, 12, "space", context), ["<<original paragraph>>"]);
		assert.deepEqual(calls.forwarded, [[{ type: "paragraph" }, 12, "space", context]]);
	});

	it("a code token renders into fenceless rows, and lang reaches the highlight on the instance theme", () => {
		const { FakeMarkdown } = makeFakeMarkdown({
			codeBlockIndent: "  ",
			highlightCode: (code: string, lang?: string) => [`<${lang}>${code}`],
		});
		installFencelessCodeBlocks({ Markdown: FakeMarkdown, measure, wrap });

		assert.deepEqual(new FakeMarkdown().renderToken({ type: "code", text: "const x = 1;", lang: "js" }, 20), [
			"  <js>const x = 1;",
		]);
	});

	it("the instance theme's codeBlockIndent is honored", () => {
		const { FakeMarkdown } = makeFakeMarkdown({ codeBlockIndent: "    " });
		installFencelessCodeBlocks({ Markdown: FakeMarkdown, measure, wrap });
		assert.deepEqual(new FakeMarkdown().renderToken({ type: "code", text: "a" }, 6), ["    a"]);
	});

	it("installed twice, wrapped once (/reload idempotent)", () => {
		const { FakeMarkdown } = makeFakeMarkdown({ codeBlockIndent: "  " });
		assert.equal(installFencelessCodeBlocks({ Markdown: FakeMarkdown, measure, wrap }), true);
		assert.equal(installFencelessCodeBlocks({ Markdown: FakeMarkdown, measure, wrap }), false);
		assert.deepEqual(new FakeMarkdown().renderToken({ type: "code", text: "a" }, 4), ["  a"]);
	});

	it("a non-space nextType gets a blank row appended", () => {
		const { FakeMarkdown } = makeFakeMarkdown({ codeBlockIndent: "  " });
		installFencelessCodeBlocks({ Markdown: FakeMarkdown, measure, wrap });

		assert.deepEqual(new FakeMarkdown().renderToken({ type: "code", text: "a" }, 3, "space"), ["  a"]);
		assert.deepEqual(new FakeMarkdown().renderToken({ type: "code", text: "a" }, 3, "paragraph"), ["  a", ""]);
	});

	it("a prototype without renderToken → nothing happens, no throw", () => {
		const Markdown = { prototype: {} as Record<string | symbol, unknown> };
		assert.equal(installFencelessCodeBlocks({ Markdown, measure, wrap }), false);
		assert.equal(Object.keys(Markdown.prototype).length, 0);
	});
});
