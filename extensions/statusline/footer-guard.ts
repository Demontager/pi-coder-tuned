/**
 * footer-guard.ts — "freezing" the footer across session replacement
 *
 * The problem it solves: on every session swap (`/new`, `/clear`, `/resume`, fork,
 * rewind) pi calls `resetExtensionUI()` after `session_shutdown` and before the new
 * session's `session_start` — it unconditionally `setExtensionFooter(undefined)`,
 * restoring the built-in footer, and `clearExtensionStatuses()` wipes every
 * `setStatus` text (`interactive-mode.js`). A new session object and extension
 * rebinding take tens of milliseconds at minimum, while pi-tui's render throttle is
 * just 16ms (`TuiBase.MIN_RENDER_INTERVAL_MS`) — that window emits several real
 * frames, and a statusline installed via `ctx.ui.setFooter()` "flashes" back to
 * pi's default footer while the second row (cwd / checkpoint) vanishes wholesale.
 *
 * Why it can only be solved on the render path: no earlier hook exists on the
 * extension side. A new extension instance gets its ctx only in
 * `bindCurrentSessionExtensions()` — which is precisely when the window ends; and
 * proactively re-mounting the footer inside the window is unreliable
 * (`resetExtensionUI` runs **after** our `session_shutdown` callback, and with
 * multiple awaits on the chain, `setImmediate` vs microtask order depends on how
 * long other extensions take). So the guarantee lands **at frame time**: take over
 * the footer container's `render` and, on finding our component is no longer
 * inside, return the previous frame's rows — the default footer never draws once.
 *
 * The implementation constraints (same as this directory's other files):
 *   - only the container's `render` method is replaced — `children` untouched, no
 *     index guessing, no pi internal state;
 *   - the container is found by **object identity** inside `tui.children`
 *     (`findRenderContainer`); not found → nothing happens;
 *   - any throw anywhere counts as "not frozen" — an exception never reaches the
 *     host as an extension error;
 *   - the takeover record hangs on the container's `FOOTER_GUARD_KEY`
 *     (`Symbol.for`, so a `/reload`'d new extension instance can see and release a
 *     previous instance's takeover); `maxAgeMs` is the fallback — a failed handover
 *     freezes only briefly.
 *
 * The known small cost: while frozen, the container's mouse hit-testing
 * (`Container.handleMouse` reads `children`) measures by the built-in footer's
 * height — the window is a frame or two and the footer is not clickable anyway, so
 * it is negligible.
 */

/** The takeover-record key hung on the footer container (global symbol registry: visible across extension instances). */
export const FOOTER_GUARD_KEY: symbol = Symbol.for("litellm-any.pi-statusline.footerGuard");

/** The freeze's max duration: a normal new-session `session_start` releases it far earlier. */
export const FOOTER_GUARD_MAX_AGE_MS = 3000;

/** The part of pi-tui `Container` this module uses (`children` is a public field). */
export interface RenderableContainer {
	children: unknown[];
	render(width: number): string[];
}

interface GuardRecord {
	release: () => void;
}

/**
 * Find "the container directly holding `component`" inside `root`'s subtree, by
 * object identity.
 * Identity only (identically-shaped components are everywhere); a seen-set and a
 * depth cap; any exception counts as not found.
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

/** Release whatever takeover `container` carries (possibly a leftover of another extension instance). Returns whether anything was released. */
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
 * Take over the footer container's rendering; returns the release function
 * (idempotent).
 *
 * - `ownComponent` still inside → pass through (and hand back after the timeout —
 *   self-healing);
 * - the container was swapped to pi's built-in footer → `frozenRender(width)`'s
 *   rows;
 * - no new footer within `maxAgeMs` → release, back to pi's default behavior.
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
	// release any existing takeover first (own re-entry / a leftover of the previous extension instance) — avoids stacking two wrappers.
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
			// read-only container / already replaced: the wrapper passes through via its released flag — no more freezing.
		}
	};

	const wrapper = (width: number): string[] => {
		if (state.released) return originalRender.call(container, width);
		const expired = now() - armedAt > maxAgeMs;
		let mounted = false;
		try {
			mounted = Array.isArray(container.children) && container.children.includes(ownComponent);
		} catch {
			mounted = true; // even reading children throws: don't force it — hand back to the original render.
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
