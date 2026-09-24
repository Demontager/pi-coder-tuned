/**
 * Tests for index.ts — destructive-guard 的接线（用 pi 自己的加载器真实加载）。
 *
 * Run with:  node --test clients/pi/extensions/destructive-guard/index.test.ts
 *
 * 覆盖的是**接线**而不是判定逻辑（判定在 targets.test.ts / writes.test.ts 里）。所以断言
 * 集中在：pi 的加载器真的能装好这个扩展、危险调用真的被 block、无害调用真的放行、非交互
 * 环境 fail closed、`PI_DESTRUCTIVE_GUARD` 的四个模式各自生效。
 *
 * 找不到本机 pi 的库入口就整体 skip（不假装通过）—— 同 plan-mode/index.test.ts。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderFindingsForHuman, truncateMiddle, writeTargetLabel } from "./index.ts";
import { extractGitHistoryLoss, inspectBash } from "./targets.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/** pi 的库入口（非 CLI）。判定方式是能不能真 import，不是路径存不存在。 */
async function findPiLibraryEntry(): Promise<string | undefined> {
	const candidates: string[] = [];
	if (process.env.PI_TEST_PI_ENTRY) candidates.push(process.env.PI_TEST_PI_ENTRY);

	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const shimPath = path.join(dir, "pi");
		try {
			const real = fs.realpathSync(shimPath);
			if (real !== shimPath) candidates.push(path.join(path.dirname(real), "index.js"));
		} catch {
			// 不是符号链接 / 不存在：看下面的 shim 脚本
		}
		try {
			const match = /^# cmd-shim-target=(.+)$/m.exec(fs.readFileSync(shimPath, "utf8"));
			if (match?.[1]) candidates.push(path.join(path.dirname(match[1].trim()), "index.js"));
		} catch {
			// 读不到这个 shim：跳过
		}
	}

	const packageDir = path.join(os.homedir(), ".pi/agent/npm/node_modules/@earendil-works/pi-coding-agent");
	candidates.push(path.join(packageDir, "dist/bundle/index.js"), path.join(packageDir, "dist/index.js"));

	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			await import(pathToFileURL(candidate).href);
			return candidate;
		} catch {
			// 空壳副本：换下一个候选
		}
	}
	return undefined;
}

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

/** 钩子返回值。 */
interface Verdict {
	block?: boolean;
	reason?: string;
}

interface Harness {
	call: (toolName: string, input: Record<string, unknown>) => Promise<Verdict>;
	notifies: string[];
	selects: string[];
	/** 钩子看到的 cwd（临时 projectDir）。“工作目录内”的断言必须用它，不能用 process.cwd()。 */
	cwd: string;
	cleanup: () => void;
}

/**
 * 用 pi 的加载器真实加载扩展，返回一个把 tool_call 喂进去的 runner。
 *
 * 注意 `session_start` 会在 `call` 之前被触发一次 —— 扩展在工厂期读一次模式、在
 * `session_start` 再读一次，所以要测模式开关必须走这条路（改环境变量后重开一个 harness）。
 */
async function loadHarness(options: { hasUI?: boolean; selectAnswer?: string } = {}): Promise<Harness> {
	const { hasUI = true, selectAnswer = "取消" } = options;
	const pi = (await import(pathToFileURL(piEntry!).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dg-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });

	const bus = { on: () => () => undefined, emit: () => undefined };
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, bus);
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const extension = loaded.extensions[0];
	assert.ok(extension, "应该加载到一个扩展");

	const notifies: string[] = [];
	const selects: string[] = [];
	const ctx = {
		mode: "tui",
		hasUI,
		cwd: projectDir,
		ui: {
			notify: (text: string) => notifies.push(text),
			select: async (prompt: string) => {
				selects.push(prompt);
				return selectAnswer;
			},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};

	// session_start 也要跑：扩展在那里重读模式。
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, ctx);
	}

	return {
		notifies,
		selects,
		cwd: projectDir,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
		async call(toolName: string, input: Record<string, unknown>): Promise<Verdict> {
			for (const handler of extension.handlers.get("tool_call") ?? []) {
				const verdict = (await handler({ toolName, input }, ctx)) as Verdict | undefined;
				if (verdict?.block) return verdict;
			}
			return {};
		},
	};
}

interface LoadedExtension {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>;
}

/** 每次测试前后清掉模式变量，避免互相污染。 */
function withMode<T>(mode: string | undefined, run: () => Promise<T>): Promise<T> {
	const prior = process.env.PI_DESTRUCTIVE_GUARD;
	if (mode === undefined) delete process.env.PI_DESTRUCTIVE_GUARD;
	else process.env.PI_DESTRUCTIVE_GUARD = mode;
	return run().finally(() => {
		if (prior === undefined) delete process.env.PI_DESTRUCTIVE_GUARD;
		else process.env.PI_DESTRUCTIVE_GUARD = prior;
	});
}

test("危险删除命令被拦下", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const verdict = await guard.call("bash", { command: "rm -rf /" });
		assert.equal(verdict.block, true, "rm -rf / 必须被拦");
		assert.match(verdict.reason ?? "", /destructive-guard/);
	} finally {
		guard.cleanup();
	}
});

test("受保护目录的上级被拦下", { skip }, async () => {
	const guard = await loadHarness();
	try {
		assert.equal((await guard.call("bash", { command: "rm -rf /Users" })).block, true);
		assert.equal((await guard.call("bash", { command: "rm -rf /usr" })).block, true);
		assert.equal((await guard.call("bash", { command: "rm -rf /etc" })).block, true);
	} finally {
		guard.cleanup();
	}
});

test("事故形态（dirname + 兜底值）被拦下", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const verdict = await guard.call("bash", { command: "rm -rf $(dirname /tmp)" });
		assert.equal(verdict.block, true, "算出来的目标必须被拦");
	} finally {
		guard.cleanup();
	}
});

test("工作目录内的正常删除放行", { skip }, async () => {
	const guard = await loadHarness();
	try {
		// 用钩子看到的 cwd（临时 projectDir），而不是 process.cwd()（仓库）——
		// 后者在工作目录之外，会（正确地）命中 outside-workdir。
		assert.deepEqual(await guard.call("bash", { command: `rm -rf ${guard.cwd}/dist` }), {});
		assert.deepEqual(await guard.call("bash", { command: "rm -f /tmp/scratch.log" }), {});
		assert.deepEqual(await guard.call("bash", { command: "ls -la /usr" }), {});
		assert.deepEqual(await guard.call("bash", { command: "git status" }), {});
	} finally {
		guard.cleanup();
	}
});

test("写入危险删除代码被拦下", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const verdict = await guard.call("write", {
			path: "verify.mjs",
			content: 'fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true });',
		});
		assert.equal(verdict.block, true, "事故那行代码必须被拦");
	} finally {
		guard.cleanup();
	}
});

test("写入正常删除代码放行", { skip }, async () => {
	const guard = await loadHarness();
	try {
		assert.deepEqual(await guard.call("write", { path: "clean.mjs", content: 'fs.rmSync("/tmp/va-1", { recursive: true });' }), {});
		assert.deepEqual(await guard.call("write", { path: "read.mjs", content: "const text = fs.readFileSync(p, 'utf8');" }), {});
	} finally {
		guard.cleanup();
	}
});

test("edit 的新文本也检查", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const verdict = await guard.call("edit", { path: "a.mjs", oldText: "x", newText: "shutil.rmtree(os.path.dirname(p))" });
		assert.equal(verdict.block, true);
	} finally {
		guard.cleanup();
	}
});

test("非交互环境 fail closed（confirm 也拒）", { skip }, async () => {
	const guard = await loadHarness({ hasUI: false });
	try {
		// 这条属于 confirm 档；没有 UI 可用时不能默认放行。
		const verdict = await guard.call("bash", { command: "rm -rf $UNSET/*" });
		assert.equal(verdict.block, true, "非交互时必须拒");
	} finally {
		guard.cleanup();
	}
});

test("有 UI 时 confirm 档会问一次，回答“取消”则拦", { skip }, async () => {
	const guard = await loadHarness({ hasUI: true, selectAnswer: "取消" });
	try {
		const verdict = await guard.call("bash", { command: "rm -rf $UNSET/*" });
		assert.equal(guard.selects.length, 1, "应该弹了一次确认");
		assert.equal(verdict.block, true, "选取消必须拦");
	} finally {
		guard.cleanup();
	}
});

test("有 UI 时回答“确认删除”则放行", { skip }, async () => {
	const guard = await loadHarness({ hasUI: true, selectAnswer: "确认删除" });
	try {
		const verdict = await guard.call("bash", { command: "rm -rf $UNSET/*" });
		assert.equal(guard.selects.length, 1);
		assert.equal(verdict.block, undefined, "用户确认后应放行");
	} finally {
		guard.cleanup();
	}
});

test("有 UI 时回答“先预览要删什么”则拦下并要求模型先列清单", { skip }, async () => {
	const guard = await loadHarness({ hasUI: true, selectAnswer: "先预览要删什么" });
	try {
		const verdict = await guard.call("bash", { command: "rm -rf $UNSET/*" });
		assert.equal(verdict.block, true, "预览也是拦下（不直接执行）");
		assert.match(verdict.reason ?? "", /先用只读命令/, "理由里要告诉模型先列清单");
	} finally {
		guard.cleanup();
	}
});

test("弹框选项里“取消”是默认项（第一个）", { skip }, async () => {
	const guard = await loadHarness({ hasUI: true, selectAnswer: "取消" });
	try {
		await guard.call("bash", { command: "rm -rf $UNSET/*" });
		assert.equal(guard.selects.length, 1);
		// 弹框正文必须包含“要删”与“为什么拦”，不能只有原始命令。
		assert.match(guard.selects[0]!, /要删：/);
		assert.match(guard.selects[0]!, /为什么拦：/);
		assert.match(guard.selects[0]!, /不会删任何东西/);
	} finally {
		guard.cleanup();
	}
});

test("block 档不弹窗，直接拒", { skip }, async () => {
	await withMode("block", async () => {
		const guard = await loadHarness({ hasUI: true });
		try {
			const verdict = await guard.call("bash", { command: "rm -rf $UNSET/*" });
			assert.equal(verdict.block, true);
			assert.equal(guard.selects.length, 0, "block 档不该弹窗");
		} finally {
			guard.cleanup();
		}
	});
});

test("notify 档只通知不拦", { skip }, async () => {
	await withMode("notify", async () => {
		const guard = await loadHarness({ hasUI: true });
		try {
			const verdict = await guard.call("bash", { command: "rm -rf /" });
			assert.equal(verdict.block, undefined, "notify 档不该拦");
			assert.equal(guard.notifies.length, 1, "应该通知一次");
		} finally {
			guard.cleanup();
		}
	});
});

test("off 档完全不管", { skip }, async () => {
	await withMode("off", async () => {
		const guard = await loadHarness({ hasUI: true });
		try {
			assert.deepEqual(await guard.call("bash", { command: "rm -rf /" }), {});
			assert.equal(guard.notifies.length, 0);
			assert.equal(guard.selects.length, 0);
		} finally {
			guard.cleanup();
		}
	});
});

test("非删除类工具不检查", { skip }, async () => {
	const guard = await loadHarness();
	try {
		assert.deepEqual(await guard.call("read", { path: "/etc/hosts" }), {});
		assert.deepEqual(await guard.call("task_set", { tasks: ["a"] }), {});
	} finally {
		guard.cleanup();
	}
});

// ---- 弹框文案（不依赖 pi 加载器，直接测纯函数）----

const CWD = "/Users/bachi/jaylli/litellm-any";
const HOME = "/Users/bachi";

test("弹框正文：命令替换目标不再显示成碎片", () => {
	const findings = inspectBash('rm -rf $(dirname "$LOG")', CWD, HOME);
	assert.equal(findings.length, 1, "应该只命中一个目标，不是三个碎片");
	const text = renderFindingsForHuman(findings, 'rm -rf $(dirname "$LOG")');
	assert.ok(text.includes('要删：$(dirname "$LOG")'), "目标应该完整显示");
	// 修复前这两个碎片会各自成为一行目标。
	assert.ok(!text.includes("要删：$(dirname\n"), "不该把 $(dirname 单独当目标");
	assert.ok(!text.includes('要删："$LOG")'), "不该把 \"$LOG\") 单独当目标");
});

test("弹框正文：能解析的目标显示实际路径", () => {
	const findings = inspectBash("rm -rf /usr/local/lib/foo", CWD, HOME);
	const text = renderFindingsForHuman(findings, "rm -rf /usr/local/lib/foo");
	assert.ok(text.includes("要删：/usr/local/lib/foo"));
	assert.ok(text.includes("为什么拦"));
});

test("弹框正文：单段命令不重复显示“所在命令”，链式命令才显示", () => {
	const single = inspectBash("rm -rf /usr/local/lib/foo", CWD, HOME);
	assert.ok(!renderFindingsForHuman(single, "rm -rf /usr/local/lib/foo").includes("所在命令"));

	const chained = inspectBash('cd /tmp && rm -rf $(dirname "$X")', CWD, HOME);
	assert.ok(renderFindingsForHuman(chained, 'cd /tmp && rm -rf $(dirname "$X")').includes("所在命令"));
});

test("弹框正文：重复命中去重、超限时折叠", () => {
	const findings = inspectBash("rm -rf $A $B $C $D $E", CWD, HOME);
	const text = renderFindingsForHuman(findings, "rm -rf $A $B $C $D $E", 3);
	assert.ok(text.includes("… 还有 2 处同类命中"));
	assert.ok(!text.includes("要删：$D"), "超过上限的条目不该展开");
});

test("弹框正文：同一目标重复命中只说一次", () => {
	const findings = inspectBash("rm -rf $A; rm -rf $A", CWD, HOME);
	const text = renderFindingsForHuman(findings, "rm -rf $A; rm -rf $A");
	assert.equal(text.match(/要删：/g)?.length, 1);
});

test("truncateMiddle 中间省略保留头尾", () => {
	assert.equal(truncateMiddle("short", 100), "short");
	const long = "a".repeat(200);
	const cut = truncateMiddle(long, 40);
	assert.ok(cut.length <= 40);
	assert.ok(cut.startsWith("aaaa") && cut.endsWith("aaaa") && cut.includes("…"));
});

test("writeTargetLabel 从写入参数里取文件名", () => {
	assert.equal(writeTargetLabel({ path: "verify.mjs" }), " verify.mjs");
	assert.equal(writeTargetLabel({ file_path: "/tmp/a.mjs" }), " /tmp/a.mjs");
	assert.equal(writeTargetLabel({ content: "x" }), "文件");
	assert.equal(writeTargetLabel(null), "文件");
});

// ---- 闸三：运行脚本前把文件读进来判（2026-09-23 事故形态的唯一拦截点）----

test("闸三：即将运行的脚本里有事故形态 → 拦", { skip }, async () => {
	const guard = await loadHarness({ hasUI: true, selectAnswer: "取消" });
	try {
		const script = path.join(guard.cwd, "verify-a.mjs");
		fs.writeFileSync(
			script,
			'import fs from "node:fs";\nimport path from "node:path";\nconst s = { log: [] };\nfs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true });\n',
		);
		const verdict = await guard.call("bash", { command: "node verify-a.mjs" });
		assert.equal(verdict.block, true, "命令词无害、危险在文件里，必须靠闸三拦");
		assert.match(verdict.reason ?? "", /即将运行的脚本|取消/);
	} finally {
		guard.cleanup();
	}
});

test("闸三：干净脚本放行", { skip }, async () => {
	const guard = await loadHarness();
	try {
		const script = path.join(guard.cwd, "clean.mjs");
		fs.writeFileSync(script, 'import fs from "node:fs";\nfs.rmSync("/tmp/va-1", { recursive: true });\n');
		assert.deepEqual(await guard.call("bash", { command: "node clean.mjs" }), {});
	} finally {
		guard.cleanup();
	}
});

test("闸三：读不到的脚本不拦（护栏不是沙箱）", { skip }, async () => {
	const guard = await loadHarness();
	try {
		assert.deepEqual(await guard.call("bash", { command: "node nope.mjs" }), {});
	} finally {
		guard.cleanup();
	}
});

test("闸三：内联代码里的脚本调用也被抽出", { skip }, async () => {
	const guard = await loadHarness({ hasUI: true, selectAnswer: "取消" });
	try {
		const script = path.join(guard.cwd, "a.mjs");
		fs.writeFileSync(script, 'fs.rmSync(path.dirname(x ?? "/tmp"), { recursive: true });');
		const verdict = await guard.call("bash", { command: "sh -c 'node a.mjs'" });
		assert.equal(verdict.block, true, "sh -c 里嵌套的脚本也要读进来判");
	} finally {
		guard.cleanup();
	}
});

// ---- 补丁④：git 破坏性命令（毁掉只此一份的未提交工作）----

test("git 破坏性命令 → confirm", () => {
	for (const command of [
		"git reset --hard HEAD",
		"git reset --hard",
		"git checkout -- .",
		"git checkout -- src/a.ts",
		"git restore .",
		"git stash drop",
		"git stash clear",
		"git branch -D feature-x",
	]) {
		const findings = extractGitHistoryLoss(command);
		assert.ok(findings.length > 0, `${command} 应该命中`);
		assert.equal(findings[0]!.verdict, "confirm", `${command} 应该是 confirm`);
		assert.equal(findings[0]!.rule, "vcs-history-loss");
	}
});

test("git 安全命令不误伤", () => {
	for (const command of [
		"git status",
		"git checkout feature-x",
		"git checkout -b feature-x",
		"git reset --soft HEAD~1",
		"git reset --mixed HEAD~1",
		"git stash push -m wip",
		"git stash list",
		"git branch -d feature-x",
		"git clean -n",
	]) {
		assert.equal(extractGitHistoryLoss(command).length, 0, `${command} 不该命中`);
	}
});

test("git reset --hard 经 inspectBash 端到端命中", () => {
	const findings = inspectBash("git reset --hard HEAD", CWD, HOME);
	assert.ok(findings.some((finding) => finding.rule === "vcs-history-loss"));
});

// ---- 补丁②：工作目录之外要确认（经 inspectBash 端到端）----

test("本次事故的全部损失面经 inspectBash 命中（outside-workdir 或更严的 self-protection）", () => {
	for (const command of [
		"rm -rf ~/.pi/agent/sessions",
		"rm -f ~/.zshrc",
		"rm -f ~/.gitconfig",
		"rm -f ~/.zprofile",
		"rm -rf ~/.claude/sessions ~/.claude/shell-snapshots",
	]) {
		const findings = inspectBash(command, CWD, HOME);
		assert.ok(findings.length > 0, `${command} 应该命中`);
		// ~/.pi/agent/sessions 会先命中更严的 self-protection（block），其余命中 outside-workdir。
		assert.ok(
			findings.some((finding) => finding.rule === "outside-workdir" || finding.rule === "self-protection"),
			`${command} 应该命中 outside-workdir/self-protection，实际：${findings.map((finding) => finding.rule).join(",")}`,
		);
	}
});

test("守卫自己经 inspectBash 命中 self-protection（block）", () => {
	for (const command of [
		"rm -rf ~/.pi/agent/extensions/destructive-guard",
		"rm -f ~/.pi/agent/AGENTS.md",
		`rm -rf ${CWD}/clients/pi/extensions/destructive-guard`,
	]) {
		const findings = inspectBash(command, CWD, HOME);
		assert.ok(findings.some((finding) => finding.rule === "self-protection" && finding.verdict === "block"), command);
	}
});
