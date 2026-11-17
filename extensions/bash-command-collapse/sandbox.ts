/**
 * Seatbelt (`sandbox-exec`) capability boundary — pure logic, no IO, no pi dependency.
 *
 * ## Why a capability boundary instead of a blacklist
 *
 * The two accidental-deletion incidents of 2026-09-23 proved that enumerating "bad shapes"
 * (`rm -rf /`, `path.dirname(x ?? "/tmp")`) always misses something, because bad shapes are
 * infinite. Codex never shows a confirmation dialog and never deletes global files by mistake —
 * not thanks to a longer blacklist, but because it **hands enforcement to the OS**: every command
 * runs inside a seatbelt / landlock sandbox. This implementation narrows enforcement to
 * **deletion** (the damage in both incidents was all deletion): `unlink` outside the boundary is
 * rejected by the kernel with `EPERM`, while writes are unrestricted (see the "Boundary" section).
 *
 * So "confirmation" only appears when it should: normal operations (in-boundary deletes, any write)
 * → never prompt; an out-of-boundary delete → the command fails first, and only after explicit user
 * approval is it rerun **inside the sandbox** with the approved scope. This is fail-closed — there
 * are no holes outside the enumeration because nothing is enumerated.
 *
 * This module only **generates the profile and decides the boundary**; execution lives in
 * `bash-command-collapse.ts`.
 *
 * ## Boundary (set by the user on 2026-09-24, narrowed to "deletion only" the same day)
 *
 * - **Writes**: unrestricted. `echo x > ~/.zshrc` and other out-of-boundary writes pass without a
 *   prompt — the user's policy is "a write target outside the writable boundary does not need a reminder".
 * - **Deletes**: allowed only **inside** the project directory (`cwd`) + temp directories (`/tmp`,
 *   `/private/tmp`, `/var/folders`, `/var/tmp`) + regenerable caches (`SAFE_CACHE_HOME_DIRS`) + paths
 *   explicitly listed in `PI_SANDBOX_EXTRA_WRITE`; an out-of-boundary `unlink` gets `EPERM` from the
 *   kernel, and only then is a confirmation shown. The damage surface of both incidents (`~/.zshrc`,
 *   `~/.pi/agent/sessions`, `~/.claude`) was entirely **deletion**, so enforcement lands on deletion.
 * - **Reads**: unrestricted. Codex's `workspace-write` likewise constrains writes, not reads; restricting
 *   reads would break perfectly normal inspection like `cat ~/.zshrc`.
 * - **Network**: fully open. Local npm / git / gateway traffic depends on egress, and the risk surface
 *   is file deletion, not networking.
 *
 * ## Three authorization tiers (set by the user on 2026-09-24, "never delete" tier added the same day)
 *
 * Out-of-boundary deletes are split by **target path** into three tiers:
 *
 * - **Never delete** (`NEVER_DELETE_HOME_FILES` / `NEVER_DELETE_HOME_DIRS`): identity / credentials
 *   (`~/.zshrc`, `~/.ssh`, `~/.gnupg`…). **No prompt, no override option at all** — allowlist, session
 *   exemption, and `PI_SANDBOX_EXTRA_WRITE` cannot override it (the kernel deny line comes after the
 *   allow lines). The `~/.zshrc`, `~/.gitconfig`, `~/.zprofile` deleted in the second 2026-09-23 incident
 *   are in this tier. On 2026-09-25 the user moved `~/.config`, `~/.pi`, `~/.claude`, `~/.codex` out of
 *   this tier — they are **tool state directories** (locks, caches, session logs and other things cleaned
 *   up routinely), not credentials, and belong in the "prompt + rememberable directory" tier.
 * - **Dangerous paths** (`DANGEROUS_ROOTS` + `~/Library` + any path containing a `.git`/`.hg`/`.svn`
 *   component): ask on every delete, only **session-level** exemption is supported (restored after pi
 *   restarts). These are unix system roots, bin, and application install directories — a wrong delete is
 *   hard to recover but these are not credentials.
 * - **Ordinary paths** (outside the boundary but in neither tier above): ask once; on approval the
 *   **directory scope** is written to `~/.pi/agent/sandbox-allowlist.json` and never asked again
 *   (including headless runs).
 *
 * Remembering a directory = adding it to the profile's `(allow file-write-unlink (subpath …))`, so the
 * delete succeeds **inside** the sandbox while the rest of the command stays sandboxed — the granted
 * scope is exactly "deletion capability for this directory", not a byte more. This is also why common
 * paths get **zero prompts and zero reruns**: the profile already carries the allowlist roots before the
 * command runs.
 *
 * ## One cost you must know: rename also goes through unlink
 *
 * Seatbelt has **no** `file-write-rename` operation (verified: `(allow file-write-rename)` reports
 * `unbound variable`); `rename(2)` is seen by the sandbox as a `file-write-unlink` on the source path.
 * So these out-of-boundary operations are blocked too, even though their intent is "write", not "delete":
 *
 * - `sed -i '' 's/a/b/' ~/.some.conf` — atomic replace = write a temp file + rename over the original
 * - `mv ~/.a ~/.b` — the source is outside the boundary
 * - `git init` / `git commit` in an out-of-boundary repo — git persists via `*.lock` + rename
 *
 * This is not a bug but an inevitability of delete semantics: atomic replace really does make the old
 * inode disappear. Compared to the previous behavior (**all** out-of-boundary writes blocked) this is a
 * strict relaxation — no operation went from "usable" to "unusable". But the "never delete" tier is the
 * exception: an **in-place rewrite** like `sed -i '' ~/.zshrc` is still kernel-blocked (rename goes
 * through unlink) — exactly the "never delete" strength the user wants, at the cost that editing config
 * must be done in a terminal yourself, or turn the whole layer off with `PI_SANDBOX=off`.
 *
 * `sandbox-exec` is marked deprecated by Apple but verified working on macOS 26.5.1
 * (out-of-boundary `echo >` succeeds, out-of-boundary `rm` gets `Operation not permitted` with the file
 * intact, in-boundary `rm` deletes normally, `curl` egress returns 200).
 */

import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

/**
 * The boundary formed by the set of writable roots. `cwd` and `extraWrites` should both be resolved
 * absolute paths.
 *
 * The "write" in the name is historical: since 2026-09-24 this boundary **only constrains deletion**
 * (seatbelt's `file-write-unlink`); writing itself is unrestricted.
 */
export interface WriteBoundary {
	readonly cwd: string;
	readonly extraWrites: readonly string[];
}

/**
 * Temp-directory roots. System-managed, auto-cleaned, containing no user data — so they count as part of
 * the "safe sandbox directories".
 *
 * `/var/folders` is macOS's real `$TMPDIR`: node / git / npm / python3 all write temp files there, and
 * not allowing it would break many normal commands. `/private/...` entries are their realpath forms;
 * both spellings must be in the table (same reasoning as `destructive-guard`'s `TEMP_ROOTS`).
 *
 * `/var/tmp` is the heredoc temp directory of macOS's bundled **bash 3.2**, and it is **hardcoded at
 * compile time**: `strings /bin/bash` contains only `/var/tmp/` and `sh-thd`; `TMPDIR=/tmp`,
 * `TMPDIR=<project dir>`, and `env -u TMPDIR` are all ineffective (verified: the inner `$TMPDIR` already
 * holds the new value yet files still land in `/private/var/tmp/sh-thd-*`). bash 3.2's heredoc
 * implementation must create a temp file and then unlink it (delete-on-open); without this root allowed,
 * **every heredoc inside the sandbox fails 100%** and leaks an `sh-thd-*` each time. User policy:
 * `/var/tmp` is the same class as `/tmp` — "nothing you do there matters". Note it is more "persistent"
 * than `/tmp` — this machine has no `/etc/periodic` and no periodic LaunchDaemon, and `/private/var/tmp`
 * does contain entries months old.
 */
export const TEMP_WRITE_ROOTS: readonly string[] = [
	"/tmp",
	"/private/tmp",
	"/var/folders",
	"/private/var/folders",
	"/var/tmp",
	"/private/var/tmp",
];

/**
 * Dangerous paths: ask on every delete; only session-level exemption is supported.
 *
 * Policy (the "narrow enumeration" the user chose on 2026-09-24): important unix system roots + bin +
 * application install directories. `/usr/local` and `/opt/homebrew` are package-manager prefixes
 * (the territory of `brew uninstall` / `npm -g`); they are listed separately because normal operations
 * touch them more often than `/usr`, yet a wrong delete is equally hard to recover.
 *
 * Home-level identity / credential / config directories have moved up to the "never delete" tier
 * (`NEVER_DELETE_HOME_DIRS`); the home part of this table is down to `~/Library` only.
 *
 * `/private/...` entries are macOS realpath forms (`/etc` → `/private/etc`); both spellings must be in
 * the table — same reasoning as `TEMP_WRITE_ROOTS`. Note that `/private/tmp` and
 * `/private/var/folders`, though under `/private`, are **inside** the writable boundary and never reach
 * the dangerous check (`classifyOutsidePaths` checks the boundary first).
 *
 * ## Dangerous subtree vs dangerous exact
 *
 * The split between these two tables is the key to the whole list — get it backwards and the feature
 * is broken:
 *
 * - **Dangerous subtree** (`DANGEROUS_ROOTS` + `DANGEROUS_HOME_DIRS`): it **and everything under it** is
 *   dangerous. `/usr/local/bin/tsc` is dangerous because `/usr` is in the table.
 * - **Dangerous exact** (`DANGEROUS_EXACT`): only itself is dangerous; its subpaths are judged
 *   **separately**. `$HOME` is in this tier — deleting all of home is a catastrophe, but `~/Downloads`
 *   is an ordinary directory that belongs in "ask once then remember". Putting `$HOME` in the subtree
 *   table would make **every** path under home dangerous and the ordinary-directory allowlist would
 *   never take effect. Same for `/Users`.
 *
 * Identity / credentials / hand-written configs have moved up to the "never delete" tier
 * (`NEVER_DELETE_*`) and no longer go through this table.
 */
export const DANGEROUS_ROOTS: readonly string[] = [
	"/System",
	"/Library",
	"/Applications",
	"/bin",
	"/sbin",
	"/usr",
	"/opt",
	"/etc",
	"/private",
	"/var",
	"/Volumes",
	"/cores",
	"/dev",
];

/**
 * Roots that are dangerous **only by themselves**: deleting them is a catastrophe, but their subpaths
 * are judged separately.
 *
 * `/` is here rather than in `DANGEROUS_ROOTS` because subtree semantics are meaningless for it (every
 * absolute path is under it); `/Users` is here because subtree semantics would mark every user's home
 * dangerous, while one's own home is already governed separately by `$HOME` (injected at runtime).
 */
export const DANGEROUS_EXACT: readonly string[] = ["/", "/Users"];

/**
 * `$HOME`-level directories "related to configuration", in the **always-ask, session-exemptable** tier.
 *
 * Credential / identity directories (`.ssh`, `.gnupg`, `.aws`…) live in the "never delete" tier
 * (`NEVER_DELETE_HOME_DIRS`); only `~/Library` remains here — home of macOS app preferences and
 * Application Support: hard to recover if wrongly deleted, but not credentials, so still ask-and-exempt.
 *
 * `~/.config`, `~/.pi`, `~/.claude`, `~/.codex` are **neither in this tier nor in never-delete**
 * (user decision 2026-09-25): they land in "ordinary outside" — ask once, and the directory can be
 * remembered permanently on approval.
 *
 * Note `~/Library/Caches` and `~/Library/Developer/Xcode/DerivedData` are **inside** the writable
 * boundary (`SAFE_CACHE_HOME_DIRS`); `classifyOutsidePaths` checks the boundary first and never gets here.
 */
export const DANGEROUS_HOME_DIRS: readonly string[] = ["Library"];

/**
 * The "never delete" tier: identity / credentials / hand-written configs that cannot be recreated once
 * deleted. Kernel-blocked, no prompt, no override option at all (`Allow once` / `Allow for this
 * session` / allowlist / extraWrites cannot override). User policy set on 2026-09-24: list only
 * **identity / credentials / hand-written configs** — cache-like dotfiles (`.cache`, `.npm`,
 * `.dartServer`…) are never listed.
 *
 * Narrowed further on 2026-09-25: `~/.config`, `~/.pi`, `~/.claude`, `~/.codex` moved out of this tier
 * (they are tool state directories; locks / caches / session logs must be cleaned routinely), landing in
 * "ordinary outside" — a three-option prompt, and `Allow for this session (and remember the directory)`
 * stops future prompts.
 *
 * Difference from the "dangerous, always ask" tier: dangerous means "deletable with explicit consent";
 * this tier means "not deletable". The `~/.zshrc`, `~/.gitconfig`, `~/.zprofile` deleted in the second
 * 2026-09-23 incident are in this tier.
 *
 * Only **home level-1** entries (`~/.zshrc`) are listed, non-recursive — `~/projects/.zshrc` is a project
 * file and must not be treated as never-delete.
 *
 * On 2026-09-25 a batch of generic names was added — **not yet present on this machine but by convention
 * also identity / credentials / hand-written configs** (`.bash_history`, `.hgrc`, `.envrc`,
 * `.tool-versions`, `.yarnrc`, `.bunfig.toml`, `.boto`, `.s3cfg`…): the list is **preventive**; adding
 * entries after the file appears is too late — the `~/.zprofile` deleted on incident day was likewise a
 * "only one on this machine" file.
 */
export const NEVER_DELETE_HOME_FILES: readonly string[] = [
	// shell startup files
	".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout",
	".bashrc", ".bash_profile", ".bash_login", ".bash_logout",
	".profile", ".cshrc", ".login", ".hushlogin",
	// git / VCS
	".gitconfig", ".git-credentials", ".gitattributes", ".gitignore", ".hgrc",
	// credentials
	".netrc", ".npmrc", ".pgpass", ".my.cnf", ".pypirc", ".vault-token", ".terraformrc",
	".boto", ".s3cfg",
	// shell / tool configuration
	".inputrc", ".editorconfig", ".tmux.conf", ".screenrc", ".vimrc",
	".curlrc", ".wgetrc", ".gemrc", ".irbrc", ".pryrc", ".pythonrc",
	".Rprofile", ".Renviron", ".condarc",
	// hand-written config of version / package managers
	".tool-versions", ".yarnrc", ".yarnrc.yml", ".bunfig.toml",
	// direnv (often contains secrets exported into the environment)
	".envrc",
	// AI / agent
	".claude.json",
	// environment
	".env",
	// shell history: irreplaceable once lost, and often contains ad-hoc pasted tokens
	".bash_history",
];

/**
 * Directories of the "never delete" tier (subtree semantics): `~/.ssh/id_rsa`, `~/.aws/credentials` are
 * all blocked.
 *
 * **Deliberately not listed** (user, 2026-09-25): `~/.config`, `~/.pi`, `~/.claude`, `~/.codex`.
 * These four are **tool state directories**, containing both hand-written config and lots of routine
 * derivatives to clean up (`trust.json.lock`, `settings.json.lock`, caches, session logs) — denying the
 * whole subtree would even kernel-block pi's own stale-lock cleanup with EPERM (verified: `pi update
 * --extensions` exited 1 because of it). They go through the "ordinary outside" tier: prompt,
 * rememberable directory, no more prompts after remembering.
 *
 * The cost, spelled out: `~/.pi/agent/extensions`, `~/.pi/agent/AGENTS.md`, `sessions/`, `rewind/`,
 * `sandbox-allowlist.json` also live in these four subtrees, so the guard's self-protection degrades
 * from "unconditional kernel block" to "prompt + explicit user consent". The project-directory
 * exemption (no blocked verdict when cwd is underneath) is an existing policy and unaffected.
 *
 * **Names may contain slashes** (`neverDeletePaths` just joins the name under home and resolves), so
 * tools that sink credentials two levels deep get named by nested entries: `.config/gh` (`hosts.yml`
 * holds the GitHub token), `.config/gcloud` (`credentials.db` / `application_default_credentials.json`).
 * After 2026-09-25's "the whole `~/.config` subtree moved out of this tier", this is the only way to
 * pull real credentials under `~/.config` back — the cost is that `isSafeAllowlistRoot`'s ancestor gate
 * must only apply to the **dangerous** tier, otherwise `~/.config` could never be remembered for being
 * "an ancestor of `~/.config/gh`" (user choice, 2026-09-25). Security is unaffected: the kernel deny
 * line unconditionally revokes after the allow lines, so remembering `~/.config` cannot yield
 * `~/.config/gh`; `classifyOutsidePaths` likewise checks blocked before the allowlist.
 */
export const NEVER_DELETE_HOME_DIRS: readonly string[] = [
	// credentials / identity
	".ssh", ".gnupg", ".aws", ".kube", ".docker",
	// cloud-vendor CLI credentials and config
	".azure", ".gcloud", ".terraform.d", ".helm", ".minikube",
	// password store
	".password-store",
	// tools that sink credentials two levels under ~/.config (nested entries, see the docstring above)
	".config/gh", ".config/gcloud",
	// AI / agent
	".agents", ".copilot", ".iflow", ".lingma",
	".aone_copilot", ".aone-copilot-preview", ".codex-claude-proxy", ".cursor-tutor",
];

/**
 * Regenerable caches: deleting them lets them be cleanly rebuilt, so they go **inside** the writable
 * boundary (silently allowed, no prompt). User policy set on 2026-09-24. Home-relative paths;
 * `writableRoots` resolves them to absolute.
 *
 * Deliberately **not** listed: `Library/pnpm/store` (where pi itself is installed), `.deno` (contains
 * bin), `.nvm` (contains installed Node versions), `.gem` / `.bundle` (small and mixed) — deleting them
 * cannot be cleanly rebuilt.
 */
export const SAFE_CACHE_HOME_DIRS: readonly string[] = [
	".cache",
	".npm",
	".gradle/caches",
	".m2/repository",
	".cargo/registry",
	".bun/install/cache",
	".node-gyp",
	".Trash",
	"Library/Caches",
	"Library/Developer/Xcode/DerivedData",
];

/** Directory names of version-control storage: **any component** of a path being one makes it dangerous (deleting it loses one-of-a-kind history). */
export const VCS_DIR_NAMES: readonly string[] = [".git", ".hg", ".svn"];

/**
 * Shallowest depth allowed for an allowlist root (component count of the absolute path).
 *
 * `/` = 0, `/Users` = 1, `/Users/bachi` = 2, `/Users/bachi/Downloads` = 3.
 * Capping at 3 makes "remember the parent directory" **never** degenerate into remembering `$HOME` or
 * shallower — `$HOME` (`/Users/bachi`, 2 components) is itself on the dangerous list, and this is the
 * second safety net (still holds if the list is later changed). A direct child of `$HOME`
 * (`~/Downloads`, 3 components) just passes the gate — exactly the width the core use case
 * "delete ~/Downloads/x, remember ~/Downloads" needs.
 */
export const MIN_ALLOWLIST_DEPTH = 3;

/**
 * Signature strings in command output when the sandbox denies a deletion.
 *
 * Seatbelt denial is `EPERM` (`Operation not permitted`). Deliberately does **not** match
 * `Permission denied` — that is `EACCES`, from file permission bits rather than the sandbox; using it
 * as an escalation signal would misreport "this file was never permitted" as "the sandbox blocked it".
 */
const SANDBOX_DENIAL_PATTERNS: readonly RegExp[] = [/Operation not permitted/i, /\bEPERM\b/];

/** Fixed title of the escalation dialog (same as `destructive-guard`: the title does not vary with the command). */
export const ESCALATION_TITLE = "Sandbox blocked deletion outside the permitted boundary";

/**
 * Whether command output looks like "the sandbox denied a deletion".
 *
 * Only meaningful when the command **already failed**: these words appearing in a successful command's
 * output (e.g. `grep "Operation not permitted"`) must not trigger escalation.
 */
export function looksLikeSandboxDenial(output: string): boolean {
	if (!output) return false;
	return SANDBOX_DENIAL_PATTERNS.some((re) => re.test(output));
}

/**
 * Parse `PI_SANDBOX_EXTRA_WRITE`: colon-separated (like `PATH`); each entry gets `~` expanded and is
 * resolved to an absolute path.
 *
 * Empty and whitespace-only items are dropped. Relative paths resolve against `cwd` — writing
 * `../shared` in the config is a reasonable intent and must not be silently ignored.
 */
export function parseExtraWrites(raw: string | undefined, cwd: string): string[] {
	if (!raw) return [];
	const out: string[] = [];
	for (const item of raw.split(":")) {
		const trimmed = item.trim();
		if (!trimmed) continue;
		out.push(resolveAgainst(trimmed, cwd));
	}
	return out;
}

/** Expand `~` and resolve relative paths against `cwd` into absolute paths. */
export function resolveAgainst(target: string, cwd: string): string {
	if (target === "~") return homedir();
	if (target.startsWith("~/")) return resolvePath(homedir(), target.slice(2));
	if (isAbsolute(target)) return resolvePath(target);
	return resolvePath(cwd, target);
}

/** Construct a boundary object. `extraWrites` are resolved to absolute paths. */
export function makeBoundary(cwd: string, extraWrites: readonly string[] = []): WriteBoundary {
	const resolvedCwd = resolvePath(cwd || process.cwd());
	return {
		cwd: resolvedCwd,
		extraWrites: extraWrites.map((p) => resolveAgainst(p, resolvedCwd)),
	};
}

/**
 * All writable roots: project directory + temp directories + regenerable caches + explicit extra paths.
 *
 * Regenerable caches (`SAFE_CACHE_HOME_DIRS`) are resolved to absolute paths via `homedir()` —
 * the same `homedir()` `makeBoundary` uses, keeping the policy consistent.
 */
export function writableRoots(boundary: WriteBoundary): string[] {
	const home = stripTrailingSlash(homedir());
	const cacheRoots = SAFE_CACHE_HOME_DIRS.map((rel) => `${home}/${rel}`);
	return [boundary.cwd, ...TEMP_WRITE_ROOTS, ...cacheRoots, ...boundary.extraWrites];
}

/**
 * Absolute forms of the "never delete" paths (home level-1 files + directory subtree roots + nested
 * entries like `.config/gh`).
 *
 * Entries with slashes in the name work too: joined under home and `resolvePath`ed into a two-level
 * absolute path.
 *
 * Shared by three places: `classifyOutsidePaths`' `blocked` tier, `buildSeatbeltProfile`'s deny line,
 * and `isSafeAllowlistRoot`'s allowlist gate — one table, so the policies cannot drift.
 *
 * `home` is injectable (same policy as `dangerousRoots(env)`); `homedir()` is used when not passed.
 */
export function neverDeletePaths(home: string = homedir()): string[] {
	const base = stripTrailingSlash(resolvePath(home));
	return [...NEVER_DELETE_HOME_FILES, ...NEVER_DELETE_HOME_DIRS].map((name) =>
		stripTrailingSlash(resolvePath(`${base}/${name}`)),
	);
}

/**
 * Whether a target is a "never delete" path: equal to a listed entry or under its subtree.
 *
 * Same dual-form check as `dangerousReasonFor` (lexical + realpath), so symlink escapes like
 * `~/link → ~/.ssh` are still caught.
 */
export function neverDeleteReasonFor(target: string, env: PathEnv): string | undefined {
	const roots = neverDeletePaths(env.home);
	const forms = [stripTrailingSlash(resolvePath(target))];
	const real = env.realpath?.(target);
	if (real) {
		const resolvedReal = stripTrailingSlash(resolvePath(real));
		if (!forms.includes(resolvedReal)) forms.push(resolvedReal);
	}
	for (const form of forms) {
		for (const root of roots) {
			if (form === root) return `${form} is protected identity, credential, or manually maintained configuration data`;
			if (form.startsWith(`${root}/`)) return `${form} is inside the protected path ${root}`;
		}
	}
	return undefined;
}

/**
 * Whether a target path falls inside the boundary (`target` equals a writable root or sits under one).
 *
 * Inside = deletable directly; outside = deletion needs confirmation (enforced on the bash side by
 * kernel EPERM).
 *
 * This is an **allowlist** check: not on the list means outside — no "dangerous paths" need enumerating.
 * Both sides are resolved to absolute paths with trailing slashes stripped before comparing, so `/tmp/`
 * and `/tmp` are not judged as two places.
 */
export function isPathInWriteBoundary(target: string, boundary: WriteBoundary): boolean {
	return isUnderRoots(target, writableRoots(boundary), boundary.cwd);
}

/** Whether `target` equals one of `roots` or sits under it. Both sides are resolved to absolute and trailing slashes stripped. */
export function isUnderRoots(target: string, roots: readonly string[], cwd: string): boolean {
	const resolved = stripTrailingSlash(resolveAgainst(target, cwd));
	return roots.some((root) => {
		const r = stripTrailingSlash(resolvePath(root));
		return resolved === r || resolved.startsWith(r + "/");
	});
}

/** Environment needed for path classification. `realpath` / `isDirectory` are IO, injected by the caller; this module stays pure logic. */
export interface PathEnv {
	readonly home: string;
	/** Resolve symlinks. When omitted, only lexical checks run (escapes like `~/link → /etc` go unseen). */
	readonly realpath?: (path: string) => string | undefined;
	/** Whether the target is a directory. When omitted, everything is treated as a file (remember the parent directory — wider scope, still bounded by the depth/danger rules). */
	readonly isDirectory?: (path: string) => boolean;
}

/**
 * Dangerous paths under the current environment, in two tiers (see the `DANGEROUS_ROOTS` file header).
 *
 * - `subtree`: it **and everything under it** is dangerous.
 * - `exact`: only itself is dangerous; subpaths are judged separately (`$HOME`, `/`, `/Users`).
 */
export interface DangerousTables {
	readonly subtree: readonly string[];
	readonly exact: readonly string[];
}

export function dangerousRoots(env: PathEnv): DangerousTables {
	const home = stripTrailingSlash(resolvePath(env.home));
	return {
		subtree: [...DANGEROUS_ROOTS, ...DANGEROUS_HOME_DIRS.map((name) => `${home}/${name}`)].map((p) =>
			stripTrailingSlash(resolvePath(p)),
		),
		exact: [...DANGEROUS_EXACT, home].map((p) => stripTrailingSlash(resolvePath(p))),
	};
}

/**
 * Why a target is dangerous; `undefined` when it is not.
 *
 * Three hit shapes:
 * 1. Equals a dangerous root or sits under its subtree (`/usr/local/bin/tsc` → `/usr/local`);
 * 2. **Any component** of the path is `.git` / `.hg` / `.svn` (`~/projects/x/.git` is dangerous anywhere);
 * 3. When `realpath` is provided, the symlink-resolved form hits 1 or 2 (`~/link → /etc`).
 *
 * Both the lexical and the realpath forms are **checked**, and the more dangerous verdict wins — lexical
 * alone misses link escapes; realpath alone misses targets already deleted (realpath fails).
 */
export function dangerousReasonFor(target: string, env: PathEnv): string | undefined {
	const tables = dangerousRoots(env);
	const forms = [stripTrailingSlash(resolvePath(target))];
	const real = env.realpath?.(target);
	if (real) {
		const resolvedReal = stripTrailingSlash(resolvePath(real));
		if (!forms.includes(resolvedReal)) forms.push(resolvedReal);
	}

	for (const form of forms) {
		for (const root of tables.exact) {
			if (form === root) return `${form} is itself a protected high-risk path`;
		}
		for (const root of tables.subtree) {
			if (form === root) return `${form} is itself a protected high-risk path`;
			if (form.startsWith(root + "/")) return `${form} is inside the high-risk path ${root}`;
		}
		const segments = form.split("/").filter(Boolean);
		const vcs = segments.find((s) => VCS_DIR_NAMES.includes(s));
		if (vcs) return `${form} contains version-control storage ${vcs} (deleting it loses the only copy of history)`;
	}
	return undefined;
}

/**
 * Whether this path can be persisted as an allowlist root.
 *
 * Four gates: component count ≥ `MIN_ALLOWLIST_DEPTH`, itself not dangerous, itself not a never-delete
 * path, and **not an ancestor of any dangerous path** (remembering `$HOME` would hand over `~/Library`
 * along with it). The same pass runs when loading the allowlist, so hand-edited or corrupted JSON
 * cannot smuggle `/` in.
 *
 * The ancestor gate **only applies to the dangerous tier**, not the never-delete tier (user choice
 * 2026-09-25): once the never-delete list has nested entries (`.config/gh`, `.config/gcloud`), checking
 * it in the ancestor gate would make `~/.config` unrememberable for being "an ancestor of
 * `~/.config/gh`", overturning the "`~/.config` is ordinary tier, rememberable" decision. No security
 * loss: the kernel deny line unconditionally revokes the never-delete subtree after the allow lines,
 * and `classifyOutsidePaths` checks blocked before the allowlist — remembering `~/.config` cannot yield
 * `~/.config/gh`. The dangerous tier still needs the ancestor gate: dangerous roots have no kernel deny
 * line as backstop, so the allowlist is the only defense.
 */
export function isSafeAllowlistRoot(path: string, env: PathEnv): boolean {
	const resolved = stripTrailingSlash(resolvePath(path));
	if (componentCount(resolved) < MIN_ALLOWLIST_DEPTH) return false;
	if (dangerousReasonFor(resolved, env)) return false;
	if (neverDeleteReasonFor(resolved, env)) return false;
	// Must not be an **ancestor** of any dangerous path: remembering `$HOME` would hand `~/Library` over with it.
	// Never-delete paths are not checked here — see the docstring above (nested entries conflict with rememberable ~/.config).
	const tables = dangerousRoots(env);
	const all = [...tables.subtree, ...tables.exact];
	return !all.some((root) => root !== resolved && root.startsWith(resolved + "/"));
}

/** Component count of an absolute path: `/` = 0, `/Users` = 1, `/Users/bachi` = 2. */
export function componentCount(resolved: string): number {
	return resolved.split("/").filter(Boolean).length;
}

/**
 * How wide a scope "remember this delete" should record.
 *
 * Target is a directory → remember it itself (the user's "this directory is safe" means it);
 * target is a file → remember the parent directory (otherwise deleting a second file in the same
 * directory asks again and the feature is pointless).
 *
 * But the computed scope must pass `isSafeAllowlistRoot`: if it fails, **degrade to remembering only the
 * exact path**; if the exact path also fails, return `undefined` (nothing is remembered; only
 * session-level exemption remains). So confirming a delete of `~/.zshrc.bak` remembers only that one
 * file — never `$HOME`.
 */
export function memoryScopeFor(target: string, env: PathEnv, cwd = process.cwd()): string | undefined {
	const resolved = stripTrailingSlash(resolveAgainst(target, cwd));
	const isDir = env.isDirectory?.(resolved) ?? false;
	const preferred = isDir ? resolved : parentOf(resolved);
	if (preferred && isSafeAllowlistRoot(preferred, env)) return preferred;
	if (isSafeAllowlistRoot(resolved, env)) return resolved;
	return undefined;
}

function parentOf(resolved: string): string | undefined {
	const idx = resolved.lastIndexOf("/");
	if (idx <= 0) return undefined;
	return resolved.slice(0, idx);
}

/**
 * How wide a scope `Allow for this session` (dangerous-path branch, formerly "do not ask again this
 * session") should exempt.
 *
 * Difference from `memoryScopeFor`: session exemption is **not persisted** and dies on restart, so it can
 * be wider than the persistent allowlist — it may land **under** a dangerous subtree root (e.g.
 * `~/Library/Foo`), so after one exemption, sibling files in the same subdirectory do not ask again this
 * session (user policy: "no more prompts in the current session"). But a hard gate remains:
 *
 * - the scope cannot **itself be** a dangerous root / never-delete path (exempting `~/Library` hands over
 *   the whole preferences directory);
 * - the scope cannot be an **ancestor** of a dangerous root (exempting `$HOME` hands over `~/Library`);
 * - component count ≥ `MIN_ALLOWLIST_DEPTH`.
 *
 * Failing all three falls back to the **exact path** (only this one target exempted). So exempting a
 * delete of `~/Library/Foo/bar` records `~/Library/Foo`, but exempting `~/Library/x.plist` (whose parent
 * `~/Library` is itself a dangerous root) only records that single file.
 *
 * Note: never-delete paths (`~/.zshrc`, `~/.ssh`…) go into `blocked` in `classifyOutsidePaths` and never
 * reach session exemption — the exact gate policy is in `isSafeSessionRoot`.
 */
export function sessionScopeFor(target: string, env: PathEnv, cwd = process.cwd()): string {
	const resolved = stripTrailingSlash(resolveAgainst(target, cwd));
	const isDir = env.isDirectory?.(resolved) ?? false;
	const preferred = isDir ? resolved : parentOf(resolved);
	if (preferred && isSafeSessionRoot(preferred, env)) return preferred;
	return resolved;
}

/**
 * Whether a session-exemption scope is usable: deep enough, itself neither a dangerous root nor a
 * never-delete path, and not an ancestor of a dangerous root.
 *
 * Unlike the persistent allowlist, landing **under** a dangerous subtree root is **allowed** here
 * (`~/Library/Foo` sits under `~/Library`) — session exemption is not persisted and dies on restart, so
 * being wider is safe; and that is exactly what `Allow for this session` means: after one exemption,
 * sibling files in the same subdirectory do not ask again.
 *
 * Never-delete paths have no exemption concept (the blocked tier never gets here), but the self-check is
 * still in the hard gate for consistency — a future caller misusing it will not silently hand over
 * `~/.ssh`. The ancestor gate only checks the dangerous tier (consistent with `isSafeAllowlistRoot`
 * after the 2026-09-25 change): the never-delete list has nested entries (`.config/gh`), and checking it
 * in the ancestor gate would kill `~/.config`'s session exemption too — while the kernel deny line
 * already blocks the never-delete subtree anyway.
 *
 * The depth gate matches the persistent allowlist: direct children of `$HOME` (`~/Downloads`, 2
 * components) pass; everything else is held to `MIN_ALLOWLIST_DEPTH`.
 */
function isSafeSessionRoot(path: string, env: PathEnv): boolean {
	const resolved = stripTrailingSlash(resolvePath(path));
	if (componentCount(resolved) < MIN_ALLOWLIST_DEPTH) return false;
	// Never-delete is **subtree** semantics: nothing under it can be exempted (`~/.config/gh/foo` counts,
	// but `~/.config/foo` does not — ~/.config itself has been ordinary tier since 2026-09-25).
	if (neverDeleteReasonFor(resolved, env)) return false;
	const tables = dangerousRoots(env);
	const all = [...tables.subtree, ...tables.exact];
	for (const root of all) {
		if (resolved === root) return false; // itself is a dangerous root (exempting ~/Library hands over the whole preferences directory)
		if (root.startsWith(resolved + "/")) return false; // ancestor of a dangerous root (exempting $HOME hands over ~/Library)
	}
	return true;
}

/**
 * Signature string of heredoc temp-file failures (exclusion 1).
 *
 * macOS's bundled bash 3.2 heredoc implementation must create a temp file and then unlink it
 * (delete-on-open), and that temp directory is **hardcoded at compile time to `/var/tmp`**
 * (`strings /bin/bash` contains only `/var/tmp/` and `sh-thd`; changing `TMPDIR` is ineffective).
 * This failure itself disappeared once `/var/tmp` entered the writable boundary, but the exclusion is
 * kept: it is not deleting user data and should not trigger a delete confirmation.
 */
const HERE_DOCUMENT_RE = /here[\s-]*document/i;

/**
 * Lines whose leading prog token is a shell or `sandbox-exec` are skipped entirely (exclusion 2).
 *
 * An EPERM reported by the shell itself is an **exec failure** (setuid / platform binaries like
 * `/bin/ps`, `/usr/bin/top`), not an unlink; the only thing bash unlinks is the heredoc temp file,
 * already covered by exclusion 1. `sandbox-exec: sandbox_apply: Operation not permitted` is a nested
 * sandbox being unavailable — likewise not a deletion. With or without a path prefix (`bash:` and
 * `/bin/bash:` are the same program).
 */
const SHELL_PROG_RE = /^(?:\/[\w./+-]+\/)?(bash|sh|zsh|dash|ksh|csh|tcsh|fish|sandbox-exec)$/i;

/**
 * Extract the paths the sandbox blocked from a **failed** command's output.
 *
 * The kernel only gives `EPERM` and never says who was denied — remembering by directory presumes we can
 * recognize paths in stderr. Only lines containing `Operation not permitted` / `EPERM` are scanned
 * (these words in a successful command's output must not trigger anything).
 *
 * ## Exclusion, not allowlist (user decision 2026-09-24)
 *
 * An allowlist of "only recognize program names like `rm|rmdir|unlink|…`" was considered; in practice it
 * **silently drops** three real deletion shapes — exactly the "script-driven out-of-boundary deletes"
 * this mechanism exists to catch:
 *
 * - `PermissionError: [Errno 1] Operation not permitted: '/p'` (python3: the path comes **after** the
 *   EPERM with no `cannot`, and the prog token is `PermissionError`, not `python3` — both regexes miss it)
 * - `find: /p: Operation not permitted` (`find -delete` / `-exec rm`)
 * - `ln: /p: Operation not permitted` (`ln -sf` overwrite = unlink on the target)
 *
 * An allowlist's essence is "enumerate deleting programs", which can never be complete. So a
 * **fallback scan** is kept, excluding only the known false-positive sources (coverage only grows).
 *
 * ## Per-line decision order
 *
 * 1. No `Operation not permitted` / `EPERM` → skip
 * 2. **Exclusion 1**: contains `here document` → skip the line (**per line**, not global — in a
 *    `;`-chained command like `cat <<EOF …; rm /outside`, the real delete line is still extracted)
 * 3. **Exclusion 2**: leading prog is a shell / `sandbox-exec` → skip the line
 * 4. `mv: rename A to B: …` / `sed: rename(A to B): …` → take the **source** A (the unlink lands on it)
 * 5. GNU `rm: cannot remove 'X': …` / `unlink: cannot unlink 'X': …` → take the quoted X
 * 6. BSD `rm: X: …` / `rmdir: X: …` → take the **single token** after the program name (`(\S+?)`,
 *    no spaces — the old `(.+?)` also swallowed the middle of `find: /p/a: cannot unlink:`)
 * 7. **Fallback**: every token on the line that looks like an absolute path (covers rvm's `errno=1`
 *    shapes, `ruby: … @ apply2files - /p`, `xargs: rm: /p`, node's `EPERM … unlink '/p'`,
 *    git's `unable to unlink '/p'`)
 *
 * When 4-6 extract nothing there is **no more `continue`** — fall through to the fallback; the old
 * implementation's `continue` is exactly why `bash: line 0: /usr/bin/top` returned empty instead of
 * reaching the fallback extraction.
 *
 * **When no path can be extracted, return an empty array** — the caller then **shows no dialog**, returns
 * the failure output unchanged plus a `[sandbox]` hint line. When the target cannot be guessed, the
 * memory logic must not run — same policy as AGENTS.md's "Never derive a delete target".
 *
 * A wrong extraction still cannot pass silently: the dialog lists these paths verbatim for the user, and
 * nothing is persisted before confirmation.
 */
export function extractDeniedPaths(output: string): string[] {
	if (!output) return [];
	const found: string[] = [];
	/** Returns whether a legal absolute path was actually extracted (decides whether to continue to the fallback). */
	const push = (candidate: string | undefined): boolean => {
		const cleaned = cleanExtractedPath(candidate);
		if (!cleaned) return false;
		if (!found.includes(cleaned)) found.push(cleaned);
		return true;
	};

	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		if (!SANDBOX_DENIAL_PATTERNS.some((re) => re.test(line))) continue;
		if (HERE_DOCUMENT_RE.test(line)) continue; // exclusion 1

		const prog = /^([\w.+-]+|\/[\w./+-]+):/.exec(line)?.[1];
		if (prog && SHELL_PROG_RE.test(prog)) continue; // exclusion 2

		// rename A to B — mv / sed -i / git writing refs all have this shape; the unlink lands on the source
		const rename = /rename[\s(]+(.+?)\s+to\s+(.+?)[\s)]*[:：]?\s*(?:Operation not permitted|EPERM)/i.exec(line);
		if (rename?.[1] && push(rename[1])) continue;

		// GNU: cannot remove '/path': …
		const quoted = /cannot\s+\w+\s+'([^']+)'/.exec(line);
		if (quoted?.[1] && push(quoted[1])) continue;

		// BSD: prog: /path: Operation not permitted — the capture takes a single token; on failure it falls to the fallback
		const bsd = /^[\w./+-]+:\s*(\S+?)\s*[:：]\s*(?:Operation not permitted|EPERM)/i.exec(line);
		if (bsd?.[1] && push(bsd[1])) continue;

		// fallback: every absolute-path token on the line
		for (const token of line.split(/\s+/)) push(token);
	}
	return found;
}

/**
 * Strip wrapping quotes and edge punctuation, keeping only absolute paths starting with `/` and longer
 * than 1.
 *
 * Whitespace / quotes / punctuation at both ends are stripped in one pass: the old implementation
 * stripped quotes first then punctuation, leaving a trailing quote on the "quote inside punctuation"
 * shape `'…lock':` (extracted as `/p'`).
 */
function cleanExtractedPath(candidate: string | undefined): string | undefined {
	if (!candidate) return undefined;
	const value = candidate.trim().replace(/^[\s'"`,;:]+|[\s'"`,;:]+$/g, "");
	if (!value.startsWith("/") || value.length <= 1) return undefined;
	return stripTrailingSlash(value);
}

/** Result of `classifyOutsidePaths`: five mutually exclusive tiers; the caller decides whether to prompt and which kind. */
export interface PathClassification {
	/** Never delete → refuse outright; no prompt, no override option. Carries the hit reason. */
	readonly blocked: ReadonlyArray<{ path: string; reason: string }>;
	/** Already covered by the persistent allowlist or a session exemption → pass silently, no prompt. */
	readonly covered: string[];
	/** Dangerous → ask every time; only session-level exemption. Carries the hit reason for display in the prompt. */
	readonly dangerous: ReadonlyArray<{ path: string; reason: string }>;
	/** Ordinary outside → ask once; on approval it can be remembered permanently. */
	readonly ordinary: string[];
	/** Inside the boundary → deletable anyway; should never prompt (listed only so the caller can assert). */
	readonly inside: string[];
}

/**
 * Classify a batch of delete targets into five tiers. This is the decision core **shared** by the bash
 * path and the `apply_patch` path, so the two sides' policies cannot drift.
 *
 * Order matters:
 *
 * 1. **Never delete** (`blocked`) is checked first, **before the boundary** — otherwise
 *    `PI_SANDBOX_EXTRA_WRITE=~/.ssh` or a hand-inserted `~/.ssh` in the allowlist would turn the
 *    credential directory deletable. With one exception: **nothing under the project directory
 *    (`boundary.cwd`) gets a blocked verdict** — otherwise, working in a project like
 *    `~/.pi/agent/extensions/x` that itself sits inside a never-delete directory would block deleting
 *    the project's own files (the project directory is inside the writable boundary by definition — an
 *    existing policy).
 * 2. Inside the boundary passes directly (`/private/tmp` is under `/private` but inside the boundary;
 *    `~/.cache` likewise).
 * 3. Then already-authorized, and only then dangerous / ordinary.
 *
 * The auto-pass policy is "**all** hit", not "any hit": the caller may skip the prompt only when
 * `blocked`, `dangerous`, and `ordinary` are all empty — otherwise `rm authorized-dir unauthorized-dir`
 * would silently pass on the former and let the latter run unguarded.
 */
export function classifyOutsidePaths(
	paths: readonly string[],
	opts: {
		readonly boundary: WriteBoundary;
		/** Persistent allowlist roots (`sandbox-allowlist.json`). */
		readonly allowedRoots: readonly string[];
		/** Session-level exemption roots (`Allow for this session` on dangerous directories). */
		readonly sessionRoots: readonly string[];
		readonly env: PathEnv;
	},
): PathClassification {
	const blocked: Array<{ path: string; reason: string }> = [];
	const covered: string[] = [];
	const dangerous: Array<{ path: string; reason: string }> = [];
	const ordinary: string[] = [];
	const inside: string[] = [];
	const seen = new Set<string>();
	const cwd = stripTrailingSlash(resolvePath(opts.boundary.cwd));

	for (const raw of paths) {
		const resolved = stripTrailingSlash(resolveAgainst(raw, opts.boundary.cwd));
		if (seen.has(resolved)) continue;
		seen.add(resolved);

		// Nothing under the project directory gets a never-delete verdict (see order note 1 above).
		const inProject = resolved === cwd || resolved.startsWith(`${cwd}/`);
		if (!inProject) {
			const neverReason = neverDeleteReasonFor(resolved, opts.env);
			if (neverReason) {
				blocked.push({ path: resolved, reason: neverReason });
				continue;
			}
		}

		if (isPathInWriteBoundary(resolved, opts.boundary)) {
			inside.push(resolved);
			continue;
		}
		// Session exemption beats the dangerous check: the user already explicitly said "stop asking" this session.
		if (isUnderRoots(resolved, opts.sessionRoots, opts.boundary.cwd)) {
			covered.push(resolved);
			continue;
		}
		if (isUnderRoots(resolved, opts.allowedRoots, opts.boundary.cwd)) {
			covered.push(resolved);
			continue;
		}
		const reason = dangerousReasonFor(resolved, opts.env);
		if (reason) dangerous.push({ path: resolved, reason });
		else ordinary.push(resolved);
	}

	return { blocked, covered, dangerous, ordinary, inside };
}

/** Reduce a batch of targets into directory scopes worth remembering (deduped; scopes failing the safety check are dropped). */
export function memoryScopesFor(paths: readonly string[], env: PathEnv, cwd = process.cwd()): string[] {
	const out: string[] = [];
	for (const p of paths) {
		const scope = memoryScopeFor(p, env, cwd);
		if (scope && !out.includes(scope)) out.push(scope);
	}
	return out;
}

/**
 * Generate a seatbelt profile.
 *
 * The shape is `deny default` as the base, then itemized allows — order matters: in seatbelt **later
 * rules override earlier ones**, so "allow globally → revoke locally" is this profile's whole trick.
 *
 * Capabilities granted:
 * - `file-read*` fully allowed (reads unrestricted)
 * - `network*` fully allowed (egress unrestricted)
 * - `process-fork` / `process-exec` / `signal`: run subcommands, `kill` own process group
 * - `sysctl-read` / `mach-lookup` / `ipc-posix*`: nearly every program needs these to start
 * - `file-write*` **fully allowed** (writes unrestricted — user policy 2026-09-24)
 *
 * The only capability revoked:
 * - `file-write-unlink` is `deny`ed globally, then `allow`ed only for the writable roots. So
 *   out-of-boundary `rm` / `rmdir` (and all renames, see the file header) get `EPERM`; in-boundary
 *   deletes work normally.
 *
 * `extraUnlinkRoots` is the injection point for the two authorization layers: persistent-allowlist and
 * session-exemption directories join the same `(allow file-write-unlink …)` line here — remembering a
 * directory widens that line, the delete succeeds inside the sandbox, and the rest of the command stays
 * sandboxed.
 *
 * **Never-delete paths get their own `deny` line after the allow lines** (`neverDeletePaths()`): later
 * seatbelt rules override earlier ones, so even if some allow root is their ancestor
 * (`PI_SANDBOX_EXTRA_WRITE=$HOME`, or a hand-inserted `~/.ssh` in the allowlist), those subtrees remain
 * kernel-blocked with `EPERM` — the kernel-level enforcement behind "no override option", from the same
 * table as `classifyOutsidePaths`' `blocked` tier.
 *
 * One exception: **when the project directory (`boundary.cwd`) sits under a never-delete path, that path
 * is left out of the deny line** — otherwise, working in a project like `~/.pi/agent/extensions/x`
 * would block deleting the project's own files (the project directory is inside the writable boundary
 * by definition — an existing policy). SBPL nested filters are not used to express "deny the whole tree
 * but carve out cwd": this profile only uses constructs verified working in this environment
 * (`deny default` / `allow` / `deny` / `subpath` / `literal`) and introduces no syntax that cannot be
 * verified here.
 *
 * `file-write-data` / `file-write-mode` for device files (`/dev/null` etc.) are already covered by the
 * global `file-write*` and are not listed separately; `file-ioctl` is not part of `file-write*` and
 * still needs an explicit allow (tty operations need it).
 */
export function buildSeatbeltProfile(boundary: WriteBoundary, extraUnlinkRoots: readonly string[] = []): string {
	const unlinkSubpaths = [...writableRoots(boundary), ...extraUnlinkRoots]
		.map((root) => stripTrailingSlash(resolvePath(root)))
		.filter((root, index, all) => all.indexOf(root) === index)
		.map((root) => `(subpath ${quoteSb(root)})`);

	// Never-delete: skip the entry that the project directory sits under (see the exception in the docstring above).
	// Each entry emits both `literal` and `subpath`: `subpath` is deterministic for **directories** (it and everything under it),
	// while for **files** (`~/.zshrc`) whether it matches the file itself has no authoritative documentation, so a `literal`
	// pins the exact path — both are deny, writing both changes nothing but removes the uncertainty.
	const cwd = stripTrailingSlash(resolvePath(boundary.cwd));
	const neverDeleteFilters = neverDeletePaths()
		.filter((root) => !(cwd === root || cwd.startsWith(`${root}/`)))
		.map((root) => `(literal ${quoteSb(root)})(subpath ${quoteSb(root)})`);

	const deviceLiterals = ["/dev/null", "/dev/zero", "/dev/tty", "/dev/urandom", "/dev/random", "/dev/dtracehelper"]
		.map((dev) => `(literal ${quoteSb(dev)})`)
		.join("");

	return [
		"(version 1)",
		"(deny default)",
		"(allow process-fork)",
		"(allow process-exec)",
		"(allow signal)",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow ipc-posix*)",
		"(allow file-read*)",
		"(allow network*)",
		"(allow file-write*)",
		"(deny file-write-unlink)",
		`(allow file-write-unlink ${unlinkSubpaths.join("")})`,
		// Never-delete: revoked after the allow lines (seatbelt later-overrides-earlier). The line is omitted when the list is empty.
		...(neverDeleteFilters.length > 0 ? [`(deny file-write-unlink ${neverDeleteFilters.join("")})`] : []),
		`(allow file-ioctl ${deviceLiterals})`,
	].join("\n");
}

/**
 * Wrap a command in the sandbox.
 *
 * The profile is passed inline via `-p` (never written to disk): a temp file would introduce new
 * questions of "who cleans it up" and "where does cleanup delete" — exactly the class of problem this
 * extension exists to eliminate. Command and profile are both single-quote escaped safely.
 */
export function wrapWithSandbox(command: string, profile: string, shellPath = "/bin/bash"): string {
	return `sandbox-exec -p ${shellQuote(profile)} ${shellQuote(shellPath)} -c ${shellQuote(command)}`;
}

/** String literal inside a seatbelt profile: wrapped in double quotes, escaping `\` and `"`. */
function quoteSb(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Shell single-quote wrapping: inner `'` becomes `'\''` (the POSIX standard; no backslash escaping needed). */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function stripTrailingSlash(p: string): string {
	return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Whether the sandbox is usable (platform + switch).
 *
 * `PI_SANDBOX=off` disables it entirely. Non-darwin platforms have no `sandbox-exec` and disable it too
 * — better to lose this layer than to fail every command on Linux with a missing binary.
 */
export function isSandboxEnabled(env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
	if (env.PI_SANDBOX?.trim().toLowerCase() === "off") return false;
	return platform === "darwin";
}

/** Build a boundary from the environment (`PI_SANDBOX_EXTRA_WRITE` + cwd). */
export function boundaryFromEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): WriteBoundary {
	return makeBoundary(cwd, parseExtraWrites(env.PI_SANDBOX_EXTRA_WRITE, cwd));
}
