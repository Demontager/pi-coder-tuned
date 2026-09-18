/**
 * 输入框视觉层微调：① 类似 Claude Code 的 "❯" 提示符；② 补全列表与 statusline 之间留一行空行。
 *
 * ① 提示符实现方式：继承 CustomEditor，把真正的编辑区收窄 gutter 列（super.render(width - gutter)），
 * 再把 gutter 补回每一行的左侧：
 *   - 上/下边框：由 renderTopBorder / renderBottomBorder 自己补满，保持边框满宽
 *   - 第一行文本（未滚动时）→ "❯ "
 *   - 其余文本行 / 自动补全行 → 等宽空格
 * 光标位置由行内的 CURSOR_MARKER 决定，跟着文本一起右移，所以硬件光标 / IME 定位不受影响；
 * 鼠标点击坐标同样左移 gutter 列后再交给父类，点击定位保持准确。
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
 * 可用环境变量：
 *   PI_EDITOR_PROMPT             提示符字符，默认 "❯"
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

		const blank = " ".repeat(gutter);
		// EditorTheme 只暴露 borderColor，所以提示符沿用边框色
		const prompt = `${this.borderColor(PROMPT_CHAR)} `;
		// 滚动后第一可见行已经不是逻辑首行，不再显示提示符
		const showPrompt = !this.scrolled;

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
			if (index === 1 && showPrompt) return prompt + line;
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

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return super.handleMouse({
			...event,
			x: Math.max(0, event.x - this.gutter),
			width: Math.max(1, event.width - this.gutter),
		});
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
