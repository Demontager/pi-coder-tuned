/**
 * Tests for plan.ts — plan-mode 的三态状态机与 bash 写操作判定。
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/plan.test.ts
 *
 * plan.ts 不 import pi / pi-tui，所以这里全部是纯输入输出断言。bash 判定表按
 * 「读操作放行 / 写操作拦住」两类各钉一组真实命令；拦截用例断言的是 `ok === false`，
 * 不断言文案原文（文案会随开发调整，形状在最后一个用例里单独钉一次）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	type PlanState,
	approvePlan,
	applyDoneSteps,
	cancelPlan,
	countDoneSteps,
	enterPlan,
	inspectBashCommand,
	initialPlanState,
	isPlanComplete,
	planModeToolSet,
	restoredToolSet,
	splitSimpleCommands,
	stripHeredocBodies,
	submitPlan,
} from "./plan.ts";

// =============================================================================
// 状态机
// =============================================================================

const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "ls", "ask_user_question", "task_set", "mcp__wechat-local__status"];

describe("工具集", () => {
	it("plan 阶段摘掉写工具，其余动态注册的工具一个不动", () => {
		const tools = planModeToolSet(ALL_TOOLS);
		assert.ok(!tools.includes("edit"));
		assert.ok(!tools.includes("write"));
		assert.deepEqual(tools, ["read", "bash", "grep", "ls", "ask_user_question", "task_set", "mcp__wechat-local__status"]);
	});

	it("不碰只读工具与扩展注册的工具（powershell 也一样摘掉）", () => {
		assert.deepEqual(planModeToolSet(["read", "powershell", "recap"]), ["read", "recap"]);
	});

	it("去重保持 pi 自己的顺序", () => {
		assert.deepEqual(planModeToolSet(["read", "read", "write"]), ["read"]);
	});

	it("退出时优先还原进入前的快照", () => {
		const state = enterPlan(initialPlanState(), ALL_TOOLS);
		assert.deepEqual(restoredToolSet(state, ["read", "bash"]), ALL_TOOLS);
	});

	it("没有快照时退回当前活动工具（会话中途换过 --tools）", () => {
		assert.deepEqual(restoredToolSet(initialPlanState(), ["read", "bash"]), ["read", "bash"]);
	});
});

describe("状态迁移", () => {
	const STEPS = [
		{ step: 1, text: "读代码", done: false },
		{ step: 2, text: "改代码", done: false },
	];

	it("enterPlan 记下快照并清空步骤", () => {
		const state = enterPlan(initialPlanState(), ALL_TOOLS);
		assert.equal(state.phase, "plan");
		assert.deepEqual(state.toolsBeforePlan, ALL_TOOLS);
		assert.deepEqual(state.steps, []);
	});

	it("重复 enterPlan 不覆盖快照", () => {
		const once = enterPlan(initialPlanState(), ["read", "edit"]);
		const twice = enterPlan(once, ["read"]);
		assert.deepEqual(twice.toolsBeforePlan, ["read", "edit"]);
	});

	it("cancelPlan 回 normal 并丢掉步骤", () => {
		const state = cancelPlan(approvePlan(submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), STEPS)));
		assert.equal(state.phase, "normal");
		assert.deepEqual(state.steps, []);
	});

	it("submitPlan 只在 plan 阶段生效", () => {
		assert.equal(submitPlan(initialPlanState(), STEPS).pending, undefined);
		const pending = submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), STEPS);
		assert.equal(pending.pending?.length, 2);
		assert.equal(pending.phase, "plan", "提交后仍停在 plan 等审批");
	});

	it("approvePlan 把待审批步骤搬进执行列表；没有计划时不动", () => {
		assert.equal(approvePlan(enterPlan(initialPlanState(), ALL_TOOLS)).phase, "plan");
		const executing = approvePlan(submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), STEPS));
		assert.equal(executing.phase, "execute");
		assert.deepEqual(executing.steps, STEPS);
		assert.equal(executing.pending, undefined);
	});

	it("approvePlan 复制步骤，不共享 submitPlan 传进来的数组", () => {
		const source = STEPS.map((step) => ({ ...step }));
		const executing = approvePlan(submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), source));
		executing.steps[0]!.done = true;
		assert.equal(source[0]!.done, false);
	});

	it("applyDoneSteps 只标记 execute 阶段的已知序号，重复标记不重复计数", () => {
		const executing = approvePlan(submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), STEPS));
		assert.equal(applyDoneSteps(executing, [1, 1, 99]), 1);
		assert.equal(applyDoneSteps(executing, [1]), 0, "已完成的步骤不再计数");
		assert.equal(countDoneSteps(executing), 1);
		assert.equal(applyDoneSteps(enterPlan(initialPlanState(), ALL_TOOLS), [1]), 0);
	});

	it("全部步骤完成后 isPlanComplete 才为真", () => {
		const executing = approvePlan(submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), STEPS));
		assert.equal(isPlanComplete(executing), false);
		applyDoneSteps(executing, [1, 2]);
		assert.equal(isPlanComplete(executing), true);
		assert.equal(isPlanComplete(initialPlanState()), false, "没有步骤时不算完成");
	});
});

// =============================================================================
// bash 判定：放行
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

describe("bash 判定：只读命令放行", () => {
	for (const command of SAFE_COMMANDS) {
		it(command.replace(/\n/g, "\\n"), () => {
			assert.deepEqual(inspectBashCommand(command), { ok: true });
		});
	}
});

// =============================================================================
// bash 判定：拦截
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

describe("bash 判定：写操作拦住", () => {
	for (const command of WRITE_COMMANDS) {
		it(command, () => {
			assert.equal(inspectBashCommand(command).ok, false, `应拦住：${command}`);
		});
	}

	it("拒绝原因带 plan 阶段说明与具体命令（模型据此改道）", () => {
		const verdict = inspectBashCommand("rm -rf dist");
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason ?? "", /^plan 阶段不执行写操作/);
		assert.match(verdict.reason ?? "", /rm/);
	});

	it("复杂命令里读的那一半不算拦截理由，写的那一半才算", () => {
		const verdict = inspectBashCommand("cat a.txt && git status && rm -rf b");
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason ?? "", /rm/);
	});
});

// =============================================================================
// 解析细节
// =============================================================================

describe("splitSimpleCommands", () => {
	it("按 ; | & && || 括号与换行切段", () => {
		const heads = splitSimpleCommands("a; b | c && d || e & f\n(g)").map((simple) => simple.words[0]);
		assert.deepEqual(heads, ["a", "b", "c", "d", "e", "f", "g"]);
	});

	it("引号里的分隔符不切段", () => {
		const segments = splitSimpleCommands("echo 'a; b' \"c | d\"");
		assert.equal(segments.length, 1);
		assert.deepEqual(segments[0]!.words, ["echo", "a; b", "c | d"]);
	});

	it("重定向目标记进 writes，不混进参数", () => {
		const segments = splitSimpleCommands("echo hi > out.txt 2> err.txt");
		assert.deepEqual(segments[0]!.writes, ["out.txt", "err.txt"]);
		assert.deepEqual(segments[0]!.words, ["echo", "hi"]);
	});

	it("fd 复制（2>&1）不算写入", () => {
		assert.deepEqual(splitSimpleCommands("cat a 2>&1").map((simple) => simple.writes), [[]]);
	});

	it("here-string 与读取重定向都不算写入", () => {
		assert.deepEqual(splitSimpleCommands("wc -l <<< abc").map((simple) => simple.writes), [[]]);
		assert.deepEqual(splitSimpleCommands("sort < in.txt").map((simple) => simple.writes), [[]]);
	});

	it("转义的分隔符不切段", () => {
		assert.deepEqual(splitSimpleCommands("echo a\\;b").map((simple) => simple.words), [["echo", "a;b"]]);
	});
});

describe("stripHeredocBodies", () => {
	it("heredoc 正文换成空行，结束行保留", () => {
		const stripped = stripHeredocBodies("cat <<EOF\nrm -rf x\nEOF\nls");
		assert.ok(!stripped.includes("rm -rf x"));
		assert.match(stripped, /ls/);
	});

	it("<<- 的制表符缩进结束符也能认出", () => {
		const stripped = stripHeredocBodies("cat <<-EOF\n\trm -rf x\n\tEOF\nls");
		assert.ok(!stripped.includes("rm -rf x"));
		assert.match(stripped, /ls/);
	});

	it("引号分隔符（<<'EOF'）也识别", () => {
		const stripped = stripHeredocBodies("cat <<'EOF'\nrm -rf x\nEOF");
		assert.ok(!stripped.includes("rm -rf x"));
	});

	it("没有结束符时原样返回，不吞掉后面的命令", () => {
		const command = "cat <<EOF\nactive";
		assert.equal(stripHeredocBodies(command), command);
		assert.equal(inspectBashCommand(command).ok, true, "不确定时保守放行");
	});
});
