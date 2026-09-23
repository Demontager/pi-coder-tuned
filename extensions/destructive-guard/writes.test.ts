/**
 * Tests for writes.ts — 写入内容里的危险删除形态。
 *
 * Run with:  node --test clients/pi/extensions/destructive-guard/writes.test.ts
 *
 * 核心用例是 2026-09-23 事故的那一行原文。它在 bash 判定的视野之外（运行那一步只是
 * `node verify-a.mjs`），只有检查**写入内容**才能发现。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { firstStringArg, inspectWrittenContent } from "./writes.ts";

/** 命中的规则名列表。 */
function rules(content: string): string[] {
	return inspectWrittenContent(content).map((finding) => finding.rule);
}

describe("事故原文", () => {
	it("认得 fs.rmSync(path.dirname(x ?? \"/tmp\")) 这一行", () => {
		const content = 'fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true });';
		const findings = inspectWrittenContent(content);
		assert.ok(findings.length > 0, "事故那一行必须命中");
		assert.equal(findings[0]!.line, 1);
	});

	it("兜底值优先于路径运算报告（它是根因）", () => {
		const content = 'fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true });';
		assert.equal(rules(content)[0], "fallback-in-delete");
	});

	it("只有路径运算、没有兜底值时也命中", () => {
		assert.deepEqual(rules("fs.rmSync(path.dirname(target), { recursive: true });"), ["derived-delete-target"]);
	});
});

describe("其他删除形态", () => {
	it("裸根", () => {
		assert.ok(rules('fs.rmSync("/", { recursive: true, force: true });').includes("root-or-parent-delete"));
	});

	it("Python shutil.rmtree", () => {
		assert.ok(rules("shutil.rmtree(os.path.join(base, name))").length > 0);
	});

	it("PowerShell Remove-Item", () => {
		assert.ok(rules("Remove-Item -Recurse -Force $Path").length > 0);
	});

	it("shell 变量目标（`rm -rf $UNSET/*` 形态）", () => {
		assert.deepEqual(rules("rm -rf $UNSET/*"), ["shell-variable-target"]);
	});

	it("shell 带花括号的变量", () => {
		assert.deepEqual(rules("rm -rf ${DIR:-/}"), ["shell-variable-target"]);
	});

	it(".. 上跳", () => {
		assert.ok(rules('fs.rmSync("../..", { recursive: true });').length > 0);
	});
});

describe("不误伤", () => {
	it("字面目标放行", () => {
		assert.deepEqual(rules('fs.rmSync("/tmp/va-abc123", { recursive: true, force: true });'), []);
		assert.deepEqual(rules('rm -rf ./dist'), []);
		assert.deepEqual(rules('rm -rf /Users/bachi/jaylli/x/node_modules'), []);
	});

	it("读操作放行", () => {
		assert.deepEqual(rules("const text = fs.readFileSync(p, 'utf8');"), []);
		assert.deepEqual(rules("path.join(a, b)"), []);
		assert.deepEqual(rules("await fs.promises.mkdtemp(dir)"), []);
	});

	it("注释与文档行不算", () => {
		assert.deepEqual(rules("// fs.rmSync(path.dirname(x ?? '/tmp'))"), []);
		assert.deepEqual(rules("# shutil.rmtree(os.path.dirname(y))"), []);
		assert.deepEqual(rules(" * fs.rmSync(dirname(z))"), []);
	});

	it("空内容", () => {
		assert.deepEqual(rules(""), []);
		assert.deepEqual(rules("\n\n"), []);
	});

	it("多行时行号正确", () => {
		const content = ["const a = 1;", "const b = 2;", 'fs.rmSync(path.dirname(t), {});'].join("\n");
		const findings = inspectWrittenContent(content);
		assert.equal(findings[0]!.line, 3);
	});
});

describe("firstStringArg", () => {
	it("抽字面目标", () => {
		assert.equal(firstStringArg('fs.rmSync("/tmp/x", {})', "rmSync"), "/tmp/x");
	});

	it("非字面目标返回 undefined", () => {
		assert.equal(firstStringArg("fs.rmSync(someVar, {})", "rmSync"), undefined);
	});
});
