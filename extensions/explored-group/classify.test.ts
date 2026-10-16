/**
 * explored-group / classify + phrases — pure-function tests (zero pi dependencies, direct `node --test`).
 *
 * The corpus is drawn from shapes found among 19,847 real bash calls on this machine; each case is
 * annotated with "why it must produce this answer". A wrong verdict fails in only two directions,
 * both unacceptable: folding something that runs ("I ran the tests" vanishes from the screen) or
 * missing something foldable (rows left behind for nothing). So the cases below pin both sides.
 *
 * Run with:  node --test clients/pi/extensions/explored-group/classify.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { classifyBash, classifyToolCall, segmentVerb, splitShellSegments, stripHeredocBodies, stripRedirects } from "./classify.ts";
import { PATH_TAIL_DIRS, phraseForToolCall, phrasesForBash, readSpanSuffix, shortenPath } from "./phrases.ts";

const CWD = "/Users/bachi/jaylli/litellm-any";

test("classify: read-only bash is foldable, with the correct category", () => {
	const cases: Array<[string, string | null]> = [
		// [command, expected kind]
		["cd /Users/bachi/jaylli/litellm-any && grep -rn 'bashOutput' clients/pi --include=*.ts | head -30", "search"],
		["ls -la ~/.pi/agent/extensions/ 2>/dev/null | head -30", "list"],
		["cd X && sed -n '180,260p' bash-command-collapse.ts", "read"],
		["cat ~/.pi/agent/npm/node_modules/x/dist/index.d.ts", "read"],
		["git status --short && git log --oneline -8", "git"],
		["which jq node python3", "list"],
		["cd X && find . -name '*.jsonl' | head -20", "list"],
		["head -60 _vimrc", "read"],
		["tail -60 ~/.vimrc", "read"],
		["stat -f '%i %N' a.ts b.ts", "list"],
		["wc -l a b c", "read"],
		["diff -q a.ts b.ts", "read"],
	];
	for (const [command, expected] of cases) {
		assert.equal(classifyBash(command).kind, expected, command);
	}
});

test("classify: commands that run things do **not** fold (even with grep inside)", () => {
	// This shape is frequent in the target session: `node --test … | grep -E '^ℹ'`. Folding it
	// would erase "I ran the tests" from the screen — which is wrong.
	const mustNotFold = [
		"node --test index.test.ts 2>&1 | grep -E '^ℹ (tests|pass|fail)' | head -70",
		"cd X && node --test render.test.ts 2>&1 | grep -E '^(✔|✖)' | tail -20",
		"python3 -m unittest gateway/tests/test_x.py 2>&1 | tail -5",
		"npm run usage | head -50",
		"npx --yes ali-skills runtime start --skill-file x.md --json 2>&1 | tail -40",
		"pnpm install",
		"cd X && pm2 restart litellm-adapter",
		"curl -s https://example.com | jq .",
	];
	for (const command of mustNotFold) {
		assert.equal(classifyBash(command).kind, null, command);
	}
});

test("classify: writes do not fold; the forms cover > / >> / sed -i / rm", () => {
	const mustNotFold = [
		"cat > /tmp/x.mjs <<'EOF'\nimport fs\nEOF",
		"grep -n x a.ts > /tmp/out.txt",
		"grep -n x a.ts >> /tmp/out.txt",
		"sed -i '' 's/a/b/' ~/.zshrc",
		"perl -i -pe 's/a/b/' a.ts",
		"rm -f /tmp/a.mjs",
		"cp a b && ls",
		"mv a b",
		"mkdir -p /tmp/x && ls /tmp/x",
		"tee /tmp/out <<< 'x'",
		"cd X && git add -A && git commit -m x",
		"cd X && git push",
		"cd X && python3 - <<'PY'\np='README.md'\ns=open(p).read()\nopen(p,'w').write(s)\nPY",
	];
	for (const command of mustNotFold) {
		assert.equal(classifyBash(command).kind, null, command);
	}
});

test("classify: `2>/dev/null` is a redirection, not a write; `>/dev/null` must not block folding either", () => {
	// A real high-frequency shape: `ls dir 2>/dev/null | head`. Discarding stderr is not "writing a file".
	assert.equal(classifyBash("ls -la dir 2>/dev/null | head -30").kind, "list");
	assert.equal(classifyBash("grep -rn x . 2>/dev/null | head").kind, "search");
	assert.equal(classifyBash("cat missing.txt 2>/dev/null").kind, "read");
});

test("classify: empty commands / pure navigation / bare echo do not fold (no substance to fold)", () => {
	for (const command of ["", "   ", "cd /tmp", "echo hi", "pwd", "true"]) {
		assert.equal(classifyBash(command).kind, null, JSON.stringify(command));
	}
});

test("classifyToolCall: native tool names map directly", () => {
	assert.equal(classifyToolCall("read", { path: "/a/b.ts" }).kind, "read");
	assert.equal(classifyToolCall("grep", { pattern: "x" }).kind, "search");
	assert.equal(classifyToolCall("find", { pattern: "*.ts" }).kind, "list");
	assert.equal(classifyToolCall("ls", { path: "/tmp" }).kind, "list");
	// All other tools never fold
	for (const name of ["write", "edit", "subagent", "task_set", "codemode", "background_output", "web_search"]) {
		assert.equal(classifyToolCall(name, {}).kind, null, name);
	}
});

// User report, 2026-10-06: reading SKILL.md was folded into `└ Read …/skills/commit/SKILL.md`
// while pi natively renders `• [skill] commit (ctrl+o to expand)`. Only SKILL.md is exempt
// (the user's chosen scope); docs / resource are not.
test("classify: reading SKILL.md does not fold (let pi's `[skill]` compact shape render it)", () => {
	const skillPaths = [
		"/Users/bachi/.pi/agent/git/github.com/jayli/superpowers/skills/commit/SKILL.md",
		"clients/pi/skills/x/SKILL.md", // cwd-relative
		"SKILL.md", // bare file name
		"/a/b/SKILL.md",
	];
	for (const path of skillPaths) {
		const verdict = classifyToolCall("read", { path });
		assert.equal(verdict.kind, null, path);
		// Must be a "definite non-foldable", not pending — it must break the group as usual and
		// not be skipped the way pending is
		assert.notEqual(verdict.pending, true, `${path} must not be judged pending`);
	}

	// Only a read of SKILL.md gets this exemption; other tools are unaffected
	assert.equal(classifyToolCall("grep", { pattern: "SKILL.md" }).kind, "search");
	assert.equal(classifyToolCall("bash", { command: "grep -rn SKILL.md ." }).kind, "search");

	// The `docs` / `resource` compact shapes are **not** exempt (the user called out only
	// skills): they still fold as usual
	assert.equal(classifyToolCall("read", { path: "/pkg/docs/foo.md" }).kind, "read");
	assert.equal(classifyToolCall("read", { path: "/repo/AGENTS.md" }).kind, "read");
	assert.equal(classifyToolCall("read", { path: "/repo/CLAUDE.md" }).kind, "read");
	// Files containing SKILL.md in their name but not being that file must not be exempted
	assert.equal(classifyToolCall("read", { path: "/a/b/SKILL.md.bak" }).kind, "read");
	assert.equal(classifyToolCall("read", { path: "/a/b/MYSKILL.md" }).kind, "read");
	// Trailing slash / empty value do not affect the verdict
	assert.equal(classifyToolCall("read", { path: "/a/b/SKILL.md/" }).kind, null);
	assert.equal(classifyToolCall("read", { path: "/a/b/" }).kind, "read");
});

test("stripHeredocBodies: strips bodies, keeps the command head (so write redirection stays visible)", () => {
	const command = "cat > /tmp/x.mjs <<'EOF'\nimport fs\nconst a = 1\nEOF\nnode /tmp/x.mjs";
	const stripped = stripHeredocBodies(command);
	assert.ok(stripped.includes("cat > /tmp/x.mjs <<'EOF'"), "the command head must be kept");
	assert.ok(!stripped.includes("import fs"), "the body must be stripped (otherwise import gets treated as a command)");
	assert.ok(stripped.includes("node /tmp/x.mjs"), "commands after the heredoc must be kept");
});

test("splitShellSegments: separators inside quotes do not split; heredoc bodies do not split", () => {
	assert.deepEqual(splitShellSegments("grep -n 'a;b' f"), ["grep -n 'a;b' f"]);
	assert.deepEqual(splitShellSegments("a && b; c | d"), ["a", "b", "c", "d"]);
	// The `&` in `2>&1` must not be treated as a segment separator
	assert.deepEqual(splitShellSegments("node --test x.js 2>&1 | grep y"), ["node --test x.js", "grep y"]);
});

test("segmentVerb: skips VAR= prefixes and sudo/env wrappers", () => {
	assert.equal(segmentVerb("P=/usr/bin grep x").verb, "grep");
	assert.equal(segmentVerb("sudo cat /etc/hosts").verb, "cat");
	assert.equal(segmentVerb("env FOO=1 ls -la").verb, "ls");
	assert.equal(segmentVerb("cd /tmp").verb, "cd");
});

test("stripRedirects: redirection targets must disappear when tokenizing", () => {
	// A real pitfall: without stripping you get `List 2>/dev/null`
	assert.equal(stripRedirects("ls -la dir 2>/dev/null").trim(), "ls -la dir");
	assert.equal(stripRedirects("grep -n x a.ts > /tmp/out.txt").trim(), "grep -n x a.ts");
	assert.equal(stripRedirects("cat f 2>&1").trim(), "cat f");
});

test("shortenPath: at most two directory levels + the last segment; longer ones get `…/`", () => {
	const cases: Array<[string, string]> = [
		["/Users/bachi/jaylli/ttt/a/b/CLAUDE.md", "…/a/b/CLAUDE.md"],
		["/Users/bachi/jaylli/litellm-any/clients/pi/extensions/explored-group/phrases.ts", "…/extensions/explored-group/phrases.ts"],
		["clients/pi/extensions/read.ts", "…/pi/extensions/read.ts"],
		["clients/pi/read.ts", "clients/pi/read.ts"],
		["src/index.ts", "src/index.ts"],
		["package.json", "package.json"],
		["/tmp/x.mjs", "/tmp/x.mjs"],
	];
	for (const [input, expected] of cases) {
		assert.equal(shortenPath(input, CWD), expected, input);
	}
	// The constant itself is "two levels"; changing it means updating the expectations too
	assert.equal(PATH_TAIL_DIRS, 2);
});

test("shortenPath: cwd-relative beats home-relative", () => {
	// `/Users/bachi/jaylli/litellm-any/x.ts` is both "under home" and "under cwd";
	// we want the latter (shorter and more meaningful)
	assert.equal(shortenPath("/Users/bachi/jaylli/litellm-any/x.ts", CWD), "x.ts");
	assert.equal(shortenPath("/Users/bachi/other/deep/a/b/c.ts", CWD), "…/a/b/c.ts");
});

test("phrases: bash phrase table (real commands)", () => {
	const cases: Array<[string, string[]]> = [
		[
			"cd /Users/bachi/jaylli/litellm-any && grep -rn 'bashOutput' clients/pi --include=*.ts | head -30",
			['Search "bashOutput" in clients/pi'],
		],
		["ls -la ~/.pi/agent/extensions/ 2>/dev/null | head -30", ["List …/.pi/agent/extensions"]],
		["cd X && sed -n '180,260p' bash-command-collapse.ts", ["Read bash-command-collapse.ts 180-260"]],
		["cd X && git status --short && git log --oneline -8", ["Git status", "Git log"]],
		["which jq node python3", ["Which jq node python3"]],
		["cd X && find . -name '*.jsonl' | head -20", ["Find *.jsonl in ."]],
		["tail -60 ~/.vimrc", ["Tail ~/.vimrc"]],
		["cd X && grep -rn x . | grep -v node_modules | head", ['Search "x" in .']],
	];
	for (const [command, expected] of cases) {
		assert.deepEqual(phrasesForBash(command, CWD), expected, command);
	}
});

test("phrases: `-v` (inverted filtering) does not masquerade as a search path", () => {
	// In `grep -rn x . | grep -v node_modules`, the second segment's positional argument is
	// node_modules, not a path
	const lines = phrasesForBash("grep -rn x . | grep -v node_modules", CWD);
	assert.deepEqual(lines, ['Search "x" in .']);
});

test("phrases: native tool phrases (the two shapes in the user's samples)", () => {
	assert.equal(phraseForToolCall("grep", { pattern: "bashOutput", path: "clients/pi" }, CWD), 'Search "bashOutput" in clients/pi');
	assert.equal(phraseForToolCall("find", { pattern: "**/*.ts", path: "clients/pi/extensions" }, CWD), "Find **/*.ts in clients/pi/extensions");
	assert.equal(phraseForToolCall("ls", { path: "clients/pi/extensions" }, CWD), "List clients/pi/extensions");
	assert.equal(phraseForToolCall("read", { path: "/Users/bachi/jaylli/ttt/CLAUDE.md" }, CWD), "Read …/jaylli/ttt/CLAUDE.md");
	assert.equal(phraseForToolCall("read", { path: "/a/b/c/d/e.ts", offset: 1, limit: 60 }, CWD), "Read …/c/d/e.ts 1-60");
});

test("phrases: all three read line-suffix shapes are visible (aligned with pi's native formatReadLineRange)", () => {
	// The old implementation gated on `offset && limit` — with only one argument given, the span
	// silently disappeared (user report, 2026-10-06). Same convention as pi:
	// `startLine = offset ?? 1`; without `limit` only the start is known, no guessing the length.
	const p = "/a/b/c/d/e.ts";
	assert.equal(phraseForToolCall("read", { path: p, offset: 100, limit: 70 }, CWD), "Read …/c/d/e.ts 100-169");
	assert.equal(phraseForToolCall("read", { path: p, offset: 100 }, CWD), "Read …/c/d/e.ts 100");
	assert.equal(phraseForToolCall("read", { path: p, limit: 45 }, CWD), "Read …/c/d/e.ts 1-45");
	assert.equal(phraseForToolCall("read", { path: p }, CWD), "Read …/c/d/e.ts");
	assert.equal(readSpanSuffix({ offset: 1, limit: 1 }), " 1-1");
});

test("phrases: fallback — bare file names with no dot and no slash still produce phrases", () => {
	// The `f` in `cat f` / `grep -n x f` has neither `/` nor `.`, yet it is a path;
	// without the fallback these commands produce no phrase line at all (the `grep` one is left
	// with `Search "x"`, losing its scope)
	assert.deepEqual(phrasesForBash("cat f", CWD), ["Read f"]);
	assert.deepEqual(phrasesForBash("grep -n x f", CWD), ['Search "x" in f']);
	// Only when there truly is no positional argument do we fall back to the scope-less form
	assert.deepEqual(phrasesForBash("grep -n x", CWD), ['Search "x"']);
});
