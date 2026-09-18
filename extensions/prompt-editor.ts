/**
 * 输入框视觉层微调：① 类似 Claude Code 的 "❯" 提示符（`!` bash 模式换成 "!"）；
 * ② 补全列表与 statusline 之间留一行空行。
 *
 * ① 提示符实现方式：继承 CustomEditor，把真正的编辑区收窄 gutter 列（super.render(width - gutter)），
 * 再把 gutter 补回每一行的左侧：
 *   - 上/下边框：由 renderTopBorder / renderBottomBorder 自己补满，保持边框满宽
 *   - 第一行文本（未滚动时）→ "❯ "，bash 模式（正文以 `!` 开头）→ "! "
 *   - 其余文本行 / 自动补全行 → 等宽空格
 * 光标位置由行内的 CURSOR_MARKER 决定，跟着文本一起右移，所以硬件光标 / IME 定位不受影响；
 * 鼠标点击坐标同样左移 gutter 列后再交给父类（bash 模式再多算一列隐藏的 `!`），点击定位保持准确。
 *
 * ② 补全列表与 statusline 的空行：Editor.render() 把补全列表渲染在**编辑器底边框之后**
 * （editor.js：renderBottomBorder 之后才 push autocompleteList.render()），而 statusline 紧跟
 * 在编辑器下方，所以输入 "/xxx" 时补全列表会紧贴 statusline。这里在补全列表真的渲染了的时候
 * 追加一行空白行（只在有补全列表时补，静态布局不变）。判据用公开的 isShowingAutocomplete()
 * （= autocompleteState !== null），而 Editor 里 state 与 autocompleteList 总是一起设置 / 一起清除
 * （clearAutocompleteUi），所以它与“列表真的渲染了”严格同步，不必碰 private 的
 * renderedAutocompleteHeight。空白行按 pi 自己的惯例补满宽度（Editor 每行都 pad 到
 * contentWidth），避免差分渲染器只写变化前缀时留残影。
 * 鼠标不受影响：空白行在补全列表之下（超出 autocompleteStartRow + renderedAutocompleteHeight），
 * 落到 Editor.handleMouse 的“超出可见行”分支；Container 的鼠标分派用 render().length 算子组件
 * 高度，所以高度 +1 后下方组件的坐标仍然对得上。
 *
 * 为什么不开第三个编辑器包装器扩展：`ctx.ui.setEditorComponent()` 是**替换**而非叠加，
 * prompt-editor 的工厂会直接丢掉之前的包装（README 里 folder-history 就是被这个顺序坑过）。
 * 所以这个改动放在已经拥有编辑器子类的本文件里，不新增任何加载顺序约束。
 *
 * Editor 的 theme / scrollOffset / renderedAutocompleteHeight 都是 private，
 * 所以这里只用 protected 的 renderTopBorder/renderBottomBorder 拿到需要的信息。
 *
 * ③ 补全列表左移：Editor 把补全列表渲染在底边框之后，PromptEditor 又给每一行补了 gutter
 * 列，于是命令词落在第 gutter+2 列（"→ " 前缀占 2 列）。这里让底边框之后的补全行少补
 * shift 列空格（默认 shift = 1，即整个列表含选择箭头左移一列）。
 * 渲染器对每条变化行先写 \x1b[2K 整行清除，补全行变短不会留残影；SelectList.handleMouse
 * 只用 event.y 定位，左移不影响鼠标点选。
 *
 * ④ `!` bash 模式（对齐 Claude Code）：输入框第一个字符是 `!` 时，gutter 的 `❯` 换成 `!`，
 * 正文里那个 `!` 不再显示 —— 于是正文看起来就是命令本身，而光标/IME/点选都还在它原来那一列。
 * 模式判定、Enter 提交（`text.startsWith("!")`）、↑ 历史、Esc 清空全部沿用 pi 自己的链路
 * （`interactive-mode.js` 的 `onChange` 是 `text.trimStart().startsWith("!")`，边框颜色用的就是它），
 * 这里只把渲染层对齐过去：判定与摘除在 `./prompt-editor/bash-prompt.ts`（纯逻辑，可单测）。
 * 三处细节：
 *   - 正文一个字符都不动（隐藏只是画法），所以 pi 那边的颜色/提交/历史不需要任何配合；
 *   - 隐藏掉一列后，正文整体左移一列 —— 渲染时把首行摘掉一个 `!` 再补一个空格回满宽，
 *     鼠标点选要多算一列，光标如果停在那一列（Ctrl+A / 方向键 / 点 gutter）会被挡回第 1 列：
 *     放进去的话反显光标会落在被摘掉的空列上，而在那儿打字会把 `x!ls` 写进正文，
 *     pi 当场判定「不是 bash 模式了」；
 *   - 退出模式不需要额外代码：正文为空时按回退键删掉 `!`（或 Enter 提交 / Esc 清空），
 *     pi 那边 `isBashMode` 变回 false、边框颜色照旧逻辑回落，这里下一帧就画回 `❯`。
 *
 * 可用环境变量：
 *   PI_EDITOR_PROMPT             提示符字符，默认 "❯"（bash 模式的 "!" 不跟着变）
 *   PI_EDITOR_AUTOCOMPLETE_GAP   设为 off 关闭补全列表下方的空白行
 *   PI_EDITOR_AUTOCOMPLETE_SHIFT 补全列表左移列数，0..gutter，默认 1；
 *                                设 0 恢复旧行为，设 2（= gutter）则命令词对齐光标起始列
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

/** 补全列表左移列数覆盖值；未设置时默认左移 1 列。 */
const AUTOCOMPLETE_SHIFT_OVERRIDE = (() => {
	const raw = process.env.PI_EDITOR_AUTOCOMPLETE_SHIFT;
	if (raw === undefined || raw.trim() === "") return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
})();

class PromptEditor extends CustomEditor {
	private readonly gutter: number;
	/** 最近一次 renderBottomBorder 生成的整行，用来在 render() 里认出下边框 */
	private bottomBorderLine = "";
	/** 上边框带的 "↑ N more" 说明当前视图是滚动过的 */
	private scrolled = false;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.gutter = visibleWidth(PROMPT_CHAR) + 1; // 提示符 + 一个空格
	}

	private get gutterFill(): string {
		return this.borderColor("─".repeat(this.gutter));
	}

	/**
	 * 提示符字形铺满 gutter 列（`❯` / `!` 都是 1 列，但 `PI_EDITOR_PROMPT` 可能是宽字符）。
	 * 只把字形染色、补齐的空格不染 —— 和原来的 `${borderColor("❯")} ` 逐字一致。
	 */
	private promptCell(char: string): string {
		const pad = Math.max(0, this.gutter - visibleWidth(char));
		return this.borderColor(char) + " ".repeat(pad);
	}

	/**
	 * 把光标挡在隐藏的 `!` 之外：Claude Code 里光标永远进不到模式标记上。
	 * 放它进去有两个后果 —— 反显光标落在被摘掉的那一空列上（看起来光标消失），
	 * 以及在那儿打字会把 `x!ls` 写进正文，pi 当场判定「不是 bash 模式了」。
	 * 光标列住在 Editor private 的 state 里、没有公开 setter，所以直接调它自己的
	 * setCursorCol(1)（顺带清掉 sticky 列）；pi 以后改名时这里退化成「光标停在 0 列」，
	 * 只影响这个边角行为，不影响渲染。
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

		// pi 的 bash 模式只由正文文本决定，不额外维护状态：每帧重算，永远不会和边框颜色脱节
		const bash = resolveBashPrompt(this.getText());

		const blank = " ".repeat(gutter);
		// 滚动后第一可见行已经不是逻辑首行，不再显示提示符
		const showPrompt = !this.scrolled;
		// EditorTheme 只暴露 borderColor，所以提示符沿用边框色（bash 模式下就是 bashMode 色）
		const prompt = this.promptCell(bash.active ? BASH_MARKER : PROMPT_CHAR);
		// 要摘 `!` 的那一行正好就是显示提示符的那一行
		const hideBang = bash.hidden && showPrompt;

		// 补全列表左移：默认 1 列（含选择箭头一起左移）。
		const shift = Math.max(0, Math.min(gutter, AUTOCOMPLETE_SHIFT_OVERRIDE ?? 1));
		const autocompleteBlank = " ".repeat(gutter - shift);

		let inAutocomplete = false;
		const mapped = lines.map((line, index) => {
			// 上边框已经在上面补满宽度
			if (index === 0) return line;
			// 下边框已补满宽度；其后的行都是补全列表行
			if (line === this.bottomBorderLine) {
				inAutocomplete = true;
				return line;
			}
			if (inAutocomplete) return autocompleteBlank + line;
			if (index === 1 && showPrompt) {
				if (!hideBang) return prompt + line;
				// 摘掉正文那个 `!` 后整行少 1 列，补一个空格回满宽（Editor 每行都铺满 contentWidth，
				// 少一列会在差分渲染器下留残影）
				const dropped = dropLeadingBang(line);
				return prompt + dropped.text + (dropped.dropped ? " " : "");
			}
			return blank + line;
		});

		// 补全列表渲染在编辑器底边框之后，紧接着就是 statusline，视觉上拥挤；
		// 只在补全列表真的存在时补一行空白行，静态布局不变。
		// 按 pi 自己的惯例补满宽度（其余行也都是 gutter + contentWidth = width）。
		if (AUTOCOMPLETE_GAP && this.isShowingAutocomplete()) {
			mapped.push(" ".repeat(Math.max(0, width)));
		}

		return mapped;
	}

	handleInput(data: string): void {
		super.handleInput(data);
		// 任何一条能改光标/正文的路径（方向键、Home/Ctrl+A、↑ 历史、退格、粘贴、undo…）都从这里过
		this.keepCursorOffBang();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// bash 模式下正文整体左移了 1 列（隐藏的 `!`），点选要往右多算 1 列才对得上原文。
		// 补全列表的 x 不参与命中（SelectList 只用 y），多这 1 列不影响它。
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
