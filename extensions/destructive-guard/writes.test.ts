/**
 * Tests for writes.ts — dangerous deletion shapes inside written content.
 *
 * Run with:  node --test clients/pi/extensions/destructive-guard/writes.test.ts
 *
 * The core case is the 2026-09-23 incident's own line verbatim. It sits outside the bash
 * judgment's view (the run step is just `node verify-a.mjs`) — only checking the **written
 * content** can find it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { firstStringArg, inspectWrittenContent } from "./writes.ts";

/** The list of matched rule names. */
function rules(content: string): string[] {
	return inspectWrittenContent(content).map((finding) => finding.rule);
}

describe("the incident verbatim", () => {
	it("recognizes the fs.rmSync(path.dirname(x ?? \"/tmp\")) line", () => {
		const content = 'fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true });';
		const findings = inspectWrittenContent(content);
		assert.ok(findings.length > 0, "the incident's own line must hit");
		assert.equal(findings[0]!.line, 1);
	});

	it("the fallback value is reported before the path arithmetic (it is the root cause)", () => {
		const content = 'fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true });';
		assert.equal(rules(content)[0], "fallback-in-delete");
	});

	it("path arithmetic without a fallback still hits", () => {
		assert.deepEqual(rules("fs.rmSync(path.dirname(target), { recursive: true });"), ["derived-delete-target"]);
	});
});

describe("other deletion shapes", () => {
	it("bare root", () => {
		assert.ok(rules('fs.rmSync("/", { recursive: true, force: true });').includes("root-or-parent-delete"));
	});

	it("Python shutil.rmtree", () => {
		assert.ok(rules("shutil.rmtree(os.path.join(base, name))").length > 0);
	});

	it("PowerShell Remove-Item", () => {
		assert.ok(rules("Remove-Item -Recurse -Force $Path").length > 0);
	});

	it("a shell variable target (the `rm -rf $UNSET/*` shape)", () => {
		assert.deepEqual(rules("rm -rf $UNSET/*"), ["shell-variable-target"]);
	});

	it("a shell variable with braces", () => {
		assert.deepEqual(rules("rm -rf ${DIR:-/}"), ["shell-variable-target"]);
	});

	it("a .. climb", () => {
		assert.ok(rules('fs.rmSync("../..", { recursive: true });').length > 0);
	});
});

describe("no false hits", () => {
	it("literal targets pass", () => {
		assert.deepEqual(rules('fs.rmSync("/tmp/va-abc123", { recursive: true, force: true });'), []);
		assert.deepEqual(rules('rm -rf ./dist'), []);
		assert.deepEqual(rules('rm -rf /Users/bachi/jaylli/x/node_modules'), []);
	});

	it("read operations pass", () => {
		assert.deepEqual(rules("const text = fs.readFileSync(p, 'utf8');"), []);
		assert.deepEqual(rules("path.join(a, b)"), []);
		assert.deepEqual(rules("await fs.promises.mkdtemp(dir)"), []);
	});

	it("comment and doc lines do not count", () => {
		assert.deepEqual(rules("// fs.rmSync(path.dirname(x ?? '/tmp'))"), []);
		assert.deepEqual(rules("# shutil.rmtree(os.path.dirname(y))"), []);
		assert.deepEqual(rules(" * fs.rmSync(dirname(z))"), []);
	});

	it("empty content", () => {
		assert.deepEqual(rules(""), []);
		assert.deepEqual(rules("\n\n"), []);
	});

	it("line numbers stay correct across multiple lines", () => {
		const content = ["const a = 1;", "const b = 2;", 'fs.rmSync(path.dirname(t), {});'].join("\n");
		const findings = inspectWrittenContent(content);
		assert.equal(findings[0]!.line, 3);
	});
});

describe("firstStringArg", () => {
	it("extract the literal target", () => {
		assert.equal(firstStringArg('fs.rmSync("/tmp/x", {})', "rmSync"), "/tmp/x");
	});

	it("a non-literal target returns undefined", () => {
		assert.equal(firstStringArg("fs.rmSync(someVar, {})", "rmSync"), undefined);
	});
});
