/**
 * verify-loop's assembly checks: the pure judgments are covered in gate's / goal's /
 * evaluator's own test files; here pi is **not mocked** — pi's own extension loader
 * (`discoverAndLoadExtensions`) really loads `index.ts`, and the registered
 * `agent_before_settle` handler plus the `/goal` command are driven directly.
 *
 * On the loader-provided runtime, `appendEntry` / `sendUserMessage` are throwing stubs
 * (loader.js's notInitialized), but the wrapper functions read the runtime properties
 * **at call time** — so replacing them with recorders in the test works (runner.bindCore
 * does exactly this in real pi).
 *
 *   node --test clients/pi/extensions/verify-loop/index.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { VERIFY_LOOP_CUSTOM_TYPE } from "./gate.ts";
import { GOAL_ENTRY_TYPE } from "./goal.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

// =============================================================================
// Find the local pi library entry (same origin as core-rules/index.test.ts)
// =============================================================================

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

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? "could not find the local pi library entry (requires an installed pi)" : false;

// =============================================================================
// Building projection messages
// =============================================================================

type Message = Record<string, unknown>;

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): Message {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolCalls(...calls: Array<{ name: string; args?: Record<string, unknown> }>): Message {
	return {
		role: "assistant",
		content: calls.map((call, index) => ({
			type: "toolCall",
			id: `call-${index}-${call.name}`,
			name: call.name,
			arguments: call.args ?? {},
		})),
	};
}

function toolResult(): Message {
	return { role: "toolResult", content: [{ type: "text", text: "ok" }] };
}

// =============================================================================
// Loading and driving
// =============================================================================

interface LoadedExtension {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	messageRenderers: Map<string, unknown>;
}

interface Harness {
	/** Drive agent_before_settle; returns the BoundaryResult. */
	settle(messages: Message[], outcome?: "completed" | "aborted" | "error"): Promise<unknown>;
	/** Run the /goal command. */
	goal(args: string): Promise<void>;
	/** Drive session_start (rebuilds the goal). */
	startSession(branchEntries?: unknown[]): Promise<void>;
	/** The appendEntry calls recorded. */
	appended: Array<{ customType: string; data: unknown }>;
	/** The sendUserMessage calls recorded. */
	sentUserMessages: Array<{ content: string; options?: unknown }>;
	/** The notifies recorded. */
	notifies: string[];
	/** The setStatus calls recorded. */
	statuses: Array<{ key: string; text: string | undefined }>;
	/** The evaluation calls recorded (a verdict can be injected). */
	evaluations: Array<{ prompt: string; systemPrompt: string }>;
	/** The raw text the next evaluation returns (undefined = evaluation failed). */
	evaluatorReply: string | undefined;
}

async function loadHarness(
	env: Record<string, string | undefined> = {},
	options: { activeSubagents?: number } = {},
): Promise<Harness> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }>; runtime: Record<string, unknown> }>;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-verify-loop-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });

	// env isolation: save → override → load → restore (config is read once at factory time).
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(env)) {
		saved[key] = process.env[key];
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}

	let loaded: Awaited<ReturnType<typeof pi.discoverAndLoadExtensions>>;
	try {
		// the fake bus for subagent probing: answers "no subagents running" to `status` requests.
		// otherwise `hasActiveSubagentWork` waits the full 1s timeout (same fail-open outcome, but every case gets 1s slower).
		const bus = createFakeEventBus(options.activeSubagents ?? 0);
		loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, bus);
	} finally {
		for (const key of Object.keys(saved)) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}

	assert.deepEqual(loaded.errors, [], "pi's extension loader must not error");
	const extension = loaded.extensions[0];
	assert.ok(extension, "the verify-loop extension should load");

	const harness: Harness = {
		appended: [],
		sentUserMessages: [],
		notifies: [],
		statuses: [],
		evaluations: [],
		evaluatorReply: undefined,
		settle: async () => undefined,
		goal: async () => undefined,
		startSession: async () => undefined,
	};

	// the test equivalent of runner.bindCore: replace the throwing stubs with recorders.
	loaded.runtime.appendEntry = (customType: string, data: unknown) => {
		harness.appended.push({ customType, data });
	};
	loaded.runtime.sendUserMessage = (content: string, options?: unknown) => {
		harness.sentUserMessages.push({ content, options });
	};

	let branchEntries: unknown[] = [];

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: projectDir,
		isIdle: () => true,
		signal: undefined,
		ui: {
			notify: (text: string) => harness.notifies.push(text),
			setStatus: (key: string, text: string | undefined) => harness.statuses.push({ key, text }),
		},
		sessionManager: {
			getBranch: () => branchEntries,
			buildContextEntries: () => branchEntries,
		},
		model: { provider: "litellm-any", id: "deepseek-flash" },
		modelRegistry: {
			find: () => ({ provider: "litellm-any", id: "qwen3.8-flash" }),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
			complete: async (_model: unknown, context: { systemPrompt?: string; messages: Array<{ content: Array<{ text?: string }> }> }) => {
				harness.evaluations.push({
					systemPrompt: context.systemPrompt ?? "",
					prompt: context.messages[0]?.content?.map((part) => part.text ?? "").join("") ?? "",
				});
				if (harness.evaluatorReply === undefined) throw new Error("evaluator unavailable");
				return { content: [{ type: "text", text: harness.evaluatorReply }] };
			},
		},
	};

	const settleHandler = extension.handlers.get("agent_before_settle")?.[0];
	const startHandler = extension.handlers.get("session_start")?.[0];
	const goalCommand = extension.commands.get("goal");
	assert.ok(settleHandler, "an agent_before_settle handler should be registered");
	assert.ok(goalCommand, "the /goal command should be registered");
	assert.ok(extension.messageRenderers.get(VERIFY_LOOP_CUSTOM_TYPE), "a renderer for the injected messages should be registered");

	harness.settle = async (messages, outcome = "completed") =>
		settleHandler(
			{ type: "agent_before_settle", outcome, entries: [], continue: false, context: { contextMessages: messages } },
			ctx,
		);
	harness.goal = async (args) => goalCommand.handler(args, ctx);
	harness.startSession = async (entries = []) => {
		branchEntries = entries;
		if (startHandler) await startHandler({ type: "session_start", reason: "startup" }, ctx);
	};
	return harness;
}

function lastDraft(result: unknown): { customType?: string; content?: string; display?: boolean; details?: { kind?: string } } | undefined {
	const entries = (result as { entries?: unknown[] } | undefined)?.entries;
	if (!entries || entries.length === 0) return undefined;
	return entries[entries.length - 1] as { customType?: string; content?: string; display?: boolean; details?: { kind?: string } };
}

/**
 * The fake pi event bus: only knows pi-subagents' RPC channel, answering
 * `fleet.totalActive = <n>`.
 * That is the field recap/subagents.ts's `isSubagentWorkActive` reads.
 */
function createFakeEventBus(active = 0): { on: (channel: string, handler: (data: unknown) => void) => () => void; emit: (channel: string, data: unknown) => void } {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
		emit(channel, data) {
			const request = data as { requestId?: string; method?: string };
			if (channel !== "subagents:rpc:v1:request" || request.method !== "status") return;
			const replyChannel = `subagents:rpc:v1:reply:${request.requestId}`;
			for (const handler of handlers.get(replyChannel) ?? []) {
				handler({ success: true, data: { fleet: { totalActive: active } } });
			}
		},
	};
}

// =============================================================================
// The gate (CC's command-type Stop hook)
// =============================================================================

test(
	"files changed, no verification → block: injects a gate message and continues",
	{ skip },
	async () => {
		const harness = await loadHarness();
		const messages = [
			user("change it"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("done"),
		];
		const result = (await harness.settle(messages)) as { continue?: boolean } | undefined;
		assert.equal(result?.continue, true, "should force one continuation");
		const draft = lastDraft(result);
		assert.equal(draft?.customType, VERIFY_LOOP_CUSTOM_TYPE);
		assert.equal(draft?.details?.kind, "gate");
		assert.equal(draft?.display, true, "CC's Stop hook feedback is user-visible");
		assert.match(draft?.content ?? "", /no command was run/);
		assert.match(draft?.content ?? "", /src\/a\.js/);
	},
);

test(
	"verification ran after the change → pass",
	{ skip },
	async () => {
		const harness = await loadHarness();
		const messages = [
			user("change it"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantToolCalls({ name: "bash", args: { command: "node --test adapter/tests/*.test.js" } }),
			toolResult(),
			assistantText("done"),
		];
		assert.equal(await harness.settle(messages), undefined);
	},
);

test(
	"aborted / error outcomes do not trip the gate (CC: abort does not fire Stop; API errors go through StopFailure)",
	{ skip },
	async () => {
		const harness = await loadHarness();
		const messages = [
			user("change it"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("done"),
		];
		assert.equal(await harness.settle(messages, "aborted"), undefined);
		assert.equal(await harness.settle(messages, "error"), undefined);
	},
);

test(
	"PI_VERIFY_LOOP=notify → notify only, no blocking",
	{ skip },
	async () => {
		const harness = await loadHarness({ PI_VERIFY_LOOP: "notify" });
		const messages = [
			user("change it"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("done"),
		];
		const result = await harness.settle(messages);
		assert.equal(result, undefined, "notify mode must not continue");
		assert.ok(harness.notifies.some((text) => text.includes("[verify-loop]")), "a notice should appear");
	},
);

test(
	"PI_VERIFY_LOOP=off → does nothing",
	{ skip },
	async () => {
		const harness = await loadHarness({ PI_VERIFY_LOOP: "off" });
		const messages = [
			user("change it"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("done"),
		];
		assert.equal(await harness.settle(messages), undefined);
		assert.equal(harness.notifies.length, 0);
	},
);

test(
	"consecutive blocks at the cap → pass (CC's forced release)",
	{ skip },
	async () => {
		const harness = await loadHarness({ PI_VERIFY_LOOP_CAP: "1" });
		const messages = [
			user("change it"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("done"),
			{ role: "custom", customType: VERIFY_LOOP_CUSTOM_TYPE, content: "...", details: { kind: "gate", at: 1 } },
			assistantText("still done"),
		];
		assert.equal(await harness.settle(messages), undefined, "already blocked once (cap 1) → should pass");
	},
);

// =============================================================================
// The /goal command
// =============================================================================

test(
	"/goal <condition>: persists + indicator + starts a turn immediately (the condition is the directive)",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("temp files contain HELLO");
		assert.equal(harness.appended.length, 1);
		assert.equal(harness.appended[0].customType, GOAL_ENTRY_TYPE);
		assert.equal((harness.appended[0].data as { condition: string }).condition, "temp files contain HELLO");
		assert.equal(harness.sentUserMessages.length, 1, "CC: setting a goal starts a turn immediately");
		assert.match(harness.sentUserMessages[0].content, /temp files contain HELLO/);
		assert.ok(harness.statuses.some((s) => s.key === "verify-goal" && s.text === "◎ /goal active"));
	},
);

test(
	"/goal clear: clears and records",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("condition A");
		await harness.goal("clear");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { condition: string }).condition, "");
		assert.ok(harness.notifies.some((text) => text.startsWith("Goal cleared")));
	},
);

test(
	"/goal stop and other aliases clear the same way",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("condition A");
		await harness.goal("stop");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { condition: string }).condition, "");
	},
);

test(
	"/goal (no args): shows status, does not evaluate",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("condition A");
		harness.notifies.length = 0;
		await harness.goal("");
		assert.ok(harness.notifies.some((text) => text.includes("condition A")));
		assert.equal(harness.evaluations.length, 0);
	},
);

// =============================================================================
// The evaluation loop (CC's prompt-type Stop hook / the /goal evaluator)
// =============================================================================

async function settleWithGoal(harness: Harness, messages: Message[]): Promise<{ continue?: boolean } | undefined> {
	return (await harness.settle(messages)) as { continue?: boolean } | undefined;
}

test(
	"goal active + not met → inject the verdict and continue",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("all tests pass");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"no test output seen"}';

		const messages = [
			user("start"),
			assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
			toolResult(),
			assistantText("should be good now"),
		];
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, true, "not met → should continue");
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-not-met");
		assert.match(draft?.content ?? "", /no test output seen/);
		assert.equal(harness.evaluations.length, 1, "the evaluator is called once");
		assert.match(harness.evaluations[0].prompt, /all tests pass/, "the condition is in the evaluation prompt");
		assert.match(harness.evaluations[0].prompt, /\[Assistant\]/, "the serialized conversation is in the evaluation prompt");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { evaluatedTurns: number }).evaluatedTurns, 1, "the evaluated-turn count is persisted");
	},
);

test(
	"goal met → records an achieved entry, no more continuation",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("all tests pass");
		harness.evaluatorReply = '{"verdict":"met","reason":"output shows 34/34 passing"}';

		const messages = [
			user("start"),
			assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
			toolResult(),
			assistantText("all passing"),
		];
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, undefined, "met → must not continue");
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-met");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { status: string }).status, "achieved");

		// no evaluation after achieving
		harness.evaluations.length = 0;
		await settleWithGoal(harness, [...messages, assistantText("continue with something else")]);
		assert.equal(harness.evaluations.length, 0);
	},
);

test(
	"goal impossible → cleared and recorded",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("make the sun rise in the west");
		harness.evaluatorReply = '{"verdict":"impossible","reason":"physically impossible"}';

		const messages = [user("start"), assistantText("this cannot be done")];
		const result = await settleWithGoal(harness, messages);
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-impossible");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { status: string }).status, "impossible");
	},
);

test(
	"evaluator failure → fail-open pass (CC: hook failure does not block the turn)",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("all tests pass");
		harness.evaluatorReply = undefined; // complete() throws

		const messages = [user("start"), assistantText("done")];
		const result = await settleWithGoal(harness, messages);
		assert.equal(result, undefined, "an evaluation failure should pass");
		assert.ok(harness.notifies.some((text) => text.includes("evaluation failed")));
	},
);

test(
	"the evaluator returns a non-verdict → fail-open pass",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("all tests pass");
		harness.evaluatorReply = "I think it should be about done";

		const messages = [user("start"), assistantText("done")];
		assert.equal(await settleWithGoal(harness, messages), undefined);
	},
);

test(
	"continuations at the cap → stop the loop, goal kept (CC's forced release)",
	{ skip },
	async () => {
		const harness = await loadHarness({ PI_GOAL_CAP: "2" });
		await harness.goal("all tests pass");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"still missing"}';

		const messages: Message[] = [user("start")];
		for (let i = 0; i < 2; i += 1) {
			messages.push(
				{ role: "custom", customType: VERIFY_LOOP_CUSTOM_TYPE, content: "...", details: { kind: "goal-not-met", at: 1 } },
				assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
				toolResult(),
				assistantText("continue"),
			);
		}
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, undefined, "no continuation past the cap");
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-cap");
		assert.match(draft?.content ?? "", /condition is retained/);
	},
);

test(
	"consecutive no-progress (text-only, no tools) → stop the loop, goal kept (CC's no-progress detection)",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("all tests pass");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"still missing"}';

		const messages: Message[] = [user("start")];
		for (let i = 0; i < 2; i += 1) {
			messages.push(
				{ role: "custom", customType: VERIFY_LOOP_CUSTOM_TYPE, content: "...", details: { kind: "goal-not-met", at: 1 } },
				assistantText("I think it is done already"),
			);
		}
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, undefined, "no continuation on no progress");
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-halted");
		assert.match(draft?.content ?? "", /no progress/);
		assert.equal(harness.evaluations.length, 0, "the halt check runs before evaluation — no model call spent");
	},
);

test(
	"a background subagent still running → skip this turn's evaluation (CC: background work defers evaluation)",
	{ skip },
	async () => {
		const harness = await loadHarness({}, { activeSubagents: 1 });
		await harness.goal("all tests pass");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"still missing"}';

		const messages = [user("start"), assistantText("sent, waiting on the subagent")];
		assert.equal(await settleWithGoal(harness, messages), undefined, "no evaluation or continuation while a subagent runs");
		assert.equal(harness.evaluations.length, 0);
	},
);

// =============================================================================
// Session lifecycle
// =============================================================================

test(
	"session_start: restores an active goal from branch entries (CC: resume restores)",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.startSession([
			{ type: "custom", customType: GOAL_ENTRY_TYPE, data: { condition: "all tests pass", setAt: 1, status: "active", evaluatedTurns: 3 } },
		]);
		assert.ok(harness.statuses.some((s) => s.key === "verify-goal" && s.text === "◎ /goal active"), "the indicator should light up after restore");

		// the restored goal participates in evaluation
		harness.evaluatorReply = '{"verdict":"met","reason":"done"}';
		const result = await settleWithGoal(harness, [user("continue"), assistantText("done")]);
		assert.equal(lastDraft(result)?.details?.kind, "goal-met");
	},
);

test(
	"session_start: an achieved goal is not restored (CC: no restore of achieved/cleared goals)",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.startSession([
			{ type: "custom", customType: GOAL_ENTRY_TYPE, data: { condition: "old condition", setAt: 1, status: "achieved", evaluatedTurns: 1 } },
		]);
		assert.ok(!harness.statuses.some((s) => s.key === "verify-goal" && s.text === "◎ /goal active"));
		assert.equal(await settleWithGoal(harness, [user("continue"), assistantText("done")]), undefined);
	},
);

test(
	"gate and goal both present: the gate wins (backfill verification first, then talk goal)",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("all tests pass");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"still missing"}';

		const messages = [
			user("start"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("done"),
		];
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, true);
		assert.equal(lastDraft(result)?.details?.kind, "gate", "the gate runs before the goal evaluation");
		assert.equal(harness.evaluations.length, 0, "a gate block spends no evaluation call");
	},
);
