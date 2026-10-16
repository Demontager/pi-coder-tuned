/**
 * Tests for index.ts — destructive-guard's wiring (loaded for real by pi's own loader).
 *
 * Run with:  node --test clients/pi/extensions/destructive-guard/index.test.ts
 *
 * What is covered is **the wiring**, not the judgment logic (targets.test.ts /
 * writes.test.ts cover that). So assertions concentrate on: pi's loader really loads this
 * extension, dangerous calls really get blocked, harmless calls really pass, non-interactive
 * environments fail closed, and each of `PI_DESTRUCTIVE_GUARD`'s four modes takes effect.
 *
 * No local pi library entry → skip wholesale (never fake a pass) — same as
 * plan-mode/index.test.ts.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderFindingsForHuman, truncateMiddle, writeTargetLabel } from "./index.ts";
import { extractGitHistoryLoss, inspectBash } from "./targets.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "could not find the local pi library entry (requires an installed pi)";

/** pi's library entry (not the CLI). The check is whether it really imports, not whether the path exists. */
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
const skip = piEntry === undefined ? SKIP : false;

/** The hook's return value. */
interface Verdict {
	block?: boolean;
	reason?: string;
}

interface Harness {
	call: (toolName: string, input: Record<string, unknown>) => Promise<Verdict>;
	notifies: string[];
	selects: string[];
	/** The cwd the hook saw (the temp projectDir). "Inside the workdir" assertions must use it, not process.cwd(). */
	cwd: string;
	cleanup: () => void;
}

/**
 * Really load the extension via pi's loader and return a runner that feeds tool_call in.
 *
 * Note `session_start` is fired once before `call` — the extension reads the mode once at
 * factory time and again at `session_start`, so mode-switch tests must go through this path
 * (change the env, open a new harness).
 */
async function loadHarness(options: { hasUI?: boolean; selectAnswer?: string } = {}): Promise<Harness> {
	const { hasUI = true, selectAnswer = "Cancel" } = options;
	const pi = (await import(pathToFileURL(piEntry!).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dg-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });

	const bus = { on: () => () => undefined, emit: () => undefined };
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, bus);
	assert.deepEqual(loaded.errors, [], "pi's extension loader must not error");
	const extension = loaded.extensions[0];
	assert.ok(extension, "exactly one extension should load");

	const notifies: string[] = [];
	const selects: string[] = [];
	const ctx = {
		mode: "tui",
		hasUI,
		cwd: projectDir,
		ui: {
			notify: (text: string) => notifies.push(text),
			select: async (prompt: string) => {
				selects.push(prompt);
				return selectAnswer;
			},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};

	// session_start must run too: the extension re-reads the mode there.
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, ctx);
	}

	return {
		notifies,
		selects,
		cwd: projectDir,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
		async call(toolName: string, input: Record<string, unknown>): Promise<Verdict> {
			for (const handler of extension.handlers.get("tool_call") ?? []) {
				const verdict = (await handler({ toolName, input }, ctx)) as Verdict | undefined;
				if (verdict?.block) return verdict;
			}
			return {};
		},
	};
}

interface LoadedExtension {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>;
}

/** Clear the mode variable before/after each test to avoid cross-contamination. */
function withMode<T>(mode: string | undefined, run: () => Promise<T>): Promise<T> {
	const prior = process.env.PI_DESTRUCTIVE_GUARD;
	if (mode === undefined) delete process.env.PI_DESTRUCTIVE_GUARD;
	else process.env.PI_DESTRUCTIVE_GUARD = mode;
	return run().finally(() => {
		if (prior === undefined) delete process.env.PI_DESTRUCTIVE_GUARD;
		else process.env.PI_DESTRUCTIVE_GUARD = prior;
	});
}

test("dangerous delete commands are blocked", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const verdict = await guard.call("bash", { command: "rm -rf /" });
		assert.equal(verdict.block, true, "rm -rf / must be blocked");
		assert.match(verdict.reason ?? "", /destructive-guard/);
	} finally {
		guard.cleanup();
	}
});

test("an ancestor of a protected dir is blocked", { skip }, async () => {
	const guard = await loadHarness();
	try {
		assert.equal((await guard.call("bash", { command: "rm -rf /Users" })).block, true);
		assert.equal((await guard.call("bash", { command: "rm -rf /usr" })).block, true);
		assert.equal((await guard.call("bash", { command: "rm -rf /etc" })).block, true);
	} finally {
		guard.cleanup();
	}
});

test("the incident shape (dirname + fallback value) is blocked", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const verdict = await guard.call("bash", { command: "rm -rf $(dirname /tmp)" });
		assert.equal(verdict.block, true, "a computed target must be blocked");
	} finally {
		guard.cleanup();
	}
});

test("a normal delete inside the workdir passes", { skip }, async () => {
	const guard = await loadHarness();
	try {
		// use the cwd the hook saw (the temp projectDir), not process.cwd() (the repo) —
		// the latter is outside the workdir and would (correctly) hit outside-workdir.
		assert.deepEqual(await guard.call("bash", { command: `rm -rf ${guard.cwd}/dist` }), {});
		assert.deepEqual(await guard.call("bash", { command: "rm -f /tmp/scratch.log" }), {});
		assert.deepEqual(await guard.call("bash", { command: "ls -la /usr" }), {});
		assert.deepEqual(await guard.call("bash", { command: "git status" }), {});
	} finally {
		guard.cleanup();
	}
});

test("writing dangerous delete code is blocked", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const verdict = await guard.call("write", {
			path: "verify.mjs",
			content: 'fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true });',
		});
		assert.equal(verdict.block, true, "the incident's own line must be blocked");
	} finally {
		guard.cleanup();
	}
});

test("writing normal delete code passes", { skip }, async () => {
	const guard = await loadHarness();
	try {
		assert.deepEqual(await guard.call("write", { path: "clean.mjs", content: 'fs.rmSync("/tmp/va-1", { recursive: true });' }), {});
		assert.deepEqual(await guard.call("write", { path: "read.mjs", content: "const text = fs.readFileSync(p, 'utf8');" }), {});
	} finally {
		guard.cleanup();
	}
});

test("edit's new text is checked too", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const verdict = await guard.call("edit", { path: "a.mjs", oldText: "x", newText: "shutil.rmtree(os.path.dirname(p))" });
		assert.equal(verdict.block, true);
	} finally {
		guard.cleanup();
	}
});

test("non-interactive fails closed (even confirm refuses)", { skip }, async () => {
	const guard = await loadHarness({ hasUI: false });
	try {
		// this one sits in the confirm tier; with no UI available it must not default to allow.
		const verdict = await guard.call("bash", { command: "rm -rf $UNSET/*" });
		assert.equal(verdict.block, true, "must refuse when non-interactive");
	} finally {
		guard.cleanup();
	}
});

test("with UI, the confirm tier asks once; answering \"cancel\" blocks", { skip }, async () => {
	const guard = await loadHarness({ hasUI: true, selectAnswer: "Cancel" });
	try {
		const verdict = await guard.call("bash", { command: "rm -rf $UNSET/*" });
		assert.equal(guard.selects.length, 1, "one confirmation should have been shown");
		assert.equal(verdict.block, true, "choosing cancel must block");
	} finally {
		guard.cleanup();
	}
});

test("with UI, answering \"confirm delete\" lets it through", { skip }, async () => {
	const guard = await loadHarness({ hasUI: true, selectAnswer: "Confirm deletion" });
	try {
		const verdict = await guard.call("bash", { command: "rm -rf $UNSET/*" });
		assert.equal(guard.selects.length, 1);
		assert.equal(verdict.block, undefined, "should pass after the user confirms");
	} finally {
		guard.cleanup();
	}
});

test("with UI, answering \"preview what would be deleted first\" blocks and asks the model to list targets", { skip }, async () => {
	const guard = await loadHarness({ hasUI: true, selectAnswer: "Preview deletion targets" });
	try {
		const verdict = await guard.call("bash", { command: "rm -rf $UNSET/*" });
		assert.equal(verdict.block, true, "a preview is also a block (not direct execution)");
		assert.match(verdict.reason ?? "", /Use read-only commands/, "the reason must tell the model to list targets first");
	} finally {
		guard.cleanup();
	}
});

test("\"cancel\" is the default (first) option in the dialog", { skip }, async () => {
	const guard = await loadHarness({ hasUI: true, selectAnswer: "Cancel" });
	try {
		await guard.call("bash", { command: "rm -rf $UNSET/*" });
		assert.equal(guard.selects.length, 1);
		// the dialog body must contain "what gets deleted" and "why it was blocked", not only the raw command.
		assert.match(guard.selects[0]!, /Delete target: /);
		assert.match(guard.selects[0]!, /Why blocked: /);
		assert.match(guard.selects[0]!, /deletes nothing/);
	} finally {
		guard.cleanup();
	}
});

test("the block tier shows no dialog and refuses outright", { skip }, async () => {
	await withMode("block", async () => {
		const guard = await loadHarness({ hasUI: true });
		try {
			const verdict = await guard.call("bash", { command: "rm -rf $UNSET/*" });
			assert.equal(verdict.block, true);
			assert.equal(guard.selects.length, 0, "the block tier must not show a dialog");
		} finally {
			guard.cleanup();
		}
	});
});

test("the notify tier only notifies, never blocks", { skip }, async () => {
	await withMode("notify", async () => {
		const guard = await loadHarness({ hasUI: true });
		try {
			const verdict = await guard.call("bash", { command: "rm -rf /" });
			assert.equal(verdict.block, undefined, "the notify tier must not block");
			assert.equal(guard.notifies.length, 1, "one notification should fire");
		} finally {
			guard.cleanup();
		}
	});
});

test("the off tier does nothing at all", { skip }, async () => {
	await withMode("off", async () => {
		const guard = await loadHarness({ hasUI: true });
		try {
			assert.deepEqual(await guard.call("bash", { command: "rm -rf /" }), {});
			assert.equal(guard.notifies.length, 0);
			assert.equal(guard.selects.length, 0);
		} finally {
			guard.cleanup();
		}
	});
});

test("non-delete tools are not checked", { skip }, async () => {
	const guard = await loadHarness();
	try {
		assert.deepEqual(await guard.call("read", { path: "/etc/hosts" }), {});
		assert.deepEqual(await guard.call("task_set", { tasks: ["a"] }), {});
	} finally {
		guard.cleanup();
	}
});

// ---- dialog text (does not need the pi loader — pure functions tested directly) ----

const CWD = "/Users/bachi/jaylli/litellm-any";
const HOME = "/Users/bachi";

test("dialog body: a command-substitution target no longer renders as fragments", () => {
	const findings = inspectBash('rm -rf $(dirname "$LOG")', CWD, HOME);
	assert.equal(findings.length, 1, "exactly one target should be hit, not three fragments");
	const text = renderFindingsForHuman(findings, 'rm -rf $(dirname "$LOG")');
	assert.ok(text.includes('Delete target: $(dirname "$LOG")'), "the target should display whole");
	// before the fix these two fragments each became a target line of their own.
	assert.ok(!text.includes("Delete target: $(dirname\n"), "$(dirname must not be treated as a separate target");
	assert.ok(!text.includes('Delete target: "$LOG")'), "\"$LOG\") must not be treated as a separate target");
});

test("dialog body: a resolvable target shows the actual path", () => {
	const findings = inspectBash("rm -rf /usr/local/lib/foo", CWD, HOME);
	const text = renderFindingsForHuman(findings, "rm -rf /usr/local/lib/foo");
	assert.ok(text.includes("Delete target: /usr/local/lib/foo"));
	assert.ok(text.includes("Why blocked"));
});

test("dialog body: a single-segment command does not repeat \"containing command\"; only chained commands do", () => {
	const single = inspectBash("rm -rf /usr/local/lib/foo", CWD, HOME);
	assert.ok(!renderFindingsForHuman(single, "rm -rf /usr/local/lib/foo").includes("Command:"));

	const chained = inspectBash('cd /tmp && rm -rf $(dirname "$X")', CWD, HOME);
	assert.ok(renderFindingsForHuman(chained, 'cd /tmp && rm -rf $(dirname "$X")').includes("Command:"));
});

test("dialog body: duplicate hits dedupe, over-limit items fold", () => {
	const findings = inspectBash("rm -rf $A $B $C $D $E", CWD, HOME);
	const text = renderFindingsForHuman(findings, "rm -rf $A $B $C $D $E", 3);
	assert.ok(text.includes("… plus 2 similar matches"));
	assert.ok(!text.includes("Delete target: $D"), "items over the limit must not be expanded");
});

test("dialog body: repeated hits on the same target are said once", () => {
	const findings = inspectBash("rm -rf $A; rm -rf $A", CWD, HOME);
	const text = renderFindingsForHuman(findings, "rm -rf $A; rm -rf $A");
	assert.equal(text.match(/Delete target: /g)?.length, 1);
});

test("truncateMiddle clips the middle, keeping head and tail", () => {
	assert.equal(truncateMiddle("short", 100), "short");
	const long = "a".repeat(200);
	const cut = truncateMiddle(long, 40);
	assert.ok(cut.length <= 40);
	assert.ok(cut.startsWith("aaaa") && cut.endsWith("aaaa") && cut.includes("…"));
});

test("writeTargetLabel pulls the filename out of the write params", () => {
	assert.equal(writeTargetLabel({ path: "verify.mjs" }), " verify.mjs");
	assert.equal(writeTargetLabel({ file_path: "/tmp/a.mjs" }), " /tmp/a.mjs");
	assert.equal(writeTargetLabel({ content: "x" }), "the file");
	assert.equal(writeTargetLabel(null), "the file");
});

// ---- gate three: read the file in and judge it before the script runs (the only interception point for the 2026-09-23 incident's shape) ----

test("gate three: the incident shape inside an about-to-run script → block", { skip }, async () => {
	const guard = await loadHarness({ hasUI: true, selectAnswer: "Cancel" });
	try {
		const script = path.join(guard.cwd, "verify-a.mjs");
		fs.writeFileSync(
			script,
			'import fs from "node:fs";\nimport path from "node:path";\nconst s = { log: [] };\nfs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true });\n',
		);
		const verdict = await guard.call("bash", { command: "node verify-a.mjs" });
		assert.equal(verdict.block, true, "a harmless command word with danger inside the file must be caught by gate three");
		assert.match(verdict.reason ?? "", /script|cancelled/);
	} finally {
		guard.cleanup();
	}
});

test("gate three: a clean script passes", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const script = path.join(guard.cwd, "clean.mjs");
		fs.writeFileSync(script, 'import fs from "node:fs";\nfs.rmSync("/tmp/va-1", { recursive: true });\n');
		assert.deepEqual(await guard.call("bash", { command: "node clean.mjs" }), {});
	} finally {
		guard.cleanup();
	}
});

test("gate three: an unreadable script is not blocked (guardrail, not sandbox)", { skip }, async () => {
	const guard = await loadHarness();
	try {
		assert.deepEqual(await guard.call("bash", { command: "node nope.mjs" }), {});
	} finally {
		guard.cleanup();
	}
});

test("gate three: script calls inside inline code are extracted too", { skip }, async () => {
	const guard = await loadHarness({ hasUI: true, selectAnswer: "Cancel" });
	try {
		const script = path.join(guard.cwd, "a.mjs");
		fs.writeFileSync(script, 'fs.rmSync(path.dirname(x ?? "/tmp"), { recursive: true });');
		const verdict = await guard.call("bash", { command: "sh -c 'node a.mjs'" });
		assert.equal(verdict.block, true, "a script nested inside sh -c must be read in and judged");
	} finally {
		guard.cleanup();
	}
});

// ---- patch ④: destructive git commands (destroying one-of-a-kind uncommitted work) ----

test("destructive git commands → confirm", () => {
	for (const command of [
		"git reset --hard HEAD",
		"git reset --hard",
		"git checkout -- .",
		"git checkout -- src/a.ts",
		"git restore .",
		"git stash drop",
		"git stash clear",
		"git branch -D feature-x",
	]) {
		const findings = extractGitHistoryLoss(command);
		assert.ok(findings.length > 0, `${command} should hit`);
		assert.equal(findings[0]!.verdict, "confirm", `${command} should be confirm`);
		assert.equal(findings[0]!.rule, "vcs-history-loss");
	}
});

test("safe git commands are not hurt", () => {
	for (const command of [
		"git status",
		"git checkout feature-x",
		"git checkout -b feature-x",
		"git reset --soft HEAD~1",
		"git reset --mixed HEAD~1",
		"git stash push -m wip",
		"git stash list",
		"git branch -d feature-x",
		"git clean -n",
	]) {
		assert.equal(extractGitHistoryLoss(command).length, 0, `${command} should not hit`);
	}
});

test("git reset --hard hits end-to-end via inspectBash", () => {
	const findings = inspectBash("git reset --hard HEAD", CWD, HOME);
	assert.ok(findings.some((finding) => finding.rule === "vcs-history-loss"));
});

// ---- patch ②: outside the working directory needs confirmation (end-to-end via inspectBash) ----

test("the incident's entire loss surface hits via inspectBash (outside-workdir or the stricter self-protection)", () => {
	for (const command of [
		"rm -rf ~/.pi/agent/sessions",
		"rm -f ~/.zshrc",
		"rm -f ~/.gitconfig",
		"rm -f ~/.zprofile",
		"rm -rf ~/.claude/sessions ~/.claude/shell-snapshots",
	]) {
		const findings = inspectBash(command, CWD, HOME);
		assert.ok(findings.length > 0, `${command} should hit`);
		// ~/.pi/agent/sessions hits the stricter self-protection (block) first; the rest hit outside-workdir.
		assert.ok(
			findings.some((finding) => finding.rule === "outside-workdir" || finding.rule === "self-protection"),
			`${command} should hit outside-workdir/self-protection; got: ${findings.map((finding) => finding.rule).join(",")}`,
		);
	}
});

test("the guard itself hits self-protection (block) via inspectBash", () => {
	for (const command of [
		"rm -rf ~/.pi/agent/extensions/destructive-guard",
		"rm -f ~/.pi/agent/AGENTS.md",
		`rm -rf ${CWD}/clients/pi/extensions/destructive-guard`,
	]) {
		const findings = inspectBash(command, CWD, HOME);
		assert.ok(findings.some((finding) => finding.rule === "self-protection" && finding.verdict === "block"), command);
	}
});
