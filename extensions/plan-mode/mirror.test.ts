/**
 * Tests for the plan-mode ⇄ simple-task mirror — the cross-extension wiring.
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/mirror.test.ts
 *
 * 这个文件测的是**两个扩展装在一起**时的行为（`plan-mirror.ts` 的纯函数由
 * `simple-task/plan-mirror.test.ts` 覆盖，plan-mode 自己的接线由 `index.test.ts` 覆盖）。
 * 为什么要单独一个集成测试：这条链路上最容易坏的是「事件名/载荷对不上」——
 * 一端 emit 了没人听、另一端听了但字段名拼错，两边各自的单测都不会发现。
 *
 * 两个扩展由 pi 自己的加载器装进**同一个事件总线**，走的全是真实代码路径：
 * 进 plan → 提交计划被批准 → simple-task 真的收到镜像并按 id=步号建条目 →
 * 调 task_update → simple-task 广播 → plan-mode 状态行跟着变。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSIONS = [path.join(HERE, "index.ts"), path.join(HERE, "..", "simple-task", "index.ts")];
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

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
			/* 不是符号链接 */
		}
		try {
			const match = /^# cmd-shim-target=(.+)$/m.exec(fs.readFileSync(shimPath, "utf8"));
			if (match?.[1]) candidates.push(path.join(path.dirname(match[1].trim()), "index.js"));
		} catch {
			/* 读不到这个 shim */
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
			/* 空壳副本 */
		}
	}
	return undefined;
}

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

interface LoadedExtension {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>>;
	tools: Map<string, { definition: { execute: (...args: unknown[]) => Promise<unknown> } }>;
}

type ToolResult = { content: Array<{ text?: string }> };

async function loadBoth() {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			paths: string[],
			cwd: string,
			agentDir: string,
			eventBus: unknown,
		) => Promise<{
			extensions: LoadedExtension[];
			errors: Array<{ path: string; error: string }>;
			runtime: Record<string, unknown>;
		}>;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-mirror-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);

	const statuses: string[] = [];
	const widgets: Array<{ key: string; value: unknown }> = [];
	const activeTools = ["read", "bash", "edit", "write", "task_set", "task_update", "task_get"];
	/** `appendEntry` 录下来的会话条目 —— 跨「重启」重放靠它。 */
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	/**
	 * 显式喂给 `sessionManager` 的条目（`setSessionEntries`）。
	 * 默认（未喂）= 直接用 `entries`；喂过之后跨 reboot 保持 —— 它们模拟的是
	 * 「磁盘上那份会话日志」，而重启不会改变它。
	 */
	let branchOverride: Array<Record<string, unknown>> | undefined;
	let allEntriesOverride: Array<Record<string, unknown>> | undefined;

	// 两个扩展装进**同一个**总线：跨扩展事件就是靠它连起来的。
	// 总线和会话日志都活在 `loadBoth` 外面 —— 进程重启会重装扩展，但这两样不会。
	const busHandlers = new Map<string, Set<(data: unknown) => void>>();
	const bus = {
		on(channel: string, handler: (data: unknown) => void) {
			const set = busHandlers.get(channel) ?? new Set<(data: unknown) => void>();
			busHandlers.set(channel, set);
			set.add(handler);
			return () => set.delete(handler);
		},
		emit(channel: string, data: unknown) {
			for (const handler of [...(busHandlers.get(channel) ?? [])]) handler(data);
		},
	};

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: projectDir,
		isIdle: () => true,
		sessionManager: {
			getEntries: () => allEntriesOverride ?? (entries as Array<Record<string, unknown>>),
			getBranch: () => branchOverride ?? (entries as Array<Record<string, unknown>>),
		},
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				strikethrough: (text: string) => text,
			},
			setStatus: (key: string, value: string | undefined) => {
				statuses.push(`${key}=${value}`);
			},
			setWidget: (key: string, value: unknown) => {
				widgets.push({ key, value });
			},
			notify: () => {},
			confirm: async () => true,
			onTerminalInput: () => () => {},
		},
	};

	/**
	 * 装一遍扩展并跑首次 `session_start` —— 这就是**启动或重启 pi**。
	 *
	 * 加载器用 jiti（`moduleCache: false`）每次都重新求值模块，所以第二次调用拿到的
	 * 是干净的模块状态（实测过：工厂函数确实会被重跑）。
	 * `agentDir`/`projectDir` 传临时目录是关键 —— 若用真实的 `~/.pi/agent`，
	 * `discoverAndLoadExtensions` 会把本机 32 个扩展全装一遍。
	 */
	const boot = async (reason: string) => {
		const loaded = await pi.discoverAndLoadExtensions(EXTENSIONS, projectDir, agentDir, bus);
		assert.deepEqual(loaded.errors, [], "两个扩展都应能加载");
		assert.equal(loaded.extensions.length, 2);

		Object.assign(loaded.runtime, {
			sendMessage: async () => {},
			sendUserMessage: async () => {},
			appendEntry: (customType: string, data: unknown) => {
				entries.push({ type: "custom", customType, data });
			},
			setSessionName: () => {},
			getSessionName: () => undefined,
			setLabel: () => {},
			getActiveTools: () => [...activeTools],
			getAllTools: () => [],
			setActiveTools: (names: string[]) => {
				activeTools.length = 0;
				activeTools.push(...names);
			},
			refreshTools: () => {},
			getCommands: () => [],
		});

		// 真实加载顺序：`discoverExtensionsInDir` 用 `fs.readdirSync` 的目录顺序，
		// 本机实测 plan-mode 在前（第 12 位）、simple-task 在后（第 17 位）。
		// 时序缺陷就藏在这个顺序里，所以这里显式排序，不依赖加载器的默认次序。
		const extensions = [...loaded.extensions].sort((a, b) => {
			const rank = (extension: LoadedExtension) =>
				EXTENSIONS.findIndex((entry) => extension.path === entry);
			return rank(a) - rank(b);
		});

		for (const extension of extensions) {
			for (const handler of extension.handlers.get("session_start") ?? []) {
				await handler({ reason }, ctx);
			}
		}
		return { extensions, runtime: loaded.runtime };
	};

	const booted = await boot("startup");
	let session = booted;

	const tool = (name: string) => {
		for (const extension of session.extensions) {
			const entry = extension.tools.get(name);
			if (entry) return entry.definition.execute;
		}
		throw new Error(`没有注册工具 ${name}`);
	};
	const callTool = async (name: string, params: unknown): Promise<ToolResult> =>
		(await tool(name)(`call-${name}`, params, undefined, undefined, ctx)) as ToolResult;

	/** 某个 widget key 最后一次被设置成的值。 */
	const lastWidget = (key: string) => [...widgets].reverse().find((entry) => entry.key === key)?.value;
	/** 最后一次状态行文案。 */
	const lastStatus = () => statuses.at(-1) ?? "";

	/** 跑某个事件的全部处理器（顺序按加载顺序，即 plan-mode 先）。 */
	const runEvent = async (event: string, payload: unknown = {}) => {
		for (const extension of session.extensions) {
			for (const handler of extension.handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		}
	};

	return {
		callTool,
		lastWidget,
		lastStatus,
		runEvent,
		entries,
		/**
		 * 重启 pi 并重开会话：**重新加载两个扩展模块**（模块级 state 归零），
		 * 再用同一份会话日志按真实顺序重跑 `session_start`。
		 *
		 * 必须重装模块而不是只重跑 `session_start` —— 缺陷的前提是
		 * simple-task 的内存 `state` 还是模块加载时的 `emptyState()`。
		 */
		reboot: async (reason: string) => {
			session = await boot(reason);
		},
		/**
		 * 直接给两个 `sessionManager` 方法喂值（构造「活动分支 ≠ 全量条目」）。
		 * 喂过之后跨 reboot 保持，不再回退到 `entries`。
		 */
		setSessionEntries: (next: { branch?: unknown[]; all?: unknown[] }) => {
			if (next.branch) branchOverride = next.branch as Array<Record<string, unknown>>;
			if (next.all) allEntriesOverride = next.all as Array<Record<string, unknown>>;
		},
		cleanup: async () => {
			// 先跑 session_shutdown：simple-task 的 spinner 是个 setInterval，有进行中任务时
			// 会一直 tick，不关掉事件循环就不会退出（测试进程挂死）。这也是 pi 真实行为。
			for (const extension of session.extensions) {
				for (const handler of extension.handlers.get("session_shutdown") ?? []) {
					await handler({}, ctx);
				}
			}
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

test("批准计划后步骤成为 simple-task 的清单；task_update 驱动状态行", { skip, timeout: 60_000 }, async () => {
	const session = await loadBoth();
	try {
		// 模型自行进入 plan（等价于用户 shift+tab），再提交两步计划（confirm 恒真 → 直接批准）
		await session.callTool("enter_plan_mode", { reason: "集成测试" });
		await session.callTool("exit_plan_mode", { steps: [{ text: "改 A" }, { text: "改 B" }] });

		// 1) simple-task 收到了镜像：清单 2 条，id 就是步号，文案带前缀
		const list = (await session.callTool("task_get", {})).content[0]?.text ?? "";
		assert.match(list, /\[ \] #1 plan: 1\. 改 A/, `清单应含镜像条目 #1，实际 ${list}`);
		assert.match(list, /\[ \] #2 plan: 2\. 改 B/, `清单应含镜像条目 #2，实际 ${list}`);

		// 2) plan-mode 交出了自己的步骤 widget —— 屏幕上只剩 simple-task 那一份
		assert.equal(session.lastWidget("plan-steps"), undefined, "execute 期不该再有 plan-steps widget");
		assert.equal(session.lastStatus(), "plan-mode=▶ 0/2 executing", "刚批准时状态行是 0/2");

		// 3) 模型用 task_update 推进（不是 [DONE:n]）→ 状态行必须跟着走
		await session.callTool("task_update", { id: 1, status: "done" });
		assert.match(session.lastStatus(), /▶ 1\/2 executing/, `状态行应显示 1/2，实际 ${session.lastStatus()}`);

		// 4) 全部标完 → 自动收尾、模式回 normal，但清单留在屏幕上
		await session.callTool("task_update", { id: 2, status: "done" });
		assert.match(session.lastStatus(), /⏵ normal/, `完成后应回 normal，实际 ${session.lastStatus()}`);
		const after = (await session.callTool("task_get", {})).content[0]?.text ?? "";
		assert.match(after, /\[x\] #1/, "收尾后清单应保留（用户还要回看刚跑完的列表）");
	} finally {
		await session.cleanup();
	}
});

test("退出 plan 清掉镜像条目，手建任务不受影响", { skip, timeout: 60_000 }, async () => {
	const session = await loadBoth();
	try {
		await session.callTool("enter_plan_mode", { reason: "集成测试" });
		await session.callTool("exit_plan_mode", { steps: [{ text: "改 A" }] });
		assert.match((await session.callTool("task_get", {})).content[0]?.text ?? "", /#1 plan: 1\. 改 A/);

		// shift+tab 等价路径：直接再进一次 plan 会让 leave() 走清镜像分支
		await session.callTool("enter_plan_mode", { reason: "再来一次" });
		await session.callTool("exit_plan_mode", { steps: [{ text: "改 C" }] });
		const list = (await session.callTool("task_get", {})).content[0]?.text ?? "";
		assert.match(list, /#1 plan: 1\. 改 C/, `重拟计划应替换镜像条目，实际 ${list}`);
		assert.ok(!list.includes("改 A"), `旧计划的条目应被替换掉，实际 ${list}`);
	} finally {
		await session.cleanup();
	}
});

test("session_start 顺序为 plan-mode 先时，重开会话不丢手建任务", { skip, timeout: 60_000 }, async () => {
	const session = await loadBoth();
	try {
		// 1) 先建手建清单
		await session.callTool("task_set", { tasks: ["手建甲", "手建乙"] });
		// 2) 再批准一个计划（镜像进来）
		await session.callTool("enter_plan_mode", { reason: "集成测试" });
		await session.callTool("exit_plan_mode", { steps: [{ text: "计划一" }, { text: "计划二" }] });
		await session.callTool("task_update", { id: 1, status: "done" });

		const before = (await session.callTool("task_get", {})).content[0]?.text ?? "";
		assert.match(before, /手建甲/, `重开会话前手建任务应在，实际 ${before}`);

		// 3) 重启 pi 并重开会话：两个扩展模块重新加载（state 归零），
		//    再按真实顺序（plan-mode 先）重跑 session_start
		await session.reboot("resume");
		const after = (await session.callTool("task_get", {})).content[0]?.text ?? "";

		assert.match(after, /手建甲/, `重开会话不该删掉手建任务；之前 ${before}，现在 ${after}`);
		assert.match(after, /手建乙/);
		assert.match(after, /plan: 1\. 计划一/);
		assert.match(after, /#4 手建乙|#3 手建甲/, `手建任务应被顺延到镜像之后，实际 ${after}`);
	} finally {
		await session.cleanup();
	}
});

test("冷启动时 plan-mode 先恢复 execute 态，镜像不会抹掉会话里的手建任务", { skip, timeout: 60_000 }, async () => {
	const session = await loadBoth();
	try {
		await session.callTool("task_set", { tasks: ["手建甲", "手建乙"] });
		await session.callTool("enter_plan_mode", { reason: "集成测试" });
		await session.callTool("exit_plan_mode", { steps: [{ text: "计划一" }, { text: "计划二" }] });
		await session.callTool("task_update", { id: 1, status: "done" });

		// 重启：两个扩展都从零开始，plan-mode 的 session_start 先跑 ——
		// 它推镜像时 simple-task 还没有 ctx（那次同步必须被搁置，不能按空清单重建）
		await session.reboot("resume");

		const list = (await session.callTool("task_get", {})).content[0]?.text ?? "";
		assert.match(list, /手建甲/, `手建任务必须还在，实际 ${list}`);
		assert.match(list, /手建乙/);
		assert.match(list, /\[x\] #1 plan: 1\. 计划一/, `镜像仍在且带上了完成态，实际 ${list}`);
		assert.equal(session.entries.at(-1)?.customType, "simple-task-state", "最后一次写入应是修复后的清单");
	} finally {
		await session.cleanup();
	}
});

test("被丢弃分支上的计划不会在重开会话时复活", { skip, timeout: 60_000 }, async () => {
	const session = await loadBoth();
	try {
		// 活动分支：没有 plan-mode 记录；全量条目里留一条已不上分支的 execute 计划
		session.setSessionEntries({
			branch: [{ type: "message", message: { role: "user", content: "hi" } }],
			all: [
				{ type: "message", message: { role: "user", content: "hi" } },
				{
					type: "custom",
					customType: "plan-mode",
					data: { phase: "execute", steps: [{ step: 1, text: "旧分支步骤", done: false }] },
				},
			],
		});
		await session.reboot("resume");

		assert.match(
			session.lastStatus(),
			/normal/,
			`不该复活被丢弃分支上的计划，实际 ${session.lastStatus()}`,
		);
	} finally {
		await session.cleanup();
	}
});

test("手建任务与镜像步号撞号时端到端顺延，且 task_update 打得到它", { skip, timeout: 60_000 }, async () => {
	const session = await loadBoth();
	try {
		await session.callTool("task_set", { tasks: ["手建甲", "手建乙"] });
		await session.callTool("enter_plan_mode", { reason: "集成测试" });
		await session.callTool("exit_plan_mode", { steps: [{ text: "计划一" }, { text: "计划二" }] });

		const list = (await session.callTool("task_get", {})).content[0]?.text ?? "";
		assert.match(list, /\[ \] #1 plan: 1\. 计划一/, `镜像优先占 1..N，实际 ${list}`);
		assert.match(list, /\[ \] #3 手建甲/, `撞号的手建任务应顺延到 #3，实际 ${list}`);
		assert.match(list, /\[ \] #4 手建乙/, `实际 ${list}`);

		// 顺延后的 id 必须真的可寻址（旧缺陷：两个 #1，task_update 永远只打到镜像）
		await session.callTool("task_update", { id: 3, status: "in_progress" });
		const after = (await session.callTool("task_get", {})).content[0]?.text ?? "";
		assert.match(after, /\[~\] #3 手建甲/, `task_update #3 应打到手建甲，实际 ${after}`);
		assert.match(session.lastStatus(), /▶ 0\/2/, "手建任务不推进计划进度");
	} finally {
		await session.cleanup();
	}
});

test("模型违规 task_set 冲掉镜像后，turn_start 把镜像重新推回去", { skip, timeout: 60_000 }, async () => {
	const session = await loadBoth();
	try {
		await session.callTool("enter_plan_mode", { reason: "集成测试" });
		await session.callTool("exit_plan_mode", { steps: [{ text: "计划一" }, { text: "计划二" }] });
		// 模型无视约定，用自己的清单整体替换（镜像条目被冲掉），且此时计划一步都没完成
		await session.callTool("task_set", { tasks: ["模型自己写的"] });

		const wiped = (await session.callTool("task_get", {})).content[0]?.text ?? "";
		assert.ok(!wiped.includes("plan: 1."), `镜像应已被冲掉，实际 ${wiped}`);

		await session.runEvent("turn_start");

		const restored = (await session.callTool("task_get", {})).content[0]?.text ?? "";
		assert.match(restored, /\[ \] #1 plan: 1\. 计划一/, `镜像应被重推回来，实际 ${restored}`);
		assert.match(restored, /模型自己写的/, "模型自己的任务不该被丢掉");
	} finally {
		await session.cleanup();
	}
});
