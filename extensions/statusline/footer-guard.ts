/**
 * footer-guard.ts — 会话替换期间的 footer「冻结」
 *
 * 要解决的问题：pi 每次换会话（`/new`、`/clear`、`/resume`、fork、rewind）都会在
 * `session_shutdown` 之后、新会话 `session_start` 之前调 `resetExtensionUI()`，它无条件
 * `setExtensionFooter(undefined)` 把 footer 还原成内置那只、并 `clearExtensionStatuses()`
 * 清掉所有 `setStatus` 文本（`interactive-mode.js`）。中间要新建会话对象、重绑扩展，
 * 几十毫秒起步，而 pi-tui 的渲染节流只有 16ms（`TuiBase.MIN_RENDER_INTERVAL_MS`），
 * 所以这段窗口至少会出几帧 —— 用 `ctx.ui.setFooter()` 装的 statusline 就「闪」成
 * pi 默认 footer，第二行（cwd / checkpoint）整行消失。
 *
 * 为什么只能在渲染路径上解决：扩展侧没有更早的钩子。新扩展实例要等
 * `bindCurrentSessionExtensions()` 才拿到 ctx，而那正是窗口结束的时刻；在窗口内主动
 * 重挂 footer 也不可靠（`resetExtensionUI` 发生在我们的 `session_shutdown` 回调**之后**，
 * 且整条链上有多个 await，`setImmediate` / 微任务谁先谁后取决于别的扩展在这段里等多久）。
 * 所以保证落在**出帧那一刻**：接管 footer 容器的 `render`，发现里面装的已经不是我们的
 * 组件时，返回上一帧的行 —— 默认 footer 一帧都不会出现。
 *
 * 做法上的约束（和本目录其它文件一致）：
 *   - 只替换 footer 容器的 `render` 方法，不改 `children`、不猜下标、不碰 pi 的内部状态；
 *   - 容器用**对象身份**从 `tui.children` 找（`findRenderContainer`），找不到就什么都不做；
 *   - 任何一步抛错都当作「没冻住」，绝不把异常漏给宿主弹 extension error；
 *   - 接管记录挂在容器的 `FOOTER_GUARD_KEY`（`Symbol.for`，所以 `/reload` 后新的扩展实例
 *     也能看到并解除旧实例遗留的接管）；另有 `maxAgeMs` 兜底，交接万一失败也只冻一小会儿。
 *
 * 已知小代价：冻结期间该容器的鼠标命中测试（`Container.handleMouse` 读 `children`）会按
 * 内置 footer 的高度算，而窗口只有一两帧、footer 本来不可点，可忽略。
 */

/** 挂在 footer 容器上的接管记录键（全局符号注册表：跨扩展实例可见）。 */
export const FOOTER_GUARD_KEY: symbol = Symbol.for("litellm-any.pi-statusline.footerGuard");

/** 冻结的最长时长：正常情况下新会话的 `session_start` 会远早于它解除。 */
export const FOOTER_GUARD_MAX_AGE_MS = 3000;

/** pi-tui `Container` 里本模块用到的那部分结构（`children` 是公开字段）。 */
export interface RenderableContainer {
	children: unknown[];
	render(width: number): string[];
}

interface GuardRecord {
	release: () => void;
}

/**
 * 在 `root` 的子树里按对象身份找「直接装着 `component` 的那个容器」。
 * 只认对象身份（同形状的组件到处都是），带 seen 集与深度上限，任何异常都当作没找到。
 */
export function findRenderContainer(
	root: unknown,
	component: unknown,
	maxDepth = 6,
): RenderableContainer | undefined {
	if (component === undefined || component === null) return undefined;
	const seen = new Set<unknown>();

	const walk = (node: unknown, depth: number): RenderableContainer | undefined => {
		if (depth > maxDepth || node === null || typeof node !== "object" || seen.has(node)) {
			return undefined;
		}
		seen.add(node);
		const children = (node as { children?: unknown }).children;
		if (!Array.isArray(children)) return undefined;
		if (children.includes(component)) return node as RenderableContainer;
		for (const child of children) {
			const found = walk(child, depth + 1);
			if (found) return found;
		}
		return undefined;
	};

	try {
		return walk(root, 0);
	} catch {
		return undefined;
	}
}

/** 解除 `container` 上现有的接管（可能是别的扩展实例遗留的）。返回是否解掉了什么。 */
export function releaseFooterGuard(container: unknown): boolean {
	try {
		const record = (container as { [FOOTER_GUARD_KEY]?: GuardRecord } | undefined)?.[FOOTER_GUARD_KEY];
		if (!record || typeof record.release !== "function") return false;
		record.release();
		return true;
	} catch {
		return false;
	}
}

/**
 * 接管 footer 容器的渲染，返回解除函数（幂等）。
 *
 * - `ownComponent` 还在容器里 → 原样透传（并在超时后顺手交还，自愈）；
 * - 容器被 pi 换成内置 footer → 返回 `frozenRender(width)` 的行；
 * - 超过 `maxAgeMs` 仍等不到新 footer → 交还，回到 pi 默认行为。
 */
export function freezeFooterContainer(options: {
	container: unknown;
	ownComponent: unknown;
	frozenRender: (width: number) => string[];
	maxAgeMs?: number;
	now?: () => number;
}): (() => void) | undefined {
	const container = options.container as RenderableContainer | undefined;
	if (
		!container ||
		typeof container.render !== "function" ||
		!Array.isArray(container.children) ||
		options.ownComponent === undefined
	) {
		return undefined;
	}
	// 先解除已有接管（自己重入 / 上一个扩展实例遗留），避免叠两层 wrapper。
	releaseFooterGuard(container);

	const ownComponent = options.ownComponent;
	const maxAgeMs = options.maxAgeMs ?? FOOTER_GUARD_MAX_AGE_MS;
	const now = options.now ?? Date.now;
	const armedAt = now();
	const hadOwnRender = Object.prototype.hasOwnProperty.call(container, "render");
	const originalRender = container.render;
	const state: { released: boolean; record?: GuardRecord } = { released: false };

	const release = (): void => {
		if (state.released) return;
		state.released = true;
		try {
			const holder = container as { [FOOTER_GUARD_KEY]?: GuardRecord };
			if (state.record && holder[FOOTER_GUARD_KEY] === state.record) delete holder[FOOTER_GUARD_KEY];
			if (hadOwnRender) container.render = originalRender;
			else delete (container as { render?: unknown }).render;
		} catch {
			// 容器只读 / 已被替换：wrapper 自己会因 released 标志透传，不再冻。
		}
	};

	const wrapper = (width: number): string[] => {
		if (state.released) return originalRender.call(container, width);
		const expired = now() - armedAt > maxAgeMs;
		let mounted = false;
		try {
			mounted = Array.isArray(container.children) && container.children.includes(ownComponent);
		} catch {
			mounted = true; // 读 children 都抛：别硬撑，交还给原渲染。
		}
		if (mounted) {
			if (expired) release();
			return originalRender.call(container, width);
		}
		if (expired) {
			release();
			return originalRender.call(container, width);
		}
		try {
			return options.frozenRender(width);
		} catch {
			return originalRender.call(container, width);
		}
	};

	try {
		container.render = wrapper as RenderableContainer["render"];
		state.record = { release };
		(container as { [FOOTER_GUARD_KEY]?: GuardRecord })[FOOTER_GUARD_KEY] = state.record;
	} catch {
		return undefined;
	}
	return release;
}
