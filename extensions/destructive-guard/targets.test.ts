/**
 * Tests for targets.ts — extraction and judgment of deletion targets.
 *
 * Run with:  node --test clients/pi/extensions/destructive-guard/targets.test.ts
 *
 * Two assertion groups: **must block** (no dangerous target may slip through) and **must
 * pass** (normal cleanup inside the workdir must not be hurt). The latter matters just as
 * much — a guard that always prompts is no guard at all. The judgment rules come from
 * `AGENTS.md`'s `## Destructive actions`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	componentCount,
	evaluateTarget,
	extractDeleteSites,
	inspectBash,
	resolveLexical,
	splitSegments,
	splitWords,
	stripQuotes,
} from "./targets.ts";

const CWD = "/Users/bachi/jaylli/litellm-any";
const HOME = "/Users/bachi";

/** The command's verdict list (verdicts only — wording is not pinned). */
function verdicts(command: string): string[] {
	return inspectBash(command, CWD, HOME).map((finding) => finding.verdict);
}

/** Whether a command gets caught (both block and confirm count). */
function caught(command: string): boolean {
	return inspectBash(command, CWD, HOME).length > 0;
}

describe("resolveLexical", () => {
	it("joins relative paths onto cwd", () => {
		assert.equal(resolveLexical("dist", CWD, HOME), `${CWD}/dist`);
		assert.equal(resolveLexical("./dist", CWD, HOME), `${CWD}/dist`);
	});

	it("expands ~", () => {
		assert.equal(resolveLexical("~", CWD, HOME), HOME);
		assert.equal(resolveLexical("~/.cache/nvim", CWD, HOME), `${HOME}/.cache/nvim`);
	});

	it("collapses . and ..", () => {
		assert.equal(resolveLexical("/Users/bachi/x/../y", CWD, HOME), "/Users/bachi/y");
		assert.equal(resolveLexical("/tmp/..", CWD, HOME), "/");
		assert.equal(resolveLexical("/Users/bachi/..", CWD, HOME), "/Users");
	});

	it("returns empty with unexpanded variables (does not pretend to know the target)", () => {
		assert.equal(resolveLexical("$UNSET/x", CWD, HOME), "");
		assert.equal(resolveLexical("${A:-/}", CWD, HOME), "");
		assert.equal(resolveLexical("$(mktemp -d)/x", CWD, HOME), "");
		assert.equal(resolveLexical("`pwd`/x", CWD, HOME), "");
	});
});

describe("componentCount", () => {
	it("counts segments", () => {
		assert.equal(componentCount("/"), 0);
		assert.equal(componentCount("/tmp"), 1);
		assert.equal(componentCount("/usr/local/bin"), 3);
		assert.equal(componentCount(""), 0);
	});
});

describe("stripQuotes / splitWords / splitSegments", () => {
	it("strips the outermost paired quotes", () => {
		assert.equal(stripQuotes('"/tmp/x"'), "/tmp/x");
		assert.equal(stripQuotes("'/tmp/x'"), "/tmp/x");
		assert.equal(stripQuotes("/tmp/x"), "/tmp/x");
	});

	it("splits on spaces, keeping quotes", () => {
		assert.deepEqual(splitWords('rm -rf "/tmp/a b"'), ["rm", "-rf", '"/tmp/a b"']);
	});

	it("command substitution / variable expansion counts as one word, not split at spaces", () => {
		assert.deepEqual(splitWords('rm -rf $(dirname "$LOG")'), ["rm", "-rf", '$(dirname "$LOG")']);
		assert.deepEqual(splitWords("rm -rf `pwd`/x"), ["rm", "-rf", "`pwd`/x"]);
		assert.deepEqual(splitWords('rm -rf "${OUT:?}"/dist'), ["rm", "-rf", '"${OUT:?}"/dist']);
		// nested parens
		assert.deepEqual(splitWords("rm -rf $(echo $(pwd)/x)"), ["rm", "-rf", "$(echo $(pwd)/x)"]);
		// quotes and parens inside a substitution do not derail it either
		assert.deepEqual(splitWords('rm -rf $(echo ")")'), ["rm", "-rf", '$(echo ")")']);
	});

	it("unsplittable command substitutions no longer produce fragment targets", () => {
		const sites = extractDeleteSites('rm -rf $(dirname "$LOG")');
		assert.deepEqual(sites[0]!.targets, ['$(dirname "$LOG")']);
	});

	it("splits segments on shell boundaries, quote-aware", () => {
		assert.deepEqual(splitSegments("a && b || c ; d | e"), ["a", "b", "c", "d", "e"]);
		assert.deepEqual(splitSegments('echo "a;b" ; ls'), ['echo "a;b"', "ls"]);
	});
});

describe("extractDeleteSites", () => {
	it("recognizes rm's targets", () => {
		const sites = extractDeleteSites("rm -rf /tmp/x /tmp/y");
		assert.equal(sites.length, 1);
		assert.equal(sites[0]!.command, "rm");
		assert.deepEqual(sites[0]!.targets, ["/tmp/x", "/tmp/y"]);
	});

	it("everything after `--` counts as a target", () => {
		const sites = extractDeleteSites("rm -- -rf");
		assert.deepEqual(sites[0]!.targets, ["-rf"]);
	});

	it("recognizes find -delete", () => {
		const sites = extractDeleteSites("find /var/log -name '*.gz' -delete");
		assert.equal(sites.length, 1);
		assert.deepEqual(sites[0]!.targets, ["/var/log"]);
	});

	it("recognizes find -exec rm", () => {
		assert.equal(extractDeleteSites("find . -exec rm {} \\;").length, 1);
	});

	it("recognizes git clean -fdx", () => {
		const sites = extractDeleteSites("git clean -fdx");
		assert.equal(sites[0]!.command, "git clean");
	});

	it("git clean without -f/-x does not count", () => {
		assert.equal(extractDeleteSites("git clean -n").length, 0);
	});

	it("recognizes rsync --delete's destination", () => {
		const sites = extractDeleteSites("rsync -a --delete src/ /dest/");
		assert.equal(sites[0]!.command, "rsync --delete");
		assert.deepEqual(sites[0]!.targets, ["/dest/"]);
	});

	it("pure read commands produce no call sites", () => {
		assert.equal(extractDeleteSites("ls -la /tmp").length, 0);
		assert.equal(extractDeleteSites("git status").length, 0);
		assert.equal(extractDeleteSites("cat /etc/hosts").length, 0);
	});
});

describe("evaluateTarget — must block", () => {
	const mustBlock = [
		"/",
		"/System",
		"/Library",
		"/Applications",
		"/Users",
		"/usr",
		"/bin",
		"/sbin",
		"/etc",
		"/private",
		"/opt",
		"~",
		"$HOME",
		HOME,
		"/tmp/..",
		"/Users/bachi/..",
		"/..",
	];

	for (const target of mustBlock) {
		it(`block ${target}`, () => {
			const finding = evaluateTarget(target, CWD, HOME);
			assert.ok(finding, `${target} should hit`);
			assert.equal(finding.verdict, "block", `${target} should be block`);
		});
	}

	it("ancestors of a protected dir are blocked too (/Users is /Users/bachi's parent)", () => {
		const finding = evaluateTarget("/Users/bachi/..", CWD, HOME);
		assert.equal(finding?.rule, "top-level");
	});
});

describe("evaluateTarget — incident shapes", () => {
	it("a fallback value in the delete target → confirm", () => {
		const finding = evaluateTarget('"/tmp" ?? "/tmp"', CWD, HOME);
		assert.equal(finding?.verdict, "confirm");
		assert.equal(finding?.rule, "fallback-in-target");
	});

	it("arithmetic like path.dirname → confirm", () => {
		const finding = evaluateTarget("$(dirname /tmp)", CWD, HOME);
		assert.equal(finding?.verdict, "confirm");
	});

	it("unexpanded variables → confirm (not pass)", () => {
		const finding = evaluateTarget("$TARGET", CWD, HOME);
		assert.equal(finding?.verdict, "confirm");
		assert.equal(finding?.rule, "derived-target");
	});
});

describe("evaluateTarget — must pass (no false hits)", () => {
	const mustAllow = [
		`${CWD}/dist`,
		`${CWD}/node_modules`,
		`${CWD}/adapter/coverage`,
		"/tmp/va-abc123",
		"/usr/local/bin/tsc",
	];

	for (const target of mustAllow) {
		it(`pass ${target}`, () => {
			assert.equal(evaluateTarget(target, CWD, HOME), undefined, `${target} must not be caught`);
		});
	}

	it("normal cleanup inside the workdir and temp dirs passes whole", () => {
		assert.equal(caught(`rm -rf ${CWD}/dist`), false);
		assert.equal(caught(`rm -rf ${CWD}/node_modules`), false);
		assert.equal(caught("rm -f /tmp/scratch.log"), false);
		assert.equal(caught("rm -rf /private/tmp/dg-abc123"), false);
	});

	it("a concrete file outside the workdir but outside home passes (package-manager turf)", () => {
		assert.equal(evaluateTarget("/usr/local/bin/tsc", CWD, HOME), undefined);
		assert.equal(evaluateTarget("/opt/homebrew/lib/x", CWD, HOME), undefined);
	});
});

describe("evaluateTarget — outside the workdir needs confirmation (AGENTS.md's third assertion)", () => {
	it("inside home but outside the workdir → confirm", () => {
		const finding = evaluateTarget(`${HOME}/.cache/nvim`, CWD, HOME);
		assert.equal(finding?.verdict, "confirm");
		assert.equal(finding?.rule, "outside-workdir");
	});

	it("the incident's entire loss surface hits outside-workdir", () => {
		for (const target of [
			`${HOME}/.zshrc`,
			`${HOME}/.gitconfig`,
			`${HOME}/.zprofile`,
			`${HOME}/.pi/agent/npm`,
		]) {
			const finding = evaluateTarget(target, CWD, HOME);
			assert.ok(finding, `${target} should hit`);
			assert.equal(finding.rule, "outside-workdir", `${target} should be outside-workdir`);
		}
	});

	it("temp dirs approximate \"created by this session\" — no prompt", () => {
		assert.equal(evaluateTarget("/var/folders/dh/x/T/dg-abc", CWD, HOME), undefined);
		assert.equal(evaluateTarget(`${HOME}/.pi/agent/../../../tmp/x`, CWD, HOME), undefined);
	});

	it("paths inside the workdir do not hit outside-workdir", () => {
		assert.equal(evaluateTarget(`${CWD}/dist`, CWD, HOME), undefined);
	});
});

describe("evaluateTarget — self-protection", () => {
	it("deleting the guard's own directory → block", () => {
		const finding = evaluateTarget(`${HOME}/.pi/agent/extensions/destructive-guard`, CWD, HOME);
		assert.equal(finding?.verdict, "block");
		assert.equal(finding?.rule, "self-protection");
	});

	it("deleting the global rule file AGENTS.md → block", () => {
		const finding = evaluateTarget(`${HOME}/.pi/agent/AGENTS.md`, CWD, HOME);
		assert.equal(finding?.verdict, "block");
		assert.equal(finding?.rule, "self-protection");
	});

	it("deleting the extensions / sessions / rewind subtrees under the agent dir → block", () => {
		for (const target of [
			`${HOME}/.pi/agent/extensions`,
			`${HOME}/.pi/agent/sessions`,
			`${HOME}/.pi/agent/rewind`,
		]) {
			const finding = evaluateTarget(target, CWD, HOME);
			assert.equal(finding?.verdict, "block", `${target} should block`);
			assert.equal(finding?.rule, "self-protection", `${target} should be self-protection`);
		}
	});

	it("the guard copy inside the repo is protected the same way", () => {
		const finding = evaluateTarget(`${CWD}/clients/pi/extensions/destructive-guard`, CWD, HOME);
		assert.equal(finding?.verdict, "block");
		assert.equal(finding?.rule, "self-protection");
	});
});

describe("read commands are not hurt", () => {
	it("read commands pass", () => {
		assert.equal(caught("ls -la /usr/local/bin"), false);
		assert.equal(caught("cat /etc/hosts"), false);
		assert.equal(caught("find /Users/bachi -name '*.log'"), false);
	});
});

describe("inspectBash — replaying the incident", () => {
	it("catches the `rm -rf $(dirname /tmp)` shape", () => {
		const findings = inspectBash("rm -rf $(dirname /tmp)", CWD, HOME);
		assert.ok(findings.length > 0, "must hit");
	});

	it("catches a variable target (the `rm -rf $UNSET/*` shape)", () => {
		const findings = inspectBash("rm -rf $UNSET/*", CWD, HOME);
		assert.ok(findings.length > 0);
		assert.equal(findings[0]!.verdict, "confirm");
	});

	it("catches a bare root", () => {
		const findings = inspectBash("rm -rf /", CWD, HOME);
		assert.equal(findings[0]!.verdict, "block");
	});

	it("catches an ancestor of a protected tree", () => {
		assert.equal(inspectBash("rm -rf /Users", CWD, HOME)[0]!.verdict, "block");
		assert.equal(inspectBash("rm -rf /usr", CWD, HOME)[0]!.verdict, "block");
	});

	it("one dangerous segment in a chained command is enough", () => {
		assert.ok(caught(`cd ${CWD} && rm -rf /Users`));
		assert.ok(caught(`ls /tmp; rm -rf /etc`));
	});

	it("normal cleanup after `&&` is not hurt", () => {
		assert.equal(caught(`cd ${CWD} && rm -rf dist && npm run build`), false);
	});
});
