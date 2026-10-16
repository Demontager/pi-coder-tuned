/**
 * theme-command — the /theme command: list all themes, **live-preview** with the
 * arrow keys, Enter to persist, Esc to cancel.
 *
 * Why it exists: the built-in path is `/settings` → Theme — several levels deep
 * (and tangled with the light/dark auto mode). `/theme` is a one-step picker —
 * with preview.
 *
 * The core is that `ctx.ui.setTheme()`'s **two paths mean completely different
 * things** (interactive-mode.js's ExtensionUIContext + theme-controller.js):
 *   - a **Theme object** → `setThemeInstance()` → recolors in memory only,
 *     **does not write settings.json**;
 *   - a **name string** → `setThemeName()` → applies **and immediately writes
 *     settings.json** (settingsManager.save()).
 * So previewing must take the object path, and only Enter takes the name path —
 * settings.json stays untouched through an Esc cancel.
 *
 * The flow:
 *   - `/theme`            → opens the picker (SelectList + a swatch area); arrow
 *                         keys preview live
 *   - `/theme <name>`     → switches and persists directly (an unknown name
 *                         errors and lists the available themes)
 *   - non-TUI mode        → just a notice, no switching (in print/json mode
 *                         ctx.ui is noOpUIContext and setTheme always returns
 *                         {success:false} — no point failing silently)
 *
 * The two preview surfaces (inside one picker):
 *   1. **Whole-screen recolor**: setThemeInstance invalidates + repaints —
 *      transcript / editor / statusline all follow. That is the truest preview.
 *      The picker's own SelectList colors come from `getSelectListTheme()`, whose
 *      callback closes over pi's global theme proxy (shared via globalThis) — so
 *      the list itself recolors live too.
 *   2. **A swatch area**: five sample rows drawn with the candidate theme's own
 *      tokens (core colors / markdown / code+diff+tool / background blocks /
 *      thinking levels) — directly comparable even on a terminal too short to
 *      read whole-screen differences.
 *
 * Known tradeoffs (all deliberate — do not "optimize" them away):
 *   - Cancel restores the original theme via the **object path** too, not the
 *     name path. The name path would rewrite `theme: "light/dark"` (auto mode)
 *     or an unset value (terminal-detected) in settings.json to a fixed name —
 *     a side effect a cancel must not have. The cost: `setThemeInstance()` runs
 *     `stopThemeWatcher()` internally, so after a previewed-then-cancelled
 *     picker, theme-file hot-reload is dead for this process (restarting pi or
 *     confirming with Enter restores it — `setTheme(name)` starts the watcher
 *     again via enableWatcher).
 *   - Cancelling without ever previewing (open → straight Esc) → nothing
 *     happens: no theme change, no watcher change.
 *   - Swatch/title/border colors are **recomputed every render** (see LiveText)
 *     — never baked into a cache: tui.md's "Invalidation and Theme Changes"
 *     says baked ANSI strings do not update after a theme switch.
 *   - `DynamicBorder` needs an explicit color function inside jiti-loaded
 *     extensions (its no-arg default reads pi's own module-cache theme — the
 *     extension side may hold another cache).
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, truncateToWidth, type Component, type SelectItem } from "@earendil-works/pi-tui";

/** How many SelectList rows show at once (the swatch takes 5 — do not let the picker fill the screen) */
const MAX_VISIBLE = 8;

type PickerResult = { action: "apply"; name: string } | { action: "cancel"; previewed: boolean };

/**
 * The minimal component that recomputes its text rows every render.
 *
 * pi's `Text` caches its content (incl. ANSI); after a theme switch `invalidate()`
 * only clears the cache — it does not recolor, so pre-baked text keeps the old
 * theme's colors. This one caches nothing: every frame is rebuilt from the
 * current theme.
 */
class LiveText implements Component {
	constructor(private readonly build: (width: number) => string[]) {}

	render(width: number): string[] {
		return this.build(width);
	}

	invalidate(): void {
		// nothing cached — nothing to clear
	}
}

/** The swatch area: a few rows drawn with the candidate theme's own tokens, covering pi's most common coloring scenarios */
function swatchLines(theme: Theme, width: number): string[] {
	const row = (...parts: string[]) => truncateToWidth(`  ${parts.join("  ")}`, width);

	return [
		// core colors
		row(
			theme.fg("accent", "accent"),
			theme.fg("success", "success"),
			theme.fg("warning", "warning"),
			theme.fg("error", "error"),
			theme.fg("muted", "muted"),
			theme.fg("dim", "dim"),
		),
		// markdown
		row(
			theme.fg("mdHeading", "# Heading"),
			theme.fg("mdCode", "`code`"),
			`${theme.fg("mdLink", "[link]")}${theme.fg("mdLinkUrl", "(url)")}`,
			`${theme.fg("mdListBullet", "•")} item`,
			theme.fg("mdQuote", "> quote"),
		),
		// syntax highlight + diff + tool name
		row(
			`${theme.fg("syntaxKeyword", "function ")}${theme.fg("syntaxFunction", "name")}${theme.fg("syntaxPunctuation", "(")}${theme.fg("syntaxString", '"str"')}${theme.fg("syntaxPunctuation", ")")} ${theme.fg("syntaxComment", "// note")}`,
			theme.fg("toolDiffAdded", "+added"),
			theme.fg("toolDiffRemoved", "-removed"),
			theme.fg("toolTitle", "tool"),
		),
		// background blocks (the bg tokens are just these — all listed)
		row(
			theme.bg("userMessageBg", theme.fg("userMessageText", " user ")),
			theme.bg("toolPendingBg", theme.fg("muted", " pending ")),
			theme.bg("toolSuccessBg", theme.fg("toolOutput", " ok ")),
			theme.bg("toolErrorBg", theme.fg("error", " err ")),
			theme.bg("selectedBg", theme.fg("text", " selected ")),
		),
		// thinking levels (the editor border colors)
		row(
			theme.fg("thinkingOff", "off"),
			theme.fg("thinkingMinimal", "minimal"),
			theme.fg("thinkingLow", "low"),
			theme.fg("thinkingMedium", "medium"),
			theme.fg("thinkingHigh", "high"),
			theme.fg("thinkingXhigh", "xhigh"),
			theme.fg("thinkingMax", "max"),
		),
	];
}

/** Open the picker; returns the user's choice (undefined = the component could not open) */
async function pickTheme(ctx: ExtensionContext): Promise<PickerResult | undefined> {
	const themes = ctx.ui.getAllThemes();
	const currentName = ctx.ui.theme?.name;
	const items: SelectItem[] = themes.map((t) => ({
		value: t.name,
		label: t.name,
		description: t.name === currentName ? "(current)" : undefined,
	}));

	return ctx.ui.custom<PickerResult>((tui, theme, _keybindings, done) => {
		const container = new Container();

		// the preview state: which theme the swatch draws, and whether the global theme was actually touched (decides whether cancel restores)
		let previewTheme: Theme = ctx.ui.getTheme(currentName ?? "") ?? theme;
		let previewed = false;

		container.addChild(new DynamicBorder((s) => theme.fg("border", s)));
		container.addChild(
			new LiveText((width) => [
				truncateToWidth(
					`  ${theme.bold(theme.fg("accent", "Select theme"))}  ${theme.fg("dim", "↑↓ preview · enter apply · esc cancel")}`,
					width,
				),
			]),
		);

		const selectList = new SelectList(items, Math.min(items.length, MAX_VISIBLE), getSelectListTheme(), {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 32,
		});
		const currentIndex = themes.findIndex((t) => t.name === currentName);
		if (currentIndex !== -1) selectList.setSelectedIndex(currentIndex);

		selectList.onSelectionChange = (item) => {
			// the object path = in-memory preview — settings.json is not written
			const instance = ctx.ui.getTheme(item.value);
			if (!instance) return; // a listed name that failed to load: keep the current theme
			previewTheme = instance;
			previewed = true;
			ctx.ui.setTheme(instance);
			tui.requestRender();
		};
		selectList.onSelect = (item) => done({ action: "apply", name: item.value });
		selectList.onCancel = () => done({ action: "cancel", previewed });

		container.addChild(selectList);
		// one blank row between the theme list and the swatch below: both are multi-row blocks — flush together they have no visible boundary.
		container.addChild(new Spacer(1));
		container.addChild(new LiveText((width) => swatchLines(previewTheme, width)));
		container.addChild(
			new LiveText((width) => [
				truncateToWidth(`  ${theme.fg("dim", `Total: ${themes.length} themes · current: ${currentName ?? "unknown"}`)}`, width),
			]),
		);
		container.addChild(new DynamicBorder((s) => theme.fg("border", s)));

		// Container has no handleInput — keyboard is forwarded to the SelectList manually; mouse goes to Container's dispatch
		// (SelectList's own handleMouse: clicks trigger the same preview/select).
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
			handleMouse: (event) => container.handleMouse(event),
		};
	});
}

export default function (pi: ExtensionAPI) {
	// the theme-name cache for `/theme <TAB>`: getArgumentCompletions has no ctx — this is all it has.
	// session_start refreshes it on new / resume / fork; note a /reload clears the cache —
	// the next session_start or one manual /theme run repopulates it.
	let themeNames: string[] = [];

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		themeNames = ctx.ui.getAllThemes().map((t) => t.name);
	});

	pi.registerCommand("theme", {
		description: "Switch pi theme (live preview while browsing)",
		getArgumentCompletions: (prefix: string) => {
			// getArgumentCompletions only gets a prefix — no ctx, so no ctx.ui.getAllThemes();
			// use the names cached by session_start / the last call (see themeNames below).
			// an empty cache (e.g. right after /reload, before a new session) → null — hand to the built-in completer, never guess.
			const items = themeNames
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/theme requires interactive mode", "warning");
				return;
			}

			const themes = ctx.ui.getAllThemes();
			themeNames = themes.map((t) => t.name);
			if (themes.length === 0) {
				ctx.ui.notify("No themes available (was --no-themes used?)", "warning");
				return;
			}

			const arg = args.trim();
			if (arg) {
				// a direct switch: exact match first, case-insensitive fallback second
				const match = themes.find((t) => t.name === arg) ?? themes.find((t) => t.name.toLowerCase() === arg.toLowerCase());
				if (!match) {
					ctx.ui.notify(`Unknown theme "${arg}"; available: ${themes.map((t) => t.name).join(" / ")}`, "error");
					return;
				}
				applyTheme(ctx, match.name);
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify(`The picker requires TUI mode; use /theme <name>: ${themes.map((t) => t.name).join(" / ")}`, "warning");
				return;
			}

			const originalName = ctx.ui.theme?.name;
			const result = await pickTheme(ctx);
			if (!result) return;

			if (result.action === "cancel") {
				if (!result.previewed) return; // nothing previewed → nothing to restore
				// restore via the object path: settings.json was never written, so it stays untouched (the cost is in the file header)
				const restore = originalName ? ctx.ui.getTheme(originalName) : undefined;
				if (restore) ctx.ui.setTheme(restore);
				else ctx.ui.notify(`Cancelled, but could not restore the original theme (${originalName ?? "unknown"}); use /theme to select it again`, "warning");
				return;
			}

			applyTheme(ctx, result.name);
		},
	});
}

/** The name path = apply + write settings.json (the only path that persists) */
function applyTheme(ctx: ExtensionContext, name: string): void {
	const result = ctx.ui.setTheme(name);
	if (!result.success) {
		ctx.ui.notify(`Switch to ${name} failed: ${result.error}`, "error");
		return;
	}
	ctx.ui.notify(`Switched to ${name}`, "info");
}
