/**
 * statusline — a minimal statusline (replacing npm:@narumitw/pi-statusline)
 *
 * Just one main row + one status row (pi-statusline's two-row structure kept), no
 * config file, no powerline blocks, no palette: every color goes through
 * `theme.fg(<semantic color>)`, so it automatically follows the current theme
 * (`theme` is pi's internal live-Proxy singleton — after a `/theme` switch the next
 * render already picks it up).
 *
 * The main row's shape:
 *
 *   ⚡️ qwen3.8-flash/xhigh | Ctx 0.0% | ᗌ main | (+0,-0)
 *   ⚡️ qwen3.8-flash/xhigh | Ctx 0.0% | ᗌ main | (+0,-0) | thinking   ← generating
 *   ⚡️ qwen3.8-flash/xhigh | Ctx 0.0% | ᗌ no git | (no git)          ← outside git
 *
 * The leading `⚡️` is the model segment's icon (`line.ts`'s `MODEL_ICON`, replacing
 * the earlier `Model:` text label — 4 columns saved; the emoji carries its own color
 * and gets none). The model segment itself is `ctx.model.id` + `ctx.thinkingLevel`
 * (a live getter) joined as `<id>/<reasoning level>` (just the id when the level is
 * unreadable). Deliberately no `[1m]`-style context-window suffix — that is a Claude
 * Code convention pi does not need.
 *
 * The line policy: truncate rather than wrap — every line goes through
 * `truncateToWidth(..., width, "…")`; a leading space is always kept, never
 * flush-left.
 *
 * Split into four modules: `line.ts` (pure formatting) + `git.ts` (reads the diff,
 * `exec` injected) + `footer-guard.ts` (freezes the footer across session swaps so
 * the default footer never flashes one frame) + this file (the pi event wiring).
 * The first three import no pi / pi-tui, so
 * `node --test clients/pi/extensions/statusline/*.test.ts` runs them directly.
 *
 * git reads always happen in the background (the render path only does one Map
 * lookup): `turn_end` / `agent_end` / `tool_execution_end` debounce a refresh at
 * 400ms, a branch change refreshes immediately, and a 30s polling fallback exists.
 *
 * On a session swap (`/new`, `/clear`, `/resume`, fork, rewind) pi first restores
 * the built-in footer and clears every `setStatus`; the new session's
 * `session_start` lets us reinstall — the tens of milliseconds in between really
 * emit frames, so the bottom visibly "flashes". This extension freezes that window
 * on the render path via `footer-guard.ts` (replaying the previous frame's rows);
 * the reasons and constraints are in that file's header. `PI_STATUSLINE_FREEZE=off`
 * turns it off.
 *
 * The startup stretch (process just up, `session_start` not yet delivered to us)
 * takes a different path: `footer-suppress.ts` replaces
 * `FooterComponent.prototype.render` inside the extension factory, returning 0 rows
 * — the built-in statusline never appears at all (reasons, timing, and fallbacks in
 * that file's header). `PI_STATUSLINE_BOOT_SUPPRESS=off` disables it.
 */

import { FooterComponent as PiFooterComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readGitDiffStat } from "./git.ts";
import { findRenderContainer, freezeFooterContainer, releaseFooterGuard } from "./footer-guard.ts";
import { suppressBuiltInFooter } from "./footer-suppress.ts";
import {
	STATUSLINE_KEY,
	ELLIPSIS,
	type StatuslineState,
	composeFooterLines,
} from "./line.ts";

const GIT_POLL_INTERVAL_MS = 30_000;
const GIT_DEBOUNCE_MS = 400;
const FROZEN_DISABLED = (process.env.PI_STATUSLINE_FREEZE ?? "").trim().toLowerCase() === "off";
const BOOT_SUPPRESS_DISABLED = (process.env.PI_STATUSLINE_BOOT_SUPPRESS ?? "").trim().toLowerCase() === "off";

/** The footer container wants this component object; only the render/dispose shape is needed, for identity checks in the guard. */
interface FooterComponent {
	render(width: number): string[];
	dispose(): void;
	invalidate(): void;
}

export default function statusline(pi: ExtensionAPI) {
	// the factory runs before the TUI exists, so the built-in footer can be muted right here: inside the window it renders 0 rows,
	// handed back once `installFooter` below mounts our component (see footer-suppress.ts).
	const releaseBuiltInFooter: (() => void) | undefined = BOOT_SUPPRESS_DISABLED
		? undefined
		: suppressBuiltInFooter(PiFooterComponent);
	let generation = 0;
	let activeTarget: { cwd: string; generation: number } | undefined;
	let requestRender: (() => void) | undefined;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let abortController: AbortController | undefined;
	let refreshInFlight = false;
	let refreshQueued = false;

	const state: StatuslineState = {
		streaming: false,
		activeTools: new Map<string, number>(),
		diffStat: undefined,
	};

	// the four things the freeze window needs: the TUI root (to find the container), the current footer component, its container, the last rendered rows.
	let tuiHandle: unknown;
	let footerComponent: FooterComponent | undefined;
	let footerContainer: unknown;
	let lastFooterLines: string[] | undefined;
	let guardRelease: (() => void) | undefined;

	const render = () => requestRender?.();

	const refreshDiffStat = async (target: { cwd: string; generation: number }) => {
		if (target !== activeTarget) return;
		if (refreshInFlight) {
			refreshQueued = true;
			return;
		}
		refreshInFlight = true;
		abortController?.abort(new DOMException("Statusline Git refresh replaced", "AbortError"));
		const controller = new AbortController();
		abortController = controller;
		try {
			const next = await readGitDiffStat(
				(command, args, options) => pi.exec(command, args, options),
				target.cwd,
				controller.signal,
			);
			if (target !== activeTarget || controller.signal.aborted) return;
			state.diffStat = next;
			render();
		} catch {
			if (target === activeTarget) {
				state.diffStat = undefined;
				render();
			}
		} finally {
			if (abortController === controller) abortController = undefined;
			refreshInFlight = false;
			if (refreshQueued && target === activeTarget) {
				refreshQueued = false;
				void refreshDiffStat(target);
			}
		}
	};

	const scheduleDiffRefresh = (delayMs: number) => {
		const target = activeTarget;
		if (!target) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		if (delayMs <= 0) {
			debounceTimer = undefined;
			void refreshDiffStat(target);
			return;
		}
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			void refreshDiffStat(target);
		}, delayMs);
	};

	const cancelDiffRefresh = () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}
		abortController?.abort(new DOMException("Statusline Git refresh cancelled", "AbortError"));
		refreshQueued = false;
	};

	const resetState = () => {
		state.streaming = false;
		state.activeTools.clear();
		state.diffStat = undefined;
	};

	const installFooter = (ctx: ExtensionContext) => {
		// release the previous swap window's freeze before installing the new footer: both steps in one sync block — no frame can slip between.
		guardRelease?.();
		guardRelease = undefined;
		cancelDiffRefresh();
		generation += 1;
		resetState();
		// print / rpc / json modes have no footer — don't waste git runs.
		activeTarget = ctx.mode === "tui" ? { cwd: ctx.cwd, generation } : undefined;
		ctx.ui.setStatus(STATUSLINE_KEY, undefined);
		if (!activeTarget) {
			requestRender = undefined;
			// print / rpc modes have no footer — nobody will install ours, so hand the built-in one back now.
			releaseBuiltInFooter?.();
			return;
		}
		const target = activeTarget;

		// hand the built-in footer back before mounting ours: both statements in one sync block — no frame can slip between.
		// placed before `setFooter` (not after) so a throw still does not leave the bottom empty.
		releaseBuiltInFooter?.();
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			tuiHandle = tui;
			const unsubscribeBranch = footerData.onBranchChange(() => {
				state.diffStat = undefined;
				tui.requestRender();
				scheduleDiffRefresh(0);
			});
			const clock = setInterval(() => scheduleDiffRefresh(0), GIT_POLL_INTERVAL_MS);

			const component: FooterComponent = {
				dispose() {
					unsubscribeBranch();
					clearInterval(clock);
					// only clear while this still belongs to the current session — an old footer's dispose must not wipe the new session's state.
					if (target === activeTarget) {
						activeTarget = undefined;
						state.diffStat = undefined;
						requestRender = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					// the truncate / indent / no-wrap rules live in line.ts, covered by unit tests.
					const lines = composeFooterLines(theme, ctx, footerData, state, width, truncateToWidth);
					// on a session swap the guard checks by identity whether we are still in the container; if not, these rows replay (see footer-guard.ts).
					lastFooterLines = lines;
					return lines;
				},
			};
			footerComponent = component;
			return component;
		});

		// the component is already mounted in the footer container (`setFooter` is synchronous) — identify that container by object identity;
		// the swap-window freeze needs it. Also release any takeover a previous extension instance left (`/reload` may leave one).
		footerContainer = findRenderContainer(tuiHandle, footerComponent);
		if (footerContainer) releaseFooterGuard(footerContainer);
		scheduleDiffRefresh(0);
	};

	/**
 * Pin the footer to its last frame inside the session-swap window: right after our
 * `session_shutdown` callback, pi restores the built-in footer and clears the
 * statuses — with the container's render taken over, the default footer never draws
 * a single frame.
 */
	const freezeFooter = () => {
		if (FROZEN_DISABLED || !footerContainer || !footerComponent) return;
		const component = footerComponent;
		const lines = lastFooterLines;
		guardRelease = freezeFooterContainer({
			container: footerContainer,
			ownComponent: component,
			frozenRender: (width) =>
				lines
					? lines.map((line) => truncateToWidth(line, width, ELLIPSIS))
					: component.render(width),
		});
	};

	const releaseFooter = (ctx: ExtensionContext) => {
		generation += 1;
		cancelDiffRefresh();
		activeTarget = undefined;
		resetState();
		requestRender = undefined;
		ctx.ui.setFooter(undefined);
		ctx.ui.setStatus(STATUSLINE_KEY, undefined);
		freezeFooter();
	};

	const bumpTool = (toolName: string, delta: number) => {
		const next = (state.activeTools.get(toolName) ?? 0) + delta;
		if (next <= 0) state.activeTools.delete(toolName);
		else state.activeTools.set(toolName, next);
	};

	pi.on("session_start", (_event, ctx) => {
		installFooter(ctx);
	});

	// resume / fork / rewind replace the session object — the footer must reinstall on the new ctx
	pi.on("session_tree", (_event, ctx) => {
		installFooter(ctx);
		render();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		releaseFooter(ctx);
	});

	pi.on("model_select", () => render());

	pi.on("thinking_level_select", () => render());

	pi.on("agent_start", () => {
		state.streaming = true;
		render();
	});

	pi.on("turn_start", () => {
		state.streaming = true;
		render();
	});

	pi.on("agent_end", () => {
		state.activeTools.clear();
		scheduleDiffRefresh(GIT_DEBOUNCE_MS);
		render();
	});

	// after agent_end pi may still auto-retry / compact / run queued messages — only settled means truly stopped
	pi.on("agent_settled", () => {
		state.streaming = false;
		state.activeTools.clear();
		render();
	});

	pi.on("turn_end", () => {
		scheduleDiffRefresh(GIT_DEBOUNCE_MS);
		render();
	});

	pi.on("tool_execution_start", (event) => {
		bumpTool(event.toolName, 1);
		render();
	});

	pi.on("tool_execution_end", (event) => {
		bumpTool(event.toolName, -1);
		scheduleDiffRefresh(GIT_DEBOUNCE_MS);
		render();
	});
}
