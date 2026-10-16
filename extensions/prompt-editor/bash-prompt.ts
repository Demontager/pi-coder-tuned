/**
 * The pure logic of `!` bash mode (aligned with Claude Code's `!` command
 * mode): mode detection + stripping the `!` at the rendered row's start. The
 * text **itself is never changed** — pi's bash detection
 * (`interactive-mode.js`'s `onChange`), Enter submit
 * (`text.startsWith("!")`), ↑ history, and Esc clearing all stay on pi's own
 * chain; this file only answers "how to draw".
 *
 * Deliberately imports no pi / pi-tui (the same convention as
 * `thinking-collapse/window.ts`), so
 * `node --test clients/pi/extensions/prompt-editor/bash-prompt.test.ts` runs
 * it directly.
 */

/** Claude Code's bash-mode prompt char (also the char pi triggers bash mode on). */
export const BASH_MARKER = "!";

export interface BashPromptState {
	/**
 * Whether the gutter swaps to `!`. The check matches pi's verbatim:
 * `interactive-mode.js`'s `onChange` is
 * `text.trimStart().startsWith("!")`, and the border color
 * (`updateEditorBorderColor`) uses that same flag — following it keeps the
 * gutter and the border color from disagreeing.
 */
	active: boolean;
	/**
 * The text's first character is `!` — at render time that column is dropped
 * from the text (the prompt already occupies its spot).
 *
 * With `!` after leading whitespace (`" !ls"`) pi also counts bash mode, but
 * that `!` is not on the text's first column and does not line up with the
 * gutter — so it shows as usual. Only this edge input is affected: border
 * color / prompt still follow pi's rule; the text is untouched.
 */
	hidden: boolean;
}

export function resolveBashPrompt(text: string): BashPromptState {
	const active = text.trimStart().startsWith(BASH_MARKER);
	return { active, hidden: active && text.startsWith(BASH_MARKER) };
}

export interface LeadingBangDrop {
	/** The row after dropping a leading `!`; byte-identical to the input when nothing was dropped. */
	text: string;
	/** A visible char was really dropped (the caller pads one column back at the tail to keep the row full-width). */
	dropped: boolean;
}

/**
 * The zero-width sequences a row may lead with — pi-tui's Editor only emits
 * these two:
 *   - CSI (`\x1b[7m` / `\x1b[0m`…): the cursor reverse-video segment;
 *   - the APC CURSOR_MARKER (`\x1b_pi:c\x07`): hardware-cursor / IME
 *     positioning.
 * Both take 0 columns — they stay verbatim where they are when `!` is
 * dropped.
 */
const LEADING_ZERO_WIDTH = /^(?:\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\))*/;

/**
 * Drop the hidden `!` at the rendered row's start (only the first visible
 * char; any leading zero-width escapes are kept).
 * Only called when `resolveBashPrompt().hidden` is true and this row is the
 * text's first row (unscrolled).
 */
export function dropLeadingBang(line: string): LeadingBangDrop {
	const head = LEADING_ZERO_WIDTH.exec(line)?.[0] ?? "";
	const rest = line.slice(head.length);
	if (!rest.startsWith(BASH_MARKER)) return { text: line, dropped: false };
	return { text: head + rest.slice(BASH_MARKER.length), dropped: true };
}
