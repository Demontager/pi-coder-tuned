/**
 * Tests for allowlist.ts — the IO layer of the persistent allowlist. Pure node, no pi needed.
 *
 * Run with:  node --test clients/pi/extensions/bash-command-collapse/allowlist.test.ts
 *
 * What is asserted:
 *   - read/write round-trip: remember → roots()/entries() agree, and what lands on disk is valid JSON with a version;
 *   - atomic write: no .tmp junk left behind;
 *   - corrupted / missing / unknown version → degrade to empty, never throw;
 *   - dangerous scopes can never reach disk (pre-write filter), and hand-edited dangerous entries are filtered on load;
 *   - forget / clear / reload semantics;
 *   - singleton: the same filePath returns the same instance — one side remembers, the other sees it immediately;
 *   - session scope set is independent of the persistent allowlist; clear only clears the session.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	ALLOWLIST_VERSION,
	createAllowlistStore,
	defaultAllowlistPath,
	getAllowlistStore,
	getSessionScopes,
	resetAllowlistStoreCache,
} from "./allowlist.ts";
import type { PathEnv } from "./sandbox.ts";

const HOME = os.homedir();
const env: PathEnv = { home: HOME };

function tmpFile(): { file: string; dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-allowlist-"));
	return {
		file: path.join(dir, "sandbox-allowlist.json"),
		dir,
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

test("defaultAllowlistPath lives under the agent directory", () => {
	assert.equal(defaultAllowlistPath("/Users/x/.pi/agent"), "/Users/x/.pi/agent/sandbox-allowlist.json");
});

test("read/write round-trip: roots/entries agree after remember; what lands on disk is valid JSON with a version", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		const written = store.remember([`${HOME}/Downloads`], "confirm", env);
		assert.deepEqual(written, [`${HOME}/Downloads`]);
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`]);

		const entries = store.entries();
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.path, `${HOME}/Downloads`);
		assert.equal(entries[0]!.source, "confirm");
		assert.ok(entries[0]!.addedAt, "must carry a timestamp");

		const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(onDisk.version, ALLOWLIST_VERSION);
		assert.equal(onDisk.entries.length, 1);
		assert.equal(onDisk.entries[0].path, `${HOME}/Downloads`);
	} finally {
		cleanup();
	}
});

test("atomic write: no .tmp junk left behind", () => {
	const { file, dir, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		store.remember([`${HOME}/Downloads`], "confirm", env);
		const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp"));
		assert.deepEqual(leftovers, [], `no temp file should be left behind: \${leftovers.join(", ")}${leftovers.join("no temp file should be left behind: ${leftovers.join(\", \")}")}`);
	} finally {
		cleanup();
	}
});

test("repeat remember writes no second entry and does not refresh the timestamp", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		store.remember([`${HOME}/Downloads`], "confirm", env);
		const first = store.entries()[0]!.addedAt;
		assert.deepEqual(store.remember([`${HOME}/Downloads`], "confirm", env), [], "already present → no new write");
		assert.equal(store.entries().length, 1);
		assert.equal(store.entries()[0]!.addedAt, first);
	} finally {
		cleanup();
	}
});

test("trailing-slash and relative forms normalize: the same directory is not remembered twice", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		store.remember([`${HOME}/Downloads/`], "confirm", env);
		assert.deepEqual(store.remember([`${HOME}/Downloads`], "confirm", env), []);
		assert.equal(store.entries().length, 1);
	} finally {
		cleanup();
	}
});

test("missing file → empty allowlist, no throw", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		assert.deepEqual(store.roots(), []);
		assert.deepEqual(store.entries(), []);
	} finally {
		cleanup();
	}
});

test("corrupted JSON → degrade to empty, no throw", () => {
	const { file, cleanup } = tmpFile();
	try {
		fs.writeFileSync(file, "{ this is not JSON", "utf8");
		const store = createAllowlistStore(file, env);
		assert.deepEqual(store.roots(), []);
		// after degrading, writes still work normally (overwriting the corrupted file)
		store.remember([`${HOME}/Downloads`], "confirm", env);
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`]);
	} finally {
		cleanup();
	}
});

test("unknown version → dropped wholesale", () => {
	const { file, cleanup } = tmpFile();
	try {
		fs.writeFileSync(
			file,
			JSON.stringify({ version: 99, entries: [{ path: `${HOME}/Downloads`, addedAt: "x", source: "confirm" }] }),
			"utf8",
		);
		const store = createAllowlistStore(file, env);
		assert.deepEqual(store.roots(), [], "unknown version: do not guess the old format");
	} finally {
		cleanup();
	}
});

test("non-object / non-array entries → degrade to empty", () => {
	const { file, cleanup } = tmpFile();
	try {
		fs.writeFileSync(file, JSON.stringify([1, 2, 3]), "utf8");
		assert.deepEqual(createAllowlistStore(file, env).roots(), []);
		fs.writeFileSync(file, JSON.stringify({ version: ALLOWLIST_VERSION, entries: "nope" }), "utf8");
		assert.deepEqual(createAllowlistStore(file, env).roots(), []);
	} finally {
		cleanup();
	}
});

test("pre-write filter: dangerous scopes can never reach disk", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		const written = store.remember(
			["/", HOME, `${HOME}/.ssh`, "/usr/local", `${HOME}/projects/x/.git`, `${HOME}/Downloads`, `${HOME}/.pi/agent`],
			"confirm",
			env,
		);
		assert.deepEqual(written, [`${HOME}/Downloads`, `${HOME}/.pi/agent`], "only ordinary directories reach disk (~/.config, ~/.pi are ordinary tier since 2026-09-25)");
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`, `${HOME}/.pi/agent`]);
	} finally {
		cleanup();
	}
});

test("load-time filter: hand-inserted dangerous entries are dropped", () => {
	const { file, cleanup } = tmpFile();
	try {
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: ALLOWLIST_VERSION,
				entries: [
					{ path: "/", addedAt: "x", source: "confirm" },
					{ path: HOME, addedAt: "x", source: "confirm" },
					{ path: `${HOME}/.ssh`, addedAt: "x", source: "confirm" },
					{ path: `${HOME}/Downloads`, addedAt: "x", source: "confirm" },
				],
			}),
			"utf8",
		);
		const store = createAllowlistStore(file, env);
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`], "dangerous entries are filtered on load");
	} finally {
		cleanup();
	}
});

test("load drops malformed and duplicate entries", () => {
	const { file, cleanup } = tmpFile();
	try {
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: ALLOWLIST_VERSION,
				entries: [
					null,
					{ addedAt: "x" }, // no path
					{ path: "", addedAt: "x" },
					{ path: `${HOME}/Downloads`, addedAt: "x", source: "confirm" },
					{ path: `${HOME}/Downloads/`, addedAt: "y", source: "command" }, // duplicate after normalization
				],
			}),
			"utf8",
		);
		const store = createAllowlistStore(file, env);
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`]);
		assert.equal(store.entries()[0]!.source, "confirm", "the first entry wins");
	} finally {
		cleanup();
	}
});

test("unknown source falls back to confirm", () => {
	const { file, cleanup } = tmpFile();
	try {
		fs.writeFileSync(
			file,
			JSON.stringify({ version: ALLOWLIST_VERSION, entries: [{ path: `${HOME}/Downloads`, addedAt: "x", source: "weird" }] }),
			"utf8",
		);
		assert.equal(createAllowlistStore(file, env).entries()[0]!.source, "confirm");
	} finally {
		cleanup();
	}
});

test("forget: exact match on the resolved path; returns whether anything was removed", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		store.remember([`${HOME}/Downloads`, `${HOME}/projects`], "confirm", env);
		assert.equal(store.forget(`${HOME}/Downloads/`), true, "matches after trailing-slash normalization");
		assert.deepEqual(store.roots(), [`${HOME}/projects`]);
		assert.equal(store.forget(`${HOME}/nope`), false, "not on the list");
		assert.deepEqual(store.roots(), [`${HOME}/projects`], "no match leaves the file untouched");
	} finally {
		cleanup();
	}
});

test("clear: returns the number removed; writes nothing when the list is empty", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		assert.equal(store.clear(), 0, "was empty to begin with");
		assert.equal(fs.existsSync(file), false, "an empty allowlist must not conjure a file");
		store.remember([`${HOME}/Downloads`, `${HOME}/projects`], "confirm", env);
		assert.equal(store.clear(), 2);
		assert.deepEqual(store.roots(), []);
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).entries, [], "on disk cleared too");
	} finally {
		cleanup();
	}
});

test("reload: drop the in-memory cache and re-read disk (sees external changes)", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		store.remember([`${HOME}/Downloads`], "confirm", env);
		// simulate another process / hand edit: append an entry directly to the file
		const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
		onDisk.entries.push({ path: `${HOME}/projects`, addedAt: "x", source: "command" });
		fs.writeFileSync(file, JSON.stringify(onDisk), "utf8");
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`], "before reload it is still the in-memory copy");
		store.reload();
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`, `${HOME}/projects`]);
	} finally {
		cleanup();
	}
});

test("singleton: the same filePath returns the same instance; one side writes and the other sees it immediately", () => {
	const { file, cleanup } = tmpFile();
	resetAllowlistStoreCache();
	try {
		const a = getAllowlistStore(file, env);
		const b = getAllowlistStore(file, env);
		assert.equal(a, b, "the same path must be the same instance");
		a.remember([`${HOME}/Downloads`], "confirm", env);
		assert.deepEqual(b.roots(), [`${HOME}/Downloads`], "remembered on the bash side, effective immediately on the apply_patch side");
	} finally {
		resetAllowlistStoreCache();
		cleanup();
	}
});

test("singleton dedupes by resolved path: trailing slash and `.` segments get the same instance", () => {
	const { file, cleanup } = tmpFile();
	resetAllowlistStoreCache();
	try {
		const a = getAllowlistStore(file, env);
		const b = getAllowlistStore(`${file}/`, env);
		const c = getAllowlistStore(path.join(path.dirname(file), ".", path.basename(file)), env);
		assert.equal(a, b, "same instance after trailing-slash normalization");
		assert.equal(a, c, "same instance after `.` segment normalization");
	} finally {
		resetAllowlistStoreCache();
		cleanup();
	}
});

test("singleton key is lexical: /var and /private/var spellings get two instances (acceptable trade-off)", { skip: process.platform !== "darwin" ? "Requires macOS /var symlink" : false }, () => {
	// Not a bug but a trade-off: the cache key uses resolvePath (lexical), no symlink hops.
	// On macOS os.tmpdir() is /var/folders/… while its realpath is /private/var/folders/…,
	// so these two spellings do get two instances. But the path-computing code on both extension
	// sides is identical (PI_SANDBOX_ALLOWLIST or join(getAgentDir(), …)), and getAgentDir() is deterministic,
	// so in one process both sides necessarily get the same string — there is no real path where "one side remembers and the other cannot see".
	// This pins the boundary down: if it ever changes to allow different spellings on the two sides, this test will flag the need for a realpath key.
	resetAllowlistStoreCache();
	const { dir, cleanup } = tmpFile();
	try {
		assert.ok(dir.startsWith("/var/") || dir.startsWith("/private/var/"), `this case depends on macOS's /var link: \${dir}${dir}`);
		const varForm = dir.replace(/^\/private/, "");
		const privateForm = varForm.startsWith("/private") ? varForm : `/private${varForm}`;
		const a = getAllowlistStore(path.join(varForm, "x.json"), env);
		const b = getAllowlistStore(path.join(privateForm, "x.json"), env);
		assert.notEqual(a, b, "lexical key: the two spellings are two instances (cannot happen while both sides share code)");
	} finally {
		resetAllowlistStoreCache();
		cleanup();
	}
});

test("session scope set: add / roots / clear, independent of the persistent allowlist", () => {
	const scopes = getSessionScopes();
	scopes.clear();
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		store.remember([`${HOME}/Downloads`], "confirm", env);

		scopes.add([`${HOME}/.config/foo`, `${HOME}/.config/foo/`]);
		assert.deepEqual(scopes.roots(), [`${HOME}/.config/foo`], "dedupe + strip trailing slash");
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`], "session exemptions are not persisted");

		scopes.clear();
		assert.deepEqual(scopes.roots(), []);
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`], "clearing the session does not touch the persistent allowlist");
	} finally {
		scopes.clear();
		cleanup();
	}
});

test("session scope set is a globalThis singleton: two gets share one state", () => {
	const a = getSessionScopes();
	const b = getSessionScopes();
	a.clear();
	a.add([`${HOME}/.config/foo`]);
	assert.deepEqual(b.roots(), [`${HOME}/.config/foo`]);
	a.clear();
});
