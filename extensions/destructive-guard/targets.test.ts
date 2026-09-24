/**
 * Tests for targets.ts — 删除目标的抽取与判定。
 *
 * Run with:  node --test clients/pi/extensions/destructive-guard/targets.test.ts
 *
 * 两组断言：**必拦**（危险目标一个不能漏）和**必放行**（工作目录内的正常清理不能误伤）。
 * 后者同样重要 —— 一个总在弹窗的守卫等于没有守卫。判定口径来自 `AGENTS.md` 的
 * `## Destructive actions`。
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

/** 这条命令的判定结果（只看 verdict 列表，文案不钉死）。 */
function verdicts(command: string): string[] {
	return inspectBash(command, CWD, HOME).map((finding) => finding.verdict);
}

/** 命令是否会被拦（block 或 confirm 都算“会拦”）。 */
function caught(command: string): boolean {
	return inspectBash(command, CWD, HOME).length > 0;
}

describe("resolveLexical", () => {
	it("把相对路径拼到 cwd 上", () => {
		assert.equal(resolveLexical("dist", CWD, HOME), `${CWD}/dist`);
		assert.equal(resolveLexical("./dist", CWD, HOME), `${CWD}/dist`);
	});

	it("展开 ~", () => {
		assert.equal(resolveLexical("~", CWD, HOME), HOME);
		assert.equal(resolveLexical("~/.cache/nvim", CWD, HOME), `${HOME}/.cache/nvim`);
	});

	it("消掉 . 与 ..", () => {
		assert.equal(resolveLexical("/Users/bachi/x/../y", CWD, HOME), "/Users/bachi/y");
		assert.equal(resolveLexical("/tmp/..", CWD, HOME), "/");
		assert.equal(resolveLexical("/Users/bachi/..", CWD, HOME), "/Users");
	});

	it("含未展开变量时返回空串（不假装知道目标）", () => {
		assert.equal(resolveLexical("$UNSET/x", CWD, HOME), "");
		assert.equal(resolveLexical("${A:-/}", CWD, HOME), "");
		assert.equal(resolveLexical("$(mktemp -d)/x", CWD, HOME), "");
		assert.equal(resolveLexical("`pwd`/x", CWD, HOME), "");
	});
});

describe("componentCount", () => {
	it("数段数", () => {
		assert.equal(componentCount("/"), 0);
		assert.equal(componentCount("/tmp"), 1);
		assert.equal(componentCount("/usr/local/bin"), 3);
		assert.equal(componentCount(""), 0);
	});
});

describe("stripQuotes / splitWords / splitSegments", () => {
	it("剥最外层成对引号", () => {
		assert.equal(stripQuotes('"/tmp/x"'), "/tmp/x");
		assert.equal(stripQuotes("'/tmp/x'"), "/tmp/x");
		assert.equal(stripQuotes("/tmp/x"), "/tmp/x");
	});

	it("按空格切词并保留引号", () => {
		assert.deepEqual(splitWords('rm -rf "/tmp/a b"'), ["rm", "-rf", '"/tmp/a b"']);
	});

	it("命令替换/变量展开整体算一个词，不被空格切碎", () => {
		assert.deepEqual(splitWords('rm -rf $(dirname "$LOG")'), ["rm", "-rf", '$(dirname "$LOG")']);
		assert.deepEqual(splitWords("rm -rf `pwd`/x"), ["rm", "-rf", "`pwd`/x"]);
		assert.deepEqual(splitWords('rm -rf "${OUT:?}"/dist'), ["rm", "-rf", '"${OUT:?}"/dist']);
		// 嵌套括号
		assert.deepEqual(splitWords("rm -rf $(echo $(pwd)/x)"), ["rm", "-rf", "$(echo $(pwd)/x)"]);
		// 替换内部带引号括号也不乱
		assert.deepEqual(splitWords('rm -rf $(echo ")")'), ["rm", "-rf", '$(echo ")")']);
	});

	it("切不碎的命令替换不再产生碎片目标", () => {
		const sites = extractDeleteSites('rm -rf $(dirname "$LOG")');
		assert.deepEqual(sites[0]!.targets, ['$(dirname "$LOG")']);
	});

	it("按 shell 边界切片段且引号感知", () => {
		assert.deepEqual(splitSegments("a && b || c ; d | e"), ["a", "b", "c", "d", "e"]);
		assert.deepEqual(splitSegments('echo "a;b" ; ls'), ['echo "a;b"', "ls"]);
	});
});

describe("extractDeleteSites", () => {
	it("认得 rm 的目标", () => {
		const sites = extractDeleteSites("rm -rf /tmp/x /tmp/y");
		assert.equal(sites.length, 1);
		assert.equal(sites[0]!.command, "rm");
		assert.deepEqual(sites[0]!.targets, ["/tmp/x", "/tmp/y"]);
	});

	it("`--` 之后一律算目标", () => {
		const sites = extractDeleteSites("rm -- -rf");
		assert.deepEqual(sites[0]!.targets, ["-rf"]);
	});

	it("认得 find -delete", () => {
		const sites = extractDeleteSites("find /var/log -name '*.gz' -delete");
		assert.equal(sites.length, 1);
		assert.deepEqual(sites[0]!.targets, ["/var/log"]);
	});

	it("认得 find -exec rm", () => {
		assert.equal(extractDeleteSites("find . -exec rm {} \\;").length, 1);
	});

	it("认得 git clean -fdx", () => {
		const sites = extractDeleteSites("git clean -fdx");
		assert.equal(sites[0]!.command, "git clean");
	});

	it("git clean 不带 -f/-x 时不算", () => {
		assert.equal(extractDeleteSites("git clean -n").length, 0);
	});

	it("认得 rsync --delete 的目的地", () => {
		const sites = extractDeleteSites("rsync -a --delete src/ /dest/");
		assert.equal(sites[0]!.command, "rsync --delete");
		assert.deepEqual(sites[0]!.targets, ["/dest/"]);
	});

	it("纯读命令不产生调用点", () => {
		assert.equal(extractDeleteSites("ls -la /tmp").length, 0);
		assert.equal(extractDeleteSites("git status").length, 0);
		assert.equal(extractDeleteSites("cat /etc/hosts").length, 0);
	});
});

describe("evaluateTarget — 必拦", () => {
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
		it(`拦 ${target}`, () => {
			const finding = evaluateTarget(target, CWD, HOME);
			assert.ok(finding, `${target} 应该命中`);
			assert.equal(finding.verdict, "block", `${target} 应该是 block`);
		});
	}

	it("受保护目录的祖先也拦（/Users 是 /Users/bachi 的上级）", () => {
		const finding = evaluateTarget("/Users/bachi/..", CWD, HOME);
		assert.equal(finding?.rule, "top-level");
	});
});

describe("evaluateTarget — 事故形态", () => {
	it("兜底值进删除目标 → confirm", () => {
		const finding = evaluateTarget('"/tmp" ?? "/tmp"', CWD, HOME);
		assert.equal(finding?.verdict, "confirm");
		assert.equal(finding?.rule, "fallback-in-target");
	});

	it("path.dirname 这类运算 → confirm", () => {
		const finding = evaluateTarget("$(dirname /tmp)", CWD, HOME);
		assert.equal(finding?.verdict, "confirm");
	});

	it("未展开变量 → confirm（不是放行）", () => {
		const finding = evaluateTarget("$TARGET", CWD, HOME);
		assert.equal(finding?.verdict, "confirm");
		assert.equal(finding?.rule, "derived-target");
	});
});

describe("evaluateTarget — 必放行（不误伤）", () => {
	const mustAllow = [
		`${CWD}/dist`,
		`${CWD}/node_modules`,
		`${CWD}/adapter/coverage`,
		"/tmp/va-abc123",
		"/usr/local/bin/tsc",
	];

	for (const target of mustAllow) {
		it(`放行 ${target}`, () => {
			assert.equal(evaluateTarget(target, CWD, HOME), undefined, `${target} 不该被拦`);
		});
	}

	it("工作目录内与临时目录的正常清理整条命令放行", () => {
		assert.equal(caught(`rm -rf ${CWD}/dist`), false);
		assert.equal(caught(`rm -rf ${CWD}/node_modules`), false);
		assert.equal(caught("rm -f /tmp/scratch.log"), false);
		assert.equal(caught("rm -rf /private/tmp/dg-abc123"), false);
	});

	it("工作目录外、但不在主目录里的具体文件放行（包管理器地盘）", () => {
		assert.equal(evaluateTarget("/usr/local/bin/tsc", CWD, HOME), undefined);
		assert.equal(evaluateTarget("/opt/homebrew/lib/x", CWD, HOME), undefined);
	});
});

describe("evaluateTarget — 工作目录之外要确认（AGENTS.md 第三条断言）", () => {
	it("主目录内、工作目录外的路径 → confirm", () => {
		const finding = evaluateTarget(`${HOME}/.cache/nvim`, CWD, HOME);
		assert.equal(finding?.verdict, "confirm");
		assert.equal(finding?.rule, "outside-workdir");
	});

	it("本次事故的全部损失面都命中 outside-workdir", () => {
		for (const target of [
			`${HOME}/.zshrc`,
			`${HOME}/.gitconfig`,
			`${HOME}/.zprofile`,
			`${HOME}/.pi/agent/npm`,
		]) {
			const finding = evaluateTarget(target, CWD, HOME);
			assert.ok(finding, `${target} 应该命中`);
			assert.equal(finding.rule, "outside-workdir", `${target} 应该是 outside-workdir`);
		}
	});

	it("临时目录是“本会话创建”的近似，不弹窗", () => {
		assert.equal(evaluateTarget("/var/folders/dh/x/T/dg-abc", CWD, HOME), undefined);
		assert.equal(evaluateTarget(`${HOME}/.pi/agent/../../../tmp/x`, CWD, HOME), undefined);
	});

	it("工作目录内的路径不命中 outside-workdir", () => {
		assert.equal(evaluateTarget(`${CWD}/dist`, CWD, HOME), undefined);
	});
});

describe("evaluateTarget — 守卫自保护", () => {
	it("删守卫自己的目录 → block", () => {
		const finding = evaluateTarget(`${HOME}/.pi/agent/extensions/destructive-guard`, CWD, HOME);
		assert.equal(finding?.verdict, "block");
		assert.equal(finding?.rule, "self-protection");
	});

	it("删全局规则文件 AGENTS.md → block", () => {
		const finding = evaluateTarget(`${HOME}/.pi/agent/AGENTS.md`, CWD, HOME);
		assert.equal(finding?.verdict, "block");
		assert.equal(finding?.rule, "self-protection");
	});

	it("删 agent 目录下的 extensions / sessions / rewind 子树 → block", () => {
		for (const target of [
			`${HOME}/.pi/agent/extensions`,
			`${HOME}/.pi/agent/sessions`,
			`${HOME}/.pi/agent/rewind`,
		]) {
			const finding = evaluateTarget(target, CWD, HOME);
			assert.equal(finding?.verdict, "block", `${target} 应该 block`);
			assert.equal(finding?.rule, "self-protection", `${target} 应该是 self-protection`);
		}
	});

	it("仓库里的守卫副本同样受保护", () => {
		const finding = evaluateTarget(`${CWD}/clients/pi/extensions/destructive-guard`, CWD, HOME);
		assert.equal(finding?.verdict, "block");
		assert.equal(finding?.rule, "self-protection");
	});
});

describe("读命令不误伤", () => {
	it("读命令放行", () => {
		assert.equal(caught("ls -la /usr/local/bin"), false);
		assert.equal(caught("cat /etc/hosts"), false);
		assert.equal(caught("find /Users/bachi -name '*.log'"), false);
	});
});

describe("inspectBash — 事故回放", () => {
	it("拦下 `rm -rf $(dirname /tmp)` 这条形态", () => {
		const findings = inspectBash("rm -rf $(dirname /tmp)", CWD, HOME);
		assert.ok(findings.length > 0, "必须命中");
	});

	it("拦下变量目标（`rm -rf $UNSET/*` 的形态）", () => {
		const findings = inspectBash("rm -rf $UNSET/*", CWD, HOME);
		assert.ok(findings.length > 0);
		assert.equal(findings[0]!.verdict, "confirm");
	});

	it("拦下裸根", () => {
		const findings = inspectBash("rm -rf /", CWD, HOME);
		assert.equal(findings[0]!.verdict, "block");
	});

	it("拦下受保护树的上级", () => {
		assert.equal(inspectBash("rm -rf /Users", CWD, HOME)[0]!.verdict, "block");
		assert.equal(inspectBash("rm -rf /usr", CWD, HOME)[0]!.verdict, "block");
	});

	it("链式命令里只要有一段危险就命中", () => {
		assert.ok(caught(`cd ${CWD} && rm -rf /Users`));
		assert.ok(caught(`ls /tmp; rm -rf /etc`));
	});

	it("`&&` 后的正常清理不误伤", () => {
		assert.equal(caught(`cd ${CWD} && rm -rf dist && npm run build`), false);
	});
});
