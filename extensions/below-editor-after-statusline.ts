/**
 * below-editor-after-statusline — 把「编辑器下方」的扩展 widget 挪到 statusline **下面**。
 *
 * 要解决的问题：pi-subagents 的 fleet 状态行（`1 active agent · ↓ 2.7k window · ↓/← to inspect`，
 * widget key `subagent-fleet-status`，见它的 `src/tui/fleet-status.ts`）注册为
 * `placement: "belowEditor"`，而 pi 的挂载顺序是
 *
 *     [document, pendingMessages, status, widgetContainerAbove,
 *      editor, widgetContainerBelow, footer]
 *
 * （`interactive-mode.js` 的 `mountInteractiveTui`）—— 于是这行提示出现在**输入框与 statusline
 * 之间**，把 statusline 挤到屏幕最底部。这一行是**状态信息**而不是输入区的一部分，视觉上应当
 * 沉到 statusline 下面去，让「输入框 → statusline」保持紧邻。
 *
 * 为什么只能改结构：pi-subagents 的 `fleetViewPlacement` 只接受 `aboveEditor` / `belowEditor`
 * （`shared/types.ts` 的 `FleetViewPlacement`，默认 belowEditor），pi 的 `setWidget` 也只有这两个
 * 位置，没有任何「footer 之下」的 placement；footer 本身（statusline 那些行）由
 * 本地 `extensions/statusline/` 通过 `ctx.ui.setFooter()` 独占，扩展拿不到它的渲染结果去拼接。
 *
 * 做法：pi-tui 的 `TUI` / `Container` 把 `children` 作为公开字段暴露，而 `TuiBase.render()`
 * 就是**按数组顺序**拼接每个 child 的行（`tui.js`），所以只要把
 * 「编辑器下方的 widget 容器」这个 child 挪到数组末尾（footer 容器之后）即可。
 *
 * 怎么认出是哪个 child：不猜下标 —— 先注册一个**探针 widget**（`placement: belowEditor`，
 * render 返回空数组所以不可见），从 widget 工厂拿到 TUI，再遍历 `children` 找到「子树里装着
 * 那个探针组件」的顶层 child，那就是编辑器下方的 widget 容器；把它移到末尾，然后删掉探针。
 * 探针的注册与删除都发生在同一 tick 内（`setWidget` 只是 `requestRender()`，不会立刻出帧），
 * 所以屏幕上不会闪出任何东西。下面那只 widget 容器里的现有内容（fleet 行）原样跟着搬家。
 *
 * 顺序会保持住：pi 只在 init 与切换 TUI 模式时调 `mountInteractiveTui`，而 `switchTuiMode`
 * 是 `[...previousUi.children]` 原样再挂一遍（顺序被复制），所以移动一次就够了；`/reload`
 * 后 `session_start` 会再跑一次，同样幂等（已经在末尾 → 直接返回）。
 *
 * 刻意不做的事：
 *   - 不改 pi-subagents 的任何文件（npm 包，升级即丢），也不改 pi 本身；
 *   - fullscreen（`--tui-mode fullscreen`）下 pi 用的是自己那棵 viewport 布局树
 *     （`createChatViewport` + `setLayoutRoot`），容器顺序由那棵树决定，本扩展**不保证**在
 *     fullscreen 下生效 —— 本机 `settings.json` 的 `tuiMode` 是 `regular`（实测布局就是这个
 *     顺序），fullscreen 下最坏情况只是回到「提示行在 statusline 上面」；
 *   - 找不到那个 child（pi 改了挂载结构）时**什么都不做**，不抛错、不猜下标 —— 界面回到改动前
 *     的样子，而不是错位；`tui.children` 万一变成只读数组（`splice`/`push` 抛 TypeError）
 *     同理：只当「没搬成」，绝不让异常漏给宿主去弹 extension error。
 *
 * 环境变量：
 *   PI_BELOW_EDITOR_AFTER_STATUSLINE=off   启动时关闭本扩展
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 探针 widget 的 key（只在本次调用里短暂存在）。 */
const PROBE_KEY = "below-editor-order-probe";

const DISABLED = (process.env.PI_BELOW_EDITOR_AFTER_STATUSLINE ?? "").trim().toLowerCase() === "off";

/** 子树里是否装着这个组件 —— 按对象身份比对，不按形状（同形状的组件到处都是）。 */
function containsComponent(node: unknown, target: unknown, seen = new Set<unknown>()): boolean {
	if (node === target) return true;
	if (node === null || typeof node !== "object" || seen.has(node)) return false;
	seen.add(node);
	const children = (node as { children?: unknown }).children;
	if (!Array.isArray(children)) return false;
	return children.some((child) => containsComponent(child, target, seen));
}

export default function (pi: ExtensionAPI): void {
	if (DISABLED) return;

	function moveBelowEditorWidgetsLast(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		let tui: unknown;
		let probe: unknown;
		try {
			// 探针必须显式声明 belowEditor —— 默认位置上方的那个容器不是要搬的对象，
			// 弄错会把「编辑器上方」的 widget 区（任务清单 / 摘要）整块搬到 footer 底下。
			ctx.ui.setWidget(
				PROBE_KEY,
				(widgetTui, _theme) => {
					tui = widgetTui;
					const component = { render: (): string[] => [], invalidate() {} };
					probe = component;
					return component;
				},
				{ placement: "belowEditor" },
			);
		} catch {
			// 没有 UI / ctx 已失效：什么都别做。
			return;
		}

		try {
			const children = (tui as { children?: unknown } | undefined)?.children;
			if (!Array.isArray(children)) return;
			const index = children.findIndex((child) => containsComponent(child, probe));
			// 找不到（pi 换了内部结构）或本来就在最后（footer 之后）→ 不动。
			if (index < 0 || index >= children.length - 1) return;
			// 数组万一变成只读（splice 抛 TypeError）也只当作「没搬成」：
			// 界面回到改动前的顺序，绝不把异常漏给宿主弹 extension error。
			try {
				const [container] = children.splice(index, 1);
				children.push(container);
			} catch {
				// 只读 / 诡异代理：保持原顺序。
			}
		} finally {
			try {
				ctx.ui.setWidget(PROBE_KEY, undefined);
			} catch {
				// stale ctx：探针随会话一起消失，不影响已完成的重排。
			}
		}
	}

	// init 时 TUI 先挂载、随后才 emit session_start（`InteractiveMode.init` →
	// `bindCurrentSessionExtensions`），所以这里一定能拿到已经挂好的组件树。
	// resume / fork / /reload 都会触发，重复执行是幂等的。
	pi.on("session_start", async (_event, ctx) => moveBelowEditorWidgetsLast(ctx));
}
