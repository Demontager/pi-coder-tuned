/**
 * loaded-sections.ts — prune the `[Context]` / `[Prompts]` / `[Themes]` sections
 * from the "loaded resources" listing at startup
 *
 * After startup pi prints a "loaded resources" listing under the header
 * (`interactive-mode.js`'s `showLoadedResources`; each section = one
 * `ExpandableText` title row + one content row + one `Spacer(1)`):
 * `[Context]` (AGENTS.md-style context files), `[Skills]`, `[Prompts]` (slash
 * templates), `[Extensions]`, `[Themes]`.
 * Of these, `[Context]` / `[Prompts]` / `[Themes]` carry no information (the
 * first two are identical on every startup, and nobody counts theme files) —
 * keeping them is pure screen waste, so they are dropped **before entering the
 * container**; `[Skills]` / `[Extensions]` and diagnostic sections like
 * `[Skill conflicts]` are kept verbatim.
 *
 * Why not pi's own `quietStartup`: that switch disables the **whole listing**
 * (incl. Skills / Extensions / diagnostics) — only three sections are unwanted
 * here. The listing is filled by pi inside `bindCurrentSessionExtensions()`
 * **after** `session_start` (`showLoadedResources` follows `await
 * session.bindExtensions(...)`), so taking over the container's `addChild`
 * inside `session_start` is early enough: a hidden section never enters the
 * container — no "drawn then erased" flash frame exists.
 *
 * How the "loaded resources" container is found: pi's `documentContainer`
 * mounts children in the fixed order `[headerContainer,
 * loadedResourcesContainer, chatContainer]` (`interactive-mode.js`'s
 * constructor), so back-trace the **mounted header component** to its container
 * (`findRenderContainer`), go up to its parent, and take the sibling container
 * right after it. Not found → **do nothing** (the listing shows as usual) — no
 * index guessing, no throwing.
 *
 * Both detection and pruning are content-driven — it does not matter which
 * container is found: only a component whose **rendered first row is exactly
 * `[Context]` / `[Prompts]` / `[Themes]`** is dropped, so should pi move the
 * containers and we grab the wrong one (e.g. chatContainer), the cost is one
 * useless takeover, never a wrong deletion. Any throw anywhere counts as "not
 * a hidden section" → pass through.
 *
 * All pure logic (a container only needs `children` + `addChild`), no pi /
 * pi-tui imports — `node --test` runs it directly.
 */

/** The section names to prune (verbatim, case-sensitive — matches pi's `addLoadedSection("Context"…)`). */
export const HIDDEN_SECTION_NAMES: readonly string[] = ["Context", "Prompts", "Themes"];

/** The takeover-record key hung on the container (global symbol registry: a `/reload`'d new instance can see and release the old one's). */
export const SECTION_PRUNER_KEY: symbol = Symbol.for("litellm-any.pi-startup-logo.sectionPruner");

/**
 * The render width used for detection. A title row is only `[Context]` long
 * (9 columns) — far under any terminal width, so wrapping can never hide it;
 * a fixed value because `addChild` time does not know the real width (`render`
 * is the one that gets it).
 */
export const DETECT_WIDTH = 200;

/** The part of pi-tui `Container` this module uses (`children` / `addChild` are public). */
export interface PrunableContainer {
	children: unknown[];
	addChild?(child: unknown): void;
	render?(width: number): string[];
}

interface PrunerRecord {
	release: () => void;
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** The component's first rendered row (returned verbatim — may be undefined / non-string). */
function firstRenderedLine(component: unknown, width: number): unknown {
	try {
		if (component === null || typeof component !== "object") return undefined;
		const render = (component as { render?: unknown }).render;
		if (typeof render !== "function") return undefined;
		const lines = (render as (w: number) => unknown).call(component, width);
		if (!Array.isArray(lines) || lines.length === 0) return undefined;
		return lines[0];
	} catch {
		return undefined;
	}
}

/** ANSI-stripped and trimmed, is this row a `[Name]` shape; returns the name if so. */
export function sectionTitleOfLine(line: unknown): string | undefined {
	if (typeof line !== "string") return undefined;
	const plain = line.replace(ANSI_PATTERN, "").trim();
	// names may contain spaces (a diagnostic section like `[Skill conflicts]`), but no nested brackets.
	const match = /^\[([^[\]]+)\]$/.exec(plain);
	const title = match?.[1].trim();
	return title ? title : undefined;
}

/** Is this component's first row one of the hidden section titles. */
export function isHiddenSection(
	component: unknown,
	names: readonly string[] = HIDDEN_SECTION_NAMES,
	width: number = DETECT_WIDTH,
): boolean {
	const title = sectionTitleOfLine(firstRenderedLine(component, width));
	return title !== undefined && names.includes(title);
}

/** Is this component "one blank row" — the `Spacer(1)` `addLoadedSection` appends after each section. */
export function isBlankLineComponent(component: unknown, width: number = DETECT_WIDTH): boolean {
	try {
		if (component === null || typeof component !== "object") return false;
		const render = (component as { render?: unknown }).render;
		if (typeof render !== "function") return false;
		const lines = (render as (w: number) => unknown).call(component, width);
		return Array.isArray(lines) && lines.length === 1 && lines[0] === "";
	} catch {
		return false;
	}
}

/**
 * Delete the hidden sections already inside `container` (each with its trailing
 * separator blank), returning the number removed.
 *
 * The normal path never needs it (the `addChild` takeover blocks them upfront);
 * kept for "the takeover went in late" — e.g. a `/reload` where the listing was
 * already filled before the new instance ran.
 */
export function pruneHiddenSections(
	container: unknown,
	names: readonly string[] = HIDDEN_SECTION_NAMES,
	width: number = DETECT_WIDTH,
): number {
	const target = container as PrunableContainer | undefined;
	if (!target || !Array.isArray(target.children)) return 0;
	const children = target.children;
	let removed = 0;
	// walk backwards: after removing index i, the old i+1 (the following blank row) lands exactly on i.
	for (let i = children.length - 1; i >= 0; i--) {
		if (!isHiddenSection(children[i], names, width)) continue;
		try {
			children.splice(i, 1);
			removed++;
			if (i < children.length && isBlankLineComponent(children[i], width)) children.splice(i, 1);
		} catch {
			// e.g. a read-only array: remove what can be removed, then stop.
			break;
		}
	}
	return removed;
}

/** Release whatever takeover `container` carries (possibly a leftover of another extension instance). Returns whether anything was released. */
export function releaseHiddenSectionPruner(container: unknown): boolean {
	try {
		const record = (container as { [SECTION_PRUNER_KEY]?: PrunerRecord } | undefined)?.[SECTION_PRUNER_KEY];
		if (!record || typeof record.release !== "function") return false;
		record.release();
		return true;
	} catch {
		return false;
	}
}

function isPrunableContainer(value: unknown): value is PrunableContainer {
	return (
		value !== null &&
		typeof value === "object" &&
		Array.isArray((value as PrunableContainer).children) &&
		typeof (value as PrunableContainer).addChild === "function"
	);
}

/**
 * Take over `container.addChild`: hidden sections (and each one's trailing
 * separator blank) simply never go in; everything else passes through.
 * Returns the release function (idempotent); an unusable container → undefined.
 *
 * Idempotent: a repeat call releases the previous takeover first — no stacked
 * wrappers; a `/reload`'d new instance can release the old one's.
 */
export function installHiddenSectionPruner(options: {
	container: unknown;
	names?: readonly string[];
	width?: number;
}): (() => void) | undefined {
	if (!isPrunableContainer(options.container)) return undefined;
	const container = options.container;
	releaseHiddenSectionPruner(container);

	const names = options.names ?? HIDDEN_SECTION_NAMES;
	const width = options.width ?? DETECT_WIDTH;
	// prune whatever is already inside when the takeover went in late (the listing already filled).
	pruneHiddenSections(container, names, width);

	const originalAddChild = container.addChild!;
	const state: { released: boolean; record?: PrunerRecord } = { released: false };
	let dropNextBlank = false;

	const release = (): void => {
		if (state.released) return;
		state.released = true;
		try {
			const holder = container as { [SECTION_PRUNER_KEY]?: PrunerRecord };
			// a different instance's newer takeover already replaced ours: only let our wrapper go dead — do not tear down the new one.
			if (state.record && holder[SECTION_PRUNER_KEY] !== state.record) return;
			delete holder[SECTION_PRUNER_KEY];
			container.addChild = originalAddChild;
		} catch {
			// read-only container / already replaced: the wrapper passes through via its released flag.
		}
	};

	const wrapper = (child: unknown): void => {
		if (state.released) {
			originalAddChild.call(container, child);
			return;
		}
		try {
			if (isHiddenSection(child, names, width)) {
				// the section's own Spacer(1) follows it immediately — take it too, or a stray blank row is left behind.
				dropNextBlank = true;
				return;
			}
			if (dropNextBlank) {
				dropNextBlank = false;
				if (isBlankLineComponent(child, width)) return;
			}
		} catch {
			// detection failed: pass through as an ordinary child.
		}
		originalAddChild.call(container, child);
	};

	try {
		container.addChild = wrapper;
		state.record = { release };
		(container as { [SECTION_PRUNER_KEY]?: PrunerRecord })[SECTION_PRUNER_KEY] = state.record;
	} catch {
		return undefined;
	}
	return release;
}

/**
 * Inside `root`'s subtree, find "the container directly holding
 * `headerContainer`", then take its **following** sibling container — pi's
 * `loadedResourcesContainer`. Not found → undefined.
 */
export function findLoadedResourcesContainer(options: {
	root: unknown;
	headerContainer: unknown;
	maxDepth?: number;
}): PrunableContainer | undefined {
	const { root, headerContainer } = options;
	if (!headerContainer) return undefined;
	const maxDepth = options.maxDepth ?? 6;
	const seen = new Set<unknown>();

	const walk = (node: unknown, depth: number): unknown => {
		if (depth > maxDepth || node === null || typeof node !== "object" || seen.has(node)) return undefined;
		seen.add(node);
		const children = (node as { children?: unknown }).children;
		if (!Array.isArray(children)) return undefined;
		const index = children.indexOf(headerContainer);
		if (index >= 0) return children[index + 1];
		for (const child of children) {
			const found = walk(child, depth + 1);
			if (found !== undefined) return found;
		}
		return undefined;
	};

	try {
		const sibling = walk(root, 0);
		return isPrunableContainer(sibling) ? sibling : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Find the "loaded resources" container and install the pruning takeover.
 * Returns whether it was installed (container not found / wrong shape → false,
 * the listing stays as usual).
 */
export function hideLoadedSections(options: {
	root: unknown;
	headerContainer: unknown;
	names?: readonly string[];
}): boolean {
	const container = findLoadedResourcesContainer({ root: options.root, headerContainer: options.headerContainer });
	if (!container) return false;
	return installHiddenSectionPruner({ container, names: options.names }) !== undefined;
}
