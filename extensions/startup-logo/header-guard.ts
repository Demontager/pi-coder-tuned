/**
 * header-guard.ts — 会话替换期间的 header「冻结」
 *
 * 问题和 statusline 的 footer 冻结同源：pi 每次换会话（`/new`、`/clear`、`/resume`、fork、
 * rewind）都会在 `session_shutdown` 之后、新会话 `session_start` 之前调 `resetExtensionUI()`，
 * 它无条件 `setExtensionHeader(undefined)` 把 header 还原成内置那只（`interactive-mode.js`）。
 * 中间要新建会话对象、重绑扩展，几十毫秒起步，而 pi-tui 的渲染节流只有 16ms，所以这段窗口
 * 至少会出几帧 —— 装了 logo header 的话，顶部会「闪」回 `pi vX.Y.Z` + 提示行，而且内置 header
 * 比 logo 矮，还会带一次整块布局跳动。
 *
 * 修法与 footer 版一致：扩展侧没有更早的钩子（新实例要等重绑才拿到 ctx），所以把保证落在
 * **出帧那一刻** —— 接管 header 容器的 `render`，发现里面装的已经不是我们的组件时，返回上一帧
 * 的行，内置 header 一帧都不出现。
 *
 * 约束（与 statusline/footer-guard.ts 相同）：
 *   - 只替换容器的 `render`，不改 `children`、不猜下标、不碰 pi 内部状态；
 *   - 容器按**对象身份**在 `tui.children` 子树里认（`findRenderContainer`），认不出就什么都不做；
 *   - 任何一步抛错都当作「没冻住」，绝不把异常漏给宿主；
 *   - 接管记录挂在容器上的 `Symbol.for(...)` 键，`/reload` 后新实例能看到并解除旧实例的接管；
 *     另有 `maxAgeMs` 兜底，交接万一失败也只冻一小会儿。
 *
 * 与 footer 版各持一份、各用各的符号键：两个扩展互不依赖，也不会互相顶掉接管。
 */

/** 挂在 header 容器上的接管记录键（全局符号注册表：跨扩展实例可见）。 */
export const HEADER_GUARD_KEY: symbol = Symbol.for("litellm-any.pi-startup-logo.headerGuard");

/** 冻结的最长时长：正常情况下新会话的 `session_start` 会远早于它解除。 */
export const HEADER_GUARD_MAX_AGE_MS = 3000;

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
export function releaseHeaderGuard(container: unknown): boolean {
	try {
		const record = (container as { [HEADER_GUARD_KEY]?: GuardRecord } | undefined)?.[HEADER_GUARD_KEY];
		if (!record || typeof record.release !== "function") return false;
		record.release();
		return true;
	} catch {
		return false;
	}
}

/**
 * 接管 header 容器的渲染，返回解除函数（幂等）。
 *
 * - `ownComponent` 还在容器里 → 原样透传（并在超时后顺手交还，自愈）；
 * - 容器被 pi 换成内置 header → 返回 `frozenRender(width)` 的行；
 * - 超过 `maxAgeMs` 仍等不到新 header → 交还，回到 pi 默认行为。
 */
export function freezeHeaderContainer(options: {
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
	releaseHeaderGuard(container);

	const ownComponent = options.ownComponent;
	const maxAgeMs = options.maxAgeMs ?? HEADER_GUARD_MAX_AGE_MS;
	const now = options.now ?? Date.now;
	const armedAt = now();
	const hadOwnRender = Object.prototype.hasOwnProperty.call(container, "render");
	const originalRender = container.render;
	const state: { released: boolean; record?: GuardRecord } = { released: false };

	const release = (): void => {
		if (state.released) return;
		state.released = true;
		try {
			const holder = container as { [HEADER_GUARD_KEY]?: GuardRecord };
			if (state.record && holder[HEADER_GUARD_KEY] === state.record) delete holder[HEADER_GUARD_KEY];
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
		(container as { [HEADER_GUARD_KEY]?: GuardRecord })[HEADER_GUARD_KEY] = state.record;
	} catch {
		return undefined;
	}
	return release;
}
