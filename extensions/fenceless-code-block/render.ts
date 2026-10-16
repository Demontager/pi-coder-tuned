/**
 * fenceless-code-block — pure logic: drop the fences around Markdown code
 * blocks
 *
 * The fenceless look comes from `itc-steve/pi-theme` (npm
 * `@itc-steve/pi-theme`, MIT), but **only that half** is taken: upstream also
 * paints each row with `toolPendingBg` — this repo wants no background, so the
 * code body keeps pi's own `mdCodeBlock` foreground, and indent / padding
 * follow pi's old rules. Rewritten per this repo's habit: pi-tui's measure /
 * wrap functions are injected by the caller (this module imports no pi —
 * `node --test` runs it directly).
 *
 * The effect: the ` ``` ` open/close fences (incl. the `lang` tag) take no
 * rows; the code body lays out at pi's indent with syntax colors kept.
 * The row tail gets **no padding**: padding existed to stretch a background
 * across the width, and `Markdown.render()` pads every row to full width
 * anyway (the `lineWithMargins + " ".repeat(paddingNeeded)` branch) — padding
 * here too would be redundant.
 *
 * Why a prototype patch is required: the only Markdown-related extension API
 * is `registerMarkdownTransformer` — **string-level** (its result still goes
 * through the built-in renderer). The fences are literals the built-in
 * renderer concatenates itself (`markdown.js`'s `case "code"`:
 * `theme.codeBlockBorder("```" + lang)` and the closing `"```"`) — absent
 * from the source text, so string-level cannot remove them. Hence
 * `Markdown.prototype.renderToken`.
 *
 * Why the patch lands (cross-module instances — measured live on this
 * machine, do not reason from intuition):
 *   the `pi` command runs `dist/bundle/cli.js` (a bun bundle) with pi-tui
 *   **inlined** into the chunk — not the node_modules copy; a patch on the
 *   node_modules copy hits a different class and does nothing (measured:
 *   patching the external package's `Markdown.prototype`, pi's own
 *   `AssistantMessageComponent` still renders the same assistant message
 *   with fences). What really makes it land is the loader's virtualModules
 *   branch (`core/extensions/loader.js:421` — bundle / compiled binary goes
 *   `{ virtualModules: VIRTUAL_MODULES }`): the extension's
 *   `@earendil-works/pi-tui` import resolves to the loader's own bundle
 *   namespace — the very class pi renders with. `index.test.ts` asserts
 *   exactly this end-to-end chain.
 *
 * Every row must be ≤ width (incl. indent): `Markdown.render()` feeds
 * **every row** renderToken returns back through
 * `wrapTextWithAnsi(line, contentWidth)` — an over-wide row wraps a second
 * time, and the continuation has no indent, so the code block looks
 * misaligned. So wrapping happens here first; when the indent cannot fit
 * (wider than width itself) it is dropped, keeping at least 1 usable column.
 */

/** The patch marker: `Symbol.for` uses the global registry — after `/reload` (module re-eval) the prototype is still recognizable as wrapped. */
const PATCH_KEY = Symbol.for("pi-fenceless-code-block.patched");

/** Terminal column-width measure (pi-tui's `visibleWidth` injected). */
export type Measure = (text: string) => number;
/** Wrapping (pi-tui's `wrapTextWithAnsi` injected). */
export type Wrap = (text: string, width: number) => string[];

export interface CodeBlockRenderOptions {
	/** The language tag (the `js` in ` ```js `) — only handed to `highlight`. */
	lang?: string;
	/** The indent prefix: pi's `MarkdownTheme.codeBlockIndent` (the `markdown.codeBlockIndent` setting, two spaces by default). */
	indent?: string;
	/** The highlighter: pi's `MarkdownTheme.highlightCode`, returning one row per input row. */
	highlight?: (code: string, lang?: string) => string[];
	/** The fallback styling when `highlightCode` is absent — equivalent to the official renderer's else branch (`theme.codeBlock`). */
	fallbackStyle?: (text: string) => string;
	measure: Measure;
	wrap: Wrap;
}

/** Code body → rows ready for pi's render: no fences, indented, every row within width. */
export function renderCodeBlockLines(code: string, width: number, options: CodeBlockRenderOptions): string[] {
	const { measure, wrap } = options;
	const total = Math.max(1, width);
	const wanted = options.indent ?? DEFAULT_INDENT;
	// the indent could squeeze the usable width to 0 (an extremely narrow terminal): rather drop the indent than emit a row over width
	// (an over-wide row gets re-wrapped by Markdown.render() — an unindented continuation looks misaligned).
	const indent = measure(wanted) < total ? wanted : "";
	const inner = Math.max(1, total - measure(indent));

	const lines: string[] = [];
	for (const source of styleCode(code, options)) {
		// wrap may return [] for an empty string: an empty line still takes a row, or the code block collapses one in the middle.
		const pieces = wrap(source, inner);
		for (const piece of pieces.length > 0 ? pieces : [""]) lines.push(indent + piece);
	}
	return lines;
}

const DEFAULT_INDENT = "  ";

/**
 * The styling priority: use `highlight`'s output when it produces any; empty
 * output (an empty code block, a language the highlighter does not know)
 * falls back to plain text — the official renderer draws nothing at all in
 * that case, and the whole code block would vanish.
 */
function styleCode(code: string, options: CodeBlockRenderOptions): string[] {
	const highlighted = options.highlight?.(code, options.lang);
	if (highlighted && highlighted.length > 0) return highlighted;
	const plain = code.split("\n");
	return options.fallbackStyle ? plain.map(options.fallbackStyle) : plain;
}

/** The theme slice off a Markdown instance (a class's "private" fields are ordinary properties at runtime). */
interface MarkdownLike {
	theme?: {
		codeBlockIndent?: string;
		highlightCode?: (code: string, lang?: string) => string[];
		codeBlock?: (text: string) => string;
	};
}

type RenderToken = (
	this: MarkdownLike,
	token: unknown,
	width: number,
	nextType?: string,
	styleContext?: unknown,
) => string[];

export interface FencelessPatchOptions {
	/** pi-tui's `Markdown` class. What the extension imports is the very class pi renders with — see the file header. */
	Markdown: { prototype: Record<string | symbol, unknown> };
	measure: Measure;
	wrap: Wrap;
}

/**
 * Install the "drop code-block fences" patch. Returns **whether this call
 * really installed**: after `/reload` it is `false` (the patch already
 * exists); an unrecognized prototype shape (no `renderToken`) is also
 * `false` and does nothing — never guess, never throw; better the feature
 * just not engage.
 */
export function installFencelessCodeBlocks(options: FencelessPatchOptions): boolean {
	const prototype = options.Markdown.prototype;
	if (prototype[PATCH_KEY]) return false;

	const original = prototype.renderToken;
	if (typeof original !== "function") return false;
	prototype[PATCH_KEY] = true;

	const patched: RenderToken = function (this: MarkdownLike, token, width, nextType, styleContext) {
		const block = token as { type?: string; text?: string; lang?: string } | null | undefined;
		// only code blocks are taken over; every other token goes to the built-in renderer (incl. nested calls inside blockquote / list).
		if (block?.type !== "code") return original.call(this, token, width, nextType, styleContext);

		const theme = this?.theme ?? {};
		const lines = renderCodeBlockLines(block.text ?? "", width, {
			lang: block.lang,
			indent: theme.codeBlockIndent,
			highlight: theme.highlightCode?.bind(theme),
			fallbackStyle: theme.codeBlock?.bind(theme),
			measure: options.measure,
			wrap: options.wrap,
		});
		// same as the official renderer: when the next token is not a blank line, add one — or the code block hugs the next paragraph.
		if (nextType && nextType !== "space") lines.push("");
		return lines;
	};
	prototype.renderToken = patched;
	return true;
}
