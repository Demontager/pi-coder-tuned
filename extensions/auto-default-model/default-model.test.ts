/**
 * auto-default-model verification: **no pi mocking** — pi's own extension
 * loader (`discoverAndLoadExtensions`) really loads `index.ts`, its
 * registered `model_select` handler is called directly, and the fake agent
 * dir's `settings.json` is inspected at the end.
 *
 * This exercises the real chain: the extension's
 * `import { SettingsManager } from "@earendil-works/pi-coding-agent"` goes
 * through the very alias / virtualModules the loader prepared (a failing
 * import makes pi's loader error and leaves `extensions` empty — the first
 * case asserts exactly that), and persistence goes through the real
 * `FileSettingsStorage` (proper-lockfile + read-modify-write merging only
 * changed fields), not a fake object the test stitched together.
 *
 * Requires a local pi install (the `pi` executable's shim back-traces the
 * real install location, then falls back to
 * `~/.pi/agent/npm/node_modules/`, or `PI_TEST_PI_ENTRY` points the way);
 * none found → skip wholesale, never fake a pass. The `~/.pi/agent/npm`
 * copy cannot be trusted by presence alone: `pi update --extensions` trims
 * the auto-installed `@earendil-works/pi-*` sibling packages, leaving a
 * shell that throws on import.
 *
 *   node --test clients/pi/extensions/auto-default-model/default-model.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

/**
 * pi's library entry (not the CLI): bundle is the shape `pi` actually runs,
 * dist is the node build shape — both can load extensions.
 *
 * First back-trace the `pi` executable to the **real install location**
 * (pnpm/npm shim scripts carry a `# cmd-shim-target=<abs path>` line; npm on
 * Unix uses a symlink — both are tried), then fall back to the
 * `~/.pi/agent/npm` copy — the latter is the **extension-package install
 * root**: `pi update --extensions` trims the auto-installed
 * `@earendil-works/pi-*` sibling packages with
 * `--config.auto-install-peers=false`, leaving that copy a hollow shell
 * (files present, import fails with `ERR_MODULE_NOT_FOUND`; hit live while
 * upgrading pi-subagents 0.68.0 in 2026-09).
 *
 * The check is **whether it really imports**, not whether the path exists —
 * only an actual import can tell a hollow shell apart. All failing →
 * undefined; the caller skips wholesale (never fakes a pass).
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

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type Notify = { type: string | undefined; message: string };

/** Really load the extension, returning its registered model_select handler. */
async function loadModelSelectHandler(agentDir: string, projectDir: string): Promise<Handler> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
		) => Promise<{ extensions: Array<{ handlers: Map<string, Handler[]> }>; errors: Array<{ path: string; error: string }> }>;
	};
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir);
	assert.deepEqual(loaded.errors, [], "pi's extension loader must not error");
	assert.equal(loaded.extensions.length, 1, "only the auto-default-model extension should load");
	const handler = loaded.extensions[0]?.handlers.get("model_select")?.[0];
	assert.ok(handler, "the extension should register a model_select handler");
	return handler;
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-default-model-"));
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

function writeSettings(agentDir: string, settings: unknown, raw?: string): void {
	fs.writeFileSync(path.join(agentDir, "settings.json"), raw ?? `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function readSettings(agentDir: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"));
}

/** Drive one model switch (the `/model` picker path by default), returning the notifications the UI received. */
async function switchModel(
	agentDir: string,
	projectDir: string,
	provider: string,
	id: string,
	options: { source?: string; hasUI?: boolean } = {},
): Promise<{ notifications: Notify[]; fileExisted: boolean }> {
	const handler = await loadModelSelectHandler(agentDir, projectDir);
	const notifications: Notify[] = [];
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await handler(
			{
				type: "model_select",
				model: { provider, id },
				previousModel: { provider: "litellm-any", id: "qwen3.8-df-qd-claude" },
				source: options.source ?? "set",
			},
			{
				cwd: projectDir,
				hasUI: options.hasUI ?? false,
				ui: {
					notify: (message: string, type?: string) => {
						notifications.push({ message, type });
					},
				},
			},
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	return { notifications, fileExisted: fs.existsSync(path.join(agentDir, "settings.json")) };
}

test("a model switch writes defaultProvider/defaultModel as the startup default — other settings.json fields untouched", { skip }, async () => {
	const workspace = makeWorkspace();
	try {
		writeSettings(workspace.agentDir, {
			theme: "coffee",
			defaultProvider: "litellm-any",
			defaultModel: "qwen3.8-df-qd-claude",
			markdown: { mermaid: "streaming" },
			packages: ["npm:pi-subagents"],
		});

		const { notifications, fileExisted } = await switchModel(workspace.agentDir, workspace.projectDir, "litellm-any", "deepseek-flash");

		assert.deepEqual(notifications, []);
		assert.equal(fileExisted, true);
		assert.deepEqual(readSettings(workspace.agentDir), {
			theme: "coffee",
			defaultProvider: "litellm-any",
			defaultModel: "deepseek-flash",
			markdown: { mermaid: "streaming" },
			packages: ["npm:pi-subagents"],
		});
	} finally {
		workspace.cleanup();
	}
});

test("settings.json is created on demand when absent (a fresh machine)", { skip }, async () => {
	const workspace = makeWorkspace();
	try {
		assert.equal(fs.existsSync(path.join(workspace.agentDir, "settings.json")), false);

		await switchModel(workspace.agentDir, workspace.projectDir, "litellm-any", "deepseek-flash");

		assert.deepEqual(readSettings(workspace.agentDir), {
			defaultProvider: "litellm-any",
			defaultModel: "deepseek-flash",
		});
	} finally {
		workspace.cleanup();
	}
});

test("the same model already on disk → no write (settings.json not dirtied for nothing)", { skip }, async () => {
	const workspace = makeWorkspace();
	try {
		// compact format, no newline: pi's own write would reformat to 2-space indent, so "bytes unchanged" = truly never written.
		const raw = '{"defaultProvider":"litellm-any","defaultModel":"deepseek-flash"}';
		writeSettings(workspace.agentDir, undefined, raw);

		await switchModel(workspace.agentDir, workspace.projectDir, "litellm-any", "deepseek-flash");

		assert.equal(fs.readFileSync(path.join(workspace.agentDir, "settings.json"), "utf-8"), raw);
	} finally {
		workspace.cleanup();
	}
});

test("source=restore (the model a resumed session brings back) does not change the global default", { skip }, async () => {
	const workspace = makeWorkspace();
	try {
		const raw = '{"defaultProvider":"litellm-any","defaultModel":"qwen3.8-df-qd-claude"}';
		writeSettings(workspace.agentDir, undefined, raw);

		await switchModel(workspace.agentDir, workspace.projectDir, "litellm-any", "deepseek-flash", { source: "restore" });

		assert.equal(fs.readFileSync(path.join(workspace.agentDir, "settings.json"), "utf-8"), raw);
	} finally {
		workspace.cleanup();
	}
});

test("PI_AUTO_DEFAULT_MODEL=off disables it entirely", { skip }, async () => {
	const workspace = makeWorkspace();
	try {
		const raw = '{"defaultProvider":"litellm-any","defaultModel":"qwen3.8-df-qd-claude"}';
		writeSettings(workspace.agentDir, undefined, raw);
		process.env.PI_AUTO_DEFAULT_MODEL = "off";
		try {
			await switchModel(workspace.agentDir, workspace.projectDir, "litellm-any", "deepseek-flash");
		} finally {
			delete process.env.PI_AUTO_DEFAULT_MODEL;
		}

		assert.equal(fs.readFileSync(path.join(workspace.agentDir, "settings.json"), "utf-8"), raw);
	} finally {
		workspace.cleanup();
	}
});

test("a broken settings.json is not reported as a successful write (a warning notifies, the file stays put)", { skip }, async () => {
	const workspace = makeWorkspace();
	try {
		const raw = "{ this is not json }";
		writeSettings(workspace.agentDir, undefined, raw);

		const { notifications } = await switchModel(workspace.agentDir, workspace.projectDir, "litellm-any", "deepseek-flash", {
			hasUI: true,
		});

		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]?.type, "warning");
		// the warning must name the model and carry pi's recorded real error (the parse failure verbatim) — or the user has nothing to go on.
		assert.match(notifications[0]?.message ?? "", /deepseek-flash/);
		assert.match(notifications[0]?.message ?? "", /startup default model/);
		assert.equal(fs.readFileSync(path.join(workspace.agentDir, "settings.json"), "utf-8"), raw);
	} finally {
		workspace.cleanup();
	}
});
