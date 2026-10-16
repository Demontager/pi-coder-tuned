/**
 * Tests for bash-prompt.ts — `!` bash mode's detection and "drop the row's
 * leading `!` from the rendered row".
 *
 * Run with:  node --test clients/pi/extensions/prompt-editor/bash-prompt.test.ts
 *
 * The module under test imports no pi / pi-tui — the cases feed it exactly
 * the rendered rows a pi-tui Editor really emits (cursor reverse
 * `\x1b[7m!\x1b[0m`, CURSOR_MARKER `\x1b_pi:c\x07`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BASH_MARKER, dropLeadingBang, resolveBashPrompt } from "./bash-prompt.ts";

const CURSOR_MARKER = "\x1b_pi:c\x07";

describe("resolveBashPrompt", () => {
	it("plain text is not bash mode", () => {
		assert.deepEqual(resolveBashPrompt(""), { active: false, hidden: false });
		assert.deepEqual(resolveBashPrompt("ls -la"), { active: false, hidden: false });
		assert.deepEqual(resolveBashPrompt("ls!"), { active: false, hidden: false });
		assert.deepEqual(resolveBashPrompt("/recap"), { active: false, hidden: false });
	});

	it("a literal `!` start: bash mode, and that `!` must be hidden", () => {
		assert.deepEqual(resolveBashPrompt("!"), { active: true, hidden: true });
		assert.deepEqual(resolveBashPrompt("!ls"), { active: true, hidden: true });
		assert.deepEqual(resolveBashPrompt("! ls -la"), { active: true, hidden: true });
		assert.deepEqual(resolveBashPrompt("!ls\n-l"), { active: true, hidden: true });
	});

	it("`!!` (the not-entering-context kind) likewise hides only the first `!` — the second stays in the text", () => {
		assert.deepEqual(resolveBashPrompt("!!ls"), { active: true, hidden: true });
		assert.deepEqual(resolveBashPrompt("!!"), { active: true, hidden: true });
	});

	it("`!` after leading whitespace/newline: pi still counts bash mode, but it does not line up with the first column — not hidden", () => {
		assert.deepEqual(resolveBashPrompt(" !ls"), { active: true, hidden: false });
		assert.deepEqual(resolveBashPrompt("\n!ls"), { active: true, hidden: false });
		assert.deepEqual(resolveBashPrompt("\t!ls"), { active: true, hidden: false });
	});
});

describe("dropLeadingBang", () => {
	it("the leading `!` is dropped — the rest verbatim", () => {
		assert.deepEqual(dropLeadingBang("!ls -la"), { text: "ls -la", dropped: true });
		assert.deepEqual(dropLeadingBang("!"), { text: "", dropped: true });
		assert.deepEqual(dropLeadingBang("! ls"), { text: " ls", dropped: true });
	});

	it("`!!` drops only one (the second `!` is pi's \"not entering context\" marker — it must stay visible in the text)", () => {
		assert.deepEqual(dropLeadingBang("!!ls"), { text: "!ls", dropped: true });
	});

	it("nothing to drop → verbatim, and dropped stays false", () => {
		assert.deepEqual(dropLeadingBang("ls -la"), { text: "ls -la", dropped: false });
		assert.deepEqual(dropLeadingBang(""), { text: "", dropped: false });
		assert.deepEqual(dropLeadingBang("ls!"), { text: "ls!", dropped: false });
	});

	it("reverse-video wrapped around the `!` drops only `!` — the escapes stay verbatim", () => {
		// the leading zero-width run (`\x1b[7m`) belongs to head — kept whole; the `\x1b[0m` right after still closes,
		// so the reverse video never leaks onto the rest of the row.
		assert.deepEqual(dropLeadingBang("\x1b[7m!\x1b[0mls"), { text: "\x1b[7m\x1b[0mls", dropped: true });
		assert.deepEqual(dropLeadingBang("\x1b[7m!\x1b[0m"), { text: "\x1b[7m\x1b[0m", dropped: true });
	});

	it("a leading CURSOR_MARKER is kept (it takes no column)", () => {
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

	it("zero-width sequences not followed by `!` → not one char touched (defensive)", () => {
		assert.deepEqual(dropLeadingBang("\x1b[7mls"), { text: "\x1b[7mls", dropped: false });
		assert.deepEqual(dropLeadingBang(`${CURSOR_MARKER}ls`), {
			text: `${CURSOR_MARKER}ls`,
			dropped: false,
		});
	});

	it("the exported marker char is Claude Code's `!`", () => {
		assert.equal(BASH_MARKER, "!");
	});
});
