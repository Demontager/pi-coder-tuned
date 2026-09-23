/**
 * plan-mode 的计划文本处理：步骤文案清洗、`[DONE:n]` 进度标记、注入给模型的上下文。
 *
 * 不 import pi / pi-tui，所以能直接单测。
 *
 * ## 为什么不做「从回复的散文里抽计划」
 *
 * 官方 plan-mode 示例会从回复里认 `Plan:` 段落抽编号清单，本扩展不这么做：计划的唯一
 * 入口是 `exit_plan_mode` 工具的结构化参数。理由是从散文里抽步骤**猜的成分太大** ——
 * 模型的编号清单可能是计划，也可能只是在解释现状；猜错就会把正文里的一句描述写进
 * 状态行、甚至当成要执行的步骤。工具调用是明确的信号，多一次调用换掉一整类误判值得。
 * 代价：模型如果只是写了一段清单而没调工具，用户看不到进度条 —— 提示词里已经把
 * 「方案想清楚就调 exit_plan_mode」写死了，走错路的模型会在下一轮被纠正。
 *
 * ## `[DONE:n]` 标记
 *
 * 执行阶段模型每完成一步在回复里带 `[DONE:n]`。这是给状态行用的信号，不是给用户看的
 * 内容，所以提取之后会从助手消息里清掉。围栏里的同名文本（讨论这个标记本身）不算数、
 * 也不清掉 —— 那是用户代码块里的内容。
 */

import type { PlanStep } from "./plan.ts";

/** 步骤文案上限：状态行与 widget 都不适合放长句，长了就截断。 */
const MAX_STEP_TEXT = 100;

/** 去掉行内 markdown 包装、压掉多余空白、超长截断。 */
export function cleanStepText(text: string): string {
	const cleaned = text
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/^[-–—•]\s*/, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.;,，。；]$/, "");
	return cleaned.length > MAX_STEP_TEXT ? `${cleaned.slice(0, MAX_STEP_TEXT - 1)}…` : cleaned;
}

// =============================================================================
// 进度标记
// =============================================================================

/** `[DONE:1]` / `[done:1,2]` / `[DONE 1]` / `[done：1，2]` 都认。 */
const DONE_MARKER = /\[done\s*[:：]?\s*([\d\s,，]+)\]/gi;

/**
 * 抽出一段文本里声明完成的步骤号（可能为 0 个）。
 * 代码围栏里的 `[DONE:n]` 不算 —— 讨论这个标记本身时不该推进进度。
 */
export function extractDoneSteps(text: string): number[] {
	const steps: number[] = [];
	for (const match of outsideFences(text).matchAll(DONE_MARKER)) {
		for (const piece of (match[1] ?? "").split(/[,，\s]+/)) {
			if (piece === "") continue;
			steps.push(Number(piece));
		}
	}
	return steps;
}

/** 从正文里清掉完成标记（围栏内容原样保留）。 */
export function stripDoneMarkers(text: string): string {
	return mapLines(
		text,
		(line) => line.replace(DONE_MARKER, ""),
		(line) => line,
	).replace(/[ \t]+\n/g, "\n");
}

/** 把代码围栏内部的行交给 `onFenced`，其余交给 `onPlain`；围栏行本身原样保留。 */
function mapLines(text: string, onPlain: (line: string) => string, onFenced: (line: string) => string): string {
	const lines = text.split("\n");
	const kept: string[] = [];
	let fence: string | null = null;

	for (const line of lines) {
		const match = /^\s*(```+|~~~+)/.exec(line);
		if (match) {
			const marker = match[1]!;
			if (fence === null) fence = marker[0]!;
			else if (marker[0] === fence) fence = null;
			kept.push(line);
			continue;
		}
		kept.push(fence === null ? onPlain(line) : onFenced(line));
	}
	return kept.join("\n");
}

/** 只看围栏外的文本（围栏内容换成空行，行数保持）。 */
function outsideFences(text: string): string {
	return mapLines(
		text,
		(line) => line,
		() => "",
	);
}

// =============================================================================
// 提示词
// =============================================================================

/**
 * plan 阶段每轮注入的上下文（`display: false`，用户看不到、模型看得到）。
 *
 * 写清楚三件事：现在是只读阶段、能做什么、最后必须调 `exit_plan_mode` 提交。不写
 * 「禁止改动」这类抽象要求，而是直接给出该走的路（读代码 → 用工具问用户 → 提交计划）。
 */
export function buildPlanModeContext(cwd: string): string {
	return `[PLAN MODE]

你现在处于 plan mode：只读探索阶段。改动类工具（edit / write）已从你的工具表里摘掉，
bash 里的写操作（重定向、rm / mv / sed -i / git commit / npm install 等）会被拦下并把
原因回给你。这不代表你卡住了 —— 它代表现在应该先把方案想清楚。

工作目录：${cwd}

在 plan mode 里：
- 尽管读：read / grep / find / ls / 只读 bash 都是通的，需要多少上下文就读多少
- 需要用户拍板的选择用 ask_user_question 问，不要自己替他决定
- 不要试图绕过限制（换个写法写文件、用 git 提交、装依赖都不行）

方案想清楚后，调用 exit_plan_mode 提交，参数 steps 是给用户看你打算怎么做的一串具体动作：
每一句都写清楚"改哪个文件、做什么"，不要写"分析代码"这种没有落点的步骤。提交后由用户
决定批准还是打回；用户批准前你不会拿到写权限，所以不要提前说"我已经改好了"。`;
}

/**
 * execute 阶段每轮注入的剩余步骤（`display: false`）。
 *
 * 这里必须把「哪份清单是真的」写死：批准计划时步骤已经镜像进会话任务清单
 * （simple-task 的 `#n`），那边与状态行是同一个进度源。模型若另建一份清单，
 * 屏幕上就会出现两套数字（issue 里的实际问题）。`[DONE:n]` 仍作为等价别名保留：
 * 它与 `task_update` 改的是同一份进度，习惯写标记的模型不会因此卡住。
 *
 * 「两步 task_update」的写法是刻意的：`pending → done` 一步到位会与全局 AGENTS.md 的
 * `Never move an item straight from pending to done` 对撞，而实测跳步率 50%（76 次
 * `→ done` 里有 38 次直接跳）—— 注入文本比全局规则更近，模型跟的是注入文本。写成
 * 两步就把这处矛盾消掉，同时保住 spinner 的视觉反馈（只有 in_progress 才转）。
 */
export function buildExecuteContext(steps: readonly PlanStep[]): string {
	const remaining = steps.filter((step) => !step.done);
	const list = remaining.map((step) => `${step.step}. ${step.text}`).join("\n");
	return `[EXECUTING PLAN]

用户已批准这个计划，写权限已恢复。步骤已同步到会话任务清单（id 就是下面的序号），
**那是这次执行唯一的进度表**——不要另建一份任务清单（不要 task_set）。

按顺序执行剩余步骤：

${list}

每完成一步，用 \`task_update\` 分两次把它标掉：先 \`task_update #${remaining[0]?.step ?? 1} → in_progress\`
（开始做之前），做完再 \`task_update #${remaining[0]?.step ?? 1} → done\`。
或者按老习惯在回复里带上 \`[DONE:n]\`（n 是上面每行开头的序号）——它等价于直接标 done。
全部完成后正常收尾即可。`;
}
