/**
 * Visual tweaks to the input box: ① a Claude Code-style "❯" prompt ("!" in bash
 * mode); ② a blank row between the completion list and the statusline.
 *
 * ① How the prompt works: subclass CustomEditor, narrow the real editing area by
 * the gutter's width (super.render(width - gutter)), then add the gutter back on
 * every row's left:
 *   - the top/bottom borders: renderTopBorder / renderBottomBorder fill them
 *     back to full width;
 *   - the first text row (unscrolled) → "❯ "; bash mode (text starting with `!`)
 *     → "! ";
 *   - every other text row / completion row → same-width spaces.
 * The cursor position is decided by the in-row CURSOR_MARKER and moves right with
 * the text, so the hardware cursor / IME positioning is unaffected; mouse clicks
 * are likewise shifted left by the gutter columns before the parent handles them
 * (one more column for the hidden `!` in bash mode) — click positioning stays
 * exact.
 *
 * ② The blank row between the completion list and the statusline: Editor.render()
 * draws the completion list **after the editor's bottom border** (editor.js:
 * autocompleteList.render() is pushed after renderBottomBorder), and the
 * statusline sits right under the editor — so typing "/xxx" glues the list to the
 * statusline. Here one blank row is appended whenever a completion list actually
 * rendered (only then — the static layout is unchanged). The check uses the
 * public isShowingAutocomplete() (= autocompleteState !== null); in Editor, state
 * and autocompleteList are always set / cleared together (clearAutocompleteUi),
 * so it is strictly in sync with "the list really rendered" — no need to touch
 * the private renderedAutocompleteHeight. The blank row is padded to full width
 * per pi's own convention (Editor pads every row to contentWidth), so the diff
 * renderer does not leave artifacts when only changed prefixes are written.
 * The mouse is unaffected: the blank row sits below the completion list (past
 * autocompleteStartRow + renderedAutocompleteHeight) and lands in
 * Editor.handleMouse's "beyond visible rows" branch; Container's mouse dispatch
 * measures child heights via render().length, so the +1 keeps every component
 * below aligned.
 *
 * Why not a third editor-wrapper extension: `ctx.ui.setEditorComponent()`
 * **replaces**, it does not stack — prompt-editor's factory would silently drop
 * any previous wrapper (the README records folder-history being bitten by that
 * order). So this change lives in the file that already owns the editor subclass
 * — no new load-order constraint.
 *
 * Editor's theme / scrollOffset / renderedAutocompleteHeight are all private —
 * so only the protected renderTopBorder / renderBottomBorder are used to get the
 * information needed.
 *
 * ③ The completion list shifts left: Editor draws the list after the bottom
 * border, and PromptEditor re-adds the gutter to every row — so the command word
 * lands at column gutter+2 (the "→ " prefix is 2 columns). Here the rows after
 * the bottom border get `shift` fewer spaces (default shift = 1 — the whole list,
 * arrow included, moves one column left).
 * The renderer writes \x1b[2K to clear each changed row, so shorter completion
 * rows leave no artifacts; SelectList.handleMouse locates by event.y only — the
 * shift does not affect clicking.
 *
 * ④ `!` bash mode (aligned with Claude Code): when the input's first character
 * is `!`, the gutter's `❯` becomes `!` and the `!` inside the text stops
 * showing — so the text looks like the command itself, while the cursor / IME /
 * clicks stay on their original columns.
 * The mode check, Enter submit (`text.startsWith("!")`), ↑ history, and Esc
 * clearing all stay on pi's own chain (`interactive-mode.js`'s `onChange` is
 * `text.trimStart().startsWith("!")` — that is what the border color uses);
 * only the rendering side is aligned here: detection and stripping live in
 * `./prompt-editor/bash-prompt.ts` (pure logic, unit-testable).
 * Three details:
 *   - not one text char is changed (hiding is draw-only), so pi's
 *     coloring/submit/history needs no cooperation;
 *   - with one column hidden, the text shifts left one column — at render time
 *     the first row drops one `!` and a space pads it back to full width; a
 *     click must count one extra column, and a cursor parked on that column
 *     (Ctrl+A / arrows / a gutter click) is pushed back to column 1: left there,
 *     the reverse-video cursor would sit on the stripped empty column, and
 *     typing there would write `x!ls` into the text — pi would instantly judge
 *     "not bash mode anymore";
 *   - leaving the mode needs no extra code: backspace on empty text deletes the
 *     `!` (or Enter submits / Esc clears) — pi's `isBashMode` goes false, the
 *     border color falls back per its own logic, and the next frame draws `❯`
 *     again.
 *
 * Available env vars:
 *   PI_EDITOR_PROMPT             the prompt char, default "❯" (bash mode's "!"
 *                                does not follow)
 *   PI_EDITOR_AUTOCOMPLETE_GAP   set to off to disable the blank row below the
 *                                completion list
 *   PI_EDITOR_AUTOCOMPLETE_SHIFT columns the completion list shifts left,
 *                                0..gutter, default 1; 0 restores the old
 *                                behavior, 2 (= gutter) aligns the command word
 *                                with the cursor's starting column
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BASH_MARKER, dropLeadingBang, resolveBashPrompt } from "./prompt-editor/bash-prompt.ts";

const PROMPT_CHAR = process.env.PI_EDITOR_PROMPT ?? "❯";
const AUTOCOMPLETE_GAP = (process.env.PI_EDITOR_AUTOCOMPLETE_GAP ?? "").toLowerCase() !== "off";

/** The completion-list left-shift override; unset → shift left 1 column. */
const AUTOCOMPLETE_SHIFT_OVERRIDE = (() => {
	const raw = process.env.PI_EDITOR_AUTOCOMPLETE_SHIFT;
	if (raw === undefined || raw.trim() === "") return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
})();

class PromptEditor extends CustomEditor {
	private readonly gutter: number;
	/** The last whole row renderBottomBorder produced — used to recognize the bottom border inside render() */
	private bottomBorderLine = "";
	/** An "↑ N more" on the top border means the view has scrolled */
	private scrolled = false;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.gutter = visibleWidth(PROMPT_CHAR) + 1; // the prompt + one space
	}

	private get gutterFill(): string {
		return this.borderColor("─".repeat(this.gutter));
	}

	/**
 * The prompt glyph fills the gutter columns (`❯` / `!` are both 1 column, but
 * `PI_EDITOR_PROMPT` could be a wide char).
 * Only the glyph is colored — the padding spaces are not — matching the old
 * `${borderColor("❯")} ` verbatim.
 */
	private promptCell(char: string): string {
		const pad = Math.max(0, this.gutter - visibleWidth(char));
		return this.borderColor(char) + " ".repeat(pad);
	}

	/**
 * Keep the cursor off the hidden `!`: in Claude Code the cursor can never reach
 * the mode marker.
 * Letting it in has two consequences — the reverse-video cursor lands on the
 * stripped empty column (it looks gone), and typing there writes `x!ls` into
 * the text, which pi instantly judges "not bash mode anymore".
 * The cursor column lives in Editor's private state with no public setter, so
 * its own setCursorCol(1) is called (which also clears the sticky column); if pi
 * renames it later, this degrades to "cursor parks at column 0" — only this
 * edge-case behavior, never the rendering.
 */
	private keepCursorOffBang(): void {
		if (!resolveBashPrompt(this.getText()).hidden) return;
		const cursor = this.getCursor();
		if (cursor.line !== 0 || cursor.col !== 0) return;

		const internals = this as unknown as {
			setCursorCol?: (col: number) => void;
			state?: { cursorCol: number };
		};
		if (typeof internals.setCursorCol === "function") internals.setCursorCol(1);
		else if (internals.state) internals.state.cursorCol = 1;
	}

	protected renderTopBorder(width: number, hiddenLineCount: number): string {
		this.scrolled = hiddenLineCount > 0;
		return this.gutterFill + super.renderTopBorder(width, hiddenLineCount);
	}

	protected renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.bottomBorderLine = this.gutterFill + super.renderBottomBorder(width, hiddenLineCount);
		return this.bottomBorderLine;
	}

	render(width: number): string[] {
		const gutter = this.gutter;
		const lines = super.render(Math.max(1, width - gutter));
		if (lines.length === 0) return lines;

		// pi's bash mode is decided by the text alone — no extra state: recomputed each frame, it can never drift from the border color
		const bash = resolveBashPrompt(this.getText());

		const blank = " ".repeat(gutter);
		// once scrolled, the first visible row is no longer the logical first — the prompt does not show
		const showPrompt = !this.scrolled;
		// EditorTheme only exposes borderColor, so the prompt takes the border's color (the bashMode color in bash mode)
		const prompt = this.promptCell(bash.active ? BASH_MARKER : PROMPT_CHAR);
		// the row whose `!` must be hidden is exactly the row showing the prompt
		const hideBang = bash.hidden && showPrompt;

		// the completion-list shift: 1 column by default (arrow included).
		const shift = Math.max(0, Math.min(gutter, AUTOCOMPLETE_SHIFT_OVERRIDE ?? 1));
		const autocompleteBlank = " ".repeat(gutter - shift);

		let inAutocomplete = false;
		const mapped = lines.map((line, index) => {
			// the top border is already filled to full width above
			if (index === 0) return line;
			// the bottom border is already filled; every row after it is a completion-list row
			if (line === this.bottomBorderLine) {
				inAutocomplete = true;
				return line;
			}
			if (inAutocomplete) return autocompleteBlank + line;
			if (index === 1 && showPrompt) {
				if (!hideBang) return prompt + line;
				// dropping the `!` makes the row 1 column short — a space pads it back (Editor pads every row to contentWidth;
				// a short row would leave an artifact under the diff renderer)
				const dropped = dropLeadingBang(line);
				return prompt + dropped.text + (dropped.dropped ? " " : "");
			}
			return blank + line;
		});

		// the completion list renders after the editor's bottom border with the statusline right under it — visually crowded;
		// a blank row is added only when a completion list really exists — the static layout is unchanged.
		// padded to full width per pi's own convention (every other row is also gutter + contentWidth = width).
		if (AUTOCOMPLETE_GAP && this.isShowingAutocomplete()) {
			mapped.push(" ".repeat(Math.max(0, width)));
		}

		return mapped;
	}

	handleInput(data: string): void {
		super.handleInput(data);
		// every path that can move the cursor or change the text (arrows, Home/Ctrl+A, ↑ history, backspace, paste, undo…) goes through here
		this.keepCursorOffBang();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// in bash mode the text shifted left 1 column (the hidden `!`) — a click must count one more column to match the source.
		// the completion list's x plays no part in hit-testing (SelectList only uses y) — the extra column does not affect it.
		const bangHitShift = resolveBashPrompt(this.getText()).hidden ? 1 : 0;
		const result = super.handleMouse({
			...event,
			x: Math.max(0, event.x - this.gutter + bangHitShift),
			width: Math.max(1, event.width - this.gutter),
		});
		this.keepCursorOffBang();
		return result;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new PromptEditor(tui, theme, keybindings),
		);
	});
}
