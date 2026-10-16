/**
 * explored-group / render — end-to-end rendering tests.
 *
 * Same technique as `bash-command-collapse/render.test.ts`: pi's own loader really loads the
 * three extensions, then pi's own `ToolExecutionComponent` renders real blocks, and assertions
 * run against **the rendered lines** — this feature's whole value is "what the screen looks
 * like", and testing only internal functions misses problems that emerge from layering.
 *
 * Run with:  node --test clients/pi/extensions/explored-group/render.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(HERE, "..");
const CWD = "/Users/bachi/jaylli/litellm-any";
const SKIP = "cannot find the local pi library entry (requires pi installed)";

async function findPiLibraryEntry(): Promise<string | undefined> {
	const packageDir = path.join(os.homedir(), ".pi/agent/npm/node_modules/@earendil-works/pi-coding-agent");
	const candidates = [
		process.env.PI_TEST_PI_ENTRY,
		path.join(packageDir, "dist/bundle/index.js"),
		path.join(packageDir, "dist/index.js"),
	].filter((c): c is string => typeof c === "string");
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			await import(pathToFileURL(candidate).href);
			return candidate;
		} catch {
			// hollow copy: try the next candidate
		}
	}
	return undefined;
}

if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

interface PiApi {
	discoverAndLoadExtensions: (
		paths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{
		extensions: Array<{ tools: Map<string, { definition: any }> }>;
		errors: Array<{ path: string; error: string }>;
	}>;
	createEventBus: () => unknown;
	initTheme: (name?: string, interactive?: boolean) => void;
	ToolExecutionComponent: new (
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: unknown,
		toolDefinition: any,
		ui: { requestRender(): void },
		cwd: string,
	) => {
		markExecutionStarted: () => void;
		setArgsComplete?: () => void;
		setExpanded: (expanded: boolean) => void;
		updateResult: (result: unknown, isPartial?: boolean) => void;
		render: (width: number) => string[];
	};
}

let pi: PiApi | undefined;
if (piEntry) {
	pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;
	// Rendering reads the theme (`theme.getFgAnsi` / `theme.fg`); without init it throws
	// "Theme not initialized" outright. The default skin is changed elsewhere, so pin 1337 here.
	pi.initTheme("pi-coder-1337", false);
}

/** All three extensions load together: group state is a cross-extension `globalThis` singleton and only a real load can build it. */
const loaded = pi
	? await pi.discoverAndLoadExtensions(
			[
				path.join(EXT_DIR, "explored-group/index.ts"),
				path.join(EXT_DIR, "bash-command-collapse.ts"),
				path.join(EXT_DIR, "read-path-collapse.ts"),
			],
			CWD,
			path.join(os.tmpdir(), "explored-group-test-agent"),
			pi.createEventBus(),
		)
	: undefined;

const definitionOf = (name: string): any =>
	loaded?.extensions.flatMap((e) => [...e.tools.entries()]).find(([n]) => n === name)?.[1].definition;

const registry = piEntry ? await import(pathToFileURL(path.join(HERE, "registry.ts")).href) : undefined;

/** Strip ANSI / OSC, leaving only visible text. */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "").replace(/\s+$/, "");
/** Render a whole block + strip ANSI + drop the leading blank line ToolExecutionComponent adds itself. */
function renderBlock(name: string, id: string, args: unknown, expanded = false, width = 100): string[] {
	const component = new pi!.ToolExecutionComponent(name, id, args, {}, definitionOf(name), { requestRender() {} }, CWD);
	component.markExecutionStarted();
	component.setArgsComplete?.(); // without this, bash blocks stay hidden as "command still streaming" (existing behavior)
	component.setExpanded(expanded);
	const lines = component.render(width).map(plain);
	if (lines[0] === "") lines.shift();
	return lines;
}

/** Render a whole block, **keeping ANSI** (for bold assertions; `plain` would strip bold too). */
function renderBlockRaw(name: string, id: string, args: unknown, width = 100, expanded = false): string[] {
	const component = new pi!.ToolExecutionComponent(name, id, args, {}, definitionOf(name), { requestRender() {} }, CWD);
	component.markExecutionStarted();
	component.setArgsComplete?.();
	component.setExpanded(expanded);
	const lines = component.render(width);
	if (lines[0] === "") lines.shift();
	return lines;
}

/** Whether the word `Read` on this line is bold (the verb only, not the path that follows). */
function readVerbIsBold(line: string): boolean {
	// bold toggles around the glyph: pi uses `\u001b[1m` … `\u001b[22m` (`theme.bold()` = chalk.bold)
	const at = line.indexOf("Read");
	if (at < 0) return false;
	const before = line.slice(0, at);
	const lastOn = before.lastIndexOf("\u001b[1m");
	const lastOff = before.lastIndexOf("\u001b[22m");
	return lastOn > lastOff;
}

/**
 * Build an assistant message and replay it (the authoritative entry for breaks and registration).
 *
 * Goes through the **same two steps** as `index.ts`'s `message_end` handler: first
 * `replayMessage` (break + register), then `markMessageReady` (open the gate so members enter
 * the tree). Without the second step, the test treats "a message from history" as "a message
 * currently streaming", and every line stays not-ready and renders empty — that is the test
 * mis-simulating, not an implementation bug.
 *
 * Use `replayStreaming()` when you need "register only, do not open the gate"
 * (testing streaming-time invisibility).
 */
function replay(content: unknown[]): void {
	registry!.replayMessage({ role: "assistant", content });
	registry!.markMessageReady({ role: "assistant", content });
}

/** Replay the message only (simulating the moment of `message_update`: registered, but the command has not finished streaming). */
function replayStreaming(content: unknown[]): void {
	registry!.replayMessage({ role: "assistant", content });
}

function reset(): void {
	registry!.resetForTesting();
	// `resetForTesting` clears the "taken over" gate too, while a real session opens it at
	// `session_start`; without opening it the rendering layer hides nothing — and the test
	// could never exercise the streaming frame.
	registry!.arm();
}

const BASH = (command: string) => ({ command });
const READ = (p: string) => ({ path: p });

/**
 * Streaming-frame rendering: simulate pi's real call sequence while arguments have **not yet
 * arrived**.
 *
 * `renderBlock` calls `markExecutionStarted` + `setArgsComplete` up front — that is the
 * end state with **arguments complete**; in a live session pi first constructs the component
 * (args are `{}` or partial) and then calls `updateArgs()` once per `input_json_delta` — the
 * user's 2026-10-06 report "a stretch of grey text streams out first, then it folds" lives in
 * this window. Returns the lines rendered at each step (ANSI stripped), to assert "not a single
 * intermediate frame may appear".
 */
function renderStreamingFrames(name: string, id: string, argsSteps: unknown[], width = 100): string[][] {
	const frames: string[][] = [];
	const push = (c: any) => {
		const lines = c.render(width).map(plain);
		if (lines[0] === "") lines.shift();
		frames.push(lines);
	};
	const component = new pi!.ToolExecutionComponent(name, id, {}, {}, definitionOf(name), { requestRender() {} }, CWD);
	push(component);
	for (const args of argsSteps) {
		component.updateArgs(args);
		push(component);
	}
	return frames;
}

test("streaming: not in the tree until arguments finish; the folded line appears the moment they do (user's 2026-10-07 report: grey text streams first, then folds)", { skip }, () => {
	// The user's words: "don't output raw streaming text first; once the bash command finishes
	// streaming … output directly as the collapsed Search". Both windows must be caught:
	//   1. **no native frame may pop** — `ensureRegistered` returns null while pending, and a
	//      renderer that assumes "null = non-foldable" falls back to the built-in renderer,
	//      flashing one frame of `grep // in .` first.
	//   2. **nor may it grow character by character in the tree** — in-line text changing with
	//      tokens (`└ bash` → `Search "auth"` → …) is still "streaming text first", just
	//      relocated.
	reset();
	const frames = renderStreamingFrames("grep", "s1", [{ pattern: "" }, { pattern: "a" }, { pattern: "authorization", path: "proxy/proxy-core" }]);
	// Nothing at all while the command is still streaming — no native frame, no half-built Explored line
	for (const [i, lines] of frames.entries()) {
		assert.deepEqual(lines, [], `frame ${i} (command not finished streaming) must render nothing, actual: ${JSON.stringify(lines)}`);
	}
	// The moment it "finishes streaming" (in real pi: message_end) → the complete line, directly
	registry!.markMessageReady({ role: "assistant", content: [{ type: "toolCall", id: "s1", name: "grep", arguments: { pattern: "authorization", path: "proxy/proxy-core" } }] });
	const after = new pi!.ToolExecutionComponent("grep", "s1", { pattern: "authorization", path: "proxy/proxy-core" }, {}, definitionOf("grep"), { requestRender() {} }, CWD);
	after.markExecutionStarted();
	after.setArgsComplete?.();
	const lines = after.render(100).map(plain);
	if (lines[0] === "") lines.shift();
	assert.deepEqual(lines, ["• Explored", '  └ Search "authorization" in proxy/proxy-core']);
});

test("streaming: an interrupted block (args never complete) must not stay permanently invisible — the error must still be visible", { skip }, () => {
	// On message_end (aborted / error), pi calls `updateResult({...}, false)` for each unfinished
	// block, **setting neither argsComplete nor filling args**. If hiding keyed only on
	// "arguments not yet arrived", this block would be permanently invisible and the user would
	// never see the `Operation aborted` line — so the hide condition must also require
	// `isPartial` (same convention as the bash side, see `shouldHideWhilePending`).
	reset();
	const component = new pi!.ToolExecutionComponent("grep", "abort-1", {}, {}, definitionOf("grep"), { requestRender() {} }, CWD);
	// Before interruption: args incomplete + still running (isPartial defaults to true at
	// construction) → invisible (no native frame drawn)
	assert.deepEqual(component.render(100).map(plain).filter((l: string) => l !== ""), [], "should be invisible before the interrupt; must not draw a native frame");
	// Simulate pi: an error result with isPartial=false, args still empty
	component.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true }, false);
	const lines = component.render(100).map(plain).filter((l: string) => l !== "");
	assert.ok(lines.length > 0, `content must be drawn after the interrupt (otherwise permanently invisible), actual: ${JSON.stringify(lines)}`);
	assert.ok(lines.join("\n").includes("Operation aborted"), `the error must be visible after the interrupt, actual: ${JSON.stringify(lines)}`);
	// Also pin the degenerate form that made it permanently invisible: with `isPartial=false`
	// it must **no longer** hide. All three conditions of `shouldHideWhilePending` are required;
	// drop the `isPartial` one and this block is left with only the error line, the `grep`
	// title gone (observed in practice).
	assert.ok(lines.some((l: string) => l.includes("grep")), `the title must also come back (not just the error), actual: ${JSON.stringify(lines)}`);
});

test("streaming: native find / ls / read likewise show no native frame first", { skip }, () => {
	// find: hidden at `{}` / `pattern:""`, Explored as soon as pattern arrives (once popped a `find  in .`)
	reset();
	const findFrames = renderStreamingFrames("find", "st-find", [{ pattern: "" }, { pattern: "*.ts", path: "clients" }]);
	for (const [i, lines] of findFrames.entries()) assert.deepEqual(lines, [], `find frame ${i} (command still streaming) must render nothing, actual: ${JSON.stringify(lines)}`);

	// read: same (once popped a `• Read ...`)
	reset();
	const readFrames = renderStreamingFrames("read", "st-read", [
		{ path: "" },
		{ path: "/Users/bachi/jaylli/litellm-any/README.md" },
	]);
	for (const [i, lines] of readFrames.entries()) assert.deepEqual(lines, [], `read frame ${i} (arguments still streaming) must render nothing, actual: ${JSON.stringify(lines)}`);

	// ls: must also wait (once popped one native `ls` frame)
	reset();
	const lsFrames = renderStreamingFrames("ls", "st-ls", [{ path: "clients/pi" }]);
	for (const [i, lines] of lsFrames.entries()) assert.deepEqual(lines, [], `ls frame ${i} must render nothing, actual: ${JSON.stringify(lines)}`);

	// After "finishing streaming", all three show the folded line directly
	for (const [name, id, args, expected] of [
		["find", "st-find", { pattern: "*.ts", path: "clients" }, ['  └ Find *.ts in clients']],
		["read", "st-read", { path: "/Users/bachi/jaylli/litellm-any/README.md" }, ["  └ Read README.md"]],
		["ls", "st-ls", { path: "clients/pi" }, ["  └ List clients/pi"]],
	] as Array<[string, string, unknown, string[]]>) {
		reset();
		registry!.markMessageReady({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
		const c = new pi!.ToolExecutionComponent(name, id, args, {}, definitionOf(name), { requestRender() {} }, CWD);
		c.markExecutionStarted();
		c.setArgsComplete?.();
		const lines = c.render(100).map(plain);
		if (lines[0] === "") lines.shift();
		assert.deepEqual(lines, ["• Explored", ...expected], `${name} must show the folded line directly once streaming finishes`);
	}
});

test("streaming: error paths must not leave a block permanently invisible (missing message_end / interrupt / only execution_end)", { skip }, () => {
	// "Not in the tree until the command finishes streaming" carries an inherent risk: when the
	// gate-opening signal does not arrive, that block stays **permanently invisible**.
	// The primary signal is `message_end`, but three measured paths never get it (or get it
	// when args are already unreadable), so `index.ts` also hooks `tool_execution_end`, and the
	// renderer has the `markReadyIfSettled` fallback. All three are real defect shapes found by
	// measurement; removing any fallback layer reintroduces them.
	const CMD = "grep -n authorization f.ts";
	const content = [{ type: "toolCall", id: "ab1", name: "bash", arguments: { command: CMD } }];
	const renderOne = (): string[] => {
		const c = new pi!.ToolExecutionComponent("bash", "ab1", { command: CMD }, {}, definitionOf("bash"), { requestRender() {} }, CWD);
		c.markExecutionStarted();
		c.setArgsComplete?.();
		const lines = c.render(100).map(plain).filter((l: string) => l !== "");
		return lines;
	};

	// ① result returned but message_end never came (only tool_execution_end)
	reset();
	registry!.replayMessage({ role: "assistant", content });
	registry!.markMemberReady("ab1"); // equivalent to index.ts's tool_execution_end handler
	assert.ok(renderOne().length > 0, "① must not be invisible when only execution_end happened");

	// ② interrupt: args complete but never marked ready (message_end arrives, but by then the gate is no longer back-filled)
	reset();
	registry!.replayMessage({ role: "assistant", content });
	const c2 = new pi!.ToolExecutionComponent("bash", "ab1", { command: CMD }, {}, definitionOf("bash"), { requestRender() {} }, CWD);
	c2.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true }, false);
	const lines2 = c2.render(100).map(plain).filter((l: string) => l !== "");
	assert.ok(lines2.length > 0, `② must not be invisible after an interrupt, actual: ${JSON.stringify(lines2)}`);

	// ③ only message_end, the tool has not finished executing (neither result nor execution_end)
	reset();
	registry!.replayMessage({ role: "assistant", content });
	registry!.markMessageReady({ role: "assistant", content });
	assert.ok(renderOne().length > 0, "③ after streaming finishes and while executing, it must already be visible");
});

test("shape: Search and native Read merged into one block (user's second-round decision, 2026-10-06)", { skip }, () => {
	reset();
	const content = [
		{ type: "thinking", text: "let me look" },
		{ type: "toolCall", id: "g1", name: "bash", arguments: BASH("cd /Users/bachi/jaylli/litellm-any && grep -rn 'bashOutput' clients/pi --include=*.ts | head -30") },
		{ type: "toolCall", id: "g2", name: "read", arguments: READ("/Users/bachi/jaylli/ttt/CLAUDE.md") },
		{ type: "toolCall", id: "g3", name: "read", arguments: READ("/Users/bachi/jaylli/ttt/package.json") },
	];
	replay(content);

	// Three entries in one tree: Search on one line, the two consecutive native reads merged
	// into the next (no longer two separate blocks)
	assert.deepEqual(renderBlock("bash", "g1", content[1]!.arguments), [
		"• Explored",
		'  └ Search "bashOutput" in clients/pi',
		"    Read …/jaylli/ttt/CLAUDE.md, …/jaylli/ttt/package.json",
	]);
	// Group members are hidden: the native reads no longer form their own blocks
	assert.equal(renderBlock("read", "g2", content[2]!.arguments).length, 0);
	assert.equal(renderBlock("read", "g3", content[3]!.arguments).length, 0);
});

test("shape: Search/List/Git in the same family each get one line; consecutive reads merge into one line", { skip }, () => {
	reset();
	const content = [
		{ type: "toolCall", id: "m1", name: "bash", arguments: BASH("grep -rn x . --include=*.ts | head") },
		{ type: "toolCall", id: "m4", name: "ls", arguments: { path: "clients/pi/extensions" } },
		{ type: "toolCall", id: "m5", name: "grep", arguments: { pattern: "Explored", path: "clients/pi" } },
	];
	replay(content);
	// Three non-reads (bash search / native ls / native grep) in the same family: one tree, one line each
	assert.deepEqual(renderBlock("bash", "m1", content[0]!.arguments), [
		"• Explored",
		'  └ Search "x" in .',
		"    List clients/pi/extensions",
		'    Search "Explored" in clients/pi',
	]);
});

test("breaks: thinking in between → two independent Explored blocks", { skip }, () => {
	reset();
	replay([
		{ type: "toolCall", id: "k1", name: "bash", arguments: BASH("grep -n a f1.ts") },
		{ type: "thinking", text: "hmm" },
		{ type: "toolCall", id: "k2", name: "bash", arguments: BASH("grep -n b f2.ts") },
	]);
	assert.deepEqual(renderBlock("bash", "k1", BASH("grep -n a f1.ts")), ["• Explored", '  └ Search "a" in f1.ts']);
	// k2 became the leader of a new group — two blocks, one tree each
	assert.deepEqual(renderBlock("bash", "k2", BASH("grep -n b f2.ts")), ["• Explored", '  └ Search "b" in f2.ts']);
});

test("breaks: narration (non-empty text) in between splits the group the same way", { skip }, () => {
	reset();
	replay([
		{ type: "toolCall", id: "n1", name: "bash", arguments: BASH("grep -n a f1.ts") },
		{ type: "text", text: "Let me look at A first, then B." },
		{ type: "toolCall", id: "n2", name: "bash", arguments: BASH("grep -n b f2.ts") },
	]);
	assert.equal(renderBlock("bash", "n1", BASH("grep -n a f1.ts"))[0], "• Explored");
	assert.equal(renderBlock("bash", "n2", BASH("grep -n b f2.ts"))[0], "• Explored");
	// Empty text does not break (streaming sends an empty text block first)
	reset();
	replay([
		{ type: "toolCall", id: "p1", name: "bash", arguments: BASH("grep -n a f1.ts") },
		{ type: "text", text: "   \n " },
		{ type: "toolCall", id: "p2", name: "bash", arguments: BASH("grep -n b f2.ts") },
	]);
	assert.deepEqual(renderBlock("bash", "p1", BASH("grep -n a f1.ts")), [
		"• Explored",
		'  └ Search "a" in f1.ts',
		'    Search "b" in f2.ts',
	]);
	assert.equal(renderBlock("bash", "p2", BASH("grep -n b f2.ts")).length, 0, "p2 is a group member and should be hidden");
});

test("breaks: non-foldable bash (running tests) breaks the group and renders itself as-is", { skip }, () => {
	reset();
	const testCmd = "node --test index.test.ts 2>&1 | grep -E '^ℹ (tests|pass|fail)' | head -70";
	replay([
		{ type: "toolCall", id: "q1", name: "bash", arguments: BASH("grep -n a f1.ts") },
		{ type: "toolCall", id: "q2", name: "bash", arguments: BASH(testCmd) },
		{ type: "toolCall", id: "q3", name: "bash", arguments: BASH("grep -n c f3.ts") },
	]);
	assert.equal(renderBlock("bash", "q1", BASH("grep -n a f1.ts"))[0], "• Explored");
	// q2 does not fold — it renders as the original bash block (with the `Run ` prefix, not Explored)
	const q2 = renderBlock("bash", "q2", BASH(testCmd));
	assert.ok(q2.length > 0, "the test-running block must be visible");
	assert.ok(q2.some((l) => l.includes("Run ")), "it should use the original bash rendering");
	assert.ok(!q2.some((l) => l.includes("Explored")), "it must not be folded into an Explored");
	// q3 opens a new group because q2 broke it
	assert.equal(renderBlock("bash", "q3", BASH("grep -n c f3.ts"))[0], "• Explored");
});

test("breaks: a user message breaks the group", { skip }, () => {
	reset();
	replay([{ type: "toolCall", id: "u1", name: "bash", arguments: BASH("grep -n a f1.ts") }]);
	registry!.noteUserMessage();
	replay([{ type: "toolCall", id: "u2", name: "bash", arguments: BASH("grep -n b f2.ts") }]);
	assert.deepEqual(renderBlock("bash", "u1", BASH("grep -n a f1.ts")), ["• Explored", '  └ Search "a" in f1.ts']);
	assert.deepEqual(renderBlock("bash", "u2", BASH("grep -n b f2.ts")), ["• Explored", '  └ Search "b" in f2.ts']);
});

test("growth: members arrive one by one and the leader's tree grows with them (no re-registration needed)", { skip }, () => {
	reset();
	// Two bash calls from the **same family** (a native read would open its own group, see `familyOf`)
	const content: any[] = [{ type: "toolCall", id: "r1", name: "bash", arguments: BASH("grep -n a f1.ts") }];
	replay(content);
	assert.deepEqual(renderBlock("bash", "r1", content[0].arguments), ["• Explored", '  └ Search "a" in f1.ts']);
	// Stream the second member in (`message_update` fires repeatedly; the registry dedupes by content fingerprint)
	content.push({ type: "toolCall", id: "r2", name: "bash", arguments: BASH("ls -la /tmp") });
	replay(content);
	assert.deepEqual(renderBlock("bash", "r1", content[0].arguments), [
		"• Explored",
		'  └ Search "a" in f1.ts',
		"    List /tmp",
	]);
	// The native read joins this tree too (second round, 2026-10-06: family no longer breaks),
	// with the line split by source
	content.push({ type: "toolCall", id: "r3", name: "read", arguments: READ("/tmp/a/b/c.ts") });
	replay(content);
	assert.deepEqual(renderBlock("bash", "r1", content[0].arguments), [
		"• Explored",
		'  └ Search "a" in f1.ts',
		"    List /tmp",
		"    Read …/a/b/c.ts",
	]);
	assert.equal(renderBlock("read", "r3", READ("/tmp/a/b/c.ts")).length, 0, "the member should be hidden");
});

test("regression: repeated streaming updates must not split the group (pi sends a fresh object on every message_update)", { skip }, () => {
	// The user's 2026-10-06 report of "two adjacent Explored blocks": every assistant message
	// starts with a thinking block, and `replayMessage` once used the **message object** as its
	// dedup key — but pi sends `{...partialMessage}` (a new object), so every token update
	// re-ran content[0]'s thinking and broke the group again, leaving every tool block in its
	// own group.
	reset();
	const th = { type: "thinking", text: "x" };
	const a = { type: "toolCall", id: "A", name: "bash", arguments: BASH("grep -n a f1.ts") };
	const b = { type: "toolCall", id: "B", name: "bash", arguments: BASH("grep -n b f2.ts") };
	// Note `replay()` takes the **content array** (it wraps role itself); do not pass {role, content}
	replay([th]);
	// Simulate pi's streaming: a new object each time, content appends; each tool block
	// registers via renderCall the moment it is created
	registry!.ensureRegistered("A", "bash", a.arguments);
	replay([th, a]);
	registry!.ensureRegistered("B", "bash", b.arguments);
	replay([th, a, b]);
	assert.equal(registry!.groupOf("A")?.leaderId, "A");
	assert.equal(registry!.groupOf("B")?.leaderId, "A", "the second foldable block in the same message must join the same group");
	// But the thinking of the **next** assistant message still breaks (the user explicitly wants Thinking to break)
	replay([{ type: "thinking", text: "y" }, { type: "toolCall", id: "C", name: "bash", arguments: BASH("grep -n c f3.ts") }]);
	assert.equal(registry!.groupOf("C")?.leaderId, "C", "the new message's thinking must break the group");
});

test("regression: the leader block also hides its own output when collapsed (the whole group shows no content)", { skip }, () => {
	// The user's first problem reported on 2026-10-06: a whole wall of grep hits trailing below
	// the phrase tree. Root cause: renderResult hid only the **members**, not the **leader**.
	reset();
	replay([
		{ type: "toolCall", id: "L1", name: "bash", arguments: BASH("grep -n needle f1.ts") },
		{ type: "toolCall", id: "L2", name: "bash", arguments: BASH("grep -n other f2.ts") },
	]);
	const result = {
		content: [{ type: "text", text: "4:from http.server import ThreadingHTTPServer\n57:    server = ThreadingHTTPServer((\"0.0.0.0\", PORT), StaticHandler)" }],
		details: {},
	};
	const renderLeader = (expanded: boolean): string[] => {
		const c = new pi!.ToolExecutionComponent("bash", "L1", BASH("grep -n needle f1.ts"), {}, definitionOf("bash"), { requestRender() {} }, CWD);
		c.markExecutionStarted();
		c.setArgsComplete?.();
		c.setExpanded(expanded);
		c.updateResult(result, false);
		return c.render(120).map(plain);
	};
	const collapsed = renderLeader(false);
	assert.ok(
		!collapsed.some((l) => l.includes("ThreadingHTTPServer")),
		`collapsed mode must not show output content: ${JSON.stringify(collapsed)}`,
	);
	// Expanded mode (ctrl+o) still shows the content — that is the only place it is visible
	const expanded = renderLeader(true);
	assert.ok(expanded.some((l) => l.includes("ThreadingHTTPServer")), "expanded mode must show the content");
});

test("regression: empty args early in streaming must refresh once the real args arrive (once produced `└ Read read`)", { skip }, () => {
	// `renderCall` runs while arguments are still streaming, so the first registration often
	// gets empty args. An idempotent `register` must not "settle and never change", otherwise
	// the path never arrives.
	reset();
	registry!.ensureRegistered("R1", "read", {});
	registry!.ensureRegistered("R1", "read", READ("/Users/bachi/jaylli/ttt/a/b/c/CLAUDE.md"));
	replay([
		{ type: "toolCall", id: "R1", name: "read", arguments: READ("/Users/bachi/jaylli/ttt/a/b/c/CLAUDE.md") },
		{ type: "toolCall", id: "R2", name: "read", arguments: READ("/Users/bachi/jaylli/ttt/a/b/c/package.json") },
	]);
	const lines = renderBlock("read", "R1", READ("/Users/bachi/jaylli/ttt/a/b/c/CLAUDE.md"));
	assert.ok(!lines.some((l) => /└ Read read\b/.test(l)), `must not show Read read: ${JSON.stringify(lines)}`);
	assert.ok(
		lines.some((l) => l.includes("CLAUDE.md") && l.includes("package.json")),
		`should show both real paths, shortened to two directory levels: ${JSON.stringify(lines)}`,
	);
});

test("regression: incomplete arguments must not break the group (once produced three adjacent Explored blocks)", { skip }, () => {
	// The user's second-round report on 2026-10-06: three consecutive read-only bash calls in
	// the same message rendered as three separate `Explored` blocks. Root cause is pi's stream
	// accumulation — at the moment a tool block appears, `arguments` is `{}` (the seed from
	// `content_block_start`'s `event.content_block.input ?? {}`), filled piece by piece via
	// `input_json_delta`. The old code classified on the empty args, `classifyBash("")` returned
	// `null`, so every block triggered a `beginBreak()` the moment it appeared, closing the
	// group the previous block had just opened.
	reset();
	const th = { type: "thinking", text: "x" };
	const mk = (id: string, cmd: string) => ({ type: "toolCall", id, name: "bash", arguments: { command: cmd } });
	const b1 = mk("B1", "cd /tmp; git status 2>&1 | head -3");
	const b2 = mk("B2", "cd /tmp; ls -t sessions/ | head -5");
	// All three from non-read families (`sed -n` is read-family and would legitimately open its own group)
	const b3 = mk("B3", "cd /tmp; grep -n version CHANGELOG.md");
	// Block-by-block streaming: each block appears with args still {}, then its args arrive
	// (renderCall runs twice)
	for (const [n, block] of [[1, b1], [2, b2], [3, b3]] as const) {
		const filled = [b1, b2, b3].slice(0, n - 1);
		replay([th, ...filled, { ...block, arguments: {} }]);
		registry!.ensureRegistered(block.id, "bash", {});
		registry!.ensureRegistered(block.id, "bash", block.arguments);
		replay([th, ...filled, block]);
	}
	assert.equal(registry!.groupOf("B1")?.leaderId, "B1");
	assert.equal(registry!.groupOf("B2")?.leaderId, "B1", "incomplete arguments must not close B1's group");
	assert.equal(registry!.groupOf("B3")?.leaderId, "B1", "the third one must join the same group too");
	// The render should be a single tree with three member lines (first line `└ ` + two lines
	// of four-space indent)
	const lines = renderBlock("bash", "B1", b1.arguments);
	assert.equal(lines.filter((l) => l.startsWith("• Explored")).length, 1);
	assert.deepEqual(lines, [
		"• Explored",
		"  └ Git status",
		"    List sessions/",
		'    Search "version" in CHANGELOG.md',
	]);
	// `└ ` appears exactly once per block (user's third-round decision, 2026-10-06);
	// subsequent member lines indent four spaces
	assert.equal(lines.filter((l) => l.includes("└ ")).length, 1, `there should be exactly one └: ${JSON.stringify(lines)}`);
});
test("pending: read / grep missing required arguments also count as not-arrived; ls does not", { skip }, () => {
	// `ls`'s `path` is optional (default = current directory), so it must not be treated as
	// "not yet arrived" and thereby miss grouping
	reset();
	registry!.replayMessage({ role: "assistant", content: [{ type: "thinking", text: "x" }] });
	assert.equal(registry!.ensureRegistered("P1", "read", {}), null, "read without path → this frame does not take over");
	assert.equal(registry!.ensureRegistered("P2", "grep", {}), null, "grep without pattern → does not take over");
	assert.ok(registry!.ensureRegistered("P3", "ls", {}) !== null, "ls without path is a legal value and should join normally");
});

test("regression: reading SKILL.md is not folded into Explored; pi's `[skill] <name>` compact shape is restored", { skip }, () => {
	// The user's 2026-10-06 report: reading a skill file became
	// `└ Read …/skills/commit/SKILL.md`, while they expected pi's original
	// `• [skill] commit (ctrl+o to expand)`.
	// Only SKILL.md is exempt (the user's chosen scope) — `read docs` / `read resource` still
	// fold as usual.
	reset();
	replay([
		{ type: "toolCall", id: "S1", name: "read", arguments: READ("/Users/bachi/.pi/agent/git/github.com/jayli/superpowers/skills/commit/SKILL.md") },
	]);
	const lines = renderBlock("read", "S1", READ("/Users/bachi/.pi/agent/git/github.com/jayli/superpowers/skills/commit/SKILL.md"));
	const joined = lines.join("\n");
	assert.ok(!joined.includes("Explored"), `SKILL.md must not fold into an Explored: ${JSON.stringify(lines)}`);
	assert.ok(joined.includes("[skill]"), `it should use pi's [skill] shape: ${JSON.stringify(lines)}`);
	assert.ok(joined.includes("commit"), `the label should be the containing directory name: ${JSON.stringify(lines)}`);
});

test("regression: reading SKILL.md neither breaks the group nor joins it, but must separate the read-only groups before and after it", { skip }, () => {
	// SKILL.md is a "definite non-foldable" (not pending), so it behaves like the
	// "running tests" block: it renders as-is and seals the previous group. Lookups before and
	// after a skill read should not merge into one group.
	reset();
	replay([
		{ type: "toolCall", id: "Z1", name: "bash", arguments: BASH("grep -n a f1.ts") },
		{ type: "toolCall", id: "Z2", name: "read", arguments: READ("/a/b/skills/x/SKILL.md") },
		{ type: "toolCall", id: "Z3", name: "bash", arguments: BASH("grep -n c f3.ts") },
	]);
	assert.equal(registry!.groupOf("Z2"), undefined, "SKILL.md must not join a group");
	assert.deepEqual(renderBlock("bash", "Z1", BASH("grep -n a f1.ts")), ["• Explored", '  └ Search "a" in f1.ts']);
	// Z3 comes **after** the SKILL.md → must open a new group (proving Z2 really broke the
	// group, rather than being skipped)
	assert.deepEqual(renderBlock("bash", "Z3", BASH("grep -n c f3.ts")), ["• Explored", '  └ Search "c" in f3.ts']);
});

test("marker: the native read's `Read` is bold, bash-derived Reads are not (bold the verb only, never the path)", { skip }, () => {
	// The user's 2026-10-06 decision: `cat f` and the native `read({path: f})` produce
	// identical phrases, indistinguishable on screen — so only the **native read tool**'s line
	// gets a bold `Read`.
	// Render only the **native read** group (family rules guarantee no bash-derived Read can
	// mix in).
	reset();
	replay([
		{ type: "toolCall", id: "b1", name: "read", arguments: READ("/tmp/native.ts") },
		{ type: "toolCall", id: "b2", name: "read", arguments: READ("/tmp/native2.ts") },
	]);
	const nativeLines = renderBlockRaw("read", "b1", READ("/tmp/native.ts"));
	const nativeRow = nativeLines.find((l) => l.includes("native.ts"))!;
	assert.ok(readVerbIsBold(nativeRow), `the native read must be bold: ${JSON.stringify(nativeRow)}`);
	// **The path must not be bold**: right after the word `Read` comes the bold-off sequence
	// (otherwise the path would be inside the bold too)
	const afterVerb = nativeRow.slice(nativeRow.indexOf("Read") + "Read".length);
	assert.ok(
		afterVerb.startsWith("\u001b[22m"),
		`bold must turn off immediately after \`Read\` (path not bold): ${JSON.stringify(nativeRow)}`,
	);
	assert.ok(!afterVerb.includes("\u001b[1m"), `no bold may open inside the path: ${JSON.stringify(afterVerb)}`);

	// The same file read via bash `cat` — identical shape, but Read is not bold.
	// Both sides read exactly **one** file, so after stripping color they must be identical strings.
	reset();
	replay([{ type: "toolCall", id: "b1", name: "read", arguments: READ("/tmp/native.ts") }]);
	const singleNativeRow = renderBlockRaw("read", "b1", READ("/tmp/native.ts")).find((l) => l.includes("native.ts"))!;
	reset();
	replay([{ type: "toolCall", id: "c1", name: "bash", arguments: BASH("cat /tmp/native.ts") }]);
	const bashLines = renderBlockRaw("bash", "c1", BASH("cat /tmp/native.ts"));
	const bashRow = bashLines.find((l) => l.includes("native.ts"))!;
	assert.ok(!readVerbIsBold(bashRow), `the bash-derived Read must not be bold: ${JSON.stringify(bashRow)}`);
	// The two must be identical after removing color — the difference is **only** the bold marker
	assert.equal(plain(singleNativeRow).trim(), plain(bashRow).trim());
});

test("regression: with a long file name wrapping, the continuation line must not redraw Read (user's 2026-10-07 report, measured at width=79)", { skip }, () => {
	// The reported shape: a bash-derived `cat <long name>`, the name just barely not fitting,
	// so the screen showed
	//
	//     └ Read pi-session-…-c7ec684628
	//       Read 7d.html                 ← the continuation got an extra verb, looking like two files were read
	//
	// Root cause in `layoutRows`: after `flatMap` flattened each entry's wrap chunks, it **lost
	// "which entry it belongs to"**, so continuation chunks looked identical to "the next file"
	// in the loop and both got a `Read ` prefix. Fix: after wrapping, keep two bits — "which
	// entry this chunk belongs to" and "is it that entry's first chunk".
	const NAME = "pi-session-2026-10-06T13-48-58-965Z_01a11179-84d5-77fd-bf01-c7ec6846287d.html";
	reset();
	const args = BASH(`cat ${NAME}`);
	replay([{ type: "toolCall", id: "n1", name: "bash", arguments: args }]);
	const lines = renderBlock("bash", "n1", args, false, 79);

	// The entry wraps into two lines: 1 header + 2 member lines
	assert.equal(lines.length, 3, `should wrap into "header + 2 member lines": ${JSON.stringify(lines)}`);
	assert.ok(lines[1]!.startsWith("  └ Read "), `the first line still carries └ and Read: ${JSON.stringify(lines[1])}`);
	// The continuation must have **indent only**, with no `Read` reappearing; stitched back
	// together it must equal the original file name
	const body = lines.slice(1);
	assert.ok(!body[1]!.includes("Read"), `the continuation must not redraw Read: ${JSON.stringify(body[1])}`);
	assert.equal(body[1]!.trim(), "7d.html", `the continuation should be only the tail: ${JSON.stringify(body[1])}`);
	const rebuilt = body[0]!.replace("  └ Read ", "") + body[1]!.trim();
	assert.equal(rebuilt, NAME, `the two lines stitched back must equal the original file name: ${JSON.stringify(rebuilt)}`);
});

test("regression: a single wrapped file must not be stitched to the next file with `, `", { skip }, () => {
	// The second symptom of the same root cause (harder to spot, and more wrong): entry A's
	// **tail fragment** was treated in the next loop iteration as "another entry" and stitched
	// with the real b.ts into `Read z, b.ts` — on screen it looks like "two files were read",
	// when in fact A's name was cut and a nonexistent `z` appeared.
	// Measured: A is 71 chars (70 a's + z), stably reproduced at width 79.
	reset();
	const A = `${"a".repeat(70)}z`;
	const content = [
		{ type: "toolCall", id: "t1", name: "read", arguments: READ(A) },
		{ type: "toolCall", id: "t2", name: "read", arguments: READ("b.ts") },
	];
	replay(content);
	const lines = renderBlock("read", "t1", READ(A), false, 79);
	const body = lines.slice(1);
	assert.ok(!body.some((l) => /z, b\.ts/.test(l)), `A's tail chunk must not be stitched to b.ts: ${JSON.stringify(body)}`);
	// A's two chunks still form A (with nothing inserted between)
	const aLines = body.filter((l) => !l.includes("b.ts"));
	assert.equal(
		aLines.map((l) => l.replace(/^\s*(└ )?Read /, "").replace(/^\s+/, "")).join(""),
		A,
		`A's wrapped chunks joined back must equal A: ${JSON.stringify(aLines)}`,
	);
});

test("marker: when a read-merged line wraps, the continuation's Read is bold too", { skip }, () => {
	reset();
	const long = (n: string): string => `/Users/bachi/jaylli/litellm-any/clients/pi/extensions/explored-group/a-very-long-file-name-${n}.ts`;
	replay([
		{ type: "toolCall", id: "l1", name: "read", arguments: READ(long("a")) },
		{ type: "toolCall", id: "l2", name: "read", arguments: READ(long("b")) },
		{ type: "toolCall", id: "l3", name: "read", arguments: READ(long("c")) },
	]);
	const lines = renderBlockRaw("read", "l1", READ(long("a")), 80);
	// Filter with `plain`: in raw lines the bold-off sequence immediately follows `Read`, so
	// `includes("Read ")` cannot match
	const readRows = lines.filter((l) => plain(l).includes("Read "));
	assert.ok(readRows.length >= 2, `at narrow width it should wrap into multiple lines: ${JSON.stringify(lines.map(plain))}`);
	for (const row of readRows) {
		assert.ok(readVerbIsBold(row), `every line's Read must be bold: ${JSON.stringify(plain(row))}`);
	}
});

test("merge: consecutive lookups across assistant messages merge into one block (user's second-round decision, 2026-10-06)", { skip }, () => {
	// The visual problem the user measured: every assistant message broke the group at its
	// start, so the screen was full of single-line Explored blocks. Now only narration /
	// Thinking / non-foldable tools / user messages break; **message boundaries do not**.
	reset();
	replay([{ type: "toolCall", id: "m1", name: "bash", arguments: BASH("grep -n a f1.ts") }]);
	// A second assistant message (no narration / thinking in between)
	replay([
		{ type: "toolCall", id: "m2", name: "read", arguments: READ("/a/x.ts") },
		{ type: "toolCall", id: "m3", name: "bash", arguments: BASH("grep -n b f2.ts") },
	]);
	assert.equal(registry!.groupOf("m2")?.leaderId, "m1", "crossing a message must not break the group");
	assert.equal(registry!.groupOf("m3")?.leaderId, "m1", "crossing a message must not break the groups");
	assert.deepEqual(renderBlock("bash", "m1", BASH("grep -n a f1.ts")), [
		"• Explored",
		'  └ Search "a" in f1.ts',
		"    Read /a/x.ts",
		'    Search "b" in f2.ts',
	]);

	// But narration inside a message still breaks (this rule is unchanged)
	reset();
	replay([{ type: "toolCall", id: "n1", name: "bash", arguments: BASH("grep -n a f1.ts") }]);
	replay([
		{ type: "text", text: "Stopping here for now." },
		{ type: "toolCall", id: "n2", name: "bash", arguments: BASH("grep -n b f2.ts") },
	]);
	assert.equal(registry!.groupOf("n2")?.leaderId, "n2", "narration must still break the group");
});

test("regression: replaying history (resume / fork) must also break groups, not merge everything into one block", { skip }, () => {
	// pi does not emit `message_*` when rebuilding history (`renderInitialMessages` just
	// constructs components and renders), so the break events for history are replayed by
	// `index.ts`'s `hydrateFromHistory` over `buildContextEntries()`.
	// Without it: since message boundaries no longer break, the whole session merges into one
	// block — measured worst case 326 members with only 5 rows on screen, history effectively
	// lost (319 of 367 measured sessions affected).
	reset();
	// Replay the "history entries" shape directly (same source as hydrateFromHistory:
	// in-order replayMessage / noteUserMessage)
	const history = [
		{ type: "thinking", text: "a" },
		{ type: "toolCall", id: "H1", name: "bash", arguments: BASH("grep -n a f1.ts") },
		{ type: "toolCall", id: "H2", name: "read", arguments: READ("/a/one.ts") },
		// the next assistant message: thinking breaks the group
		{ type: "thinking", text: "b" },
		{ type: "toolCall", id: "H3", name: "bash", arguments: BASH("grep -n b f2.ts") },
	];
	// Replay as two messages (history's shape is multiple messages)
	replay(history.slice(0, 3));
	replay(history.slice(3));
	assert.equal(registry!.groupOf("H2")?.leaderId, "H1", "Search and Read in the same message merge into one block");
	assert.equal(registry!.groupOf("H3")?.leaderId, "H3", "the next message's thinking must break the group (no merging into one block)");
});

test("mixed sources: native Reads and bash-derived Reads take separate lines within one block; bold lands only on the native line", { skip }, () => {
	// Second round, 2026-10-06: groups no longer split by family, so "within a group, reads can
	// only be of one source" no longer holds — instead, **splitting the line by source**
	// preserves "bold = native tool".
	reset();
	const content = [
		{ type: "toolCall", id: "c1", name: "bash", arguments: BASH("cat /a/first.ts") },
		{ type: "toolCall", id: "N1", name: "read", arguments: READ("/a/second.ts") },
		{ type: "toolCall", id: "N2", name: "read", arguments: READ("/a/third.ts") },
		{ type: "toolCall", id: "c2", name: "bash", arguments: BASH("cat /a/fourth.ts") },
	];
	replay(content);
	// All four in one group (no longer split by family)
	for (const id of ["N1", "N2", "c2"]) {
		assert.equal(registry!.groupOf(id)?.leaderId, "c1", `${id} should be in the same group as c1`);
	}
	assert.deepEqual(renderBlock("bash", "c1", content[0]!.arguments), [
		"• Explored",
		"  └ Read /a/first.ts", // bash-derived: not bold
		"    Read /a/second.ts, /a/third.ts", // the two native reads merged
		"    Read /a/fourth.ts", // back to bash: a new line rewrites the verb
	]);
	// Bold lands only on the native line (the second); both bash lines are not bold
	const lines = renderBlockRaw("bash", "c1", content[0]!.arguments);
	assert.equal(readVerbIsBold(lines[1]!), false, "the first line is bash-derived and must not be bold");
	assert.equal(readVerbIsBold(lines[2]!), true, "the second line is a native read and should be bold");
	assert.equal(readVerbIsBold(lines[3]!), false, "the third line is bash-derived again and must not be bold");
});

test("family rules cancelled: the native read and bash-derived Reads now share a group (reverse assertion of the old rule)", { skip }, () => {
	// In the old implementation, familyOf split the two into separate groups (fourth round,
	// 2026-10-06); the user asked for merging in the second round, so this became a reverse
	// assertion — if someone ever reintroduces family rules, this test turns red immediately.
	const B = (id: string, cmd: string) => ({ type: "toolCall", id, name: "bash", arguments: BASH(cmd) });
	reset();
	replay([
		{ type: "thinking", text: "x" },
		B("g1", "cd /tmp; git status"),
		B("l1", "cd /tmp; ls -t sessions/ | head -5"),
		B("r1", "cd /tmp; sed -n '1,60p' CHANGELOG.md"),
		{ type: "toolCall", id: "R1", name: "read", arguments: READ("/a/x.ts") },
		B("s2", "cd /tmp; grep -n c f2.ts"),
	]);
	for (const id of ["l1", "r1", "R1", "s2"]) {
		assert.equal(registry!.groupOf(id)?.leaderId, "g1", `${id} should be in the same group as g1 (family and category no longer break)`);
	}
});

test("status: the header dot recolors with the whole group's status (running=white, all ok=green, any error=red)", { skip }, () => {
	reset();
	replay([
		{ type: "toolCall", id: "s1", name: "bash", arguments: BASH("grep -n a f1.ts") },
		{ type: "toolCall", id: "s2", name: "bash", arguments: BASH("grep -n b f2.ts") },
	]);
	// With pi-coder-1337: text=`#f8f8f2` white, toolDiffAdded=`#8bc391` green, toolDiffRemoved=`#e27878` red
	pi!.initTheme("pi-coder-1337", false);
	const WHITE = "\u001b[38;2;248;248;242m";
	const GREEN = "\u001b[38;2;139;195;145m";
	const RED = "\u001b[38;2;226;120;120m";
	const dotOf = (): string => {
		const component = new pi!.ToolExecutionComponent("bash", "s1", BASH("grep -n a f1.ts"), {}, definitionOf("bash"), { requestRender() {} }, CWD);
		component.markExecutionStarted();
		component.setArgsComplete?.();
		const line = component.render(100).find((l) => l.includes("\u2022")) ?? "";
		return line.slice(0, 22);
	};
	assert.ok(dotOf().startsWith(WHITE), `a member still running → white, actual ${JSON.stringify(dotOf())}`);
	registry!.setMemberStatus("s1", "ok");
	assert.ok(dotOf().startsWith(WHITE), `one still running → still white, actual ${JSON.stringify(dotOf())}`);
	registry!.setMemberStatus("s2", "ok");
	assert.ok(dotOf().startsWith(GREEN), `all succeeded → green, actual ${JSON.stringify(dotOf())}`);
	registry!.setMemberStatus("s2", "error");
	assert.ok(dotOf().startsWith(RED), `an error → red, actual ${JSON.stringify(dotOf())}`);
});

test("row limit: beyond GROUP_MAX_ROWS it folds into `… +N`; expanded mode shows everything", { skip }, () => {
	reset();
	const content = Array.from({ length: 8 }, (_, i) => ({
		type: "toolCall",
		id: `c${i}`,
		name: "bash",
		// one independent search per line, avoiding read merging
		arguments: BASH(`grep -n needle${i} file${i}.ts`),
	}));
	replay(content);
	const collapsed = renderBlock("bash", "c0", content[0]!.arguments);
	assert.ok(collapsed.some((l) => /… \+\d+$/.test(l)), `there should be a folding line: ${JSON.stringify(collapsed)}`);
	const expanded = renderBlock("bash", "c0", content[0]!.arguments, true);
	assert.ok(!expanded.some((l) => /… \+\d+$/.test(l)), "expanded mode should not fold");
	assert.ok(expanded.length > collapsed.length);
});

test("width: every line's visible width stays within the terminal width", { skip }, () => {
	reset();
	replay([
		{ type: "toolCall", id: "w1", name: "bash", arguments: BASH("grep -rn 'a-very-long-pattern-indeed-with-many-chars' some/deeply/nested/directory/path | head") },
		{ type: "toolCall", id: "w2", name: "read", arguments: READ("/Users/bachi/jaylli/litellm-any/clients/pi/extensions/explored-group/registry.ts") },
		{ type: "toolCall", id: "w3", name: "read", arguments: READ("/Users/bachi/jaylli/litellm-any/clients/pi/extensions/explored-group/render.ts") },
	]);
	for (const width of [40, 60, 80, 120]) {
		for (const line of renderBlock("bash", "w1", BASH("grep -rn x f | head"), false, width)) {
			const visible = [...line].length; // fixture is all ASCII
			assert.ok(visible <= width, `width=${width} over-wide ${visible}: ${JSON.stringify(line)}`);
		}
	}
});

test("expanded mode: members show their own content (while collapsed they are hidden)", { skip }, () => {
	reset();
	// The native read forms its own group (family rules), so the two native reads can share a group
	replay([
		{ type: "toolCall", id: "x1", name: "read", arguments: READ("/tmp/leader.ts") },
		{ type: "toolCall", id: "x2", name: "read", arguments: READ("/tmp/a.ts") },
	]);
	// The result must be really provided: expanded mode shows exactly "the member's own
	// content"; without a result it renders 0 lines anyway
	const result = { content: [{ type: "text", text: "line1\nline2\nline3" }], details: {} };
	const renderWith = (expanded: boolean): string[] => {
		const c = new pi!.ToolExecutionComponent("read", "x2", READ("/tmp/a.ts"), {}, definitionOf("read"), { requestRender() {} }, CWD);
		c.markExecutionStarted();
		c.setArgsComplete?.();
		c.setExpanded(expanded);
		c.updateResult(result, false);
		const lines = c.render(100).map(plain);
		if (lines[0] === "") lines.shift();
		return lines;
	};
	assert.equal(renderWith(false).length, 0, "a collapsed member must be hidden");
	const expanded = renderWith(true);
	assert.ok(expanded.some((l) => l.includes("line1")), `expanded mode must show the content: ${JSON.stringify(expanded)}`);
});

test("shape: └ appears exactly once per block; subsequent member lines indent four spaces", { skip }, () => {
	// The user's third-round decision, 2026-10-06: the tree corner is only on the first line.
	// Subsequent member lines (and the wrapped continuations of read-merged lines) all indent
	// four spaces — the same language as the bash / codemode / web-search result trees.
	reset();
	replay([
		{ type: "thinking", text: "x" },
		{ type: "toolCall", id: "z1", name: "grep", arguments: { pattern: "alpha", path: "clients/pi" } },
		{ type: "toolCall", id: "z2", name: "ls", arguments: { path: "clients/pi/extensions" } },
	]);
	const lines = renderBlock("grep", "z1", { pattern: "alpha", path: "clients/pi" });
	assert.deepEqual(lines, [
		"• Explored",
		'  └ Search "alpha" in clients/pi',
		"    List clients/pi/extensions",
	]);
	// The first line's `└ ` is at column 2; continuations are four spaces, and their text (the
	// L of `List`) aligns with the first line's text (column 4)
	assert.equal(lines[1]!.indexOf("Search"), 4);
	assert.equal(lines[2]!.indexOf("List"), 4);
});

test("regression: when a read-merged line wraps, the continuation does not redraw └ (but keeps Read and the line numbers)", { skip }, () => {
	// A wrapped continuation redraws `Read ` (the verb; without it the line is a bare list of
	// paths), but not `└ `. The fixture uses long paths to force wrapping at a narrow width
	// (the line-number span must follow its own piece).
	reset();
	const a = "/Users/bachi/jaylli/litellm-any/clients/pi/extensions/explored-group/very-long-name-a.ts";
	const b = "/Users/bachi/jaylli/litellm-any/clients/pi/extensions/explored-group/very-long-name-b.ts";
	replay([
		{ type: "toolCall", id: "f1", name: "read", arguments: { path: a, offset: 100, limit: 70 } },
		{ type: "toolCall", id: "f2", name: "read", arguments: { path: b } },
	]);
	const lines = renderBlock("read", "f1", { path: a, offset: 100, limit: 70 }, false, 80);
	assert.equal(lines.filter((l) => l.includes("└ ")).length, 1, `└ should appear exactly once: ${JSON.stringify(lines)}`);
	for (const line of lines.slice(2)) assert.ok(line.startsWith("    Read "), `continuations should indent four spaces and redraw Read: ${JSON.stringify(line)}`);
	assert.ok(lines[1]!.includes("100-169"), `the line-number span must be preserved: ${JSON.stringify(lines)}`);
});

test("color: when Read carries a line-number span, the digits use warning and the hyphen between them the foreground color (user's decision, 2026-10-07)", { skip }, () => {
	// Pin the real bytes of pi-coder-1337. This test **deliberately** asserts concrete color
	// values: the criterion itself is "which slot", and extracting colors with loose regexes
	// would test nothing (the "don't assert color values in render tests" convention
	// deliberately excepts this — that convention assumes the slot doesn't matter, and here
	// the slot IS the requirement).
	pi!.initTheme("pi-coder-1337", false);
	const WARN = "\u001b[38;2;253;176;130m"; // theme.fg("warning", …)
	const FG = "\u001b[38;2;248;248;242m"; // theme.fg("text", …) — the theme's `fg` variable is exactly this slot
	const OFF = "\u001b[39m";
	const p = "/Users/bachi/jaylli/litellm-any/a.ts";
	const span = (args: any): string => {
		reset();
		replay([{ type: "toolCall", id: "s1", name: "read", arguments: args }]);
		return renderBlockRaw("read", "s1", args).find((l) => l.includes("a.ts")) ?? "";
	};

	// ① offset+limit: `100`(warning) `-`(foreground) `169`(warning)
	assert.ok(
		span({ path: p, offset: 100, limit: 70 }).includes(` ${WARN}100${OFF}${FG}-${OFF}${WARN}169${OFF}`),
		`①② should be 100(warning)-(foreground)169(warning): ${JSON.stringify(span({ path: p, offset: 100, limit: 70 }))}`,
	);
	// ② offset only: only the digits get colored; no hyphen may appear out of thin air (hence
	// none of the hyphen's foreground color)
	const onlyOffset = span({ path: p, offset: 100 });
	assert.ok(onlyOffset.includes(` ${WARN}100${OFF}`), `with offset only it should still be colored: ${JSON.stringify(onlyOffset)}`);
	assert.ok(!onlyOffset.includes(FG), `with offset only there should be no hyphen: ${JSON.stringify(onlyOffset)}`);
	// ③ no span: no warning anywhere on the line
	assert.ok(!span({ path: p }).includes(WARN), `without a span nothing should be colored: ${JSON.stringify(span({ path: p }))}`);

	// ④ the bash-derived Read (`sed -n '100,169p' f`) is colored too, but its `Read` is not bold
	reset();
	const cmd = { command: `sed -n '100,169p' ${p}` };
	replay([{ type: "toolCall", id: "s2", name: "bash", arguments: cmd }]);
	const bashLine = renderBlockRaw("bash", "s2", cmd).find((l) => l.includes("a.ts")) ?? "";
	assert.ok(bashLine.includes(`${WARN}100${OFF}${FG}-${OFF}${WARN}169${OFF}`), `the bash span must be colored too: ${JSON.stringify(bashLine)}`);
	assert.ok(!readVerbIsBold(bashLine), `the bash Read must not be bold: ${JSON.stringify(bashLine)}`);
});

test("color: wrapping must not split the line-number span in half (a split leaves half the color)", { skip }, () => {
	// Coloring works by recognizing "space + digits(-digits)" at the line tail, while the
	// earlier break-all wrapping cuts at the **character level** — measured at width 60,
	// `…a.ts 100-169` split exactly between the digits, and the second line became `Read -169`:
	// the span was gone (`-169` alone is meaningless) and only half the color remained. The
	// span is this line's only structured information, so wrapping handles it as a whole: if it
	// does not fit, the whole span starts a new line.
	pi!.initTheme("pi-coder-1337", false);
	const WARN = "\u001b[38;2;253;176;130m";
	const FG = "\u001b[38;2;248;248;242m";
	const OFF = "\u001b[39m";
	reset();
	const args = {
		path: "/Users/bachi/jaylli/litellm-any/clients/pi/extensions/explored-group/very-long-name-a.ts",
		offset: 100,
		limit: 70,
	};
	replay([{ type: "toolCall", id: "w1", name: "read", arguments: args }]);
	for (const width of [60, 50, 45]) {
		const lines = renderBlockRaw("read", "w1", args, width);
		const intact = lines.filter((l) => l.includes(`${WARN}100${OFF}${FG}-${OFF}${WARN}169${OFF}`));
		assert.equal(intact.length, 1, `at width=${width} the span should appear intact and colored on some line: ${JSON.stringify(lines)}`);
		for (const line of lines) {
			const visible = [...plain(line)].length;
			assert.ok(visible <= width, `width=${width} over-wide ${visible}: ${JSON.stringify(plain(line))}`);
		}
	}
});

test("regression: with only offset / only limit, the line numbers must still be visible (aligned with pi native)", { skip }, () => {
	// The old implementation gated on `offset && limit`, so with only one argument the whole
	// span silently disappeared (the user's 2026-10-06 report: "line-number information seems
	// lost"). Both shapes exist in the real corpus: across 440 sessions, `offset+limit` 1176
	// times / `offset` only 40 times / `limit` only 90 times.
	const p = "/Users/bachi/jaylli/litellm-any/a.ts";
	const cases: Array<[any, string]> = [
		[{ path: p, offset: 100, limit: 70 }, " 100-169"],
		[{ path: p, offset: 100 }, " 100"],
		[{ path: p, limit: 45 }, " 1-45"],
		[{ path: p }, ""],
		[{ path: p, offset: 1, limit: 1 }, " 1-1"],
	];
	for (const [args, span] of cases) {
		reset();
		replay([{ type: "toolCall", id: "s", name: "read", arguments: args }]);
		const line = renderBlock("read", "s", args)[1]!;
		assert.equal(line, `  └ Read a.ts${span}`, JSON.stringify(args));
	}
});
