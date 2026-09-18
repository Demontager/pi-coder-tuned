/**
 * fenceless-code-block — 纯逻辑：Markdown 代码块去掉围栏
 *
 * 去围栏这个观感来自 `itc-steve/pi-theme`（npm `@itc-steve/pi-theme`，MIT），但**只取这一半**：
 * 上游还给每行铺一块 `toolPendingBg` 底色，本仓库不要底色 —— 代码正文保持 pi 原本的
 * `mdCodeBlock` 前景色，缩进与补白也照 pi 的老规矩来。按本仓库的习惯重写：pi-tui 的量度 /
 * 折行函数由调用方注入（本模块不 import pi，`node --test` 能直跑）。
 *
 * 效果：` ``` ` 开合围栏（连同 `lang` 标签）不再占行；代码正文按 pi 的缩进铺开，语法着色保留。
 * 行尾**不补白**：补白本来是给底色铺满整宽用的，而 `Markdown.render()` 无论如何都会把每行补到
 * 整宽（没有底色时走 `lineWithMargins + " ".repeat(paddingNeeded)` 那条分支），自己再补一遍多余。
 *
 * 为什么必须打原型补丁：pi 的扩展 API 里跟 Markdown 有关的只有 `registerMarkdownTransformer`，
 * 它是**字符串级**的（改完仍交给内置渲染器）。而围栏是内置渲染器自己拼的字面量
 * （`markdown.js` 的 `case "code"`：`theme.codeBlockBorder("```" + lang)` 与收尾的 `"```"`），
 * 源文里没有这两个字符，字符串级改不掉。所以只能接管 `Markdown.prototype.renderToken`。
 *
 * 补丁为什么打得中（跨模块实例，本机实测过，别凭直觉推断）：
 *   `pi` 命令跑的是 `dist/bundle/cli.js`（bun 打的 bundle），pi-tui 被**内联**进 chunk，不是
 *   node_modules 里那份；扩展若拿到 node_modules 那份，补丁就打在另一个类上、毫无效果
 *   （实测：改外部包的 `Markdown.prototype`，pi 自己的 `AssistantMessageComponent` 渲染同一个
 *   assistant 消息，围栏照样在）。真正让补丁生效的是 pi 扩展加载器的 virtualModules 分支
 *   （`core/extensions/loader.js:421`，bundle / 编译二进制走 `{ virtualModules: VIRTUAL_MODULES }`）：
 *   扩展 import 的 `@earendil-works/pi-tui` 被指向加载器那份 bundle 自己的命名空间，也就是 pi
 *   渲染时用的同一个类。`index.test.ts` 断言的就是这条端到端链路。
 *
 * 每行都必须 ≤ width（含缩进）：`Markdown.render()` 会把 renderToken 返回的**每一行**再交给
 * `wrapTextWithAnsi(line, contentWidth)`，超宽行会被二次折行 —— 而续行不带缩进，代码块看上去
 * 会错位。所以这里自己先折行；缩进放不下（比 width 还宽）时丢缩进，保证可用宽度至少 1 列。
 */

/** 补丁标记：`Symbol.for` 走全局注册表，`/reload`（模块重新求值）后仍认得出这个原型包过了。 */
const PATCH_KEY = Symbol.for("pi-fenceless-code-block.patched");

/** 终端列宽量度（注入 pi-tui 的 `visibleWidth`）。 */
export type Measure = (text: string) => number;
/** 折行（注入 pi-tui 的 `wrapTextWithAnsi`）。 */
export type Wrap = (text: string, width: number) => string[];

export interface CodeBlockRenderOptions {
	/** 语言标签（` ```js ` 里的 `js`），只用来交给 `highlight`。 */
	lang?: string;
	/** 缩进前缀：pi 的 `MarkdownTheme.codeBlockIndent`（设置项 `markdown.codeBlockIndent`，默认两格）。 */
	indent?: string;
	/** 着色：pi 的 `MarkdownTheme.highlightCode`，返回行数与输入一一对应。 */
	highlight?: (code: string, lang?: string) => string[];
	/** 没有 `highlightCode` 时的兜底着色，等价于官方渲染器的 else 分支（`theme.codeBlock`）。 */
	fallbackStyle?: (text: string) => string;
	measure: Measure;
	wrap: Wrap;
}

/** 代码块正文 → 可直接交给 pi 渲染的行：无围栏、按缩进铺开、每行不超过 width。 */
export function renderCodeBlockLines(code: string, width: number, options: CodeBlockRenderOptions): string[] {
	const { measure, wrap } = options;
	const total = Math.max(1, width);
	const wanted = options.indent ?? DEFAULT_INDENT;
	// 缩进可能把可用宽度挤成 0（极窄终端）：宁可这一段丢缩进，也不能让行超过 width
	// （超了会被 Markdown.render() 二次折行，续行丢缩进、看上去错位）。
	const indent = measure(wanted) < total ? wanted : "";
	const inner = Math.max(1, total - measure(indent));

	const lines: string[] = [];
	for (const source of styleCode(code, options)) {
		// 折行函数对空串可能返回空数组：空行也要占一行，否则代码块中间会塌掉一行。
		const pieces = wrap(source, inner);
		for (const piece of pieces.length > 0 ? pieces : [""]) lines.push(indent + piece);
	}
	return lines;
}

const DEFAULT_INDENT = "  ";

/**
 * 着色优先级：`highlight` 有产出就用它；产出为空（空代码块、高亮器不认这门语言）就退回纯文本
 * —— 官方渲染器在这种情况下会一行都不画，那样整个代码块会凭空消失。
 */
function styleCode(code: string, options: CodeBlockRenderOptions): string[] {
	const highlighted = options.highlight?.(code, options.lang);
	if (highlighted && highlighted.length > 0) return highlighted;
	const plain = code.split("\n");
	return options.fallbackStyle ? plain.map(options.fallbackStyle) : plain;
}

/** Markdown 实例上的主题切片（类的"私有"字段在运行时就是普通属性）。 */
interface MarkdownLike {
	theme?: {
		codeBlockIndent?: string;
		highlightCode?: (code: string, lang?: string) => string[];
		codeBlock?: (text: string) => string;
	};
}

type RenderToken = (
	this: MarkdownLike,
	token: unknown,
	width: number,
	nextType?: string,
	styleContext?: unknown,
) => string[];

export interface FencelessPatchOptions {
	/** pi-tui 的 `Markdown` 类。扩展侧 import 到的就是 pi 渲染用的那个类，见文件头。 */
	Markdown: { prototype: Record<string | symbol, unknown> };
	measure: Measure;
	wrap: Wrap;
}

/**
 * 装上「代码块去围栏」补丁。返回**本次是否真的装了**：`/reload` 之后是 `false`（补丁已在），
 * 原型的形状不认识（没有 `renderToken`）时也是 `false` 且什么都不做 —— 不猜、不抛，
 * 宁可这个特性不生效。
 */
export function installFencelessCodeBlocks(options: FencelessPatchOptions): boolean {
	const prototype = options.Markdown.prototype;
	if (prototype[PATCH_KEY]) return false;

	const original = prototype.renderToken;
	if (typeof original !== "function") return false;
	prototype[PATCH_KEY] = true;

	const patched: RenderToken = function (this: MarkdownLike, token, width, nextType, styleContext) {
		const block = token as { type?: string; text?: string; lang?: string } | null | undefined;
		// 只接管代码块，其它 token 原样交给内置渲染器（含 blockquote / list 里的嵌套调用）。
		if (block?.type !== "code") return original.call(this, token, width, nextType, styleContext);

		const theme = this?.theme ?? {};
		const lines = renderCodeBlockLines(block.text ?? "", width, {
			lang: block.lang,
			indent: theme.codeBlockIndent,
			highlight: theme.highlightCode?.bind(theme),
			fallbackStyle: theme.codeBlock?.bind(theme),
			measure: options.measure,
			wrap: options.wrap,
		});
		// 与官方渲染器一致：后面紧跟的不是空行 token 时补一个空行，免得代码块贴着下一段。
		if (nextType && nextType !== "space") lines.push("");
		return lines;
	};
	prototype.renderToken = patched;
	return true;
}
