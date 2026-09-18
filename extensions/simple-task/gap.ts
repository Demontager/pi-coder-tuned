/**
 * gap.ts — 决定任务清单这一帧要不要在**上/下各补一个空行**。
 *
 * 为什么需要它：pi 把「编辑器上方」的所有扩展 widget 放进同一个 Container，按 Map
 * 插入顺序依次 `addChild`（`interactive-mode.js` 的 `renderWidgetContainer`），
 * **两个 widget 之间没有任何间隔**；而 `setExtensionWidget` 是先 `map.delete(key)` 再
 * `set` —— 重新注册会把 widget 挪到末尾。simple-task 的 spinner 每 150ms 重注册一次
 * （见 index.ts 的 `ensureTimer`），于是清单通常落在最下面，pi-subagents 的
 * 「async subagent · background」块紧贴在它上面，两段内容糊成一片：
 *
 *     output: /var/folders/…/pi-subagents-ui…
 *     ● 6 tasks (1 done, 1 in progress, 4 open)
 *
 * 为什么走组件树：扩展拿不到「别人注册了什么 widget」（`ctx.ui` 没有枚举接口），
 * 但 pi 传进 widget 工厂的第一个参数就是 TUI 实例（`setExtensionWidget` 里的
 * `content(this.ui, theme)`），而 `TUI` / `Container` 的 `children` 是 pi-tui 的公开
 * 字段（`@earendil-works/pi-tui` 的 `tui.d.ts`）。于是渲染时可以从 TUI 根往下找到
 * **装着本组件的那个 Container**，再看紧邻兄弟渲染成什么样。传进来的 TUI 是 pi 的
 * `createInteractiveTuiReference()` 代理，永远指向当前 renderer，所以切换全屏/普通
 * 模式（renderer 会被整个换掉）之后依然能走到正确的树。
 *
 * 规则（目标是任意两个上下相邻的 widget 之间**恰好一行**空行，且孤立时不多出一行）：
 *   - 上方兄弟的**最后一行有可见内容** → 上方挨着东西，补一个前导空行；
 *   - 上方兄弟本身就以空行收尾（只有一个 widget 时它是 pi 自己加的 Spacer；
 *     挂着 recap 时是 recap 固定补的行尾空行）→ 间隔已经有了，不补；
 *   - 下方兄弟的**第一行有可见内容** → 清单落在上面时同样要间隔，补一个结尾空行；
 *   - 兄弟一条可见内容都没有（空 widget）→ 没什么可隔开的，不补；
 *   - 找不到自己的父容器、兄弟没有 `render`（pi 换了内部结构）→ 一律不补：
 *     宁可不补空行，也不要凭空多出一行。兄弟 `render` 抛异常时反过来当作
 *     「有内容」补一行 —— 那种情况下它是个真 widget，漏掉间隔正是要修的 bug。
 *
 * 本文件**不 import 任何 pi / pi-tui 模块**（只用鸭子类型 + 一个 ANSI 剥离正则），
 * 所以能用 `node --test` 直接跑 —— 与 `rewind/checkpoints.ts` 的做法一致。
 */

/** 需要补空行的两侧。 */
export interface WidgetGaps {
	above: boolean;
	below: boolean;
}

/** widget 行里只会出现 SGR 颜色序列。 */
const SGR = /\x1b\[[0-9;]*m/g;

const NO_GAPS: WidgetGaps = { above: false, below: false };
/** 一个「渲染不出任何可见内容」的边。 */
const EDGE_NOTHING = { visible: false, blank: false };
/** 渲染失败时的兜底：当作有内容。 */
const EDGE_UNKNOWN = { visible: true, blank: false };

interface EdgeInfo {
	visible: boolean;
	blank: boolean;
}

/** 有非空白字符（ANSI 颜色序列不算内容）。 */
function hasContent(line: string | undefined): boolean {
	return (line ?? "").replace(SGR, "").trim().length > 0;
}

/** `children` 是个数组的节点才算容器。 */
function childrenOf(node: unknown): unknown[] | undefined {
	if (node === null || typeof node !== "object") return undefined;
	const children = (node as { children?: unknown }).children;
	return Array.isArray(children) ? children : undefined;
}

/**
 * 从 TUI 根往下找「装着 self 的那个 Container」，返回它的 children。
 * 深度优先 + `seen` 去重：树里不会有环，但万一有也不会转死。
 */
function siblingsOf(root: unknown, self: unknown): unknown[] | undefined {
	const seen = new Set<unknown>();
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === null || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		const children = childrenOf(node);
		if (!children) continue;
		if (children.includes(self)) return children;
		for (const child of children) stack.push(child);
	}
	return undefined;
}

/** 渲染兄弟组件「面向自己」的那一行（`top` = 第一行，`bottom` = 最后一行）。 */
function facingEdge(component: unknown, width: number, edge: "top" | "bottom"): EdgeInfo {
	const render = (component as { render?: unknown } | null | undefined)?.render;
	if (typeof render !== "function") return EDGE_NOTHING;
	let rendered: unknown;
	try {
		rendered = (render as (width: number) => unknown).call(component, width);
	} catch {
		return EDGE_UNKNOWN;
	}
	if (!Array.isArray(rendered) || rendered.length === 0) return EDGE_NOTHING;
	const lines = rendered.map((line) => String(line));
	const edgeLine = edge === "top" ? lines[0] : lines[lines.length - 1];
	return { visible: lines.some(hasContent), blank: !hasContent(edgeLine) };
}

/**
 * 计算本组件当前这一帧需要在上/下补的空行（见文件头）。
 *
 * @param root  widget 工厂拿到的 TUI（pi 的 renderer 代理）
 * @param self  本组件自身（用来在容器里定位自己的位置）
 * @param width 当前渲染宽度，原样转发给兄弟组件 —— pi 是同一个宽度渲染同一个容器
 */
export function widgetGaps(root: unknown, self: unknown, width: number): WidgetGaps {
	const siblings = siblingsOf(root, self);
	if (!siblings) return NO_GAPS;
	const index = siblings.indexOf(self);
	if (index < 0) return NO_GAPS;

	const above = index > 0 ? facingEdge(siblings[index - 1], width, "bottom") : EDGE_NOTHING;
	const below = index < siblings.length - 1 ? facingEdge(siblings[index + 1], width, "top") : EDGE_NOTHING;
	return {
		above: above.visible && !above.blank,
		below: below.visible && !below.blank,
	};
}
