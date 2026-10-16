/**
 * Tests for recap/index.ts — the idle gate in front of the auto recap.
 *
 * Run with:  node --test clients/pi/extensions/recap/index.test.ts
 *
 * This one takes ~35s on purpose: the 10s idle threshold is hard-coded and the test uses
 * real timers (the whole point is "does it *not* recap while work is still running"), so
 * nothing is shortened or faked as a shortcut. What is faked is everything outside the
 * extension: the ctx (a canned last exchange + a recording modelRegistry/ui) and the
 * other side of the event bus. pi's own extension loader really loads `index.ts`, so the
 * `./subagents.ts` import and the handler/command registrations are covered too.
 *
 * Timeline asserted:
 *   agent_settled → 10s idle → probe #1 says "1 subagent running"  → no recap
 *                              (only a 10s poll is armed)
 *   flip the fake fleet to idle → probe #2 says "nothing running"  → still no recap
 *                              (the 10s idle timer restarts)
 *   → 10s later → recap generated and shown.
 *
 * The second test covers the widget's breathing line: the blank line above the recap is
 * decided at render time by walking the editor's widget container (`../simple-task/gap.ts`)
 * instead of guessing from the task-list state, and the re-entrancy guard keeps
 * simple-task's own walk (which renders this component right back) from recursing forever.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SUBAGENT_RPC_REPLY_PREFIX, SUBAGENT_RPC_REQUEST } from "./subagents.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

/**
 * pi's library entry (not the CLI): bundle is the shape `pi` actually runs, dist is
 * the node build shape — both can load extensions.
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
const skip = piEntry === undefined ? "could not find the local pi library entry (requires an installed pi)" : false;

test("local /recap and idle recap display an excerpt with zero auth or inference calls", { skip, timeout: 15000 }, async () => {
	const workspace = makeWorkspace();
	let extension: any;
	try {
		const pi = await import(pathToFileURL(piEntry as string).href);
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], workspace.projectDir, workspace.agentDir, createTestBus());
		assert.deepEqual(loaded.errors, []);
		extension = loaded.extensions[0];
		const recorder: Recorder = { completeCalls: 0, widgets: [], notifies: [] };
		const ctx: any = createContext(recorder, [
			{ type: "message", message: { role: "user", content: "Fix fhash" } },
			{ type: "message", message: { role: "assistant", content: "Fixed fhash; tests passed." } },
		]);
		ctx.model = { provider: "llama-local", id: "test", baseUrl: "http://127.0.0.1:8080/v1" };
		let requests = 0;
		ctx.modelRegistry = {
			getApiKeyAndHeaders() { requests++; throw new Error("No local recap auth allowed"); },
			complete() { requests++; throw new Error("No local recap inference allowed"); },
		};
		await extension.commands.get("recap").handler("", ctx);
		assert.deepEqual(recorder.notifies, ["✦ Recap: Fixed fhash; tests passed."]);
		assert.equal(recorder.widgets.length, 1);
		await extension.commands.get("recap").handler("", ctx);
		assert.equal(recorder.widgets.length, 1, "manual recap is idempotent");
		await extension.handlers.get("input")[0]({ source: "interactive" }, ctx);
		await extension.handlers.get("agent_settled")[0]({}, ctx);
		await new Promise(resolve => setTimeout(resolve, 11500));
		assert.equal(recorder.widgets.length, 2, "idle recap displays without inference");
		assert.equal(requests, 0);
	} finally {
		await extension?.handlers.get("session_shutdown")?.[0]?.({}, {});
		workspace.cleanup();
	}
});

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface WidgetComponent {
	render(width: number): string[];
}
type WidgetFactory = (tui: unknown, theme: unknown) => WidgetComponent;

interface Recorder {
	/** How many times `modelRegistry.complete` was called (one recap generation = one). */
	completeCalls: number;
	/** One entry per `setWidget(key, <factory>)`; undefined is not recorded. */
	widgets: WidgetFactory[];
	/** The texts `ui.notify` received (a `✦ Recap: …` on success, a "could not generate recap…" on failure). */
	notifies: string[];
}

/** The fake ctx: only what recap's path really uses. */
function createContext(recorder: Recorder, branch?: unknown[]): unknown {
	return {
		mode: "tui",
		isIdle: () => true,
		model: { provider: "test", id: "test-model" },
		sessionManager: {
			getBranch: () =>
				branch ?? [
					{ type: "message", message: { role: "user", content: "reschedule recap to wait for the subagent" } },
					{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done, waiting on the subagent's result." }] } },
				],
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
			complete: async () => {
				recorder.completeCalls += 1;
				return { content: [{ type: "text", text: "rescheduled recap to wait for the subagent" }] };
			},
		},
		ui: {
			setWidget: (_key: string, widget: unknown) => {
				if (widget) recorder.widgets.push(widget as WidgetFactory);
			},
			notify: (message: string) => {
				recorder.notifies.push(message);
			},
		},
	};
}

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
			// a copy: the real EventEmitter also dispatches synchronously to subscribers.
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
}

/** Wait until the predicate holds; on timeout report what was being waited for. */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting for: ${what} (timeout ${timeoutMs}ms)`);
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-recap-idle-gate-"));
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

test("no recap is generated while a subagent runs; once it ends, a fresh 10s timer generates", { skip, timeout: 180_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const bus = createTestBus();
		/** The fake pi-subagents: `active` is its `status` reply's `fleet.totalActive`. */
		const bridge = { active: true, requests: [] as Array<Record<string, unknown>> };
		bus.on(SUBAGENT_RPC_REQUEST, (data) => {
			const request = data as Record<string, unknown>;
			bridge.requests.push(request);
			const reply = {
				version: 1,
				requestId: request.requestId,
				method: "status",
				success: true,
				data: { text: "…", fleet: { version: 1, entries: [], totalActive: bridge.active ? 1 : 0, omitted: 0 } },
			};
			// a real RPC reply is async (the handler awaits).
			setTimeout(() => bus.emit(`${SUBAGENT_RPC_REPLY_PREFIX}${String(request.requestId)}`, reply), 0);
		});

		const pi = (await import(pathToFileURL(piEntry as string).href)) as {
			discoverAndLoadExtensions: (
				configuredPaths: string[],
				cwd: string,
				agentDir?: string,
				eventBus?: unknown,
			) => Promise<{
				extensions: Array<{ handlers: Map<string, Handler[]>; commands: Map<string, unknown> }>;
				errors: Array<{ path: string; error: string }>;
			}>;
		};
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], workspace.projectDir, workspace.agentDir, bus);
		assert.deepEqual(loaded.errors, [], "pi's extension loader must not error (the `./subagents.ts` import is verified here too)");
		assert.equal(loaded.extensions.length, 1);
		const extension = loaded.extensions[0];
		assert.ok(extension);

		// the registration surface: the timers (agent_settled / agent_start) and cleanup (session_*) hang here, the command surface has /recap.
		const settled = extension.handlers.get("agent_settled")?.[0];
		const shutdown = extension.handlers.get("session_shutdown")?.[0];
		assert.ok(settled, "agent_settled should be registered");
		assert.ok(extension.handlers.get("agent_start")?.length, "agent_start should be registered");
		assert.ok(extension.handlers.get("input")?.length, "input should be registered");
		assert.ok(shutdown, "session_shutdown should be registered");
		assert.ok(extension.commands.has("recap"), "the /recap command should be registered");

		const recorder: Recorder = { completeCalls: 0, widgets: [], notifies: [] };
		const ctx = createContext(recorder);

		// the turn ends: arm the 10s idle timer (no output at this point).
		await settled({}, ctx);
		assert.equal(recorder.completeCalls, 0);
		assert.equal(recorder.widgets.length, 0);

		// ~10s later the first probe: the fake fleet has 1 active subagent → re-check only, no generation.
		await waitFor(() => bridge.requests.length >= 1, 45_000, "the first subagent probe after 10 idle seconds");
		assert.equal(bridge.requests[0]?.method, "status");
		assert.equal(recorder.completeCalls, 0, "a recap must never be generated while a subagent runs");
		assert.equal(recorder.widgets.length, 0, "no recap widget may appear while a subagent runs");

		// the subagent ends: the next re-check (10s per round) confirms "nothing left" — but no generation either,
		// instead a fresh 10s timer arms (the result just arrived, the woken turn is about to run — a recap now is half-done).
		bridge.active = false;
		await waitFor(() => bridge.requests.length >= 2, 15_000, "the 10s re-check in waiting mode");
		assert.equal(recorder.completeCalls, 0, "finding no work should re-arm a 10s timer, not generate right away");

		// after the re-armed 10s: generate and show the recap.
		await waitFor(() => recorder.completeCalls >= 1, 45_000, "the recap generation 10s after the re-armed timer");
		assert.equal(recorder.widgets.length, 1, "the recap should be on a widget already");

		// the widget renders the cleaned recap text (`✦ Recap:` prefix + a trailing blank row).
		const component = recorder.widgets[0]?.(undefined, { fg: (_color: string, text: string) => text });
		assert.ok(component);
		const rendered = component.render(80).join("\n");
		assert.match(rendered, /✦ Recap:/);
		assert.match(rendered, /rescheduled recap to wait for the subagent/);

		await shutdown?.({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("the gap is decided by inspecting neighbours at render: no neighbour → none, a content neighbour → one row, a blank-tailed neighbour → none again, re-entry → no infinite recursion", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const bus = createTestBus();
		const pi = (await import(pathToFileURL(piEntry as string).href)) as {
			discoverAndLoadExtensions: (
				configuredPaths: string[],
				cwd: string,
				agentDir?: string,
				eventBus?: unknown,
			) => Promise<{
				extensions: Array<{
					commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
				}>;
				errors: Array<{ path: string; error: string }>;
			}>;
		};
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], workspace.projectDir, workspace.agentDir, bus);
		assert.deepEqual(loaded.errors, []);
		const command = loaded.extensions[0]?.commands.get("recap");
		assert.ok(command, "the /recap command should be registered");

		// /recap takes the force=true path (skipping the 10s idle gate); the captured widget factory is the render site.
		const recorder: Recorder = { completeCalls: 0, widgets: [], notifies: [] };
		await command.handler("", createContext(recorder));
		assert.equal(recorder.widgets.length, 1, "/recap should mount a widget");

		const theme = { fg: (_color: string, text: string) => text };
		/** Every scenario needs a fresh component: the re-entry flag lives in the closure — no reuse. */
		const newComponent = (tui: unknown): WidgetComponent =>
			(recorder.widgets[0] as WidgetFactory)(tui, theme);
		/** pi's "above the editor" container looks like this: an all-blank Spacer first, then each extension's widget in registration order. */
		const container = (...neighbours: unknown[]): { children: unknown[] } => {
			const tui = { children: [{ render: (): string[] => [""] }] as unknown[] };
			for (const neighbour of neighbours) tui.children.push(neighbour);
			return tui;
		};

		// 1) only ourselves in the container (the Spacer above is an empty row) → no leading blank.
		const alone = newComponent(undefined);
		const aloneLines = alone.render(80);
		assert.equal(aloneLines.length, 2, "alone = the recap row + one blank row below");
		assert.match(aloneLines[0] ?? "", /✦ Recap:/);
		assert.equal(aloneLines[1], "", "one blank row below the recap, always");

		// 2) the neighbour above has visible content (the task list / pi-subagents's `async subagent` block) → a leading blank is added.
		const withNeighbour = container({ render: (): string[] => [" ● 3 tasks", "  ◻ #1 task-a"], invalidate() {} });
		const spaced = newComponent(withNeighbour);
		withNeighbour.children.push(spaced);
		const spacedLines = spaced.render(80);
		assert.equal(spacedLines.length, 3, "a content neighbour → exactly one leading blank");
		assert.equal(spacedLines[0], "");
		assert.match(spacedLines[1] ?? "", /✦ Recap:/);
		assert.equal(spacedLines[2], "", "the trailing blank is unaffected");

		// 3) the neighbour itself ends in a blank row (a gap already exists) → nothing added — or there would be two.
		const blankTailed = container({ render: (): string[] => [" ● 3 tasks", ""], invalidate() {} });
		const quiet = newComponent(blankTailed);
		blankTailed.children.push(quiet);
		const quietLines = quiet.render(80);
		assert.equal(quietLines.length, 2, "a blank-tailed neighbour → no second pad");
		assert.match(quietLines[0] ?? "", /✦ Recap:/);

		// 4) the neighbour's render re-renders recap in turn (that is how simple-task's gap.ts inspects neighbours) →
		//    the re-entry guard holds: exactly one re-entry, and that one carries no leading blank; the gap is decided by the outer walk.
		const nested: string[][] = [];
		let cyclic: WidgetComponent | undefined;
		const cyclicNeighbour = {
			render: (): string[] => {
				nested.push(cyclic?.render(80) ?? []);
				return [" ● 3 tasks", "  ◻ #1 task-a"];
			},
			invalidate() {},
		};
		const cyclicContainer = container(cyclicNeighbour);
		cyclic = newComponent(cyclicContainer);
		cyclicContainer.children.push(cyclic);
		const outerLines = cyclic.render(80);
		assert.equal(nested.length, 1, "the re-entry happens exactly once (without the guard it recurses to stack overflow)");
		assert.equal(nested[0]?.length, 2, "the re-entered render emits only content rows");
		assert.match(nested[0]?.[0] ?? "", /✦ Recap:/);
		assert.equal(outerLines.length, 3, "the outer walk sees content → a leading blank is added");
		assert.equal(outerLines[0], "");
		assert.match(outerLines[1] ?? "", /✦ Recap:/);
	} finally {
		workspace.cleanup();
	}
});

/**
 * `/recap`'s repeat-run gate: when the current turn already has a recap still on
 * screen, re-running neither re-calls the model nor re-mounts the widget nor sends a
 * notification — a generation that comes back empty would let the failure notice push
 * the fresh recap off.
 * The rule is "a recap exists **and** its fingerprint (last user+assistant+model)
 * matches the one it was generated with", so the gate opens the moment new
 * conversation arrives: on the normal path the `input` event has already cleared the
 * state (covered here too), and a non-interactive new message opens it via the
 * different fingerprint.
 */
test("/recap run twice neither re-calls the model nor notifies; it regenerates only after new conversation", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const bus = createTestBus();
		const pi = (await import(pathToFileURL(piEntry as string).href)) as {
			discoverAndLoadExtensions: (
				configuredPaths: string[],
				cwd: string,
				agentDir?: string,
				eventBus?: unknown,
			) => Promise<{
				extensions: Array<{
					handlers: Map<string, Handler[]>;
					commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
				}>;
				errors: Array<{ path: string; error: string }>;
			}>;
		};
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], workspace.projectDir, workspace.agentDir, bus);
		assert.deepEqual(loaded.errors, []);
		const command = loaded.extensions[0]?.commands.get("recap");
		const onInput = loaded.extensions[0]?.handlers.get("input")?.[0];
		assert.ok(command, "the /recap command should be registered");
		assert.ok(onInput, "input should be registered");

		/** The mutable conversation branch: pushing a message pair is one more exchange. */
		const branch: unknown[] = [
			{ type: "message", message: { role: "user", content: "a" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "b" }] } },
		];
		const recorder: Recorder = { completeCalls: 0, widgets: [], notifies: [] };
		const ctx = createContext(recorder, branch);

		// the first run: normal generation + notification.
		await command.handler("", ctx);
		assert.equal(recorder.completeCalls, 1, "the first /recap should generate");
		assert.equal(recorder.widgets.length, 1);
		assert.deepEqual(recorder.notifies, ["✦ Recap: rescheduled recap to wait for the subagent"]);

		// the second run (no new conversation): the gate hits — nothing happens.
		await command.handler("", ctx);
		assert.equal(recorder.completeCalls, 1, "the same turn must not call the model twice");
		assert.equal(recorder.widgets.length, 1, "the widget must not be remounted");
		assert.equal(recorder.notifies.length, 1, "no second notification (a failure notice would push the recap off)");

		// new conversation + interactive input: `input` clears the recap and state first — running it should regenerate.
		branch.push({ type: "message", message: { role: "user", content: "c" } });
		branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "d" }] } });
		await onInput({ source: "interactive" }, ctx);
		await command.handler("", ctx);
		assert.equal(recorder.completeCalls, 2, "after input cleared the state it should regenerate");
		assert.equal(recorder.notifies.length, 2);

		// pressing it again right after: same turn again — no repeat.
		await command.handler("", ctx);
		assert.equal(recorder.completeCalls, 2, "the same turn still does not repeat");

		// new conversation with no `input` sent (a non-interactive message cannot clear the state) → the fingerprint differs and the gate opens anyway.
		branch.push({ type: "message", message: { role: "user", content: "e" } });
		branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "f" }] } });
		await command.handler("", ctx);
		assert.equal(recorder.completeCalls, 3, "a changed fingerprint should regenerate");

		await loaded.extensions[0]?.handlers.get("session_shutdown")?.[0]?.({}, ctx);
	} finally {
		workspace.cleanup();
	}
});
