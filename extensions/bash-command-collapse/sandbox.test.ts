/**
 * Tests for the seatbelt capability boundary (sandbox.ts) — pure-logic unit tests, no pi needed.
 *
 * Run with:  node --test clients/pi/extensions/bash-command-collapse/sandbox.test.ts
 *
 * What is asserted:
 *   - profile shape: deny default as base, file-write* / network* / process etc. allowed,
 *     file-write-unlink revoked globally then allowed only for the writable roots;
 *   - boundary checks: cwd / temp roots / regenerable caches are inside; $HOME dotfiles and system
 *     roots are outside;
 *   - never-delete tier: identity / credentials / hand-written configs blocked, same-name files in
 *     projects unaffected;
 *   - dangerous tier: system roots / ~/Library / any-path-.git, ask every time, session-exemptable;
 *   - ordinary outside tier: ask once, then rememberable;
 *   - memoryScopeFor / sessionScopeFor scope computation and their safety gates;
 *   - extractDeniedPaths: per-line exclusion + fallback scan over real failure shapes;
 *   - classifyOutsidePaths: five mutually exclusive tiers, order matters (blocked before boundary).
 */

import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import {
	ESCALATION_TITLE,
	MIN_ALLOWLIST_DEPTH,
	NEVER_DELETE_HOME_DIRS,
	NEVER_DELETE_HOME_FILES,
	SAFE_CACHE_HOME_DIRS,
	TEMP_WRITE_ROOTS,
	buildSeatbeltProfile,
	boundaryFromEnv,
	classifyOutsidePaths,
	componentCount,
	dangerousReasonFor,
	dangerousRoots,
	extractDeniedPaths,
	isPathInWriteBoundary,
	isSafeAllowlistRoot,
	isSandboxEnabled,
	looksLikeSandboxDenial,
	makeBoundary,
	memoryScopeFor,
	memoryScopesFor,
	neverDeletePaths,
	neverDeleteReasonFor,
	parseExtraWrites,
	resolveAgainst,
	sessionScopeFor,
	shellQuote,
	wrapWithSandbox,
	writableRoots,
} from "./sandbox.ts";

const CWD = "/Users/someone/project";
const HOME = os.homedir();

test("profile is based on deny default, and allows read/write, network and process capabilities", () => {
	const profile = buildSeatbeltProfile(makeBoundary(CWD));
	const lines = profile.split("\n");
	assert.equal(lines[0], "(version 1)");
	assert.equal(lines[1], "(deny default)", "fail-closed: anything not explicitly allowed is denied");
	assert.ok(profile.includes("(allow file-read*)"), "reads unrestricted");
	assert.ok(profile.includes("(allow network*)"), "network fully open");
	assert.ok(profile.includes("(allow process-fork)"));
	assert.ok(profile.includes("(allow process-exec)"));
	assert.ok(profile.includes("(allow mach-lookup)"));
});

test("profile allows all writes; deletion allowed only for writable roots (global deny + local allow)", () => {
	const profile = buildSeatbeltProfile(makeBoundary(CWD, ["/Users/someone/.pm2"]));
	const lines = profile.split("\n");
	assert.ok(lines.includes("(allow file-write*)"), "writes unrestricted (user policy 2026-09-24)");
	assert.ok(lines.includes("(deny file-write-unlink)"), "deletion revoked globally first");
	const unlinkAllow = lines.find((l) => l.startsWith("(allow file-write-unlink "));
	assert.ok(unlinkAllow, "deletion then allowed for writable roots");
	// order: deny must come before allow — later seatbelt rules override earlier ones
	assert.ok(
		lines.indexOf("(deny file-write-unlink)") < lines.indexOf(unlinkAllow),
		"deny before allow, otherwise the global deny would be overridden and lost",
	);
	assert.ok(unlinkAllow.includes(`(subpath "${CWD}")`));
	for (const root of TEMP_WRITE_ROOTS) {
		assert.ok(unlinkAllow.includes(`(subpath "${root}")`), `missing temp root ${root}`);
	}
	assert.ok(unlinkAllow.includes('(subpath "/Users/someone/.pm2")'), "extra paths must enter the unlink allow list");
});

test("isPathInWriteBoundary: inside cwd and its subdirectories is inside", () => {
	const b = makeBoundary(CWD);
	assert.equal(isPathInWriteBoundary(`${CWD}/src/x.ts`, b), true);
	assert.equal(isPathInWriteBoundary(CWD, b), true, "cwd itself is writable");
	assert.equal(isPathInWriteBoundary("src/x.ts", b), true, "relative paths resolve against cwd");
	assert.equal(isPathInWriteBoundary(`${CWD}/`, b), true, "a trailing slash does not matter");
});

test("isPathInWriteBoundary: temp directories are inside (realpath forms included)", () => {
	const b = makeBoundary(CWD);
	assert.equal(isPathInWriteBoundary("/tmp/a", b), true);
	assert.equal(isPathInWriteBoundary("/private/tmp/a", b), true);
	assert.equal(isPathInWriteBoundary("/var/folders/x/y", b), true);
	assert.equal(isPathInWriteBoundary("/private/var/folders/x/y", b), true);
});

test("isPathInWriteBoundary: /var/tmp is inside (bash 3.2 heredoc temp dir, hardcoded at compile time)", () => {
	const b = makeBoundary(CWD);
	assert.equal(isPathInWriteBoundary("/var/tmp/sh-thd-12345", b), true);
	assert.equal(isPathInWriteBoundary("/private/var/tmp/sh-thd-12345", b), true);
	assert.ok(TEMP_WRITE_ROOTS.includes("/var/tmp"), "without /var/tmp every heredoc in the sandbox fails 100%");
	assert.ok(TEMP_WRITE_ROOTS.includes("/private/var/tmp"), "realpath forms must also be in the table");
});

test("isPathInWriteBoundary: $HOME global files and system directories are outside", () => {
	const b = makeBoundary(CWD);
	assert.equal(isPathInWriteBoundary(`${HOME}/.zshrc`, b), false);
	assert.equal(isPathInWriteBoundary(`${HOME}/.gitconfig`, b), false);
	assert.equal(isPathInWriteBoundary(`${HOME}/.pi/agent/sessions`, b), false);
	assert.equal(isPathInWriteBoundary("/usr/local/bin/tsc", b), false);
	assert.equal(isPathInWriteBoundary("/Users/someone-other/x", b), false, "a same-named prefix is not a subtree");
});

test("isPathInWriteBoundary: a prefix-named directory is not a subtree", () => {
	const b = makeBoundary("/Users/someone/project");
	assert.equal(isPathInWriteBoundary("/Users/someone/project-x/f", b), false);
});

test("extra write paths: ~ expansion and relative paths", () => {
	const b = makeBoundary(CWD, ["~/.pm2", "../shared"]);
	assert.equal(isPathInWriteBoundary(`${HOME}/.pm2/logs/out.log`, b), true);
	assert.equal(isPathInWriteBoundary("/Users/someone/shared/f", b), true);
});

test("parseExtraWrites: colon-separated, empty items dropped, ~ expanded", () => {
	const out = parseExtraWrites("~/.pm2::/opt/data:", CWD);
	assert.deepEqual(out, [`${HOME}/.pm2`, "/opt/data"]);
	assert.deepEqual(parseExtraWrites(undefined, CWD), []);
	assert.deepEqual(parseExtraWrites("", CWD), []);
});

test("resolveAgainst: ~ and ~/ expansion", () => {
	assert.equal(resolveAgainst("~", CWD), HOME);
	assert.equal(resolveAgainst("~/x", CWD), `${HOME}/x`);
	assert.equal(resolveAgainst("/abs", CWD), "/abs");
	assert.equal(resolveAgainst("rel", CWD), `${CWD}/rel`);
});

test("looksLikeSandboxDenial: only EPERM family, not EACCES", () => {
	assert.equal(looksLikeSandboxDenial("rm: /Users/x/.zshrc: Operation not permitted"), true);
	assert.equal(looksLikeSandboxDenial("Error: EPERM: operation not permitted, open '/x'"), true);
	assert.equal(looksLikeSandboxDenial("rm: /x: Permission denied"), false, "EACCES is not a sandbox denial");
	assert.equal(looksLikeSandboxDenial("hello world"), false);
	assert.equal(looksLikeSandboxDenial(""), false);
});

test("wrapWithSandbox: sandbox-exec -p wrapping, single-quote safe escaping", () => {
	const wrapped = wrapWithSandbox("echo 'hi'", "(version 1)", "/bin/bash");
	assert.ok(wrapped.startsWith("sandbox-exec -p '"), "profile inlined single-quoted, never on disk");
	assert.ok(wrapped.includes("/bin/bash' -c '"));
	// a single quote in the command must be escaped as '\'', never left bare to break the outer quoting
	assert.ok(wrapped.includes("echo '\\''hi'\\''"));
});

test("shellQuote: strings containing single quotes round-trip safely", () => {
	const tricky = "a'b\"c$d`e";
	assert.equal(shellQuote(tricky), `'a'\\''b"c$d`+"`"+`e'`);
});

test("isSandboxEnabled: PI_SANDBOX=off disables; non-darwin disables", () => {
	assert.equal(isSandboxEnabled({ PI_SANDBOX: "off" }, "darwin"), false);
	assert.equal(isSandboxEnabled({ PI_SANDBOX: "OFF" }, "darwin"), false);
	assert.equal(isSandboxEnabled({}, "darwin"), true);
	assert.equal(isSandboxEnabled({}, "linux"), false, "platforms without sandbox-exec stay off");
});

test("boundaryFromEnv: extra paths read from PI_SANDBOX_EXTRA_WRITE", () => {
	const b = boundaryFromEnv(CWD, { PI_SANDBOX_EXTRA_WRITE: "~/.pm2" });
	assert.equal(isPathInWriteBoundary(`${HOME}/.pm2/x`, b), true);
});

test("ESCALATION_TITLE is fixed text", () => {
	assert.equal(ESCALATION_TITLE, "Sandbox blocked deletion outside the permitted boundary");
});

/* ------------------------------------------------------------------ *
 * Two authorization layers (user decision 2026-09-24): dangerous directories ask every time
 * (session exemption only) + ordinary directories ask once then remember.
 * ------------------------------------------------------------------ */

const env = { home: HOME };

test("dangerousReasonFor: system roots, bin, app install dirs, package-manager prefixes are all dangerous", () => {
	assert.ok(dangerousReasonFor("/usr/local/bin/tsc", env));
	assert.ok(dangerousReasonFor("/opt/homebrew/bin/x", env));
	assert.ok(dangerousReasonFor("/Applications/Foo.app", env));
	assert.ok(dangerousReasonFor("/bin/ls", env));
	assert.ok(dangerousReasonFor("/System/Library/x", env));
	assert.ok(dangerousReasonFor("/private/etc/hosts", env));
	assert.ok(dangerousReasonFor("/Volumes/Backup/x", env));
	assert.ok(dangerousReasonFor("/", env), "the root itself");
	assert.ok(dangerousReasonFor("/Users", env), "Users root");
});

test("dangerousReasonFor: $HOME itself and ~/Library are dangerous, but ordinary subdirectories are not", () => {
	assert.ok(dangerousReasonFor(HOME, env), "$HOME itself is dangerous");
	assert.ok(dangerousReasonFor(`${HOME}/Library/Preferences/x.plist`, env), "~/Library is the dangerous tier (always ask, exemptable)");
	assert.equal(dangerousReasonFor(`${HOME}/.ssh/id_rsa`, env), undefined, "credential directories moved up to never-delete; no longer dangerous");
	assert.equal(dangerousReasonFor(`${HOME}/Downloads`, env), undefined, "ordinary directories are not dangerous");
	assert.equal(dangerousReasonFor(`${HOME}/projects/foo`, env), undefined);
});

test("neverDeleteReasonFor: identity/credentials/hand-written configs hit; same-name files in projects do not", () => {
	assert.ok(neverDeleteReasonFor(`${HOME}/.zshrc`, env), "the second incident deleted exactly this");
	assert.ok(neverDeleteReasonFor(`${HOME}/.gitconfig`, env));
	assert.ok(neverDeleteReasonFor(`${HOME}/.ssh/id_rsa`, env), "subtree semantics");
	assert.ok(neverDeleteReasonFor(`${HOME}/.gnupg/secring`, env));
	assert.equal(neverDeleteReasonFor(`${HOME}/.config/foo`, env), undefined, "user 2026-09-25: ~/.config left the never-delete tier");
	assert.equal(neverDeleteReasonFor(`${HOME}/.pi/agent/extensions`, env), undefined, "user 2026-09-25: ~/.pi left the never-delete tier (self-protection degraded to a prompt)");
	assert.equal(neverDeleteReasonFor(`${HOME}/.claude/x`, env), undefined, "user 2026-09-25: ~/.claude left the never-delete tier");
	assert.equal(neverDeleteReasonFor(`${HOME}/.codex/y`, env), undefined, "user 2026-09-25: ~/.codex left the never-delete tier");
	assert.ok(neverDeleteReasonFor(`${HOME}/.env`, env));
	assert.equal(neverDeleteReasonFor(`${HOME}/projects/.zshrc`, env), undefined, "a .zshrc in a project is not global config");
	assert.equal(neverDeleteReasonFor(`${HOME}/.zshrc.bak`, env), undefined, "exact name: the .bak suffix is not on the list");
	assert.equal(neverDeleteReasonFor(`${HOME}/Downloads`, env), undefined);
	assert.equal(neverDeleteReasonFor(`${HOME}/Library/Caches/x`, env), undefined, "caches are not on the never-delete list");
	// generic entries added on 2026-09-25 (may not exist on this machine — the list is preventive)
	assert.ok(neverDeleteReasonFor(`${HOME}/.bash_history`, env), "shell history is irreplaceable once lost");
	assert.ok(neverDeleteReasonFor(`${HOME}/.envrc`, env), "direnv often contains secrets exported into the environment");
	assert.ok(neverDeleteReasonFor(`${HOME}/.hgrc`, env));
	assert.ok(neverDeleteReasonFor(`${HOME}/.gitignore`, env), "home-level global gitignore");
	assert.ok(neverDeleteReasonFor(`${HOME}/.tool-versions`, env));
	assert.ok(neverDeleteReasonFor(`${HOME}/.yarnrc`, env));
	assert.ok(neverDeleteReasonFor(`${HOME}/.yarnrc.yml`, env));
	assert.ok(neverDeleteReasonFor(`${HOME}/.bunfig.toml`, env));
	assert.ok(neverDeleteReasonFor(`${HOME}/.boto`, env), "gsutil credentials");
	assert.ok(neverDeleteReasonFor(`${HOME}/.s3cfg`, env), "s3cmd credentials");
	for (const dir of [".azure", ".gcloud", ".terraform.d", ".helm", ".minikube", ".password-store"]) {
		assert.ok(neverDeleteReasonFor(`${HOME}/${dir}/x`, env), `${dir} has subtree semantics`);
	}
	// nested entries: tools that sink credentials two levels under ~/.config
	assert.ok(neverDeleteReasonFor(`${HOME}/.config/gh/hosts.yml`, env), "gh token lives in hosts.yml");
	assert.ok(neverDeleteReasonFor(`${HOME}/.config/gcloud/credentials.db`, env), "gcloud credentials");
	assert.equal(neverDeleteReasonFor(`${HOME}/.config`, env), undefined, "nested entries do not drag in ~/.config itself");
	assert.equal(neverDeleteReasonFor(`${HOME}/.config/ghostty/config`, env), undefined, "other tools under ~/.config remain ordinary tier");
	assert.equal(neverDeleteReasonFor(`${HOME}/projects/.envrc`, env), undefined, "an .envrc in a project is not global config");
	assert.equal(neverDeleteReasonFor(`${HOME}/projects/.gitignore`, env), undefined, "a .gitignore in a project is a project file");
});

test("neverDeleteReasonFor: realpath sees symlink escapes", () => {
	const withRealpath = {
		home: HOME,
		realpath: (p: string) => (p === `${HOME}/link` || p.startsWith(`${HOME}/link/`) ? p.replace(`${HOME}/link`, `${HOME}/.ssh`) : undefined),
	};
	assert.ok(neverDeleteReasonFor(`${HOME}/link/id_rsa`, withRealpath), "a link pointing at ~/.ssh is blocked too");
	assert.equal(neverDeleteReasonFor(`${HOME}/link/id_rsa`, env), undefined, "without realpath only lexical checks run (known gap)");
});

test("dangerousReasonFor: any path component being .git/.hg/.svn is dangerous", () => {
	assert.ok(dangerousReasonFor(`${HOME}/projects/x/.git`, env));
	assert.ok(dangerousReasonFor(`${HOME}/projects/x/.git/objects`, env));
	assert.ok(dangerousReasonFor(`/tmp/whatever/.svn/entries`, env), "counts even inside a temp directory (the shape rule wins)");
	assert.equal(dangerousReasonFor(`${HOME}/projects/x/gitignore`, env), undefined, "similar names that are not VCS directories");
});

test("dangerousReasonFor: realpath sees symlink escapes", () => {
	// ~/link → /etc: the lexical form sits under home (not dangerous); the realpath form is /etc/passwd (dangerous).
	// Simulates real realpathSync: a prefix of the whole path is replaced, not just the link itself.
	const withRealpath = {
		home: HOME,
		realpath: (p: string) => (p === `${HOME}/link` || p.startsWith(`${HOME}/link/`) ? p.replace(`${HOME}/link`, "/etc") : undefined),
	};
	assert.ok(dangerousReasonFor(`${HOME}/link/passwd`, withRealpath));
	assert.equal(dangerousReasonFor(`${HOME}/link/passwd`, env), undefined, "without realpath only lexical checks run (known gap)");
});

test("dangerousRoots: split into subtree / exact tiers; $HOME is in exact", () => {
	const tables = dangerousRoots(env);
	assert.ok(tables.exact.includes(HOME), "$HOME is dangerous only by itself (otherwise ~/Downloads would be dangerous too and the allowlist dies)");
	assert.ok(tables.exact.includes("/"));
	assert.ok(tables.exact.includes("/Users"));
	assert.ok(tables.subtree.includes(`${HOME}/Library`), "~/Library stays in the dangerous tier");
	assert.ok(!tables.subtree.includes(`${HOME}/.ssh`), "credential directories moved up to never-delete");
	assert.ok(tables.subtree.includes("/usr"));
	assert.ok(!tables.subtree.includes(HOME), "$HOME is not in the subtree tier");
});

test("neverDeletePaths: home level-1 files + directory subtree roots + nested entries all resolve to absolute paths", () => {
	const paths = neverDeletePaths(HOME);
	assert.ok(paths.includes(`${HOME}/.zshrc`));
	assert.ok(paths.includes(`${HOME}/.ssh`));
	assert.ok(paths.includes(`${HOME}/.bash_history`), "generic entries added 2026-09-25");
	assert.ok(paths.includes(`${HOME}/.password-store`), "password-store subtree");
	assert.ok(paths.includes(`${HOME}/.config/gh`), "nested entries: joined under home then resolvePath");
	assert.ok(paths.includes(`${HOME}/.config/gcloud`), "nested entries");
	assert.ok(!paths.includes(`${HOME}/.config`), "user 2026-09-25: tool state directories left the list");
	assert.ok(!paths.includes(`${HOME}/.pi`), "user 2026-09-25: tool state directories left the list");
	assert.ok(paths.includes(`${HOME}/.env`));
	assert.ok(!paths.includes(`${HOME}/.cache`), "caches are not on the list");
	assert.ok(!paths.includes(`${HOME}/Library`), "Library is the dangerous tier, not never-delete");
});

test("memoryScopeFor: a file remembers its parent directory; a directory remembers itself", () => {
	const withDir = { home: HOME, isDirectory: (p: string) => p === `${HOME}/Downloads` };
	assert.equal(memoryScopeFor(`${HOME}/Downloads/old.zip`, withDir, CWD), `${HOME}/Downloads`);
	assert.equal(memoryScopeFor(`${HOME}/Downloads`, withDir, CWD), `${HOME}/Downloads`, "target is a directory → remember itself");
});

test("memoryScopeFor: degrades to the exact path when the parent is dangerous/too shallow", () => {
	// ~/.zshrc.bak's parent is $HOME (dangerous root) → only the file itself can be remembered
	assert.equal(memoryScopeFor(`${HOME}/.zshrc.bak`, env, CWD), `${HOME}/.zshrc.bak`);
	// /Users/x's parent is /Users (dangerous root) and itself is only 2 levels → nothing can be remembered (approve each time)
	assert.equal(memoryScopeFor("/Users/x", env, CWD), undefined);
	// target itself is a dangerous root → nothing can be remembered (only session-level exemption remains)
	assert.equal(memoryScopeFor(`${HOME}/.ssh`, env, CWD), undefined);
	assert.equal(memoryScopeFor("/", env, CWD), undefined);
});

test("memoryScopeFor: MIN_ALLOWLIST_DEPTH blocks shallow directories", () => {
	assert.equal(componentCount("/Users/bachi"), 2);
	assert.equal(componentCount("/Users/bachi/Downloads"), 3);
	assert.ok(MIN_ALLOWLIST_DEPTH >= 3, "3-level cap: remembering a parent can never degrade into $HOME");
	// /Users/bachi/Downloads's parent /Users/bachi is only 2 levels → degrade to remembering the exact path
	assert.equal(memoryScopeFor("/Users/bachi/Downloads", env, CWD), "/Users/bachi/Downloads");
});

test("isSafeAllowlistRoot: rejects `/`, dangerous roots, never-delete paths, and ancestors of dangerous roots", () => {
	assert.equal(isSafeAllowlistRoot("/", env), false);
	assert.equal(isSafeAllowlistRoot(HOME, env), false, "$HOME is a dangerous root");
	assert.equal(isSafeAllowlistRoot(`${HOME}/.ssh`, env), false, "never-delete paths cannot enter the allowlist");
	assert.equal(isSafeAllowlistRoot(`${HOME}/.config/gh`, env), false, "nested never-delete paths cannot enter the allowlist either");
	assert.equal(isSafeAllowlistRoot(`${HOME}/.config`, env), true, "user 2026-09-25: ~/.config is an ordinary directory, rememberable (the ancestor gate must not check never-delete, or nested entries would kill it)");
	assert.equal(isSafeAllowlistRoot(`${HOME}/.pi/agent`, env), true, "user 2026-09-25: ~/.pi subdirectories are rememberable");
	assert.equal(isSafeAllowlistRoot(`${HOME}/Downloads`, env), true);
	assert.equal(isSafeAllowlistRoot("/Users", env), false, "not enough components");
	assert.equal(isSafeAllowlistRoot("/Users/bachi", env), false, "ancestor of the $HOME dangerous root (and not enough components)");
});

test("sessionScopeFor: under a dangerous root is exemptable; under a dangerous root / never-delete path itself is not", () => {
	// ~/Library/Foo/bar's parent ~/Library/Foo sits under dangerous root ~/Library but is not itself one → allowed
	assert.equal(sessionScopeFor(`${HOME}/Library/Foo/bar`, env, CWD), `${HOME}/Library/Foo`);
	// ~/Library/x.plist's parent is ~/Library (itself a dangerous root) → falls back to the exact path
	assert.equal(sessionScopeFor(`${HOME}/Library/x.plist`, env, CWD), `${HOME}/Library/x.plist`);
	// ~/.ssh itself is a never-delete path → falls back to the exact path (the blocked tier never reaches this; defensive policy)
	assert.equal(sessionScopeFor(`${HOME}/.ssh`, env, CWD), `${HOME}/.ssh`);
	// user 2026-09-25: ~/.config/foo is no longer a never-delete subtree → remember parent ~/.config (depth 3 passes the gate)
	assert.equal(sessionScopeFor(`${HOME}/.config/foo`, env, CWD), `${HOME}/.config`);
});

test("extractDeniedPaths: BSD rm/rmdir shapes", () => {
	assert.deepEqual(extractDeniedPaths("rm: /Users/x/.sbx-probe: Operation not permitted"), ["/Users/x/.sbx-probe"]);
	assert.deepEqual(extractDeniedPaths("rmdir: /Users/x/dir: Operation not permitted"), ["/Users/x/dir"]);
	assert.deepEqual(extractDeniedPaths("node: /Users/x/a: Operation not permitted"), ["/Users/x/a"]);
});

test("extractDeniedPaths: GNU quoted shapes", () => {
	assert.deepEqual(extractDeniedPaths("rm: cannot remove '/Users/x/a': Operation not permitted"), ["/Users/x/a"]);
	assert.deepEqual(extractDeniedPaths("unlink: cannot unlink '/Users/x/a': Operation not permitted"), ["/Users/x/a"]);
});

test("extractDeniedPaths: rename shape takes the source (mv / sed -i / git writing refs)", () => {
	assert.deepEqual(extractDeniedPaths("mv: rename /Users/x/a to /Users/x/b: Operation not permitted"), ["/Users/x/a"]);
	assert.deepEqual(extractDeniedPaths("sed: rename(/Users/x/.conf.sedXXXX to /Users/x/.conf): Operation not permitted"), ["/Users/x/.conf.sedXXXX"]);
});

test("extractDeniedPaths: exclusion 1 — heredoc temp-file failure is not a deletion", () => {
	// bash 3.2's heredoc must create /var/tmp/sh-thd-* and then unlink it; it is not user data.
	// These three are the original inputs of the 2026-09-24 false positive that popped a dangerous-directory dialog for "deleting /bin/bash".
	assert.deepEqual(
		extractDeniedPaths("/bin/bash: cannot create temp file for here document: Operation not permitted"),
		[],
		"the old implementation's fallback scan extracted /bin/bash, popping the \"dangerous path /bin\" dialog",
	);
	assert.deepEqual(
		extractDeniedPaths("/bin/bash: line 5: cannot create temp file for here document: Operation not permitted"),
		[],
		"line-numbered variant",
	);
	assert.deepEqual(
		extractDeniedPaths("bash: /p: cannot create temp file for here document: Operation not permitted"),
		[],
		"the old BSD greedy capture extracted dirty paths like \"/p: cannot create temp file for here document\"",
	);
});

test("extractDeniedPaths: exclusion 2 — EPERM reported by a shell / sandbox-exec itself is an exec failure, not an unlink", () => {
	// /bin/ps and /usr/bin/top are setuid / platform binaries — exec inside the sandbox is EPERM directly.
	assert.deepEqual(extractDeniedPaths("bash: /bin/ps: Operation not permitted"), [], "old implementation extracted /bin/ps → popped the dangerous dialog");
	assert.deepEqual(extractDeniedPaths("bash: line 0: /usr/bin/top: Operation not permitted"), []);
	assert.deepEqual(extractDeniedPaths("/bin/sh: /usr/bin/top: Operation not permitted"), [], "shells with a path prefix are recognized too");
	assert.deepEqual(extractDeniedPaths("zsh: /bin/ps: Operation not permitted"), []);
	assert.deepEqual(extractDeniedPaths("sandbox-exec: sandbox_apply: Operation not permitted"), [], "nested sandbox unavailable");
});

test("extractDeniedPaths: exclusion is per-line — a real delete in mixed output is still extracted", () => {
	// A `cat <<EOF …; rm /outside` style chained command: the heredoc line is skipped, the rm line still prompts.
	const out = extractDeniedPaths(
		[
			"/bin/bash: cannot create temp file for here document: Operation not permitted",
			"rm: /Users/x/outside/a: Operation not permitted",
		].join("\n"),
	);
	assert.deepEqual(out, ["/Users/x/outside/a"], "a global gate would swallow the real delete; per-line does not");
});

test("extractDeniedPaths: fallback scan retained — the three real delete shapes an allowlist would drop", () => {
	// python3: the path comes **after** the EPERM with no `cannot`, and the prog token is PermissionError, not python3 —
	// neither the BSD nor the GNU regex can reach it — only the fallback extracts it. The prototype shape of incident ① on 2026-09-23.
	assert.deepEqual(
		extractDeniedPaths("PermissionError: [Errno 1] Operation not permitted: '/Users/x/outside/a'"),
		["/Users/x/outside/a"],
	);
	// find -delete / -exec rm
	assert.deepEqual(extractDeniedPaths("find: /Users/x/outside: Operation not permitted"), ["/Users/x/outside"]);
	// ln -sf overwrite = unlink on the target
	assert.deepEqual(extractDeniedPaths("ln: /Users/x/outside/link: Operation not permitted"), ["/Users/x/outside/link"]);
});

test("extractDeniedPaths: fallback scan retained — rvm / apply2files / xargs wrappings", () => {
	assert.deepEqual(extractDeniedPaths("rvm: /Users/x/a -> errno=1 Operation not permitted"), ["/Users/x/a"]);
	assert.deepEqual(extractDeniedPaths("ruby: Operation not permitted @ apply2files - /Users/x/a"), ["/Users/x/a"]);
	assert.deepEqual(extractDeniedPaths("perl: Operation not permitted @ apply2files - /Users/x/a"), ["/Users/x/a"]);
	assert.deepEqual(extractDeniedPaths("xargs: rm: /Users/x/outside/a: Operation not permitted"), ["/Users/x/outside/a"]);
});

test("extractDeniedPaths: fallback scan covers more — node's / git's real multi-line formats", () => {
	// The old implementation could not extract these two (node's has no colon separator; git's trailing quote was not cleaned).
	assert.deepEqual(
		extractDeniedPaths("Error: EPERM: operation not permitted, unlink '/Users/x/outside/a'"),
		["/Users/x/outside/a"],
		"node fs.unlinkSync's real error shape",
	);
	assert.deepEqual(
		extractDeniedPaths("warning: unable to unlink '/Users/x/repo/.git/config.lock': Operation not permitted"),
		["/Users/x/repo/.git/config.lock"],
		"git's real ref-write shape; also pins cleanExtractedPath's trailing-quote fix (the old one extracted …lock')",
	);
});

test("extractDeniedPaths: BSD capture takes a single token; on failure it falls to the fallback", () => {
	// the old (.+?) would swallow the middle too, producing a dirty path.
	assert.deepEqual(
		extractDeniedPaths("find: /Users/x/outside/a: cannot unlink: Operation not permitted"),
		["/Users/x/outside/a"],
		"old implementation extracted \"/Users/x/outside/a: cannot unlink\"",
	);
});

test("extractDeniedPaths: multiple targets, deduped", () => {
	const out = extractDeniedPaths(
		[
			"rm: /Users/x/a: Operation not permitted",
			"rm: /Users/x/b: Operation not permitted",
			"rm: /Users/x/a: Operation not permitted",
		].join("\n"),
	);
	assert.deepEqual(out, ["/Users/x/a", "/Users/x/b"], "deduped and order-preserved");
	assert.deepEqual(extractDeniedPaths("hello world"), []);
	assert.deepEqual(extractDeniedPaths(""), []);
	// a line with the signature string but no absolute-path token: even the fallback scan extracts nothing
	assert.deepEqual(extractDeniedPaths("grep: Operation not permitted is just ordinary text"), []);
});

test("extractDeniedPaths: relative paths and pathless lines return empty (caller shows no prompt and reports the error verbatim)", () => {
	assert.deepEqual(extractDeniedPaths("rm: foo.txt: Operation not permitted"), [], "relative paths are not accepted (no absolute target can be guessed)");
	assert.deepEqual(extractDeniedPaths("Operation not permitted"), []);
});

test("classifyOutsidePaths: five mutually exclusive tiers — never-delete / inside / authorized / dangerous / ordinary", () => {
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths(
		[
			`${CWD}/src/x.ts`, // inside the boundary
			`${HOME}/Downloads/a.txt`, // authorized (~/Downloads is in allowedRoots)
			`${HOME}/Downloads/b.txt`, // authorized (same directory)
			`${HOME}/.zshrc`, // never delete
			`${HOME}/.ssh/id_rsa`, // never delete (subtree)
			`${HOME}/Library/Preferences/x`, // dangerous (always ask, exemptable)
			`${HOME}/projects/foo/y.txt`, // ordinary
		],
		{ boundary: b, allowedRoots: [`${HOME}/Downloads`], sessionRoots: [], env },
	);
	assert.deepEqual(result.inside, [`${CWD}/src/x.ts`]);
	assert.deepEqual(result.covered, [`${HOME}/Downloads/a.txt`, `${HOME}/Downloads/b.txt`]);
	assert.deepEqual(result.blocked.map((d) => d.path), [`${HOME}/.zshrc`, `${HOME}/.ssh/id_rsa`]);
	assert.deepEqual(result.dangerous.map((d) => d.path), [`${HOME}/Library/Preferences/x`]);
	assert.deepEqual(result.ordinary, [`${HOME}/projects/foo/y.txt`]);
});

test("classifyOutsidePaths: never-delete beats boundary and authorization — extraWrites / allowlist / session exemption cannot override", () => {
	// extraWrites put ~/.ssh inside the writable boundary — still blocked
	const b = makeBoundary(CWD, [`${HOME}/.ssh`]);
	const result = classifyOutsidePaths([`${HOME}/.ssh/id_rsa`], {
		boundary: b,
		allowedRoots: [`${HOME}/.ssh`],
		sessionRoots: [`${HOME}/.ssh`],
		env,
	});
	assert.deepEqual(result.blocked.map((d) => d.path), [`${HOME}/.ssh/id_rsa`], "credential directories are not deletable");
	assert.equal(result.inside.length, 0, "not in the boundary tier even when extraWrites allows it");
	assert.equal(result.covered.length, 0, "allowlist / session exemption cannot override either");
});

test("classifyOutsidePaths: when the project directory sits under a never-delete path, deleting its own files is not blocked", () => {
	// working in a (hypothetical) project inside a never-delete directory like ~/.gnupg/proj/x: deleting the project's own files should pass
	const projectDir = `${HOME}/.gnupg/proj/x`;
	const b = makeBoundary(projectDir);
	const result = classifyOutsidePaths([`${projectDir}/src/a.ts`, `${HOME}/.gnupg/private-keys-v1.d`], {
		boundary: b,
		allowedRoots: [],
		sessionRoots: [],
		env,
	});
	assert.deepEqual(result.inside, [`${projectDir}/src/a.ts`], "the project directory is inside the writable boundary by definition");
	assert.deepEqual(result.blocked.map((d) => d.path), [`${HOME}/.gnupg/private-keys-v1.d`], "ones outside the project still blocked");
});

test("classifyOutsidePaths: ~/.pi, ~/.config, ~/.claude, ~/.codex are ordinary outside tier — prompt once, rememberable", () => {
	// user 2026-09-25: these four tool state directories left the never-delete tier (pi's own stale-lock cleanup was once kernel-blocked)
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths(
		[`${HOME}/.pi/agent/trust.json.lock`, `${HOME}/.config/foo`, `${HOME}/.claude/x`, `${HOME}/.codex/y`],
		{ boundary: b, allowedRoots: [], sessionRoots: [], env },
	);
	assert.deepEqual(
		result.ordinary,
		[`${HOME}/.pi/agent/trust.json.lock`, `${HOME}/.config/foo`, `${HOME}/.claude/x`, `${HOME}/.codex/y`],
	);
	assert.equal(result.blocked.length, 0);
	assert.equal(result.dangerous.length, 0);
	// after the allowlist remembers ~/.pi/agent, no more prompts
	const covered = classifyOutsidePaths([`${HOME}/.pi/agent/trust.json.lock`], {
		boundary: b,
		allowedRoots: [`${HOME}/.pi/agent`],
		sessionRoots: [],
		env,
	});
	assert.deepEqual(covered.covered, [`${HOME}/.pi/agent/trust.json.lock`], "after remembering, passes silently");
});

test("classifyOutsidePaths: session exemption beats the dangerous check", () => {
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths([`${HOME}/Library/Foo/bar`], {
		boundary: b,
		allowedRoots: [],
		sessionRoots: [`${HOME}/Library/Foo`],
		env,
	});
	assert.deepEqual(result.covered, [`${HOME}/Library/Foo/bar`], "once exempted this session, no more prompts");
	assert.equal(result.dangerous.length, 0);
});

test("classifyOutsidePaths: regenerable caches are inside — ~/.cache and ~/Library/Caches pass silently", () => {
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths([`${HOME}/.cache/foo`, `${HOME}/Library/Caches/x`, `${HOME}/.npm/_cacache/y`], {
		boundary: b,
		allowedRoots: [],
		sessionRoots: [],
		env,
	});
	assert.deepEqual(result.inside, [`${HOME}/.cache/foo`, `${HOME}/Library/Caches/x`, `${HOME}/.npm/_cacache/y`]);
	assert.equal(result.blocked.length, 0);
	assert.equal(result.dangerous.length, 0, "~/Library/Caches is inside the boundary and never reaches the ~/Library dangerous check");
});

test("classifyOutsidePaths: boundary first — /private/tmp is under /private but not dangerous", () => {
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths(["/private/tmp/x"], { boundary: b, allowedRoots: [], sessionRoots: [], env });
	assert.deepEqual(result.inside, ["/private/tmp/x"], "boundary checked first: temp roots pass directly");
	assert.equal(result.dangerous.length, 0);
});

test("classifyOutsidePaths: deduplication", () => {
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths([`${HOME}/projects/a`, `${HOME}/projects/a/`, `${HOME}/projects/a`], {
		boundary: b,
		allowedRoots: [],
		sessionRoots: [],
		env,
	});
	assert.deepEqual(result.ordinary, [`${HOME}/projects/a`]);
});

test("memoryScopesFor: a batch of targets reduces to deduped scopes", () => {
	assert.deepEqual(memoryScopesFor([`${HOME}/Downloads/a`, `${HOME}/Downloads/b`], env, CWD), [`${HOME}/Downloads`]);
});

test("writableRoots contains at least the project directory, all temp roots, and regenerable cache roots", () => {
	const roots = writableRoots(makeBoundary(CWD));
	assert.ok(roots.includes(CWD));
	for (const root of TEMP_WRITE_ROOTS) assert.ok(roots.includes(root));
	for (const rel of SAFE_CACHE_HOME_DIRS) assert.ok(roots.includes(`${HOME}/${rel}`), `cache root ${rel} is inside the writable boundary`);
});

test("buildSeatbeltProfile: the never-delete deny line comes after the allow line and covers all never-delete subtrees", () => {
	const profile = buildSeatbeltProfile(makeBoundary(CWD));
	const lines = profile.split("\n");
	const allowIdx = lines.findIndex((l) => l.startsWith("(allow file-write-unlink "));
	const denyIdx = lines.findIndex((l) => l.startsWith("(deny file-write-unlink ("));
	assert.ok(allowIdx >= 0, "the allow line exists");
	assert.ok(denyIdx >= 0, "the never-delete deny line exists");
	assert.ok(denyIdx > allowIdx, "deny after allow (later seatbelt rules override earlier → kernel-level block)");
	const denyLine = lines[denyIdx]!;
	// each entry emits both literal (pins the file itself) and subpath (covers the directory subtree)
	assert.ok(denyLine.includes(`(literal "${HOME}/.zshrc")`), "config files get a literal");
	assert.ok(denyLine.includes(`(subpath "${HOME}/.zshrc")`), "config files also get a subpath");
	assert.ok(denyLine.includes(`(subpath "${HOME}/.ssh")`), "credential directories are in the deny line");
	assert.ok(denyLine.includes(`(subpath "${HOME}/.password-store")`), "the password store added 2026-09-25 is in the deny line");
	// nested entries: the two-level absolute path goes into the deny line too (literal + subpath)
	assert.ok(denyLine.includes(`(literal "${HOME}/.config/gh")`), "nested entries get a literal");
	assert.ok(denyLine.includes(`(subpath "${HOME}/.config/gcloud")`), "nested entries get a subpath");
	assert.ok(!denyLine.includes(`"${HOME}/.cache"`), "caches are not in the deny line");
	// cache roots are in the allow line
	assert.ok(lines[allowIdx]!.includes(`(subpath "${HOME}/.cache")`), "cache roots are in the allow line");
});

test("buildSeatbeltProfile: when the project directory sits under a never-delete path, that path is left out of the deny line", () => {
	const projectDir = `${HOME}/.gnupg/proj/x`;
	const profile = buildSeatbeltProfile(makeBoundary(projectDir));
	const denyLine = profile.split("\n").find((l) => l.startsWith("(deny file-write-unlink ("));
	assert.ok(denyLine, "the deny line still exists");
	assert.ok(!denyLine!.includes(`"${HOME}/.gnupg"`), "the never-delete root containing the project is carved out, or deleting the project's own files would all be blocked");
	assert.ok(denyLine!.includes(`(subpath "${HOME}/.ssh")`), "the other never-delete roots remain");
});

test("buildSeatbeltProfile: ~/.pi, ~/.config, ~/.claude, ~/.codex are not in the deny line", () => {
	// user 2026-09-25: tool state directories left the never-delete tier — the kernel no longer blocks their deletion
	const profile = buildSeatbeltProfile(makeBoundary(CWD));
	const denyLine = profile.split("\n").find((l) => l.startsWith("(deny file-write-unlink ("));
	assert.ok(denyLine);
	for (const name of [".pi", ".config", ".claude", ".codex"]) {
		assert.ok(!denyLine!.includes(`"${HOME}/${name}"`), `${name} is not in the deny line`);
	}
	assert.ok(denyLine!.includes(`(subpath "${HOME}/.ssh")`), "credential directories remain in the deny line");
	// nested entries do not affect the four above: `~/.config/gh` is in the deny line, but `~/.config` itself is not
	assert.ok(denyLine!.includes(`(subpath "${HOME}/.config/gh")`), "nested entries are in");
	assert.ok(!denyLine!.includes(`(subpath "${HOME}/.config")`), "~/.config itself is not (or tool state directories become never-delete again)");
});

test("buildSeatbeltProfile: extraUnlinkRoots merge into the same allow line, order preserved", () => {
	const profile = buildSeatbeltProfile(makeBoundary(CWD), [`${HOME}/Downloads`, `${HOME}/Downloads`]);
	const lines = profile.split("\n");
	const unlinkAllow = lines.find((l) => l.startsWith("(allow file-write-unlink "));
	assert.ok(unlinkAllow, "still only one unlink allow line");
	assert.ok(unlinkAllow!.includes(`(subpath "${HOME}/Downloads")`), "allowlist roots entered the allow list");
	assert.equal(unlinkAllow!.split(`(subpath "${HOME}/Downloads")`).length - 1, 1, "deduplicated");
	assert.ok(
		lines.indexOf("(deny file-write-unlink)") < lines.indexOf(unlinkAllow!),
		"the global deny still precedes the allow (later seatbelt rules override earlier)",
	);
});
