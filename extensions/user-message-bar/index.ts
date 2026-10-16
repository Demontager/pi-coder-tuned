/**
 * user-message-bar — a vertical bar at the start of every user-message row (wiring)
 *
 * This file only wires things up: the patch goes on pi's
 * `UserMessageComponent.prototype.render`, and the color source comes from
 * `ctx.ui.theme`; all the logic lives in `bar.ts` (no pi imports — `node --test`
 * runs it directly).
 *
 * The patch is installed **at module-eval time** (the color source is still empty
 * then — `bar.ts` quietly draws no bar), so it is guaranteed to be in place before
 * the first render regardless of event order. At `session_start` the color source
 * is set to `ctx.ui.theme` — a live Proxy that survives `/theme` switches, so the
 * next frame follows.
 *
 * The color source must also be **dropped at the moment the session is replaced**
 * — or it takes the whole pi down (fixed 2026-09-20; `/clear` crashed it live). pi's
 * `teardownCurrent()` order is: emit `session_shutdown` → `resetExtensionUI()` →
 * `session.dispose()` (which runs `extensionRunner.invalidate()`) — from step
 * three on, **any** property read on the old ctx throws; the old messages are still
 * mounted on `chatContainer` (pi only clears them in the **next**
 * `rebindCurrentSession()`'s `renderCurrentSessionState()`), and the new ctx only
 * arrives at `session_start`. Multiple awaits sit between these steps, and pi-tui's
 * 16ms render throttle can easily land a tick inside them — an exception thrown in
 * a render tick is uncatchable and reaches pi's `uncaughtException`, exiting the
 * process (`/clear`, `/new`, `/resume`, `/fork`, `/reload` all take this path; a
 * resumed session's window is even longer — `renderInitialMessages()` runs before
 * bind).
 * So: at `session_shutdown` the color source resets to empty (that event always
 * precedes `invalidate()`), and reading the skin gets one more try/catch layer —
 * worst case a few frames draw no bar, and the next `session_start` restores it.
 *
 * `PI_USER_MESSAGE_BAR=off` disables it; `PI_USER_MESSAGE_BAR_COLOR=<skin slot
 * name>` picks the color (default `accent` — the skin's accent color; try
 * `selectedBg` for something darker).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";

import { DEFAULT_COLOR_NAME, installUserMessageBar, type ThemeColorSource } from "./bar.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_USER_MESSAGE_BAR === "off") return;
	const colorName = process.env.PI_USER_MESSAGE_BAR_COLOR?.trim() || DEFAULT_COLOR_NAME;
	const dropThemeSource = (): void => {
		installUserMessageBar({ UserMessageComponent, theme: () => undefined, colorName });
	};

	dropThemeSource();
	pi.on("session_start", (_event, ctx) => {
		installUserMessageBar({ UserMessageComponent, theme: () => liveTheme(ctx), colorName });
	});
	pi.on("session_shutdown", dropThemeSource);
}

/**
 * Read the current skin — **never throws**: after a session swap / reload pi
 * invalidates the old ctx, and reading `ctx.ui` throws `This extension ctx is
 * stale …`, and an exception inside a render tick is uncatchable — it takes the
 * whole pi down (see the file header).
 * An unreadable skin counts as "no skin this frame" (no bar drawn); the next
 * `session_start` fills it in.
 */
function liveTheme(ctx: ExtensionContext): ThemeColorSource | undefined {
	try {
		return ctx.ui.theme;
	} catch {
		return undefined;
	}
}
