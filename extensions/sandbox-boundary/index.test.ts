/**
 * Tests for sandbox-boundary/index.ts — really load the extension via pi's own loader,
 * feed real `tool_call` events in, and assert the pass / confirm / block outcomes.
 *
 * Run with:  node --test clients/pi/extensions/sandbox-boundary/index.test.ts
 *
 * The assertion rule (decided by the user 2026-09-24, narrowed to "deletion only" the same
 * day, then two authorization tiers and later a "never delete" tier were added):
 *   - **Writes are never blocked**: write / edit / multiedit pass outright inside or outside
 *     the boundary, no dialog;
 *   - apply_patch only looks at `*** Delete File:` lines:
 *     - a delete target inside the boundary (project dir, /tmp, regenerable caches like
 *       ~/.cache) → pass outright;
 *     - **never delete** (`~/.zshrc`, `~/.ssh/…`, `~/.gnupg/…`, nested entries like
 *       `~/.config/gh/…` `~/.config/gcloud/…` — identity/credential/handwritten config;
 *       `~/.config` `~/.pi` `~/.claude` `~/.codex` themselves moved to the ordinary tier on
 *       2026-09-25) → **no dialog, no allow option**, outright block; the whole patch is
 *       rejected together;
 *     - **dangerous paths** (system roots, `~/Library/…`, paths containing `.git`…) → asked
 *       every time, options are Deny / Allow once / Allow for this session (no "remember");
 *     - **ordinary out-of-boundary paths** (like `~/Downloads/x`) → asked once, options are
 *       Deny / Allow for this session (and remember the directory) / Allow once; remembered
 *       means persisted — no prompt next time;
 *     - `Update File` / `Add File` are writes and pass even outside the boundary;
 *   - read-only tools (read/grep) and tools with no recognizable delete target pass;
 *   - non-interactive: the persistent allowlist applies (hits pass), never-delete and
 *     unauthorized dangerous/ordinary all fail-closed into a block;
 *   - PI_SANDBOX=off disables the whole hook.
 *
 * Note the harness's projectDir sits under /tmp (mkdtempSync) — already inside the
 * deletable boundary, so "inside" cases use paths under projectDir and "outside" cases use
 * paths under $HOME.
 * The allowlist points at the harness's own temp file (`PI_SANDBOX_ALLOWLIST`) — the user's
 * real one is never touched; session exemptions are a globalThis singleton and must be
 * cleared around every case or residue pollutes the next judgment.
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
const HOME = os.homedir();

/**
 * Find pi's library entry: first back-trace the `pi` executable to the real install (pnpm/
 * npm shim scripts carry a `# cmd-shim-target=<abs path>` line; on Unix npm uses a symlink —
 * both are tried), then fall back to the `~/.pi/agent/npm` copy — the check is whether it
 * really imports. All failing → undefined → skip wholesale.
 * (Same logic as bash-command-collapse/render.test.ts.)
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

const piEntry = await findPiLibraryEntry();
const skip = process.platform !== "darwin" ? "macOS-only deletion boundary (disabled on this platform)" : piEntry === undefined ? SKIP : false;

interface Verdict {
	block?: boolean;
	reason?: string;
}

interface Harness {
	cwd: string;
	/** The selects shown (the main dialog of the two authorization tiers). */
	selects: Array<{ title: string; options: string[] }>;
	confirms: Array<{ title: string; message: string }>;
	notifies: string[];
	/** This harness's allowlist file path. */
	allowlistFile: string;
	cleanup: () => void;
	/** Feed a tool_call event; returns the interception result ({} = pass). */
	call(toolName: string, input: Record<string, unknown>): Promise<Verdict>;
	/** Run the /sandbox-boundary command (with optional subcommand args). */
	runCommand(args?: string): Promise<void>;
}

/**
 * Really load the extension via pi's loader. `selections` replays the user's select choices
 * in order; `confirmAnswer` served the old confirm branch (no longer used — kept as a
 * regression guard).
 */
async function loadHarness(
	options: { hasUI?: boolean; selections?: string[]; confirmAnswer?: boolean; seedAllowlist?: string[] } = {},
): Promise<Harness> {
	const { hasUI = true, selections = [], confirmAnswer = true, seedAllowlist } = options;
	const pi = (await import(pathToFileURL(piEntry!).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-boundary-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	const allowlistFile = path.join(root, "sandbox-allowlist.json");
	if (seedAllowlist) {
		fs.writeFileSync(
			allowlistFile,
			JSON.stringify({
				version: 1,
				entries: seedAllowlist.map((p) => ({ path: p, addedAt: new Date().toISOString(), source: "confirm" })),
			}),
			"utf8",
		);
	}

	// the allowlist points at its own temp file; session exemptions (a globalThis singleton) are cleared.
	const prevAllowlist = process.env.PI_SANDBOX_ALLOWLIST;
	process.env.PI_SANDBOX_ALLOWLIST = allowlistFile;
	const { getSessionScopes, resetAllowlistStoreCache } = await import("../bash-command-collapse/allowlist.ts");
	resetAllowlistStoreCache();
	getSessionScopes().clear();

	const bus = { on: () => () => undefined, emit: () => undefined };
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, bus);
	if (prevAllowlist === undefined) delete process.env.PI_SANDBOX_ALLOWLIST;
	else process.env.PI_SANDBOX_ALLOWLIST = prevAllowlist;
	assert.deepEqual(loaded.errors, [], "pi's extension loader must not error");
	const extension = loaded.extensions[0];
	assert.ok(extension, "exactly one extension should load");

	const selects: Array<{ title: string; options: string[] }> = [];
	const confirms: Array<{ title: string; message: string }> = [];
	const notifies: string[] = [];
	const queue = [...selections];
	const ctx = {
		mode: "tui",
		hasUI,
		cwd: projectDir,
		ui: {
			notify: (text: string) => notifies.push(text),
			select: async (title: string, options: string[]) => {
				selects.push({ title, options });
				return queue.shift();
			},
			confirm: async (title: string, message: string) => {
				confirms.push({ title, message });
				return confirmAnswer;
			},
		},
	};

	return {
		cwd: projectDir,
		selects,
		confirms,
		notifies,
		allowlistFile,
		cleanup: () => {
			getSessionScopes().clear();
			resetAllowlistStoreCache();
			fs.rmSync(root, { recursive: true, force: true });
		},
		async call(toolName: string, input: Record<string, unknown>): Promise<Verdict> {
			for (const handler of extension.handlers.get("tool_call") ?? []) {
				const verdict = (await handler({ toolName, input }, ctx)) as Verdict | undefined;
				if (verdict?.block) return verdict;
			}
			return {};
		},
		async runCommand(args = ""): Promise<void> {
			const command = extension.commands.get("sandbox-boundary");
			assert.ok(command, "the /sandbox-boundary command should be registered");
			await command.handler(args, ctx);
		},
	};
}

interface LoadedExtension {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
}

test("writes always pass: a write outside the boundary shows no dialog", { skip }, async () => {
	const h = await loadHarness();
	try {
		const verdict = await h.call("write", { path: `${HOME}/.zshrc`, content: "x" });
		assert.deepEqual(verdict, {}, "writes are not blocked, even outside the boundary");
		assert.equal(h.confirms.length, 0, "writes must never prompt");
	} finally {
		h.cleanup();
	}
});

test("writes always pass: edit / multiedit outside the boundary show no dialog", { skip }, async () => {
	const h = await loadHarness();
	try {
		assert.deepEqual(await h.call("edit", { path: `${HOME}/.gitconfig`, oldText: "a", newText: "b" }), {});
		assert.deepEqual(await h.call("multiedit", { path: `${HOME}/.config/foo`, edits: [] }), {});
		assert.equal(h.confirms.length, 0);
	} finally {
		h.cleanup();
	}
});

test("apply_patch: in-boundary deletes pass outright, no dialog", { skip }, async () => {
	const h = await loadHarness();
	try {
		const patch = `*** Delete File: ${path.join(h.cwd, "old.ts")}\n`;
		const verdict = await h.call("apply_patch", { patch });
		assert.deepEqual(verdict, {}, "in-boundary deletes must not be blocked");
		assert.equal(h.selects.length, 0, "in-boundary must never prompt");
		assert.equal(h.confirms.length, 0);
		assert.equal(h.notifies.length, 0, "in-boundary must not notify either (that is most operations)");
	} finally {
		h.cleanup();
	}
});

test("apply_patch: a dangerous path (~/Library) shows the dangerous dialog with no \"remember\" option; approving lets it through", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow once"] });
	try {
		const patch = `*** Delete File: ${HOME}/Library/Preferences/sbx-probe.plist\n`;
		const verdict = await h.call("apply_patch", { patch });
		assert.deepEqual(verdict, {}, "should pass after approval");
		assert.equal(h.selects.length, 1, "one dialog should be shown");
		assert.match(h.selects[0].title, /high-risk directories/, "~/Library is the dangerous tier (always asked, session-exemptible)");
		assert.deepEqual(h.selects[0].options, ["Deny", "Allow once", "Allow for this session"], "dangerous dirs have no \"remember\" option");
		assert.ok(h.selects[0].title.includes("outside the boundary"));
		assert.equal(fs.existsSync(h.allowlistFile), false, "dangerous paths are never persisted");
	} finally {
		h.cleanup();
	}
});

test("apply_patch: a never-delete path (~/.zshrc) shows no dialog and no allow option — outright block", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow once", "Allow for this session"] });
	try {
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.zshrc\n` });
		assert.equal(verdict.block, true, "never delete: no deleting");
		assert.match(verdict.reason ?? "", /protected/, "the reason must name the tier");
		assert.equal(h.selects.length, 0, "no dialog — there is no allow option to give");
		assert.equal(h.confirms.length, 0);
		assert.equal(fs.existsSync(h.allowlistFile), false, "nothing is persisted");
	} finally {
		h.cleanup();
	}
});

test("apply_patch: never-delete subtrees (~/.ssh, ~/.gnupg) block the same way; same-named project files are unaffected", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow once"] });
	try {
		const v1 = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.ssh/id_rsa\n` });
		assert.equal(v1.block, true, "the credential subtree is blocked");
		const v2 = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.gnupg/x\n` });
		assert.equal(v2.block, true, "the credential subtree is blocked");
		assert.equal(h.selects.length, 0, "neither time shows a dialog");
		// the nested entries added 2026-09-25: all of ~/.config is ordinary tier, but .config/gh is pulled back to never-delete
		const v3 = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.config/gh/hosts.yml\n` });
		assert.equal(v3.block, true, "a nested never-delete subtree is blocked");
		assert.equal(h.selects.length, 0, "nested entries show no dialog either");
	} finally {
		h.cleanup();
	}
});

test("apply_patch: a never-delete path mixed with ordinary paths — the whole patch is rejected together", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow for this session (and remember the directory)"] });
	try {
		const patch = `*** Delete File: ${HOME}/Downloads/ok.txt\n*** Delete File: ${HOME}/.zshrc\n`;
		const verdict = await h.call("apply_patch", { patch });
		assert.equal(verdict.block, true, "one never-delete path mixed in rejects the whole patch");
		assert.match(verdict.reason ?? "", /protected/);
		assert.equal(h.selects.length, 0, "no chance to \"approve the rest\"");
		assert.equal(fs.existsSync(h.allowlistFile), false, "nothing persisted either");
	} finally {
		h.cleanup();
	}
});

test("apply_patch: a dangerous path asks every time; \"Allow for this session\" silences it for the session, a restart (reload) asks again", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow for this session", "Deny"] });
	try {
		const patch = `*** Delete File: ${HOME}/Library/sbx-probe/foo\n`;
		assert.deepEqual(await h.call("apply_patch", { patch }), {}, "passes after the first approval");
		assert.deepEqual(await h.call("apply_patch", { patch }), {}, "passes without a dialog after the session exemption");
		assert.equal(h.selects.length, 1, "must not prompt a second time");
		assert.equal(fs.existsSync(h.allowlistFile), false, "session exemptions are not persisted");
		// a session exemption was already notified (a covered hit) — no deep assert on content, only on restart semantics:
		// cleanup clears the session set, simulating a restart; reloading the extension prompts on dangerous paths again.
	} finally {
		h.cleanup();
	}
	const h2 = await loadHarness({ selections: ["Deny"] });
	try {
		const verdict = await h2.call("apply_patch", { patch: `*** Delete File: ${HOME}/Library/sbx-probe/foo\n` });
		assert.equal(verdict.block, true, "dangerous paths ask again after a restart; Deny blocks");
		assert.equal(h2.selects.length, 1, "a dialog again");
	} finally {
		h2.cleanup();
	}
});

test("apply_patch: an ordinary out-of-boundary path (~/Downloads) shows the ordinary dialog; `Allow for this session (and remember the directory)` then", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow for this session (and remember the directory)"] });
	const target = `${HOME}/Downloads/sbx-probe-file.txt`;
	try {
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${target}\n` });
		assert.deepEqual(verdict, {}, "should pass after approval");
		assert.equal(h.selects.length, 1);
		assert.deepEqual(h.selects[0].options, ["Deny", "Allow for this session (and remember the directory)", "Allow once"], "the ordinary dir's three options");
		assert.ok(h.selects[0].title.includes("outside the boundary") && !h.selects[0].title.includes("high-risk"), "the ordinary dialog is not the dangerous one");
		// persisted: what is remembered is the parent dir ~/Downloads, not the file
		const onDisk = JSON.parse(fs.readFileSync(h.allowlistFile, "utf8"));
		assert.deepEqual(onDisk.entries.map((e: { path: string }) => e.path), [`${HOME}/Downloads`]);
		// second time: another file in the same dir — allowlist hit, no dialog, one notify line
		const verdict2 = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Downloads/sbx-probe-2.txt\n` });
		assert.deepEqual(verdict2, {});
		assert.equal(h.selects.length, 1, "a remembered directory prompts no more");
		assert.ok(h.notifies.some((n) => n.includes("allowlist")), "an allowlist-hit pass must notify (not go silently)");
	} finally {
		h.cleanup();
	}
});

test("apply_patch: tool-state dirs (~/.pi, ~/.config, ~/.claude, ~/.codex) are the ordinary tier — dialog can remember (user", { skip }, async () => {
	const h = await loadHarness({
		selections: [
			"Allow for this session (and remember the directory)",
			"Allow for this session (and remember the directory)",
			"Allow for this session (and remember the directory)",
			"Allow for this session (and remember the directory)",
		],
	});
	try {
		// probe names use nonexistent files (the apply_patch hook ignores existence) — otherwise memoryScopeFor would
		// treat a really-existing dir (like this machine's ~/.pi/agent/trust.json.lock) as the target itself.
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.pi/agent/sbx-probe-lock.txt\n` });
		assert.deepEqual(verdict, {}, "should pass after approval (no longer never-delete's outright refusal)");
		assert.equal(h.selects.length, 1, "one dialog should be shown");
		assert.deepEqual(h.selects[0].options, ["Deny", "Allow for this session (and remember the directory)", "Allow once"], "the ordinary dir's three options");
		assert.ok(!h.selects[0].title.includes("high-risk"), "not the dangerous dialog");
		const onDisk = JSON.parse(fs.readFileSync(h.allowlistFile, "utf8"));
		assert.deepEqual(onDisk.entries.map((e: { path: string }) => e.path), [`${HOME}/.pi/agent`], "remembers the parent dir");

		// the other three take the ordinary tier too (unauthorized → dialog)
		for (const p of [`${HOME}/.config/sbx-probe.txt`, `${HOME}/.claude/sbx-probe.txt`, `${HOME}/.codex/sbx-probe.txt`]) {
			const v = await h.call("apply_patch", { patch: `*** Delete File: ${p}\n` });
			assert.deepEqual(v, {}, `${p} passes after approval`);
		}
		assert.equal(h.selects.length, 4, "each of the three unremembered dirs prompts once");
	} finally {
		h.cleanup();
	}
});

test("apply_patch: `Allow once` on an ordinary path persists nothing; a second file in the same dir still prompts", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow once", "Deny"] });
	try {
		assert.deepEqual(await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Downloads/a.txt\n` }), {});
		assert.equal(fs.existsSync(h.allowlistFile), false, "`Allow once` persists nothing");
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Downloads/b.txt\n` });
		assert.equal(verdict.block, true, "not remembered → the second file asks again, and Deny blocks");
		assert.equal(h.selects.length, 2);
	} finally {
		h.cleanup();
	}
});

test("apply_patch: denying (Deny) blocks, and nothing is persisted", { skip }, async () => {
	const h = await loadHarness({ selections: ["Deny"] });
	try {
		const patch = `*** Delete File: ${HOME}/Library/Preferences/sbx-deny.plist\n`;
		const verdict = await h.call("apply_patch", { patch });
		assert.equal(verdict.block, true, "should block after the denial");
		assert.match(verdict.reason ?? "", /denied deletion/);
		assert.equal(fs.existsSync(h.allowlistFile), false);
	} finally {
		h.cleanup();
	}
});

test("apply_patch: Update / Add File are writes and pass even outside the boundary", { skip }, async () => {
	const h = await loadHarness({ selections: ["Deny"] });
	try {
		const patch = `*** Update File: ${HOME}/.pi/agent/settings.json\n*** Add File: ${HOME}/new-file.txt\n`;
		const verdict = await h.call("apply_patch", { patch });
		assert.deepEqual(verdict, {}, "no Delete File → must not block");
		assert.equal(h.selects.length, 0, "writes must not prompt");
		assert.equal(h.confirms.length, 0);
	} finally {
		h.cleanup();
	}
});

test("apply_patch: `Allow once` on the same dangerous path still asks again (goes into no memory)", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow once", "Allow once"] });
	try {
		await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Library/Foo/bar\n` });
		await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Library/Foo/bar\n` });
		assert.equal(h.selects.length, 2, "dangerous paths ask every time; `Allow once` does not exempt");
	} finally {
		h.cleanup();
	}
});

test("apply_patch: non-interactive fails closed — an unauthorized out-of-boundary delete blocks outright, no dialog", { skip }, async () => {
	const h = await loadHarness({ hasUI: false });
	try {
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Library/Preferences/sbx-headless.plist\n` });
		assert.equal(verdict.block, true, "non-interactive should block outright");
		assert.match(verdict.reason ?? "", /non-interactive/);
		assert.equal(h.selects.length, 0, "non-interactive must not show a dialog");
		assert.equal(h.confirms.length, 0);
	} finally {
		h.cleanup();
	}
});

test("apply_patch: non-interactive + a preset allowlist → pass (the authorization was given interactively)", { skip }, async () => {
	const h = await loadHarness({ hasUI: false, seedAllowlist: [`${HOME}/Downloads`] });
	try {
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Downloads/old.zip\n` });
		assert.deepEqual(verdict, {}, "the allowlist must apply under headless");
		assert.equal(h.selects.length, 0, "there is no dialog to show non-interactively anyway");
	} finally {
		h.cleanup();
	}
});

test("apply_patch: non-interactive + a preset allowlist still blocks dangerous paths", { skip }, async () => {
	const h = await loadHarness({ hasUI: false, seedAllowlist: [`${HOME}/Downloads`] });
	try {
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Library/Preferences/sbx-headless2.plist\n` });
		assert.equal(verdict.block, true, "not in the allowlist → still fail-closed");
		assert.match(verdict.reason ?? "", /non-interactive/);
		assert.match(verdict.reason ?? "", /Persistent allowlist: 1 entries/, "the reason must tell the model the current allowlist size");
	} finally {
		h.cleanup();
	}
});

test("apply_patch: non-interactive blocks never-delete paths too (the reason names the tier)", { skip }, async () => {
	const h = await loadHarness({ hasUI: false });
	try {
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.zshrc\n` });
		assert.equal(verdict.block, true, "never-delete still blocks under headless");
		assert.match(verdict.reason ?? "", /protected/);
		assert.equal(h.selects.length, 0);
	} finally {
		h.cleanup();
	}
});

test("read-only tools and tools with no delete target all pass", { skip }, async () => {
	const h = await loadHarness();
	try {
		assert.deepEqual(await h.call("read", { path: `${HOME}/.zshrc` }), {}, "read is read-only");
		assert.deepEqual(await h.call("grep", { pattern: "x" }), {}, "grep has no path");
		assert.deepEqual(await h.call("bash", { command: "rm -rf /" }), {}, "bash belongs to the sandbox, not here");
		assert.deepEqual(await h.call("apply_patch", { patch: "*** Update File: x.ts\n" }), {}, "no Delete lines");
		assert.equal(h.selects.length, 0);
		assert.equal(h.confirms.length, 0);
	} finally {
		h.cleanup();
	}
});

test("PI_SANDBOX=off disables the whole hook", { skip }, async () => {
	const prior = process.env.PI_SANDBOX;
	process.env.PI_SANDBOX = "off";
	let h: Harness | undefined;
	try {
		h = await loadHarness();
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.zshrc\n` });
		assert.deepEqual(verdict, {}, "off must not block");
		assert.equal(h.selects.length, 0, "off must not prompt");
		assert.equal(h.confirms.length, 0);
	} finally {
		if (prior === undefined) delete process.env.PI_SANDBOX;
		else process.env.PI_SANDBOX = prior;
		h?.cleanup();
	}
});

test("the /sandbox-boundary command reports the boundary, the allowlist, and session exemptions", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow for this session (and remember the directory)"] });
	try {
		await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Downloads/sbx-probe.txt\n` });
		await h.runCommand();
		const report = h.notifies[h.notifies.length - 1] ?? "";
		assert.match(report, /Deletion boundary/);
		assert.match(report, /Persistent allowlist/, "must list the persistent allowlist");
		assert.ok(report.includes(`${HOME}/Downloads`), "allowlist entries must be shown");
		assert.match(report, /Session exemptions/);
	} finally {
		h.cleanup();
	}
});

test("/sandbox-boundary allow pre-authorizes, forget removes, clear empties", { skip }, async () => {
	const h = await loadHarness();
	try {
		await h.runCommand(`allow ${HOME}/Downloads`);
		let onDisk = JSON.parse(fs.readFileSync(h.allowlistFile, "utf8"));
		assert.deepEqual(onDisk.entries.map((e: { path: string }) => e.path), [`${HOME}/Downloads`], "allow persists");
		assert.equal(onDisk.entries[0].source, "command", "manually added entries are tagged command");

		await h.runCommand(`allow ${HOME}/.ssh`);
		onDisk = JSON.parse(fs.readFileSync(h.allowlistFile, "utf8"));
		assert.equal(onDisk.entries.length, 1, "pre-authorizing a never-delete path is stopped by the safety gate");

		await h.runCommand(`forget ${HOME}/Downloads`);
		onDisk = JSON.parse(fs.readFileSync(h.allowlistFile, "utf8"));
		assert.deepEqual(onDisk.entries, [], "forget removes");

		await h.runCommand(`allow ${HOME}/Downloads`);
		await h.runCommand("clear");
		onDisk = JSON.parse(fs.readFileSync(h.allowlistFile, "utf8"));
		assert.deepEqual(onDisk.entries, [], "clear empties");
	} finally {
		h.cleanup();
	}
});
