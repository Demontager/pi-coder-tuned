/**
 * Tests for bash-prompt.ts — `!` bash 模式的模式判定与「把行首 `!` 从渲染行里摘掉」。
 *
 * Run with:  node --test clients/pi/extensions/prompt-editor/bash-prompt.test.ts
 *
 * 被测模块不 import pi / pi-tui，用例直接喂 pi-tui Editor 真正会写出来的渲染行字符串
 * （光标反显 `\x1b[7m!\x1b[0m`、CURSOR_MARKER `\x1b_pi:c\x07`）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BASH_MARKER, dropLeadingBang, resolveBashPrompt } from "./bash-prompt.ts";

const CURSOR_MARKER = "\x1b_pi:c\x07";

describe("resolveBashPrompt", () => {
	it("普通正文不算 bash 模式", () => {
		assert.deepEqual(resolveBashPrompt(""), { active: false, hidden: false });
		assert.deepEqual(resolveBashPrompt("ls -la"), { active: false, hidden: false });
		assert.deepEqual(resolveBashPrompt("ls!"), { active: false, hidden: false });
		assert.deepEqual(resolveBashPrompt("/recap"), { active: false, hidden: false });
	});

	it("字面以 `!` 开头：算 bash 模式，且那个 `!` 要藏起来", () => {
		assert.deepEqual(resolveBashPrompt("!"), { active: true, hidden: true });
		assert.deepEqual(resolveBashPrompt("!ls"), { active: true, hidden: true });
		assert.deepEqual(resolveBashPrompt("! ls -la"), { active: true, hidden: true });
		assert.deepEqual(resolveBashPrompt("!ls\n-l"), { active: true, hidden: true });
	});

	it("`!!`（不进上下文的那种）同样只藏第一个 `!`，第二个留在正文里", () => {
		assert.deepEqual(resolveBashPrompt("!!ls"), { active: true, hidden: true });
		assert.deepEqual(resolveBashPrompt("!!"), { active: true, hidden: true });
	});

	it("前导空白 / 换行后跟 `!`：pi 也算 bash 模式，但位置对不上第一列，不藏", () => {
		assert.deepEqual(resolveBashPrompt(" !ls"), { active: true, hidden: false });
		assert.deepEqual(resolveBashPrompt("\n!ls"), { active: true, hidden: false });
		assert.deepEqual(resolveBashPrompt("\t!ls"), { active: true, hidden: false });
	});
});

describe("dropLeadingBang", () => {
	it("摘掉行首的 `!`，其余逐字保留", () => {
		assert.deepEqual(dropLeadingBang("!ls -la"), { text: "ls -la", dropped: true });
		assert.deepEqual(dropLeadingBang("!"), { text: "", dropped: true });
		assert.deepEqual(dropLeadingBang("! ls"), { text: " ls", dropped: true });
	});

	it("`!!` 只摘一个（第二个 `!` 是 pi 的「不进上下文」标记，要留在正文里看得见）", () => {
		assert.deepEqual(dropLeadingBang("!!ls"), { text: "!ls", dropped: true });
	});

	it("没有可摘的 `!` 时原样返回，并且不报 dropped", () => {
		assert.deepEqual(dropLeadingBang("ls -la"), { text: "ls -la", dropped: false });
		assert.deepEqual(dropLeadingBang(""), { text: "", dropped: false });
		assert.deepEqual(dropLeadingBang("ls!"), { text: "ls!", dropped: false });
	});

	it("光标反显包在 `!` 上时只摘 `!`，转义序列原样留下", () => {
		// 行首那串零宽序列（`\x1b[7m`）属于 head，整段保留；紧跟其后的 `\x1b[0m` 仍然收尾，
		// 所以不会把反显漏给行内其余字符。
		assert.deepEqual(dropLeadingBang("\x1b[7m!\x1b[0mls"), { text: "\x1b[7m\x1b[0mls", dropped: true });
		assert.deepEqual(dropLeadingBang("\x1b[7m!\x1b[0m"), { text: "\x1b[7m\x1b[0m", dropped: true });
	});

	it("CURSOR_MARKER 在行首时保留（它不占列）", () => {
		assert.deepEqual(dropLeadingBang(`${CURSOR_MARKER}!ls`), {
			text: `${CURSOR_MARKER}ls`,
			dropped: true,
		});
		assert.deepEqual(dropLeadingBang(`${CURSOR_MARKER}\x1b[7m!\x1b[0mls`), {
			text: `${CURSOR_MARKER}\x1b[7m\x1b[0mls`,
			dropped: true,
		});
		assert.deepEqual(dropLeadingBang(`${CURSOR_MARKER}!`), {
			text: `${CURSOR_MARKER}`,
			dropped: true,
		});
	});

	it("零宽序列后面不是 `!` 就一个字都不动（防御性）", () => {
		assert.deepEqual(dropLeadingBang("\x1b[7mls"), { text: "\x1b[7mls", dropped: false });
		assert.deepEqual(dropLeadingBang(`${CURSOR_MARKER}ls`), {
			text: `${CURSOR_MARKER}ls`,
			dropped: false,
		});
	});

	it("导出的标记字符就是 Claude Code 的那个 `!`", () => {
		assert.equal(BASH_MARKER, "!");
	});
});
