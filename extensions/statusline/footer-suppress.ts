/**
 * footer-suppress.ts — "turning off" pi's built-in footer inside the startup window
 *
 * The problem it solves: pi's TUI startup order is `ui.start()` (the built-in
 * footer already mounted in the footer container) → `ensureTool("fd"/"rg")` →
 * `rebindCurrentSession()` → only then emit `session_start`
 * (`interactive-mode.js`'s `init()`). An extension gets a ctx — and can
 * `setFooter()` — only at that last step, and the Runner's `emit()` **serially
 * awaits** every extension's handler, so extensions sorted before `statusline`
 * (locally `mcp`, whose handshake connects to an MCP server) push it back further.
 * Measured cold start on this machine: the built-in footer drew its first frame
 * at ~480ms while our statusline installed at ~1.2s — the ~0.7s between shows
 * pi's default statusline (`~/path` + `0.0%/1.0M (auto) ... deepseek-flash •
 * max`), then the whole block swaps to `⚡️ ...`. The user sees a "first default,
 * then extension" flash.
 *
 * Why it can only be solved on the prototype: the earliest an extension can touch
 * the TUI is `session_start`; but an extension's **module eval / factory** runs
 * before the TUI is created (extensions load via `createAgentSessionServices` →
 * `resourceLoader.reload()`, InteractiveMode is new'd after). So inside the
 * factory, `FooterComponent.prototype.render` is replaced: inside the window the
 * built-in footer renders 0 rows (the bottom stays empty waiting for our
 * statusline) instead of painting a default statusline about to be replaced.
 *
 * Why the patch lands: under the bundle runtime, an extension resolving
 * `@earendil-works/pi-coding-agent` goes through the loader's `virtualModules`
 * (`dist/bundle/index.js`) — the same class objects (same chunk)
 * `interactive-mode.js` uses internally; the same premise as
 * `fenceless-code-block` patching `Markdown.prototype`. And if it misses, it only
 * degrades to the original behavior (the flash as before) — nothing breaks.
 *
 * Constraints:
 *   - only `prototype.render` is replaced — no instances touched, no pi internal
 *     state, no children;
 *   - idempotent and releasable: `/reload` re-evals the module — the new instance
 *     releases the previous takeover before applying its own;
 *   - `maxAgeMs` fallback: should our footer never install (an extension error,
 *     non-TUI mode), it auto-releases back to pi's default — the bottom never
 *     stays empty forever;
 *   - any throw anywhere counts as "not applied" — an exception never reaches the
 *     host.
 */

/** The takeover-record key hung on the footer prototype (global symbol registry: a `/reload`'d new instance can see the old one's). */
export const FOOTER_SUPPRESS_KEY: symbol = Symbol.for("litellm-any.pi-statusline.footerSuppress");

/**
 * The fallback duration: a normal `session_start` releases it far earlier — only a
 * failed handover reaches this.
 * 30s because we sort after other extensions — `Runner.emit()` awaits serially,
 * and `mcp` (alphabetically earlier) only yields to us once its whole handshake
 * finishes, and the handshake alone caps at 20s.
 */
export const FOOTER_SUPPRESS_MAX_AGE_MS = 30_000;

/** The `FooterComponent` shape this module uses (no pi imports — tests feed a fake class). */
export interface FooterClassLike {
	prototype: { render(width: number): string[] };
}

interface SuppressRecord {
	release: () => void;
}

/**
 * Where the takeover record hangs: preferably `target.prototype` (the object really
 * patched), falling back to target itself.
 * Passing the class or the prototype both work; a shape mismatch → undefined (then
 * nothing happens).
 */
export function suppressTarget(target: unknown): { render(width: number): string[] } | undefined {
	const kind = typeof target;
	if (target === null || (kind !== "object" && kind !== "function")) return undefined;
	for (const candidate of [(target as { prototype?: unknown }).prototype, target]) {
		if (
			candidate !== null &&
			typeof candidate === "object" &&
			typeof (candidate as { render?: unknown }).render === "function"
		) {
			return candidate as { render(width: number): string[] };
		}
	}
	return undefined;
}

/** Release whatever takeover `target` carries (possibly a leftover of another extension instance). Returns whether anything was released. */
export function releaseFooterSuppressor(target: unknown): boolean {
	try {
		const holder = suppressTarget(target) as { [FOOTER_SUPPRESS_KEY]?: SuppressRecord } | undefined;
		const record = holder?.[FOOTER_SUPPRESS_KEY];
		if (!record || typeof record.release !== "function") return false;
		record.release();
		return true;
	} catch {
		return false;
	}
}

/**
 * Replace `footerClass.prototype.render` with "return 0 rows"; returns the release
 * function (idempotent).
 *
 * After release (or past `maxAgeMs`) the prototype is restored and rendering passes
 * through; a repeat takeover first releases the previous — no stacked wrappers.
 * A wrong shape / read-only prototype → undefined (the caller treats it as "not
 * applied" — behavior degrades to the original).
 */
export function suppressBuiltInFooter(
	footerClass: unknown,
	options: { maxAgeMs?: number; now?: () => number } = {},
): (() => void) | undefined {
	const target = suppressTarget(footerClass);
	if (!target) return undefined;
	// release any existing takeover first (own re-entry / a leftover of the previous extension instance) — what remains is the real original.
	releaseFooterSuppressor(target);

	const originalRender = target.render;
	const maxAgeMs = options.maxAgeMs ?? FOOTER_SUPPRESS_MAX_AGE_MS;
	const now = options.now ?? Date.now;
	const armedAt = now();
	const hadOwnRender = Object.prototype.hasOwnProperty.call(target, "render");
	const state: { released: boolean; record?: SuppressRecord } = { released: false };

	const release = (): void => {
		if (state.released) return;
		state.released = true;
		try {
			const holder = target as { [FOOTER_SUPPRESS_KEY]?: SuppressRecord };
			if (state.record && holder[FOOTER_SUPPRESS_KEY] === state.record) delete holder[FOOTER_SUPPRESS_KEY];
			if (hadOwnRender) target.render = originalRender;
			else delete (target as { render?: unknown }).render;
		} catch {
			// read-only prototype / already replaced: the wrapper passes through via its released flag — no more suppressing.
		}
	};

	const wrapper = function (this: unknown, width: number): string[] {
		if (state.released) return originalRender.call(this, width);
		if (now() - armedAt > maxAgeMs) {
			release();
			return originalRender.call(this, width);
		}
		return [];
	};

	try {
		target.render = wrapper;
		state.record = { release };
		(target as { [FOOTER_SUPPRESS_KEY]?: SuppressRecord })[FOOTER_SUPPRESS_KEY] = state.record;
	} catch {
		return undefined;
	}
	return release;
}
