/**
 * Tests for the bash block shape (bash-command-collapse.ts) — 端到端：pi 自己的扩展加载器真的加载
 * 本扩展，再用 pi 自己的 `ToolExecutionComponent` 渲染真实的 bash 块，对渲染出来的**行**做断言。
 *
 * Run with:  node --test clients/pi/extensions/bash-command-collapse/render.test.ts
 *
 * 为什么必须绕这一圈（不直接调扩展里的内部函数）：这个特性的**全部**价值在于“用户屏幕上长什么样”，
 * 而屏幕上的行是 `ToolExecutionComponent` → `renderCall` / `renderResult` → Box → pi-tui 折行
 * 一层层叠出来的。只测内部函数会漏掉实测踩过的那些问题：`└ ` 逐 child 画会出现两个、续行前缀
 * 挂错导致正文列跑偏、超宽行被 pi-tui 的渲染截掉、`state.resultSeen` 没让前缀从缩切换成 `│`。
 *
 * 断言口径（用户 2026-09-21 定的形状）：
 *   - 命令首行 `Run `，最多 2 个视觉行；第 2 行末尾溢出换 `…`；更长时第 2 行下面一行 `… +N lines`；
 *   - 命令续行 / `… +N lines` 起始列 == `Run ` 的 `n` 列（第 3 列）：执行中是两格缩进，执行完是 `│ `；
 *   - `└ ` 在**整块结果里恰好出现一次**，就在第一行实质输出上（截断提示行不算）；
 *   - 第一行实质输出之后的内容行不带竖线、也不带拐角符，只有两格缩进；
 *   - 没有输出时显示 `(no output)`，`└ ` 挂在它前面；
 *   - 每一行的可见宽度 <= 终端宽度（pi-tui 对超宽行会截断，多一格就丢内容）。
 * 找不到本机 pi 的库入口就整体 skip（不假装通过）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bash-command-collapse.ts");
/** 树形竖线行（`│ `）：命令续行、截断提示、以及 `└ ` 之上的所有行。 */
const PIPE = "\u2502";
/** `…`（U+2026）：单独提出来只是为了让断言读起来清楚。 */
const ELLIPSIS_PLAIN = "\u2026";
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态。
 *
 * 先从 `pi` 可执行文件反查**真正的安装位置**（pnpm/npm 的 shim 脚本里留有
 * `# cmd-shim-target=<绝对路径>`；npm 在 Unix 上则是符号链接，两种都试），再退回
 * `~/.pi/agent/npm` 那份副本 —— 判定方式是**能不能真 import**，不是路径存不存在
 *（那份副本可能是被剪掉同伴包的空壳）。全都不行就返回 undefined，整体 skip。
 */
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

/**
 * pi 自带的 chalk 在**模块求值时**就定好「要不要输出样式」（非 TTY 下默认关掉），而
 * `theme.bold()` 就是它 —— 所以只有「加粗 / 颜色」那几个断言需要这个环境变量，且**必须
 * 在 import pi 之前**设。不设的话那些断言看到的全是不带 SGR 的裸文本，永远“通过”。
 * 只影响本测试进程，且尊重用户已有的 NO_COLOR。
 */
if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

interface BashToolDefinitionLike {
	renderShell?: string;
	renderCall?: (...args: any[]) => any;
	renderResult?: (...args: any[]) => any;
}

interface PiApi {
	discoverAndLoadExtensions: (
		configuredPaths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{
		extensions: Array<{ tools: Map<string, { definition: BashToolDefinitionLike }> }>;
		errors: Array<{ path: string; error: string }>;
	}>;
	createEventBus: () => unknown;
	initTheme: (name?: string, interactive?: boolean) => void;
	ToolExecutionComponent: new (
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: unknown,
		toolDefinition: BashToolDefinitionLike,
		ui: { requestRender(): void },
		cwd: string,
	) => {
		rendererState: { startedAt?: number; endedAt?: number };
		setArgsComplete?: () => void;
		markExecutionStarted: () => void;
		setExpanded: (expanded: boolean) => void;
		updateResult: (result: unknown, isPartial?: boolean) => void;
		render: (width: number) => string[];
	};
}

let pi: PiApi | undefined;
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

/** 剥掉所有 ANSI / OSC 转义，只留可见文本（断言直接看这个）。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** 可见列数（fixture 里只有 ASCII 与汉字；汉字 2 列，其余 1 列 —— 与 pi-tui 的算口一致）。 */
function widthOf(line: string): number {
	let width = 0;
	for (const ch of plain(line)) {
		const code = ch.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
}

/**
 * 用 pi 自己的加载器加载本扩展（模块求值时做一次，测试之间复用注册好的工具定义）。
 * 顶层 await 是必须的：`test()` 回调是同步的，而加载是异步的。
 */
let cached: { agentDir: string; projectDir: string; definition: BashToolDefinitionLike } | undefined;
let cleanup: (() => void) | undefined;

if (pi) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-shape-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	cleanup = () => fs.rmSync(root, { recursive: true, force: true });

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const definition = loaded.extensions[0]?.tools.get("bash")?.definition;
	assert.ok(definition, "本扩展必须注册 bash 工具（跨扩展同名注册是 first wins，见文件头）");
	pi.initTheme("dark");
	cached = { agentDir, projectDir, definition };
}

test.after(() => cleanup?.());

interface RenderOptions {
	output?: string;
	expanded?: boolean;
	partial?: boolean;
	timeout?: number;
	details?: unknown;
	/** 伪装成“跑了 N 毫秒”（页脚门槛判据用的是 `endedAt - startedAt`）。 */
	elapsedMs?: number;
	width?: number;
	/** 不调 `updateResult` —— 真实的“命令已发出、结果还没到”那一刻（`renderCall` 独舞）。 */
	noResult?: boolean;
	/** 命令失败（pi 把 `isError` 放在 tool result 上 —— 内置 bash 失败时 throw）。 */
	isError?: boolean;
}

/**
 * 一条失败命令的 tool result 正文，照抄 pi 的内置 bash 形态 —— `core/tools/bash.ts` 里
 * `formatOutput` 先把空输出换成 `(no output)`，再由 `appendStatus(text, status)` 拼上状态：
 * `` `${text}\n\n${status}` ``。所以**无输出时也是这个 `(no output)` 占位行**，
 * 不是空串 —— 扩展自己补的那个 `(no output)` 只用在结果正文真的为空的情况（不失败、也没输出）。
 */
const failed = (output: string, status = "Command exited with code 2"): string => `${output || "(no output)"}\n\n${status}`;

/**
 * 渲染一个真实的 bash 块：`markExecutionStarted` → `updateResult`，与 pi 的调用顺序一致
 *（`setArgsComplete` 在实时流里先于执行开始，`/resume` 重建时从不调用它 —— 这里都覆盖）。
 */
function renderBlock(command: string, options: RenderOptions = {}): string[] {
	assert.ok(pi && cached);
	const component = new pi.ToolExecutionComponent(
		"bash",
		"call-1",
		{ command, ...(options.timeout === undefined ? {} : { timeout: options.timeout }) },
		{},
		cached.definition,
		{ requestRender() {} },
		cached.projectDir,
	);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	if (options.elapsedMs !== undefined) {
		component.rendererState.endedAt = (component.rendererState.startedAt ?? Date.now()) + options.elapsedMs;
	}
	component.setExpanded(options.expanded === true);
	if (!options.noResult) {
		component.updateResult(
			{
				content: [{ type: "text", text: options.output ?? "" }],
				details: options.details ?? {},
				// pi 把 isError 放在 result 上（`updateResult(message)` 收到的是那条 toolResult 消息），
				// 而渲染器的 `context.isError` 从它算出来 —— 失败状态的染色靠的就是这个。
				...(options.isError === undefined ? {} : { isError: options.isError }),
			},
			options.partial === true,
		);
	}
	const lines = component.render(options.width ?? 79);
	// pi 内置的 bash renderResult 在 `isPartial` 时挂了个每秒 invalidate 的定时器
	//（`setInterval(() => context.invalidate(), 1e3)`）。它是 pi 的组件、测试里没有
	// UI 会去清它，不清的话 node --test **永远退不出去**（实测挂死）。
	clearInterval((component.rendererState as { interval?: NodeJS.Timeout }).interval);
	return lines;
}

const text = (command: string, options: RenderOptions = {}): string[] => renderBlock(command, options).map(plain);

/** 那个“跑了 3 秒”伪装：越过 2s 门槛，于是 `Took` 页脚会画出来（测树里怎么摆）。 */
const SLOW = { elapsedMs: 3000 } as const;

const LONG_COMMAND =
	"cd /Users/bachi/Library/pnpm/store/v11/links/@earendil-works/pi-coding-agent/0.86.0/5813aee6dbf81477902199f3db54e13ab115c8902b3ab00a8b290b3e44dcb3c8/node_modules/@earendil-works/pi-coding-agent";

/**
 * 规范化一行用于断言：去掉 Box 的 1 列左内边距与行尾补白（Box.applyBg 会把每行补满到
 * 终端宽度再上底色，补白不是内容）。行首空白**要保留** —— 续行的对齐就靠它。
 */
const body = (line: string): string => line.replace(/ +$/, "").replace(/^ /, "");

test("命令行：`Run ` 开头，最多两行，第二行溢出换 `…`", { skip }, () => {
	const lines = text(LONG_COMMAND, { output: "a\nb\n" }).map(body);
	// 结构固定：Run 行 + 1 个续行 + `… +N lines` 标记，然后才是结果
	assert.equal(lines[2]!.startsWith("Run cd "), true, `第 1 行应当是 Run 开头的命令：${lines[2]}`);
	assert.equal(lines[3]!.startsWith("│ ent/"), true, `第 2 行应当是续行：${lines[3]}`);
	assert.equal(lines[3]!.endsWith(ELLIPSIS_PLAIN), true, `溢出的行尾必须换成 …：${lines[3]}`);
	assert.equal(lines[4], "│ … +1 lines", `第 3 行应当是折叠标记：${lines[4]}`);
	// 命令正文精确两行（Run 行 + 1 续行），第三条命令行是折叠标记而不是正文
	assert.equal(lines[3]!.includes("0.86.0"), true, "续行必须接着放命令正文");
	assert.equal(lines[5]!.startsWith("└ "), true, `第 4 行开始应当是结果：${lines[5]}`);
	// 不再有旧的 token 提示
	assert.equal(lines.some((line) => line.includes("tokens hidden")), false);
});

test("命令行：没溢出的短命令不画 `…`，也不画折叠标记", { skip }, () => {
	const lines = text("echo hello", { output: "hello\n" });
	assert.equal(body(lines[2]!), "Run echo hello");
	assert.equal(lines.some((line) => line.includes(ELLIPSIS_PLAIN)), false, "短命令不该有 …");
	assert.equal(lines.some((line) => line.includes("lines")), false, "短命令不该有 … +N lines");
});

test("命令行：续行与折叠标记的正文列 == `Run ` 的 n 列", { skip }, () => {
	// 续行 / 折叠标记的前缀是 `│ `（2 列），所以它们的**正文**落在第 3 列（0 基的 2）——
	// 正是 `Run ` 里 `n` 那一列。用户样例里的两行就是这么对齐的。
	const lines = text(LONG_COMMAND, { output: "a\n" }).map(body);
	const run = lines.find((line) => line.startsWith("Run "))!;
	const continuation = lines[lines.indexOf(run) + 1]!;
	const marker = lines.find((line) => line.includes("+1 lines"))!;
	const nColumn = "Run ".indexOf("n");
	assert.equal(nColumn, 2, "`Run ` 的 n 在第 3 列（0 基 2）—— 断言口径的前提");
	assert.equal(continuation.slice(0, 2), `${PIPE} `, `续行应当带 2 列前缀：${continuation}`);
	assert.equal(continuation.slice(2).length > 0, true);
	assert.equal(marker.slice(0, 2), `${PIPE} `, `折叠标记应当带 2 列前缀：${marker}`);
	assert.equal(marker.indexOf(ELLIPSIS_PLAIN), nColumn, `折叠标记的 … 列不对：${marker}`);
});

test("命令行：命令还在跑（没有任何结果）用空格缩进，结果一到就是 `│ `", { skip }, () => {
	// 纯执行中（`renderCall` 独舞、`updateResult` 还没被调过）：整块都是纯缩进，一根竖线都没有
	const running = text(LONG_COMMAND, { noResult: true }).map(body);
	assert.equal(running[3]!.startsWith("  ent/"), true, `执行中续行应当是空格缩进：${running[3]}`);
	assert.equal(running.find((line) => line.includes("+1 lines"))!.startsWith("  …"), true, "执行中的折叠标记也只用缩进");
	assert.equal(running.some((line) => line.startsWith(`${PIPE} `) || line.startsWith("└ ")), false, "执行中不该出现树形符号");
	// 结果一到（哪怕还是 partial 快照），命令续行与折叠标记就换成 `│ `，树接上
	const withOutput = text(LONG_COMMAND, { output: "a\n", partial: true }).map(body);
	assert.equal(withOutput[3]!.startsWith(`${PIPE} ent/`), true, `出结果后续行应当是 │ ：${withOutput[3]}`);
	assert.equal(withOutput.find((line) => line.includes("+1 lines"))!.startsWith(`${PIPE} …`), true, "折叠标记也挂 │");
});

test("结果：`└ ` 在整块里恰好出现一次，就在第一行实质输出上", { skip }, () => {
	const lines = text(LONG_COMMAND, { output: "one\ntwo\nthree\n", ...SLOW }).map(body);
	const corners = lines.filter((line) => line.startsWith("└ "));
	assert.equal(corners.length, 1, `└ 只能出现一次：${JSON.stringify(lines)}`);
	assert.equal(corners[0], "└ one", "└ 必须挂在第一行实质输出上");
	// 后续内容行：两格缩进，不带竖线 / 拐角符
	assert.equal(lines[lines.indexOf(corners[0]!) + 1], "  two");
	assert.equal(lines[lines.indexOf(corners[0]!) + 2], "  three");
});

test("结果：截断提示行挂 `│ `，`└ ` 留给它下面的第一行输出", { skip }, () => {
	const lines = text(LONG_COMMAND, { output: "1\n2\n3\n4\n5\n6\n7\n", ...SLOW }).map(body);
	const hint = lines.find((line) => line.includes("earlier lines"))!;
	assert.equal(hint.startsWith("│ …"), true, `截断提示应当挂 │ ：${hint}`);
	const corner = lines.find((line) => line.startsWith("└ "))!;
	assert.equal(corner, "└ 5", `└ 应当挂在提示行下面的第一行输出上：${corner}`);
	assert.equal(lines[lines.indexOf(corner) + 1], "  6");
	assert.equal(lines[lines.indexOf(corner) + 2], "  7");
	// 页脚也在树里、同样只缩进（不再长竖线）
	const footer = lines.find((line) => line.startsWith("  Took "))!;
	assert.ok(footer, "Took 页脚应当缩进对齐");
	// `│ ` 只出现在 `└ ` 上面的那一段（命令续行 + 折叠标记 + 截断提示），`└ ` 之后一根都没有
	assert.equal(lines.findIndex((line) => line.startsWith("└ ")) < lines.findIndex((line) => line.startsWith("  Took ")), true);
	assert.equal(lines.slice(lines.findIndex((line) => line.startsWith("└ "))).some((line) => line.startsWith("│ ")), false, `└ 之后不该再画竖线：${JSON.stringify(lines)}`);
});

test("结果：没有输出时画 `(no output)`，`└ ` 挂在它前面", { skip }, () => {
	const lines = text("true", SLOW).map(body);
	assert.equal(lines.find((line) => line.startsWith("└ ")), "└ (no output)");
	// 执行中（还没结果）不保留行：那时“还没输出”不等于“没有输出”
	const running = text("sleep 5", { partial: true }).map(body);
	assert.equal(running.some((line) => line.includes("(no output)")), false, "执行中不该画 (no output)");
	assert.equal(running.some((line) => line.startsWith("└ ")), false, "执行中不该有 └");
});

test("结果：`(no output)` 排在 warnings 前面", { skip }, () => {
	const lines = text("cat huge", {
		output: "",
		details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 999 }, fullOutputPath: "/tmp/x.log" },
		...SLOW,
	}).map(body);
	const noOutput = lines.findIndex((line) => line.includes("(no output)"));
	const warning = lines.findIndex((line) => line.includes("Full output:"));
	assert.ok(noOutput !== -1 && warning !== -1, `两行都该在：${JSON.stringify(lines)}`);
	assert.ok(noOutput < warning, "(no output) 应当排在 warnings 前面");
	assert.equal(lines[noOutput]!.startsWith("└ "), true);
	assert.equal(lines[warning]!.startsWith("  "), true, "warnings 只缩进、不再挂拐角符");
});

test("结果：每一行的可见宽度都不超过终端宽度", { skip }, () => {
	const cases: Array<{ command: string; options: RenderOptions }> = [
		{ command: LONG_COMMAND, options: { output: "one\ntwo\nthree\n", ...SLOW } },
		{ command: "echo hi", options: { output: "hi\n", ...SLOW } },
		{ command: "true", options: SLOW },
		{ command: "echo " + "x".repeat(200), options: { output: "1\n2\n3\n" } },
		{ command: "echo 你好世界".repeat(20), options: { output: "第一行\n第二行\n" } },
		{ command: "cat huge", options: { output: "", details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 999 }, fullOutputPath: "/tmp/" + "y".repeat(120) }, ...SLOW } },
	];
	for (const width of [120, 79, 60, 40, 30, 25]) {
		for (const { command, options } of cases) {
			const lines = renderBlock(command, { ...options, width });
			for (const line of lines) {
				assert.ok(widthOf(line) <= width, `宽度 ${width} 下超宽：${JSON.stringify(plain(line))}（Run ${command.slice(0, 30)}…）`);
			}
		}
	}
});

test("展开态：结果不裁行、不挂 gutter（命令自己的续行前缀还在）", { skip }, () => {
	const lines = text(LONG_COMMAND, { output: "1\n2\n3\n4\n5\n6\n7\n8\n", expanded: true, ...SLOW }).map(body);
	// 结果段是原样输出：没有 `└ `、没有截断提示、每个输出行都顶格
	assert.equal(lines.some((line) => line.startsWith("└ ")), false, `展开态不该有 └ ：${JSON.stringify(lines)}`);
	assert.equal(lines.some((line) => line.includes("earlier lines")), false, "展开态不该有截断提示");
	for (const line of ["1", "2", "8"]) assert.equal(lines.includes(line), true, `展开态应当原样输出 ${line}：${JSON.stringify(lines)}`);
	// 命令段：不截断、没有 `… +N lines` 标记（但还是命令自己的续行前缀）
	assert.equal(lines.some((line) => line.endsWith(ELLIPSIS_PLAIN)), false, "展开态命令不截断");
	assert.equal(lines.some((line) => line.includes("+") && line.includes("lines")), false, "展开态不该有 … +N lines 标记");
	// 页脚顶格（不在树里）
	assert.equal(lines.find((line) => line.includes("Took "))!.startsWith("Took "), true);
});

test("着色：命令续行的 `│` 是 muted，不跟着后面 token 的颜色飘", { skip }, () => {
	// 命令第 2 行的正文是路径（`syntaxString`），第 1 行末尾也是路径 —— 两行的 `│` 与
	// `Run ` 必须各是各的色：结构符一头一尾都不能继承正文的颜色（实测踩过：`│` 跟着 path 色）。
	const lines = renderBlock(LONG_COMMAND, { output: "ok\n" });
	const run = lines.find((line) => plain(line).includes("Run cd "))!;
	const continuation = lines.find((line) => plain(line).includes("ent/0.86.0"))!;
	assert.ok(run && continuation, "两行命令行都该在");

	// `Run ` 用 toolTitle（正常色；`Run` 词上还套一层粗体），`│ ` 用 muted（结构灰），
	// 各自紧跟着一个前景复位
	const runPrefix = /^(\u001b\[48[^m]*m \u001b\[38;2;212;212;212m\u001b\[1mRun\u001b\[22m \u001b\[39m)/.exec(run);
	assert.ok(runPrefix, `Run 前缀应当是 toolTitle 正常色 + 粗体：${JSON.stringify(run)}`);
	const chainPrefix = /\u001b\[38;2;128;128;128m│ \u001b\[39m/.exec(continuation);
	assert.ok(chainPrefix, `续行的 │ 应当是 muted 灰、且颜色在正文前闭合：${JSON.stringify(continuation)}`);
	// 正文的 path 色（syntaxString）出现在 `│ ` 之后，而不是包住它
	const chainIndex = continuation.indexOf(chainPrefix![0]);
	const pathIndex = continuation.indexOf("\u001b[38;2;206;145;120m");
	assert.ok(pathIndex > chainIndex, "path 色必须排在 │ 前缀之后");
});

test("着色：只有 `Run` 那个词加粗，命令正文不加粗", { skip }, () => {
	const lines = renderBlock("echo hi", { output: "ok\n", ...SLOW });
	const run = lines.find((line) => plain(line).trimStart().startsWith("Run "))!;
	assert.ok(run, "命令行该在");
	// `Run` 外面套着粗体开/关，**行尾那个空格在粗体之外**（包住前缀会让间距看着变宽）
	assert.match(run, /\u001b\[1mRun\u001b\[22m /, `Run 该加粗且空格不加粗：${JSON.stringify(run)}`);
	// 正文（echo / hi）不带任何粗体标记
	const body = run.slice(run.indexOf("\u001b[22m") + "\u001b[22m".length);
	assert.equal(body.includes("\u001b[1m"), false, `命令正文不该加粗：${JSON.stringify(body)}`);
	assert.equal(body.includes("\u001b[22m"), false, `命令正文不该有粗体复位：${JSON.stringify(body)}`);
	// 续行（`│ `）与结果（`└ `）都不加粗
	const styledCorner = lines.find((line) => plain(line).trimStart().startsWith("└ "))!;
	assert.ok(styledCorner, "结果行该在");
	assert.equal(styledCorner.includes("\u001b[1m"), false, "结果树的 └ 不该加粗");
	// 长命令的续行（`│ `）也不加粗
	const continuation = renderBlock(LONG_COMMAND, { output: "ok\n" }).find((line) => plain(line).trimStart().startsWith("\u2502 "));
	assert.ok(continuation, "长命令该有续行");
	assert.equal(continuation.includes("\u001b[1m"), false, "续行的 │ 不该加粗");
});

test("失败：`Command exited with code 2` 用 error 前景色", { skip }, () => {
	// pi 把它塞在结果正文末尾，前面跟输出一样是 `toolOutput`（默认 gray）—— 用户要的是红色。
	// 用默认皮肤（dark，见 initTheme）的色值断言：error = #cc6666 = `\u001b[38;2;204;102;102m`。
	const raw = renderBlock("for f in a b; do echo x; done", { output: failed("one\ntwo"), isError: true, elapsedMs: 100 });
	const status = raw.find((line) => plain(line).includes("Command exited with code 2"))!;
	assert.ok(status, `失败提示该在：${JSON.stringify(raw.map(plain))}`);
	assert.ok(status.includes("\u001b[38;2;204;102;102m"), `失败提示该是 error 红：${JSON.stringify(status)}`);
	// 有输出时那两行就是提示行本身，不能被树形 gutter 误伤
	// （它们落在 `└ ` 之后，所以只缩进两格、不带竖线）
	const after = raw.map(plain).map(body);
	assert.equal(after.find((line) => line.includes("Command exited"))!.startsWith("  Command exited"), true);

	const only = renderBlock("true; exit 3", { output: failed("", "Command exited with code 3"), isError: true, elapsedMs: 100 });
	const onlyStatus = only.find((line) => plain(line).includes("Command exited with code 3"))!;
	assert.ok(onlyStatus.includes("\u001b[38;2;204;102;102m"), `无输出时提示同样要红：${JSON.stringify(onlyStatus)}`);
	const onlyBody = only.map(plain).map(body);
	assert.equal(onlyBody.find((line) => line.startsWith("└ ")), "└ (no output)", "无输出时 └ 挂在占位行上");
	assert.equal(onlyBody.find((line) => line.includes("Command exited"))!.startsWith("  Command exited"), true, "提示紧随其后、缩进对齐");
});

test("失败：提示行上方不留没有前导符的空行（中间不能断层）", { skip }, () => {
	// pi 把状态拼在输出末尾，那句 `\n\n` 会画出一行没有前缀的空行 —— 用户看到的就是
	// “断层两层”（它挤在预览与 `└ Command exited…` 之间）。现在空行不再画（见文件头 ⑤）。
	const lines = text("true; exit 3", { output: failed("", "Command exited with code 3"), isError: true, elapsedMs: 100 }).map(body);
	const corner = lines.findIndex((line) => line.startsWith("└ "));
	const status = lines.findIndex((line) => line.includes("Command exited"));
	assert.equal(lines[corner], "└ (no output)", `树起点：${JSON.stringify(lines)}`);
	assert.equal(status, corner + 1, `提示紧跟在占位行下面：${JSON.stringify(lines)}`);
	// 提示的前导符是两格缩进（`└ ` 已在上一行用过，树在那里就落地了）
	assert.equal(lines[status]!.startsWith("  Command exited"), true, `提示该缩进对齐：${JSON.stringify(lines[status])}`);
	// 整棵结果树里没有任何一行是断开的空行
	const tree = lines.slice(corner, status + 1);
	for (const line of tree) assert.match(line, /^(?:└ |  )/, `树里不该有断开前导符的行：${JSON.stringify(lines)}`);

	// 有输出、提示紧跟输出时，中间那几行都是内容，不是空行
	const withOutput = text("echo x; exit 5", { output: failed("x", "Command exited with code 5"), isError: true, elapsedMs: 100 }).map(body);
	const region = withOutput.slice(withOutput.findIndex((line) => line.startsWith("Run ")), withOutput.findIndex((line) => line.includes("Command exited")) + 1);
	assert.deepEqual(region, ["Run echo x; exit 5", "└ x", "  Command exited with code 5"], `命令与提示之间不该有空行：${JSON.stringify(withOutput)}`);
});

test("失败：提示不会被输出预览裁掉", { skip }, () => {
	// pi 把状态拼在输出末尾，预览只留最后 3 行 —— 状态前面那一句 `\n\n` 会把它挤出可视区，
	// 用户看到的就是只剩一条 `│ … (N earlier lines)` 加两行空行的断层。
	// 修复是把那行状态当成预览**必须留住的一行**（先摘下来、预算留给内容、再放回去）。
	const lines = text("cat big", { output: failed(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")), isError: true, elapsedMs: 100 }).map(body);
	const hint = lines.find((line) => line.includes("earlier lines"))!;
	assert.equal(hint.startsWith("│ "), true, `截断提示挂 │ ：${JSON.stringify(lines)}`);
	const corner = lines.find((line) => line.startsWith("└ "))!;
	assert.equal(corner, "└ line 29", `└ 该挂在提示下面第一行内容上（状态占掉一行预算）：${JSON.stringify(lines)}`);
	const status = lines.find((line) => line.includes("Command exited"))!;
	assert.equal(status.startsWith("  Command exited"), true, `失败提示在树里缩进：${status}`);
	assert.equal(lines.indexOf(status), lines.indexOf(corner) + 2, `提示该紧跟在两行预览后面：${JSON.stringify(lines)}`);
});

test("失败：正常输出里出现同样字样不会被误染也不会被吞掉", { skip }, () => {
	// 认形态必须是“真的是错的那次”（`context.isError`）+ 文本形态两条。只看文本会把把这句话
	// echo 出来的正常输出也染红、并且在末尾时把它当成状态摘走。
	const raw = renderBlock("echo 'Command exited with code 2'", {
		output: "Command exited with code 2\n",
		isError: false,
		elapsedMs: 100,
	});
	assert.equal(raw.some((line) => line.includes("\u001b[38;2;204;102;102m")), false, `成功的结果不该有 error 红：${JSON.stringify(raw.map(plain))}`);
	assert.deepEqual(raw.map(plain).map(body).slice(2, -1), ["Run echo 'Command exited with code 2'", "└ Command exited with code 2"], "输出要原样保留");
});

test("失败：展开态（ctrl+o）里提示也要红", { skip }, () => {
	// 展开态不裁行、不挂树，但颜色不能丢（用户要的是“失败提示见红”，与折叠态无关）。
	const raw = renderBlock("cmd", {
		output: `1\n2\n3\n\nCommand exited with code 2`,
		isError: true,
		expanded: true,
		elapsedMs: 100,
	});
	const status = raw.find((line) => plain(line).includes("Command exited with code 2"))!;
	assert.ok(status.includes("\u001b[38;2;204;102;102m"), `展开态的提示该是 error 红：${JSON.stringify(status)}`);
	// 展开态不挂树：输出行顶格、`└ ` 不出现
	const lines = raw.map(plain).map(body);
	assert.equal(lines.some((line) => line.startsWith("└ ")), false, `展开态不该有 └ ：${JSON.stringify(lines)}`);
	assert.equal(lines.includes("1"), true, `展开态该原样输出：${JSON.stringify(lines)}`);
});

test("失败：空行不断栅栏 —— 树里的空行也带 `│ `", { skip }, () => {
	// 用户 2026-09-21 第二次报的形状（真实会话 13:01:21 的那条）：pi 的预览窗口
	// `truncateToVisualLines(styledOutput, 5, width)` 从尾部倒着切，窗口开头可能正好是一个空行
	//（输出自己的空行）。它夹在截断提示行与 `└ ` 之间，光秃秃地空着就成了“断层”。
	// 用户的定案：**这种空行要把 `│` 补在行前**，而不是删掉它。
	const lines = text("node x.mjs", {
		output: `1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n\nNode.js v26.4.0\n\n\nCommand exited with code 1`,
		isError: true,
		elapsedMs: 100,
	}).map(body);
	const hint = lines.findIndex((line) => line.includes("earlier lines"));
	const corner = lines.findIndex((line) => line.startsWith("└ "));
	assert.ok(hint !== -1, `截断提示该在：${JSON.stringify(lines)}`);
	assert.equal(lines[corner], "└ Node.js v26.4.0", `└ 该在提示行下面：${JSON.stringify(lines)}`);
	// 提示行与 `└ ` 之间的每一行都是 `│`（这里就是那一行空行），没有裸空行
	for (let i = hint; i < corner; i++) assert.equal(lines[i]!.startsWith("│"), true, `第 ${i} 行断了栅栏：${JSON.stringify(lines)}`);
	// 整棵树从 `Run ` 到状态行之间的每一行都带前导（空行 = `│`）
	const status = lines.findIndex((line) => line.includes("Command exited"));
	for (let i = lines.findIndex((line) => line.startsWith("Run ")); i <= status; i++) {
		assert.match(lines[i]!, /^(?:Run |\u2502|└ |  )/, `树里断了栅栏：${JSON.stringify(lines)}`);
	}
	// 树之外的空行（命令上方、下边界）仍然是空行
	assert.equal(lines[0], "", `命令上方应当留空：${JSON.stringify(lines)}`);
	assert.equal(lines[lines.length - 1], "", `块尾应当留空：${JSON.stringify(lines)}`);
});

test("warnings：`[Full output: …]` 上方那行空行不带前导符（树在 `└ ` 就落地了）", { skip }, () => {
	// 用户 2026-09-21 定案：`└ ` 已经指到首行实质输出上，下面那截是缩进对齐的续行；
	// 所以 warnings（`[Full output: …]`）与 `Took` 各自前面那行前导空行都是**空行**，
	// 不能再挂 `│ ` —— 挂了反而像输出还没完。只在 `└ ` **之上**的空行才补（那里断了才是断层）。
	const lines = text("grep -rn x dist/", {
		output: "a\nb\nc\n\n[Showing lines 3-16 of 16 (50.0KB limit). Full output: /tmp/x.log]",
		isError: false,
		elapsedMs: 100,
	}).map(body);
	const corner = lines.findIndex((line) => line.startsWith("└ "));
	const warning = lines.findIndex((line) => line.includes("[Showing lines"));
	assert.ok(corner !== -1 && warning !== -1, `两段都该在：${JSON.stringify(lines)}`);
	// 输出行被预览裁过头一行（`a` 没了、只剩 `c`），这不影响本用例要断言的是前导符
	assert.match(lines[corner]!, /^└ \S/, `└ 挂实质输出上：${JSON.stringify(lines)}`);
	assert.equal(lines[warning - 1], "", `[Full output 前那行应当是空行：${JSON.stringify(lines)}`);
	assert.equal(lines.slice(corner, warning).some((line) => line.startsWith("│")), false, `└ 之下不该再画竖线：${JSON.stringify(lines)}`);
	// `└ ` 之上仍不充许裸空行（长输出 + 截断提示的场景）
	const long = text("grep -rn x dist/", {
		output: Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n\n[Showing lines 11-16 of 16 (50.0KB limit). Full output: /tmp/x.log]",
		isError: false,
		elapsedMs: 100,
	}).map(body);
	const c2 = long.findIndex((line) => line.startsWith("└ "));
	const run2 = long.findIndex((line) => line.startsWith("Run "));
	for (let i = run2; i < c2; i++) assert.notEqual(long[i], "", `└ 之上断了栅栏：${JSON.stringify(long)}`);
});

test("耗时页脚：短命令不画 `Took`，长命令画", { skip }, () => {
	const fast = text("echo hi", { output: "hi\n", elapsedMs: 100 }).map(body);
	assert.equal(fast.some((line) => line.includes("Took ")), false, "短命令不该有 Took 页脚");
	const slow = text("echo hi", { output: "hi\n", ...SLOW }).map(body);
	assert.equal(slow.find((line) => line.includes("Took "))!.startsWith("  Took "), true, "长命令的 Took 在树里缩进");
});

