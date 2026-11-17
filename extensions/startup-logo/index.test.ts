/**
 * Tests for startup-logo/index.ts — the "logo in the startup header" and "prune three
 * sections of the startup listing" chain.
 *
 * Run with:  node --test clients/pi/extensions/startup-logo/index.test.ts
 *
 * pi's own extension loader really loads `index.ts` (the import surface and the event
 * registration surface are both covered); faked is everything outside the extension:
 * `ctx.ui.setHeader` synchronously builds the component and mounts it into a fake
 * header container exactly as pi does, and `ctx` is a minimal object. So the
 * "install header → find the container → take over the loaded-resources listing"
 * chain can be exercised end to end.
 *
 * pi's real internals are **not** covered here (render throttling, the swap-freeze
 * window, diagnostic sections) — those live in `header-guard.test.ts` /
 * `loaded-sections.test.ts`'s pure-logic cases plus live runs.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MARK_WIDTH } from "./logo.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "could not find the local pi library entry (requires an installed pi)";

/**
 * pi's library entry (not the CLI): bundle is the shape `pi` actually runs, dist is
 * the node build shape.
 *
 * First back-trace the `pi` executable to the **real install location** (pnpm/npm shim
 * scripts carry a `# cmd-shim-target=<abs path>` line; npm on Unix uses a symlink —
 * both are tried), then fall back to the `~/.pi/agent/npm` copy — the latter is the
 * **extension-package install root**: `pi update --extensions` trims the auto-installed
 * `@earendil-works/pi-*` sibling packages with
 * `--config.auto-install-peers=false`, leaving that copy a hollow shell (files present,
 * import fails with `ERR_MODULE_NOT_FOUND`; hit live while upgrading pi-subagents
 * 0.68.0 in 2026-09).
 *
 * The check is **whether it really imports**, not whether the path exists — only an
 * actual import can tell a hollow shell apart. All failing → undefined; the caller
 * skips wholesale (never fakes a pass).
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

/** Shaped after pi-tui: `children` is a public array, `addChild` pushes to its tail. */
class FakeContainer {
	children: unknown[] = [];
	addChild(child: unknown): void {
		this.children.push(child);
	}
	render(width: number): string[] {
		return this.children.flatMap((child) => (child as { render(w: number): string[] }).render(width));
	}
}

class FakeSection {
	name: string;
	constructor(name: string) {
		this.name = name;
	}
	render(_width: number): string[] {
		return [`\u001b[38;2;121;214;193m[${this.name}]\u001b[39m`, `  ${this.name}'s content`, ""];
	}
}

class FakeSpacer {
	render(_width: number): string[] {
		return [""];
	}
}

interface FakeTui {
	children: unknown[];
	headerContainer: FakeContainer;
	loadedResourcesContainer: FakeContainer;
	chatContainer: FakeContainer;
	documentContainer: FakeContainer;
	/** The currently mounted header component (undefined after `setHeader(undefined)`). */
	headerComponent: unknown;
}

function createFakeTui(): FakeTui {
	const headerContainer = new FakeContainer();
	const loadedResourcesContainer = new FakeContainer();
	const chatContainer = new FakeContainer();
	const documentContainer = new FakeContainer();
	documentContainer.addChild(headerContainer);
	documentContainer.addChild(loadedResourcesContainer);
	documentContainer.addChild(chatContainer);
	return {
		children: [documentContainer],
		headerContainer,
		loadedResourcesContainer,
		chatContainer,
		documentContainer,
		headerComponent: undefined,
	};
}

/** The theme: identity coloring (ANSI-stripped it is plain text — same width rule as the real theme). */
const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
};

function createContext(tui: FakeTui): { ctx: unknown; setHeaderCalls: number } {
	const state = { setHeaderCalls: 0 };
	const ui = {
		theme: fakeTheme,
		// pi's setExtensionHeader synchronously builds the component and mounts it — mirrored here (order visible to the extension).
		setHeader(factory?: (tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void }) {
			state.setHeaderCalls += 1;
			const children = tui.headerContainer.children;
			const index = children.indexOf(tui.headerComponent);
			if (index >= 0) children.splice(index, 1);
			tui.headerComponent = undefined;
			if (!factory) return;
			const component = factory(tui, fakeTheme);
			tui.headerComponent = component;
			children.push(component);
		},
		notify() {},
	};
	return { ctx: { mode: "tui", hasUI: true, cwd: "/Users/someone/proj", ui }, setHeaderCalls: state.setHeaderCalls };
}

interface LoadedExtension {
	handlers: Map<string, Handler[]>;
	commands: Map<string, unknown>;
	errors: Array<{ path: string; error: string }>;
}

/** Load this extension via pi's own loader (the `./logo.ts` / `./loaded-sections.ts` imports are verified along the way). */
async function loadExtension(agentDir: string, projectDir: string): Promise<LoadedExtension> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
	};
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, createTestBus());
	assert.deepEqual(loaded.errors, [], "pi's extension loader must not error");
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.ok(extension);
	return extension;
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-startup-logo-"));
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

const stripAnsi = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, "");

const sectionTitlesIn = (container: FakeContainer): string[] =>
	container.children
		.flatMap((child) => {
			const lines = (child as { render(w: number): string[] }).render(80);
			const first = stripAnsi(lines[0] ?? "").trim();
			const match = /^\[([^[\]]+)\]$/.exec(first);
			return match ? [match[1]!] : [];
		})
		.filter((title) => title.length > 0);

test("the registration surface: session events only — no `/logo` command anymore", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir);
		assert.equal(extension.commands.size, 0, "the `/logo` command was removed per user request");
		assert.equal(extension.commands.has("logo"), false);
		for (const event of ["session_start", "session_tree", "session_shutdown"]) {
			assert.ok(extension.handlers.get(event)?.length, `should register ${event}`);
		}
	} finally {
		workspace.cleanup();
	}
});

test("session_start: the header is the logo (every row indented one, no /logo hint), and the listing loses three sections", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir);
		const sessionStart = extension.handlers.get("session_start")?.[0];
		assert.ok(sessionStart);
		const tui = createFakeTui();
		const { ctx } = createContext(tui);

		await sessionStart({}, ctx);
		assert.ok(tui.headerComponent, "session_start should install the logo header");

		const lines = (tui.headerComponent as { render(w: number): string[] }).render(80);
		const plain = lines.map(stripAnsi);
		// the first four rows are the mark: each leads with a blank, and rows 0/3 (no side text) are full-width
		for (const line of plain.slice(0, 4)) assert.ok(line.startsWith(" "), `a mark row must not be flush-left: ${JSON.stringify(line)}`);
		assert.equal(plain[0]!.length, MARK_WIDTH, "a mark row without side text is the full row width");
		assert.equal(plain[3]!.length, MARK_WIDTH, "a mark row without side text is the full row width");
		// rows 1/2 carry the side text: it lands on the same column (MARK_WIDTH + 2), so the columns align
		assert.ok(plain[1]?.includes("pi v"), "the side text should carry the version");
		assert.equal(plain[1]!.indexOf("pi v"), MARK_WIDTH + 2, "the version should land on column MARK_WIDTH + 2");
		assert.ok(plain.some((line) => line.includes("/Users/someone/proj")), "the side text should carry the cwd");
		assert.ok(plain.some((line) => line.includes("Pi can explain its own features")), "the tagline should be kept");
		assert.equal(plain.some((line) => line.includes("/logo")), false, "the `/logo toggles this header.` hint is gone");

		// the loaded-resources listing: filled in pi's order — the three pruned sections and their blank rows must never enter
		const { loadedResourcesContainer: loaded } = tui;
		loaded.addChild(new FakeSpacer());
		for (const name of ["Context", "Skills", "Prompts", "Extensions", "Themes"]) {
			loaded.addChild(new FakeSection(name));
			loaded.addChild(new FakeSpacer());
		}
		assert.deepEqual(sectionTitlesIn(loaded), ["Skills", "Extensions"]);
	} finally {
		workspace.cleanup();
	}
});

test("session_tree reinstalls the header: the takeover is idempotent and the listing still only has Skills / Extensions", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir);
		const sessionStart = extension.handlers.get("session_start")?.[0];
		const sessionTree = extension.handlers.get("session_tree")?.[0];
		assert.ok(sessionStart && sessionTree);
		const tui = createFakeTui();
		const { ctx } = createContext(tui);

		await sessionStart({}, ctx);
		await sessionTree({}, ctx);
		assert.equal(tui.headerContainer.children.filter((child) => child === tui.headerComponent).length, 1, "exactly one header should be mounted");

		// the /reload shape: clear, then fill a fresh listing
		tui.loadedResourcesContainer.children = [];
		tui.loadedResourcesContainer.addChild(new FakeSection("Themes"));
		tui.loadedResourcesContainer.addChild(new FakeSpacer());
		tui.loadedResourcesContainer.addChild(new FakeSection("Skills"));
		assert.deepEqual(sectionTitlesIn(tui.loadedResourcesContainer), ["Skills"]);
	} finally {
		workspace.cleanup();
	}
});
