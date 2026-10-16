/**
 * below-editor-after-statusline — move the "below editor" extension widgets
 * **below** the statusline.
 *
 * The problem it solves: pi-subagents's fleet status row (`1 active agent · ↓
 * 2.7k window · ↓/← to inspect`, widget key `subagent-fleet-status` — see its
 * `src/tui/fleet-status.ts`) registers with `placement: "belowEditor"`, and
 * pi's mount order is
 *
 *     [document, pendingMessages, status, widgetContainerAbove,
 *      editor, widgetContainerBelow, footer]
 *
 * (`interactive-mode.js`'s `mountInteractiveTui`) — so that hint row shows up
 * **between the input box and the statusline**, pushing the statusline to the
 * very bottom of the screen. The row is **status information**, not part of the
 * input area — visually it belongs under the statusline, keeping "input box →
 * statusline" adjacent.
 *
 * Why only structure can fix it: pi-subagents's `fleetViewPlacement` accepts
 * only `aboveEditor` / `belowEditor` (`shared/types.ts`'s
 * `FleetViewPlacement`, default belowEditor), pi's `setWidget` offers the same
 * two spots, and no "below footer" placement exists; the footer itself (the
 * statusline rows) is owned by the local `extensions/statusline/` via
 * `ctx.ui.setFooter()` — an extension cannot take its rendered rows to join.
 *
 * The approach: pi-tui's `TUI` / `Container` expose `children` as a public
 * field, and `TuiBase.render()` concatenates each child's rows **in array
 * order** (`tui.js`) — so the "below-editor widget container" child just moves
 * to the array's end (after the footer container).
 *
 * How the right child is found — no index guessing: register a **probe widget**
 * first (`placement: belowEditor`, render returns [] so it is invisible), get
 * the TUI inside the widget factory, then walk `children` for the top-level
 * child whose subtree holds the probe — that is the below-editor widget
 * container; move it to the end, then remove the probe. Both registration and
 * removal happen within one tick (`setWidget` only `requestRender()`s — no
 * frame is emitted), so nothing flashes on screen. Whatever already lives in
 * that below container (the fleet row) moves along verbatim.
 *
 * The order holds: pi only calls `mountInteractiveTui` at init and on TUI-mode
 * switches, and `switchTuiMode` re-mounts `[...previousUi.children]` verbatim
 * (the order is copied) — one move is enough; `/reload`'s `session_start` runs
 * it again, equally idempotent (already last → early return).
 *
 * Deliberately not done:
 *   - no pi-subagents file is touched (an npm package — lost on upgrade), nor
 *     pi itself;
 *   - fullscreen (`--tui-mode fullscreen`) uses pi's own viewport layout tree
 *     (`createChatViewport` + `setLayoutRoot`), whose order that tree decides —
 *     this extension **does not guarantee** fullscreen behavior; this machine's
 *     `settings.json` has `tuiMode: "regular"` (the layout above is the
 *     measured one), and fullscreen's worst case is just "the hint row sits
 *     above the statusline again";
 *   - when the child cannot be found (pi changed its mount structure) **do
 *     nothing** — no throw, no index guessing: the layout stays as it was
 *     rather than misplaced; should `tui.children` turn read-only (`splice` /
 *     `push` throwing TypeError), likewise just "not moved".
 *
 * Env var:
 *   PI_BELOW_EDITOR_AFTER_STATUSLINE=off   disable this extension at startup
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The probe widget's key (exists only briefly inside this call). */
const PROBE_KEY = "below-editor-order-probe";

const DISABLED = (process.env.PI_BELOW_EDITOR_AFTER_STATUSLINE ?? "").trim().toLowerCase() === "off";

/** Whether the subtree holds this component — by object identity, not shape (identically-shaped components are everywhere). */
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
			// the probe must declare belowEditor explicitly — the default-position container above is not the one to move,
			// and mistaking it would drag the whole above-editor widget area (task list / recap) under the footer.
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
			// no UI / a dead ctx: do nothing.
			return;
		}

		try {
			const children = (tui as { children?: unknown } | undefined)?.children;
			if (!Array.isArray(children)) return;
			const index = children.findIndex((child) => containsComponent(child, probe));
			// not found (pi changed internals) or already last (after the footer) → leave it.
			if (index < 0 || index >= children.length - 1) return;
			// a turned-read-only array (splice throwing TypeError) likewise counts as "not moved":
			// the layout falls back to the old order — never leak an exception into an extension error.
			try {
				const [container] = children.splice(index, 1);
				children.push(container);
			} catch {
				// read-only / a weird proxy: keep the old order.
			}
		} finally {
			try {
				ctx.ui.setWidget(PROBE_KEY, undefined);
			} catch {
				// stale ctx: the probe dies with the session — the completed reorder is unaffected.
			}
		}
	}

	// at init the TUI mounts first and session_start is emitted after (`InteractiveMode.init` →
	// `bindCurrentSessionExtensions`), so the mounted component tree is always available here.
	// resume / fork / /reload all trigger it — repeat runs are idempotent.
	pi.on("session_start", async (_event, ctx) => moveBelowEditorWidgetsLast(ctx));
}
