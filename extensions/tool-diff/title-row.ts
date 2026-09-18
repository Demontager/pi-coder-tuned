/**
 * title-row.ts — `Edit` / `Write` 标题行（`Edit <path> (+3 -5)`）的纯排版逻辑。
 * 工具名由调用方传入（`titleRow(theme, "Edit", …)`），本模块不认工具、只看宽度。
 *
 * 从 `tool-diff.ts` 抽出来的理由有两个：
 *
 *   1. **可单测**。这段是纯字符串排版（预算分配 + 按宽度截断），却埋在 1300 多行、到处
 *      import pi 的 `tool-diff.ts` 里，`node --test` 根本 import 不进来。抽出后本模块
 *      **不 import pi / pi-tui**：宽度函数 `widthOf`、截断函数 `truncateToWidth`、home
 *      目录、缩进全部从 `deps` 注入（与 `working-summary.ts` 同一套做法），测试里喂一个
 *      ASCII=1 / CJK=2 的假量宽函数就能跑满每个分支。
 *   2. **「超长路径跟着闪烁一起抖」的现场就在这里**。路径预算按「可用宽度 − 工具名 −
 *      尾部」算，而流式期间尾部是那个闪烁的 `●` —— 亮 / 灭两态各自占 2 列和 0 列，于是
 *      每 500ms 预算变一次、路径的截断窗口跟着左右挪 2 列，看起来就是「文件名自己在闪」。
 *      修法见 `blinkSuffix`（灭态等宽占位）。
 *
 * 模块放在 `extensions/tool-diff/` 这个**同名目录**下（`tool-diff.ts` 与 `tool-diff/` 可以
 * 并存）：目录里没有 `index.ts`，而 pi 的加载器只认 `extensions/<name>.ts` 与
 * `extensions/<name>/index.ts`（loader.js 的 `discoverExtensionsInDir` → `resolveExtensionEntries`
 * 找不到入口就整目录跳过），所以它不会被当成扩展加载。
 */

/** 从头部截断时用的省略号。1 列宽。 */
export const ELLIPSIS = "…";
/** 流式加载中的标记字符。1 列宽（`visibleWidth("●") === 1`，已核对）。 */
export const BLINK_MARKER = "●";

/** 渲染需要的主题子集（`Theme.fg` 的方法声明是**双变**的，真实 `Theme` 可直接赋值）。 */
export interface TitleTheme {
	fg(color: string, text: string): string;
}

/** 标题行尾部 `(+N -M)` 的行数统计。 */
export interface TitleStats {
	added: number;
	removed: number;
}

/**
 * 排版依赖（全部注入，本模块因此不 import pi / pi-tui）。
 *
 * `widthOf` / `truncateToWidth` 运行时传 pi-tui 的 `visibleWidth` / `truncateToWidth`
 * （与渲染器同一套实现，量出来的宽度与 pi 实际折行严格一致）；`home` 传 `os.homedir()`；
 * `indent` 传调用方的标题缩进。
 */
export interface TitleRowDeps {
	/** 可见宽度（忽略 ANSI 转义、CJK 记 2 列） */
	widthOf(text: string): number;
	/** 按可见宽度从**尾部**截断（ANSI 安全），超出部分换成一个省略号 */
	truncateToWidth(text: string, width: number, ellipsis: string): string;
	/** home 目录（`""` = 不做 `~` 缩写） */
	home?: string;
	/** 标题缩进，默认 1 个空格 */
	indent?: string;
}

/**
 * 闪烁标记的着色尾部。**灭态返回等宽空格占位，绝不返回空串。**
 *
 * 为什么不能返回空串：`TitleRow` 的路径预算 = 可用宽度 − 工具名 − 尾部（分隔空格 + 标记），
 * 尾部在「亮 = 2 列 / 灭 = 0 列」之间来回就是**预算每 500ms 跳 2 列**。路径短（装得下）时
 * 看不出来，路径长到需要截断时，截断窗口跟着一起左右挪 —— 实测每个闪烁周期里路径的前半段
 * （`…` 之后那截）和文件名的落点都会平移 2 列，观感是「标记在闪、文件名也在闪」。
 * 用空格占位后两态同宽，路径恒定，只有标记本身在亮灭。
 */
export function blinkSuffix(theme: TitleTheme, on: boolean): string {
	return theme.fg("dim", on ? BLINK_MARKER : " ");
}

/**
 * 行数的显示形态：万位以上缩略成 `k`（`10043` → `10k`、`11133` → `11.1k`）。
 *
 * 尾部 `(+N -M)` 是这一行里**不能被截掉**的部分，但两个五位数并排能吃掉 13 列以上，
 * 窄终端里那几列本该留给路径。缩到 `k` 之后最多 5-6 列，路径的可用宽度也稳定了
 * （写入量越大越极端，这里只影响显示，不影响任何统计口径）。
 * 万位以下原样显示 —— `+1043` 比 `+1.0k` 精确，也不长。
 */
export function formatCount(count: number): string {
	if (!Number.isFinite(count) || count < 10_000) return String(count);
	const thousands = count / 1000;
	if (thousands < 100) {
		const rounded = Math.round(thousands * 10) / 10;
		return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
	}
	return `${Math.round(thousands)}k`;
}

/**
 * 标题行尾部的 `(+3 -5)`：新增绿、删除红（沿用 diff 的 `toolDiffAdded` / `toolDiffRemoved`，
 * 跟卡片里的 +/- 行同色），括号保持 dim。为 0 的一侧省略，两侧都为 0（无改动 / 算不出来）
 * 返回空串 —— 空括号比没有括号更难看。
 */
export function statsSuffix(theme: TitleTheme, stats: TitleStats | undefined): string {
	if (stats === undefined) return "";
	const parts: string[] = [];
	if (stats.added > 0) parts.push(theme.fg("toolDiffAdded", `+${formatCount(stats.added)}`));
	if (stats.removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${formatCount(stats.removed)}`));
	if (parts.length === 0) return "";
	return `${theme.fg("dim", "(")}${parts.join(" ")}${theme.fg("dim", ")")}`;
}

/** 把 home 目录前缀缩写成 `~`，跟内置工具标题的惯例一致 */
export function shortenPath(path: string, home: string): string {
	if (home === "" || !path.startsWith(home)) return path;
	const rest = path.slice(home.length);
	// 只在边界处缩写：`~` 本身或 `~/...`，避免把 `/Users/bachir/...` 误缩成 `~r/...`
	if (rest === "" || rest.startsWith("/")) return `~${rest}`;
	return path;
}

/**
 * 从**头部**截断到指定列宽：保留尾部，前面用一个 `…` 顶替被丢掉的字符。
 * 按**码点**走（不是 UTF-16 单元），所以代理对不会被切成半个；宽度用 `widthOf`
 * 逐字符量，CJK / emoji 占 2 列也算得对。
 */
export function truncateStartToWidth(
	text: string,
	maxWidth: number,
	widthOf: (text: string) => number,
	ellipsis = ELLIPSIS,
): string {
	if (maxWidth <= 0) return "";
	if (widthOf(text) <= maxWidth) return text;
	const budget = maxWidth - widthOf(ellipsis);
	if (budget <= 0) return ellipsis;
	const chars = Array.from(text);
	let used = 0;
	let start = chars.length;
	for (let i = chars.length - 1; i >= 0; i -= 1) {
		const charWidth = widthOf(chars[i] ?? "");
		if (used + charWidth > budget) break;
		used += charWidth;
		start = i;
	}
	return ellipsis + chars.slice(start).join("");
}

/**
 * 标题行组件。用 `Text` 的话长路径会被折成两三行（工具名 / 路径 / 计数各一行），
 * 所以自己按宽度排版成**恒一行**。
 *
 * 排版优先级：工具名和尾部（`(+N -M)` / 闪烁的 `●`）**永远完整**，路径吃剩下的宽度、
 * 超宽时从头部截断。尾部是这一行的信息量所在，被截掉就失去意义了；只有窄到连一个
 * 字符的路径都放不下时，才退回整行尾部截断（至少保住工具名）。
 */
export class TitleRow {
	// 字段显式声明 + 构造里赋值，**不用参数属性**（`constructor(private readonly x)`）：
	// Node 的类型剥离不支持它（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`），而本模块要能被
	// `node --test` 直接 import。
	private readonly deps: TitleRowDeps;
	private readonly theme: TitleTheme;
	/** 已着色的工具名 */
	private readonly tool: string;
	/** 纯文本路径（未着色）—— 先按宽度截断再上色，否则 ANSI 串会被截断逻辑当成可见字符 */
	private readonly path: string;
	/** 已着色的尾部 */
	private readonly suffix: string;

	constructor(deps: TitleRowDeps, theme: TitleTheme, tool: string, path: string, suffix: string) {
		this.deps = deps;
		this.theme = theme;
		this.tool = tool;
		this.path = path;
		this.suffix = suffix;
	}

	render(width: number): string[] {
		const { widthOf } = this.deps;
		const indent = this.deps.indent ?? " ";
		// 缩进占 1 列，所以正文的可用宽度要相应减 1，否则整行会超宽
		const available = Math.max(1, width - widthOf(indent));
		const path = this.path === "" ? "" : shortenPath(this.path, this.deps.home ?? "");
		const toolWidth = widthOf(this.tool);
		// 尾部与路径各占一个分隔空格
		const suffixWidth = this.suffix === "" ? 0 : 1 + widthOf(this.suffix);
		const pathBudget = available - toolWidth - suffixWidth - (path === "" ? 0 : 1);

		if (path === "" || pathBudget < 1) {
			const fallback = [this.tool, path === "" ? "" : this.theme.fg("text", path), this.suffix]
				.filter((part) => part !== "")
				.join(" ");
			return [indent + this.deps.truncateToWidth(fallback, available, ELLIPSIS)];
		}

		const shown = this.theme.fg("text", truncateStartToWidth(path, pathBudget, widthOf));
		const tail = this.suffix === "" ? "" : ` ${this.suffix}`;
		return [indent + `${this.tool} ${shown}${tail}`];
	}

	invalidate(): void {}
}
