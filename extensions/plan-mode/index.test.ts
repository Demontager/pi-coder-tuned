/**
 * Tests for index.ts — plan-mode's event wiring (loaded for real by pi's own loader).
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/index.test.ts
 *
 * pi's extension loader really loads `index.ts` (so the `./plan.ts` / `./plan-text.ts` /
 * `./render.ts` imports and the registered surface are covered); everything outside the
 * extension is faked: ctx (recording setStatus / notify / select / onTerminalInput / isIdle),
 * pi's API (recording setActiveTools / appendEntry), and the session entries.
 *
 * What is covered is **the wiring**, not the pure logic (plan.test.ts / plan-text.test.ts /
 * render.test.ts cover that). So assertions concentrate on: who changed the active tools when,
 * what the status row says, when shift+tab gets consumed, when write commands get blocked,
 * when a write triggers auto-wrap-up. Render details are not re-tested here.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { THINKING_FALLBACK_KEY } from "./keybinding.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "could not find the local pi library entry (requires an installed pi)";

/** The approval dialog's three choices (same values as index.ts's constants). */
const CHOICE_EXECUTE = "Write plan and implement";
const CHOICE_DOC_ONLY = "Write plan only";
const CHOICE_REJECT = "Request changes";

/**
 * pi's library entry (not the CLI): bundle is the shape `pi` actually runs, dist is the node
 * build shape.
 * The check is **whether it really imports** (the `~/.pi/agent/npm` copy may be a hollow
 * shell); all failing → skip wholesale, never fake a pass. Same approach as
 * working-indicator/index.test.ts.
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
			// not a symlink: look at the shim script below
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
type InputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

interface LoadedExtension {
	handlers: Map<string, Handler[]>;
	tools: Map<string, unknown>;
	shortcuts: Map<string, unknown>;
	flags: Map<string, unknown>;
	errors: Array<{ path: string; error: string }>;
	/** Test-attached: the real active-tools array (what runtime.getActiveTools reads). */
	__activeTools: string[];
	__runtime: RuntimeLike;
}

/** The default active tools: pi's write tools plus two fake extension/MCP tools. */
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "ls", "task_set", "mcp__x__y"];

function createTestBus(rec?: Recorder): {
	emit: (channel: string, data: unknown) => void;
	on: (channel: string, handler: (data: unknown) => void) => () => void;
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
			rec?.emits.push({ channel, data });
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
}

async function loadExtension(
	agentDir: string,
	projectDir: string,
	rec: Recorder,
	flagValues?: Map<string, unknown>,
): Promise<LoadedExtension> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{
			extensions: LoadedExtension[];
			errors: Array<{ path: string; error: string }>;
			runtime: RuntimeLike;
		}>;
	};

	// load the extension with pi's own loader, grab the runtime it shares, then hook the action methods.
	// the test then walks the same path the extension really calls (`pi.setActiveTools()` lands on our recorder),
	// instead of fabricating a fake pi object — a fake cannot verify "is the extension really calling pi's API".
	const bus = createTestBus(rec);
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, bus);
	assert.deepEqual(loaded.errors, [], "pi's extension loader must not error");
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.ok(extension);

	const active: string[] = [...DEFAULT_TOOLS];
	Object.assign(loaded.runtime, {
		sendMessage: async (message: { content: string }) => {
			rec.messages.push(message);
		},
		sendUserMessage: async () => {},
		appendEntry: (customType: string, data: unknown) => {
			rec.entries.push({ customType, data });
		},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [...active],
		getAllTools: () => [],
		setActiveTools: (names: string[]) => {
			active.length = 0;
			active.push(...names);
			rec.toolSets.push([...names]);
		},

		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => true,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
	});

	// `pi.getFlag()` reads runtime.flagValues; defaults were written when the extension registered its flags,
	// so only the entries the test explicitly specifies need overriding here.
	if (flagValues) {
		for (const [name, value] of flagValues) loaded.runtime.flagValues?.set(name, value);
	}

	extension.__activeTools = active;
	extension.__runtime = loaded.runtime;
	return extension;
}

interface RuntimeLike {
	flagValues?: Map<string, unknown>;
	setActiveTools?: (names: string[]) => void;
}

interface Recorder {
	/** One record per setStatus as `key=value` (undefined recorded as `key=<undefined>`). */
	statuses: string[];
	notifies: string[];
	/** Recorded tool-set changes, in order of occurrence. */
	toolSets: string[][];
	entries: Array<{ customType: string; data: unknown }>;
	messages: Array<{ content: string }>;
	/** Events the extension broadcast (now only one-shot actions at registration — no mirrored sync). */
	emits: Array<{ channel: string; data: unknown }>;
	/** The titles handed to select dialogs (incl. the plan body). */
	selectTitles: string[];
}

interface ContextOptions {
	hasUI?: boolean;
	mode?: string;
	idle?: boolean;
	/** The select dialog's return (defaults to the recommended "write plan and implement"; undefined = user pressed esc). */
	selectResult?: string;
	/** Pre-existing active tools (default: a list including extension tools). */
	activeTools?: string[];
	/** Entries the sessionManager returns; both `getBranch()` and `getEntries()` read it. */
	entries?: unknown[];
	flagValues?: Map<string, unknown>;
}

function makeContext(extension: LoadedExtension, recorder: Recorder, options: ContextOptions = {}) {
	const inputHandlers: InputHandler[] = [];

	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		cwd: "/repo",
		isIdle: () => options.idle ?? true,
		sessionManager: {
			getEntries: () => options.entries ?? [],
			getBranch: () => options.entries ?? [],
		},
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				strikethrough: (text: string) => text,
			},
			setStatus: (key: string, value: string | undefined) => {
				recorder.statuses.push(`${key}=${value === undefined ? "<undefined>" : value}`);
			},
			notify: (message: string) => {
				recorder.notifies.push(message);
			},
			select: async (title: string, choices: string[]) => {
				recorder.selectTitles.push(title);
				// explicitly passing undefined = user pressed esc (select returns undefined);
				// omitting the field takes the default = pressing enter (the first item, the recommended route).
				// For the approval box that equals CHOICE_EXECUTE (first item anyway); for the consent box it is the correct
				// CONSENT_PLAN. Hard-coding CHOICE_EXECUTE would make the consent box's default wrongly "write plan and implement".
				return "selectResult" in options ? options.selectResult : (choices[0] ?? undefined);
			},
			onTerminalInput: (handler: InputHandler) => {
				inputHandlers.push(handler);
				return () => {
					const index = inputHandlers.indexOf(handler);
					if (index !== -1) inputHandlers.splice(index, 1);
				};
			},
		},
		/**
 * Test-only: broadcast one keystroke the way pi really does — every registered listener
 * receives it, and any `consume` short-circuits (the semantics of `TuiBase.handleTerminalInput`).
 * So "duplicate registration" cannot hide here: registering twice would toggle twice.
 */
		__feedInput: (data: string) => {
			for (const handler of [...inputHandlers]) {
				const result = handler(data);
				if (result?.consume) return result;
			}
			return undefined;
		},
		/** Test-only: how many listeners are currently registered (verifies the reentrancy guard). */
		__listenerCount: () => inputHandlers.length,
	};

	return { ctx, getActiveTools: () => [...extension.__activeTools] };
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-mode-"));
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

function recorder(): Recorder {
	return { statuses: [], notifies: [], toolSets: [], entries: [], messages: [], emits: [], selectTitles: [] };
}

function handlerOf(extension: LoadedExtension, name: string): Handler {
	const handler = extension.handlers.get(name)?.[0];
	assert.ok(handler, `should have registered ${name}`);
	return handler;
}

interface RegisteredTool {
	definition: {
		name: string;
		execute: (
			toolCallId: string,
			params: unknown,
			signal: unknown,
			onUpdate: unknown,
			ctx: unknown,
		) => Promise<unknown>;
	};
}

/** Get a registered tool definition (pi stores `{ definition, sourceInfo }`). */
function toolOf(extension: LoadedExtension, name: string): RegisteredTool {
	const tool = extension.tools.get(name);
	assert.ok(tool, `should have registered tool ${name}`);
	return tool as RegisteredTool;
}

/** Invoke a tool (`execute` lives on `definition`). */
function callTool(
	extension: LoadedExtension,
	name: string,
	params: unknown,
	ctx: unknown,
): Promise<{ content: Array<{ text: string }>; details?: unknown }> {
	const tool = toolOf(extension, name);
	return tool.definition.execute("call-1", params, undefined, undefined, ctx) as Promise<{
		content: Array<{ text: string }>;
		details?: unknown;
	}>;
}

const sessionStart = (extension: LoadedExtension, ...args: Parameters<Handler>) => handlerOf(extension, "session_start")(...args);
const beforeAgentStart = (extension: LoadedExtension, ...args: Parameters<Handler>) => handlerOf(extension, "before_agent_start")(...args);
const toolCall = (extension: LoadedExtension, ...args: Parameters<Handler>) => handlerOf(extension, "tool_call")(...args);
const toolResult = (extension: LoadedExtension, ...args: Parameters<Handler>) => handlerOf(extension, "tool_result")(...args);

/** Start a session (session_start + before_agent_start — the first half of a full turn). */
async function startSession(
	extension: LoadedExtension,
	recorder: Recorder,
	options: ContextOptions = {},
): Promise<SessionHarness> {
	setActiveToolsOf(extension, options.activeTools ?? DEFAULT_TOOLS);
	const harness = makeContext(extension, recorder, options);
	await sessionStart(extension, { reason: "startup" }, harness.ctx);
	await beforeAgentStart(extension, { prompt: "hi", systemPrompt: "", systemPromptOptions: {} }, harness.ctx);
	return harness;
}

interface SessionHarness {
	ctx: Record<string, unknown> & { __feedInput: (data: string) => { consume?: boolean } | undefined };
	getActiveTools: () => string[];
}

/** Set pi's active tool table to the given value (simulating the load result at session start). */
function setActiveToolsOf(extension: LoadedExtension, tools: string[]): void {
	extension.__runtime.setActiveTools?.(tools);
}

/** Pull the pinned doc path out of exit_plan_mode's tool result (the first backtick pair). */
function docPathFrom(result: { content: Array<{ text: string }> }): string {
	const match = /`([^`]+)`/.exec(result.content[0]!.text);
	assert.ok(match, `the tool result should carry the doc path; got: ${result.content[0]!.text}`);
	return match[1]!;
}

const PLAN = "# Plan\n\nChange plan.ts and render.ts.";

/** Enter plan and submit a plan; return the post-approval tool result. */
async function submitPlan(
	extension: LoadedExtension,
	harness: SessionHarness,
	options: { summary?: string; slug?: string } = {},
): Promise<{ content: Array<{ text: string }>; details?: unknown }> {
	harness.ctx.__feedInput("\x1b[Z");
	return callTool(
		extension,
		"exit_plan_mode",
		{ plan: PLAN, slug: options.slug ?? "fix-two-files", summary: options.summary ?? "change two files" },
		harness.ctx,
	);
}

// =============================================================================
// Loading and registration surface
// =============================================================================

test("the extension loads under pi's loader and registers two tools plus one command", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		assert.ok(extension.tools.has("enter_plan_mode"), "should register enter_plan_mode");
		assert.ok(extension.tools.has("exit_plan_mode"), "should register exit_plan_mode");
		assert.equal(extension.shortcuts.size, 0, "shift+tab goes through raw-input interception — no shortcut should be registered");
		assert.ok(extension.flags.has("plan"), "should register the --plan flag");
		assert.ok(extension.handlers.has("tool_result"), "should register the tool_result hook (doc-write auto wrap-up)");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// shift+tab
// =============================================================================

test("shift+tab while idle enters plan and is consumed; write tools removed, extension tools kept", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = harness.ctx.__feedInput("\x1b[Z");

		assert.deepEqual(result, { consume: true }, "shift+tab must be consumed or it lands on the editor");
		assert.deepEqual(harness.getActiveTools(), ["read", "bash", "grep", "ls", "task_set", "mcp__x__y"]);
		assert.ok(rec.statuses.at(-1)?.includes("plan"), `the status row should show plan; got ${rec.statuses.at(-1)}`);
	} finally {
		workspace.cleanup();
	}
});

test("all three shift+tab encodings toggle (bare CSI / Kitty CSI-u / modifyOtherKeys)", { skip, timeout: 30_000 }, async () => {
	// regression: `shift+tab` has three encodings, and a hardcoded compare for one of them goes fully dead on terminals with the Kitty keyboard protocol
	// (hit for real: worked in a pty, no response to shift+tab in a real Ghostty). Must go through pi's own matchesKey.
	const encodings: Array<[string, string]> = [
		["bare CSI", "\x1b[Z"],
		["Kitty CSI-u", "\x1b[9;2u"],
		["xterm modifyOtherKeys", "\x1b[27;2;9~"],
	];
	for (const [label, sequence] of encodings) {
		const workspace = makeWorkspace();
		try {
			const rec = recorder();
			const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
			const harness = await startSession(extension, rec);

			const result = harness.ctx.__feedInput(sequence);
			assert.deepEqual(result, { consume: true }, `${label} should be consumed`);
			assert.ok(!harness.getActiveTools().includes("write"), `${label} should enter plan`);
			assert.match(rec.statuses.at(-1) ?? "", /plan/, `${label} the status row should show plan`);
		} finally {
			workspace.cleanup();
		}
	}
});

test("pressing shift+tab again exits, and the active tools restore verbatim", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		const before = harness.getActiveTools();

		harness.ctx.__feedInput("\x1b[Z");
		harness.ctx.__feedInput("\x1b[Z");

		assert.deepEqual(harness.getActiveTools(), before, "exit must restore verbatim (incl. extension tools)");
		assert.match(rec.statuses.at(-1) ?? "", /⏵ bypass/, "back to the bypass mode indicator after exit");
	} finally {
		workspace.cleanup();
	}
});

test("repeated session_start does not stack listeners (one shift+tab toggles once)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec);

		// /reload, /new, /resume each run session_start again.
		await sessionStart(extension, { reason: "startup" }, harness.ctx);
		await sessionStart(extension, { reason: "reload" }, harness.ctx);
		await sessionStart(extension, { reason: "new" }, harness.ctx);

		// after three session_starts there is still exactly one registered listener — otherwise pi's broadcast would toggle multiple times.
		const count = (harness.ctx as unknown as { __listenerCount: () => number }).__listenerCount();
		assert.equal(count, 1, `listeners must not stack; registered: ${count}`);

		// one shift+tab toggles exactly once → into plan (not twice, back to bypass).
		const result = harness.ctx.__feedInput("\x1b[Z");
		assert.deepEqual(result, { consume: true });
		assert.ok(!harness.getActiveTools().includes("write"), "one keypress should toggle exactly once: should end in plan");
		const status = rec.statuses.at(-1) ?? "";
		assert.ok(status.includes("plan"), `the status row should be plan; got ${status}`);
	} finally {
		workspace.cleanup();
	}
});

test("other keys and busy state are not stolen (not consumed)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);

		// an ordinary character
		const busy = await startSession(extension, rec);
		assert.equal(busy.ctx.__feedInput("a"), undefined);
		assert.equal(busy.ctx.__feedInput("tab"), undefined, "a bare tab is not shift+tab");
		assert.deepEqual(busy.getActiveTools(), busy.getActiveTools(), "the tool table must not change");

		// while streaming (not idle): let pi's thinking-level cycle work as usual
		const streaming = await startSession(extension, rec, { idle: false });
		assert.equal(streaming.ctx.__feedInput("\x1b[Z"), undefined, "keys are not stolen while busy");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// Model-initiated auto-enter
// =============================================================================

test("the enter_plan_mode tool lets the model enter plan itself and returns an explanation", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = await callTool(extension, "enter_plan_mode", { reason: "multiple files to change" }, harness.ctx);

		assert.match(result.content[0]!.text, /Entered plan mode/);
		assert.match(result.content[0]!.text, /exit_plan_mode/, "the model must be told how to exit");
		assert.ok(!harness.getActiveTools().includes("write"), "write tools must be disabled after entering plan");
		// the model path goes through the consent dialog first (default enter = accept)
		assert.equal(rec.selectTitles.length, 1, "the model path should show one consent dialog");
		assert.match(rec.selectTitles[0]!, /model requests plan mode/, "the dialog must say the model requested it");
		assert.ok(rec.selectTitles[0]!.includes("multiple files to change"), "the model's reason should be visible in the dialog");
	} finally {
		workspace.cleanup();
	}
});

test("consent box picks \"implement directly\": no plan entry, write tools stay, model told not to call again", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, { selectResult: "Implement directly" });

		const result = await callTool(extension, "enter_plan_mode", { reason: "multiple files to change" }, harness.ctx);

		assert.match(result.content[0]!.text, /without entering plan mode/, "must say clearly it did not enter");
		assert.match(result.content[0]!.text, /do not call again/, "must stop the model from retrying");
		assert.ok(harness.getActiveTools().includes("write"), "write tools must stay untouched after a decline");
		assert.equal(rec.selectTitles.length, 1, "only this one dialog");
	} finally {
		workspace.cleanup();
	}
});

test("pressing esc on the consent box: same as declining (CC's must consent)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, { selectResult: undefined });

		const result = await callTool(extension, "enter_plan_mode", { reason: "multiple files to change" }, harness.ctx);

		assert.match(result.content[0]!.text, /without entering plan mode/);
		assert.ok(harness.getActiveTools().includes("write"), "write tools must stay untouched after esc");
	} finally {
		workspace.cleanup();
	}
});

test("user paths (shift+tab / --plan) show no consent dialog — that is already the user's decision", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = harness.ctx.__feedInput("\x1b[Z");
		assert.deepEqual(result, { consume: true });
		assert.equal(rec.selectTitles.length, 0, "shift+tab should not show a dialog");
		assert.ok(!harness.getActiveTools().includes("write"), "should enter plan directly");
	} finally {
		workspace.cleanup();
	}

	const workspace2 = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace2.agentDir, workspace2.projectDir, rec, new Map([["plan", true]]));
		const harness = makeContext(extension, rec);
		await sessionStart(extension, { reason: "startup" }, harness.ctx);
		assert.equal(rec.selectTitles.length, 0, "--plan should not show a dialog");
		assert.ok(!harness.getActiveTools().includes("edit"), "--plan should enter plan directly");
	} finally {
		workspace2.cleanup();
	}
});

test("PI_PLAN_MODE_CONSENT=off: no dialog, enter directly (back to old behavior)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	process.env.PI_PLAN_MODE_CONSENT = "off";
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = await callTool(extension, "enter_plan_mode", { reason: "multiple files to change" }, harness.ctx);

		assert.match(result.content[0]!.text, /Entered plan mode/);
		assert.equal(rec.selectTitles.length, 0, "no dialog with CONSENT=off");
		assert.ok(!harness.getActiveTools().includes("write"), "should enter plan directly");
	} finally {
		delete process.env.PI_PLAN_MODE_CONSENT;
		workspace.cleanup();
	}
});

test("the tool description carries the full routing criteria: positive conditions + exemption list", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		await startSession(extension, rec);

		const tool = toolOf(extension, "enter_plan_mode");
		const desc = (tool.definition as unknown as { description: string }).description;
		// positive conditions (the quantified thresholds and the ask_user_question rule from CC's 7)
		assert.match(desc, /more than 2-3 files/, "the multi-file threshold must be stated");
		assert.match(desc, /ask_user_question/, "the ask_user_question relationship must be explained");
		// the exemption list (the two measured false-positive sources — pinned so nobody deletes them casually)
		assert.match(desc, /detailed unambiguous user instructions/, "small changes with detailed unambiguous user instructions must be exempt");
		assert.match(desc, /pure research/, "pure research / report writing must be exempt");
		// the consent mechanism's self-description (the premise for "call it when unsure")
		assert.match(desc, /Requires user consent/, "the model must be told the user can veto this tool");
	} finally {
		workspace.cleanup();
	}
});

test("the --plan flag starts the session already in plan", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec, new Map([["plan", true]]));
		const harness = makeContext(extension, rec);

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		assert.ok(!harness.getActiveTools().includes("edit"), "--plan should remove the write tools");
		assert.ok(rec.notifies.some((message) => message.includes("plan mode")), "should report having entered");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// exit_plan_mode: the three choices
// =============================================================================

test("submitting a plan: the dialog is a select with three choices and the full plan in the title", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		await submitPlan(extension, harness);

		assert.equal(rec.selectTitles.length, 1, "one approval dialog should appear");
		assert.match(rec.selectTitles[0]!, /Approve this plan/, "the title must ask for approval");
		assert.ok(rec.selectTitles[0]!.includes(PLAN), "the full plan must be visible in the dialog");
	} finally {
		workspace.cleanup();
	}
});

test("picking \"write plan and implement\": enters the doc-writing sub-state — write restored, edit still removed, path pinned", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = await submitPlan(extension, harness, { slug: "fix-two-files" });

		const docPath = docPathFrom(result);
		assert.match(docPath, /\/repo\/\.pi\/plans\/\d{4}-\d{2}-\d{2}-fix-two-files\.md$/, "the path is cwd + date + English slug");
		assert.match(result.content[0]!.text, /approved/);
		assert.match(result.content[0]!.text, /write tool/, "the model must be taught to write the file via write");

		const tools = harness.getActiveTools();
		assert.ok(tools.includes("write"), "the sub-state must restore write");
		assert.ok(!tools.includes("edit"), "edit stays removed");
		assert.ok(!tools.includes("powershell"), "powershell stays removed");
		assert.match(rec.statuses.at(-1) ?? "", /writing document/, "the status row should show the doc-writing sub-state");

		// the persisted entry pins both path and route (must not be recomputed after /resume)
		const last = rec.entries.at(-1)!.data as Record<string, unknown>;
		assert.equal(last.docWriting, true);
		assert.equal(last.docMode, "execute-with-doc");
		assert.equal(last.pendingDocPath, docPath);
	} finally {
		workspace.cleanup();
	}
});

test("picking \"write plan only\": the route is recorded as doc-only", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, { selectResult: CHOICE_DOC_ONLY });

		await submitPlan(extension, harness);

		const last = rec.entries.at(-1)!.data as Record<string, unknown>;
		assert.equal(last.docMode, "doc-only");
		assert.equal(last.docWriting, true);
	} finally {
		workspace.cleanup();
	}
});

test("picking \"request changes\" or esc: stays in plan (read-only), and the model is asked to revise", { skip, timeout: 30_000 }, async () => {
	for (const selectResult of [CHOICE_REJECT, undefined]) {
		const workspace = makeWorkspace();
		try {
			const rec = recorder();
			const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
			const harness = await startSession(extension, rec, { selectResult });

			const result = await submitPlan(extension, harness);

			assert.match(result.content[0]!.text, /did not approve/);
			assert.ok(!harness.getActiveTools().includes("write"), "still read-only after a rejection");
			assert.match(rec.statuses.at(-1) ?? "", /plan/, "still in plan state");
		} finally {
			workspace.cleanup();
		}
	}
});

test("a non-interactive run (pi -p) auto-takes the recommended route — no deadlock", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, { hasUI: false });

		const result = await submitPlan(extension, harness);

		assert.equal(rec.selectTitles.length, 0, "no dialog should appear without UI");
		const last = rec.entries.at(-1)!.data as Record<string, unknown>;
		assert.equal(last.docMode, "execute-with-doc", "auto-picks the recommended route");
		assert.ok(docPathFrom(result).includes(".pi/plans/"));
	} finally {
		workspace.cleanup();
	}
});

test("calling exit_plan_mode outside plan: a clear refusal, state unchanged", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = await callTool(extension, "exit_plan_mode", { plan: PLAN }, harness.ctx);
		assert.match(result.content[0]!.text, /Not in plan mode/);
		assert.equal(rec.selectTitles.length, 0, "no approval dialog should appear");
	} finally {
		workspace.cleanup();
	}
});

test("an empty plan is rejected", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");

		const result = await callTool(extension, "exit_plan_mode", { plan: "   " }, harness.ctx);
		assert.match(result.content[0]!.text, /empty/);
		assert.equal(rec.selectTitles.length, 0);
	} finally {
		workspace.cleanup();
	}
});

test("calling exit_plan_mode inside the doc-writing sub-state: told to go write the file, no dialog", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		await submitPlan(extension, harness);
		rec.selectTitles.length = 0;

		const result = await callTool(extension, "exit_plan_mode", { plan: PLAN }, harness.ctx);

		assert.match(result.content[0]!.text, /writing the plan document/);
		assert.match(result.content[0]!.text, /do not call again/);
		assert.equal(rec.selectTitles.length, 0, "no approval dialog inside the sub-state");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// the doc-writing sub-state's write gate
// =============================================================================

test("doc-writing sub-state: write may only target the pinned path", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		const approved = await submitPlan(extension, harness);
		const docPath = docPathFrom(approved);

		const allowed = await toolCall(
			extension,
			{ toolName: "write", toolCallId: "w1", input: { path: docPath, content: "# Plan" } },
			harness.ctx,
		);
		assert.equal(allowed, undefined, "writing the plan document itself must pass");

		const blocked = (await toolCall(
			extension,
			{ toolName: "write", toolCallId: "w2", input: { path: "/repo/src/index.ts", content: "x" } },
			harness.ctx,
		)) as { block?: boolean; reason?: string };
		assert.equal(blocked.block, true, "writing another file must be blocked");
		assert.match(blocked.reason ?? "", /Only the plan document/);
		assert.ok((blocked.reason ?? "").includes(docPath), "the refusal must name the correct path");
	} finally {
		workspace.cleanup();
	}
});

test("plain plan state (no sub-state): write is double-gated", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");

		const blocked = (await toolCall(
			extension,
			{ toolName: "write", toolCallId: "w3", input: { path: "/repo/a.txt", content: "x" } },
			harness.ctx,
		)) as { block?: boolean; reason?: string };
		assert.equal(blocked.block, true, "write already removed from the table; the hook gates once more");
		assert.match(blocked.reason ?? "", /Files cannot be written during planning/);
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// tool_result auto wrap-up
// =============================================================================

test("a successful write on the matching path: auto wrap-up to bypass, tools restored, wrap-up instruction replaces the tool result", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		const before = harness.getActiveTools();
		const approved = await submitPlan(extension, harness);
		const docPath = docPathFrom(approved);

		const replaced = (await toolResult(
			extension,
			{
				toolName: "write",
				toolCallId: "w1",
				input: { path: docPath, content: "# Plan" },
				content: [{ type: "text", text: "Successfully wrote 5 bytes" }],
				isError: false,
			},
			harness.ctx,
		)) as { content: Array<{ text: string }> } | undefined;

		assert.ok(replaced, "write's normal success text should be replaced");
		const text = replaced.content[0]!.text;
		assert.ok(text.includes(docPath), "the wrap-up instruction must report the doc path");
		assert.match(text, /Follow this document/, "the execute-with-doc route sends the model onward");
		assert.match(text, /task_set/, "building a list is the model's call, but the tool must be mentioned");

		assert.deepEqual(harness.getActiveTools(), before, "the tool table returns to its pre-entry shape after wrap-up");
		assert.match(rec.statuses.at(-1) ?? "", /⏵ bypass/, "state back to bypass");
		assert.ok(rec.notifies.some((message) => message.includes(docPath)), "the notify must report the path");

		const last = rec.entries.at(-1)!.data as Record<string, unknown>;
		assert.equal(last.phase, "bypass");
		assert.equal(last.docWriting, undefined);
	} finally {
		workspace.cleanup();
	}
});

test("doc-only wrap-up: the instruction is \"stop\", not \"implement\"", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, { selectResult: CHOICE_DOC_ONLY });
		const approved = await submitPlan(extension, harness);
		const docPath = docPathFrom(approved);

		const replaced = (await toolResult(
			extension,
			{
				toolName: "write",
				toolCallId: "w1",
				input: { path: docPath, content: "# Plan" },
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
			harness.ctx,
		)) as { content: Array<{ text: string }> };

		const text = replaced.content[0]!.text;
		assert.match(text, /stop now/);
		assert.match(text, /Do not change code/);
		assert.ok(!text.includes("Follow this document"), "the two routes' instructions must not cross");
		assert.match(rec.statuses.at(-1) ?? "", /⏵ bypass/, "doc-only also returns to bypass");
	} finally {
		workspace.cleanup();
	}
});

test("write failed / wrong path / not write: none of them wrap up", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		const approved = await submitPlan(extension, harness);
		const docPath = docPathFrom(approved);

		const cases = [
			["write failed", { toolName: "write", toolCallId: "w1", input: { path: docPath }, content: [], isError: true }],
			["wrong path", { toolName: "write", toolCallId: "w2", input: { path: "/repo/other.md" }, content: [], isError: false }],
			["not write", { toolName: "bash", toolCallId: "w3", input: { command: "ls" }, content: [], isError: false }],
		] as const;
		for (const [label, event] of cases) {
			const result = await toolResult(extension, event, harness.ctx);
			assert.equal(result, undefined, `${label} must not trigger wrap-up`);
			assert.ok(!harness.getActiveTools().includes("edit"), `${label} must stay read-only`);
		}
		assert.match(rec.statuses.at(-1) ?? "", /writing document/, "the status row still shows the doc-writing sub-state");
	} finally {
		workspace.cleanup();
	}
});

test("a write result in bypass triggers no hook action", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = await toolResult(
			extension,
			{ toolName: "write", toolCallId: "w1", input: { path: "/repo/a.md" }, content: [], isError: false },
			harness.ctx,
		);
		assert.equal(result, undefined);
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// write interception (bash)
// =============================================================================

test("write-class bash in plan is blocked and the reason goes back to the model; read-only commands pass", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");

		const blocked = (await toolCall(
			extension,
			{ toolName: "bash", toolCallId: "t1", input: { command: "rm -rf dist" } },
			harness.ctx,
		)) as { block?: boolean; reason?: string };
		assert.equal(blocked.block, true);
		assert.match(blocked.reason ?? "", /plan mode/);
		assert.match(blocked.reason ?? "", /exit_plan_mode/, "the model must be told the right way forward");

		const allowed = await toolCall(
			extension,
			{ toolName: "bash", toolCallId: "t2", input: { command: "git status" } },
			harness.ctx,
		);
		assert.equal(allowed, undefined, "read-only commands must not be blocked");
	} finally {
		workspace.cleanup();
	}
});

test("bash writes stay blocked inside the doc-writing sub-state (only the write tool was let back)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		await submitPlan(extension, harness);

		const blocked = (await toolCall(
			extension,
			{ toolName: "bash", toolCallId: "t3", input: { command: "echo x > /repo/.pi/plans/a.md" } },
			harness.ctx,
		)) as { block?: boolean };
		assert.equal(blocked.block, true, "a redirect write to the doc path fails too — only the write tool counts");
	} finally {
		workspace.cleanup();
	}
});

test("write commands are not blocked in bypass", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		assert.equal(await toolCall(extension, { toolName: "bash", toolCallId: "t4", input: { command: "rm -rf dist" } }, harness.ctx), undefined);
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// Session restore
// =============================================================================

function planEntry(data: Record<string, unknown>) {
	return { type: "custom", customType: "plan-mode", data };
}

test("session restore: plan state comes back from session entries, the tool table shrinks with it", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec, {
			entries: [planEntry({ phase: "plan", pending: PLAN, toolsBeforePlan: DEFAULT_TOOLS })],
		});

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		assert.ok(!harness.getActiveTools().includes("write"), "a restored plan state must shrink the tools");
		assert.match(rec.statuses.at(-1) ?? "", /plan/);
	} finally {
		workspace.cleanup();
	}
});

test("session restore: the doc-writing sub-state comes back (write present, edit gone); the next round injects the doc-writing instruction", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const docPath = "/repo/.pi/plans/2026-09-24-resume.md";
		const harness = makeContext(extension, rec, {
			entries: [
				planEntry({
					phase: "plan",
					pending: PLAN,
					toolsBeforePlan: DEFAULT_TOOLS,
					docMode: "execute-with-doc",
					docWriting: true,
					pendingDocPath: docPath,
					planSummary: "resume",
				}),
			],
		});

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		const tools = harness.getActiveTools();
		assert.ok(tools.includes("write"), "write must be present after a sub-state restore");
		assert.ok(!tools.includes("edit"), "edit stays removed");

		const injected = (await beforeAgentStart(
			extension,
			{ prompt: "continue", systemPrompt: "", systemPromptOptions: {} },
			harness.ctx,
		)) as { message?: { customType: string; content: string } } | undefined;
		assert.equal(injected?.message?.customType, "plan-doc-write-context");
		assert.ok((injected?.message?.content ?? "").includes(docPath), "the doc-writing instruction must carry the pinned path");
		assert.ok((injected?.message?.content ?? "").includes(PLAN), "the doc-writing instruction must carry the full plan");
	} finally {
		workspace.cleanup();
	}
});

test("session restore: legacy phase \"normal\" / \"execute\" both map to bypass", { skip, timeout: 30_000 }, async () => {
	// `normal` is the pre-2026-09-23 name; `execute` is the state deleted on 2026-09-24.
	// both restore as bypass: the whitelist check backstops every historical value.
	for (const phase of ["normal", "execute"]) {
		const workspace = makeWorkspace();
		try {
			const rec = recorder();
			const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
			const harness = makeContext(extension, rec, {
				entries: [planEntry({ phase, steps: [{ step: 1, text: "old steps", done: false }] })],
			});

			await sessionStart(extension, { reason: "startup" }, harness.ctx);

			assert.match(rec.statuses.at(-1) ?? "", /⏵ bypass/, `phase=${phase} should restore as bypass`);
			assert.deepEqual(harness.getActiveTools(), DEFAULT_TOOLS, "tools must not be shrunk");
		} finally {
			workspace.cleanup();
		}
	}
});

test("session restore: a step-array pending in an old entry is dropped (only string plans count)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec, {
			entries: [planEntry({ phase: "plan", pending: [{ step: 1, text: "old steps" }], toolsBeforePlan: DEFAULT_TOOLS })],
		});

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		assert.match(rec.statuses.at(-1) ?? "", /⏸ plan$/, "no pending — \"awaiting approval\" must not show");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// Context injection and filtering
// =============================================================================

test("plan injects the read-only context (display: false); bypass filters it out", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");

		const injected = (await beforeAgentStart(
			extension,
			{ prompt: "hi", systemPrompt: "", systemPromptOptions: {} },
			harness.ctx,
		)) as { message?: { customType: string; content: string; display: boolean } } | undefined;
		assert.equal(injected?.message?.customType, "plan-mode-context");
		assert.equal(injected?.message?.display, false, "invisible to the user, visible to the model");
		assert.match(injected?.message?.content ?? "", /\[PLAN MODE\]/);

		// after exiting, these injected messages must be filtered out of the context (the model must not see stale instructions)
		harness.ctx.__feedInput("\x1b[Z");
		const contextHandler = handlerOf(extension, "context");
		const filtered = (await contextHandler(
			{
				messages: [
					{ customType: "plan-mode-context", content: "x" },
					{ customType: "plan-doc-write-context", content: "y" },
					{ role: "user", content: "hi" },
				],
			},
			harness.ctx,
		)) as { messages: Array<{ customType?: string; role?: string }> };
		assert.equal(filtered.messages.length, 1, "both kinds of plan injection should be filtered");
		assert.equal(filtered.messages[0]!.role, "user");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// Thinking-key rebinding
// =============================================================================

test("at startup the thinking cycle is rebound to the fallback key (written into the agentDir's keybindings.json)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec);

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		const file = path.join(workspace.agentDir, "keybindings.json");
		assert.ok(fs.existsSync(file), "keybindings.json should be written");
		const bindings = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(bindings["app.thinking.cycle"], THINKING_FALLBACK_KEY);
		assert.ok(rec.notifies.some((message) => message.includes(THINKING_FALLBACK_KEY)), "the first rebind notifies once");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		workspace.cleanup();
	}
});

test("other bindings are preserved when keybindings.json already exists", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		const rec = recorder();
		const file = path.join(workspace.agentDir, "keybindings.json");
		fs.writeFileSync(file, JSON.stringify({ "app.thinking.cycle": "ctrl+shift+t", "editor.undo": "ctrl+z" }));
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec);

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		const bindings = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(bindings["editor.undo"], "ctrl+z", "other bindings kept verbatim");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		workspace.cleanup();
	}
});

test("startup does not touch the file when the user configured the thinking cycle themselves", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		const rec = recorder();
		const file = path.join(workspace.agentDir, "keybindings.json");
		fs.writeFileSync(file, JSON.stringify({ "app.thinking.cycle": "ctrl+alt+t" }));
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec);

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		const bindings = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(bindings["app.thinking.cycle"], "ctrl+alt+t", "the user's choice wins");
		assert.ok(!rec.notifies.some((message) => message.includes("remap")), "must not notify");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		workspace.cleanup();
	}
});

test("a previous rebind (already on the fallback) stays silent at startup", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		const rec = recorder();
		const file = path.join(workspace.agentDir, "keybindings.json");
		fs.writeFileSync(file, JSON.stringify({ "app.thinking.cycle": THINKING_FALLBACK_KEY }));
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec);

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		assert.ok(!rec.notifies.some((message) => message.includes("remap")), "already bound → must not notify again");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		workspace.cleanup();
	}
});
