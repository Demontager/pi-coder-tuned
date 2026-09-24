/**
 * plan-doc.ts — 计划文档的**路径生成**（纯逻辑，不 import pi / pi-tui / node:fs）。
 *
 * 文档正文由模型自己写（探索到的背景、文件结构、验证方式只存在于它的上下文里，
 * 扩展代写只能得到一份和任务清单一样薄的东西）。本模块只负责回答一个问题：
 * **写到哪个文件**。
 *
 * ## 约定
 *
 *   <cwd>/.pi/plans/YYYY-MM-DD-<slug>.md
 *
 *   - `.pi/plans/`：pi 专用，与已被 git 跟踪的 `.claude/plans/`（Claude Code 的计划）
 *     语义分开；`docs/` 是「冻结产物、非生成目录」，动态计划文档不放那里。
 *   - 日期用**本地日历**（与 usage-report.js 的口径一致），同一天多份计划靠 slug 区分。
 *   - slug 取 `exit_plan_mode` 的 `slug` 参数（模型给的英文短名，如 `m5-entity-runtime`）；
 *     缺省或清洗后为空时退回 `plan`。
 *   - 撞名（同一天同一个 slug）追加 `-2` / `-3`，而不是覆盖 —— 覆盖会毁掉上一份计划。
 *
 * ## 为什么 `exists` 是注入的
 *
 * 撞名判定必须问文件系统，但本模块要保持纯逻辑好单测（与 plan.ts / plan-text.ts 同一条
 * 规矩）。调用方传 `existsSync` 即可；单测传一个假实现就能覆盖 `-2` / `-3` 分支。
 *
 * ## slug 为什么是「纯英文 kebab-case」
 *
 * 文件名要短、要能一眼看出是哪次规划。中文长句塞进文件名会变成一百多列的路径
 * （实测踩过：`2026-09-24-两个问题的真因都已实测定位：反复弹框是因为批准按-…md`），
 * 在终端里既截不断也读不了。有意义的英文短名只能由模型给（纯逻辑不做翻译/音译），
 * 所以 `exit_plan_mode` 要求一个 `slug` 参数，本模块只负责把它**清洗**成安全形状：
 * 小写、`[a-z0-9]` 之外的字符（含 CJK、标点、空格、路径分隔符、控制字符）一律折成 `-`。
 *
 * 这条规则同时就是安全边界：`/` `\` 被折掉，所以借 slug 写不到 `.pi/plans/` 之外；
 * 开头的 `.` 被剥掉，所以 `..` 跳不出去、`.foo.md` 也不会变成隐藏文件。清洗后为空
 * 一律退回 `plan`，绝不产出 `.pi/plans/2026-09-24-.md` 这种残缺名。
 */

import { join } from "node:path";

/** 计划文档目录（相对 cwd）。 */
export const PLAN_DOC_DIR = ".pi/plans";

/** slug 的最大长度（按码点算）。 */
export const MAX_SLUG_LENGTH = 60;

/** 撞名后缀的上限；超过就退回时间戳，保证一定能产出一个可用路径。 */
const MAX_COLLISION_SUFFIX = 99;

/** 清洗后什么都不剩时用的兜底 slug。 */
const FALLBACK_SLUG = "plan";

/**
 * slug 里保留的字符：小写字母与数字。其余（CJK、标点、空白、路径分隔符、控制字符）
 * 统一折成 `-`。
 */
const KEEP_CHARS = /[^a-z0-9]+/g;

export interface PlanDocPathOptions {
	/** 工作目录（`ctx.cwd`）。 */
	cwd: string;
	/** `exit_plan_mode` 的 `slug`（英文短名）；缺省或清洗后为空则用兜底 slug。 */
	slug?: string;
	/** 当前时间，默认 `new Date()`；单测注入固定值。 */
	now?: Date;
	/**
	 * 候选路径是否已被占用。调用方传 `existsSync`；不传则不做撞名处理
	 * （单测里想覆盖 `-2` 分支必须显式传）。
	 */
	exists?: (path: string) => boolean;
}

/** 计划文档的绝对路径。 */
export function buildPlanDocPath(options: PlanDocPathOptions): string {
	const now = options.now ?? new Date();
	const dir = join(options.cwd, ...PLAN_DOC_DIR.split("/"));
	const slug = planDocSlug(options.slug);
	const base = `${localDateString(now)}-${slug}`;

	if (!options.exists) return join(dir, `${base}.md`);

	const first = join(dir, `${base}.md`);
	if (!options.exists(first)) return first;
	for (let suffix = 2; suffix <= MAX_COLLISION_SUFFIX; suffix += 1) {
		const candidate = join(dir, `${base}-${suffix}.md`);
		if (!options.exists(candidate)) return candidate;
	}

	// 99 份同名计划：极端情况，用时分秒兜底，仍然不覆盖任何已有文件
	const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return join(dir, `${base}-${stamp}.md`);
}

/**
 * 从模型给的 `slug` 生成文件名 slug（纯英文 kebab-case）。
 *
 * 步骤：markdown 行内包装去掉 → 转小写 → 非 `[a-z0-9]` 的字符折成 `-` →
 * 折叠连续 `-` → 首尾的 `-` 与 `.` 剥掉 → 按码点截断 → 空则兜底。
 * CJK 会被整段折掉：`"修复 m5 entity runtime"` → `m5-entity-runtime`，
 * 纯中文则退回 `plan`。
 */
export function planDocSlug(slug: string | undefined): string {
	if (typeof slug !== "string") return FALLBACK_SLUG;

	const cleaned = slug
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.toLowerCase()
		.replace(KEEP_CHARS, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+/, "")
		.replace(/[-.]+$/, "");

	if (cleaned === "") return FALLBACK_SLUG;
	return truncateByCodePoints(cleaned, MAX_SLUG_LENGTH).replace(/[-.]+$/, "") || FALLBACK_SLUG;
}

/** 本地日历日期 `YYYY-MM-DD`（不是 UTC —— 跨时区的会话里日期会差一天）。 */
export function localDateString(now: Date): string {
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function pad(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

/** 按码点截断（`slice` 会把代理对劈成半个字符，emoji 会坏）。 */
function truncateByCodePoints(text: string, max: number): string {
	const points = [...text];
	return points.length <= max ? text : points.slice(0, max).join("");
}
