/**
 * Tests for the read block shape (read-path-collapse.ts) — end-to-end: pi's own
 * extension loader really loads this extension, then pi's own `ToolExecutionComponent`
 * renders a real read block and the rendered **rows** are asserted.
 *
 * Run with:  node --test clients/pi/extensions/read-path-collapse/render.test.ts
 *
 * Why this detour is required (instead of calling the extension's internals directly):
 * the feature's **entire** value is "what the user's screen looks like", and the
 * on-screen rows are built layer by layer through `ToolExecutionComponent` →
 * `renderCall` / `renderResult` → Box → pi-tui. Testing internals alone would miss the
 * issues actually hit live: a wrong `lastComponent` making pi silently fall back (a bare
 * `read` title, path gone), the title row and result body disagreeing on the left
 * margin, over-wide lines clipped by pi-tui.
 *
 * The assertion rule (the shape the user set on 2026-09-21, one look with
 * `bash-command-collapse.ts`):
 *   - the title row `• Read <path>`: the dot at **column 0**, `Read`'s `R` at **column
 *     2**, the path right after;
 *   - the dot color in three states: while reading (pending / partial) `dim`, success
 *     `toolDiffAdded`, failure `toolDiffRemoved`;
 *   - every result-body line padded two spaces (same column as `Read`); pi's leading
 *     blank row is stripped (the body hugs the title);
 *   - the block has **no background** (none of `toolPendingBg` / `toolSuccessBg` /
 *     `toolErrorBg` is painted; the other tools keep theirs — a dedicated control
 *     assertion);
 *   - the block has **no top/bottom border rows** (pi's default `Box(1, 1)` pair), and
 *     no blank row inside;
 *   - every row's visible width ≤ the terminal width (pi-tui clips over-wide rows — one
 *     column over loses content);
 *   - the long-path compression branch (`…` prefix), the compact shapes (`[skill]`), and
 *     the expanded state (ctrl+o) all keep the shape above.
 * No local pi library entry → skip wholesale (never fake a pass).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path, { join } from "node:path";
import test from "node:test";
// These snapshots explicitly assert 24-bit ANSI colors, independent of the test terminal.
process.env.COLORTERM = "truecolor";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "read-path-collapse.ts");
/** The status dot `•` (U+2022): hangs only on the title row's start. */
const BAR = "\u2022";
/** The default skin (dark)'s three state slots' **true colors** — the dot color assertions watch exactly these. */
const DIM_ANSI = "\u001b[38;2;102;102;102m"; // dim            `#666666`
const ADDED_ANSI = "\u001b[38;2;181;189;104m"; // toolDiffAdded  `#b5bd68`
const REMOVED_ANSI = "\u001b[38;2;204;102;102m"; // toolDiffRemoved `#cc6666`
const SKIP = "could not find the local pi library entry (requires an installed pi)";

/**
 * pi's library entry (not the CLI): bundle is the shape `pi` actually runs, dist is the
 * node build shape.
 *
 * First back-trace the `pi` executable to the **real install location** (pnpm/npm shim
 * scripts carry a `# cmd-shim-target=<abs path>` line; on Unix npm uses a symlink — both
 * are tried), then fall back to the `~/.pi/agent/npm` copy — the check is **whether it
 * really imports**, not whether the path exists (that copy may be a hollow shell with
 * sibling packages trimmed). All failing → undefined → skip wholesale.
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
 * pi's bundled chalk decides **at module-eval time** whether to emit styles (off by
 * default without a TTY), and `theme.bold()` is it — so the color assertions need this
 * env var, set **before importing pi**.
 * Without it those assertions see bare text with no SGR and "pass" forever.
 * Only affects this test process and respects a user's existing NO_COLOR.
 */
if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

interface ToolDefinitionLike {
	renderShell?: string;
	renderCall?: (...args: any[]) => any;
	renderResult?: (...args: any[]) => any;
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
		rendererState: { startedAt?: number; endedAt?: number; interval?: NodeJS.Timeout };
		setArgsComplete?: () => void;
		markExecutionStarted: () => void;
		setExpanded: (expanded: boolean) => void;
		updateResult: (result: unknown, isPartial?: boolean) => void;
		render: (width: number) => string[];
	};
}

let pi: PiApi | undefined;
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

/** Strip every ANSI / OSC / OSC 8 hyperlink escape, keeping only visible text (assertions read this). */
const plain = (line: string): string =>
	line
		.replace(/\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\][^\u0007]*\u0007/g, "")
		.replace(/\u001b\\/g, "")
		.replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** The visible column count (fixtures are ASCII-only; Han chars count 2, matching pi-tui's rule). */
function widthOf(line: string): number {
	let width = 0;
	for (const ch of plain(line)) {
		const code = ch.codePointAt(0) ?? 0;
		const wide = code >= 0x2e80 && code <= 0xa4cf;
		width += wide ? 2 : 1;
	}
	return width;
}

/**
 * Load this extension via pi's own loader (done once at module eval; the registered tool
 * definition is reused across tests).
 * The top-level await is required: `test()` callbacks are sync, loading is async.
 */
let cached: { agentDir: string; projectDir: string; definition: ToolDefinitionLike } | undefined;
let cleanup: (() => void) | undefined;

if (pi) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-shape-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	cleanup = () => fs.rmSync(root, { recursive: true, force: true });

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	assert.deepEqual(loaded.errors, [], "pi's extension loader must not error");
	const definition = loaded.extensions[0]?.tools.get("read")?.definition;
	assert.ok(definition, "this extension must register the read tool (same-name registration across extensions is first-wins)");
	assert.equal(definition.renderShell, "self", "the read block must take the self shell (no background, no border rows)");
	pi.initTheme("dark");
	cached = { agentDir, projectDir, definition };
}

test.after(() => cleanup?.());

interface RenderOptions {
	content?: string;
	isError?: boolean;
	partial?: boolean;
	expanded?: boolean;
	/** Do not call `updateResult` — the real "started reading, no result yet" moment. */
	noResult?: boolean;
	width?: number;
	details?: unknown;
}

/** Render a real read block: `markExecutionStarted` → `updateResult`, pi's own call order. */
function renderBlock(args: unknown, options: RenderOptions = {}): string[] {
	assert.ok(pi && cached);
	const component = new pi.ToolExecutionComponent(
		"read",
		"call-1",
		args,
		{},
		cached.definition,
		{ requestRender() {} },
		cached.projectDir,
	);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	component.setExpanded(options.expanded === true);
	if (!options.noResult) {
		component.updateResult(
			{
				content: [{ type: "text", text: options.content ?? "" }],
				details: options.details ?? {},
				...(options.isError === undefined ? {} : { isError: options.isError }),
			},
			options.partial === true,
		);
	}
	const lines = component.render(options.width ?? 79);
	// read's result renderer starts a per-second invalidate timer in partial too; without clearing it node --test never exits
	clearInterval(component.rendererState.interval);
	return lines;
}

const text = (args: unknown, options: RenderOptions = {}): string[] => renderBlock(args, options).map(plain);

/** The path long enough to always trigger compression (read-path-collapse.ts's reason to exist). */
const LONG_PATH =
	"/Users/bachi/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

/**
 * Normalize a row for assertions: drop the two-column left margin (`• ` / two spaces)
 * and the trailing padding (`Box.render` pads each row to the terminal width — padding
 * is not content). **Everything else at the row start is kept**.
 */
const body = (line: string): string => line.replace(/ +$/, "").replace(/^(?:\u2022 |  )/, "");

test("title row: `• Read <path>`, dot at column 0, `Read` at column 2", { skip }, () => {
	const raw = renderBlock({ path: "/tmp/x.js" }, { content: "const a = 1;\n" }).map(plain);
	assert.equal(raw[0], "", "row 0 is pi self-mode's fixed blank (not part of the block)");
	const title = raw[1]!;
	assert.equal(title.startsWith(`${BAR} Read `), true, `the title row should start with \`• Read \`: ${JSON.stringify(title)}`);
	assert.equal(title.indexOf(BAR), 0, "the dot sits at column 0");
	assert.equal(title.indexOf("Read"), 2, "`Read` sits at column 2 (body shifted right one column)");
	assert.equal(title.includes("/tmp/x.js"), true, `the path stays on the title row: ${JSON.stringify(title)}`);
	// only the title row carries a dot
	assert.equal(raw.filter((line) => line.includes(BAR)).length, 1, `the block may carry exactly one dot: ${JSON.stringify(raw)}`);
});

test("dot color: dim while reading, green on success, red on failure", { skip }, () => {
	// user 2026-09-21: same semantics as the bash block (same `•` glyph, coloring identical).
	const barAnsi = (line: string): string | undefined => /(\u001b\[38;2;\d+;\d+;\d+m)\u2022/.exec(line)?.[1];

	// "while reading" = the result has not come back (`renderCall` alone)
	assert.equal(
		barAnsi(renderBlock({ path: "/tmp/x.js" }, { noResult: true })[1]!),
		DIM_ANSI,
		"the dot should be dim gray while pending",
	);
	// a streaming partial snapshot is still "reading"
	assert.equal(
		barAnsi(renderBlock({ path: "/tmp/x.js" }, { content: "a\n", partial: true })[1]!),
		DIM_ANSI,
		"the dot should be dim gray while partial",
	);
	// success → toolDiffAdded (the diff addition green)
	assert.equal(
		barAnsi(renderBlock({ path: "/tmp/x.js" }, { content: "a\n" })[1]!),
		ADDED_ANSI,
		"the dot should be green on success",
	);
	// failure → toolDiffRemoved (the diff deletion red)
	assert.equal(
		barAnsi(renderBlock({ path: "/tmp/nope.js" }, { content: "File not found", isError: true })[1]!),
		REMOVED_ANSI,
		"the dot should be red on failure",
	);
});

test("the dot color is fetched from the theme each time (change the theme → the next render follows)", { skip }, () => {
	// asserts "fetched fresh every render", not three hardcoded colors: temporarily patch two dark-skin slots and the next render must follow.
	const singleton = (globalThis as Record<symbol, unknown>)[Symbol.for("@earendil-works/pi-coding-agent:theme")] as
		| { fgColors?: Map<string, string> }
		| undefined;
	assert.ok(singleton?.fgColors?.set, "pi's theme singleton should exist (initTheme ran)");
	const fgColors = singleton!.fgColors!;
	const dimBefore = fgColors.get("dim");
	const addedBefore = fgColors.get("toolDiffAdded");
	try {
		fgColors.set("dim", "\u001b[38;2;1;2;3m");
		fgColors.set("toolDiffAdded", "\u001b[38;2;4;5;6m");
		assert.equal(
			/(\u001b\[38;2;\d+;\d+;\d+m)\u2022/.exec(renderBlock({ path: "/tmp/x.js" }, { noResult: true })[1]!)?.[1],
			"\u001b[38;2;1;2;3m",
			"while reading it should follow the new dim",
		);
		assert.equal(
			/(\u001b\[38;2;\d+;\d+;\d+m)\u2022/.exec(renderBlock({ path: "/tmp/x.js" }, { content: "a\n" })[1]!)?.[1],
			"\u001b[38;2;4;5;6m",
			"success should follow the new toolDiffAdded",
		);
	} finally {
		if (dimBefore === undefined) fgColors.delete("dim");
		else fgColors.set("dim", dimBefore);
		if (addedBefore === undefined) fgColors.delete("toolDiffAdded");
		else fgColors.set("toolDiffAdded", addedBefore);
	}
});

test("result body: every line indented two, same column as `Read`", { skip }, () => {
	// in collapsed mode pi only paints a result body on error (`formatReadResult`'s `!expanded && !isError` guard),
	// so the failing case verifies the body's column position.
	const raw = renderBlock({ path: "/tmp/nope.js" }, { content: "File not found\nsecond line", isError: true }).map(plain);
	const title = raw[1]!;
	assert.equal(title.indexOf("Read"), 2, "the title's `Read` sits at column 2");
	const first = raw.find((line) => line.includes("File not found"))!;
	assert.equal(first.indexOf("File"), 2, `the result body should share \`Read\`'s column: ${JSON.stringify(raw)}`);
	const second = raw.find((line) => line.includes("second line"))!;
	assert.equal(second.indexOf("second"), 2, `the second line is indented two the same way: ${JSON.stringify(raw)}`);
});

test("the block: no background (none of pending / success / failure paints)", { skip }, () => {
	// no background sequence (`48;2;…` / `40-47` / `100-107`) may appear — that is what a `Box` without bgFn means.
	const hasBg = (line: string): boolean => /\u001b\[(?:4[0-7]|10[0-7]|48[;:])/.test(line);
	const cases: Array<[string, string[]]> = [
		["while reading", renderBlock({ path: "/tmp/x.js" }, { noResult: true })],
		["success", renderBlock({ path: "/tmp/x.js" }, { content: "a\nb\n" })],
		["failure", renderBlock({ path: "/tmp/nope.js" }, { content: "File not found", isError: true })],
		["expanded", renderBlock({ path: "/tmp/x.js" }, { content: "a\nb\n", expanded: true })],
	];
	for (const [label, lines] of cases) {
		assert.deepEqual(lines.filter(hasBg), [], `${label}: the read block must have no background row`);
		// but the content is still there ("no background" must not become "no block")
		assert.equal(lines.map(plain).some((line) => line.includes(BAR)), true, `${label}: the title row must still be there`);
	}
});

test("the block: no top/bottom border rows, the body hugs the title", { skip }, () => {
	// the collapsed result body only shows on error (see above) — the failing case verifies "body hugs title".
	const raw = renderBlock({ path: "/tmp/nope.js" }, { content: "File not found", isError: true }).map(plain);
	// row 0 is pi self-mode's fixed blank; the block itself starts at row 1 and ends at the last content row
	assert.equal(raw[0], "", "row 0 is pi's fixed blank");
	assert.equal(raw[1]!.includes(BAR), true, `the block's row 1 should be the title (no top border row): ${JSON.stringify(raw)}`);
	const last = raw[raw.length - 1]!;
	assert.notEqual(last.trim(), "", `the last row must not be blank (no bottom border row): ${JSON.stringify(raw)}`);
	// no blank row inside either: the row after the title is the body (pi's leading `\n` was stripped)
	assert.equal(raw[2]!.includes("File not found"), true, `the body hugs the title directly below: ${JSON.stringify(raw)}`);
	for (const [index, line] of raw.entries()) {
		if (index === 0) continue;
		assert.notEqual(line.trim(), "", `the block must contain no blank row (row ${index}): ${JSON.stringify(raw)}`);
	}
	// a successful collapsed read has **no** result body (pi's behavior — this extension stays out): the whole block is the title row alone
	const ok = renderBlock({ path: "/tmp/x.js" }, { content: "a\nb\n" }).map(plain);
	assert.equal(ok.length, 2, `success + collapsed should be exactly pi's blank + the title row: ${JSON.stringify(ok)}`);
});

test("control: other tools keep their background / border rows (only read changed)", { skip }, () => {
	// this extension only registers `read`; other tools go through pi's default shell (`Box(1, 1)` + bgFn).
	// no toolDefinition → that generic path.
	assert.ok(pi && cached);
	const other = new pi.ToolExecutionComponent(
		"grep",
		"call-other",
		{ pattern: "x" },
		{},
		undefined,
		{ requestRender() {} },
		cached.projectDir,
	);
	other.updateResult({ content: [{ type: "text", text: "some output" }], details: {} }, false);
	const lines = other.render(79);
	assert.equal(lines.some((line) => /\u001b\[(?:4[0-7]|10[0-7]|48[;:])/.test(line)), true, "other tools must still have a background");
	assert.equal(plain(lines[0]!).trim(), "", "other tools must still have a top border row");
});

test("long path: compresses to one row (`…` prefix), dot and indent unchanged", { skip }, () => {
	const raw = renderBlock({ path: LONG_PATH }, { content: "x\n" }).map(plain);
	const title = raw[1]!;
	assert.equal(title.startsWith(`${BAR} Read `), true, `after compression still starts with \`• Read \`: ${JSON.stringify(title)}`);
	assert.equal(title.includes("…"), true, `an overlong path should carry …: ${JSON.stringify(title)}`);
	assert.equal(title.trimEnd().split("\n").length, 1, "still a single row");
	// the compressed row stays within width (pi-tui clips over-wide rows)
	assert.ok(widthOf(raw[1]!) <= 79, `must not exceed the width after compression (${widthOf(raw[1]!)} > 79)`);
});

test("every row's visible width stays within the terminal", { skip }, () => {
	const cases: Array<{ args: unknown; options: RenderOptions }> = [
		{ args: { path: "/tmp/x.js" }, options: { content: "a\nb\nc\n" } },
		{ args: { path: LONG_PATH }, options: { content: "a\nb\n" } },
		{ args: { path: LONG_PATH, offset: 10, limit: 20 }, options: { content: "a\n" } },
		{ args: { path: "/tmp/" + "y".repeat(120) }, options: { content: "a\n" } },
		{ args: { path: "/tmp/你好世界/" + "深".repeat(60) + ".js" }, options: { content: "a\n" } },
		{ args: { path: "/tmp/x.js" }, options: { content: "x".repeat(300) + "\n" } },
	];
	for (const width of [120, 79, 60, 40, 30, 25]) {
		for (const { args, options } of cases) {
			for (const line of renderBlock(args, { ...options, width })) {
				assert.ok(
					widthOf(line) <= width,
					`width ${width} over-wide: ${JSON.stringify(plain(line))} (${JSON.stringify(args)})`,
				);
			}
		}
	}
});

test("the compact shape (`[skill]`) and the line-range form keep the dot and indent", { skip }, () => {
	// the compact shape's title is pi's own drawing (this extension only compresses it when over-wide); the left margin is still ours
	const skill = renderBlock({ path: join(os.homedir(), ".pi/agent/skills/commit/SKILL.md") }, { content: "x\n" }).map(plain);
	assert.equal(skill[1]!.startsWith(`${BAR} `), true, `the [skill] shape must carry a dot too: ${JSON.stringify(skill)}`);
	assert.equal(skill[1]!.includes("[skill]"), true, `should take the compact shape: ${JSON.stringify(skill)}`);

	// the line range (`offset` / `limit`) follows the path — dot and columns unchanged
	const ranged = renderBlock({ path: "/tmp/x.js", offset: 10, limit: 20 }, { content: "a\n" }).map(plain);
	const title = ranged[1]!;
	assert.equal(title.startsWith(`${BAR} Read `), true, `the line-range form: ${JSON.stringify(title)}`);
	assert.equal(title.includes(":10-29"), true, `the line range should be there: ${JSON.stringify(title)}`);
	assert.equal(title.indexOf("Read"), 2, "`Read` still at column 2");
});

test("a resource file outside cwd: the compressed label is a path, not a `.`", { skip }, () => {
	// regression: `cwdRelativePath` once copied pi's `resolvePath(input, baseDir)` as node's
	// `resolve(base, target)` — an absolute input makes node return base outright, dropping the file,
	// `relative(cwd, cwd)` = "" then judged "inside cwd" and the label degenerated to `"."`.
	// the symptom: reading `~/.pi/agent/AGENTS.md` showed `Read resource .:67-80` on a narrow terminal.
	// files inside cwd happen to be correct — only a path outside cwd exposes the trap.
	const outside = join(os.homedir(), ".pi/agent/AGENTS.md");
	assert.notEqual(path.dirname(outside), cached!.projectDir, "the fixture must sit outside cwd or the trap is untestable");
	for (const width of [79, 66, 60, 40]) {
		const title = body(text({ path: outside, offset: 67, limit: 14 }, { content: "x\n", width })[1]!);
		assert.equal(/\s\.(:|\s|$)/.test(title), false, `the label must not degenerate to \`.\` (width=${width}): ${JSON.stringify(title)}`);
		assert.equal(title.includes("AGENTS.md"), true, `the filename should be in the title (width=${width}): ${JSON.stringify(title)}`);
		assert.equal(title.includes(":67-80"), true, `the line range should be there (width=${width}): ${JSON.stringify(title)}`);
		assert.ok(widthOf(title) <= width, `over-wide (width=${width}): ${JSON.stringify(title)}`);
	}

	// resource files inside cwd still take the relative label (the fix must not break them)
	const inside = join(cached!.projectDir, "CLAUDE.md");
	fs.writeFileSync(inside, "# hi\n");
	for (const raw of ["CLAUDE.md", inside]) {
		const title = body(text({ path: raw }, { content: "x\n", width: 60 })[1]!);
		assert.equal(title.includes("CLAUDE.md"), true, `inside cwd the label should be relative: ${JSON.stringify(title)}`);
		assert.equal(title.includes(cached!.projectDir), false, `no absolute prefix inside cwd: ${JSON.stringify(title)}`);
	}
});

test("expanded (ctrl+o): the result is not clipped, dot and indent unchanged", { skip }, () => {
	const raw = renderBlock({ path: "/tmp/x.js" }, { content: "1\n2\n3\n4\n5\n6\n7\n8\n", expanded: true }).map(plain);
	assert.equal(raw[1]!.startsWith(`${BAR} Read `), true, `expanded must carry a dot too: ${JSON.stringify(raw)}`);
	for (const line of ["1", "2", "8"]) {
		assert.equal(raw.some((l) => l.trimEnd() === `  ${line}`), true, `expanded should print verbatim ${line} (two-space indent): ${JSON.stringify(raw)}`);
	}
	assert.equal(raw.some((line) => line.includes("more lines")), false, `expanded must show no truncation hint: ${JSON.stringify(raw)}`);
});
