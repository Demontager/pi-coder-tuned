/**
 * codemode-tree — tree rendering for the codemode tool block (wiring)
 *
 * Reworks the look of pi's built-in `codemode` tool block into the same set as
 * `bash-command-collapse.ts` / `read-path-collapse.ts`: a tree with a `• ` head, `│ `
 * continuations, and a single `└ `, **no background fill and no boundary blank lines**.
 * Shape and column rules all live in `render.ts` (no pi import, `node --test` runs it
 * directly); this file only does three things: capture the built-in tool definition,
 * delegate to the built-in renderers, and reflow their lines into a tree.
 *
 * ## How we obtain codemode's **execution logic** (without copying it)
 *
 * `codemode` is a pi **built-in extension** (`builtin:codemode`), not a built-in tool — there
 * is no "definitions only" export like `createCodemodeToolDefinition()`
 * (`createCodemodeExtension` is the only entry, and it calls `createCodemodeToolDefinition`
 * internally). So we **capture** the definition it registers using that same factory: pass a
 * Proxy that intercepts only `registerTool` and forwards every other property to the real
 * `pi` (`getSettings` / `appendEntry` / `getAllTools` are all used inside the factory
 * closure, and must read live values **at call time** — e.g. `getMode()` reads
 * `pi.getSettings().codemode.mode` every turn). A Proxy instead of a hand-written stub: if
 * pi adds new `pi.*` calls to the factory later, nothing breaks from a missed forwarding,
 * and nothing throws at load time.
 *
 * Measured (real CLI, 2026-10-01): the captured definition's `parameters` **is the same
 * object reference** as pi's own (`===` holds). This is required — the MCP extension's
 * `isCodemodeTool()` recognizes "this is our package's codemode" precisely by schema
 * reference equality, and decides whether to auto-activate codemode tools on that; a
 * hand-rolled schema would silently break that auto-activation (leaving only the
 * `MCP tools are only reachable from the codemode or tool_search tool…` warning).
 *
 * ## The built-in is explicitly disabled in settings (user's decision, 2026-10-01)
 *
 * `codemode` is the kind of pi built-in extension that declares **`replaceable: true`**
 * (like `tool-search` / `mcp`): when another extension registers a same-named tool, pi skips
 * loading the built-in **entirely** and prints one warning at startup
 * (`registers tool `codemode`, so built-in extension `codemode` was not loaded`). That warning
 * is **expected**, not an error — it literally says "the built-in copy has stepped aside".
 * But pi renders it in **two places** at startup (the `[Extension issues]` block + the
 * `Warning: Extension package …` line), and there is no switch to turn it off (`quietStartup`
 * only affects the resource listing, not diagnostics).
 *
 * The user decided to put `extensions: ["-builtin:codemode"]` in settings.json (2026-10-01),
 * so the built-in simply never loads and both notices disappear (measured via SDK: warnings
 * drop to zero, codemode still provided by this extension). The cost: the
 * `PI_CODEMODE_TREE=off` fallback no longer works — when off, this extension registers
 * nothing while the built-in is disabled by settings, so the codemode tool **disappears
 * entirely** (previously "off" meant "the built-in takes over"). Restoring the built-in look
 * requires removing that settings entry first.
 *
 * ## The block shell: `renderShell: "self"` + self-drawn left margin
 *
 * `renderShell: "self"` makes pi stop wrapping the whole block in `contentBox`
 * (`Box(1, 1, bgFn)`), so ① **no background fill** (pending / success / failure all unpainted
 * — "not painted", not "painted then erased"), and ② **no boundary blank lines above and
 * below** — the same technique as the bash / read blocks (see the README, "two blocks share
 * one shell").
 *
 * The cost must be said plainly: pi's default shell uses `toolErrorBg` (red fill) to express
 * "this tool failed"; with the fill gone, that signal layer is gone — so **the dot must carry
 * the outcome**: white while executing (`text`) / green on success (`toolDiffAdded`, same
 * color as bash) / red on failure (`toolDiffRemoved`), plus the red `Script error:` lines in
 * the body.
 *
 * The left margin (first line `• `, remaining lines per `render.ts`'s rules) is drawn
 * entirely by this extension: in self mode, `ToolExecutionComponent` renders the
 * `selfRenderContainer` directly with **no padding at all**, so both renderers receive the
 * full width and must subtract 4 columns via `contentWidth()` before handing off to the child
 * components.
 *
 * ## The one thing that must be passed correctly when delegating to the built-in renderers
 *
 * Both built-in renderers follow the shape
 * `const component = context.lastComponent ?? new Container(); component.clear();` — the
 * `lastComponent` must be **the inner component they themselves returned last time**. Passing
 * our wrapper (which lacks `clear()` / `addChild()`) throws a `TypeError`, and
 * `updateDisplay()`'s try/catch **silently falls back** to the built-in fallback renderer:
 * it does not look broken, the shape just reverts to default. So the inner component is kept
 * in `context.state` and reused across calls (`read-path-collapse.ts` stepped in the same
 * pit).
 *
 * Turned off with `PI_CODEMODE_TREE=off` (read once at registration time; same convention as
 * `PI_FENCELESS_CODE` / `PI_READ_COLLAPSE`): when off, this extension does not register
 * `codemode`. Note: settings already contains `-builtin:codemode` (see above), so the
 * built-in will not step in, and the codemode tool disappears entirely — this env is now
 * purely an "off" switch, no longer a "restore the built-in look" switch.
 */

import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { contentWidth, shapeResultLines, stateDotSlot, withCallGutter } from "./render.ts";

/** A Proxy intercepting only `registerTool`: every other `pi.*` is forwarded to the real API (see the file header). */
function captureCodemodeDefinition(pi: ExtensionAPI): ToolDefinition<any, any, any> {
	let captured: ToolDefinition<any, any, any> | undefined;
	const capture = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (definition: ToolDefinition<any, any, any>) => {
					captured = definition;
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
	// Invoked exactly the way pi loads it built-in (no options = `models: true`; mode /
	// inlineBudget follow settings)
	createCodemodeExtension()(capture);
	if (!captured) {
		throw new Error("codemode-tree: could not capture the codemode tool definition from createCodemodeExtension()");
	}
	return captured;
}

/** Stitch the child components' rendered lines into a flat array (the built-in renderers return a `Container`). */
function childrenLines(component: any, width: number): string[] {
	const children: any[] | undefined = component?.children;
	if (!Array.isArray(children) || children.length === 0) {
		return typeof component?.render === "function" ? component.render(width) : [];
	}
	const lines: string[] = [];
	for (const child of children) {
		if (typeof child?.render === "function") lines.push(...child.render(width));
	}
	return lines;
}

/**
 * Cache the line array by **width + shape key**: `render(width)` runs every frame and
 * neither path is cheap (code highlighting / wrapping / the preview component). The key must
 * include "which indent set the command side uses" — `updateDisplay()` renders renderCall
 * then renderResult within one call, so the command line's `│ ` vs two-space indent switches
 * at the moment the result arrives; caching by width alone would pin that half-frame's shape.
 */
function createCachedComponent(render: (width: number) => string[], cacheKey: () => string, invalidateInner?: () => void) {
	let cachedWidth: number | undefined;
	let cachedKey: string | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			const key = cacheKey();
			if (cachedLines === undefined || cachedWidth !== width || cachedKey !== key) {
				cachedWidth = width;
				cachedKey = key;
				cachedLines = render(width);
			}
			return cachedLines;
		},
		invalidate() {
			cachedWidth = undefined;
			cachedKey = undefined;
			cachedLines = undefined;
			invalidateInner?.();
		},
	};
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_CODEMODE_TREE?.trim().toLowerCase() === "off") return;

	const base = captureCodemodeDefinition(pi);

	pi.registerTool({
		// Spread, not field-by-field copying: `execute` / `prepareLoadout` (the tool
		// description is generated live from callable tools via it) / `description` /
		// `parameters` / `promptSnippet` / `promptGuidelines` / `constrainedSampling` /
		// `exposure` / `defaultActive` are all inherited as-is — prompt metadata is not
		// auto-inherited; it must be carried explicitly.
		...base,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as { innerCall?: any; innerResult?: any };
			// The lastComponent handed to the built-in implementations must be the
			// **inner** component (see the file header)
			const inner =
				base.renderCall?.(args, theme, { ...context, lastComponent: state.innerCall }) ??
				({ render: () => [], invalidate() {} } as any);
			state.innerCall = inner;
			return createCachedComponent(
				(width) => {
					// Three dot states (user's decision, 2026-10-01): white while executing
					// (`text`) / green on success (`toolDiffAdded`, **same color as the bash
					// success dot**) / red on failure (`toolDiffRemoved`). Slot selection lives
					// in the pure logic (`stateDotSlot`).
					const dot = theme.fg(stateDotSlot(context.isPartial === true, context.isError === true), "•");
					const pipe = theme.fg("muted", "│ ");
					// "Is the tree connected" reads `state.innerResult`: `updateDisplay()`
					// runs renderCall first, then renderResult, but both components actually
					// `render()` in the container render afterwards — by then this frame's
					// innerResult is in place, so the command side and the result side switch
					// to `│ ` in **the same frame** (no half-frame mismatch, and no need to
					// set the flag early in renderResult the way bash does).
					const connected = state.innerResult !== undefined;
					return withCallGutter(inner.render(contentWidth(width)), dot, pipe, connected);
				},
				// The cache key must include "which state": the dot color and the
				// continuation prefix change with state; caching by width alone would pin the
				// previous frame's color / shape.
				() => `${state.innerResult === undefined ? "loose" : "connected"}:${stateDotSlot(context.isPartial === true, context.isError === true)}`,
				() => inner.invalidate?.(),
			);
		},
		renderResult(result, options, theme, context) {
			const state = context.state as { innerResult?: any };
			const inner =
				base.renderResult?.(result, options, theme, { ...context, lastComponent: state.innerResult }) ??
				({ render: () => [], invalidate() {} } as any);
			state.innerResult = inner;
			return createCachedComponent(
				(width) => shapeResultLines(childrenLines(inner, contentWidth(width)), theme),
				() => "result",
				() => inner.invalidate?.(),
			);
		},
	});
}
