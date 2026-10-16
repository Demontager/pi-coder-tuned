/**
 * web-search-tree — tree rendering for pi-web-access tool blocks (wiring)
 *
 * Reworks the three `pi-web-access` blocks into the same set as `bash-command-collapse.ts` /
 * `codemode-tree/` / `read-path-collapse.ts`: a tree with a `• ` head, `│ ` continuations,
 * and a single `└ `, **no background fill and no boundary blank lines** (the user's three
 * requirements, 2026-10-02). Shape and column rules all live in `render.ts` (no pi import,
 * `node --test` runs it directly); this file only does three things: capture the tool
 * definitions the package registers, delegate to the package's own renderers, and reflow
 * their lines into a tree.
 *
 * ## Which tools we take over (user's decision, 2026-10-02)
 *
 * | Tool | Package renderer | Handling |
 * | --- | --- | --- |
 * | `pi_web_search` | yes | **take over** (done in round one) |
 * | `fetch_content` | yes | **take over** |
 * | `get_search_content` | yes | **take over** |
 * | `source_check` | **no** (falls to pi's generic fallback) | register as-is |
 * | `web_enable` | **no** | register as-is |
 *
 * Only the three that ship renderers: like us they are "delegate to the package renderer +
 * reflow lines", a small surface to change with alignable style; `source_check` /
 * `web_enable` have no renderer, so taking them over means **drawing from scratch** (colors,
 * truncation, and expanded state would all need defining) — a separate project, kept out.
 *
 * ## How we obtain these tools' **execution logic** (without copying it)
 *
 * `pi-web-access` is a pi package (`npm:pi-web-access`). It has no "definitions only" export —
 * its default export is that `ExtensionFactory`, and the tool definitions live in the factory
 * closure, so the only way is to **capture**. The technique is exactly the one in
 * `codemode-tree/`: pass a Proxy that intercepts only `registerTool` and forwards every other
 * `pi.*` to the real `pi`.
 *
 * Two reasons a Proxy beats a hand-written stub:
 *   ① The factory closure uses plenty of `pi.*` (`getSettings` / `appendEntry` / `events` /
 *      `getAllTools` / `registerCommand` / `registerShortcut` / `on(...)`); missing one
 *      forwarding throws at **load time**, and a failed extension load silently just misses
 *      those tools.
 *   ② If pi adds new `pi.*` calls inside the factory later, nothing breaks (the Proxy forwards
 *      automatically).
 *
 * Measured (SDK, 2026-10-02): all 5 captured tool definitions share the **same object
 * references** for `execute` / `parameters` / `description` / `promptSnippet` as the package's
 * own — so routing, storage, curator, and the model-visible descriptions are all untouched;
 * this extension only swaps renderers.
 *
 * ## Why the package must be dropped from "auto-loaded extensions" (the settings filter)
 *
 * Capturing + re-registering inside the extension is not enough: the package itself also loads
 * **before** `~/.pi/agent/extensions/` and registers those 5 tools, so same-name registration
 * becomes a **conflict** — pi prints `Tool "pi_web_search" conflicts with …` into
 * `[Extension issues]` at startup (5 tools = 5 entries). And since `renderShell` /
 * `renderCall` are `ToolDefinition` fields, pi has **no** mechanism to "replace a registered
 * tool's renderer after the fact" — the only way to take over is same-name registration, and
 * that requires the package not auto-loading first.
 *
 * The switch is the **object form + empty-array filter** of `packages` in `settings.json`
 * (pi's official `docs/packages.md`, "Select package resources": `[]` = load none of that
 * type):
 *
 * ```json
 * "packages": [
 *   { "source": "npm:pi-web-access", "extensions": [] },
 *   "npm:pi-subagents",
 *   "git:github.com/jayli/superpowers"
 * ]
 * ```
 *
 * **The package itself stays listed in `packages`** — so `pi update --extensions` still offers
 * and performs its upgrade, the same technique as `-builtin:codemode`'s "disable the load unit
 * but not the package" (the user explicitly required on 2026-10-02: "upgrades still upgrade
 * normally"). After an upgrade this extension needs no changes: it captures the package's
 * definitions **for the running session**, so they follow the package; the renderers carry no
 * copied package logic whatsoever.
 *
 * Measured (SDK, 2026-10-02): with the filter in effect, `pi-web-access` no longer
 * auto-loads, this extension's 5 tools register as usual, and startup diagnostics show
 * **errors: [] / warnings: []** (contrast: without the filter, 5 conflict errors).
 *
 * ## Behavior when the package is absent (fail-soft; must not take pi down)
 *
 * When the package is not installed (new machine, or manually removed from `packages`), this
 * extension **registers nothing** — those tools simply do not exist, identical to the native
 * behavior of "package not installed". No exception is thrown: a load-time exception likewise
 * silently misses tools, and is even harder to diagnose.
 *
 * ## Resolving the package path (three candidates, in reliability order)
 *
 * ① The `PI_WEB_ACCESS_EXTENSION` environment variable (for tests and special layouts);
 * ② **bare specifier `import("pi-web-access")`** — extensions are loaded by jiti, whose
 *    resolution base is **the extension file's own directory**
 *    (`~/.pi/agent/extensions/web-search-tree/`), walking up to `~/.pi/agent/node_modules/`.
 *    When that location exists it is the first choice (it follows the package's install
 *    location instead of guessing). Measured absent on this machine, but kept — other layouts
 *    may hit it, and it is the most accurate when it does.
 * ③ `~/.pi/agent/npm/node_modules/pi-web-access/dist/index.js` (pi's npm install location;
 *    measured in a `node --test` environment: **can** be imported directly into ESM; not so
 *    when the readpath is a bin — see the notes in index.test.ts).
 *
 * **No `createRequire` approach**: in `.pnpm`'s hoisted layout `pi-web-access` exists only as
 * a symlink, and `require.resolve("pi-web-access")` measured throws `MODULE_NOT_FOUND` (it is
 * neither under `node_modules/.pnpm/node_modules` nor a dependency of this package) — the
 * three candidates already cover the two places it really lives, and another candidate would
 * only mislead.
 *
 * Turned off with `PI_WEB_SEARCH_TREE=off` (read once at registration time; same convention as
 * `PI_CODEMODE_TREE` / `PI_READ_COLLAPSE`). Note that when off, these tools **disappear
 * entirely** (the package is already filtered out by settings and this extension registers
 * nothing) — restoring the native look requires removing that settings filter first. This
 * cost is exactly the same shape as `codemode-tree`'s `PI_CODEMODE_TREE`, and is recorded in
 * the README alongside it.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
	colorizeErrorLines,
	contentWidth,
	isFailureResult,
	recolorSuccessToFailure,
	shapeResultLines,
	stateDotSlot,
	trimTrailingBlanks,
	withCallGutter,
} from "./render.ts";

/** Tool names we take over — all three ship renderers, so the rework is isomorphic to search (see the table in the file header). */
const MANAGED_TOOLS = new Set(["pi_web_search", "fetch_content", "get_search_content"]);

/** The extension entry inside the package's npm install location. */
function npmPackageEntry(): string {
	return join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-web-access", "dist", "index.js");
}

/**
 * Resolve pi-web-access's factory function (candidates in the file header). Returns undefined
 * when everything fails — the caller exits silently on that.
 *
 * The bare-specifier candidate is **deliberately placed before the absolute path**: only when
 * it hits is it "where the package is installed right now"; the absolute path is the fallback.
 */
async function resolvePackageFactory(): Promise<((pi: unknown) => unknown) | undefined> {
	const candidates: string[] = [];
	const override = process.env.PI_WEB_ACCESS_EXTENSION?.trim();
	if (override) candidates.push(override);
	candidates.push("pi-web-access");
	candidates.push(npmPackageEntry());

	for (const candidate of candidates) {
		try {
			const loaded = await import(candidate);
			const factory = (loaded as { default?: unknown }).default;
			if (typeof factory === "function") return factory as (pi: unknown) => unknown;
		} catch {
			// this candidate is unusable: try the next
		}
	}
	return undefined;
}

/**
 * **Capture** the tool definitions the package registers by running its own factory
 * (intercepting only `registerTool`; every other `pi.*` is forwarded to the real API).
 *
 * Note the package's factory is **async** (pi's `initializeExtension` does `await factory(...)`),
 * so this must await too — without waiting, the capture would be an empty set.
 */
async function capturePackageTools(pi: ExtensionAPI, factory: (pi: unknown) => unknown): Promise<ToolDefinition<any, any, any>[]> {
	const captured: ToolDefinition<any, any, any>[] = [];
	const capture = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (definition: ToolDefinition<any, any, any>) => {
					captured.push(definition);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
	await factory(capture);
	return captured;
}

/** The package renderer may return a `Container` (with children) or a single component — unify into a line array. */
function componentLines(component: any, width: number): string[] {
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

/** Extract the body lines (the model-visible copy) from a tool result — available synchronously, no width needed. */
function contentLines(result: { content?: unknown }): string[] {
	const blocks = Array.isArray(result.content) ? result.content : [];
	return blocks
		.filter((block): block is { type: string; text?: string } => !!block && typeof block === "object")
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.flatMap((block) => block.text!.split("\n"));
}

/**
 * Cache the line array by **width + shape key**: `render(width)` runs every frame, and neither
 * renderer is cheap (the package's `renderResult` assembles previews and scans content). The
 * key must include the state — the dot color and the command-line continuation prefix change
 * with state, and caching by width alone would pin the previous frame's shape (`codemode-tree`
 * stepped in the same pit).
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

/**
 * Give **one** taken-over tool definition the tree shell.
 *
 * All three tools share the same transformation (user's decision, 2026-10-02: only the three
 * with bundled renderers are covered, so this path holds for all of them) — the only
 * differences are the lines each package renderer produces; shape and columns are unified in
 * `render.ts`.
 */
function withTreeShell(target: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
	return {
		// Spread, not field-by-field copying: `execute` / `parameters` / `description` /
		// `promptSnippet` / `promptGuidelines` / `constrainedSampling` / `exposure` /
		// `defaultActive` / `annotations` are all inherited as-is (prompt metadata is not
		// auto-inherited; it must be carried explicitly).
		...target,
		// `renderShell: "self"`: makes pi stop wrapping in `contentBox` (`Box(1, 1, bgFn)`) — so
		// ① **no background fill** (pending / success / failure all unpainted), and ② **no
		// boundary blank lines above and below**. Same technique as the bash / read / codemode
		// blocks.
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as { innerCall?: any; innerResult?: any; failed?: boolean };
			// The `lastComponent` handed to the package renderers must be **their own previous
			// inner component**: the package's `renderResult` has `context.lastComponent ?? …`
			// reuse logic, and passing our wrapper (which lacks `clear()` / `addChild()`)
			// throws a `TypeError`, while pi's `updateDisplay()` **silently** falls back to the
			// fallback renderer — the shape quietly reverts to the default with no error at all.
			const inner =
				target.renderCall?.(args, theme, { ...context, lastComponent: state.innerCall }) ??
				({ render: () => [], invalidate: () => {} } as any);
			state.innerCall = inner;
			return createCachedComponent(
				(width) => {
					// The dot color reads `state.failed`, not `context.isError`: the package has
					// several failure paths that **return normally** with `details.error` set
					// (rather than throwing); pi does not flag those as isError, so keying on
					// `context.isError` alone would keep those paths showing a green dot forever.
					// `state.failed` is written by renderResult — `updateDisplay()` runs call
					// before result, but both components' `render()` only run after both, so it
					// is readable within the same frame (same timing as the `state.innerResult`
					// "is the tree connected" check below).
					const dot = theme.fg(stateDotSlot(context.isPartial === true, state.failed === true), "\u2022");
					const pipe = theme.fg("muted", "\u2502 ");
					const connected = state.innerResult !== undefined;
					return withCallGutter(componentLines(inner, contentWidth(width)), dot, pipe, connected);
				},
				() =>
					`${state.innerResult === undefined ? "loose" : "connected"}:${stateDotSlot(context.isPartial === true, state.failed === true)}`,
				() => inner.invalidate?.(),
			);
		},
		renderResult(result, options, theme, context) {
			const state = context.state as { innerResult?: any; failed?: boolean };
			// The failure verdict must be **computed synchronously here** (not pushed into the
			// lazy render closure below): `updateDisplay()` runs renderCall first, then this
			// function, while the container renders both components' `render()` **call first,
			// then result** — putting the verdict in the closure below means renderCall's dot
			// sees the previous frame's (unset) `state.failed`, so a failed block shows a green
			// dot (hit in practice). The verdict reads the raw `result` (body text / details /
			// isError), not the rendered lines, so it can be computed synchronously and needs
			// no width.
			const failed = isFailureResult(context.isError === true, contentLines(result), result.details);
			state.failed = failed;
			// The same `lastComponent` contract (see renderCall).
			const inner =
				target.renderResult?.(result, options, theme, { ...context, lastComponent: state.innerResult }) ??
				({ render: () => [], invalidate: () => {} } as any);
			state.innerResult = inner;
			return createCachedComponent(
				(width) => {
					const lines = trimTrailingBlanks(componentLines(inner, contentWidth(width)));
					if (!failed) return shapeResultLines(lines, theme);
					// On failure: ① the package's status line is unconditionally `success`
					// green (it does not know about this failure), so swap it to failure red —
					// otherwise you get the self-contradictory "red dot + green status line";
					// ② the `Error:` line is also dyed red.
					return shapeResultLines(recolorSuccessToFailure(colorizeErrorLines(lines, theme), theme), theme);
				},
				() => `result:${failed ? "err" : "ok"}:${options.expanded ? "expanded" : "collapsed"}`,
				() => inner.invalidate?.(),
			);
		},
	};
}

export default async function (pi: ExtensionAPI): Promise<void> {
	if (process.env.PI_WEB_SEARCH_TREE?.trim().toLowerCase() === "off") return;

	const factory = await resolvePackageFactory();
	if (!factory) {
		// Package absent: register nothing (see "Behavior when the package is absent" in the
		// file header). No exception — a load-time exception likewise silently misses tools,
		// only harder to diagnose.
		return;
	}
	const captured = await capturePackageTools(pi, factory);
	if (captured.length === 0) return;

	for (const definition of captured) {
		// The three with bundled renderers get the tree shell; the rest (source_check /
		// web_enable, no renderer) register as-is — "looks unchanged" is the scope the user
		// drew explicitly (see the table in the file header).
		pi.registerTool(MANAGED_TOOLS.has(definition.name) && definition.renderCall ? withTreeShell(definition) : definition);
	}
}
