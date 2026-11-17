/**
 * Tests for the bash block shape (bash-command-collapse.ts) — end to end: pi's own extension
 * loader really loads this extension, then pi's own `ToolExecutionComponent` renders a real bash
 * block, and assertions run against the rendered **lines**.
 *
 * Run with:  node --test clients/pi/extensions/bash-command-collapse/render.test.ts
 *
 * Why this detour is necessary (rather than calling the extension's internals directly): this
 * feature's **entire** value is "what the user's screen looks like", and the on-screen lines are
 * stacked up layer by layer — `ToolExecutionComponent` → `renderCall` / `renderResult` → Box →
 * pi-tui wrapping. Testing internals alone would miss the problems actually hit in practice:
 * `└ ` drawn per-child produced two of them, the continuation prefix mounted wrong shifted the
 * body column, overlong rows got truncated by pi-tui's render, and `state.resultSeen` did not
 * switch the prefix from indent to `│`.
 *
 * What is asserted (the shape the user specified on 2026-09-21):
 *   - the command's first row is `• Run ` (the dot color follows state, see below); at most 2
 *     visual rows; overflow on row 2's tail becomes `…`; when longer, a `… +N lines` marker row;
 *   - command continuations / the `… +N lines` body column == `Run `'s `n` column (column 3):
 *     two-cell indent mid-run, `│ ` once finished;
 *   - the state dot `•` (U+2022) **only on the command's first row** (not on continuations,
 *     `… +N lines`, or anything in the result tree); colors: running `dim`, success
 *     `toolDiffAdded`, failure `toolDiffRemoved`;
 *   - the whole body shifted one column right (`• Run …`): `Run` / `│` / `└` all on column 2 and
 *     all body on column 4, so command line and result tree do not skew apart (user's second-round
 *     call 2026-09-21);
 *   - the whole block has **no background at all** (none of pending / success / failure is
 *     painted), and **other tools' backgrounds are unaffected**;
 *   - **no blank rows above or below** the colored block (the command is the block's first row,
 *     the result its last);
 *   - `└ ` appears **exactly once in the whole result**, on the first substantive output row
 *     (truncation-hint rows do not count);
 *   - content rows after the first substantive output carry no vertical bar and no corner — only
 *     a two-cell indent;
 *   - no output shows `(no output)` with `└ ` in front of it;
 *   - every row's visible width <= the terminal width (pi-tui truncates overlong rows — one extra
 *     column loses content).
 * If the local pi library entry cannot be found, everything skips (no pretending to pass).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bash-command-collapse.ts");
// These snapshots explicitly assert 24-bit ANSI colors, independent of the test terminal.
process.env.COLORTERM = "truecolor";
/** Tree vertical-bar row (`│ `): command continuations, truncation hints, and everything above `└ `. */
const PIPE = "\u2502";
/** The state dot `•` (U+2022): only at the head of the command's first row. */
const BAR = "\u2022";
/** `…` (U+2026): pulled out only so assertions read clearly. */
const ELLIPSIS_PLAIN = "\u2026";
/** The three state slots' **true colors** in the default skin (dark) — the dot color assertions track exactly these values. */
const DIM_ANSI = "\u001b[38;2;102;102;102m"; // dim       `#666666`
const ADDED_ANSI = "\u001b[38;2;181;189;104m"; // toolDiffAdded  `#b5bd68`
const REMOVED_ANSI = "\u001b[38;2;204;102;102m"; // toolDiffRemoved `#cc6666`
const SKIP = "pi library entry not found on this machine (requires an installed pi)";

/**
 * pi's library entry point (not the CLI): bundle is the form `pi` actually runs, dist is the node
 * build form.
 *
 * First the **real install location** is recovered from the `pi` executable (pnpm/npm shim
 * scripts leave a `# cmd-shim-target=<absolute path>` line; on Unix npm uses a symlink — both are
 * tried), then the fallback is the copy under `~/.pi/agent/npm` — the check is **whether it can
 * really be imported**, not whether the path exists (that copy may be a shell with its companion
 * packages pruned). If all fail, returns undefined and everything skips.
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
			// shell copy: try the next candidate
		}
	}
	return undefined;
}

/**
 * pi's bundled chalk decides "whether to emit styles" **at module evaluation time** (off by
 * default when not a TTY), and `theme.bold()` is exactly it — so only the "bold / color"
 * assertions need this env var, and it **must be set before importing pi**. Without it those
 * assertions see SGR-free bare text and would "pass" forever.
 * Affects only this test process, and respects a user's existing NO_COLOR.
 */
if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

/**
 * Whether this process can nest one more layer of `sandbox-exec`.
 *
 * seatbelt **does not allow nesting**: if the shell running the tests is itself inside a sandbox
 * (e.g. running `node --test` inside a pi session with `PI_SANDBOX` on), the inner `sandbox_apply`
 * fails outright with `Operation not permitted` (exit code 71). That is an environment condition,
 * not a code regression, so the real-sandbox cases all skip in that situation (no pretending to
 * pass, and no pile of unreadable errors).
 * In a normal terminal (no outer sandbox) it is true and the cases really run.
 */
const NESTED_SKIP = "nested sandbox-exec unavailable (this process is already inside a sandbox); real-sandbox cases skipped";
const nestedSandboxOk = (() => {
	if (piEntry === undefined) return false;
	try {
		execFileSync("sandbox-exec", ["-p", "(version 1)(allow default)", "/bin/echo", "ok"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
})();
/** The real-sandbox cases' skip value: platform unsupported / pi not found / nesting unavailable — all three skip. */
const sandboxSkip = skip !== false ? skip : nestedSandboxOk ? false : NESTED_SKIP;

interface BashToolDefinitionLike {
	renderShell?: string;
	renderCall?: (...args: any[]) => any;
	renderResult?: (...args: any[]) => any;
	execute?: (
		toolCallId: string,
		params: { command: string; timeout?: number },
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
		extensions: Array<{ tools: Map<string, { definition: BashToolDefinitionLike }> }>;
		errors: Array<{ path: string; error: string }>;
	}>;
	createEventBus: () => unknown;
	initTheme: (name?: string, interactive?: boolean) => void;
	ToolExecutionComponent: new (
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: unknown,
		toolDefinition: BashToolDefinitionLike,
		ui: { requestRender(): void },
		cwd: string,
	) => {
		rendererState: { startedAt?: number; endedAt?: number };
		setArgsComplete?: () => void;
		markExecutionStarted: () => void;
		setExpanded: (expanded: boolean) => void;
		updateResult: (result: unknown, isPartial?: boolean) => void;
		render: (width: number) => string[];
	};
}

let pi: PiApi | undefined;
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

/** Strip all ANSI / OSC escapes, leaving only visible text (assertions look at this). */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** Visible column count (fixtures contain only ASCII and Han characters; a Han char is 2 columns, the rest 1 — matching pi-tui's accounting). */
function widthOf(line: string): number {
	let width = 0;
	for (const ch of plain(line)) {
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
}

/**
 * Load this extension through pi's own loader (done once at module evaluation; the registered
 * tool definition is reused across tests).
 * Top-level await is required: `test()` callbacks are synchronous while loading is async.
 */
let cached: { agentDir: string; projectDir: string; definition: BashToolDefinitionLike } | undefined;
let cleanup: (() => void) | undefined;

if (pi) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-shape-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	cleanup = () => fs.rmSync(root, { recursive: true, force: true });

	// isolate the persistent allowlist: do not point at the user's real ~/.pi/agent/sandbox-allowlist.json,
	// or once the user has approved some directory, the "out-of-boundary delete refused" cases here would fail on an allowlist hit.
	const prevAllowlist = process.env.PI_SANDBOX_ALLOWLIST;
	process.env.PI_SANDBOX_ALLOWLIST = path.join(root, "sandbox-allowlist.json");
	let loaded;
	try {
		loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	} finally {
		if (prevAllowlist === undefined) delete process.env.PI_SANDBOX_ALLOWLIST;
		else process.env.PI_SANDBOX_ALLOWLIST = prevAllowlist;
	}
	assert.deepEqual(loaded.errors, [], "pi's extension loader must not error");
	const definition = loaded.extensions[0]?.tools.get("bash")?.definition;
	assert.ok(definition, "this extension must register the bash tool (cross-extension same-name registration is first-wins; see file header)");
	pi.initTheme("dark");
	cached = { agentDir, projectDir, definition };
}

test.after(() => cleanup?.());

interface RenderOptions {
	output?: string;
	expanded?: boolean;
	partial?: boolean;
	timeout?: number;
	details?: unknown;
	/** Pretend "ran for N milliseconds" (the footer threshold check uses `endedAt - startedAt`). */
	elapsedMs?: number;
	width?: number;
	/** Do not call `updateResult` — the real "command sent, result not yet arrived" moment (`renderCall` solo). */
	noResult?: boolean;
	/** Command failed (pi puts `isError` on the tool result — the built-in bash throws on failure). */
	isError?: boolean;
}

/**
 * The tool-result body of a failed command, copied verbatim from pi's built-in bash shape — in
 * `core/tools/bash.ts` `formatOutput` first replaces empty output with `(no output)`, then
 * `appendStatus(text, status)` appends the status: `` `${text}\n\n${status}` ``. So **no output is
 * still this `(no output)` placeholder row**, not an empty string — the `(no output)` the
 * extension supplies itself is only for results whose body is truly empty (not failed, and no
 * output).
 */
const failed = (output: string, status = "Command exited with code 2"): string => `${output || "(no output)"}\n\n${status}`;

/**
 * Render a real bash block: `markExecutionStarted` → `updateResult`, in the same order pi calls
 * them (`setArgsComplete` precedes execution start in the live stream, and is never called on
 * `/resume` rebuilds — both covered here).
 */
function renderBlock(command: string, options: RenderOptions = {}): string[] {
	assert.ok(pi && cached);
	const component = new pi.ToolExecutionComponent(
		"bash",
		"call-1",
		{ command, ...(options.timeout === undefined ? {} : { timeout: options.timeout }) },
		{},
		cached.definition,
		{ requestRender() {} },
		cached.projectDir,
	);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	if (options.elapsedMs !== undefined) {
		component.rendererState.endedAt = (component.rendererState.startedAt ?? Date.now()) + options.elapsedMs;
	}
	component.setExpanded(options.expanded === true);
	if (!options.noResult) {
		component.updateResult(
			{
				content: [{ type: "text", text: options.output ?? "" }],
				details: options.details ?? {},
				// pi puts isError on the result (`updateResult(message)` receives that toolResult message),
				// and the renderer's `context.isError` is computed from it — the failure-status coloring relies on that.
				...(options.isError === undefined ? {} : { isError: options.isError }),
			},
			options.partial === true,
		);
	}
	const lines = component.render(options.width ?? 79);
	// pi's built-in bash renderResult hangs a per-second invalidate timer when `isPartial`
	// (`setInterval(() => context.invalidate(), 1e3)`). It is pi's component, and no UI in the test
	// clears it — otherwise node --test **never exits** (observed hanging).
	clearInterval((component.rendererState as { interval?: NodeJS.Timeout }).interval);
	return lines;
}

const text = (command: string, options: RenderOptions = {}): string[] => renderBlock(command, options).map(plain);

/** The "ran 3 seconds" pretense: crosses the 2s threshold so the `Took` footer is drawn (to test its place in the tree). */
const SLOW = { elapsedMs: 3000 } as const;

const LONG_COMMAND =
	"cd /Users/bachi/Library/pnpm/store/v11/links/@earendil-works/pi-coding-agent/0.86.0/5813aee6dbf81477902199f3db54e13ab115c8902b3ab00a8b290b3e44dcb3c8/node_modules/@earendil-works/pi-coding-agent";

/**
 * Normalize a line for assertions: the leading **state dot** `•` becomes a space (so the other
 * assertions can still be written as "the block's first row is `Run …`", while the dot itself
 * has its own case), then strip the first of the block left margin's 2 columns plus the first
 * row's dot column (i.e. `• ` / two spaces → 1 column), and trim right padding (`Box.render`
 * pads each row to the terminal width — padding is not content). **The remaining 1 leading column
 * must be kept** — the continuations' and the result tree's indent lives in it (the body
 * shifted right one column; see `withHeadBar` in the source file).
 */
const body = (line: string): string => line.replace(/^\u2022/, " ").replace(/ +$/, "").replace(/^ {2}/, "");

test("command line: starts with `•Run `, at most two rows, row-2 overflow becomes `…`", { skip }, () => {
	const raw = renderBlock(LONG_COMMAND, { output: "a\nb\n" }).map(plain);
	const lines = raw.map(body);
	// the structure is fixed: command first row + 1 continuation + `… +N lines` marker, then the result
	assert.equal(raw[0], "", "row 0 is pi self-mode's fixed blank (not part of the block)");
	assert.equal(raw[1]!.startsWith("• Run cd "), true, `the block's row 1 should be dot + space + a \`Run\`-headed command: ${raw[1]}`);
	assert.equal(lines[2]!.startsWith("│ gent/"), true, `row 2 should be a continuation: ${lines[2]}`);
	assert.equal(lines[2]!.endsWith(ELLIPSIS_PLAIN), true, `an overflowing row tail must become …: ${lines[2]}`);
	assert.equal(lines[3], "│ … +1 lines", `row 3 should be the collapse marker: ${lines[3]}`);
	// exactly two command body rows (the Run row + 1 continuation); the third command row is the collapse marker, not body
	assert.equal(lines[2]!.includes("0.86.0"), true, "the continuation must keep showing command body");
	assert.equal(lines[4]!.startsWith("└ "), true, `row 4 onward should be the result: ${lines[4]}`);
	// the old token hint is gone
	assert.equal(lines.some((line) => line.includes("tokens hidden")), false);
});

test("command line: a short command with no overflow draws no `…` and no collapse marker", { skip }, () => {
	const lines = renderBlock("echo hello", { output: "hello\n" }).map(plain);
	// first row = dot + space + `Run ` + command; the rest is background padding (`Box.applyBg` fills to terminal width)
	assert.equal(lines[1]!.trimEnd(), "• Run echo hello", "first row is dot + space + Run + command");
	assert.equal(widthOf(lines[1]!), 79, `the first row still fills the whole width: ${JSON.stringify(lines[1])}`);
	assert.equal(lines.some((line) => line.includes(ELLIPSIS_PLAIN)), false, "short commands must not have …");
	assert.equal(lines.some((line) => line.includes("lines")), false, "short commands must not have … +N lines");
});

test("state dot: only on the command's first row; color follows state (dim / green / red)", { skip }, () => {
	// the shape the user set on 2026-09-21: `•Run ls …path…` — no dot on continuations or the result tree.
	// the three slots' true colors in the default skin (dark, see initTheme): dim `#666666`,
	// toolDiffAdded `#b5bd68`, toolDiffRemoved `#cc6666`.
	const bar = (line: string): string => {
		const match = /\u001b\[38;2;\d+;\d+;\d+m\u2022\u001b\[39m/.exec(line);
		assert.ok(match, `the first row should carry one colored •: ${JSON.stringify(line)}`);
		return match![0];
	};

	// running (`renderCall` solo, no result yet) → dim
	const pending = renderBlock("echo hello", { noResult: true });
	assert.equal(bar(pending[1]!), `${DIM_ANSI}${BAR}\u001b[39m`, `running should be dim gray: ${JSON.stringify(pending[1])}`);
	// a streaming partial snapshot is also "still running" → dim
	assert.equal(bar(renderBlock("echo hello", { output: "", partial: true })[1]!), `${DIM_ANSI}${BAR}\u001b[39m`, "partial is dim too");

	// success → toolDiffAdded (the green of diff added-lines)
	const ok = renderBlock("echo hello", { output: "hello\n" })[1]!;
	assert.equal(bar(ok), `${ADDED_ANSI}${BAR}\u001b[39m`, `success should be green: ${JSON.stringify(ok)}`);

	// failure → toolDiffRemoved (the red of diff removed-lines)
	const failedLine = renderBlock("false", { output: "boom\n", isError: true })[1]!;
	assert.equal(bar(failedLine), `${REMOVED_ANSI}${BAR}\u001b[39m`, `failure should be red: ${JSON.stringify(failedLine)}`);

	// **only the first row**: the long command's continuation, the `… +N lines` marker, and the whole result tree have no dot
	const long = renderBlock(LONG_COMMAND, { output: "a\nb\n", isError: true });
	const plainLines = long.map(plain);
	assert.equal(plainLines.filter((line) => line.includes(BAR)).length, 1, `the whole block may carry only one dot: ${JSON.stringify(plainLines)}`);
	assert.equal(plainLines.findIndex((line) => line.includes(BAR)), 1, "the dot only sits on the command's first row (the block's row 1)");
});

test("state dot: the color is read fresh from the theme (change the theme → the dot follows)", { skip }, () => {
	// what is asserted is "each render reads the theme fresh" itself, not three hardcoded values: temporarily point two
	// slots of the dark skin at other colors, then render — the dot must follow. A cached value would miss this.
	// `theme.getFgAnsi` reads the same `fgColors` table as the singleton pi's own rendering uses (see the
	// withBashOutputColor comment in the source file), so mutating the singleton mutates the color the extension sees.
	const singleton = (globalThis as Record<symbol, unknown>)[Symbol.for("@earendil-works/pi-coding-agent:theme")] as
		| { fgColors?: Map<string, string> }
		| undefined;
	assert.ok(singleton?.fgColors?.set, "pi's theme singleton must exist (initTheme already ran)");
	const fgColors = singleton!.fgColors!;
	const dimBefore = fgColors.get("dim");
	const addedBefore = fgColors.get("toolDiffAdded");
	try {
		fgColors.set("dim", "\u001b[38;2;1;2;3m");
		fgColors.set("toolDiffAdded", "\u001b[38;2;4;5;6m");
		const pendingBar = /\u001b\[38;2;\d+;\d+;\d+m\u2022/.exec(renderBlock("x", { noResult: true })[1]!)?.[0];
		assert.equal(pendingBar, "\u001b[38;2;1;2;3m\u2022", "the running dot must follow the new dim");
		const okBar = /\u001b\[38;2;\d+;\d+;\d+m\u2022/.exec(renderBlock("x", { output: "ok\n" })[1]!)?.[0];
		assert.equal(okBar, "\u001b[38;2;4;5;6m\u2022", "the success dot must follow the new toolDiffAdded");
	} finally {
		if (dimBefore === undefined) fgColors.delete("dim");
		else fgColors.set("dim", dimBefore);
		if (addedBefore === undefined) fgColors.delete("toolDiffAdded");
		else fgColors.set("toolDiffAdded", addedBefore);
	}
});

test("background: the bash block carries no background at all (none of pending / success / failure is painted); other tools unaffected", { skip }, () => {
	// user decision 2026-09-21: the bash block loses its background **entirely** (none of pending's `toolPendingBg`,
	// success's `toolSuccessBg`, or failure's `toolErrorBg` is painted) — state is conveyed only by the first row's dot.
	// The check looks at SGR **background** sequences (`48;2;…` / `40-47` / `100-107`) — as long as the row head
	// lacks one, the whole row has no background (`Box` applies bgFn across the whole row).
	const hasBg = (line: string): boolean => /\u001b\[(?:4[0-7]|10[0-7]|48[;:])/.test(line);
	const cases: Array<[string, string[]]> = [
		["running", renderBlock("echo hello", { noResult: true })],
		["streaming partial", renderBlock("echo hello", { output: "hi\n", partial: true })],
		["success", renderBlock("echo hello", { output: "hello\n", ...SLOW })],
		["failure", renderBlock("false", { output: "(no output)\n\nCommand exited with code 1", isError: true, ...SLOW })],
		["expanded failure", renderBlock("cmd", { output: "1\n2\n3\n\nCommand exited with code 2", isError: true, expanded: true })],
	];
	for (const [label, lines] of cases) {
		const painted = lines.filter(hasBg);
		assert.deepEqual(painted, [], `${label}: the bash block must have no background rows: ${JSON.stringify(painted.map(plain))}`);
		// the content itself is still there (do not turn "no background" into "block gone")
		assert.equal(lines.map(plain).some((line) => line.includes(BAR)), true, `${label}: the command's first row should still be there: ${JSON.stringify(lines.map(plain))}`);
	}

	// control: other tools (stand-in: pi's **generic** render path — no toolDefinition) keep their background.
	// What this pins down is the "only bash loses it" half: this extension registers only the `bash` tool,
	// and other tools go through ToolExecutionComponent's own contentBox + bgFn.
	assert.ok(pi);
	const other = new pi.ToolExecutionComponent("read", "call-other", { path: "/tmp/x" }, {}, undefined, { requestRender() {} }, cached!.projectDir);
	other.updateResult({ content: [{ type: "text", text: "file content" }], details: {} }, false);
	const otherLines = other.render(79);
	assert.equal(otherLines.some(hasBg), true, `other tools' background must survive: ${JSON.stringify(otherLines.map(plain))}`);
});

test("no boundary blanks: no blank rows above or below (the command is the first row, the result the last)", { skip }, () => {
	// user decision 2026-09-21: no more opening the block with two colored blank rows top and bottom. So the block's
	// row 1 is the command and its last row is the result itself (the `Took` footer when present), with no blanks inside.
	for (const [label, lines] of [
		["running", renderBlock("echo hello", { noResult: true })],
		["success", renderBlock("echo hello", { output: "hello\n", elapsedMs: 100 })],
		["failure", renderBlock("false", { output: "(no output)\n\nCommand exited with code 1", isError: true, elapsedMs: 100 })],
		["a long command with Took", renderBlock("echo hi", { output: "hi\n", ...SLOW })],
	] as Array<[string, string[]]>) {
		const visible = lines.map(plain);
		// row 1 is pi self-mode's fixed blank (`render()` does `lines.push("")`) — it is not part of the block
		assert.equal(visible[0], "", `${label}: row 0 is pi's fixed blank`);
		assert.equal(visible[1]!.startsWith(BAR), true, `${label}: row 1 (the block's first row) should be the dot-carrying command: ${JSON.stringify(visible)}`);
		assert.notEqual(visible[visible.length - 1]!.trim(), "", `${label}: the last row must not be blank (no bottom boundary blank): ${JSON.stringify(visible)}`);
		// command and result are flush too: the block's row 2 is the first result row (`└ `), not a blank
		if (visible.length > 2) assert.equal(visible[2]!.trimStart().startsWith("└ "), true, `${label}: the result hugs the command: ${JSON.stringify(visible)}`);
	}
});

test("command line: continuations' and the collapse marker's body column == `Run `'s `n` column", { skip }, () => {
	// continuations / the collapse marker carry the `│ ` prefix (2 columns), so their **body** lands on column 3 (0-based 2) —
	// exactly `Run `'s `n` column. That is how the two rows in the user's sample align.
	const lines = text(LONG_COMMAND, { output: "a\n" }).map(body);
	const run = lines.find((line) => line.startsWith("Run "))!;
	const continuation = lines[lines.indexOf(run) + 1]!;
	const marker = lines.find((line) => line.includes("+1 lines"))!;
	const nColumn = "Run ".indexOf("n");
	// the dot sits on **column 0** (taking over the cell that used to be Box's left padding), so `Run `'s body still starts at column 2
	assert.equal(nColumn, 2, "`Run `'s n is on column 3 (0-based 2) — a precondition of the assertion");
	assert.equal(continuation.slice(0, 2), `${PIPE} `, `the continuation should carry a 2-column prefix: ${continuation}`);
	assert.equal(continuation.slice(2).length > 0, true);
	assert.equal(marker.slice(0, 2), `${PIPE} `, `the collapse marker should carry a 2-column prefix: ${marker}`);
	assert.equal(marker.indexOf(ELLIPSIS_PLAIN), nColumn, `the collapse marker's … is in the wrong column: ${marker}`);
	assert.equal(run.indexOf("Run "), 0, `Run should be at column 0 (body already stripped the block left margin): ${run}`);
});

test("alignment: dot on column 0, `Run` / `│` / `└` all on column 2, body all on column 4", { skip }, () => {
	// the user's second-round look call on 2026-09-21: the whole body shifted one column right (`• Run …`, no longer `•Run …`),
	// and **the result side shifted with it** — a command line on column 2 against a result tree on column 0 would skew.
	// What this case watches is "same width on both sides": the leading columns of the command line and every result-tree row
	// output uses 3 rows (exactly the preview budget, all kept): `└ ` lands on the first row and the second row is its indented continuation.
	const raw = renderBlock(LONG_COMMAND, { output: "one\ntwo\nthree\n" }).map(plain);
	const barIndex = raw.findIndex((line) => line.includes(BAR));
	assert.equal(barIndex, 1, `the dot is on the block's row 1: ${JSON.stringify(raw)}`);
	assert.equal(raw[barIndex]!.indexOf(BAR), 0, `the dot is on column 0: ${JSON.stringify(raw[barIndex])}`);
	assert.equal(raw[barIndex]!.indexOf("Run "), 2, `\`Run \` is on column 2: ${JSON.stringify(raw[barIndex])}`);

	// the command line's continuations and the result tree's `│ ` / `└ ` all start on column 2
	const continuation = raw.find((line) => line.includes("gent/") && line.includes("\u2502"))!;
	assert.ok(continuation?.startsWith("  \u2502 "), `the command continuation should be on column 2: ${JSON.stringify(raw)}`);
	const bodyColumn = continuation.indexOf("\u2502") + 2;
	assert.equal(bodyColumn, 4, `the command continuation's body on column 4: ${JSON.stringify(continuation)}`);
	const corner = raw.find((line) => line.includes("\u2514 "))!;
	assert.equal(corner.indexOf("\u2514"), 2, `\`└ \` is on column 2: ${JSON.stringify(corner)}`);
	// the body after `└ ` likewise lands on column 4 (same column as the command continuation's body)
	assert.equal(corner.indexOf("one"), bodyColumn, `the result body should share the command body's column: ${JSON.stringify(corner)}`);
	// continuations below `└ ` carry only indent; their body still sits on column 4
	const rest = raw.find((line) => line.trimStart().startsWith("two"))!;
	assert.equal(rest.indexOf("two"), bodyColumn, `the result continuation's body should be on column 4: ${JSON.stringify(rest)}`);
	// the block's left margin is uniform: every row is either blank or its first two cells are of the "dot / tree glyph / space" family
	for (const [index, line] of raw.entries()) {
		if (line === "" || line.trim() === "") continue;
		const head = line.slice(0, 2);
		assert.match(head, /^(?:\u2022 |  |\u2502 |\u2514 | {2})/, `row ${index} has the wrong left margin: ${JSON.stringify(line)}`);
	}
});

test("command line: while the command is still running (no result) continuations use space indent; once a result arrives they become `│ `", { skip }, () => {
	// pure running (`renderCall` solo, `updateResult` never called): the whole block is bare indent — not a single vertical bar
	const running = text(LONG_COMMAND, { noResult: true }).map(body);
	assert.equal(running[2]!.startsWith("  gent/"), true, `a running continuation should be space-indented: ${running[2]}`);
	assert.equal(running.find((line) => line.includes("+1 lines"))!.startsWith("  …"), true, "the collapse marker mid-run uses indent only");
	assert.equal(running.some((line) => line.startsWith(`${PIPE} `) || line.startsWith("└ ")), false, "no tree glyph should appear mid-run");
	// once a result arrives (even a partial snapshot), command continuations and the collapse marker switch to `│ ` — the tree connects
	const withOutput = text(LONG_COMMAND, { output: "a\n", partial: true }).map(body);
	assert.equal(withOutput[2]!.startsWith(`${PIPE} gent/`), true, `once a result arrives the continuation becomes │: ${withOutput[2]}`);
	assert.equal(withOutput.find((line) => line.includes("+1 lines"))!.startsWith(`${PIPE} …`), true, "the collapse marker carries │ too");
});

test("result: `└ ` appears exactly once in the whole block, on the first substantive output row", { skip }, () => {
	const lines = text(LONG_COMMAND, { output: "one\ntwo\nthree\n", ...SLOW }).map(body);
	const corners = lines.filter((line) => line.startsWith("└ "));
	assert.equal(corners.length, 1, `└ may appear only once: ${JSON.stringify(lines)}`);
	assert.equal(corners[0], "└ one", "└ must hang on the first substantive output row");
	// the following content rows: two-cell indent, no vertical bar / corner
	assert.equal(lines[lines.indexOf(corners[0]!) + 1], "  two");
	assert.equal(lines[lines.indexOf(corners[0]!) + 2], "  three");
});

test("result: the truncation hint carries `│ `; `└ ` is reserved for the first output row below it", { skip }, () => {
	const lines = text(LONG_COMMAND, { output: "1\n2\n3\n4\n5\n6\n7\n", ...SLOW }).map(body);
	const hint = lines.find((line) => line.includes("earlier lines"))!;
	assert.equal(hint.startsWith("│ …"), true, `the truncation hint should carry │: ${hint}`);
	const corner = lines.find((line) => line.startsWith("└ "))!;
	assert.equal(corner, "└ 5", `└ should hang on the first output row below the hint: ${corner}`);
	assert.equal(lines[lines.indexOf(corner) + 1], "  6");
	assert.equal(lines[lines.indexOf(corner) + 2], "  7");
	// the footer is in the tree too, likewise only indented (no more verticals)
	const footer = lines.find((line) => line.startsWith("  Took "))!;
	assert.ok(footer, "the Took footer should be indented");
	// `│ ` appears only in the stretch above `└ ` (command continuations + collapse marker + truncation hint); after `└ ` there is not a single one
	assert.equal(lines.findIndex((line) => line.startsWith("└ ")) < lines.findIndex((line) => line.startsWith("  Took ")), true);
	assert.equal(lines.slice(lines.findIndex((line) => line.startsWith("└ "))).some((line) => line.startsWith("│ ")), false, `no more verticals after └: ${JSON.stringify(lines)}`);
});

test("result: with no output, `(no output)` is drawn and `└ ` hangs in front of it", { skip }, () => {
	const lines = text("true", SLOW).map(body);
	assert.equal(lines.find((line) => line.startsWith("└ ")), "└ (no output)");
	// mid-run (no result yet) no placeholder row is kept: "no output yet" is not "no output"
	const running = text("sleep 5", { partial: true }).map(body);
	assert.equal(running.some((line) => line.includes("(no output)")), false, "(no output) must not be drawn mid-run");
	assert.equal(running.some((line) => line.startsWith("└ ")), false, "no └ mid-run");
});

test("result: `(no output)` comes before warnings", { skip }, () => {
	const lines = text("cat huge", {
		output: "",
		details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 999 }, fullOutputPath: "/tmp/x.log" },
		...SLOW,
	}).map(body);
	const noOutput = lines.findIndex((line) => line.includes("(no output)"));
	const warning = lines.findIndex((line) => line.includes("Full output:"));
	assert.ok(noOutput !== -1 && warning !== -1, `both rows should be there: ${JSON.stringify(lines)}`);
	assert.ok(noOutput < warning, "(no output) should come before warnings");
	assert.equal(lines[noOutput]!.startsWith("└ "), true);
	assert.equal(lines[warning]!.startsWith("  "), true, "warnings only indent — no more corner glyph");
});

test("result: every row's visible width stays within the terminal width", { skip }, () => {
	const cases: Array<{ command: string; options: RenderOptions }> = [
		{ command: LONG_COMMAND, options: { output: "one\ntwo\nthree\n", ...SLOW } },
		{ command: "echo hi", options: { output: "hi\n", ...SLOW } },
		{ command: "true", options: SLOW },
		{ command: "echo " + "x".repeat(200), options: { output: "1\n2\n3\n" } },
		{ command: "echo 你好世界".repeat(20), options: { output: "第一行\n第二行\n" } },
		{ command: "cat huge", options: { output: "", details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 999 }, fullOutputPath: "/tmp/" + "y".repeat(120) }, ...SLOW } },
	];
	for (const width of [120, 79, 60, 40, 30, 25]) {
		for (const { command, options } of cases) {
			const lines = renderBlock(command, { ...options, width });
			for (const line of lines) {
				assert.ok(widthOf(line) <= width, `width ${width} overflows: ${JSON.stringify(plain(line))} (Run ${command.slice(0, 30)}…)`);
			}
		}
	}
});

test("expanded: the result is not trimmed and carries no gutter (the command's own continuation prefix remains)", { skip }, () => {
	const lines = text(LONG_COMMAND, { output: "1\n2\n3\n4\n5\n6\n7\n8\n", expanded: true, ...SLOW }).map(body);
	// the result section is verbatim output: no `└ `, no truncation hint, every output row flush left
	assert.equal(lines.some((line) => line.startsWith("└ ")), false, `expanded should have no └: ${JSON.stringify(lines)}`);
	assert.equal(lines.some((line) => line.includes("earlier lines")), false, "expanded should have no truncation hint");
	// the left margin's 1 column is still mounted (`body` strips only 2 columns, so 1 remains) — the body column matches collapsed
	for (const line of ["1", "2", "8"]) assert.equal(lines.includes(line), true, `expanded should emit verbatim ${line}:${JSON.stringify(lines)}`);
	assert.equal(lines.some((line) => line === " 1"), false, "expanded output must not keep an extra left margin (`body` strips only 1 column)");
	// the command section: not truncated, no `… +N lines` marker (but still the command's own continuation prefix)
	assert.equal(lines.some((line) => line.endsWith(ELLIPSIS_PLAIN)), false, "expanded command is not truncated");
	assert.equal(lines.some((line) => line.includes("+") && line.includes("lines")), false, "expanded should have no … +N lines marker");
	// the footer is not in the tree either: flush left, no `│ ` / `└ `
	assert.equal(lines.find((line) => line.includes("Took "))!.startsWith("Took "), true);
});

test("coloring: the command continuation's `│` is muted and does not drift with the next token's color", { skip }, () => {
	// the command's second row body is a path (`syntaxString`), and the first row's tail is a path too — the two rows' `│` and
	// `Run ` must each keep their own color: a structural glyph must never inherit the body's color at either end (observed: `│` once drifted along with the path color).
	const lines = renderBlock(LONG_COMMAND, { output: "ok\n" });
	const run = lines.find((line) => plain(line).includes("Run cd "))!;
	const continuation = lines.find((line) => plain(line).includes("ent/0.86.0"))!;
	assert.ok(run && continuation, "both command rows should be there");

	// the first row is now `•` + `Run ` (the dot is its own SGR segment; the `Run` word additionally carries bold), the continuation is `│ ` (muted)
	const runPrefix = /^\u001b\[38;2;\d+;\d+;\d+m\u2022\u001b\[39m \u001b\[38;2;212;212;212m\u001b\[1mRun\u001b\[22m \u001b\[39m/.exec(run);
	assert.ok(runPrefix, `the Run prefix should be dot + space + toolTitle normal color + bold: ${JSON.stringify(run)}`);
	// the prefix sits flush at the row head (no SGR-48 background prefix) — see the "no background" case below
	assert.equal(run.startsWith("\u001b[38;2;"), true, `the bash block's first row must have no background: ${JSON.stringify(run)}`);
	const chainPrefix = /\u001b\[38;2;128;128;128m│ \u001b\[39m/.exec(continuation);
	assert.ok(chainPrefix, `the continuation's │ should be muted gray, with the color closed before the body: ${JSON.stringify(continuation)}`);
	// the body's path color (syntaxString) appears **after** `│ `, not wrapped around it
	const chainIndex = continuation.indexOf(chainPrefix![0]);
	const pathIndex = continuation.indexOf("\u001b[38;2;206;145;120m");
	assert.ok(pathIndex > chainIndex, "the path color must come after the │ prefix");
});

test("coloring: only the word `Run` is bold; the command body is not", { skip }, () => {
	const lines = renderBlock("echo hi", { output: "ok\n", ...SLOW });
	const run = lines.find((line) => plain(line).includes("Run echo hi"))!;
	assert.ok(run, "the command row should be there");
	// `Run` carries the bold on/off pair, and **that trailing space is outside the bold** (wrapping it in bold makes the gap look wider)
	assert.match(run, /\u001b\[1mRun\u001b\[22m /, `Run should be bold and the space not bold: ${JSON.stringify(run)}`);
	// the body (echo / hi) carries no bold marks
	const body = run.slice(run.indexOf("\u001b[22m") + "\u001b[22m".length);
	assert.equal(body.includes("\u001b[1m"), false, `the command body must not be bold: ${JSON.stringify(body)}`);
	assert.equal(body.includes("\u001b[22m"), false, `the command body must have no bold reset: ${JSON.stringify(body)}`);
	// neither the continuation (`│ `) nor the result (`└ `) is bold
	const styledCorner = lines.find((line) => plain(line).trimStart().startsWith("└ "))!;
	assert.ok(styledCorner, "the result row should be there");
	assert.equal(styledCorner.includes("\u001b[1m"), false, "the result tree's └ must not be bold");
	// the long command's continuation (`│ `) is not bold either
	const continuation = renderBlock(LONG_COMMAND, { output: "ok\n" }).find((line) => plain(line).trimStart().startsWith("\u2502 "));
	assert.ok(continuation, "a long command should have a continuation");
	assert.equal(continuation.includes("\u001b[1m"), false, "the continuation's │ must not be bold");
});

test("failure: `Command exited with code 2` uses the error foreground", { skip }, () => {
	// pi welds it to the end of the result body; like the output before it, it is `toolOutput` (gray by default) — the user wants red.
	// asserts the default skin's (dark, see initTheme) value: error = #cc6666 = `\u001b[38;2;204;102;102m`.
	const raw = renderBlock("for f in a b; do echo x; done", { output: failed("one\ntwo"), isError: true, elapsedMs: 100 });
	const status = raw.find((line) => plain(line).includes("Command exited with code 2"))!;
	assert.ok(status, `the failure notice should be there: ${JSON.stringify(raw.map(plain))}`);
	assert.ok(status.includes("\u001b[38;2;204;102;102m"), `the failure notice should be error red: ${JSON.stringify(status)}`);
	// with output present, those two rows are the status line itself and must not be mangled by the tree gutter
	// (they land after `└ `, so two-cell indent, no vertical bar)
	const after = raw.map(plain).map(body);
	assert.equal(after.find((line) => line.includes("Command exited"))!.startsWith("  Command exited"), true);

	const only = renderBlock("true; exit 3", { output: failed("", "Command exited with code 3"), isError: true, elapsedMs: 100 });
	const onlyStatus = only.find((line) => plain(line).includes("Command exited with code 3"))!;
	assert.ok(onlyStatus.includes("\u001b[38;2;204;102;102m"), `with no output the notice is likewise red: ${JSON.stringify(onlyStatus)}`);
	const onlyBody = only.map(plain).map(body);
	assert.equal(onlyBody.find((line) => line.startsWith("└ ")), "└ (no output)", "with no output └ hangs on the placeholder row");
	assert.equal(onlyBody.find((line) => line.includes("Command exited"))!.startsWith("  Command exited"), true, "the notice follows immediately, indented and aligned");
});

test("failure: no prefix-free blank row above the notice (no mid-tree break)", { skip }, () => {
	// pi welds the status to the end of the output; its `\n\n` draws one prefix-free blank row — what the user saw was
	// a "two-layer break" (sandwiched between the preview and `└ Command exited…`). Blank rows are no longer drawn (see file header ⑤).
	const lines = text("true; exit 3", { output: failed("", "Command exited with code 3"), isError: true, elapsedMs: 100 }).map(body);
	const corner = lines.findIndex((line) => line.startsWith("└ "));
	const status = lines.findIndex((line) => line.includes("Command exited"));
	assert.equal(lines[corner], "└ (no output)", `tree start: ${JSON.stringify(lines)}`);
	assert.equal(status, corner + 1, `the notice sits directly under the placeholder row: ${JSON.stringify(lines)}`);
	// the status's leading is a two-cell indent (`└ ` was already spent on the row above — the tree landed there)
	assert.equal(lines[status]!.startsWith("  Command exited"), true, `the notice should be indent-aligned: ${JSON.stringify(lines[status])}`);
	// nowhere in the whole result tree is there a detached blank row
	const tree = lines.slice(corner, status + 1);
	for (const line of tree) assert.match(line, /^(?:└ |  )/, `the tree must have no detached-leading row: ${JSON.stringify(lines)}`);

	// with output and the status directly beneath it, the rows in between are all content, not blanks
	const withOutput = text("echo x; exit 5", { output: failed("x", "Command exited with code 5"), isError: true, elapsedMs: 100 }).map(body);
	const region = withOutput.slice(withOutput.findIndex((line) => line.startsWith("Run ")), withOutput.findIndex((line) => line.includes("Command exited")) + 1);
	assert.deepEqual(region, ["Run echo x; exit 5", "└ x", "  Command exited with code 5"], `no blank row between the command and the notice: ${JSON.stringify(withOutput)}`);
});

test("failure: the notice is not trimmed away by the output preview", { skip }, () => {
	// pi welds the status to the end of the output, and the preview keeps only the last 3 rows — the `\n\n` before the status
	// would push it out of view, leaving the user with one `│ … (N earlier lines)` plus two blank rows of nothing.
	// the fix treats the status row as **one row guaranteed a slot** in the preview (lift it out, give the budget to content, put it back).
	const lines = text("cat big", { output: failed(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")), isError: true, elapsedMs: 100 }).map(body);
	const hint = lines.find((line) => line.includes("earlier lines"))!;
	assert.equal(hint.startsWith("│ "), true, `the truncation hint carries │: ${JSON.stringify(lines)}`);
	const corner = lines.find((line) => line.startsWith("└ "))!;
	assert.equal(corner, "└ line 29", `└ should hang on the first content row below the hint (the status eats one budget slot): ${JSON.stringify(lines)}`);
	const status = lines.find((line) => line.includes("Command exited"))!;
	assert.equal(status.startsWith("  Command exited"), true, `the failure notice is indented inside the tree: ${status}`);
	assert.equal(lines.indexOf(status), lines.indexOf(corner) + 2, `the notice should follow the two preview rows: ${JSON.stringify(lines)}`);
});

test("failure: the same words in normal output are neither dyed nor swallowed", { skip }, () => {
	// the check must be "this run really errored" (`context.isError`) **plus** the text shape. Shape alone would dye
	// normal output that echoes the same words red, and lift it as a status when it happens to sit at the tail.
	const raw = renderBlock("echo 'Command exited with code 2'", {
		output: "Command exited with code 2\n",
		isError: false,
		elapsedMs: 100,
	});
	assert.equal(raw.some((line) => line.includes("\u001b[38;2;204;102;102m")), false, `a successful result must have no error red: ${JSON.stringify(raw.map(plain))}`);
	assert.deepEqual(raw.map(plain).map(body).slice(1), ["Run echo 'Command exited with code 2'", "└ Command exited with code 2"], "the output stays verbatim");
});

test("failure: the notice is red in expanded state (ctrl+o) too", { skip }, () => {
	// expanded state does not trim and does not mount the tree, but the color must not be lost (the user wants "failure notice in red" regardless of collapsed state).
	const raw = renderBlock("cmd", {
		output: `1\n2\n3\n\nCommand exited with code 2`,
		isError: true,
		expanded: true,
		elapsedMs: 100,
	});
	const status = raw.find((line) => plain(line).includes("Command exited with code 2"))!;
	assert.ok(status.includes("\u001b[38;2;204;102;102m"), `the notice should be error red in expanded state: ${JSON.stringify(status)}`);
	// expanded state has no tree: output rows are flush left, `└ ` never appears
	const lines = raw.map(plain).map(body);
	assert.equal(lines.some((line) => line.startsWith("└ ")), false, `expanded should have no └: ${JSON.stringify(lines)}`);
	assert.equal(lines.includes("1"), true, `expanded should emit verbatim: ${JSON.stringify(lines)}`);
});

test("failure: blanks do not break the fence — blank rows inside the tree carry `│ ` too", { skip }, () => {
	// the user's second report on 2026-09-21 (the real session entry at 13:01:21): pi's preview window
	// `truncateToVisualLines(styledOutput, 5, width)` cuts backwards from the tail, and the window's head can happen to be a blank row
	// (the output's own blank). Sandwiched between the truncation hint and `└ `, a bare blank reads as a "break".
	// the user's ruling: **such a blank gets `│` in front**, rather than being deleted.
	const lines = text("node x.mjs", {
		output: `1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n\nNode.js v26.4.0\n\n\nCommand exited with code 1`,
		isError: true,
		elapsedMs: 100,
	}).map(body);
	const hint = lines.findIndex((line) => line.includes("earlier lines"));
	const corner = lines.findIndex((line) => line.startsWith("└ "));
	assert.ok(hint !== -1, `the truncation hint should be there: ${JSON.stringify(lines)}`);
	assert.equal(lines[corner], "└ Node.js v26.4.0", `└ should sit below the hint: ${JSON.stringify(lines)}`);
	// every row between the hint and `└ ` carries `│` (here, the one blank row) — no bare blanks
	for (let i = hint; i < corner; i++) assert.equal(lines[i]!.startsWith("│"), true, `row ${i} broke the fence: ${JSON.stringify(lines)}`);
	// every row of the tree from `Run ` through the status row carries a leading (blank = `│`)
	const status = lines.findIndex((line) => line.includes("Command exited"));
	for (let i = lines.findIndex((line) => line.startsWith("Run ")); i <= status; i++) {
		assert.match(lines[i]!, /^(?:Run |\u2502|└ |  )/, `the tree broke its fence: ${JSON.stringify(lines)}`);
	}
	// the row outside the tree — pi's fixed blank (self-mode render()'s first row) — stays empty
	assert.equal(lines[0], "", `the row above the command should be blank: ${JSON.stringify(lines)}`);
});

test("warnings: the blank row above `[Full output: …]` carries no leading (the tree lands at `└ `)", { skip }, () => {
	// user decision 2026-09-21: `└ ` already points at the first substantive output, and everything below is indent-aligned continuations;
	// so the separator blank before warnings (`[Full output: …]`) and `Took` each stay **blank** —
	// hanging `│ ` there would look like the output continues. Only blanks **above** `└ ` get the bar (a break there is a real break).
	const lines = text("grep -rn x dist/", {
		output: "a\nb\nc\n\n[Showing lines 3-16 of 16 (50.0KB limit). Full output: /tmp/x.log]",
		isError: false,
		elapsedMs: 100,
	}).map(body);
	const corner = lines.findIndex((line) => line.startsWith("└ "));
	const warning = lines.findIndex((line) => line.includes("[Showing lines"));
	assert.ok(corner !== -1 && warning !== -1, `both sections should be there: ${JSON.stringify(lines)}`);
	// the output rows over-trimmed by one (lost `a`, only `c` left) — irrelevant to what this case asserts about leading prefixes
	assert.match(lines[corner]!, /^└ \S/, `└ hangs on substantive output: ${JSON.stringify(lines)}`);
	assert.equal(lines[warning - 1], "", `the row before [Full output should be blank: ${JSON.stringify(lines)}`);
	assert.equal(lines.slice(corner, warning).some((line) => line.startsWith("│")), false, `no more verticals below └: ${JSON.stringify(lines)}`);
	// above `└ ` a bare blank is still not allowed (the long-output + truncation-hint scenario)
	const long = text("grep -rn x dist/", {
		output: Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n\n[Showing lines 11-16 of 16 (50.0KB limit). Full output: /tmp/x.log]",
		isError: false,
		elapsedMs: 100,
	}).map(body);
	const c2 = long.findIndex((line) => line.startsWith("└ "));
	const run2 = long.findIndex((line) => line.startsWith("Run "));
	for (let i = run2; i < c2; i++) assert.notEqual(long[i], "", `a broken fence above └: ${JSON.stringify(long)}`);
});

test("duration footer: no `Took` on short commands, drawn on long ones", { skip }, () => {
	const fast = text("echo hi", { output: "hi\n", elapsedMs: 100 }).map(body);
	assert.equal(fast.some((line) => line.includes("Took ")), false, "short commands must not have a Took footer");
	const slow = text("echo hi", { output: "hi\n", ...SLOW }).map(body);
	assert.equal(slow.find((line) => line.includes("Took "))!.startsWith("  Took "), true, "a long command's Took sits indented inside the tree");
});

/* ------------------------------------------------------------------ *
 * Capability boundary (seatbelt sandbox) — end-to-end assertions on the execute path
 *
 * What runs here is **real commands**, all harmless: `echo`, writing to the test's own temp
 * directory, and one out-of-boundary deletion **guaranteed to be blocked by the sandbox**. The
 * out-of-boundary targets use probe filenames with random suffixes, so even if the sandbox did
 * not engage (which fails the test) all that happens is one empty file under $HOME, which the
 * case itself cleans up — nothing pre-existing is touched.
 *
 * Policy (user 2026-09-24): writes are not blocked; only out-of-boundary deletions are.
 * ------------------------------------------------------------------ */

/** Build a non-interactive ctx (hasUI: false → no escalation on boundary violation, just failure).
 *
 * The built-in bash's execute reads `ctx.sessionManager.getSessionId()` / `getSessionFile()`
 * to inject PI_SESSION_ID etc. into the environment, so those two fields must be given —
 * otherwise what surfaces is `Cannot read properties of undefined` rather than a sandbox error,
 * and the test cannot verify what it means to.
 */
function execCtx(cwd: string) {
	return {
		cwd,
		hasUI: false,
		mode: "print",
		ui: {},
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionId: () => "sbx-test-session",
			getSessionFile: () => undefined,
		},
	};
}

/** Run one command, returning { ok, text }: the body on success, the thrown message on failure. */
async function runCommand(definition: BashToolDefinitionLike, command: string, cwd: string) {
	assert.ok(definition.execute, "the bash tool must have execute");
	try {
		const result = await definition.execute("call-sbx", { command }, undefined, undefined, execCtx(cwd));
		const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
		return { ok: true, text };
	} catch (err) {
		return { ok: false, text: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Interactive ctx: `select` replays `selections` in order (simulating the user's dialog picks),
 * `confirm` replays `confirmAnswers` (for the fallback branch where no path can be extracted).
 * Every two-layer-authorization end-to-end case is driven through this harness.
 */
function execCtxUI(cwd: string, selections: string[], confirmAnswers: boolean[] = []) {
	const selects: Array<{ title: string; options: string[] }> = [];
	const confirms: Array<{ title: string; message: string }> = [];
	const notifies: string[] = [];
	return {
		cwd,
		hasUI: true,
		mode: "tui",
		selects,
		confirms,
		notifies,
		ui: {
			select: async (title: string, options: string[]) => {
				selects.push({ title, options });
				return selections.shift();
			},
			confirm: async (title: string, message: string) => {
				confirms.push({ title, message });
				return confirmAnswers.shift() ?? false;
			},
			notify: (text: string) => notifies.push(text),
		},
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionId: () => "sbx-test-session",
			getSessionFile: () => undefined,
		},
	};
}

async function runCommandWithCtx(
	definition: BashToolDefinitionLike,
	command: string,
	ctx: ReturnType<typeof execCtxUI>,
) {
	assert.ok(definition.execute, "the bash tool must have execute");
	try {
		const result = await definition.execute("call-sbx", { command }, undefined, undefined, ctx);
		const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
		return { ok: true, text };
	} catch (err) {
		return { ok: false, text: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Load a **separate** extension instance for the two-layer-authorization cases: `PI_SANDBOX_ALLOWLIST`
 * points at the case's own temp file (the user's real allowlist is never touched), and the session
 * scope set is cleared (it is a globalThis singleton — residue across cases would pollute the
 * checks). The returned restore puts env and set back.
 */
async function loadSandboxFixture(name: string): Promise<{
	definition: BashToolDefinitionLike;
	projectDir: string;
	allowlistFile: string;
	restore: () => void;
}> {
	assert.ok(pi);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-bash-${name}-`));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	const allowlistFile = path.join(root, "sandbox-allowlist.json");
	const prevAllowlist = process.env.PI_SANDBOX_ALLOWLIST;
	process.env.PI_SANDBOX_ALLOWLIST = allowlistFile;
	let definition: BashToolDefinitionLike | undefined;
	try {
		const { getSessionScopes } = await import("./allowlist.ts");
		getSessionScopes().clear();
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
		assert.deepEqual(loaded.errors, [], "loading must not error");
		definition = loaded.extensions[0]?.tools.get("bash")?.definition;
	} finally {
		if (prevAllowlist === undefined) delete process.env.PI_SANDBOX_ALLOWLIST;
		else process.env.PI_SANDBOX_ALLOWLIST = prevAllowlist;
	}
	assert.ok(definition?.execute, "the bash tool should be registered");
	return {
		definition,
		projectDir,
		allowlistFile,
		restore: () => {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

test("sandbox: commands inside the boundary run normally (echo, write cwd, delete in cwd all succeed)", { skip: sandboxSkip }, async () => {
	assert.ok(cached);
	const { definition, projectDir } = cached;

	const echoed = await runCommand(definition, "echo sandbox-ok", projectDir);
	assert.equal(echoed.ok, true, `echo must not fail: ${echoed.text}`);
	assert.match(echoed.text, /sandbox-ok/);

	// projectDir sits under /tmp, inside the writable boundary → writing to it and deleting it must both succeed
	const wrote = await runCommand(definition, "echo x > .sbx-write-probe && cat .sbx-write-probe", projectDir);
	assert.equal(wrote.ok, true, `a write inside the boundary must not fail: ${wrote.text}`);
	assert.match(wrote.text, /x/);

	const removed = await runCommand(definition, "rm -f .sbx-write-probe && echo removed", projectDir);
	assert.equal(removed.ok, true, `a delete inside the boundary must not fail: ${removed.text}`);
	assert.match(removed.text, /removed/);
});

test("sandbox: out-of-boundary writes pass (create and overwrite both allowed)", { skip: sandboxSkip }, async () => {
	assert.ok(cached);
	const { definition, projectDir } = cached;

	// probe path: under $HOME, random suffix. Writes are allowed by policy, so it **will** be created —
	// the finally removes that literal path with the test process's own fs (not through the sandbox).
	const probe = path.join(os.homedir(), `.sbx-write-probe-${process.pid}-${Date.now()}.txt`);
	try {
		const created = await runCommand(definition, `echo hi > ${JSON.stringify(probe)}`, projectDir);
		assert.equal(created.ok, true, `an out-of-boundary write should pass: ${created.text}`);
		assert.equal(fs.existsSync(probe), true, "the out-of-boundary file should be created");

		const appended = await runCommand(definition, `echo more >> ${JSON.stringify(probe)}`, projectDir);
		assert.equal(appended.ok, true, `an out-of-boundary append should pass too: ${appended.text}`);
	} finally {
		if (fs.existsSync(probe)) fs.rmSync(probe);
	}
});

test("sandbox: an out-of-boundary delete is refused by the OS, the file remains, no escalation in non-interactive mode", { skip: sandboxSkip }, async () => {
	assert.ok(cached);
	const { definition, projectDir } = cached;

	// first create a probe file under $HOME with the test process's own fs (no sandbox, so it can be created),
	// then let the sandboxed command delete it — that is the real shape of the two incidents.
	const probe = path.join(os.homedir(), `.sbx-delete-probe-${process.pid}-${Date.now()}.txt`);
	fs.writeFileSync(probe, "victim\n");
	try {
		const denied = await runCommand(definition, `rm -f ${JSON.stringify(probe)}`, projectDir);
		assert.equal(denied.ok, false, "the out-of-boundary delete must fail (did the sandbox engage?)");
		assert.match(denied.text, /Operation not permitted|EPERM/, `should be a sandbox refusal: ${denied.text}`);
		assert.match(denied.text, /\[Sandbox\]/, "non-interactive must include the sandbox note");
		assert.match(denied.text, /outside the deletion boundary/, "the message must name deletion, not writing");
		assert.equal(fs.existsSync(probe), true, "the out-of-boundary file must remain");
		assert.equal(fs.readFileSync(probe, "utf8"), "victim\n", "its content must be unchanged");
	} finally {
		// only clean up the literal path this case itself created; if it is gone, do nothing.
		if (fs.existsSync(probe)) fs.rmSync(probe);
	}
});

test("sandbox: an out-of-boundary rmdir is likewise refused, the directory remains", { skip: sandboxSkip }, async () => {
	assert.ok(cached);
	const { definition, projectDir } = cached;

	const probe = path.join(os.homedir(), `.sbx-rmdir-probe-${process.pid}-${Date.now()}`);
	fs.mkdirSync(probe);
	try {
		const denied = await runCommand(definition, `rmdir ${JSON.stringify(probe)}`, projectDir);
		assert.equal(denied.ok, false, "the out-of-boundary rmdir must fail");
		assert.match(denied.text, /Operation not permitted|EPERM/);
		assert.equal(fs.existsSync(probe), true, "the out-of-boundary directory must remain");
	} finally {
		if (fs.existsSync(probe)) fs.rmdirSync(probe);
	}
});

test("sandbox: with PI_SANDBOX=off the command is not wrapped (an out-of-boundary delete succeeds)", { skip }, async () => {
	assert.ok(pi);
	// reload the extension with off: sandboxOn is read at registration, so a reload is required for env changes.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-nosbx-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	const prev = process.env.PI_SANDBOX;
	process.env.PI_SANDBOX = "off";
	let offDefinition: BashToolDefinitionLike | undefined;
	try {
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
		assert.deepEqual(loaded.errors, [], "off-mode load must not error");
		offDefinition = loaded.extensions[0]?.tools.get("bash")?.definition;
	} finally {
		if (prev === undefined) delete process.env.PI_SANDBOX;
		else process.env.PI_SANDBOX = prev;
	}
	assert.ok(offDefinition?.execute, "off mode still registers the bash tool");

	// with the sandbox off, the out-of-boundary delete is no longer blocked — that is exactly the PI_SANDBOX=off semantics.
	// Use this case's own temp directory as the "out of boundary" target: it is under /tmp, but offDefinition's
	// boundary concept no longer exists — all this verifies is "command runs verbatim, no sandbox-exec prefix".
	const probe = path.join(root, "off-probe.txt");
	try {
		const r = await runCommand(offDefinition, `echo off > ${JSON.stringify(probe)}`, projectDir);
		assert.equal(r.ok, true, `writing inside root should succeed in off mode: ${r.text}`);
		assert.equal(fs.existsSync(probe), true);
		const del = await runCommand(offDefinition, `rm -f ${JSON.stringify(probe)}`, projectDir);
		assert.equal(del.ok, true, `deleting should succeed in off mode too: ${del.text}`);
		assert.equal(fs.existsSync(probe), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ *
 * End-to-end assertions for the two authorization layers (user decision 2026-09-24)
 *
 * Runs real commands + the real seatbelt sandbox + the real dialog (scripted ui.select).
 * All out-of-boundary targets use probe names with pid + timestamp, created and cleaned by the
 * case's own fs — nothing pre-existing is touched; the allowlist points at the case's own temp
 * file, not the user's real one.
 * ------------------------------------------------------------------ */

test("two-tier auth: ordinary directory — first prompt → remember → real delete → same directory asks no more", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("ordinary");
	// probe directory: under $HOME, random suffix — outside the boundary but not on the dangerous list (ordinary).
	const dir = path.join(os.homedir(), `.sbx-ordinary-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir);
	const first = path.join(dir, "a.txt");
	const second = path.join(dir, "b.txt");
	fs.writeFileSync(first, "a\n");
	fs.writeFileSync(second, "b\n");
	try {
		// first time: dialog appears, pick `Allow for this session (and remember the directory)`
		const ctx1 = execCtxUI(fx.projectDir, ["Allow for this session (and remember the directory)"]);
		const r1 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(first)}`, ctx1);
		assert.equal(r1.ok, true, `deletion should succeed after approval: ${r1.text}`);
		assert.equal(fs.existsSync(first), false, "the file really is deleted (not just a success return)");
		assert.equal(ctx1.selects.length, 1, "exactly one dialog should appear");
		assert.ok(ctx1.selects[0]!.title.includes("outside the permitted boundary"), `dialog title: ${ctx1.selects[0]!.title}`);
		assert.deepEqual(
			ctx1.selects[0]!.options,
			["Deny", "Allow for this session (and remember the directory)", "Allow once"],
			"the ordinary directory's three options",
		);
		assert.ok(ctx1.selects[0]!.title.includes("high-risk") === false, "an ordinary directory must not go through the dangerous dialog");

		// persisted: the allowlist should contain this directory (not the file)
		const onDisk = JSON.parse(fs.readFileSync(fx.allowlistFile, "utf8"));
		assert.deepEqual(onDisk.entries.map((e: { path: string }) => e.path), [dir], "what is remembered is the parent directory");

		// second time: another file in the same directory — the profile already carries the allowlist root, succeeds inside the sandbox, **no dialog**
		const ctx2 = execCtxUI(fx.projectDir, []);
		const r2 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(second)}`, ctx2);
		assert.equal(r2.ok, true, `the second one must not be blocked: ${r2.text}`);
		assert.equal(fs.existsSync(second), false);
		assert.equal(ctx2.selects.length, 0, "a remembered directory no longer prompts (the whole point of this feature)");
		assert.equal(ctx2.confirms.length, 0);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("two-tier auth: `Allow once` deletes but does not persist; the same directory prompts again", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("once");
	const dir = path.join(os.homedir(), `.sbx-once-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir);
	const first = path.join(dir, "a.txt");
	const second = path.join(dir, "b.txt");
	fs.writeFileSync(first, "a\n");
	fs.writeFileSync(second, "b\n");
	try {
		const ctx1 = execCtxUI(fx.projectDir, ["Allow once"]);
		const r1 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(first)}`, ctx1);
		assert.equal(r1.ok, true, `this approval should delete successfully: ${r1.text}`);
		assert.equal(fs.existsSync(first), false);
		assert.equal(fs.existsSync(fx.allowlistFile), false, "`Allow once` must not persist");

		const ctx2 = execCtxUI(fx.projectDir, ["Deny"]);
		const r2 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(second)}`, ctx2);
		assert.equal(r2.ok, false, "not remembered → the second one is blocked again");
		assert.equal(ctx2.selects.length, 1, "the second one still prompts");
		assert.equal(fs.existsSync(second), true, "after Deny the file must remain");
		assert.match(r2.text, /user denied/, `the refusal reason must be shown to the user: ${r2.text}`);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("two-tier auth: a dangerous directory asks every time; after `Allow for this session` it does not, and after reloading the extension it does again", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("dangerous");
	// dangerous directory: ~/Library is in DANGEROUS_HOME_DIRS (subtree semantics).
	// The probe is created beneath it and cleaned by the case itself — nothing existing under ~/Library is touched.
	const dir = path.join(os.homedir(), "Library", `.sbx-dangerous-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const first = path.join(dir, "a.txt");
	const second = path.join(dir, "b.txt");
	const third = path.join(dir, "c.txt");
	for (const f of [first, second, third]) fs.writeFileSync(f, "x\n");
	try {
		// first time: the dangerous dialog, three options different from the ordinary one
		const ctx1 = execCtxUI(fx.projectDir, ["Allow once"]);
		const r1 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(first)}`, ctx1);
		assert.equal(r1.ok, true, `deletion should succeed after approval: ${r1.text}`);
		assert.equal(fs.existsSync(first), false);
		assert.equal(ctx1.selects.length, 1);
		assert.ok(ctx1.selects[0]!.title.includes("high-risk directories"), `dangerous dialog title: ${ctx1.selects[0]!.title}`);
		assert.deepEqual(
			ctx1.selects[0]!.options,
			["Deny", "Allow once", "Allow for this session"],
			"a dangerous directory has no \"remember\" option",
		);
		assert.equal(fs.existsSync(fx.allowlistFile), false, "a dangerous directory never persists");

		// second time: still a dangerous directory → still prompts (that is "always ask")
		const ctx2 = execCtxUI(fx.projectDir, ["Allow for this session"]);
		const r2 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(second)}`, ctx2);
		assert.equal(r2.ok, true, `the session exemption should let it through: ${r2.text}`);
		assert.equal(ctx2.selects.length, 1, "a dangerous directory still prompts on the second run");
		assert.equal(fs.existsSync(second), false);
		assert.equal(fs.existsSync(fx.allowlistFile), false, "session exemptions do not persist either");

		// third time: exempted this session → no prompt; the profile carries the session root and it succeeds inside the sandbox
		const ctx3 = execCtxUI(fx.projectDir, []);
		const r3 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(third)}`, ctx3);
		assert.equal(r3.ok, true, `after session exemption it must not be blocked again: ${r3.text}`);
		assert.equal(ctx3.selects.length, 0, "after session exemption it does not prompt");
		assert.equal(fs.existsSync(third), false);

		// session exemptions are not persisted → after reloading the extension (simulating a pi restart) it prompts again.
		// The new instance reads the same blank allowlist file, while session scopes are a globalThis singleton —
		// so it is cleared first, simulating "session state is gone after restart".
		const { getSessionScopes } = await import("./allowlist.ts");
		getSessionScopes().clear();
		const fourth = path.join(dir, "d.txt");
		fs.writeFileSync(fourth, "x\n");
		const ctx4 = execCtxUI(fx.projectDir, ["Deny"]);
		const r4 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(fourth)}`, ctx4);
		assert.equal(r4.ok, false, "after restart the dangerous directory asks every time again");
		assert.equal(ctx4.selects.length, 1, "it prompted again");
		assert.equal(fs.existsSync(fourth), true);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		const { getSessionScopes } = await import("./allowlist.ts");
		getSessionScopes().clear();
		fx.restore();
	}
});

test("two-tier auth: headless + a preset allowlist → deletion succeeds and no dialog", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("headless-allow");
	const dir = path.join(os.homedir(), `.sbx-headless-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir);
	const target = path.join(dir, "a.txt");
	fs.writeFileSync(target, "a\n");
	// preset allowlist: simulates the user having approved this directory in an earlier interactive session
	fs.writeFileSync(
		fx.allowlistFile,
		JSON.stringify({ version: 1, entries: [{ path: dir, addedAt: new Date().toISOString(), source: "confirm" }] }),
		"utf8",
	);
	try {
		// reload the extension so it reads the preset allowlist (the store is a singleton cache keyed by file path,
		// and loadSandboxFixture's temp file path is new, so the new instance reads the disk)
		const r = await runCommand(fx.definition, `rm -f ${JSON.stringify(target)}`, fx.projectDir);
		assert.equal(r.ok, true, `the allowlist should take effect under headless: ${r.text}`);
		assert.equal(fs.existsSync(target), false, "the file really is deleted");
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("two-tier auth: headless + a dangerous directory → fail-closed refusal, file remains", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("headless-danger");
	const dir = path.join(os.homedir(), "Library", `.sbx-headless-danger-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, "a.txt");
	fs.writeFileSync(target, "a\n");
	try {
		const r = await runCommand(fx.definition, `rm -f ${JSON.stringify(target)}`, fx.projectDir);
		assert.equal(r.ok, false, "a dangerous directory must be refused under headless");
		assert.match(r.text, /non-interactive/, `the reason must name the environment: ${r.text}`);
		assert.equal(fs.existsSync(target), true, "the file must remain");
		assert.equal(fs.readFileSync(target, "utf8"), "a\n", "its content must be unchanged");
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("never-delete: deleting a probe under ~/.gnupg is refused outright with no dialog; the file remains", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("never-delete");
	// the probe is created under ~/.gnupg (a never-delete subtree) by the test process's own fs (no sandbox),
	// and cleaned by itself in finally — nothing existing under ~/.gnupg is touched.
	const dir = path.join(os.homedir(), ".gnupg", `.sbx-never-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, "probe.txt");
	fs.writeFileSync(target, "victim\n");
	try {
		// give it every "allow" option: if it really did prompt and one was picked, this case fails —
		// what is asserted is precisely "there is no allow option to give".
		const ctx = execCtxUI(fx.projectDir, ["Allow for this session", "Allow once"]);
		const r = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(target)}`, ctx);
		assert.equal(r.ok, false, "a never-delete must fail");
		assert.match(r.text, /protected/, `the reason must name the tier: ${r.text}`);
		assert.equal(ctx.selects.length, 0, "no dialog — there is no allow option");
		assert.equal(ctx.confirms.length, 0);
		assert.equal(fs.existsSync(target), true, "the file must remain");
		assert.equal(fs.readFileSync(target, "utf8"), "victim\n", "its content must be unchanged");
		assert.equal(fs.existsSync(fx.allowlistFile), false, "nothing persists");
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("never-delete: refused under headless too, and the reason names the tier", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("never-delete-headless");
	const dir = path.join(os.homedir(), ".gnupg", `.sbx-never-h-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, "probe.txt");
	fs.writeFileSync(target, "victim\n");
	try {
		const r = await runCommand(fx.definition, `rm -f ${JSON.stringify(target)}`, fx.projectDir);
		assert.equal(r.ok, false, "never-delete is refused under headless as well");
		assert.match(r.text, /protected/, `the reason must name the tier: ${r.text}`);
		assert.equal(fs.existsSync(target), true, "the file must remain");
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("never-delete: a probe under nested entry ~/.config/gh is likewise hard-blocked (added 2026-09-25)", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("never-delete-nested");
	// the whole ~/.config subtree is ordinary tier (user 2026-09-25), but the nested entry .config/gh pulls
	// the gh-token directory back into never-delete — what is asserted is precisely that the "pull back" works.
	// the probe directory is created and removed by the test process's own fs (recursive creates only down to the probe itself; finally removes only the probe).
	const dir = path.join(os.homedir(), ".config", "gh", `.sbx-never-n-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, "probe.txt");
	fs.writeFileSync(target, "victim\n");
	try {
		const ctx = execCtxUI(fx.projectDir, ["Allow for this session", "Allow once"]);
		const r = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(target)}`, ctx);
		assert.equal(r.ok, false, "a nested never-delete subtree must fail");
		assert.match(r.text, /protected/, `the reason must name the tier: ${r.text}`);
		assert.equal(ctx.selects.length, 0, "no dialog — there is no allow option");
		assert.equal(fs.existsSync(target), true, "the file must remain");
		assert.equal(fs.readFileSync(target, "utf8"), "victim\n", "its content must be unchanged");
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("tool state directories: deleting a probe under ~/.pi/agent pops the three-option dialog, remembered afterwards (user 2026-09-25)", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("pi-agent-ordinary");
	// reproduce the shape of `pi update --extensions` being blocked: a stale lock under ~/.pi/agent.
	// The probe is created and cleaned by the test process's own fs — nothing existing under ~/.pi/agent is touched.
	const dir = path.join(os.homedir(), ".pi", "agent", `.sbx-pi-${process.pid}-${Date.now()}.lock`);
	fs.mkdirSync(dir);
	const first = path.join(dir, "a");
	const second = path.join(dir, "b");
	fs.writeFileSync(first, "a\n");
	fs.writeFileSync(second, "b\n");
	try {
		const ctx1 = execCtxUI(fx.projectDir, ["Allow for this session (and remember the directory)"]);
		const r1 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(first)}`, ctx1);
		assert.equal(r1.ok, true, `deletion should succeed after approval: ${r1.text}`);
		assert.equal(fs.existsSync(first), false, "the file really is deleted");
		assert.equal(ctx1.selects.length, 1, "exactly one dialog should appear (no longer the never-delete outright refusal)");
		assert.deepEqual(
			ctx1.selects[0]!.options,
			["Deny", "Allow for this session (and remember the directory)", "Allow once"],
			"the ordinary directory's three options",
		);
		// what persists is the target's parent directory (memoryScopeFor's policy: a file remembers its parent) — the temp allowlist file, not the user's real one
		const onDisk = JSON.parse(fs.readFileSync(fx.allowlistFile, "utf8"));
		assert.deepEqual(onDisk.entries.map((e: { path: string }) => e.path), [dir], "what is remembered is the parent directory");

		// second time: same directory — the profile already carries the allowlist root; succeeds inside the sandbox, no prompt
		const ctx2 = execCtxUI(fx.projectDir, []);
		const r2 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(second)}`, ctx2);
		assert.equal(r2.ok, true, `a remembered directory must not be blocked again: ${r2.text}`);
		assert.equal(ctx2.selects.length, 0);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("regenerable cache: deleting a probe under ~/.cache succeeds silently, no dialog", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("safe-cache");
	// ~/.cache is inside the writable boundary (SAFE_CACHE_HOME_DIRS) — deletable and rebuildable, no need to bother the user.
	const dir = path.join(os.homedir(), ".cache", `.sbx-cache-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, "probe.txt");
	fs.writeFileSync(target, "x\n");
	try {
		const ctx = execCtxUI(fx.projectDir, []);
		const r = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(target)} && echo removed`, ctx);
		assert.equal(r.ok, true, `a cache directory inside the writable boundary should succeed directly: ${r.text}`);
		assert.match(r.text, /removed/);
		assert.equal(fs.existsSync(target), false, "the file really is deleted");
		assert.equal(ctx.selects.length, 0, "no dialog");
		assert.equal(ctx.confirms.length, 0);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("two-tier auth: headless + an unauthorized ordinary directory → fail-closed too", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("headless-ordinary");
	const dir = path.join(os.homedir(), `.sbx-headless-ord-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir);
	const target = path.join(dir, "a.txt");
	fs.writeFileSync(target, "a\n");
	try {
		const r = await runCommand(fx.definition, `rm -f ${JSON.stringify(target)}`, fx.projectDir);
		assert.equal(r.ok, false, "with nobody at the screen, an ordinary directory cannot be approved by default");
		assert.match(r.text, /unauthorized/, `the reason must name unauthorized: ${r.text}`);
		assert.equal(fs.existsSync(target), true);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("two-tier auth: a command mixing authorized and unauthorized paths → still prompts (auto-pass only when everything hits)", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("mixed");
	const allowedDir = path.join(os.homedir(), `.sbx-mixed-allow-${process.pid}-${Date.now()}`);
	const otherDir = path.join(os.homedir(), `.sbx-mixed-other-${process.pid}-${Date.now()}`);
	fs.mkdirSync(allowedDir);
	fs.mkdirSync(otherDir);
	const a = path.join(allowedDir, "a.txt");
	const b = path.join(otherDir, "b.txt");
	fs.writeFileSync(a, "a\n");
	fs.writeFileSync(b, "b\n");
	fs.writeFileSync(
		fx.allowlistFile,
		JSON.stringify({ version: 1, entries: [{ path: allowedDir, addedAt: new Date().toISOString(), source: "confirm" }] }),
		"utf8",
	);
	try {
		// delete two targets together: the authorized one succeeds inside the sandbox, the unauthorized one is blocked → command fails and prompts.
		// Only the unauthorized one should appear in the dialog (the authorized one must not be asked again).
		const ctx = execCtxUI(fx.projectDir, ["Deny"]);
		const r = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(a)} ${JSON.stringify(b)}`, ctx);
		assert.equal(r.ok, false, "unauthorized paths present → the whole command cannot pass silently");
		assert.equal(ctx.selects.length, 1, "a dialog should appear");
		assert.ok(ctx.selects[0]!.title.includes("outside the permitted boundary"), `dialog title: ${ctx.selects[0]!.title}`);
		assert.equal(fs.existsSync(b), true, "after Deny the unauthorized file must remain");
	} finally {
		for (const d of [allowedDir, otherDir]) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
		fx.restore();
	}
});

test("two-tier auth: the blocked path cannot be extracted (cd + relative path) → no prompt, no bare rerun, error reported verbatim", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("unparsed");
	const dir = path.join(os.homedir(), `.sbx-unparsed-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir);
	const target = path.join(dir, "a.txt");
	fs.writeFileSync(target, "a\n");
	try {
		// `cd` outside the boundary and delete with a **relative path**: BSD rm reports `rm: a.txt: Operation not permitted`,
		// which carries no absolute path — extractDeniedPaths deliberately rejects relative paths (no absolute target can be guessed).
		// This is a shape a model really writes (`cd X && rm -f y`), not an artificial edge case.
		//
		// old behavior: asked once at session level for the whole command (confirm); on approval the whole command reran outside the sandbox.
		// new behavior (2026-09-24): no prompt, no bare rerun — an unrecognized target must not trade the whole command for
		// the full deletion capability outside the entire boundary. The way out is /sandbox-boundary allow <dir>.
		const ctx = execCtxUI(fx.projectDir, [], [true]);
		const r = await runCommandWithCtx(fx.definition, `cd ${JSON.stringify(dir)} && rm -f a.txt`, ctx);
		assert.equal(r.ok, false, "no path extracted → the command stays failed");
		assert.equal(ctx.confirms.length, 0, "no more confirm (the out-of-sandbox rerun fallback is deleted)");
		assert.equal(ctx.selects.length, 0, "no select either (an unrecognized path cannot be split dangerous/ordinary)");
		assert.ok(r.text.includes("[Sandbox] Could not identify the blocked path"), `the error must carry the [Sandbox] hint: ${r.text}`);
		assert.ok(r.text.includes("/sandbox-boundary allow"), `the hint must show a way out: ${r.text}`);
		assert.equal(fs.existsSync(target), true, "the file must remain (nothing ran)");
		assert.equal(fs.existsSync(fx.allowlistFile), false, "nothing persisted");

		// run the same command again: behavior is unchanged (there is no "approved for this session" anymore)
		const ctx2 = execCtxUI(fx.projectDir, [], [true]);
		const r2 = await runCommandWithCtx(fx.definition, `cd ${JSON.stringify(dir)} && rm -f a.txt`, ctx2);
		assert.equal(r2.ok, false, "the second run fails the same way — there is no more \"approved for this session\"");
		assert.equal(ctx2.confirms.length, 0);
		assert.equal(fs.existsSync(target), true);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("heredoc inside the sandbox succeeds (/var/tmp is inside the writable boundary)", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("heredoc");
	try {
		// bash 3.2's heredoc must create /var/tmp/sh-thd-* then unlink it (delete-on-open).
		// Before /var/tmp entered the writable boundary this failed 100% (measured 2026-09-24), leaking one sh-thd-* each time.
		const before = fs.readdirSync("/private/var/tmp").filter((n) => n.startsWith("sh-thd-")).length;
		const ctx = execCtxUI(fx.projectDir, []);
		const r = await runCommandWithCtx(fx.definition, 'cat <<EOF\nhello heredoc\nEOF', ctx);
		assert.equal(r.ok, true, `the heredoc should succeed: ${r.text}`);
		assert.ok(r.text.includes("hello heredoc"), "the heredoc body must come out verbatim");
		assert.equal(ctx.selects.length, 0, "should not prompt");
		assert.equal(ctx.confirms.length, 0, "should not confirm");
		const after = fs.readdirSync("/private/var/tmp").filter((n) => n.startsWith("sh-thd-")).length;
		// use <= rather than ==: this run must not add any (the old behavior leaked 100%), but the system cleaning up
		// an old one must not fail the case.
		assert.ok(after <= before, `no more leaked sh-thd-* temp files (before=${before} after=${after})`);
	} finally {
		fx.restore();
	}
});

test("output containing EPERM but no delete shape → no dialog, no confirm, carries the [Sandbox] hint", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("exec-failure");
	try {
		// a setuid / platform binary is EPERM on exec inside the sandbox — not a deletion, no delete dialog should appear.
		// /bin/ps is setuid and must fail inside the sandbox; the output shape `bash: /bin/ps: Operation not permitted`
		// is caught by exclusion 2 (shell prog), so extractDeniedPaths returns empty → no dialog.
		const ctx = execCtxUI(fx.projectDir, []);
		const r = await runCommandWithCtx(fx.definition, "/bin/ps -o pid= 2>&1; exit 1", ctx);
		assert.equal(r.ok, false, "the command itself fails (exec EPERM)");
		assert.equal(ctx.selects.length, 0, "an exec failure is not a deletion — no select");
		assert.equal(ctx.confirms.length, 0, "no confirm either (the out-of-sandbox rerun fallback is deleted)");
		assert.ok(r.text.includes("[Sandbox] Could not identify the blocked path"), `the error must carry the [Sandbox] hint: ${r.text}`);
	} finally {
		fx.restore();
	}
});

test("two-tier auth: after Deny the file remains, its content is unchanged, and nothing persists", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("deny");
	const dir = path.join(os.homedir(), `.sbx-deny-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir);
	const target = path.join(dir, "a.txt");
	fs.writeFileSync(target, "victim\n");
	try {
		const ctx = execCtxUI(fx.projectDir, ["Deny"]);
		const r = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(target)}`, ctx);
		assert.equal(r.ok, false);
		assert.equal(fs.existsSync(target), true, "after Deny the file must remain");
		assert.equal(fs.readFileSync(target, "utf8"), "victim\n", "its content must be unchanged");
		assert.equal(fs.existsSync(fx.allowlistFile), false, "Deny must not persist");
		assert.ok(ctx.notifies.length === 0, "Deny must not notify");
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});
