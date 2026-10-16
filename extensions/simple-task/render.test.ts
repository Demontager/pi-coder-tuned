/**
 * Tests for the task tool block shape (simple-task/index.ts) — end-to-end: pi's own
 * extension loader really loads this extension, then pi's own
 * `ToolExecutionComponent` renders a real task tool block, and the rendered **rows**
 * are asserted.
 *
 * Run with:  node --test clients/pi/extensions/simple-task/render.test.ts
 *
 * Why this detour is required: the feature's entire value is "what the user's screen
 * looks like", and the on-screen rows are built layer by layer through
 * `ToolExecutionComponent` → `renderCall` / `renderResult` → the shell (contentBox /
 * selfRenderContainer). Asserting only `renderShell === "self"` would miss the other
 * half — "no background is actually painted in self mode".
 *
 * The assertion rule (user 2026-09-26: the task block shares one shell with the bash
 * block):
 *   - all three tools (`task_set` / `task_update` / `task_get`) declare
 *     `renderShell: "self"`;
 *   - the block has **no background at all** (none of pending / success / failure —
 *     the same trick as the bash / read blocks: selfRenderContainer is a plain
 *     Container, bgFn cannot attach, and the extension paints none itself);
 *   - the block has **no top/bottom border rows** (pi's default `Box(1, 1)` pair is
 *     gone): row 0 is pi self-mode's fixed blank (`lines.push("")` in `render()`),
 *     row 1 is the tool title itself, and the last row is the result itself;
 *   - title and result body both start at **column 1** (one leading space per row,
 *     never flush-left — user 2026-09-26: restores the one-column left margin the
 *     default shell used to give, drawn by Text's `paddingX = 1`);
 *   - other tools keep the default shell (background included) — a dedicated control
 *     assertion.
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

/**
 * pi's library entry (not the CLI): bundle is the shape `pi` actually runs, dist is
 * the node build shape.
 * The same lookup as the bash / read render.test.ts files: back-trace the `pi`
 * executable to the install location, then fall back to the `~/.pi/agent/npm` copy —
 * the check is whether it really imports.
 */
async function findPiLibraryEntry(): Promise<string | undefined> {
	const candidates: string[] = [];
	if (process.env.PI_TEST_PI_ENTRY) candidates.push(process.env.PI_TEST_PI_ENTRY);

	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const shimPath = path.join(dir, "pi");
		try {
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

/**
 * pi's bundled chalk decides at module-eval time whether to emit styles (off by
 * default without a TTY).
 * The background assertions watch SGR sequences — FORCE_COLOR must be set before
 * importing pi.
 */
if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

interface ToolDefinitionLike {
	renderShell?: string;
	renderCall?: (...args: any[]) => any;
	renderResult?: (...args: any[]) => any;
	execute?: (
		toolCallId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
}

interface PiApi {
	discoverAndLoadExtensions: (
		configuredPaths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{
		extensions: Array<{ tools: Map<string, { definition: ToolDefinitionLike }> }>;
		errors: Array<{ path: string; error: string }>;
	}>;
	createEventBus: () => unknown;
	initTheme: (name?: string, interactive?: boolean) => void;
	ToolExecutionComponent: new (
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: unknown,
		toolDefinition: ToolDefinitionLike | undefined,
		ui: { requestRender(): void },
		cwd: string,
	) => {
		setArgsComplete?: () => void;
		markExecutionStarted: () => void;
		updateResult: (result: unknown, isPartial?: boolean) => void;
		render: (width: number) => string[];
	};
}

let pi: PiApi | undefined;
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

/** Strip every ANSI / OSC escape, keeping only visible text (assertions read this). */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** The background check: a leading background SGR (`48;2;…` / `40-47` / `100-107`) means a painted background. */
const hasBg = (line: string): boolean => /\u001b\[(?:4[0-7]|10[0-7]|48[;:])/.test(line);

let cached: { projectDir: string; tools: Map<string, { definition: ToolDefinitionLike }> } | undefined;
let cleanup: (() => void) | undefined;

if (pi) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-shape-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	cleanup = () => fs.rmSync(root, { recursive: true, force: true });

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	assert.deepEqual(loaded.errors, [], "pi's extension loader must not error");
	const tools = loaded.extensions[0]?.tools;
	assert.ok(tools, "this extension must register tools");
	pi.initTheme("dark");
	cached = { projectDir, tools };
}

test.after(() => cleanup?.());

/** Render a task tool block in pi's own call order (setArgsComplete → markExecutionStarted → updateResult). */
function renderBlock(name: string, args: unknown, result?: { content: unknown[]; details?: unknown; isError?: boolean }): string[] {
	assert.ok(pi && cached);
	const definition = cached.tools.get(name)?.definition;
	assert.ok(definition, `this extension must register ${name} tools`);
	const component = new pi.ToolExecutionComponent(name, "call-1", args, {}, definition, { requestRender() {} }, cached.projectDir);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	if (result) component.updateResult(result, false);
	return component.render(79);
}

/** Each of the three tools' sample args and success results (the state inside details feeds renderResult's counts). */
const SAMPLES: Record<string, { args: unknown; result: { content: unknown[]; details: unknown } }> = {
	task_set: {
		args: { tasks: ["a", "b", "c"] },
		result: {
			content: [{ type: "text", text: "Task list set with 3 task(s)." }],
			details: {
				action: "set",
				state: { active: true, nextId: 4, tasks: [
					{ id: 1, text: "a", status: "pending" },
					{ id: 2, text: "b", status: "done" },
					{ id: 3, text: "c", status: "pending" },
				] },
			},
		},
	},
	task_update: {
		args: { id: 2, status: "done" },
		result: {
			content: [{ type: "text", text: "Task #2 → done." }],
			details: { action: "update", state: { active: true, nextId: 4, tasks: [] } },
		},
	},
	task_get: {
		args: {},
		result: {
			content: [{ type: "text", text: "[x] #2 b" }],
			details: {
				action: "get",
				state: { active: true, nextId: 4, tasks: [
					{ id: 1, text: "a", status: "pending" },
					{ id: 2, text: "b", status: "done" },
					{ id: 3, text: "c", status: "pending" },
				] },
			},
		},
	},
};

test("all three tools declare renderShell: \"self\"", { skip }, () => {
	assert.ok(cached);
	for (const name of ["task_set", "task_update", "task_get"]) {
		assert.equal(cached.tools.get(name)?.definition.renderShell, "self", `${name} must carry the self shell`);
	}
});

test("the whole block has no background (none of pending / success / failure paints)", { skip }, () => {
	assert.ok(cached);
	for (const [name, sample] of Object.entries(SAMPLES)) {
		const pending = renderBlock(name, sample.args);
		const success = renderBlock(name, sample.args, sample.result);
		const failed = renderBlock(name, sample.args, { content: [{ type: "text", text: "boom" }], details: {}, isError: true });
		for (const [label, lines] of [["pending", pending], ["success", success], ["failure", failed]] as Array<[string, string[]]>) {
			const painted = lines.filter(hasBg);
			assert.deepEqual(painted, [], `${name} ${label}: the task block must have no background row: ${JSON.stringify(painted.map(plain))}`);
			// but the content is still there ("no background" must not become "no block")
			assert.equal(lines.map(plain).some((line) => line.includes(name)), true, `${name} ${label}: the title row must still be there`);
		}
	}

	// control: the other tools (no toolDefinition → pi's generic render path) keep their background.
	// pins the "only the task tools changed" half: everything else still goes through ToolExecutionComponent's own contentBox + bgFn.
	assert.ok(pi);
	const other = new pi.ToolExecutionComponent("read", "call-other", { path: "/tmp/x" }, {}, undefined, { requestRender() {} }, cached!.projectDir);
	other.updateResult({ content: [{ type: "text", text: "file content" }], details: {} }, false);
	assert.equal(other.render(79).some(hasBg), true, "the other tools must keep their background");
});

test("no border rows: the title is the block's first row, the result its last, body at column 1 (one leading space per row)", { skip }, () => {
	for (const [name, sample] of Object.entries(SAMPLES)) {
		for (const [label, lines] of [
			["pending", renderBlock(name, sample.args)],
			["success", renderBlock(name, sample.args, sample.result)],
		] as Array<[string, string[]]>) {
			const visible = lines.map(plain);
			// row 0 is pi self-mode's fixed blank (`lines.push("")` in render()) — not part of the block
			assert.equal(visible[0], "", `${name} ${label}: row 0 is pi's fixed blank`);
			// the block's first row is the tool title: leading **exactly one** space (not flush-left, not two)
			assert.equal(visible[1]!.startsWith(` ${name}`), true, `${name} ${label}: row 1 should be "space + title": ${JSON.stringify(visible)}`);
			assert.notEqual(visible[1]!.startsWith(`  ${name}`), true, `${name} ${label}: must not have two leading spaces: ${JSON.stringify(visible[1])}`);
			// the last row is the content itself (no bottom border row)
			assert.notEqual(visible[visible.length - 1]!.trim(), "", `${name} ${label}: the last row must not be blank: ${JSON.stringify(visible)}`);
			// result rows likewise lead with one space — never flush-left
			if (visible.length > 2) {
				assert.equal(visible[2]!.startsWith(" ") && visible[2]!.trim() !== "", true, `${name} ${label}: a result row should lead with one space: ${JSON.stringify(visible[2])}`);
				assert.notEqual(visible[2]!.startsWith("  "), true, `${name} ${label}: a result row must not lead with two spaces: ${JSON.stringify(visible[2])}`);
			}
		}
	}
});
