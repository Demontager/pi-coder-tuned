/**
 * header-guard.ts — "freezing" the header across session replacement
 *
 * Same problem as statusline's footer freeze: on every session swap (`/new`,
 * `/clear`, `/resume`, fork, rewind) pi calls `resetExtensionUI()` after
 * `session_shutdown` and before the new session's `session_start` — it
 * unconditionally `setExtensionHeader(undefined)`, restoring the built-in header
 * (`interactive-mode.js`). A new session object and extension rebinding take
 * tens of milliseconds at minimum, while pi-tui's render throttle is 16ms — so
 * that window emits several real frames: with a logo header installed, the top
 * "flashes" back to `pi vX.Y.Z` + the hint line — and since the built-in header
 * is shorter than the logo, the whole layout jumps once too.
 *
 * The fix mirrors the footer version: no earlier hook exists on the extension
 * side (a new instance only gets its ctx at rebinding), so the guarantee lands
 * **at frame time** — the header container's `render` is taken over, and on
 * finding our component no longer inside, the previous frame's rows return —
 * the built-in header never draws once.
 *
 * Constraints (same as statusline/footer-guard.ts):
 *   - only the container's `render` is replaced — `children` untouched, no index
 *     guessing, no pi internal state;
 *   - the container is found by **object identity** inside the `tui.children`
 *     subtree (`findRenderContainer`); not found → nothing happens;
 *   - any throw anywhere counts as "not frozen" — an exception never reaches
 *     the host;
 *   - the takeover record hangs on a `Symbol.for(...)` key on the container, so
 *     a `/reload`'d new instance can see and release the old one's; `maxAgeMs`
 *     is the fallback — a failed handover freezes only briefly.
 *
 * Each side keeps its own copy with its own symbol key: the two extensions
 * depend on neither and cannot clobber each other's takeover.
 */

/** The takeover-record key hung on the header container (global symbol registry: visible across extension instances). */
export const HEADER_GUARD_KEY: symbol = Symbol.for("litellm-any.pi-startup-logo.headerGuard");

/** The freeze's max duration: a normal new-session `session_start` releases it far earlier. */
export const HEADER_GUARD_MAX_AGE_MS = 3000;

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
 * Take over the header container's rendering; returns the release function
 * (idempotent).
 *
 * - `ownComponent` still inside → pass through (and hand back after the timeout —
 *   self-healing);
 * - the container was swapped to pi's built-in header → `frozenRender(width)`'s
 *   rows;
 * - no new header within `maxAgeMs` → release, back to pi's default behavior.
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
	// release any existing takeover first (own re-entry / a leftover of the previous extension instance) — avoids stacking two wrappers.
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
		(container as { [HEADER_GUARD_KEY]?: GuardRecord })[HEADER_GUARD_KEY] = state.record;
	} catch {
		return undefined;
	}
	return release;
}
