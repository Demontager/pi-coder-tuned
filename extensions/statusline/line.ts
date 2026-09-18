/**
 * line.ts — statusline 主行 / 状态行的纯格式化
 *
 * 这个模块**不 import pi / pi-tui**（只用结构化最小接口描述需要的字段），所以
 * `node --test` 能直接拿假对象跑满每个分支；pi 的真实 `Theme` / `ExtensionContext` /
 * `ReadonlyFooterDataProvider` 结构兼容，index.ts 里原样传进来即可。
 */

/** pi 的 Theme.fg 子集（方法声明双变，真实 Theme 可直接赋值）。 */
export interface StatuslineTheme {
	fg(color: string, text: string): string;
}

/** ctx 里渲染主行需要的部分（`thinkingLevel` 在 pi 的 ctx 上是 live getter，可选且可能抛）。 */
export interface StatuslineSource {
	model: { id?: string } | undefined;
	thinkingLevel?: string;
	getContextUsage(): { percent: number | null | undefined } | undefined;
}

/** footerData 里需要的部分。 */
export interface StatuslineGitSource {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

export interface DiffStat {
	added: number;
	deleted: number;
}

export interface StatuslineState {
	streaming: boolean;
	/** 渲染路径只读，只有 index.ts 的事件回调会改。 */
	activeTools: Map<string, number>;
	/** undefined = 还没读到 / 不在 git 仓库。 */
	diffStat: DiffStat | undefined;
}

export const SEPARATOR = " | ";
export const ELLIPSIS = "…";
/**
 * 模型段前缀图标（取代早期的 `Model:` 文字标签，省 4 列）。
 * 刻意**不上色**：emoji 是自带颜色的字形，`theme.fg` 包一层只多出一对没有视觉效果的
 * ANSI 码。宽度按 pi-tui `visibleWidth` 是 2 列（RGI emoji），与终端实际渲染一致，
 * 所以 `truncateToWidth` 的截断数学不受影响。
 * 带 VS16（U+FE0F）强制 emoji 呈现：裸 `\u26a1` 在 pi-tui 里同样量 2 列，但 VS16
 * 能保证个别终端/字体不把它渲染成单色窄字形（那会和宽度口径错位 1 列）。
 */
export const MODEL_ICON = "⚡️";
/**
 * 分支段前缀图标：U+E0A0（Powerline / Nerd Font 的 git branch 字形），取代早期的 `⎇`(U+2387)。
 * 这码位在私有区，源码里只写转义不写裸字形 —— 裸字形在字体缺字形时是看不见的方块，贴错成
 * 近形码位（U+E0A2 / U+E0B0）review 时也看不出来，所以测试用转义把码位钉死。
 * 宽度按 pi-tui `visibleWidth` 是 1 列，与旧图标相同，`truncateToWidth` 的截断预算不用动。
 * 前提是终端用 Nerd Font —— 本机 Ghostty 配的 JetBrainsMonoNL Nerd Font Mono 即是。
 */
export const BRANCH_ICON = "\ue0a0";
/** 行首缩进：整行不顶格。 */
export const LEADING_INDENT = " ";
/** 本扩展自己的 setStatus key（清残留用，渲染时也跳过）。 */
export const STATUSLINE_KEY = "statusline";
const MAX_STATUS_ITEMS = 5;

/** 主行：`⚡️ x/xhigh | Ctx 0.0% | \ue0a0 branch | (+a,-b)[ | 状态]`，各段已着色。 */
export function formatMainLine(
	theme: StatuslineTheme,
	source: StatuslineSource,
	git: StatuslineGitSource,
	state: StatuslineState,
): string {
	const branch = git.getGitBranch();
	const segments = [
		formatModelSegment(theme, source),
		formatContextSegment(theme, source),
		formatBranchSegment(theme, branch),
		formatDiffSegment(theme, branch, state.diffStat),
		formatStateSegment(theme, state),
	].filter((segment): segment is string => Boolean(segment));
	return segments.join(dim(theme, SEPARATOR));
}

/**
 * footer 的完整输出：一个主行（+ 可选状态行），行首恒缩进一格，超长只截断省略、绝不折行。
 * `truncate` 由 index.ts 注入 pi-tui 的 `truncateToWidth`（ANSI / 宽字符安全），
 * 这样这条关键约定也能在单测里直接断言。
 */
export function composeFooterLines(
	theme: StatuslineTheme,
	source: StatuslineSource,
	git: StatuslineGitSource,
	state: StatuslineState,
	width: number,
	truncate: (text: string, width: number, ellipsis: string) => string,
): string[] {
	if (width <= 0) return [];
	const lines = [`${LEADING_INDENT}${formatMainLine(theme, source, git, state)}`];
	const statuses = formatExtensionStatuses(theme, git);
	if (statuses) lines.push(`${LEADING_INDENT}${statuses}`);
	return lines.map((line) => truncate(line, width, ELLIPSIS));
}

/**
 * 第二行：其它扩展 `ctx.ui.setStatus()` 的文本（cwd-statusline / rewind / simple-task）。
 * 自带 ANSI 的原样渲染（那些扩展已经自己配过色），没色的统一给 muted。
 */
export function formatExtensionStatuses(theme: StatuslineTheme, git: StatuslineGitSource): string {
	const visible = [...git.getExtensionStatuses().entries()]
		.filter(([key, value]) => key !== STATUSLINE_KEY && value.trim().length > 0)
		.slice(0, MAX_STATUS_ITEMS)
		.map(([, value]) => (hasAnsi(value) ? value : theme.fg("muted", value.trim())));
	return visible.join(dim(theme, SEPARATOR));
}

/** 模型图标 + id + 推理强度：`⚡️ qwen3.8-flash/xhigh`（id 用 accent，斜杠 dim，level 用 syntaxFunction）；level 读不到（stale ctx）时只报 id。 */
function formatModelSegment(theme: StatuslineTheme, source: StatuslineSource): string {
	const id = readModel(source)?.id ?? "no-model";
	const level = readThinkingLevel(source);
	const suffix = level ? `${dim(theme, "/")}${theme.fg("syntaxFunction", level)}` : "";
	return `${MODEL_ICON} ${theme.fg("accent", id)}${suffix}`;
}

function formatContextSegment(theme: StatuslineTheme, source: StatuslineSource): string {
	const percent = readContextUsage(source)?.percent ?? null;
	const percentText = percent === null ? "?" : `${percent.toFixed(1)}%`;
	return `${dim(theme, "Ctx")} ${theme.fg(contextColor(percent), percentText)}`;
}

function formatBranchSegment(theme: StatuslineTheme, branch: string | null): string {
	if (!branch) return dim(theme, `${BRANCH_ICON} no git`);
	return `${dim(theme, BRANCH_ICON)} ${theme.fg("accent", branch)}`;
}

function formatDiffSegment(
	theme: StatuslineTheme,
	branch: string | null,
	diffStat: DiffStat | undefined,
): string {
	if (!branch) return dim(theme, "(no git)");
	return `${dim(theme, "(")}${theme.fg("success", `+${diffStat?.added ?? 0}`)}${dim(theme, ",")}${theme.fg("error", `-${diffStat?.deleted ?? 0}`)}${dim(theme, ")")}`;
}

/** 末段状态：有工具在跑 → 工具名（并发带计数），否则流式中 → thinking，空闲 → 整段不出现；整段用 warning 着色。 */
function formatStateSegment(theme: StatuslineTheme, state: StatuslineState): string | undefined {
	const active = [...state.activeTools.entries()];
	if (active.length > 0) {
		const [name, count] = active[0] ?? ["tool", 1];
		const suffix = count > 1 ? `×${count}` : active.length > 1 ? `+${active.length - 1}` : "";
		return theme.fg("warning", `${name}${suffix}`);
	}
	return state.streaming ? theme.fg("warning", "thinking") : undefined;
}

function contextColor(percent: number | null): string {
	if (percent === null) return "dim";
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

/** ctx 的 getter 在会话被换掉后可能抛（stale ctx），状态栏不值得为此挂掉渲染。 */
function readContextUsage(
	source: StatuslineSource,
): { percent: number | null | undefined } | undefined {
	try {
		return source.getContextUsage();
	} catch {
		return undefined;
	}
}

/** thinkingLevel 在 stale ctx 上同样可能抛，一律兜底成「无 level」。 */
function readThinkingLevel(source: StatuslineSource): string | undefined {
	try {
		const level = source.thinkingLevel;
		return typeof level === "string" && level.length > 0 ? level : undefined;
	} catch {
		return undefined;
	}
}

/** ctx.model 在 stale ctx 上也可能抛，一律走这里取。 */
function readModel(
	source: StatuslineSource,
): { id?: string; contextWindow?: number } | undefined {
	try {
		return source.model;
	} catch {
		return undefined;
	}
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/;

function hasAnsi(value: string): boolean {
	return ANSI_PATTERN.test(value);
}

function dim(theme: StatuslineTheme, text: string): string {
	return theme.fg("dim", text);
}
