/**
 * user-message-bar — pure logic: a vertical bar at the start of every
 * user-message row
 *
 * The user message box is already a `Box(paddingX = outputPad, paddingY = 1)` +
 * a `userMessageBg` background, with one blank padding row above and below. This
 * extension puts a bar at the start of **every row** (incl. the two blank rows)
 * plus one more space before the text:
 *
 *     ▎
 *     ▎ message text
 *     ▎
 *
 * The bar occupies **the left padding column that already exists**: the row's
 * first space is replaced by `▎`; the extra column before the text (`BAR_INDENT`)
 * is eaten equally from the **trailing padding** — so the background, the row
 * width, and the wrap positions are exactly the same as before.
 * Not one column may be cheated by "add a column and let the terminal clip it":
 * pi-tui's main-screen renderer **throws outright** on any row wider than the
 * terminal (`tui-main-screen.js` first dumps the whole screen into
 * `pi-tui-crash.log`, then throws `Rendered line N exceeds terminal width`) —
 * the whole TUI dies.
 *
 * The trailing padding always has enough room: at `paddingX = 1` the Box gives
 * its child `width - 2` columns, so one column always remains. At `outputPad =
 * 0` (a pi setting) there is no left padding to occupy — the bar plus the indent
 * (two columns) must both be borrowed from the tail; if only one is borrowable,
 * the bar is kept (the extra space is dropped), and when not even one is
 * borrowable the row is left untouched (rather draw less than overflow).
 *
 * The color is the skin's **`accent`** — the skin's "emphasis / positive"
 * bright color.
 * It is a **foreground** slot — `getFgAnsi` used directly; another slot (incl. a
 * background slot like `selectedBg`, which gets a 48→38 equivalent conversion
 * into a foreground) is selectable via `PI_USER_MESSAGE_BAR_COLOR=<skin slot
 * name>`. The bar carries its own foreground reset, so the space after it is
 * not tinted.
 *
 * The bar cell **follows the message background** (not cut out): the Box wraps
 * the whole row in `theme.bg("userMessageBg", …)` — the bar sits inside it and
 * the glyph merges with the background block. An earlier version inserted a
 * `49m` before the bar and restored it after, leaving the cell bare — the
 * background block's left edge ended up with a notch, which measured worse
 * (reverted — do not bring it back).
 *
 * Why a prototype patch is unavoidable: the only extension API touching user
 * messages is `registerMarkdownTransformer`, which is **string-level** — it only
 * sees the body source, not the Box's blank rows or left padding — precisely
 * where the bar needs to go. So `UserMessageComponent.prototype.render` is the
 * takeover point.
 *
 * Why the patch lands (cross-module): the `pi` command runs
 * `dist/bundle/cli.js`, and under the bundle / compiled-binary form the
 * extension loader resolves `@earendil-works/pi-coding-agent` to the loader's
 * **own bundle namespace** (`core/extensions/loader.js`'s `virtualModules`
 * branch) — the very class pi renders with.
 * `index.test.ts` asserts exactly this end-to-end chain (rendering pi's own
 * exported `UserMessageComponent`).
 *
 * This module imports no pi / pi-tui: the color source and the component class
 * are injected by the caller — `node --test` runs it directly.
 */

/** The bar glyph: `▎` (U+258E). */
export const BAR_GLYPH = "\u258E";

/** The half-width columns of space between the bar and the text (so the text indents two columns past the bar). */
export const BAR_INDENT = 1;

/** The default color slot: the skin's accent (`accent`, see the file header). */
export const DEFAULT_COLOR_NAME = "accent";

/**
 * The fallback order when the preferred slot does not resolve (a skin may not
 * define `accent` — especially old ones):
 * accent → selected → diff-addition gutter color → body text.
 */
const FALLBACK_COLOR_NAMES = ["selectedBg", "toolDiffAdded", "text"];

const ESC = "\u001b";
const BEL = "\u0007";

/**
 * Zero-width (column-free) sequences: pi's Box opens each row with `\x1b[48;…m`
 * and closes with `\x1b[49m`; a restored session's first row also carries an OSC
 * 133 shell-integration zone marker; the other two are terminal charset
 * switching and keyboard modes — defensive coverage.
 */
const ANSI_PART = [
	`${ESC}\\[[0-9;:?]*[ -/]*[@-~]`, // CSI (SGR colors, cursor moves)
	`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, // OSC (OSC 133 zone markers), BEL- or ST-terminated
	`${ESC}[()][0-9A-Za-z]`, // charset switching
	`${ESC}[=>]`, // keypad modes
].join("|");

const LEADING_ANSI = new RegExp(`^(?:${ANSI_PART})*`);
const ONLY_ANSI = new RegExp(`^(?:${ANSI_PART})*$`);

/**
 * Add the bar to one row: the eaten left-padding space becomes the bar, `indent`
 * spaces go before the text, and the freed columns are eaten equally from the
 * trailing padding — the row's visible width is identical to before.
 *
 * The bar **does not cut out the background**: it sits directly inside the
 * Box's `userMessageBg` (pi's Box wraps the whole row in
 * `theme.bg("userMessageBg", …)`), so that cell merges with the message's
 * background block — only a glyph appears at the left edge. An earlier version
 * inserted `49m` before the bar and restored it after; the background block's
 * left edge got a notch — worse (reverted).
 *
 * Four edge cases (never overflow — worst case the row simply has no bar):
 *   - at `outputPad = 0` (a pi setting) the row starts with text — that padding
 *     column does not exist, so even the bar itself must borrow a column from
 *     the trailing padding; it is inserted before the text.
 *   - when the trailing padding cannot spare `indent` columns → degrade to
 *     "bar only, no extra space".
 *   - when the tail cannot spare even the bar's column (text fills the row
 *     exactly) → return verbatim.
 */
export function addBarToLine(line: string, bar: string, indent: number = BAR_INDENT): string {
	const head = LEADING_ANSI.exec(line)?.[0] ?? "";
	const rest = line.slice(head.length);

	// the Box's left padding (0 / 1 columns): if present, this cell is the bar's landing spot
	const pad = rest.startsWith(" ") ? 1 : 0;
	const body = pad === 1 ? rest.slice(1) : rest;

	const padding = trailingSpaceRun(body);
	const spare = padding ? padding.end - padding.start : 0;
	const neededByBar = 1 - pad; // how many columns the bar itself must borrow from the tail
	if (spare < neededByBar) return line;

	const used = Math.min(indent, spare - neededByBar);
	const dropped = neededByBar + used;
	const trimmed = padding ? body.slice(0, padding.end - dropped) + body.slice(padding.end) : body;

	return `${head}${bar}${" ".repeat(used)}${trimmed}`;
}

/**
 * The index range of the trailing "pure-space padding" (relative to the whole
 * row); undefined when absent. The rule requires only **zero-width sequences**
 * (`\x1b[49m` etc.) after the spaces — otherwise they are spaces inside the
 * text, and touching them would eat real characters.
 */
function trailingSpaceRun(line: string): { start: number; end: number } | undefined {
	const last = line.lastIndexOf(" ");
	if (last < 0) return undefined;
	if (!ONLY_ANSI.test(line.slice(last + 1))) return undefined;
	let start = last;
	while (start > 0 && line[start - 1] === " ") start -= 1;
	return { start, end: last + 1 };
}

/** The color source: pi's `Theme` instance (only these two methods used — injected, so this module decouples from pi). */
export interface ThemeColorSource {
	getFgAnsi(color: string): string;
	getBgAnsi(color: string): string;
}

/**
 * Resolve the bar's foreground ANSI (glyph not included). A skin lacking even
 * the fallback slots → `undefined` — the caller skips the bar rather than
 * throwing.
 *
 * The slot may be a foreground slot (`toolDiffAdded` / `accent`) or a
 * **background** slot (`selectedBg`): `Theme.fg()` only knows foreground
 * slots — a background slot name throws `Unknown theme color` — so a background
 * slot gets a 38/48 equivalent conversion here (`bgAnsi` and `fgAnsi` are
 * identical apart from that one digit, in truecolor and 256-color alike): the
 * converted foreground is exactly that background color.
 */
export function resolveBarAnsi(
	source: ThemeColorSource | undefined,
	preferred: string = DEFAULT_COLOR_NAME,
): string | undefined {
	if (!source) return undefined;
	for (const name of [preferred, ...FALLBACK_COLOR_NAMES]) {
		const ansi = colorAnsi(source, name);
		if (ansi) return ansi;
	}
	return undefined;
}

/** A slot name → foreground ANSI: try as fg first, then as bg (a background slot converted to foreground). */
function colorAnsi(source: ThemeColorSource, name: string): string | undefined {
	try {
		const fg = source.getFgAnsi(name);
		if (fg.startsWith("\u001b[38;")) return fg;
	} catch {
		// not a foreground slot of this skin: try the background slots
	}
	try {
		const bg = source.getBgAnsi(name);
		if (bg.startsWith("\u001b[48;")) return bg.replace("\u001b[48;", "\u001b[38;");
	} catch {
		// not a background slot either
	}
	return undefined;
}

/**
 * The patch state on the prototype. `Symbol.for` uses the global registry —
 * after a `/reload` (module re-eval) the prototype is still recognizable as
 * already wrapped. The state lives on the prototype, not the module scope, so a
 * reloaded instance **updates the color source** rather than wrapping a second
 * layer (the old ctx may be dead — the source must be swapped for the new one).
 */
const PATCH_KEY = Symbol.for("pi-user-message-bar.state");

interface BarState {
	theme: () => ThemeColorSource | undefined;
	colorName: string;
	barAnsi: () => string | undefined;
}

export interface UserMessageBarOptions {
	/** pi's `UserMessageComponent` class (what the extension imports is the very class pi renders with — see the file header). */
	UserMessageComponent: { prototype: Record<string | symbol, unknown> };
	/** The current skin's Theme, evaluated per render — `ctx.ui.theme` is a live Proxy across `/theme` switches. */
	theme: () => ThemeColorSource | undefined;
	/** The color slot name — default `accent` (the skin's accent color). */
	colorName?: string;
	/** The glyph — default `▎` (U+258E). */
	glyph?: string;
}

/**
 * Install the "bar at user-message row start" patch. Returns **whether this
 * call really installed**: after `/reload` it is `false` (the patch already
 * exists — only the color source was swapped); an unrecognized prototype shape
 * (no `render`) is also `false` and does nothing —
 * never guess, never throw; better the feature just not engage.
 */
export function installUserMessageBar(options: UserMessageBarOptions): boolean {
	const prototype = options.UserMessageComponent.prototype;
	const existing = prototype[PATCH_KEY] as BarState | undefined;
	if (existing) {
		existing.theme = options.theme;
		if (options.colorName !== undefined) existing.colorName = options.colorName;
		return false;
	}

	const original = prototype.render;
	if (typeof original !== "function") return false;

	const glyph = options.glyph ?? BAR_GLYPH;
	const state: BarState = {
		theme: options.theme,
		colorName: options.colorName ?? DEFAULT_COLOR_NAME,
		barAnsi: () => undefined,
	};
	state.barAnsi = () => {
		const ansi = resolveBarAnsi(state.theme(), state.colorName);
		// a foreground reset follows the glyph (same shape as theme.fg()): the bar must not bleed color into the padding
		return ansi === undefined ? undefined : `${ansi}${glyph}\u001b[39m`;
	};

	prototype[PATCH_KEY] = state;
	prototype.render = function (this: unknown, ...args: unknown[]): string[] {
		const lines = (original as (...args: unknown[]) => string[]).apply(this, args);
		if (!Array.isArray(lines) || lines.length === 0) return lines;
		const bar = state.barAnsi();
		if (!bar) return lines;
		return lines.map((line) => addBarToLine(line, bar));
	};
	return true;
}
