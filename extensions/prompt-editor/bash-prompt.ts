/**
 * `!` bash 模式（对齐 Claude Code 的 `!` 命令模式）的纯逻辑：模式判定 + 把渲染行行首那个
 * `!` 摘掉。正文文本**一个字符都不改** —— pi 的 bash 判定（`interactive-mode.js` 的
 * `onChange`）、Enter 提交（`text.startsWith("!")`）、↑ 历史、Esc 清空都还走它自己那条链路，
 * 这里只回答「怎么画」。
 *
 * 刻意不 import pi / pi-tui（与 `thinking-collapse/window.ts` 同一条约定），所以
 * `node --test clients/pi/extensions/prompt-editor/bash-prompt.test.ts` 能直接跑。
 */

/** Claude Code 的 bash 模式提示符（也是 pi 触发 bash 的那个字符）。 */
export const BASH_MARKER = "!";

export interface BashPromptState {
	/**
	 * gutter 要不要换成 `!`。判定与 pi 自己一字不差：`interactive-mode.js` 的 `onChange` 是
	 * `text.trimStart().startsWith("!")`，而边框颜色（`updateEditorBorderColor`）用的就是同一个
	 * 标志 —— 跟着它走，gutter 才不会和输入框颜色打架。
	 */
	active: boolean;
	/**
	 * 正文第一个字符就是 `!`，渲染时要把这一列从正文里摘掉（提示符已经占了它的位置）。
	 *
	 * 前导空白后跟 `!`（`" !ls"`）时 pi 也算 bash 模式，但那个 `!` 不在正文第一列、位置对不上
	 * gutter，所以照常显示。这只影响这一个边角输入：边框颜色/提示符仍按 pi 的判定走，正文不动。
	 */
	hidden: boolean;
}

export function resolveBashPrompt(text: string): BashPromptState {
	const active = text.trimStart().startsWith(BASH_MARKER);
	return { active, hidden: active && text.startsWith(BASH_MARKER) };
}

export interface LeadingBangDrop {
	/** 摘掉行首 `!` 之后的行；没有可摘的 `!` 时与输入逐字相同。 */
	text: string;
	/** 真的摘掉了一个可见字符（调用方据此把行尾补回一列，保持整行满宽）。 */
	dropped: boolean;
}

/**
 * 行首可能出现的零宽序列，pi-tui 的 Editor 只会给出这两种：
 *   - CSI（`\x1b[7m` / `\x1b[0m`…）：光标反显那一段；
 *   - APC 的 CURSOR_MARKER（`\x1b_pi:c\x07`）：硬件光标 / IME 定位用。
 * 它们都占 0 列，摘 `!` 时要原样留在原位。
 */
const LEADING_ZERO_WIDTH = /^(?:\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\))*/;

/**
 * 摘掉渲染行行首那个隐藏的 `!`（只摘第一个可见字符，其前的零宽转义原样保留）。
 * 只在 `resolveBashPrompt().hidden` 为真、且这一行就是正文第一行（未滚动）时调用。
 */
export function dropLeadingBang(line: string): LeadingBangDrop {
	const head = LEADING_ZERO_WIDTH.exec(line)?.[0] ?? "";
	const rest = line.slice(head.length);
	if (!rest.startsWith(BASH_MARKER)) return { text: line, dropped: false };
	return { text: head + rest.slice(BASH_MARKER.length), dropped: true };
}
