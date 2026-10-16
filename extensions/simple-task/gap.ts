/**
 * gap.ts — decides whether the task list's current frame needs a blank row **above
 * and/or below**.
 *
 * Why it exists: pi puts every extension widget "above the editor" into one
 * Container, `addChild`-ing them in Map insertion order
 * (`interactive-mode.js`'s `renderWidgetContainer`) — **with no separator between two
 * widgets**; and `setExtensionWidget` does `map.delete(key)` then `set` —
 * re-registering moves a widget to the end. simple-task's spinner re-registers every
 * 150ms (see index.ts's `ensureTimer`), so the list usually lands at the bottom with
 * pi-subagents's "async subagent · background" block glued right on top — two blocks
 * of content fused together:
 *
 *     output: /var/folders/…/pi-subagents-ui…
 *     ● 6 tasks (1 done, 1 in progress, 4 open)
 *
 * Why the component tree: an extension cannot ask "what widgets did others register"
 * (`ctx.ui` has no enumeration API), but the first argument pi passes into the widget
 * factory is the TUI instance (`content(this.ui, theme)` in `setExtensionWidget`),
 * and `TUI` / `Container`'s `children` is a public pi-tui field
 * (`@earendil-works/pi-tui`'s `tui.d.ts`). So at render time the tree walks down from
 * the TUI root to **the Container holding this component**, then looks at what the
 * adjacent siblings render. The TUI handed in is pi's
 * `createInteractiveTuiReference()` proxy — always pointing at the current renderer —
 * so switching between fullscreen / normal mode (which replaces the renderer
 * wholesale) still reaches the right tree.
 *
 * The rules (goal: **exactly one** blank row between any two vertically adjacent
 * widgets, and none extra when isolated):
 *   - the sibling above's **last row has visible content** → something sits above →
 *     pad a leading blank row;
 *   - the sibling above itself ends in a blank row (with only one widget it is pi's
 *     own Spacer; with recap present it is recap's fixed trailing blank) → the gap
 *     already exists → no pad;
 *   - the sibling below's **first row has visible content** → the list sits above it
 *     → pad a trailing blank row;
 *   - a sibling renders no visible content at all (an empty widget) → nothing to
 *     separate → no pad;
 *   - cannot find the own container, or a sibling lacks `render` (pi changed
 *     internals) → never pad: better to miss a blank row than invent one. When a
 *     sibling's `render` throws, the opposite applies — treat as "has content" and
 *     pad: it is a real widget in that case, and a missing gap is exactly the bug
 *     being fixed.
 *
 * This file **imports no pi / pi-tui module** (duck typing + one ANSI-strip regex
 * only), so `node --test` runs it directly — same approach as
 * `rewind/checkpoints.ts`.
 */

/** The two sides a blank row may be needed on. */
export interface WidgetGaps {
	above: boolean;
	below: boolean;
}

/** Only SGR color sequences appear in widget rows. */
const SGR = /\x1b\[[0-9;]*m/g;

const NO_GAPS: WidgetGaps = { above: false, below: false };
/** An edge that "renders no visible content". */
const EDGE_NOTHING = { visible: false, blank: false };
/** The fallback when rendering fails: treat as having content. */
const EDGE_UNKNOWN = { visible: true, blank: false };

interface EdgeInfo {
	visible: boolean;
	blank: boolean;
}

/** Has non-whitespace characters (ANSI color sequences are not content). */
function hasContent(line: string | undefined): boolean {
	return (line ?? "").replace(SGR, "").trim().length > 0;
}

/** Only a node whose `children` is an array counts as a container. */
function childrenOf(node: unknown): unknown[] | undefined {
	if (node === null || typeof node !== "object") return undefined;
	const children = (node as { children?: unknown }).children;
	return Array.isArray(children) ? children : undefined;
}

/**
 * Walk down from the TUI root to "the Container holding self", returning its
 * children.
 * Depth-first + `seen` dedupe: the tree has no cycles, but even one would not hang it.
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

/** Render the sibling's row **facing us** (`top` = its first row, `bottom` = its last). */
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
 * Compute the blank rows this component needs above/below this frame (see the file
 * header).
 *
 * @param root  the TUI handed to the widget factory (pi's renderer proxy)
 * @param self  this component itself (to locate its position in the container)
 * @param width the current render width, forwarded verbatim to the siblings — pi
 *              renders one container at one width
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
