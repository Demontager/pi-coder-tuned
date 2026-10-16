/**
 * startup-logo — show a static pi logo on top at startup, and prune three useless
 * sections from the startup listing
 *
 * pi's built-in header (`interactive-mode.js`) is only `pi vX.Y.Z` plus a few
 * shortcut hints — no graphic. This extension replaces it via
 * `ctx.ui.setHeader()`: a static pi.dev mark on top (glyph data shaped after
 * `npm:pi-claude-code-tui` but **without installing that package** — reasons in
 * `logo.ts` and the README), the version and the current directory (shown as
 * `~/...` under home) on the right, and the same compact shortcut hints below —
 * so swapping the header loses no information.
 *
 * The logo is **always on**: no `/logo` toggle command (and no mention of one in
 * the hint line) — `PI_LOGO=off` is the only switch.
 *
 * **Static**: the upstream mark is a 22-frame animation (three strokes sliding in
 * + a base flashing twice before settling); this repo wants a static logo, so no
 * frame table, no timers, no `requestRender` — every render emits the same grid
 * with the color fetched via `theme.fg("accent")`, so a `/theme` switch is
 * followed on the very next frame. That also eliminates the "a timer outliving
 * the session crashes the host" class of bug (this repo hit it in `simple-task/`
 * and `working-indicator/`).
 *
 * The header appears above the chat area **at startup only** and scrolls out of
 * view; it is not a persistent control and takes no editor space.
 *
 * The "loaded resources" listing under the header is likewise filled only after
 * session binding; its `[Context]` / `[Prompts]` / `[Themes]` sections carry no
 * information, so this extension prunes them (`loaded-sections.ts`): the pruner
 * finds its container via **the mounted header component**, so it only acts while
 * the logo is installed — `[Skills]` / `[Extensions]` and every diagnostic
 * section stay.
 *
 * Three remaining constraints:
 *   1. Only installs in TUI mode (`ctx.mode === "tui"`) — print / RPC / JSON modes
 *      have no header.
 *   2. On a session swap (`/new`, `/clear`, `/resume`, fork, rewind) pi first
 *      `resetExtensionUI()`s the header back to the built-in one and the new
 *      session's `session_start` reinstalls ours — the tens of milliseconds
 *      between really emit frames, so the top "flashes" back to the built-in
 *      header and jumps layout. `header-guard.ts` freezes that window on the
 *      render path (replaying the previous frame) — same mechanism as
 *      statusline's footer freeze, each keeping its own copy, independent.
 *   3. A too-narrow terminal (no room beside the mark) degrades to a single
 *      wordmark row — no wrapping.
 *
 * The switch: `PI_LOGO=off` → nothing installed at startup (no config file, no
 * side effects; the startup listing then stays pi's, since the pruner needs the
 * mounted header component to find its container).
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, keyText, rawKeyHint, VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import {
	MARK_CELL,
	MARK_INDENT,
	MARK_WIDTH,
	attachSideText,
	composeHeaderLines,
	markLines,
	shortenPath,
} from "./logo.ts";
import { findRenderContainer, freezeHeaderContainer, releaseHeaderGuard } from "./header-guard.ts";
import { hideLoadedSections } from "./loaded-sections.ts";

const LOGO_DISABLED = (process.env.PI_LOGO ?? "").trim().toLowerCase() === "off";
/** The logo is always on (no in-session toggle — `/logo` was removed per user request). */
const ENABLED = !LOGO_DISABLED;
/** The narrow-terminal threshold: at least this many columns must remain right of the mark for it to draw. */
const MIN_SIDE_COLUMNS = 20;
const SIDE_GAP = 2;
const ELLIPSIS = "…";

/** The header container wants this component object; only the render/invalidate shape is needed, for identity checks in the guard. */
interface HeaderComponent {
	render(width: number): string[];
	invalidate(): void;
}

export default function startupLogo(pi: ExtensionAPI) {
	// the four things the freeze window needs: the TUI root (to find the container), the current header component, its container, the last rendered rows.
	let tuiHandle: unknown;
	let headerComponent: HeaderComponent | undefined;
	let headerContainer: unknown;
	let lastLines: string[] | undefined;
	let guardRelease: (() => void) | undefined;

	let home: string | undefined;
	const homeDir = (): string | undefined => {
		if (home === undefined) {
			try {
				home = homedir();
			} catch {
				home = "";
			}
		}
		return home || undefined;
	};

	/**
 * The compact hint line with the built-in header's key bindings.
 *
 * Deliberately wrapped in try/catch: this repo already hit "the
 * `@earendil-works/pi-coding-agent` copy an extension imports is not the same
 * singleton as pi's runtime — `keyHint` throws `Theme not initialized`,
 * `keyText` returns """ in `bash-command-collapse.ts` (which had to rebuild from
 * keybindings.json itself).
 * Measured on 0.85.1 + a pnpm layout this gets the same copy — key names and
 * colors work (see the README's measured notes), so pi's helper is used; should a
 * future setup hand a different copy, at worst the hint line is missing — the
 * whole header must not die (a render throw is reported by pi as an extension
 * error).
 */
	const buildHints = (theme: Theme): string | undefined => {
		try {
			return [
				keyHint("app.interrupt", "interrupt"),
				rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
				rawKeyHint("/", "commands"),
				rawKeyHint("!", "bash"),
			].join(theme.fg("muted", " · "));
		} catch {
			return undefined;
		}
	};

	/** A frame's full rows: the mark → the hint line → the tagline. */
	const buildLines = (theme: Theme, cwd: string, width: number): string[] => {
		const wordmark = theme.bold(theme.fg("accent", "pi")) + theme.fg("dim", ` v${VERSION}`);
		const where = theme.fg("muted", shortenPath(cwd, homeDir()));
		const hints = buildHints(theme);
		const onboarding = theme.fg("dim", "Pi can explain its own features and look up its docs.");

		// narrow terminal: no mark — degrade to a single wordmark row (same one-space indent, aligned with the mark's left edge).
		if (width < MARK_WIDTH + MIN_SIDE_COLUMNS) {
			const room = Math.max(1, width - MARK_INDENT.length);
			return composeHeaderLines({
				logo: [`${MARK_INDENT}${truncateToWidth(wordmark, room, ELLIPSIS)}`],
				hints,
				onboarding,
			});
		}
		const sideRoom = Math.max(0, width - MARK_WIDTH - SIDE_GAP);
		// color per cell (wrapping the whole row would break the trailing trimEnd — see logo.ts's markLines)
		const logo = attachSideText(
			markLines((filled) => (filled ? theme.fg("accent", MARK_CELL) : " ".repeat(MARK_CELL.length))),
			[wordmark, truncateToWidth(where, sideRoom, ELLIPSIS)],
			SIDE_GAP,
		);
		return composeHeaderLines({ logo, hints, onboarding });
	};

	const installHeader = (ctx: ExtensionContext) => {
		// release the previous swap window's freeze before installing the new header: both steps in one sync block — no frame can slip between.
		guardRelease?.();
		guardRelease = undefined;
		if (ctx.mode !== "tui" || !ENABLED) return;

		let component: HeaderComponent | undefined;
		ctx.ui.setHeader((tui, theme) => {
			tuiHandle = tui;
			const own: HeaderComponent = {
				invalidate() {},
				render(width: number): string[] {
					const lines = buildLines(theme, ctx.cwd, Math.max(1, width));
					// on a session swap the guard checks by identity whether we are still in the container; if not, these rows replay (see header-guard.ts).
					lastLines = lines;
					return lines;
				},
			};
			component = own;
			return own;
		});

		// the component is already mounted in the header container (`setHeader` is synchronous) — identify that container by object identity;
		// the swap-window freeze needs it. Also release any takeover a previous extension instance left (`/reload` may leave one).
		if (!component) return;
		headerComponent = component;
		headerContainer = findRenderContainer(tuiHandle, component);
		if (!headerContainer) return;
		releaseHeaderGuard(headerContainer);
		// the loaded-resources listing sits in the sibling container right after the header container, and pi has not filled it yet (this callback runs
		// before `showLoadedResources`) — taking over its addChild here drops those three sections wholesale.
		hideLoadedSections({ root: tuiHandle, headerContainer });
	};

	/** Pin the header to its last frame inside the session-swap window: the built-in header never draws once. */
	const freezeHeader = () => {
		if (!headerContainer || !headerComponent) return;
		const component = headerComponent;
		const lines = lastLines;
		guardRelease = freezeHeaderContainer({
			container: headerContainer,
			ownComponent: component,
			frozenRender: (width) =>
				lines ? lines.map((line) => truncateToWidth(line, width, ELLIPSIS)) : component.render(width),
		});
	};

	pi.on("session_start", (_event, ctx) => {
		installHeader(ctx);
	});

	// resume / fork / rewind replace the session object — the header must reinstall on the new ctx.
	pi.on("session_tree", (_event, ctx) => {
		installHeader(ctx);
	});

	// resetExtensionUI runs after this callback: taking over the container's render first means restoring the built-in header emits no frame.
	pi.on("session_shutdown", () => {
		freezeHeader();
	});
}
