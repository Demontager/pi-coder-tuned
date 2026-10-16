/**
 * Unit tests for `lookup-redirect` — detection rules of the single-lookup gate.
 *
 * This gate is a **hard block** (the `tool_call` handler returns `block`), so one
 * wrong interception wastes a whole model turn. Both directions must be pinned:
 *
 *   - **Must gate**: pure single lookups (including `cd X &&` prefixes and the
 *     `| head -N` truncation idiom)
 *   - **Must never gate**: transformers (`awk`/`wc`/`sort`/`jq`), execution (`node`/`npm`/`git`),
 *     writes (redirection, `sed -i`), and shapes the native schema cannot express
 *     (`grep -v`, `find -mtime`, `ls -R`, multi-path `grep`)
 *
 * Detection is exercised with real commands (typical shapes taken from historical
 * sessions), not constructed toy strings.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { detectBashLookup, renderLookupRedirect } from "./lookup-redirect.ts";

/** Should be gated: returns the suggested tool name. */
function gated(command: string): string | null {
	return detectBashLookup(command)?.tool ?? null;
}

test("gates: a pure single grep", () => {
	assert.equal(gated('grep -n "foo" file.ts'), "grep");
	assert.equal(gated('grep -rn "foo" src/'), "grep");
	assert.equal(gated("grep -rn foo ."), "grep");
	assert.equal(gated('grep -i needle .'), "grep");
	assert.equal(gated('grep -n "foo" --include="*.ts" src/'), "grep");
	assert.equal(gated('rg "foo" src/'), "grep");
});

test("gates: single lookup with a `cd X &&` navigation prefix (the most common real-world shape)", () => {
	assert.equal(gated('cd /Users/x/proj && grep -rn "foo" .'), "grep");
	assert.equal(gated('cd "/path with space/proj" && grep -n "bar" index.html'), "grep");
	assert.equal(gated("cd /x && ls -la src/"), "ls");
});

test("gates: `| head -N` is just a truncation idiom, not a compound (the native tool has a limit)", () => {
	assert.equal(gated("grep -rn foo . | head -30"), "grep");
	assert.equal(gated("ls -la src/ | head -5"), "ls");
	assert.equal(gated('find . -name "*.ts" | head'), "find");
	assert.equal(gated("grep -rn foo . | tail -3"), "grep");
});

test("gates: listing directories and finding files by name", () => {
	assert.equal(gated("ls -la src/"), "ls");
	assert.equal(gated("ls -t sessions/"), "ls");
	assert.equal(gated('find . -name "*.jsonl"'), "find");
	assert.equal(gated("find /x -type f"), "find");
});

test("gates: fetching file contents (the read family)", () => {
	assert.equal(gated("cat package.json"), "read");
	assert.equal(gated("head -20 README.md"), "read");
	assert.equal(gated('sed -n "1,60p" CHANGELOG.md'), "read");
	assert.equal(gated("sed -n '92,121p' CLAUDE.md"), "read");
});

test("does not gate: transformers — the native tools cannot provide them, and gating only forces the model into other bash", () => {
	assert.equal(gated('grep -rn foo . | awk -F: "{print $1}"'), null);
	assert.equal(gated("grep -rn foo . | wc -l"), null);
	assert.equal(gated("grep -rn foo . | sort -u"), null);
	assert.equal(gated('grep -rn foo . | jq -r ".[]"'), null);
	assert.equal(gated('find . -name "*.ts" | wc -l'), null);
	assert.equal(gated("grep -rn foo . | head -30 | wc -l"), null);
});

test("does not gate: execution commands — those actually run things", () => {
	assert.equal(gated("node --test x.test.ts 2>&1 | grep -E \"pass\""), null);
	assert.equal(gated("cd /x && npm test"), null);
	assert.equal(gated("git status"), null);
	assert.equal(gated("python3 -c \"print(1)\""), null);
	assert.equal(gated("cd /x && node -v; go version"), null);
	assert.equal(gated("cd /x && grep -n a f && echo done && node x.js"), null);
});

test("does not gate: writes and in-place edits", () => {
	assert.equal(gated("sed -i \"\" \"s/a/b/\" f.txt"), null);
	assert.equal(gated('cat > /tmp/x.txt <<EOF\nhi\nEOF'), null);
	assert.equal(gated("echo hi > f.txt"), null);
	assert.equal(gated("grep -rn foo . > out.txt"), null);
	// sed without `-n` is substitution, not reading
	assert.equal(gated('sed "s/a/b/" f.txt'), null);
});

test("does not gate: flags the native schema cannot express", () => {
	assert.equal(gated("grep -c foo a.txt"), null); // count only
	assert.equal(gated("grep -v foo a.txt"), null); // inverted match
	assert.equal(gated("grep -A 3 foo a.txt"), null); // context lines
	assert.equal(gated("grep -rn foo src/ dist/"), null); // multiple paths
	assert.equal(gated("find . -maxdepth 2 -name x"), null); // depth limit
	assert.equal(gated('find . -name "*.log" -mtime +7'), null); // time predicate
	assert.equal(gated('find . -name "*.log" -exec rm {} \\;'), null); // side effects
	assert.equal(gated("ls -R src/"), null); // recursion
	assert.equal(gated("cat a.txt b.txt c.txt"), null); // multiple files
});

test("does not gate: unrelated and empty commands", () => {
	assert.equal(gated("echo hi"), null);
	assert.equal(gated("cd /x"), null);
	assert.equal(gated("which timeout"), null);
	assert.equal(gated("someunknowncmd --flag"), null);
	assert.equal(gated(""), null);
	assert.equal(gated("   "), null);
});

test("suggested call shape: arguments must match the native schema", () => {
	// The `cd` target is joined into relative paths — the native tool resolves `path` against the
	// **current cwd**, not the directory the command `cd`s into. Without the join the model would
	// read a different file (or get `Path not found`); in practice 74% of gated commands carry a
	// `cd` prefix plus a relative path.
	const g = detectBashLookup('cd /Users/x/proj && grep -rn "NEVER_DELETE" src/')!;
	assert.equal(g.tool, "grep");
	assert.deepEqual(g.hint?.args, { pattern: "NEVER_DELETE", path: "/Users/x/proj/src/" });

	// The `cd` target acts as the scope when there is no explicit path
	const g2 = detectBashLookup('cd /tmp/scope && grep -n foo .')!;
	assert.equal(g2.hint?.args?.path, ".");
	// Without a `.`, it is that directory itself
	assert.equal(detectBashLookup('cd /tmp/scope && grep -rn foo')?.hint?.args?.path, "/tmp/scope");
	assert.equal(detectBashLookup("cd /tmp/scope && cat f.ts")?.hint?.args?.path, "/tmp/scope/f.ts");
	assert.equal(detectBashLookup("cd /tmp/scope && ls sub")?.hint?.args?.path, "/tmp/scope/sub");
	// Absolute paths and `~` are not joined (already complete)
	assert.equal(detectBashLookup("cd /tmp/scope && cat /abs/f.ts")?.hint?.args?.path, "/abs/f.ts");

	// Quoted paths containing spaces must not be split apart (`segmentVerb` tokenizes on
	// whitespace and would cut `"/a b"` into `"/a`)
	assert.equal(detectBashLookup('cd "/a b/proj" && cat f.ts')?.hint?.args?.path, "/a b/proj/f.ts");
	assert.equal(detectBashLookup('cd "/a b/proj" && ls')?.hint?.args?.path, "/a b/proj");

	// `--include` → glob, `-i` → ignoreCase
	const g3 = detectBashLookup('grep -i "x" --include="*.ts" src/')!;
	assert.equal(g3.hint?.args?.ignoreCase, true);
	assert.equal(g3.hint?.args?.glob, "*.ts");

	// `sed -n '92,121p'` → offset/limit (30 lines)
	const g4 = detectBashLookup("sed -n '92,121p' CLAUDE.md")!;
	assert.equal(g4.hint?.args?.offset, 92);
	assert.equal(g4.hint?.args?.limit, 30);

	// `head -20 f` → limit 20
	const g5 = detectBashLookup("head -20 README.md")!;
	assert.equal(g5.hint?.args?.limit, 20);

	// `ls -t sessions/` → path
	const g6 = detectBashLookup("cd /x && ls -t sessions/ | head -5")!;
	assert.equal(g6.tool, "ls");
	assert.equal(g6.hint?.args?.path, "/x/sessions/");
});

test("does not gate: shapes that need the shell to expand first — the native tools **do not expand**, so a copy-paste suggestion would always fail", () => {
	// Measured: `ls({path: "*.md"})` fails outright with `Path not found: …/*.md`. Gating such a
	// command pushes the model into a dead end: its only way out is to discover on its own that
	// "use bash and let the shell expand" works — a net loss of one turn.
	assert.equal(gated("ls *.md"), null);
	assert.equal(gated("ls -d */"), null);
	assert.equal(gated("ls ~/Downloads/*.png"), null);
	assert.equal(gated("cat *.log"), null);
	assert.equal(gated("head -20 *.md"), null);
	assert.equal(gated("grep -n foo *.ts"), null);
	assert.equal(gated("grep -rn foo `pwd`"), null);
	assert.equal(gated("cat $(ls | head -1)"), null);
	// Square brackets are regex, not a glob — must not be treated as expansion and slip through
	assert.equal(gated("grep -n '[a-z]\\+' f.ts"), "grep");
});

test("does not gate: grep reading from **stdin** — the native grep can only search files, so no replacement call can be offered", () => {
	// When the upstream side is a command (not a file), `grep pat` has no path; the native
	// schema cannot express it.
	assert.equal(gated("env | grep -i '^PI_'"), null);
	assert.equal(gated("env | grep -i '^PI_' | head -20"), null);
	assert.equal(gated("ls /x | grep -i qoder"), null);
	assert.equal(gated("history | grep npm"), null);
	// `cat f | grep pat` could theoretically derive the path, but `splitShellSegments` treats `|`
	// and `;` as the same kind of separator, so it cannot tell "grep reading a pipe" from "grep
	// reading stdin" — when in doubt, do not gate (0.4% of real cases).
	assert.equal(gated("cat a.txt | grep foo"), null);
	// `grep -rn pat` (recursive without a path) uses the current directory; the native tool can express that
	assert.equal(gated("grep -rn foo"), "grep");
	assert.equal(gated("grep -rn foo ."), "grep");
});

test("does not gate: listing multiple paths at once — the native ls takes a single path, and copying the suggestion would silently drop the rest", () => {
	assert.equal(gated("ls /a /b"), null);
	assert.equal(gated("cd /x && ls src test docs"), null);
});

test("gates: `head -n N f` must also yield a limit (same treatment as `head -N f`)", () => {
	// Previously only the `-20` form was recognized; `-n 20` was gated but only suggested
	// `read({path})`, silently losing the line count.
	assert.equal(detectBashLookup("head -n 20 app.ts")?.hint?.args?.limit, 20);
	assert.equal(detectBashLookup("head -20 app.ts")?.hint?.args?.limit, 20);
	assert.equal(detectBashLookup("head -n 5 x.log")?.hint?.args?.path, "x.log");
});

test("suggested call shape: `--include` must not be mistaken for `-i`", () => {
	// The old `/^-.*i/` matched the letter i inside `--include=*.ts` and produced
	// ignoreCase: true — the model would copy it and silently widen its search results.
	const g = detectBashLookup("grep -rn foo --include=*.ts .")!;
	assert.equal(g.hint?.args?.glob, "*.ts");
	assert.equal(g.hint?.args?.ignoreCase, undefined);
	// A real `-i` must still be recognized (including combined short flags like `-rni`)
	assert.equal(detectBashLookup("grep -i foo x.ts")?.hint?.args?.ignoreCase, true);
	assert.equal(detectBashLookup("grep -rni foo x.ts")?.hint?.args?.ignoreCase, true);
});

test("the suggested path must resolve to the command's actual target (`cd` target + relative path)", () => {
	// The native tool resolves `path` against the **current cwd**, not the directory the command
	// `cd`s into — without the join the model reads a different file or gets `Path not found`;
	// in practice 74% of gated commands carry a `cd` prefix plus a relative path.
	assert.equal(detectBashLookup("cd /tmp/scope && cat f.ts")?.hint?.args?.path, "/tmp/scope/f.ts");
	assert.equal(detectBashLookup("cd /tmp/scope && grep -n foo f.ts")?.hint?.args?.path, "/tmp/scope/f.ts");
	assert.equal(detectBashLookup("cd /tmp/scope && head -20 f.ts")?.hint?.args?.path, "/tmp/scope/f.ts");
	assert.equal(detectBashLookup("cd /tmp/scope && ls sub")?.hint?.args?.path, "/tmp/scope/sub");
	// Absolute / `~` / `.` are not joined (already complete, or semantically the current directory)
	assert.equal(detectBashLookup("cd /tmp/scope && cat /abs/f.ts")?.hint?.args?.path, "/abs/f.ts");
	assert.equal(detectBashLookup("cd /tmp/scope && grep -n foo .")?.hint?.args?.path, ".");
});

test("the suggested path must not carry quotes / wildcards / unexpanded variables — native tools neither expand nor strip quotes", () => {
	// Measured: `ls({path: "*.md"})` fails outright with `Path not found`; `read({path: "$D/x.md"})`
	// looks for a directory literally named `$D`. All three shapes mean "the copy-paste suggestion
	// will fail", so gating costs more than letting it through.
	assert.equal(gated("ls *.md"), null);
	assert.equal(gated("cd /tmp && cat $D/f.ts"), null);
	assert.equal(gated("cd /tmp && cat ${D}/f.ts"), null);
	// When the `cd` target itself is unresolvable the command is still gated (it really is a
	// single lookup), but **no relative path may be suggested** — that relative name points to a
	// different file under the current cwd, and silently pointing at the wrong file is worse than an error.
	const unresolved = detectBashLookup("cd $DIR && cat f.ts")!;
	assert.equal(unresolved.tool, "read");
	assert.equal(unresolved.hint?.args?.path, undefined, "an unresolved cd target must not be used as path");
	assert.equal(detectBashLookup("cd /x/*/pkg && cat f.ts")?.hint?.args?.path, undefined);
});

test("the gate message must spell out the .gitignore exception (otherwise switching to native tools becomes a silent miss)", () => {
	const g = detectBashLookup('grep -rn "x" .')!;
	const text = renderLookupRedirect(g);
	assert.ok(text.includes(".gitignore"), "the grep gate message must mention .gitignore");
	assert.ok(text.includes("explicitly"), "must show the piercing method");
	// Must contain a native call that can be copied verbatim
	assert.ok(text.includes('grep({ pattern: "x", path: "." })'), `the gate message should offer a copy-paste line, actual: ${text}`);

	// The read family has no .gitignore concern and should not mention it
	const r = detectBashLookup("cat package.json")!;
	assert.ok(!renderLookupRedirect(r).includes(".gitignore"));

	// The off switch must be written in the gate message (so users can free themselves)
	assert.ok(renderLookupRedirect(g).includes("PI_BASH_LOOKUP_GATE=off"));
});
