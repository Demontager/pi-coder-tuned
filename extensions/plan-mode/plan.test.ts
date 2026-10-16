/**
 * Tests for plan.ts — plan-mode's two-state machine and bash write judgment.
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/plan.test.ts
 *
 * plan.ts imports no pi / pi-tui, so this file is all pure input/output assertions. The bash
 * judgment table pins two groups of real commands — "reads pass / writes blocked"; block cases
 * assert `ok === false`, never the message text verbatim (wording evolves; the shape is pinned
 * once in the last case).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	completeDocWrite,
	enterDocWriting,
	enterPlan,
	initialPlanState,
	inspectBashCommand,
	planModeToolSet,
	rejectPlan,
	restoredToolSet,
	splitSimpleCommands,
	stripHeredocBodies,
	submitPlan,
} from "./plan.ts";

// =============================================================================
// State machine
// =============================================================================

const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "ls", "ask_user_question", "task_set", "mcp__wechat-local__status"];

describe("tool set", () => {
	it("plan removes the write tools; every other dynamically registered tool is untouched", () => {
		const tools = planModeToolSet(ALL_TOOLS);
		assert.ok(!tools.includes("edit"));
		assert.ok(!tools.includes("write"));
		assert.deepEqual(tools, ["read", "bash", "grep", "ls", "ask_user_question", "task_set", "mcp__wechat-local__status"]);
	});

	it("read-only tools and extension-registered tools are untouched (powershell is removed like the rest)", () => {
		assert.deepEqual(planModeToolSet(["read", "powershell", "recap"]), ["read", "recap"]);
	});

	it("dedupe keeps pi's own order", () => {
		assert.deepEqual(planModeToolSet(["read", "read", "write"]), ["read"]);
	});

	it("the doc-writing sub-state restores write alone — edit / powershell stay removed", () => {
		const tools = planModeToolSet(ALL_TOOLS, true);
		assert.ok(tools.includes("write"), "the sub-state needs write to put the plan into a file");
		assert.ok(!tools.includes("edit"));
		assert.ok(!tools.includes("powershell"));
	});

	it("exit restores the pre-entry snapshot first", () => {
		const state = enterPlan(initialPlanState(), ALL_TOOLS);
		assert.deepEqual(restoredToolSet(state, ["read", "bash"]), ALL_TOOLS);
	});

	it("with no snapshot it falls back to the current active tools (--tools changed mid-session)", () => {
		assert.deepEqual(restoredToolSet(initialPlanState(), ["read", "bash"]), ["read", "bash"]);
	});
});

describe("state transitions", () => {
	const PLAN = "# Plan\n\n## Summary\nChange two files.";

	it("enterPlan records the snapshot and clears the previous plan's traces", () => {
		const state = enterPlan(initialPlanState(), ALL_TOOLS);
		assert.equal(state.phase, "plan");
		assert.deepEqual(state.toolsBeforePlan, ALL_TOOLS);
		assert.equal(state.pending, undefined);
		assert.equal(state.docMode, undefined);
		assert.equal(state.docWriting, undefined);
	});

	it("a repeated enterPlan does not overwrite the snapshot", () => {
		const once = enterPlan(initialPlanState(), ["read", "edit"]);
		const twice = enterPlan(once, ["read"]);
		assert.deepEqual(twice.toolsBeforePlan, ["read", "edit"]);
	});

	it("enterPlan clears a leftover docWriting (or the new round would inject the doc-writing instruction)", () => {
		const stale = enterDocWriting(submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), PLAN), "doc-only", "/tmp/a.md");
		const fresh = enterPlan({ ...stale, phase: "bypass" }, ALL_TOOLS);
		assert.equal(fresh.docWriting, undefined);
		assert.equal(fresh.pendingDocPath, undefined);
	});

	it("submitPlan stores the full plan and summary, still in plan awaiting approval", () => {
		const submitted = submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), PLAN, "  change two files  ");
		assert.equal(submitted.pending, PLAN);
		assert.equal(submitted.planSummary, "change two files", "the summary must be trimmed");
		assert.equal(submitted.phase, "plan");
	});

	it("submitPlan records an empty summary as undefined (slug falls back)", () => {
		const submitted = submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), PLAN, "   ");
		assert.equal(submitted.planSummary, undefined);
	});

	it("submitPlan only takes effect in plan phase", () => {
		assert.equal(submitPlan(initialPlanState(), PLAN).pending, undefined);
	});

	it("rejectPlan stays in plan, drops pending and the doc-sub-state flags, keeps the tool snapshot", () => {
		const writing = enterDocWriting(submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), PLAN), "doc-only", "/tmp/a.md");
		const rejected = rejectPlan(writing);
		assert.equal(rejected.phase, "plan", "a rejection is not an exit — the revision continues");
		assert.equal(rejected.pending, undefined);
		assert.equal(rejected.docWriting, undefined);
		assert.equal(rejected.pendingDocPath, undefined);
		assert.deepEqual(rejected.toolsBeforePlan, ALL_TOOLS);
	});
});

describe("doc-writing sub-state", () => {
	const PLAN = "# Plan";
	const DOC = "/repo/.pi/plans/2026-09-24-plan.md";

	function inDocWriting(mode: "execute-with-doc" | "doc-only" = "execute-with-doc") {
		return enterDocWriting(submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), PLAN, "the plan"), mode, DOC);
	}

	it("enterDocWriting flips the flag and remembers route + path; the phase stays plan", () => {
		const state = inDocWriting();
		assert.equal(state.phase, "plan", "the sub-state is not a third phase: bash interception and tool shrinkage all ride on plan");
		assert.equal(state.docWriting, true);
		assert.equal(state.docMode, "execute-with-doc");
		assert.equal(state.pendingDocPath, DOC);
		assert.equal(state.pending, PLAN, "the full plan is kept — the doc-writing instruction needs it");
	});

	it("a repeated enterDocWriting is idempotent — the pinned path is not overwritten", () => {
		const once = inDocWriting();
		const twice = enterDocWriting(once, "doc-only", "/repo/.pi/plans/other.md");
		assert.equal(twice.pendingDocPath, DOC);
		assert.equal(twice.docMode, "execute-with-doc");
	});

	it("enterDocWriting does nothing outside plan", () => {
		assert.equal(enterDocWriting(initialPlanState(), "doc-only", DOC).docWriting, undefined);
	});

	it("completeDocWrite wraps up to bypass and hands route + path to the caller", () => {
		const outcome = completeDocWrite(inDocWriting("doc-only"));
		assert.ok(outcome);
		assert.equal(outcome.state.phase, "bypass");
		assert.equal(outcome.docMode, "doc-only");
		assert.equal(outcome.docPath, DOC);
		assert.equal(outcome.state.docWriting, undefined);
		assert.equal(outcome.state.pending, undefined);
		assert.equal(outcome.state.toolsBeforePlan, undefined, "the snapshot clears with the state (the caller performs the restore first)");
	});

	it("calling completeDocWrite outside the sub-state returns undefined (that is not a wrap-up)", () => {
		assert.equal(completeDocWrite(enterPlan(initialPlanState(), ALL_TOOLS)), undefined);
		assert.equal(completeDocWrite(initialPlanState()), undefined);
	});

	it("a missing path does not wrap up either (better to stay recoverably in the sub-state than to wave through silently)", () => {
		const broken = { ...inDocWriting(), pendingDocPath: undefined };
		assert.equal(completeDocWrite(broken), undefined);
	});

	it("a missing docMode wraps up as execute-with-doc (an approval should be implementable)", () => {
		const outcome = completeDocWrite({ ...inDocWriting(), docMode: undefined });
		assert.equal(outcome?.docMode, "execute-with-doc");
	});
});

// =============================================================================
// bash judgment: passes
// =============================================================================

const SAFE_COMMANDS = [
	"ls -la",
	"cat src/index.ts",
	"rg 'plan' -n clients/pi",
	"git status",
	"git log --oneline -20",
	"git diff HEAD --stat",
	"git show HEAD:README.md",
	"git branch -a",
	"npm list --depth=0",
	"npm ls",
	"pnpm --version",
	"node --test clients/pi/extensions/plan-mode/plan.test.ts",
	"python3 -m unittest gateway/tests/test_qoder_provider.py",
	"echo hello",
	"pwd",
	"wc -l file",
	"jq '.models' gateway/config.yaml",
	"sed -n '1,20p' README.md",
	"2>&1",
	"cat a.txt 2>&1 | head -5",
	"git status && git log --oneline -3",
	"cat a.txt; ls -la",
	"make --dry-run",
	"cat <<EOF\nrm -rf /tmp/x\nEOF",
	"npm run build 2>/dev/null",
	"git diff > /dev/null",
	"find . -name '*.ts' -type f",
	"ls | grep plan",
	"env | sort",
	"echo 'a > b'",
	"cat \"file with > in name\"",
	"git config --get remote.origin.url",
	"name=value; ls",
];

describe("bash judgment: read-only commands pass", () => {
	for (const command of SAFE_COMMANDS) {
		it(command.replace(/\n/g, "\\n"), () => {
			assert.deepEqual(inspectBashCommand(command), { ok: true });
		});
	}
});

// =============================================================================
// bash judgment: blocked
// =============================================================================

const WRITE_COMMANDS = [
	"echo hi > out.txt",
	"echo hi >> out.txt",
	"cat a.txt > b.txt",
	"rm -rf node_modules",
	"mv a b",
	"cp -r a b",
	"mkdir out",
	"touch newfile",
	"chmod +x script.sh",
	"tee out.txt",
	"sed -i '' 's/a/b/' file",
	"sed -i.bak 's/a/b/' file",
	"find . -name '*.ts' -delete",
	"find . -name '*.ts' -exec rm {} \\;",
	"git add -A",
	"git commit -m x",
	"git push",
	"git reset --hard",
	"git checkout -- .",
	"git stash",
	"npm install",
	"npm i lodash",
	"npm ci",
	"pnpm add -D typescript",
	"pip install requests",
	"brew install jq",
	"sudo rm -rf /",
	"apt-get install -y curl",
	"vim README.md",
	"make build",
	"eslint . --fix",
	"prettier --write .",
	"cat a.txt && rm -rf b",
	"ls; rm -rf /tmp/x",
	"ls | tee out.txt",
	"(cd /tmp && rm -rf x)",
	"echo x > /dev/null; rm -rf y",	"dd if=/dev/zero of=/tmp/x bs=1 count=1",
	"NODE_ENV=prod rm -rf dist",
	"truncate -s 0 log.txt",
];

describe("bash judgment: writes blocked", () => {
	for (const command of WRITE_COMMANDS) {
		it(command, () => {
			assert.equal(inspectBashCommand(command).ok, false, `should be blocked: ${command}`);
		});
	}

	it("the refusal carries the plan-phase note and the specific command (the model reroutes on it)", () => {
		const verdict = inspectBashCommand("rm -rf dist");
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason ?? "", /^Writes are not permitted during planning/);
		assert.match(verdict.reason ?? "", /rm/);
	});

	it("the read half of a compound command does not count as a block reason; the write half does", () => {
		const verdict = inspectBashCommand("cat a.txt && git status && rm -rf b");
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason ?? "", /rm/);
	});
});

// =============================================================================
// Parsing details
// =============================================================================

describe("splitSimpleCommands", () => {
	it("splits on ; | & && || parens and newlines", () => {
		const heads = splitSimpleCommands("a; b | c && d || e & f\n(g)").map((simple) => simple.words[0]);
		assert.deepEqual(heads, ["a", "b", "c", "d", "e", "f", "g"]);
	});

	it("separators inside quotes do not split", () => {
		const segments = splitSimpleCommands("echo 'a; b' \"c | d\"");
		assert.equal(segments.length, 1);
		assert.deepEqual(segments[0]!.words, ["echo", "a; b", "c | d"]);
	});

	it("redirect targets land in writes, not mixed into args", () => {
		const segments = splitSimpleCommands("echo hi > out.txt 2> err.txt");
		assert.deepEqual(segments[0]!.writes, ["out.txt", "err.txt"]);
		assert.deepEqual(segments[0]!.words, ["echo", "hi"]);
	});

	it("an fd dup (2>&1) is not a write", () => {
		assert.deepEqual(splitSimpleCommands("cat a 2>&1").map((simple) => simple.writes), [[]]);
	});

	it("here-strings and read redirects are not writes", () => {
		assert.deepEqual(splitSimpleCommands("wc -l <<< abc").map((simple) => simple.writes), [[]]);
		assert.deepEqual(splitSimpleCommands("sort < in.txt").map((simple) => simple.writes), [[]]);
	});

	it("escaped separators do not split", () => {
		assert.deepEqual(splitSimpleCommands("echo a\\;b").map((simple) => simple.words), [["echo", "a;b"]]);
	});
});

describe("stripHeredocBodies", () => {
	it("heredoc bodies become blank lines; the end line is kept", () => {
		const stripped = stripHeredocBodies("cat <<EOF\nrm -rf x\nEOF\nls");
		assert.ok(!stripped.includes("rm -rf x"));
		assert.match(stripped, /ls/);
	});

	it("the tab-indented terminator of <<- is recognized too", () => {
		const stripped = stripHeredocBodies("cat <<-EOF\n\trm -rf x\n\tEOF\nls");
		assert.ok(!stripped.includes("rm -rf x"));
		assert.match(stripped, /ls/);
	});

	it("quoted delimiters (<<'EOF') are recognized", () => {
		const stripped = stripHeredocBodies("cat <<'EOF'\nrm -rf x\nEOF");
		assert.ok(!stripped.includes("rm -rf x"));
	});

	it("no terminator → returned verbatim, the later commands are not swallowed", () => {
		const command = "cat <<EOF\nactive";
		assert.equal(stripHeredocBodies(command), command);
		assert.equal(inspectBashCommand(command).ok, true, "unsure → conservatively allow");
	});
});
