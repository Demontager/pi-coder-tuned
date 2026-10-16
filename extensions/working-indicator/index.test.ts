/**
 * Tests for working-indicator/index.ts — the "overlong prompt asynchronously asks the model to
 * compress it to one line" path.
 *
 * Run with:  node --test clients/pi/extensions/working-indicator/index.test.ts
 *
 * pi's own extension loader really loads `index.ts` (so the `./summary-request.ts` import and
 * the registered event surface are covered); everything outside the extension is faked: ctx
 * (recording `setWorkingMessage` and `modelRegistry.complete`) and the other end of the event
 * bus. Model calls are manually resolved promises, so timings like "the old request returns
 * after the new prompt is already in place" can be staged exactly.
 *
 * Terminal width: `process.stdout.columns` is undefined in the test process, so
 * `terminalWidth()` falls back to 80; the available width becomes min(40 - 2, 76 - 34 - 1 - 2)
 * = 38 columns and the trigger line is 38 (default ratio 1 — one column over and it requests).
 * The long prompts in these cases are far above it, the short ones far below.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	DEFAULT_FRAMES_PER_COLOR,
	SPINNER_COLOR_TOKENS,
	SPINNER_FRAMES,
	SPINNER_INTERVAL_MS,
} from "./spinner-frames.ts";

/**
 * Retry delay for a failed summary (matches the `PI_WORKING_SUMMARY_RETRY_MS` value set below).
 * Cases assert in two halves on it: "no retry inside the delay" / "one retry after". 300ms is
 * an order of magnitude faster than the 3s default, yet comfortable enough that slow-machine
 * scheduling jitter cannot flake it.
 */
const RETRY_DELAY_MS = 300;
// index.ts's retry delay is a **module-level constant** — it must be set before the extension is first loaded (pi's loader
// reads it only once); every case below shares this value.
process.env.PI_WORKING_SUMMARY_RETRY_MS = String(RETRY_DELAY_MS);

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "could not find the local pi library entry (requires an installed pi)";

/**
 * pi's library entry (not the CLI): bundle is the shape `pi` actually runs, dist is the node
 * build shape.
 *
 * First back-track from the `pi` executable to **the real install location** (pnpm/npm shim
 * scripts keep a `# cmd-shim-target=<abs path>` line; npm is a symlink on Unix — both tried),
 * then fall back to the `~/.pi/agent/npm` copy — the latter is **the extension packages'
 * install root**, and `pi update --extensions` prunes the auto-installed `@earendil-works/pi-*`
 * companions with `--config.auto-install-peers=false`, leaving that copy a hollow shell (files
 * present, imports fail with `ERR_MODULE_NOT_FOUND`; hit for real upgrading pi-subagents
 * 0.68.0 in 2026-09).
 *
 * The check is **whether it really imports**, not whether the path exists — only an actual
 * import distinguishes the hollow shell. If all fail → undefined, and the caller skips
 * wholesale (never fakes a pass).
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
			// not a symlink / does not exist: look at the shim script below
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

interface TestBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

function createTestBus(): TestBus {
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

/** The record of one `modelRegistry.complete` call. */
interface CompleteCall {
	/** The request prompt (the user message's text). */
	prompt: string;
	maxTokens: number | undefined;
	temperature: number | undefined;
	/** Manually release this call. */
	resolve: (text: string) => void;
	/** Make this call fail (model error / timeout). */
	reject: (error: Error) => void;
}

interface Recorder {
	completes: CompleteCall[];
	/** One record per `setWorkingMessage(<string>)`. */
	workingMessages: string[];
	/** Count of no-arg `setWorkingMessage()` calls (restoring the default at turn end). */
	resets: number;
}

interface ContextOptions {
	/** The theme `fg` implementation; defaults to identity (keeps the width accounting of the existing layout cases). */
	themeFg?: (color: string, text: string) => string;
	/** One record per `setWorkingIndicator` (`undefined` = the no-arg call, i.e. restore pi's default frames). */
	onIndicator?: (options: { frames?: string[]; intervalMs?: number } | undefined) => void;
}

/** The user text inside a request context (the body shape is owned by `summary-request.ts`). */
function promptTextOf(context: unknown): string {
	const messages = (context as { messages?: Array<{ content?: Array<{ text?: string }> }> }).messages ?? [];
	return messages.map((message) => message.content?.map((block) => block.text ?? "").join("") ?? "").join("");
}

function createContext(recorder: Recorder, options: ContextOptions = {}): unknown {
	return {
		mode: "tui",
		hasUI: true,
		model: { provider: "test", id: "test-model" },
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {} }),
			complete: (_model: unknown, context: unknown, options: { maxTokens?: number; temperature?: number }) =>
				new Promise((resolve, reject) => {
					recorder.completes.push({
						prompt: promptTextOf(context),
						maxTokens: options?.maxTokens,
						temperature: options?.temperature,
						resolve: (text: string) => resolve({ content: [{ type: "text", text }] }),
						reject,
					});
				}),
		},
		ui: {
			theme: { fg: options.themeFg ?? ((_color: string, text: string) => text) },
			setWorkingIndicator: (indicator?: { frames?: string[]; intervalMs?: number }) =>
				options.onIndicator?.(indicator),
			setWorkingMessage: (message?: string) => {
				if (message === undefined) recorder.resets += 1;
				else recorder.workingMessages.push(message);
			},
		},
	};
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-working-indicator-"));
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

interface LoadedExtension {
	handlers: Map<string, Handler[]>;
	errors: Array<{ path: string; error: string }>;
}

/** Load this extension with pi's own loader (verifying `./summary-request.ts` imports too). */
async function loadExtension(workspace: { agentDir: string; projectDir: string }): Promise<LoadedExtension> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
	};
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

function handlersOf(extension: LoadedExtension): {
	input: Handler;
	agentStart: Handler;
	agentSettled: Handler;
	shutdown: Handler;
} {
	const input = extension.handlers.get("input")?.[0];
	const agentStart = extension.handlers.get("agent_start")?.[0];
	const agentSettled = extension.handlers.get("agent_settled")?.[0];
	const shutdown = extension.handlers.get("session_shutdown")?.[0];
	assert.ok(input, "should have registered input");
	assert.ok(agentStart, "should have registered agent_start");
	assert.ok(agentSettled, "should have registered agent_settled");
	assert.ok(shutdown, "should have registered session_shutdown");
	return { input, agentStart, agentSettled, shutdown };
}

/** Wait for the predicate; a timeout reports what it was waiting on. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for: ${what} (${timeoutMs}ms)`);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A multi-line prompt far beyond the 38-column trigger line. */
const LONG_PROMPT = [
	"optimize the prompt summary at the working line's tail",
	"long prompts get clipped mid-word right now and you cannot tell what is running",
	"want the model to compress them into one line when they exceed the display width",
	"and this request must run in parallel with the main task, not interfere with it",
].join("\n");

test("a long prompt asynchronously requests one summary, then replaces the row-tail original; the request does not block the main turn", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, agentSettled, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);

		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);

		assert.equal(recorder.completes.length, 1, "a long prompt should send one summary request");
		const call = recorder.completes[0];
		assert.ok(call);
		// the request carries the computed target length (38 available × 0.9 = 34) and the column accounting.
		assert.match(call.prompt, /34 display columns/);
		assert.match(call.prompt, /CJK\/full-width character counts as 2 columns/);
		// the flattened original is embedded whole (multi-line → one sentence).
		assert.ok(call.prompt.includes("optimize the prompt summary at the working line's tail"));
		// no temperature passed: these routes degenerate into unstoppable long thinking at 0 (measured).
		assert.equal(call.temperature, undefined);
		// maxTokens must leave room for forced thinking (the gateway hard-codes thinking: enabled on these routes).
		assert.ok((call.maxTokens ?? 0) >= 512, `maxTokens must leave room for thinking; got ${call.maxTokens}`);

		// the summary has not come back yet: the truncated original shows first.
		const before = recorder.workingMessages.at(-1) ?? "";
		assert.match(before, /✦ /);
		assert.ok(!before.includes("Condense the long prompt"), "no summary may appear out of thin air before the model replies");

		call.resolve("Condense the long prompt at the tail into one line");

		await waitFor(
			() => (recorder.workingMessages.at(-1) ?? "").includes("Condense the long prompt at the tail into one line"),
			"the summary is replaced by the model's one-liner",
		);
		const after = recorder.workingMessages.at(-1) ?? "";
		assert.ok(after.includes("✦ "), "the summary still carries the `✦ ` prefix");
		assert.ok(!after.includes("want the model to"), "the summary should replace the original, not coexist with it");

		await agentSettled({}, ctx);
		assert.equal(recorder.resets, 1, "the turn's end should restore pi's default text");
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("the request does not block input: the input handler returns immediately even when the model never replies", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		const startedAt = Date.now();
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		const elapsed = Date.now() - startedAt;
		assert.equal(recorder.completes.length, 1, "the request has been sent");
		assert.ok(elapsed < 500, `the input handler must not wait on the model (took ${elapsed}ms)`);

		// a hung request does not affect later events: the turn ends normally.
		await handlersOf(extension).agentSettled({}, ctx);
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("a short prompt does not request; a repeated input of the same message does not re-request", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: "hi", source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await delay(50);
		assert.equal(recorder.completes.length, 0, "a short prompt fits whole — must not request");

		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 1, "the first long-prompt request");
		// an extension command's sendUserMessage runs the same message through input twice.
		await input({ text: LONG_PROMPT, source: "extension" }, ctx);
		await delay(50);
		assert.equal(recorder.completes.length, 1, "a repeated fire of the same text must not request again");

		// only a genuinely different long prompt sends a second request.
		await input({ text: `${LONG_PROMPT} (v2)`, source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 2, "the second request for the new prompt");
		assert.ok(recorder.completes[1]?.prompt.includes(" (v2)"));

		// after a session replace, the same text must request again (the dedupe key must not survive).
		await shutdown({}, ctx);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 3, "the same prompt in a new session");
	} finally {
		workspace.cleanup();
	}
});

test("the trigger line is the available width: 39 columns (one over) requests, 38 (exactly fits) does not", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		// terminal width falls back to 80 in the test process → 38 available columns (derivation in the file header).
		await input({ text: "a".repeat(38), source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await delay(50);
		assert.equal(recorder.completes.length, 0, "exactly fitting must not request");

		await input({ text: "a".repeat(39), source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 1, "one column over should request");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("a new prompt voids the old request: a late old summary never displaces the new one", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "the first prompt's request");
		await input({ text: `${LONG_PROMPT} with model compression`, source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 2, "the second prompt's request");

		// the old request returning late must be dropped (abort + generation guards).
		recorder.completes[0]?.resolve("first prompt's summary");
		await delay(50);
		assert.ok(
			!recorder.workingMessages.some((message) => message.includes("first prompt's summary")),
			"a stale summary must never display",
		);

		recorder.completes[1]?.resolve("second prompt's summary");
		await waitFor(
			() => (recorder.workingMessages.at(-1) ?? "").includes("second prompt's summary"),
			"the current prompt's summary",
		);

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("an overlong summary is only truncated, never re-asked: a successful reply never triggers a second request", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "the summary request");
		const overlong = "This is a model summary far wider than the available width. ".repeat(20);
		recorder.completes[0]?.resolve(overlong);

		await waitFor(
			() => (recorder.workingMessages.at(-1) ?? "").includes("…"),
			"the overlong summary is truncated with an ellipsis",
		);
		const message = recorder.workingMessages.at(-1) ?? "";
		assert.ok(!message.includes("This is a model summary far wider than the available width. This is a"), "an overlong summary should lose most of its body");
		// wait out a 1s tick to confirm no "second request" ever happens.
		await delay(1_200);
		assert.equal(recorder.completes.length, 1, "an overlong reply still does not retry");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("a first failure silently falls back to the truncated original, then auto-retries once after the delay; a successful retry swaps in the summary", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "the summary request");
		recorder.completes[0]?.reject(new Error("boom"));

		// the retry is still inside its delay: the cell falls back to the truncated original (not blank, not re-requested early).
		await delay(Math.floor(RETRY_DELAY_MS / 3));
		const fallback = recorder.workingMessages.at(-1) ?? "";
		assert.ok(fallback.includes("✦ "), "the summary segment still shows after a failure (the truncated original here)");
		assert.ok(fallback.includes("optimize the prompt"), "the original's prefix is still there");
		assert.equal(recorder.completes.length, 1, "must not retry before the delay is up");

		await waitFor(() => recorder.completes.length === 2, "the automatic retry after a failure");
		assert.equal(recorder.completes[1]?.prompt, recorder.completes[0]?.prompt, "the retry asks the same question");
		recorder.completes[1]?.resolve("Condense the long prompt at the tail into one line");
		await waitFor(
			() => (recorder.workingMessages.at(-1) ?? "").includes("Condense the long prompt at the tail into one line"),
			"the retry's summary reaches the screen",
		);

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("an empty reply (thinking only, no body) also counts as failure: retried the same way", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "the summary request");
		recorder.completes[0]?.resolve(""); // cleans to empty (real-world case: only thinking came back)

		await waitFor(() => recorder.completes.length === 2, "the automatic retry after an empty reply");
		assert.ok(
			(recorder.workingMessages.at(-1) ?? "").includes("optimize the prompt"),
			"the empty reply swapped nothing in — still the truncated original",
		);

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("a second failure gives up for good: at most two requests per prompt", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "the summary request");
		recorder.completes[0]?.reject(new Error("boom-1"));
		await waitFor(() => recorder.completes.length === 2, "the automatic retry after a failure");
		recorder.completes[1]?.reject(new Error("boom-2"));

		await delay(RETRY_DELAY_MS * 2);
		assert.equal(recorder.completes.length, 2, "no more retries after the second failure");
		assert.ok((recorder.workingMessages.at(-1) ?? "").includes("optimize the prompt"), "still the truncated original");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("a new prompt voids the pending retry: nothing is re-sent for the old prompt", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "the first prompt's request");
		recorder.completes[0]?.reject(new Error("boom"));

		// let the failure land and the retry timer actually get armed before switching prompts — otherwise the `seq` guard below blocks it
		// and there is no chance to verify "the pending retry gets cancelled".
		await delay(Math.floor(RETRY_DELAY_MS / 6));
		await input({ text: `${LONG_PROMPT} (v2)`, source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 2, "the new prompt's request");
		assert.ok(recorder.completes[1]?.prompt.includes(" (v2)"));

		await delay(RETRY_DELAY_MS * 2);
		assert.equal(recorder.completes.length, 2, "the old prompt's pending-retry timer should be cleared");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("a turn end voids the pending retry: no request goes out outside a turn", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, agentSettled, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "the summary request");
		recorder.completes[0]?.reject(new Error("boom"));

		// same as above: let the retry timer arm, then end the turn (`agentSettled` → `stopActivity` → timer cleared).
		await delay(Math.floor(RETRY_DELAY_MS / 6));
		await agentSettled({}, ctx); // turn end → stopActivity → the pending retry timer cleared
		await delay(RETRY_DELAY_MS * 2);
		assert.equal(recorder.completes.length, 1, "no retry should fire after the turn ends");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

// ---------------------------------------------------------------------------
// spinner rainbow frames (`spinner-frames.ts` + index.ts's three install moments)
// ---------------------------------------------------------------------------

/** A seven-color fake theme; mutating `colors` in place IS "the skin swap" (a stand-in for `theme.fg`'s live proxy). */
function createMutableTheme(): { colors: Record<string, string>; fg: (color: string, text: string) => string } {
	const colors: Record<string, string> = Object.fromEntries(
		SPINNER_COLOR_TOKENS.map((token, index) => [token, `<c${index}>`]),
	);
	return { colors, fg: (color, text) => `${colors[color] ?? `<${color}>`}${text}` };
}

/** The record of one `setWorkingIndicator` call (`undefined` = the no-arg call, i.e. restore pi's default frames). */
type IndicatorCall = { frames?: string[]; intervalMs?: number } | undefined;

test("turn start installs the rainbow table: ten braille frames × seven colors, 80ms interval, 19 frames per color (≈1.5s)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const theme = createMutableTheme();
		const calls: IndicatorCall[] = [];
		const ctx = createContext(recorder, { themeFg: theme.fg, onIndicator: (o) => calls.push(o) });

		await agentStart({}, ctx);

		const installed = calls.at(-1);
		assert.ok(installed, "agent_start should install the indicator once");
		assert.equal(installed.intervalMs, SPINNER_INTERVAL_MS);
		const frames = installed.frames as string[];
		// table period = lcm(10, 19 × 7) = 1330: an integer multiple of both one palette lap and the braille revolution (no color jump at wraparound).
		assert.equal(frames.length, 1330);
		assert.equal(frames.length % (DEFAULT_FRAMES_PER_COLOR * SPINNER_COLOR_TOKENS.length), 0);
		assert.equal(frames.length % SPINNER_FRAMES.length, 0);
		for (const [index, frame] of frames.entries()) {
			assert.equal(frame.at(-1), SPINNER_FRAMES[index % SPINNER_FRAMES.length]);
			assert.equal(
				frame.slice(0, -1),
				theme.colors[
					SPINNER_COLOR_TOKENS[
						Math.floor(index / DEFAULT_FRAMES_PER_COLOR) % SPINNER_COLOR_TOKENS.length
					] as string
				],
			);
		}

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("within a second of a theme change the table is reinstalled: unchanged fingerprint → no reinstall, changed → reinstall", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, shutdown } = handlersOf(extension);
		const messageUpdate = extension.handlers.get("message_update")?.[0];
		assert.ok(messageUpdate, "should have registered message_update");
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const theme = createMutableTheme();
		const calls: IndicatorCall[] = [];
		const ctx = createContext(recorder, { themeFg: theme.fg, onIndicator: (o) => calls.push(o) });

		await agentStart({}, ctx);
		assert.equal(calls.length, 1, "installed once at turn start");

		// theme unchanged: the refresh that runs on every streaming delta must not keep reinstalling (a reinstall resets the animation phase).
		await messageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "hi" } }, ctx);
		await messageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "!" } }, ctx);
		assert.equal(calls.length, 1, "an unchanged fingerprint must not reinstall");

		// skin swap: the next refresh re-reads the new colors, the fingerprint changes → reinstall.
		theme.colors.accent = "<new-accent>";
		await messageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "?" } }, ctx);
		assert.equal(calls.length, 2, "a skin swap should reinstall once");
		const refreshed = calls[1]?.frames?.[0] as string;
		assert.ok(refreshed.startsWith("<new-accent>"), `the new table should use the new theme's colors; got ${refreshed}`);

		// further refreshes do not reinstall again.
		await messageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "?" } }, ctx);
		assert.equal(calls.length, 2, "must not reinstall under the same theme");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("questionnaire end reinstalls the rainbow (ask-user-question's freeze replaced it with pi's default frames)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, shutdown } = handlersOf(extension);
		const toolEnd = extension.handlers.get("tool_execution_end")?.[0];
		assert.ok(toolEnd, "should have registered tool_execution_end");
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const theme = createMutableTheme();
		const calls: IndicatorCall[] = [];
		const ctx = createContext(recorder, { themeFg: theme.fg, onIndicator: (o) => calls.push(o) });

		await agentStart({}, ctx);
		const afterStart = calls.length;

		// a non-questionnaire tool's end must not touch the indicator (reinstalling on every tool end would chop the animation phase by tool call).
		await toolEnd({ toolCallId: "1", toolName: "bash" }, ctx);
		assert.equal(calls.length, afterStart, "a non-questionnaire tool must not reinstall");

		// questionnaire end: reinstall the rainbow once (the questionnaire's finally already restored pi's default frames with a no-arg call).
		await toolEnd({ toolCallId: "2", toolName: "ask_user_question" }, ctx);
		assert.equal(calls.length, afterStart + 1, "questionnaire end should reinstall");
		assert.equal((calls.at(-1)?.frames as string[]).length, 1330);

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("a monochrome theme (NO_COLOR / identity fg) issues no table — it hands control back to pi's default spinner with a no-arg call", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const calls: IndicatorCall[] = [];
		// no themeFg passed: the existing fake ctx's identity theme resolves all seven slots to the same color.
		const ctx = createContext(recorder, { onIndicator: (o) => calls.push(o) });

		await agentStart({}, ctx);

		assert.equal(calls.length, 1, "control must still be handed back once");
		assert.equal(calls[0], undefined, "a monochrome theme should restore pi's default frames, not install a fake animation");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// freeze repaints during dialogs (ui_prompt_start / ui_prompt_end)
// =============================================================================

test("dialog start: the spinner freezes to a single frame and the seconds timer stops (no new message within 1.2s)", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, agentSettled, shutdown } = handlersOf(extension);
		const promptStart = extension.handlers.get("ui_prompt_start")?.[0];
		assert.ok(promptStart, "should have registered ui_prompt_start");
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const calls: IndicatorCall[] = [];
		const ctx = createContext(recorder, { onIndicator: (o) => calls.push(o) });

		await input({ text: "run a long command", source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.workingMessages.length >= 1, "the first message after the turn starts");

		await promptStart({}, ctx);

		// the frozen frame: a single full-block braille char (same char as ask-user-question), accent-colored.
		const frozen = calls.at(-1);
		assert.ok(frozen?.frames, "dialog start should install the frozen frame");
		assert.equal(frozen.frames.length, 1, "only a single frame stops the Loader's 80ms animation timer");
		assert.ok(frozen.frames[0].endsWith("⠿"), "the frozen frame should be the full-block braille char");

		// timers stopped: no new message should appear across a whole TICK (1s).
		const countAtFreeze = recorder.workingMessages.length;
		await delay(1_200);
		assert.equal(recorder.workingMessages.length, countAtFreeze, "the seconds timer must not emit messages during the dialog");

		await agentSettled({}, ctx);
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("dialog end: reinstall the rainbow table, restart the seconds timer, refresh once immediately", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, agentSettled, shutdown } = handlersOf(extension);
		const promptStart = extension.handlers.get("ui_prompt_start")?.[0];
		const promptEnd = extension.handlers.get("ui_prompt_end")?.[0];
		assert.ok(promptStart && promptEnd, "should have registered ui_prompt_start / ui_prompt_end");
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const calls: IndicatorCall[] = [];
		// a distinguishable seven-color theme: the default identity theme is monochrome and `spinnerPalette` returns a null table
		// (restoration then takes the no-arg call), so the "reinstall the 1330-frame rainbow" step would be untestable.
		const theme = createMutableTheme();
		const ctx = createContext(recorder, { themeFg: theme.fg, onIndicator: (o) => calls.push(o) });

		await input({ text: "run a long command", source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.workingMessages.length >= 1, "the first message after the turn starts");

		await promptStart({}, ctx);
		await promptEnd({}, ctx);

		// the table is reinstalled to the 1330-frame rainbow (overwriting the single frozen frame). The resume-time immediate refresh is guarded by the lastMessage
		// dedupe: a dialog lasting milliseconds with unchanged text does not re-emit — designed behavior, not a bug.
		const restored = calls.at(-1);
		assert.equal((restored?.frames as string[] | undefined)?.length, 1330, "the full rainbow table should be reinstalled");

		// the timer restarted: messages should resume within another 1.2s.
		const countAfterResume = recorder.workingMessages.length;
		await waitFor(() => recorder.workingMessages.length > countAfterResume, "the seconds timer keeps running after resume", 3_000);

		await agentSettled({}, ctx);
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("a dialog outside a turn (no agent_start): freeze does not crash, resume starts no timer", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const promptStart = extension.handlers.get("ui_prompt_start")?.[0];
		const promptEnd = extension.handlers.get("ui_prompt_end")?.[0];
		const shutdown = extension.handlers.get("session_shutdown")?.[0];
		assert.ok(promptStart && promptEnd && shutdown);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const calls: IndicatorCall[] = [];
		const ctx = createContext(recorder, { onIndicator: (o) => calls.push(o) });

		// no agent_start: ctxRef is null, turnStartedAt is null.
		await promptStart({}, ctx);
		assert.equal(calls.length, 1, "the frozen frame should still be installed once");
		await promptEnd({}, ctx);
		// no seconds timer may materialize out of nothing: nothing appears across a TICK.
		await delay(1_200);
		assert.equal(recorder.workingMessages.length, 0, "no seconds-tick message outside a turn");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});
