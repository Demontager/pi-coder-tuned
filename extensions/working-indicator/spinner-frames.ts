/**
 * spinner-frames.ts — working spinner 的「幻彩」帧表：同一族盲文帧按调色板轮换颜色。
 *
 * 抽出来的理由与 `working-summary.ts` / `bash-spinner.ts` 相同：帧表怎么排（周期长度、
 * 第 i 帧配哪个颜色）、调色板怎么去重、主题指纹是什么，全是纯计算，不该活在 `index.ts`
 * 的 ctx 与定时器之间。本模块**不 import pi / pi-tui**，`node --test` 直接跑每个分支
 * （用例见 `spinner-frames.test.ts`）；装着帧表的那半边（什么时候装、什么时候重装）在扩展里。
 *
 * ## 为什么只能预烘颜色
 *
 * pi 的 `Loader` 只有一条上色路径：默认十帧盲文交给 `spinnerColorFn`（非嵌入态就是
 * `theme.fg("accent", frame)`），所以整条 spinner 永远一个颜色 —— 这正是本扩展要改的。
 * 扩展的入口 `ctx.ui.setWorkingIndicator({ frames, intervalMs })` 里**自定义帧是 verbatim
 * 渲染的**（pi 0.85.1 的 Loader：`renderIndicatorVerbatim = indicator !== undefined`，
 * 为真时 `getRenderedIndicator()` 直接返回帧字符串、不套 `spinnerColorFn`），也就是颜色
 * 必须由帧字符串自己带。于是「一帧一个颜色」只能把 ANSI 序列预烘进帧表；代价是换主题后
 * 帧表不会自己更新，得重装一次（重装 = 再调一次 `setWorkingIndicator`，要不要重装由
 * `signature` 判断）。
 *
 * ## 帧表怎么排
 *
 * Loader 每 `intervalMs`（默认 80）把帧表索引 +1 再取模回绕，**帧表顺序就是动画顺序**。
 * 把「十帧盲文 × 若干颜色」摊平成一维数组，索引 i 的真身是
 *
 *     盲文 = SPINNER_FRAMES[i % 10]                        （旋转照旧，速度与 pi 默认一致）
 *     颜色 = colors[floor(i / framesPerColor) % colors.length]
 *
 * 颜色是**按帧数**推进而不是每帧一换：默认 `framesPerColor = 19`。1500ms 不是 80ms 的
 * 整数倍，19 帧 = 1520ms 是离需求（1.5s 一换色）最近的取值（差 1.3%）；演变轨迹：初版
 * 5 帧 / 400ms 偏快 → 10 帧 / 800ms（减半）→ 19 帧 / 1520ms。每帧一换
 * （`framesPerColor = 1`，80ms）在终端里是频闪不是幻彩；再往上就是「半天不动」——
 * `PI_SPINNER_COLOR_HOLD` 按帧数调。
 *
 * 一维表必须有周期，否则回绕处会跳色：周期 = lcm(10, framesPerColor × 颜色数)，这样
 * i 与 i+周期 的 (盲文, 颜色) 都对齐。默认 19 帧 × 7 色：一轮调色板 133 帧（10.6s，
 * 盲文转 13.3 圈），帧表周期 lcm(10, 133) = 1330 帧（约 106s）。
 * 19 与盲文圈长 10 互质，所以换色点每换一次就往圈内错一步、相位遍历全部 10 个位置 ——
 * 观感是颜色在漂移的彩带，换色点不会总落在同一个盲文帧上。想让换色点固定在盲文同一
 * 位置（每圈/每两圈换一次色）就把 `framesPerColor` 设成 10 的倍数（如 10 / 20），代价是
 * 调色板周期与旋转周期锁相。
 *
 * ## 调色板
 *
 * 七个色槽按需求取：accent / success / warning / syntaxKeyword / toolDiffAdded /
 * toolDiffRemoved / toolTitle（需求里的「keyword / added / removed / tool」在主题
 * token 目录里的正式名字）。顺序就照需求这一串排列。换主题后**实际颜色可能撞车**
 * （实测 pi-coder-summer-night：success 与 toolDiffAdded 同为 #8cd6a7、warning 与 toolTitle
 * 同为 #e9c16f），撞车的槽位按 `fg` 的渲染结果去重丢掉 —— 留着会连续两段同一个颜色，
 * 看着像动画卡住了。去重后只剩一种颜色（单色主题 / NO_COLOR）时 `frames = null`：
 * 调用方保持 pi 默认 spinner，不要装一张每帧长得都一样的「动画」表。
 */

/** 只用到 `fg` 的主题接口 —— 沿用 `index.ts` 的 `WorkingMessageTheme` 形状，但不反向 import。 */
export type SpinnerColorize = (token: string, text: string) => string;

/** pi 默认的十帧盲文（顺序即旋转方向）。帧表沿用它：动画读起来与改动前是同一族。 */
export const SPINNER_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * pi 默认帧间隔（毫秒）。自定义帧必须自己给间隔（不给就退回 pi 的默认值，数值一样但
 * 依赖 pi 的实现细节），所以这里写死一份并与 pi 的 `DEFAULT_INTERVAL_MS` 对齐 —— 它同时
 * 是「颜色持续多久」的换算基准（`framesPerColor × SPINNER_INTERVAL_MS`）。
 */
export const SPINNER_INTERVAL_MS = 80;

/** 参与轮换的主题色槽，按需求顺序（「幻彩」的色序）。 */
export const SPINNER_COLOR_TOKENS: readonly string[] = [
	"accent",
	"success",
	"warning",
	"syntaxKeyword",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolTitle",
];

/**
 * 每种颜色持续的帧数（默认 19 帧 × 80ms = 1520ms ≈ 1.5s 一换色）。
 * 1500ms 不是 80ms 的整数倍，19 是最近的帧数（1520ms，差 1.3%）。
 */
export const DEFAULT_FRAMES_PER_COLOR = 19;

/**
 * 取色探针字符：给 `fg` 一个非空文本，拿到的就是「该色槽的染色结果」，用来比对两个
 * 色槽在当前主题下是否同色（`fg` 的返回值带上 ANSI 前缀，不能只看槽位名字）。
 */
const COLOR_PROBE = "x";

export interface SpinnerPalette {
	/** 去重后真正参与轮换的色槽（保持原顺序）。 */
	tokens: string[];
	/** 主题指纹：同一主题同一配色下稳定，换主题 / 换配色后必变。 */
	signature: string;
	/** 帧表（已上色，逐帧字符串）；`null` = 当前主题挑不出两种可区分的颜色。 */
	frames: string[] | null;
}

function gcd(a: number, b: number): number {
	let left = Math.abs(a);
	let right = Math.abs(b);
	while (right > 0) {
		const next = left % right;
		left = right;
		right = next;
	}
	return left;
}

/** 帧表周期（帧数）：盲文圈（10）与颜色周期（每色帧数 × 颜色数）的最小公倍数。 */
function spinnerFramePeriod(framesPerColor: number, colorCount: number): number {
	const colorCycle = framesPerColor * colorCount;
	return (colorCycle / gcd(SPINNER_FRAMES.length, colorCycle)) * SPINNER_FRAMES.length;
}

/** 非整数 / <1 / 非有限值一律退回默认（环境变量解析出来的数还可能是 NaN）。 */
function normalizeFramesPerColor(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) && value >= 1
		? Math.floor(value)
		: DEFAULT_FRAMES_PER_COLOR;
}

/**
 * 按当前主题算出幻彩帧表。
 *
 * 颜色去重按**渲染结果**（`colorize(token, COLOR_PROBE)`）而不是槽位名字：两个槽位在当前
 * 主题里可能是同一个颜色（见文件头）。去重后不足两种颜色就返回 `frames: null`。
 */
export function buildSpinnerPalette(
	colorize: SpinnerColorize,
	options: { framesPerColor?: number; tokens?: readonly string[] } = {},
): SpinnerPalette {
	const tokens = options.tokens ?? SPINNER_COLOR_TOKENS;
	const framesPerColor = normalizeFramesPerColor(options.framesPerColor);

	const seen = new Set<string>();
	const kept: string[] = [];
	const probes: string[] = [];
	for (const token of tokens) {
		const probe = colorize(token, COLOR_PROBE);
		if (seen.has(probe)) continue;
		seen.add(probe);
		kept.push(token);
		probes.push(probe);
	}
	const signature = probes.join("\n");
	if (kept.length < 2) return { tokens: kept, signature, frames: null };

	const frames: string[] = [];
	const period = spinnerFramePeriod(framesPerColor, kept.length);
	for (let index = 0; index < period; index += 1) {
		const token = kept[Math.floor(index / framesPerColor) % kept.length] as string;
		const frame = SPINNER_FRAMES[index % SPINNER_FRAMES.length] as string;
		frames.push(colorize(token, frame));
	}
	return { tokens: kept, signature, frames };
}
