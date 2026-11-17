/**
 * core-rules verification: the pure decision (decision.ts) is tested
 * directly; the injection chain does **not mock pi** — pi's own extension
 * loader (`discoverAndLoadExtensions`) really loads `index.ts`, then its
 * registered `before_agent_start` handler is called directly, with ctx
 * giving only a fake `sessionManager.buildContextEntries()`.
 *
 * Requires a local pi install; no library entry → skip wholesale, never
 * fake a pass (the harness shares its origin with
 * auto-default-model/default-model.test.ts).
 *
 *   node --test clients/pi/extensions/core-rules/index.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { decideInjection, renderBody, REPLACEMENT_NOTICE } from "./decision.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

// =============================================================================
// the pure decision (decision.ts)
// =============================================================================

test("decideInjection: file missing → silently skip", () => {
	assert.deepEqual(decideInjection(undefined, []), { action: "skip", reason: "no-rules-file" });
	assert.deepEqual(decideInjection(undefined, ["abc"]), { action: "skip", reason: "no-rules-file" });
});

test("decideInjection: an empty projection (session start / compacted away) → inject without the replacement notice", () => {
	assert.deepEqual(decideInjection("abc", []), { action: "inject", replacement: false });
});

test("decideInjection: the newest hash matches → skip", () => {
	assert.deepEqual(decideInjection("abc", ["old", "abc"]), { action: "skip", reason: "unchanged" });
});

test("decideInjection: the hash changed → re-inject with the replacement notice", () => {
	assert.deepEqual(decideInjection("new", ["old"]), { action: "inject", replacement: true });
});

test("decideInjection: a prior entry exists but its hash is unknowable (old format) → conservative re-injection", () => {
	assert.deepEqual(decideInjection("abc", [undefined]), { action: "inject", replacement: true });
});

test("renderBody: the replacement notice is prepended only on re-injection", () => {
	assert.equal(renderBody("RULES", false), "RULES");
	assert.equal(renderBody("RULES", true), `${REPLACEMENT_NOTICE}\n\nRULES`);
});

// =============================================================================
// the real chain through pi's loader
// =============================================================================

/**
 * pi's library entry (not the CLI): first back-trace the `pi` executable's
 * shim to the real install location, then fall back to the
 * `~/.pi/agent/npm/node_modules/` copy; the check is **whether it really
 * imports**.
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
const skip = piEntry === undefined ? "could not find the local pi library entry (requires an installed pi)" : false;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/** Really load the extension, returning its registered before_agent_start handler (it may not exist). */
async function loadHandler(agentDir: string): Promise<Handler | undefined> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
		) => Promise<{ extensions: Array<{ handlers: Map<string, Handler[]> }>; errors: Array<{ path: string; error: string }> }>;
	};
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], agentDir, agentDir);
	assert.deepEqual(loaded.errors, [], "pi's extension loader must not error");
	assert.equal(loaded.extensions.length, 1, "only the core-rules extension should load");
	return loaded.extensions[0]?.handlers.get("before_agent_start")?.[0];
}

function makeAgentDir(rulesText?: string): { agentDir: string; cleanup: () => void } {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-rules-"));
	if (rulesText !== undefined) fs.writeFileSync(path.join(agentDir, "AGENTS.core.md"), rulesText, "utf-8");
	return { agentDir, cleanup: () => fs.rmSync(agentDir, { recursive: true, force: true }) };
}

/** Drive one before_agent_start; entries is a fake model-visible projection. */
async function run(handler: Handler, entries: unknown[]): Promise<unknown> {
	return handler(
		{ type: "before_agent_start", prompt: "test", systemPromptOptions: {} },
		{ sessionManager: { buildContextEntries: () => entries } },
	);
}

/** One core-rules custom_message entry inside the projection. */
function coreRulesEntry(hash?: string): Record<string, unknown> {
	return { type: "custom_message", customType: "core-rules", content: "...", display: false, details: hash === undefined ? {} : { hash } };
}

test(
	"an empty projection → inject the full rules text (no replacement notice), details carry the hash",
	{ skip },
	async () => {
		const { agentDir, cleanup } = makeAgentDir("# RULES\nbe safe");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const handler = await loadHandler(agentDir);
			assert.ok(handler, "the extension should register a before_agent_start handler");
			const result = (await run(handler, [])) as { message?: Record<string, unknown> } | undefined;
			assert.ok(result?.message, "an empty projection should inject");
			assert.equal(result.message.customType, "core-rules");
			assert.equal(result.message.display, false);
			assert.equal(result.message.content, "# RULES\nbe safe");
			assert.match(String((result.message.details as { hash: string }).hash), /^[0-9a-f]{16}$/);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			cleanup();
		}
	},
);

test(
	"a same-hash entry already in the projection → skip",
	{ skip },
	async () => {
		const text = "# RULES\nbe safe";
		const { agentDir, cleanup } = makeAgentDir(text);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const handler = await loadHandler(agentDir);
			assert.ok(handler);
			const { createHash } = await import("node:crypto");
			const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
			const result = await run(handler, [{ type: "user", content: "hi" }, coreRulesEntry(hash)]);
			assert.equal(result, undefined, "a same hash must not inject twice");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			cleanup();
		}
	},
);

test(
	"the hash changed → re-inject with the replacement notice",
	{ skip },
	async () => {
		const { agentDir, cleanup } = makeAgentDir("# RULES v2");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const handler = await loadHandler(agentDir);
			assert.ok(handler);
			const result = (await run(handler, [coreRulesEntry("stalehash0000000")])) as { message?: Record<string, unknown> } | undefined;
			assert.ok(result?.message, "a changed hash should re-inject");
			assert.ok(
				String(result.message.content).startsWith(REPLACEMENT_NOTICE + "\n\n"),
				"the re-injection must carry the replacement notice",
			);
			assert.ok(String(result.message.content).endsWith("# RULES v2"));
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			cleanup();
		}
	},
);

test(
	"rules file missing → silently skip",
	{ skip },
	async () => {
		const { agentDir, cleanup } = makeAgentDir(); // no AGENTS.core.md written
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const handler = await loadHandler(agentDir);
			assert.ok(handler);
			assert.equal(await run(handler, []), undefined, "a missing file must not inject");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			cleanup();
		}
	},
);

test(
	"PI_CORE_RULES=off → no handler is registered",
	{ skip },
	async () => {
		const { agentDir, cleanup } = makeAgentDir("# RULES");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousOff = process.env.PI_CORE_RULES;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_CORE_RULES = "off";
		try {
			const handler = await loadHandler(agentDir);
			assert.equal(handler, undefined, "with off, no before_agent_start handler should be registered");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousOff === undefined) delete process.env.PI_CORE_RULES;
			else process.env.PI_CORE_RULES = previousOff;
			cleanup();
		}
	},
);
