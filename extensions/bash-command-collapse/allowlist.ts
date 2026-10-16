/**
 * Persistence layer for the allowlist — where "this directory was confirmed safe once, stop asking" is written to disk.
 *
 * ## Why a separate file
 *
 * `sandbox.ts` is pure logic (no IO, no pi dependency), so it can run directly under `node --test`.
 * The allowlist reads and writes `~/.pi/agent/sandbox-allowlist.json` — that is IO — and it must be shared
 * by **two** extensions (the bash sandbox path and the `apply_patch` path), otherwise each side keeps its own
 * records and the policies drift apart. So it lives in its own layer, and **does not import pi**: the caller
 * resolves the agent directory and passes it in (`bash-command-collapse.ts` and `sandbox-boundary/index.ts`
 * both already import pi and call `getAgentDir()`), which keeps this module runnable under `node --test` too.
 *
 * ## Where and what it stores
 *
 * `~/.pi/agent/sandbox-allowlist.json`:
 *
 * ```json
 * { "version": 1, "entries": [{ "path": "/Users/x/Downloads", "addedAt": "…", "source": "confirm" }] }
 * ```
 *
 * This is **machine-local state**, in the same category as `sessions/` and `auth.json`, and deliberately kept
 * out of the `clients/pi/` snapshot. `PI_SANDBOX_ALLOWLIST=<path>` can relocate it — both a user knob and a
 * test-isolation requirement (otherwise tests would read the user's real allowlist and produce
 * nondeterministic results).
 *
 * The allowlist is **global**: a directory authorized in project A also applies in project B. That is the
 * user's chosen policy ("recorded into pi's global config"), not an oversight.
 *
 * ## Three lines of defense
 *
 * 1. **Filter before writing**: `remember()` only accepts ranges passing `isSafeAllowlistRoot`; dangerous
 *    paths (`/`, `$HOME`, `~/.ssh`, anything containing `.git`…) can never reach disk.
 * 2. **Filter again on load**: hand-edited or corrupted JSON cannot smuggle `/` in.
 * 3. **Atomic write**: temp file + rename, so a crash mid-write cannot leave truncated JSON.
 *
 * Corrupted / unreadable / unknown version → always degrade to an empty allowlist, **never throw**. This
 * gate's job is to show fewer prompts, not to add another failure point that stops pi from starting;
 * degrading to empty only means "ask once more", which is the safe direction.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { isSafeAllowlistRoot, type PathEnv } from "./sandbox.ts";

/** Allowlist file name (inside the agent directory). */
export const ALLOWLIST_FILENAME = "sandbox-allowlist.json";

/** Current schema version. A mismatched version is dropped wholesale (better empty than guessing an old format). */
export const ALLOWLIST_VERSION = 1;

/** How an entry got in: `Allow for this session (and remember this directory)` was picked in the dialog, or it was added manually via `/sandbox-boundary allow`. */
export type AllowlistSource = "confirm" | "command";

export interface AllowlistEntry {
	/** Resolved absolute path, trailing slash stripped. */
	readonly path: string;
	/** ISO timestamp, only for human display in `/sandbox-boundary`. */
	readonly addedAt: string;
	readonly source: AllowlistSource;
}

interface AllowlistFile {
	version: number;
	entries: Array<{ path?: unknown; addedAt?: unknown; source?: unknown }>;
}

export interface AllowlistStore {
	/** The file actually read and written (`/sandbox-boundary` displays it). */
	readonly filePath: string;
	/** Paths of all entries, with unsafe roots filtered out. Used by profile injection and boundary checks. */
	roots(): string[];
	/** All entries (with timestamps and sources), for the `/sandbox-boundary` listing. */
	entries(): AllowlistEntry[];
	/**
	 * Remember these scopes, returning the ones **actually written** (entries rejected by the safety gate are excluded).
	 * Entries already on the list are not rewritten, and their timestamps are not refreshed.
	 */
	remember(paths: readonly string[], source: AllowlistSource, env: PathEnv): string[];
	/** Remove one entry (exact match on the resolved path). Returns whether anything was removed. */
	forget(path: string): boolean;
	/** Clear everything. Returns the number of entries removed. */
	clear(): number;
	/** Drop the in-memory cache so the next read hits disk. Used after the file is changed externally. */
	reload(): void;
}

/** Default allowlist path under the agent directory. */
export function defaultAllowlistPath(agentDir: string): string {
	return join(agentDir, ALLOWLIST_FILENAME);
}

/**
 * Process-wide singleton: caches stores by **resolved file path**.
 *
 * It hangs off `globalThis` rather than a module-level variable because two extensions each import this
 * module and the loader does not guarantee they get the same module instance — on globalThis, both sides
 * see the same in-memory state regardless of instance identity (one side remembers, the other side
 * takes effect immediately).
 */
const STORE_CACHE_KEY = "__piSandboxAllowlistStores__";

function storeCache(): Map<string, AllowlistStore> {
	const host = globalThis as unknown as Record<string, Map<string, AllowlistStore> | undefined>;
	const existing = host[STORE_CACHE_KEY];
	if (existing) return existing;
	const created = new Map<string, AllowlistStore>();
	host[STORE_CACHE_KEY] = created;
	return created;
}

/**
 * Get (or create) a store. The same `filePath` always returns the same instance.
 *
 * `env` is used for the safety filter at load time and only matters on **first creation**; later calls
 * return the cached instance.
 */
export function getAllowlistStore(filePath: string, env: PathEnv): AllowlistStore {
	const resolved = resolvePath(filePath);
	const cache = storeCache();
	const cached = cache.get(resolved);
	if (cached) return cached;
	const store = createAllowlistStore(resolved, env);
	cache.set(resolved, store);
	return store;
}

/** For tests: clear the singleton cache so the next `getAllowlistStore` re-reads disk. */
export function resetAllowlistStoreCache(): void {
	storeCache().clear();
}

/** Create a store (bypassing the singleton cache). Used by tests and `getAllowlistStore`. */
export function createAllowlistStore(filePath: string, env: PathEnv): AllowlistStore {
	const resolvedFile = resolvePath(filePath);
	let cache: AllowlistEntry[] | undefined;

	const read = (): AllowlistEntry[] => {
		if (cache) return cache;
		cache = parseFile(resolvedFile, env);
		return cache;
	};

	const write = (entries: readonly AllowlistEntry[]): void => {
		const payload: AllowlistFile = { version: ALLOWLIST_VERSION, entries: [...entries] };
		mkdirSync(dirname(resolvedFile), { recursive: true });
		// Atomic write: write a temp file in the same directory, then rename over the target.
		// The temp name carries pid + timestamp so two pi processes writing at once do not clobber each other.
		const tmp = `${resolvedFile}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		try {
			renameSync(tmp, resolvedFile);
		} catch (err) {
			// If rename fails, collect the temp file so no junk is left in the agent directory, then rethrow —
			// the caller learns the remember failed (it will ask again next time, which is the safe direction).
			try {
				unlinkSync(tmp);
			} catch {
				// If cleanup fails, so be it: a stray .tmp file is not worth another throw that masks the real error.
			}
			throw err;
		}
		cache = [...entries];
	};

	return {
		filePath: resolvedFile,
		roots: () => read().map((e) => e.path),
		entries: () => [...read()],
		remember(paths, source, rememberEnv) {
			const current = read();
			const existing = new Set(current.map((e) => e.path));
			const added: AllowlistEntry[] = [];
			for (const raw of paths) {
				const resolved = stripTrailingSlash(resolvePath(raw));
				if (existing.has(resolved)) continue;
				// Pre-write filter: dangerous paths can never reach disk, even if the caller computed the scope wrong.
				if (!isSafeAllowlistRoot(resolved, rememberEnv)) continue;
				existing.add(resolved);
				added.push({ path: resolved, addedAt: new Date().toISOString(), source });
			}
			if (added.length === 0) return [];
			write([...current, ...added]);
			return added.map((e) => e.path);
		},
		forget(path) {
			const resolved = stripTrailingSlash(resolvePath(path));
			const current = read();
			const next = current.filter((e) => e.path !== resolved);
			if (next.length === current.length) return false;
			write(next);
			return true;
		},
		clear() {
			const count = read().length;
			if (count === 0) return 0;
			write([]);
			return count;
		},
		reload() {
			cache = undefined;
		},
	};
}

/** Read disk + validate + safety-filter. Any error degrades to an empty array. */
function parseFile(filePath: string, env: PathEnv): AllowlistEntry[] {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return []; // File missing (first use) or unreadable: empty allowlist, we just ask once more
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return []; // Corrupted JSON: don't guess, don't throw — treat as empty
	}

	if (!parsed || typeof parsed !== "object") return [];
	const file = parsed as Partial<AllowlistFile>;
	if (file.version !== ALLOWLIST_VERSION) return []; // Unknown version: drop wholesale
	if (!Array.isArray(file.entries)) return [];

	const out: AllowlistEntry[] = [];
	const seen = new Set<string>();
	for (const item of file.entries) {
		if (!item || typeof item !== "object") continue;
		if (typeof item.path !== "string" || !item.path) continue;
		const resolved = stripTrailingSlash(resolvePath(item.path));
		if (seen.has(resolved)) continue;
		// Filter on load too: hand-edited JSON cannot smuggle in `/` or `~/.ssh`
		if (!isSafeAllowlistRoot(resolved, env)) continue;
		seen.add(resolved);
		out.push({
			path: resolved,
			addedAt: typeof item.addedAt === "string" ? item.addedAt : "",
			source: item.source === "command" ? "command" : "confirm",
		});
	}
	return out;
}

function stripTrailingSlash(p: string): string {
	return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Session-level exemptions (`Allow for this session` on a dangerous directory) and one-shot exemptions (`Allow once`).
 *
 * Kept separate from the persistent allowlist because their lifetimes differ: session-level dies when pi
 * restarts, one-shot only lives until the command finishes. Also hung on `globalThis`, same reason as the store cache.
 */
const SESSION_KEY = "__piSandboxSessionScopes__";

export interface SessionScopes {
	/** Directories exempted for this session (dangerous directories where `Allow for this session` was chosen). */
	roots(): string[];
	add(paths: readonly string[]): void;
	clear(): void;
}

export function getSessionScopes(): SessionScopes {
	const host = globalThis as unknown as Record<string, Set<string> | undefined>;
	const existing = host[SESSION_KEY];
	const set = existing ?? new Set<string>();
	host[SESSION_KEY] = set;
	return {
		roots: () => [...set],
		add: (paths) => {
			for (const p of paths) set.add(stripTrailingSlash(resolvePath(p)));
		},
		clear: () => set.clear(),
	};
}
