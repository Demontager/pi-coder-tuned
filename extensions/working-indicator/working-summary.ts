/**
 * working-summary.ts — spinner 行右对齐「提示词摘要」的纯文本压平 + 纯布局逻辑。
 *
 * `working-indicator.ts` 在 spinner 文案（`Working (23s)` / `Tools Calling (…)`）的
 * 右侧追加当前回合提示词的摘要（**整段提示词压平成一行**后的前排字符 + `…`），形如：
 *
 *      ⠧ Working (23s)                        ✦ /init 我要优化…
 *
 * 本文件不 import 任何 pi / pi-tui 模块 —— 宽度计算通过 `widthOf` 依赖注入（运行时传
 * pi-tui 的 `visibleWidth`，与渲染器同一套实现，所以量出来的宽度与 pi 实际折行用的宽度
 * 严格一致；单测里喂一个简单的 ASCII=1 / CJK=2 假函数即可），因此能用 `node --test`
 * 直接跑：
 *
 *     node --test clients/pi/extensions/working-indicator/working-summary.test.ts
 *
 * ## 压平（`flattenPrompt`）
 *
 * 多行提示词要显示成**一句正常的话**，而不是只显示第一行 —— 第一行往往只有几个字
 * （"帮我看看"、"修一下"），信息量全在后面几行。规则：
 *
 *   - 换行、缩进、制表符、连续空格全部折叠：行首行尾空白去掉（缩进消失），行内
 *     **≥2 个连续空格折叠成 1 个**，单个空格原样保留（单词之间那一个空格是有意义的）。
 *     刻意不按字面的「超过两个才折叠」实现 —— 那样 3 个空格变 1 个、2 个空格却保留
 *     2 个，越长反而越窄，非单调。
 *   - 行间连接符按**两侧字符**决定（`joinSeparator`），目标是读起来像原句：
 *       两侧都是宽字符（CJK）  → 不补空格（中文折行处本来就没有空格）
 *       任一侧是 CJK 标点      → 不补空格（`，。：、「」《》` 等两侧都不吃空格）
 *       行尾是开括号/引号      → 不补空格（`call(` + `)` → `call()`）
 *       行首是闭括号/收尾标点  → 不补空格（`summary` + `.ts` → `summary.ts`，路径不断）
 *       其余（含 ASCII 逗号后、中英混排）→ 补 1 个空格（`hello,` + `world` → `hello, world`）
 *   - 各种「看不见的脏东西」一并归一：`\r\n` / `\r` / `\u2028` / `\u2029` / `\u0085` /
 *     `\v` / `\f` 都当换行；NBSP / 全角空格 / `\u2000-\u200a` 等 Unicode 空格当普通空格；
 *     零宽字符（`\u200b` / `\ufeff` / 双向标记）删掉 —— 它们不参与显示却会混进宽度
 *     计算，把右对齐算歪；ANSI 转义序列（从终端复制粘贴会带）整段剥掉，否则截断可能
 *     切在转义序列中间渲染出乱码；其余控制字符删除。
 *   - Markdown 排版噪声剥掉：代码围栏标记行（` ```ts `，**围栏内的代码正文保留**）、
 *     分隔线（`---` / `***` / `___`）、引用标记 `> `、标题标记 `## `、列表标记
 *     `- ` / `* ` / `+ ` / `1. `。压成一行后它们只是垃圾字符。
 *   - 空行（含段落之间的多个空行）不产生额外空格；以空行开头的提示词也能正常摘要
 *     （旧实现取第一行，这种情况直接判定为「无摘要」）。
 *   - 只扫描前 `MAX_PROMPT_SCAN_CHARS` 个字符：摘要最多显示半屏，多扫纯属白做功，
 *     而这个函数每个 `input` 事件都要跑一次（提示词可能是几十 KB 的粘贴）。切点若落在
 *     代理对中间，丢掉那个落单的高位代理。
 *
 * 刻意**不做**的两件事（都会误伤正常内容）：行尾连字符的「反断词」（`opti-` + `mization`
 * → `optimization`）—— 无法与真的以 `-` 结尾的行区分；以及跨行 URL 的无缝拼接 —— 检测
 * 不可靠，按普通规则补空格。
 *
 * ## 布局（`layoutPromptSummary`）
 *
 * 给定左段可见宽度、整行可见宽度预算与压平后的提示词，算出摘要文本（按可见宽度截断、
 * 必要时补 `…`）和左段与摘要之间的空格数，使摘要**恰好右对齐到行尾**。
 *
 * 为什么右对齐靠「算空格」而不是靠渲染器：pi 的 working message 走
 * `Text` 组件的 word-wrap（`wrapTextWithAnsi`），只有**整行可见宽度 ≤ 折行宽度**
 * 时才原样单行输出（行内空格原样保留）；一旦超宽就会在空格处折到第二行、
 * 且行尾空格被 `trimEnd` 掉。所以这里把总宽**恰好**凑满预算：既不折行，
 * 摘要又顶到右端。调用方传入的 `totalWidth` 必须已扣除 spinner 与 Text
 * 左右 padding 占的列数（见 working-indicator.ts 的 `SPINNER_AND_PADDING_COLUMNS`）。
 *
 * 截断规则：针对**整段压平后的提示词**（不是第一行）。放得下就全量展示（不补省略号），
 * 放不下就截到放得下的最长前缀再接一个 `…`。`…` 恒占位（按 `widthOf` 量），截断点落在
 * 宽字符（CJK 占 2 列）中间时宁可少一列也不超宽 —— 少掉的列数自动并进 gap，摘要仍然
 * 右对齐。另有一个独立的**整段宽度上限**（`maxWidth`，调用方传终端宽度的一半）：不管
 * 行内剩余空间多大，摘要段（`✦ ` + 正文）都不超过它 —— 免得宽终端上一条长提示词把左半
 * 行的状态文案挤得只剩零星几列；上限收窄出的富余同样并进 gap，右对齐不变。
 *
 * 可用宽度本身（`availableSummaryTextWidth`）是公开的：`summary-request.ts` 在请求模型
 * 摘要时要用同一个数——先算好「这一格能放多少列」，再据此决定值不值得请求、要求模型输出
 * 多长。渲染与请求共用一份宽度数学，模型拿到的目标长度才不会和实际能显示的对不上。
 */

/** 可见宽度函数：与 pi-tui `visibleWidth` 同语义（剥 ANSI、宽字符按 2 列）。 */
export type WidthFn = (text: string) => number;

/** 摘要前的标记符。可见宽度在运行时用 `widthOf` 现量，不假设它是 1 列。 */
export const SUMMARY_MARKER = "✦";

/** 左段与摘要之间的最小空隙（列）。右对齐天然把摘要推到行尾，这只是窄终端下的下限。 */
export const DEFAULT_MIN_GAP = 1;

/** 摘要正文（不含 `✦ ` 前缀）至少要有这么宽才值得显示，否则整条摘要省略。 */
export const MIN_SUMMARY_TEXT_WIDTH = 4;

/**
 * 压平时最多扫描多少个原始字符（UTF-16 码元）。摘要最多显示半屏（几百列），
 * 扫描上限只是给「几十 KB 的粘贴」兜底，让 `input` 事件里的那次计算保持廉价。
 */
export const MAX_PROMPT_SCAN_CHARS = 4000;

/** 截断时接在末尾的省略号。 */
const ELLIPSIS = "…";

/* eslint-disable no-control-regex -- 下面几条正则必须匹配控制字符 / 转义序列本身 */

/** ANSI / VT 转义序列：CSI（`ESC [ … 终止符`）、OSC（`ESC ] … BEL|ST`）、以及双字符转义。 */
const ANSI_RE =
	/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** 零宽 / 不可见格式字符：显示上不占位，留着会污染宽度计算。 */
const ZERO_WIDTH_RE = /[\u200b\u200c\u200d\u200e\u200f\u2060\u2061-\u2064\ufeff]/g;

/** Unicode 空白（不含 ASCII 空格与制表符）：一律归一成普通空格。 */
const UNICODE_SPACE_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

/** 所有当换行处理的字符：LF / CR / CRLF / NEL / VT / FF / 行分隔符 / 段分隔符。 */
const LINE_BREAK_RE = /\r\n|[\n\r\u0085\u000b\u000c\u2028\u2029]/g;

/** 行内剩余的控制字符（换行与制表符已在上一步处理掉）。 */
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/* eslint-enable no-control-regex */

/** 代码围栏标记行（` ``` ` / `~~~`，可带语言标识）：整行丢掉，围栏内的正文保留。 */
const FENCE_LINE_RE = /^(?:`{3,}|~{3,})[^\s`~]*$/;
/** 水平分隔线（`---` / `***` / `___`，可带空格）：整行丢掉。 */
const RULE_LINE_RE = /^(?:[-*_]\s*){3,}$/;
/** 引用标记 `> `（可嵌套 `> > `）。 */
const BLOCKQUOTE_RE = /^(?:>\s?)+/;
/** ATX 标题标记 `# ` … `###### `。 */
const HEADING_RE = /^#{1,6}\s+/;
/** 列表标记：`- ` / `* ` / `+ ` / `• ` 与 `1. ` / `2) `（标记后必须有空白，避免误伤 `-1` / `**粗体**`）。 */
const LIST_BULLET_RE = /^(?:[-*+•·]\s+|\d{1,3}[.)]\s+)/;

/** 行内 ≥2 个连续空格折叠成 1 个（单个空格保留）。 */
const SPACE_RUN_RE = / {2,}/g;

/**
 * 宽字符（终端占 2 列）：CJK 表意文字、假名、谚文、全角形式等。
 * 与 `joinSeparator` 的「两侧都是宽字符就不补空格」配套 —— 口径只需覆盖
 * 「中日韩正文」，不必与 wcwidth 表逐格一致（差几格只影响要不要补一个空格）。
 */
function isWideChar(ch: string): boolean {
	const c = ch.codePointAt(0) ?? 0;
	return (
		(c >= 0x1100 && c <= 0x115f) ||
		(c >= 0x2e80 && c <= 0xa4cf) || // 含 CJK 标点 0x3000-0x303f
		(c >= 0xac00 && c <= 0xd7a3) ||
		(c >= 0xf900 && c <= 0xfaff) ||
		(c >= 0xfe30 && c <= 0xfe6f) ||
		(c >= 0xff00 && c <= 0xff60) || // 全角形式（含全角标点）
		(c >= 0xffe0 && c <= 0xffe6)
	);
}

/**
 * CJK 标点（，。、；：？！「」『』《》【】… 及全角/半角形式）：两侧都不吃空格。
 * 全角区里要排掉字母与数字（`ＡＢＣ１２３` 是正文，不是标点）。
 */
function isCjkPunct(ch: string): boolean {
	const c = ch.codePointAt(0) ?? 0;
	if (c >= 0x3000 && c <= 0x303f) return true; // CJK 符号与标点
	if (c >= 0xfe30 && c <= 0xfe6f) return true; // 竖排/小型形式
	if (c >= 0xff61 && c <= 0xff65) return true; // 半角片假名标点 ｡｢｣､･
	if (c < 0xff01 || c > 0xff60) return false; // 全角形式区
	const digit = c >= 0xff10 && c <= 0xff19;
	const upper = c >= 0xff21 && c <= 0xff3a;
	const lower = c >= 0xff41 && c <= 0xff5a;
	return !digit && !upper && !lower;
}

/** 行尾是这些字符时不补空格：开括号 / 开引号 / 反引号 / 破折号省略号一类。 */
const NO_SPACE_AFTER = new Set(["(", "[", "{", "<", "\"", "'", "`", "…", "—", "–", "·", "$"]);
/**
 * 行首是这些字符时不补空格：闭括号 / 收尾标点 / 引号 / 路径与扩展名分隔符。
 * 刻意**不含** `-` 与 `_` —— 它们开头的行更可能是 `--verbose` 这类参数或普通正文，
 * 不补空格会和上一行粘成一个词。
 */
const NO_SPACE_BEFORE = new Set([
	")",
	"]",
	"}",
	">",
	",",
	".",
	";",
	":",
	"!",
	"?",
	"%",
	"\"",
	"'",
	"`",
	"…",
]);

/**
 * 两行相接处该填什么。目标是读起来像原句：中文折行处不留空格，英文单词之间留一个，
 * 标点按它自己的排版习惯（ASCII 逗号后有空格、闭括号前没有）。
 */
function joinSeparator(prevEnd: string, nextStart: string): string {
	if (prevEnd === "" || nextStart === "") return "";
	if (isCjkPunct(prevEnd) || isCjkPunct(nextStart)) return "";
	if (isWideChar(prevEnd) && isWideChar(nextStart)) return "";
	if (NO_SPACE_AFTER.has(prevEnd)) return "";
	if (NO_SPACE_BEFORE.has(nextStart)) return "";
	return " ";
}

/** 取字符串末尾一个码点（不切半个代理对）。 */
function lastChar(text: string): string {
	if (text === "") return "";
	const last = text.charCodeAt(text.length - 1);
	if (last >= 0xdc00 && last <= 0xdfff && text.length >= 2) {
		return text.slice(-2);
	}
	return text.slice(-1);
}

/** 取字符串开头一个码点。 */
function firstChar(text: string): string {
	if (text === "") return "";
	const first = text.charCodeAt(0);
	if (first >= 0xd800 && first <= 0xdbff && text.length >= 2) {
		return text.slice(0, 2);
	}
	return text.slice(0, 1);
}

/**
 * 剥掉一行的 Markdown 排版噪声。返回 null 表示整行都该丢掉（围栏标记行 / 分隔线）。
 * 顺序：先判整行丢弃，再依次剥引用 → 标题 → 列表标记（`> - item` 这种组合也剥得干净）。
 */
function stripLineChrome(line: string): string | null {
	if (FENCE_LINE_RE.test(line) || RULE_LINE_RE.test(line)) return null;
	return line
		.replace(BLOCKQUOTE_RE, "")
		.replace(HEADING_RE, "")
		.replace(LIST_BULLET_RE, "")
		.trim();
}

/**
 * 把整段提示词压平成一行紧凑文本（规则见文件头注释）。空提示词 / 全是空白与排版噪声
 * 时返回空串 —— 调用方按「无摘要」处理。
 */
export function flattenPrompt(prompt: string, maxScanChars: number = MAX_PROMPT_SCAN_CHARS): string {
	if (prompt === "") return "";
	let src = maxScanChars > 0 && prompt.length > maxScanChars ? prompt.slice(0, maxScanChars) : prompt;
	// 扫描上限可能切在代理对中间：丢掉落单的高位代理，免得后面按码点走时出现半个字符。
	const tail = src.charCodeAt(src.length - 1);
	if (tail >= 0xd800 && tail <= 0xdbff) src = src.slice(0, -1);

	src = src.replace(ANSI_RE, "").replace(ZERO_WIDTH_RE, "").replace(UNICODE_SPACE_RE, " ");

	let out = "";
	for (const rawLine of src.split(LINE_BREAK_RE)) {
		// 制表符按「一个空格」处理而不是直接删：`a\tb` 删掉会把两个词粘成 `ab`。
		const cleaned = rawLine.replace(/\t/g, " ").replace(CONTROL_RE, "").trim();
		if (cleaned === "") continue; // 空行 / 纯缩进行：不产生额外空格
		const content = stripLineChrome(cleaned);
		if (content === null || content === "") continue;
		out += joinSeparator(lastChar(out), firstChar(content)) + content;
	}
	return out.replace(SPACE_RUN_RE, " ").trim();
}

/** 字素切分：有 `Intl.Segmenter` 就用（代理对 / 组合字符不拆半），没有就按码点。 */
const graphemeSegmenter =
	typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: null;

function graphemes(text: string): string[] {
	if (graphemeSegmenter !== null) {
		return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
	}
	return [...text];
}

/**
 * 把文本截到可见宽度不超过 `maxWidth` 的最长前缀（按字素前进，不切半个字符）。
 * 文本本身放得下时原样返回。用 `widthOf(前缀)` 逐段量而不是逐字符宽度求和，
 * 这样组合字符 / 宽字符的边界判断与渲染器一致。
 */
export function fitToWidth(text: string, maxWidth: number, widthOf: WidthFn): string {
	if (maxWidth <= 0) return "";
	if (widthOf(text) <= maxWidth) return text;
	let out = "";
	for (const segment of graphemes(text)) {
		const next = out + segment;
		if (widthOf(next) > maxWidth) break;
		out = next;
	}
	return out;
}

export interface PromptSummaryLayout {
	/** 截断后的摘要正文（可能带尾部 `…`），不含 `✦ ` 前缀。 */
	summaryText: string;
	/** 左段与 `✦` 之间应补的空格数（≥ minGap，且使整行恰好占满 totalWidth）。 */
	gap: number;
}

export interface SummaryTextWidthOptions {
	/** 左段（spinner 文案）的可见宽度（ANSI 色码不计）。 */
	leftWidth: number;
	/** 整条 working message 的可见宽度预算（已扣除 spinner 与 padding 占位）。 */
	totalWidth: number;
	/** 可见宽度函数（运行时传 pi-tui 的 visibleWidth）。 */
	widthOf: WidthFn;
	/** 摘要标记符，默认 `✦`。 */
	marker?: string;
	/** 左段与摘要之间的最小空隙，默认 1 列。 */
	minGap?: number;
	/**
	 * 摘要段（`marker` + 空格 + 正文）的可见宽度上限；缺省不限（只受
	 * totalWidth 约束）。
	 */
	maxWidth?: number;
}

export interface PromptSummaryOptions extends SummaryTextWidthOptions {
	/** 压平后的提示词（见 `flattenPrompt`）；空串直接返回 null。 */
	promptText: string;
	/** 摘要正文的最小可用宽度，低于它整条摘要省略，默认 4 列。 */
	minTextWidth?: number;
}

/**
 * 摘要正文（不含 `✦ ` 前缀）可用的可见列数：预算 − 左段 − 最小空隙 − 标记前缀，
 * 再受 `maxWidth`（整段上限）封顶。返回值 ≤ 0 表示这一格放不下摘要。
 *
 * 渲染（`layoutPromptSummary`）与「要不要请模型摘要 / 请它写多长」（`summary-request.ts`）
 * 都基于它，两处必须得出同一个数 —— 否则模型按 40 列写的摘要会撞上实际只有 20 列的位置。
 */
export function availableSummaryTextWidth(opts: SummaryTextWidthOptions): number {
	const marker = opts.marker ?? SUMMARY_MARKER;
	const minGap = opts.minGap ?? DEFAULT_MIN_GAP;
	const markerWidth = opts.widthOf(`${marker} `);
	let avail = opts.totalWidth - opts.leftWidth - minGap - markerWidth;
	if (opts.maxWidth !== undefined) {
		avail = Math.min(avail, opts.maxWidth - markerWidth);
	}
	return avail;
}

/**
 * 计算右对齐布局。返回 null 表示放不下（左段太宽 / 终端太窄 / 提示词为空），
 * 调用方应只显示左段。
 *
 * 不变量（非 null 时恒成立，单测逐条断言）：
 *   leftWidth + gap + widthOf(marker + " ") + widthOf(summaryText) === totalWidth
 *   gap ≥ minGap
 */
export function layoutPromptSummary(opts: PromptSummaryOptions): PromptSummaryLayout | null {
	const marker = opts.marker ?? SUMMARY_MARKER;
	const minGap = opts.minGap ?? DEFAULT_MIN_GAP;
	const minTextWidth = opts.minTextWidth ?? MIN_SUMMARY_TEXT_WIDTH;
	const text = opts.promptText;
	if (text === "") return null;

	const widthOf = opts.widthOf;
	const markerWidth = widthOf(`${marker} `); // 布局只需它的宽度（可用宽度由 helper 算）
	// 富余（未用满的列数）全部并进 gap：短摘要时它把摘要推到行尾（右对齐），
	// 截断摘要时它恰好等于（或略大于）minGap。
	const avail = availableSummaryTextWidth(opts);
	if (avail < minTextWidth) return null;

	let summaryText: string;
	if (widthOf(text) <= avail) {
		// 整段放得下：完整展示、不补省略号（用户要求：短提示词全量右对齐）。
		summaryText = text;
	} else {
		// 放不下：给省略号留出宽度后截断；截断点后的行尾空格去掉，避免 "abc …"。
		const budget = avail - widthOf(ELLIPSIS);
		summaryText = `${fitToWidth(text, budget, widthOf).trimEnd()}${ELLIPSIS}`;
	}

	// gap 吃掉全部余量：短摘要时它把摘要推到行尾（右对齐），
	// 截断摘要时它恰好等于（或略大于）minGap。
	const gap = opts.totalWidth - opts.leftWidth - markerWidth - widthOf(summaryText);
	if (gap < minGap) return null; // 防御：理论上走不到（avail 已保证）
	return { summaryText, gap };
}
