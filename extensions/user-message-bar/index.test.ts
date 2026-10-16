/**
 * Tests for index.ts — end-to-end: pi's own extension loader really loads
 * this extension, the patch really lands on **the `UserMessageComponent` pi
 * renders with**, and a user message rendered by pi's own component is A/B
 * compared (same text, same width: before vs after the patch).
 *
 * Run with:  node --test clients/pi/extensions/user-message-bar/index.test.ts
 *
 * Why this detour is unavoidable (rather than just new-ing a component): the
 * feature's **only** risk is "the patch landed on a different class" — `pi`
 * runs `dist/bundle/cli.js` with pi's classes inlined in the chunk, while the
 * extension's import resolves to whatever the loader's virtualModules hands
 * it. Only a real pass through pi's loader + pi's own render component proves
 * the two **are the same class** (the chain is in `bar.ts`'s file header).
 * `bar.test.ts` covers the pure logic and edge cases.
 *
 * The assertions (row-by-row A/B — harder than "looks right"):
 *   - every row's visible width is **identical** to before (pi-tui throws
 *     outright on an over-wide row — not one column may differ);
 *   - zero-width sequences stripped, the text is byte-identical to before —
 *     only the row start's two columns change from "space + text" to "bar +
 *     space", and the extra column was eaten from the **trailing padding**
 *     (width unchanged);
 *   - the bar color = the skin's `accent` (a hand-made skin is injected —
 *     values controlled);
 *   - the OSC 133 zone marker still leads the first row (the bar must not
 *     push it back);
 *   - inside a session-swap window (old ctx dead, new one not yet arrived)
 *     rendering does not throw — it just draws no bar (2026-09-20
 *     regression).
 * No local pi library entry → skip wholesale (never fake a pass).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "could not find the local pi library entry (requires an installed pi)";
const ESC = "\u001b";

const BAR = "\u258e";
/** The hand-made skin's `accent` (`#95c4ce` = this machine's `pi-coder-summer-night` sky) — the default color slot. */
const ACCENT = "#95c4ce";
const ACCENT_FG = "\u001b[38;2;149;196;206m";
/** The default color (= accent) — the A/B compare and `undoBar` use it. */
const BAR_FG = ACCENT_FG;
/** The hand-made skin's `toolDiffAdded` (`#89b8c2` = that skin's teal): the fallback slot when `accent` is absent. */
const DIFF_ADDED = "#89b8c2";
const DIFF_ADDED_FG = "\u001b[38;2;137;184;194m";
/** `#2d2c5d` = that skin's select color: a background slot — verifies the 38/48 conversion when a bg slot is named explicitly. */
const SELECTED_BG = "#2d2c5d";
const SELECTED_BG_FG = "\u001b[38;2;45;44;93m";

/**
 * pi's library entry (not the CLI): bundle is the shape `pi` actually runs,
 * dist is the node build shape.
 *
 * First back-trace the `pi` executable to the **real install location**
 * (pnpm/npm shim scripts carry a `# cmd-shim-target=<abs path>` line; npm on
 * Unix uses a symlink — both are tried), then fall back to the
 * `~/.pi/agent/npm` copy — the latter is the **extension-package install
 * root**: `pi update --extensions` trims the auto-installed
 * `@earendil-works/pi-*` sibling packages with
 * `--config.auto-install-peers=false`, leaving that copy a hollow shell
 * (files present, import fails with `ERR_MODULE_NOT_FOUND`; hit live while
 * upgrading pi-subagents 0.68.0 in 2026-09).
 *
 * The check is **whether it really imports**, not whether the path exists —
 * only an actual import can tell a hollow shell apart. All failing →
 * undefined; the caller skips wholesale (never fakes a pass).
 */
async function findPiLibraryEntry(): Promise<string | undefined> {
	const candidates: string[] = [];
	if (process.env.PI_TEST_PI_ENTRY) candidates.push(process.env.PI_TEST_PI_ENTRY);

	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const shimPath = path.join(dir, "pi");
		try {
			// npm's shim is a symlink
			const real = fs.realpathSync(shimPath);
			if (real !== shimPath) candidates.push(path.join(path.dirname(real), "index.js"));
		} catch {
			// not a symlink / missing: look at the shim script below
		}
		try {
			const match = /^# cmd-shim-target=(.+)$/m.exec(fs.readFileSync(shimPath, "utf8"));
			if (match?.[1]) candidates.push(path.join(path.dirname(match[1].trim()), "index.js"));
		} catch {
			// cannot read this shim: skip it
		}
	}

	const packageDir = path.join(os.homedir(), ".pi/agent/npm/node_modules/@earendil-works/pi-coding-agent");
	candidates.push(path.join(packageDir, "dist/bundle/index.js"), path.join(packageDir, "dist/index.js"));

	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			await import(pathToFileURL(candidate).href);
			return candidate;
		} catch {
			// a hollow-shell copy: try the next candidate
		}
	}
	return undefined;
}

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface LoadedExtension {
	handlers: Map<string, Handler[]>;
	errors: Array<{ path: string; error: string }>;
}

interface PiApi {
	discoverAndLoadExtensions: (
		configuredPaths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
	getMarkdownTheme: () => Record<string, unknown>;
	initTheme: (name?: string) => void;
	Theme: new (
		fgColors: Record<string, string>,
		bgColors: Record<string, string>,
		mode: string,
	) => unknown;
	UserMessageComponent: new (
		text: string,
		markdownTheme: unknown,
		outputPad: number,
		transformers: unknown[],
	) => { render(width: number): string[] };
}

let pi: PiApi | undefined;
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

/** The `ctx.ui.theme` injected into the extension: a hand-made skin with controlled values.
 *  `muted` / `thinkingXhigh` / `text` are read by the Theme constructor's fallbacks
 *  (scrollbarTrack ← muted, etc.) — missing any, the constructor throws on `fgAnsi(undefined)`. */
function createTheme(): unknown {
	assert.ok(pi);
	return new pi.Theme(
		{ accent: ACCENT, text: "#c6c8d1", muted: "#818596", thinkingXhigh: "#626262", toolDiffAdded: DIFF_ADDED },
		{ selectedBg: SELECTED_BG, userMessageBg: "#1b1c1d" },
		"truecolor",
	);
}

function createTestBus(): { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void } {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set<(data: unknown) => void>();
			handlers.set(channel, set);
			set.add(handler);
			return () => {
				set.delete(handler);
			};
		},
		emit(channel, data) {
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-user-message-bar-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	return {
		agentDir,
		projectDir,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

/** Load this extension via pi's own loader (the `./bar.ts` import is verified along the way). */
async function loadExtension(workspace: { agentDir: string; projectDir: string }): Promise<LoadedExtension> {
	assert.ok(pi);
	const loaded = await pi.discoverAndLoadExtensions(
		[EXTENSION_PATH],
		workspace.projectDir,
		workspace.agentDir,
		createTestBus(),
	);
	assert.deepEqual(loaded.errors, [], "pi's extension loader must not error");
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.ok(extension);
	return extension;
}

/** The step that touches pi's real event chain: `session_start` carries the ctx — where the extension gets the skin. */
async function fireSessionStart(extension: LoadedExtension, theme: unknown): Promise<void> {
	await fireSessionStartWithCtx(extension, { ui: { theme } });
}

/** Same as above, but the whole ctx is given — injects a "any property read throws" dead ctx. */
async function fireSessionStartWithCtx(extension: LoadedExtension, ctx: unknown): Promise<void> {
	const handlers = extension.handlers.get("session_start") ?? [];
	assert.ok(handlers.length > 0, "this extension must register session_start (or it never gets the skin)");
	for (const handler of handlers) await handler({ type: "session_start" }, ctx);
}

/** pi emits this before killing the old ctx on a session swap / reload (`extensionRunner.invalidate()`). */
async function fireSessionShutdown(extension: LoadedExtension): Promise<void> {
	const handlers = extension.handlers.get("session_shutdown") ?? [];
	assert.ok(handlers.length > 0, "this extension must register session_shutdown (the color source must drop before the old ctx dies)");
	for (const handler of handlers) await handler({ type: "session_shutdown", reason: "new" }, undefined);
}

/** What pi's stale-ctx kill throws (`ExtensionRunner.assertActive()`). */
const STALE_CTX = "This extension ctx is stale after session replacement or reload.";

/** A ctx behaving like the dead old one: every property read throws. */
function staleCtx(): unknown {
	return new Proxy(
		{},
		{
			get() {
				throw new Error(STALE_CTX);
			},
		},
	);
}

/** Render one user message with pi's own component (`outputPad = 1` — same as the real render). */
function renderUserMessage(text: string, width: number): string[] {
	assert.ok(pi);
	pi.initTheme("dark");
	const markdownTheme = { ...pi.getMarkdownTheme(), codeBlockIndent: "  " };
	return new pi.UserMessageComponent(text, markdownTheme, 1, []).render(width);
}

/** Strip the CSI colors and the OSC 133 marker (a user message carries one of each at head/tail). */
const plainText = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/**
 * The visible column count: zero-width sequences stripped, then columns
 * counted (the fixture holds only ASCII, Han, and `▎`; Han = 2 columns, the
 * rest 1).
 * An independent implementation verifies pi's own width math agrees — it is
 * the check for whether a row would hit pi-tui's over-wide throw.
 */
const visibleWidth = (line: string): number => {
	let width = 0;
	for (const ch of plainText(line)) {
		const code = ch.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
};

/** The bar (color + glyph + foreground reset) plus the one indent space after it — exactly the segment the extension writes into every row. */
const barOf = (fg: string): string => `${fg}${BAR}\u001b[39m `;

/**
 * Restore a patched row **byte for byte** to its unpatched form: bar +
 * indent become the left padding space again, and the eaten column is
 * returned to the trailing padding. Anything not restorable means the patch
 * touched more than it should.
 */
const undoBar = (line: string, fg: string): string =>
	line.replace(barOf(fg), " ").replace(/\u001b\[49m$/, (reset) => ` ${reset}`);

const MESSAGE = "first line\nsecond much textbodybodybodybodybodybodybody";
const WIDTH = 46;

/** The prototype patch is **process-wide** — once installed it lives until exit — so this case must run before any real install,
 *  or it would see a patch left by an earlier test. In the real world off is a startup switch (the module never loads) — no such issue. */
test("with PI_USER_MESSAGE_BAR=off the patch is not even installed", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	process.env.PI_USER_MESSAGE_BAR = "off";
	try {
		const extension = await loadExtension(workspace);
		assert.equal(extension.handlers.size, 0, "with off, not even session_start is registered");
		const lines = renderUserMessage(MESSAGE, WIDTH);
		assert.equal(lines.some((line) => line.includes(BAR)), false, "no bar drawn");
	} finally {
		delete process.env.PI_USER_MESSAGE_BAR;
		workspace.cleanup();
	}
});

test("pi's loader can load the extension and the patch lands on pi's own UserMessageComponent", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		assert.equal(extension.handlers.get("session_start")?.length, 1, "one session_start registered");
		assert.equal(extension.handlers.get("session_shutdown")?.length, 1, "one session_shutdown registered");
		assert.equal(extension.handlers.size, 2, "only these two events registered");
	} finally {
		workspace.cleanup();
	}
});

test("pi's render before the patch, verbatim (freshly loaded, no skin yet — no bar)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		await loadExtension(workspace);

		const lines = renderUserMessage(MESSAGE, WIDTH);
		assert.equal(lines.length >= 3, true, "at least top/bottom padding + one text row");
		assert.equal(lines.some((line) => line.includes(BAR)), false, "no bar without a skin");
	} finally {
		workspace.cleanup();
	}
});

test("with a skin: a bar at every row's start + one indent before the text, accent color, width and text byte-identical", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const before = renderUserMessage(MESSAGE, WIDTH);
		await fireSessionStart(extension, createTheme());
		const after = renderUserMessage(MESSAGE, WIDTH);

		assert.equal(after.length, before.length, "the row count is unchanged");
		for (const [i, line] of after.entries()) {
			assert.equal(line.includes(`${BAR_FG}${BAR}\u001b[39m`), true, `row ${i}'s bar uses the accent color`);
			assert.equal(plainText(line).startsWith(`${BAR} `), true, `row ${i} starts with bar + one blank`);
			// the bar follows the message background: no background-toggle sequences are inserted, and the block's left edge keeps no notch
			assert.equal(line.split("\u001b[49m").length - 1, 1, `row ${i} has only the tail's one background-close`);
			assert.equal(undoBar(line, BAR_FG), before[i], `row ${i} only gained the bar + indent — nothing else touched`);
			assert.equal(visibleWidth(line), visibleWidth(before[i] ?? ""), `row ${i}'s visible width is unchanged`);
		}
		assert.equal(after[0].startsWith(`${ESC}]133;A\u0007`), true, "the zone marker still leads the first row");
		const joined = after.map(plainText).join("\n");
		assert.equal(joined.includes("first line"), true, "the body text is there");
		assert.equal(joined.includes("second much text"), true, "the wrapped body is there too");
	} finally {
		workspace.cleanup();
	}
});

/**
 * Rows whose text wraps to a full line: the Box gives its child `width - 2`
 * columns, so at least one trailing-padding column always remains and bar +
 * indent always fit. A long body makes pi really wrap it — every row's
 * width is verified.
 */
test("even rows wrapped to a full line spare the column: every row is exactly width columns", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const long = "body".repeat(60);
		await fireSessionStart(extension, createTheme());
		const lines = renderUserMessage(long, WIDTH);

		assert.equal(lines.length > 3, true, "the long body should wrap to multiple rows");
		for (const [i, line] of lines.entries()) {
			assert.equal(visibleWidth(line), WIDTH, `row ${i} is exactly ${WIDTH} columns (one over and pi-tui throws)`);
			assert.equal(plainText(line).startsWith(`${BAR} `), true, `row ${i} starts with bar + indent`);
		}
	} finally {
		workspace.cleanup();
	}
});

test("PI_USER_MESSAGE_BAR_COLOR=toolDiffAdded switches to another foreground slot (no 38/48 conversion)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	process.env.PI_USER_MESSAGE_BAR_COLOR = "toolDiffAdded";
	try {
		const extension = await loadExtension(workspace);
		await fireSessionStart(extension, createTheme());
		const lines = renderUserMessage(MESSAGE, WIDTH);

		for (const line of lines) {
			assert.equal(line.includes(`${DIFF_ADDED_FG}${BAR}`), true, "the bar uses toolDiffAdded");
			assert.equal(line.includes(ACCENT_FG), false, "the default accent was not used");
		}
	} finally {
		delete process.env.PI_USER_MESSAGE_BAR_COLOR;
		workspace.cleanup();
	}
});

test("PI_USER_MESSAGE_BAR_COLOR=selectedBg also works: a background slot converted to foreground (38/48)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	process.env.PI_USER_MESSAGE_BAR_COLOR = "selectedBg";
	try {
		const extension = await loadExtension(workspace);
		await fireSessionStart(extension, createTheme());
		const lines = renderUserMessage(MESSAGE, WIDTH);

		for (const line of lines) {
			assert.equal(line.includes(`${SELECTED_BG_FG}${BAR}`), true, "the bar uses selectedBg's 38 equivalent");
			assert.equal(line.includes(BAR_FG), false, "the default accent was not used");
			assert.equal(line.includes(`\u001b[48;2;45;44;93m${BAR}`), false, "a background slot must not be painted as a background");
		}
	} finally {
		delete process.env.PI_USER_MESSAGE_BAR_COLOR;
		workspace.cleanup();
	}
});

/**
 * Regression: at the moment a session is replaced (`/clear`, `/new`,
 * `/resume`, `/fork`, `/reload`), pi kills the old ctx while the old
 * messages still hang on `chatContainer` and the new ctx has not arrived —
 * a render tick inside that window throws on any old-ctx read, and an
 * exception from a render callback is uncatchable — it exits pi (measured
 * 2026-09-20).
 * So "no skin available" must mean "no bar this frame", never an escaped
 * exception.
 */
test("a dead old ctx → render does not throw and draws no bar (a render tick inside the swap window must not topple pi)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		await fireSessionStartWithCtx(extension, staleCtx());

		const lines = renderUserMessage(MESSAGE, WIDTH); // this used to throw → straight into pi's uncaughtException
		assert.equal(lines.some((line) => line.includes(BAR)), false, "no bar when the skin cannot be read");
		assert.equal(lines.length >= 3, true, "the message itself still renders (top/bottom padding + body)");
		assert.equal(plainText(lines.join("\n")).includes("first line"), true, "the body loses nothing");
	} finally {
		workspace.cleanup();
	}
});

/**
 * Regression: `session_shutdown` resets the color source on arrival. The
 * assertion is "let the old ctx start throwing afterwards" — with the reset
 * effective, render never reads it; without it, the previous case's throw
 * would fire.
 */
test("after session_shutdown: no bar, and render never touches the old ctx (it may throw from here on — no crash)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		let live = true;
		const theme = createTheme();
		await fireSessionStartWithCtx(extension, {
			ui: {
				get theme() {
					if (!live) throw new Error(STALE_CTX);
					return theme;
				},
			},
		});
		const before = renderUserMessage(MESSAGE, WIDTH);
		assert.equal(before.some((line) => line.includes(`${BAR_FG}${BAR}`)), true, "a skin before the swap → bars drawn");

		await fireSessionShutdown(extension);
		live = false; // from here on the old ctx is dead: any read of it throws
		const after = renderUserMessage(MESSAGE, WIDTH);

		assert.equal(after.some((line) => line.includes(BAR)), false, "no bar after shutdown");
		for (const [i, line] of after.entries()) assert.equal(line, undoBar(before[i] ?? "", BAR_FG), `row ${i} is back to its unpatched form`);
	} finally {
		workspace.cleanup();
	}
});
