/**
 * Tests for index.ts — end-to-end: pi's own extension loader really loads
 * this extension, the patch really lands on **the `Markdown` class pi
 * renders with**, and pi's own `AssistantMessageComponent` renders an
 * assistant message asserting the fences are gone, syntax colors remain,
 * and **no background is painted**.
 *
 * Run with:  node --test clients/pi/extensions/fenceless-code-block/index.test.ts
 *
 * Why this detour is unavoidable (rather than new-ing a Markdown to
 * render): the feature's **only** risk is "the patch landed on a different
 * class" — `pi` runs `dist/bundle/cli.js` with pi-tui inlined in the
 * chunk, while the extension's import resolves to whatever the loader's
 * aliases / virtualModules hands it. Only a real pass through pi's loader
 * + pi's own render component proves the two **are the same class** (the
 * chain is in `render.ts`'s file header).
 * `render.test.ts` covers the pure logic and edge cases; this file only
 * proves "installs, and works on pi itself".
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

/**
 * pi's library entry (not the CLI): bundle is the shape `pi` actually
 * runs, dist is the node build shape.
 *
 * First back-trace the `pi` executable to the **real install location**
 * (pnpm/npm shim scripts carry a `# cmd-shim-target=<abs path>` line; npm
 * on Unix uses a symlink — both are tried), then fall back to the
 * `~/.pi/agent/npm` copy — the latter is the **extension-package install
 * root**: `pi update --extensions` trims the auto-installed
 * `@earendil-works/pi-*` sibling packages with
 * `--config.auto-install-peers=false`, leaving that copy a hollow shell
 * (files present, import fails with `ERR_MODULE_NOT_FOUND`; hit live
 * while upgrading pi-subagents 0.68.0 in 2026-09).
 *
 * The check is **whether it really imports**, not whether the path
 * exists — only an actual import can tell a hollow shell apart. All
 * failing → undefined; the caller skips wholesale (never fakes a pass).
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
	commands: Map<string, unknown>;
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
	AssistantMessageComponent: new (
		message: unknown,
		hideThinkingBlock: boolean,
		markdownTheme: unknown,
		hiddenThinkingLabel: string,
		outputPad: number,
		transformers: unknown[],
	) => { render(width: number): string[] };
}

let pi: PiApi | undefined;
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fenceless-code-block-"));
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

/** Load this extension via pi's own loader (the `./render.ts` import is verified along the way). */
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

/** Render one assistant text message with pi's own component (`outputPad = 1` — same as the real render). */
function renderAssistantText(text: string, width = 80): string[] {
	assert.ok(pi);
	pi.initTheme("dark");
	// on the real path pi uses getMarkdownThemeWithSettings() (= this merged with the configured indent).
	const markdownTheme = { ...pi.getMarkdownTheme(), codeBlockIndent: "  " };
	const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
	const component = new pi.AssistantMessageComponent(message, false, markdownTheme, "Thinking...", 1, []);
	return component.render(width);
}

/** Strip the CSI colors and the OSC 133 marker (an assistant message carries one of each at head/tail). */
const plainText = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;]*m/g, "");

test("pi's loader can load the extension (it registers neither events nor commands)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		assert.equal(extension.handlers.size, 0, "the patch installs at module-eval time — no session_start needed");
		assert.equal(extension.commands.size, 0, "this extension provides no commands");
	} finally {
		workspace.cleanup();
	}
});

test("pi's rendered code block has no fences and paints no background", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		await loadExtension(workspace);

		const lines = renderAssistantText("before\n\n```js\nconst x = 1;\n```\n\nafter");
		const plain = lines.map(plainText);

		assert.equal(plain.some((line) => line.includes("```")), false, "the fences must not appear");
		assert.equal(plain.some((line) => line.trim() === "js"), false, "the language tag must not take a row of its own");

		const codeLine = lines.find((line) => plainText(line).includes("const x = 1;"));
		assert.ok(codeLine, "the code rows should be there");
		assert.ok(codeLine.includes(`${ESC}[38;`), "syntax coloring must not be eaten by our render");
		assert.equal(codeLine.includes(`${ESC}[48;`), false, "the code rows must have no background");
		assert.equal(lines.some((line) => line.includes(`${ESC}[48;`)), false, "no background SGR anywhere in the whole message");

		assert.equal(plainText(codeLine).trim(), "const x = 1;", "only pi's indent remains — nothing extra at the row tail");
		assert.ok(plain.some((line) => line.includes("before")), "the text before the code block is still there");
		assert.ok(plain.some((line) => line.includes("after")), "the text after the code block is still there");
		for (const line of plain.filter((text) => text.trim() !== "")) {
			assert.equal(line.length, 80, "pi's full-row padding still applies");
		}
	} finally {
		workspace.cleanup();
	}
});
