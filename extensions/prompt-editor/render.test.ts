/**
 * Tests for prompt-editor.ts — the `!` bash mode's render contract on the
 * **real editor**.
 *
 * Run with:  node --test clients/pi/extensions/prompt-editor/render.test.ts
 *
 * pi's own extension loader really loads `../prompt-editor.ts` (syntax, the
 * import surface, the session_start registration — all covered); faked is
 * only everything outside the editor: tui needs just `terminal.rows` and
 * `requestRender()`, the theme's `borderColor` is identity, keybindings'
 * `matches` is always false. So the chain "gutter swaps to `!`, the typed
 * `!` no longer shows in the text, the cursor cannot reach the dropped
 * column, clicks cross it, backspace deletes `!` and leaves the mode" is
 * asserted row by row / cursor column by cursor column. The pure logic is
 * in `bash-prompt.test.ts`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"prompt-editor.ts",
);
const SKIP = "could not find the local pi library entry (requires an installed pi)";

/**
 * pi's library entry (not the CLI): bundle is the shape `pi` actually runs,
 * dist is the node build shape.
 *
 * First back-trace the `pi` executable to the **real install location**
 * (pnpm/npm shim scripts carry a `# cmd-shim-target=<abs path>` line; npm
 * on Unix uses a symlink — both are tried), then fall back to the
 * `~/.pi/agent/npm` copy — the latter is the **extension-package install
 * root**: `pi update --extensions` trims the auto-installed
 * `@earendil-works/pi-*` sibling packages with
 * `--config.auto-install-peers=false`, leaving that copy a hollow shell
 * (files present, import fails with `ERR_MODULE_NOT_FOUND`).
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

function createTestBus(): {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
} {
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

interface EditorLike {
	setText(text: string): void;
	getText(): string;
	getCursor(): { line: number; col: number };
	handleInput(data: string): void;
	handleMouse(event: Record<string, unknown>): unknown;
	render(width: number): string[];
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-editor-"));
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

/**
 * Load the extension with pi's own loader, call its registered
 * session_start, grab the editor factory and instantiate it.
 * Everything outside the editor is fake: a `paddingX: 0` Editor only needs
 * `tui.terminal.rows`, the theme only an identity `borderColor`,
 * keybindings only a never-matching `matches` (the Editor's own keys take
 * pi-tui's global default table, so Ctrl+A / backspace behave by their real
 * bindings).
 */
async function mountEditor(): Promise<EditorLike> {
	const workspace = makeWorkspace();
	try {
		const pi = (await import(pathToFileURL(piEntry as string).href)) as {
			discoverAndLoadExtensions: (
				configuredPaths: string[],
				cwd: string,
				agentDir?: string,
				eventBus?: unknown,
			) => Promise<{
				extensions: Array<{ handlers: Map<string, Handler[]> }>;
				errors: Array<{ path: string; error: string }>;
			}>;
		};
		const loaded = await pi.discoverAndLoadExtensions(
			[EXTENSION_PATH],
			workspace.projectDir,
			workspace.agentDir,
			createTestBus(),
		);
		assert.deepEqual(loaded.errors, [], "pi's extension loader must not error");
		const extension = loaded.extensions[0];
		assert.ok(extension, "the extension should load");
		const sessionStart = extension.handlers.get("session_start")?.[0];
		assert.ok(sessionStart, "the extension should register session_start");

		let factory: ((tui: unknown, theme: unknown, keybindings: unknown) => EditorLike) | undefined;
		const ctx = {
			hasUI: true,
			cwd: workspace.projectDir,
			ui: {
				setEditorComponent(next: typeof factory) {
					factory = next;
				},
			},
		};
		await sessionStart({}, ctx);
		assert.ok(factory, "session_start should register the editor factory");

		return factory(
			{ terminal: { rows: 40 }, requestRender() {} },
			{ borderColor: (text: string) => text },
			{ matches: () => false },
		);
	} finally {
		workspace.cleanup();
	}
}

/** Strip CSI and APC (CURSOR_MARKER) escapes — plain text is left. */
function plainLines(lines: string[]): string[] {
	return lines.map((line) =>
		line
			.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "")
			.replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""),
	);
}

/** The full event shape Editor.handleMouse wants; x / y are component-internal coordinates. */
function mouseClick(x: number, y: number): Record<string, unknown> {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 40,
		height: 40,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}

test("plain input: gutter is ❯, text verbatim", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("hello");

	const lines = plainLines(editor.render(40));
	assert.ok(lines[1]?.startsWith("❯ hello"), `the first text row should be "❯ hello": ${JSON.stringify(lines[1])}`);
	assert.equal(lines[1]?.length, 40, "every row must be full width (gutter + contentWidth)");
	assert.equal(lines[0]?.length, 40, "the top border is full width too");
});

test("a `!` start: gutter becomes !, the typed ! no longer shows", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!ls -la");

	const lines = plainLines(editor.render(40));
	assert.ok(lines[1]?.startsWith("! ls -la"), `the gutter should be "! " with the text right behind: ${JSON.stringify(lines[1])}`);
	assert.equal(lines[1]?.includes("!ls"), false, "the `!` must not appear inside the text");
	assert.equal(lines[1]?.length, 40, "the dropped column is padded back to full width");
	assert.equal(lines[0]?.length, 40, "the top border is unaffected");
});

test("`!!` (not-entering-context) hides only the first ! — the second stays visible in the text", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!!ls");

	const lines = plainLines(editor.render(40));
	assert.ok(lines[1]?.startsWith("! !ls"), `the second "!" stays in the text: ${JSON.stringify(lines[1])}`);
	assert.equal(lines[1]?.length, 40);
});

test("with only `!` left, backspace exits the mode: the gutter returns to ❯ on its own", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!");
	assert.ok(plainLines(editor.render(40))[1]?.startsWith("! "), "enter bash mode first");

	editor.handleInput("\x7f"); // backspace
	assert.equal(editor.getText(), "", "backspace deleted that `!`");
	assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
	assert.ok(
		plainLines(editor.render(40))[1]?.startsWith("❯ "),
		"after leaving the mode the gutter is back to ❯",
	);
});

test("Ctrl+A keeps the cursor behind the hidden `!`: typing on does not break bash mode", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!ls");

	editor.handleInput("\x01"); // ctrl+a
	assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, "the cursor must not land on the dropped column");

	editor.handleInput("c");
	assert.equal(editor.getText(), "!cls", "the insertion point stays after column 1, `!` still leads");
	assert.ok(plainLines(editor.render(40))[1]?.startsWith("! cls"), "the bash-mode drawing is kept");
});

test("plain text's Ctrl+A is unaffected: the cursor may reach column 0", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("ls");

	editor.handleInput("\x01"); // ctrl+a
	assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
});

test("click: with the text shifted one column left the coordinates still match (a gutter click is pushed back to column 1)", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!ls");
	editor.render(40); // handleMouse relies on the latest render's width and row count

	// the visible text: the gutter takes x=0/1, `l` sits at x=2, `s` at x=3
	editor.handleMouse(mouseClick(3, 1));
	assert.deepEqual(editor.getCursor(), { line: 0, col: 2 }, "a click on `s` → the cursor goes before `s`");

	editor.handleMouse(mouseClick(2, 1));
	assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, "a click on `l` → the cursor goes before `l`");

	editor.handleMouse(mouseClick(0, 1));
	assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, "a click on the gutter (the hidden column) is pushed back to column 1");
});
