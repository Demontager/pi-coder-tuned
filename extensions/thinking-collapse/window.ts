/**
 * window.ts — thinking 单行连续滚动窗口的纯逻辑。
 *
 * 从 `thinking-collapse.ts` 抽出来（那个文件到处 import pi，`node --test` import 不进来）：
 * 本模块**不 import pi / pi-tui**，可见宽度函数 `widthOf` 由调用方注入（运行时传 pi-tui 的
 * `visibleWidth`，与渲染器同一套实现，量出来的宽度与 pi 实际折行用的宽度严格一致），
 * 所以能用 `node --test` 直接跑：
 *
 *     node --test clients/pi/extensions/thinking-collapse/window.test.ts
 *
 * 目录与 `thinking-collapse.ts` **同名且没有 index.ts**：pi 的扩展加载器只认
 * `extensions/<name>.ts` 与 `extensions/<name>/index.ts`（`loader.js` 的
 * `discoverExtensionsInDir` → `resolveExtensionEntries` 找不到入口就整目录跳过），
 * 所以这个目录不会被当成扩展加载（与 `tool-diff/` 同一套做法）。
 *
 * ## 显示形态：一条不间断滚动的行
 *
 * 整个 thinking 块**永远只渲染成一行**，所有 token 在这一行里连续滚动：
 *
 *     Think: …最新写下的 token 一直追加在行尾
 *
 *   - **不分段、不换行**：thinking 里所有的换行（模型自己折的行、空行分段、列表项之间、
 *     代码围栏内）全部拼进这**同一条**行 —— 上一段结束后，下一段直接接续在上一段的结尾，
 *     不另起一行。于是 Think 区域呈现的是「一条不间断的 token 流」，而不是逐段刷新的多行。
 *   - 行首带 `Think: ` 标签（7 列，从第 0 列起），标签属于「块首」，始终钉在这一行最前面。
 *   - 拼接处补什么按两侧字符决定（见 `joinSeparator`），并且**区分两种接缝**：
 *     - **段内换行**（模型自己折的行、列表项之间）：中文之间不补、英文单词之间补一个空格；
 *     - **段落接缝**（原文的空行处）：中文 ↔ 中文额外补一个**逗号** `，`，免得两段无缝粘连
 *       读起来像一句话（`第一段结尾，第二段开头`）。上一段末尾本来就有标点（。，：等）时
 *       不重复补；英文 / 中英混排仍按空格规则。
 *   - 整行超过预算时**从头部**丢掉溢出字符并在行首补一个 `…`：内容越写越长，前面的字符一路
 *     向前挤出视口，行尾永远是最新写下的 token。放得下就全量显示，不补 `…`。
 *
 * 这里**没有**「短段回填补满整行」的逻辑：曾经有过（最后一段太短时把被顶出去的开头拉回来
 * 拼满行），但它会在流式过程中不断改变整行构成、打断「token 持续流动」的观感，已移除。
 * 现在短 thinking 就是短，行尾留白，不补。
 *
 * ## 硬性不折行（本扩展的核心约束，别拆）
 *
 * 出口行必须**恰好是一行**：thinking 不会被仔细阅读，格式整洁比内容完整更重要，
 * 所以宁可截掉字符也不允许 pi 二次折行。而 pi 会把本扩展的返回值再交给 marked 解析一次，
 * 于是唯一能把两条视觉行**合并**成一条超宽行的是行内 code span：marked 的 codespan
 * tokenizer 会把 code span 里的换行**换成空格**（`rules.inline.code` + `newLineCharGlobal`，
 * 实测 `` `a\nb` `` → text `"a b"`），合并出来的超宽行再被 pi 按 contentWidth 折一次，
 * 折出来的续行没有标签、看上去就是凭空多出来的一行 —— 就是屏幕上看到的「折行」。所以出口行里的反引号必须
 * **自身配对**：`stripUnpairedBackticks` 按 marked 的判定规则（`findCodeSpanEnd`）把配不上
 * 对的反引号整段删掉。头部截断会切在 code span 中间、留下一串落单的闭合反引号，正是同一个 bug。
 * 出口处还有一道硬截断兜底（`truncateTail`），保证任何情况下都不超宽。
 */

/** 可见宽度函数：与 pi-tui `visibleWidth` 同语义（剥 ANSI、宽字符按 2 列）。 */
export type WidthFn = (text: string) => number;

/** 首行标签：`Think: `（占 7 列，从第 0 列开始）。 */
export const HEADER_LABEL = "Think: ";

/** 省略号（1 列）：放在被头部截断的那一行最前面，表示左边还有被挤掉的内容。 */
export const ELLIPSIS = "…";

/** 斜体关 / 开。标签要正常字形、正文要斜体，所以标签前后夹一对 SGR。 */
export const ITALIC_OFF = "\u001b[23m";
export const ITALIC_ON = "\u001b[3m";

/** 内容预算的下限（列）。终端窄到装不下标签时至少还能放一个 `…`。 */
const MIN_CONTENT_WIDTH = 1;

/**
 * 段落接缝（原文空行处）中文 ↔ 中文补的标点：逗号。
 *
 * 选逗号而不是句号：thinking 的段落之间多是「接着想」而不是「说完了」，句号会把语气断得太死。
 * 只在**段落**接缝补，段内折行仍按原规则（中文之间不补），否则模型自己折的每一行都会多一个逗号。
 */
export const PARAGRAPH_JOIN_PUNCT = "，";

/** 可用宽度缺失 / 不合理时的兜底（列）。 */
const DEFAULT_WIDTH = 80;

/** 所有当换行处理的字符：LF / CR / CRLF / NEL / VT / FF / 行分隔符 / 段分隔符。 */
const LINE_BREAK_RE = /\r\n|[\n\r\u0085\u000b\u000c\u2028\u2029]/;

/** 行内 ≥2 个连续空格折叠成 1 个（单个空格保留：单词之间那一个空格是有意义的）。 */
const SPACE_RUN_RE = / {2,}/g;

/** pi 在解析 markdown 前会把 tab 换成 3 个空格，这里先做同样的归一，宽度才算得准。 */
export function normalizeTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * 宽字符（终端占 2 列）：CJK 表意文字、假名、谚文、全角形式等。
 * 与 `joinSeparator` 的「两侧都是宽字符就不补空格」配套 —— 口径只需覆盖「中日韩正文」，
 * 不必与 wcwidth 表逐格一致（差几格只影响要不要补一个空格）。
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
const NO_SPACE_AFTER = new Set(["(", "[", "{", "<", '"', "'", "`", "…", "—", "–", "·", "$"]);

/**
 * 行首是这些字符时不补空格：闭括号 / 收尾标点 / 引号 / 路径与扩展名分隔符。
 * 刻意**不含** `-` 与 `_` —— 它们开头的行更可能是 `--verbose` 这类参数或普通正文，
 * 不补空格会和上一行粘成一个词。
 */
const NO_SPACE_BEFORE = new Set([")", "]", "}", ">", ",", ".", ";", ":", "!", "?", "%", '"', "'", "`", "…"]);

/** 取字符串末尾一个码点（不切半个代理对）。 */
function lastCodePoint(text: string): string {
	if (text === "") return "";
	const end = text.length;
	const start = prevCodePointStart(text, end);
	return text.slice(start, end);
}

/** 取字符串开头一个码点。 */
function firstCodePoint(text: string): string {
	if (text === "") return "";
	const first = text.charCodeAt(0);
	if (first >= 0xd800 && first <= 0xdbff && text.length >= 2) return text.slice(0, 2);
	return text.slice(0, 1);
}

/** 从 end 往前退一个码点，返回它的起始下标（代理对整体退，不切半个）。 */
function prevCodePointStart(text: string, end: number): number {
	if (end <= 1) return 0;
	const low = text.charCodeAt(end - 1);
	if (low >= 0xdc00 && low <= 0xdfff && end >= 2) {
		const high = text.charCodeAt(end - 2);
		if (high >= 0xd800 && high <= 0xdbff) return end - 2;
	}
	return end - 1;
}

/**
 * 两行相接处该填什么。目标是读起来像原句：中文折行处不留空格，英文单词之间留一个，
 * 标点按它自己的排版习惯（ASCII 逗号后有空格、闭括号前没有）。
 *
 * `paragraphBreak = true` 表示这是**段落接缝**（原文空行处）而不是段内折行：此时中文 ↔ 中文
 * 补一个逗号，把「两段」在视觉上分开（否则无缝粘连读起来像一句话）。上一段末尾已经有标点
 * （。，：等 CJK 标点，或 ASCII 的收尾标点）就不重复补 —— 那个标点本身已经把段落断开了。
 */
function joinSeparator(prevEnd: string, nextStart: string, paragraphBreak = false): string {
	if (prevEnd === "" || nextStart === "") return "";
	if (isCjkPunct(prevEnd) || isCjkPunct(nextStart)) return "";
	if (paragraphBreak && isWideChar(prevEnd) && isWideChar(nextStart)) return PARAGRAPH_JOIN_PUNCT;
	if (isWideChar(prevEnd) && isWideChar(nextStart)) return "";
	if (NO_SPACE_AFTER.has(prevEnd)) return "";
	if (NO_SPACE_BEFORE.has(nextStart)) return "";
	return " ";
}

/**
 * 把 thinking 的**所有源行**拼成一条连续的行（缩进去掉、空格串折叠、接缝按两侧字符与
 * 「是否段落接缝」决定补什么）。空行（段落分隔）不产生换行，只把下一次拼接标记成段落接缝 ——
 * 于是上一段的结尾直接接续下一段的开头，中文之间补一个逗号。这正是「一条不间断 token 流」
 * 的拼接层。入参是 `body.split(LINE_BREAK_RE)` 的原始结果（**含**空行条目，它们就是段落标记）。
 */
export function joinAllLines(lines: readonly string[]): string {
	let out = "";
	let paragraphBreak = false;
	for (const line of lines) {
		const collapsed = line.trim().replace(SPACE_RUN_RE, " ");
		if (collapsed === "") {
			// 空行 = 段落分隔。只有已经攒下内容时才有意义（开头的空行不产生接缝）。
			if (out !== "") paragraphBreak = true;
			continue;
		}
		if (out === "") {
			out = collapsed;
			continue;
		}
		out += joinSeparator(lastCodePoint(out), firstCodePoint(collapsed), paragraphBreak) + collapsed;
		paragraphBreak = false;
	}
	return out;
}

/**
 * 找出从 start 开始的行内 code span 的结束位置（exclusive），配不上返回 -1。
 *
 * 判定规则对齐 marked 的 codespan tokenizer（`/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/`）：
 * 开合反引号数量必须相等、闭合串后面不能再紧跟反引号、内容首字符不能是反引号。
 * 只有和 marked 判定一致，「我这边的配对」才等于「marked 眼里的 code span」，
 * 删掉落单反引号之后才不会再出现跨行 code span。
 */
export function findCodeSpanEnd(text: string, start: number): number {
	let openerLength = 0;
	while (text[start + openerLength] === "`") openerLength++;
	const contentStart = start + openerLength;
	let i = contentStart;
	while (i < text.length) {
		if (text[i] !== "`") {
			i++;
			continue;
		}
		let closerLength = 0;
		while (text[i + closerLength] === "`") closerLength++;
		// 内容末字符必然不是反引号（我们只在反引号处停下），所以只需检查首字符。
		const content = text.slice(contentStart, i);
		if (closerLength === openerLength && text[i + closerLength] !== "`" && content[0] !== "`") {
			return i + closerLength;
		}
		i += closerLength;
	}
	return -1;
}

/**
 * 删掉配不上对的反引号（连着一整串一起删），配对的 code span 原样保留。
 *
 * 为什么必须删：marked 是在**整条 markdown** 上做 code span 配对的，一条出口行里落单的
 * 反引号会跟另一条出口行的反引号配成跨行 code span，那个 token 内部的新行会被换成空格，
 * 两行于是被并成一条超宽行、被 pi 再折一次（折出来的续行没有标签）。
 * marked 对落单反引号本来就当字面量，删掉它只是把「会显示成裸反引号」变成「不显示」，
 * 而这一行的内容本来就已经被头部截断过，代价可以忽略。
 */
export function stripUnpairedBackticks(text: string): string {
	if (!text.includes("`")) return text;
	let out = "";
	let changed = false;
	let i = 0;
	while (i < text.length) {
		if (text[i] === "`") {
			const end = findCodeSpanEnd(text, i);
			if (end > i) {
				out += text.slice(i, end);
				i = end;
				continue;
			}
			let run = i;
			while (text[run] === "`") run++;
			i = run;
			changed = true;
			continue;
		}
		out += text[i];
		i++;
	}
	return changed ? out : text;
}

/**
 * 从**头部**截断到 maxWidth 列：保留尾部，前面用一个 `…` 顶替被丢掉的字符。
 *
 * 按**码点**从后往前量（不切半个代理对）；宽度为 0 的字符（组合符 / 零宽）不占预算，
 * 跟着前面那个字符一起带上。宽字符跨在边界上时宁可少一列也不超宽。
 */
export function clipToTail(text: string, maxWidth: number, widthOf: WidthFn, ellipsis = ELLIPSIS): string {
	if (maxWidth <= 0) return "";
	if (widthOf(text) <= maxWidth) return text;
	const budget = maxWidth - widthOf(ellipsis);
	if (budget <= 0) return "";
	let used = 0;
	let i = text.length;
	while (i > 0) {
		const start = prevCodePointStart(text, i);
		const width = widthOf(text.slice(start, i));
		if (width > 0 && used + width > budget) break;
		used += width;
		i = start;
	}
	return ellipsis + text.slice(i);
}

/**
 * 从**尾部**截断到 maxWidth 列（保留头部，截掉的部分换成一个 `…`）。出口兜底截断用。
 *
 * 截断点正好落在空白上时那个空白一并去掉：`the …` 里的空格只是被切掉一半的空白，
 * 不表达任何信息，去掉后这一行可能比预算少 1 列（肉眼看不出来）。
 */
export function truncateTail(text: string, maxWidth: number, widthOf: WidthFn, ellipsis = ELLIPSIS): string {
	if (maxWidth <= 0) return "";
	if (widthOf(text) <= maxWidth) return text;
	const budget = maxWidth - widthOf(ellipsis);
	if (budget <= 0) return "";
	let out = "";
	let used = 0;
	for (const ch of text) {
		const width = widthOf(ch);
		if (used + width > budget) break;
		out += ch;
		used += width;
	}
	return out.replace(/\s+$/, "") + ellipsis;
}

/**
 * 把 thinking 正文压成**一条连续滚动的行**。导出供测试直接调用。
 *
 * @param markdown        thinking 块原文（pi 会把多个 thinking 块用 `\n\n` 拼起来）
 * @param availableWidth  pi 给 transform 的内容宽度（已扣掉 Markdown 组件左右各 1 列 padding）
 * @param widthOf         可见宽度函数（运行时传 pi-tui 的 `visibleWidth`）
 * @param ansi            是否夹斜体开关控制码
 */
export function buildThinkingWindow(
	markdown: string,
	availableWidth: number,
	widthOf: WidthFn,
	ansi = true,
): string {
	const body = normalizeTabs(markdown).trim();
	if (body === "") return markdown;

	// 所有源行（含空行分段）拼成一条连续的行：上一段结尾直接接续下一段开头，不换行。
	const line = joinAllLines(body.split(LINE_BREAK_RE));
	if (line === "") return markdown;

	const width = Math.max(8, Math.floor(availableWidth) || DEFAULT_WIDTH);

	const italicOff = ansi ? ITALIC_OFF : "";
	const italicOn = ansi ? ITALIC_ON : "";
	// 窄到连「标签 + `…` + 至少 1 列正文」都放不下时丢掉标签：正文比标记重要，
	// 否则标签 (7 列) 会把整行吃光、一个字都剩不下。
	const useLabel = width >= widthOf(HEADER_LABEL) + widthOf(ELLIPSIS) + MIN_CONTENT_WIDTH;
	const label = useLabel ? HEADER_LABEL : "";
	const budget = Math.max(MIN_CONTENT_WIDTH, width - widthOf(label));

	// 头部截断滚动：放得下就全显示，放不下就从头部丢掉溢出字符、行首补 `…`，行尾永远是最新 token。
	let content = stripUnpairedBackticks(clipToTail(line, budget, widthOf));
	// 兜底：任何情况下出口行都不许超宽（超了宁可截掉尾部）。
	if (widthOf(label) + widthOf(content) > width) {
		content = truncateTail(content, width - widthOf(label), widthOf);
	}
	content = stripUnpairedBackticks(content);

	// 标签要正常字形（关掉 pi 给的斜体再开回来）；没有标签时正文沿用斜体。
	return label === "" ? content : italicOff + label + italicOn + content;
}
