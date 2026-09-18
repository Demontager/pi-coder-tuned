/**
 * Thinking Window Extension（文件名沿用 thinking-collapse.ts）
 *
 * 把 assistant 的 thinking 块渲染成**一条连续横向滚动的行**，避免大段推理刷屏。
 * 纯显示层：session / 模型上下文里的原文完全不变。
 *
 * 形状永远是：
 *
 *     Think: …最新写下的 token 一直追加在行尾
 *
 * 设计意图是「一条不间断的 token 流」：
 *   - **不分段、不换行**：thinking 里所有换行（模型自己折的行、空行分段、列表项、代码围栏内）
 *     全部拼进这同一条行 —— 上一段结束后，下一段直接接续在上一段的结尾，**不另起一行**。
 *     于是 Think 区域从头到尾只有一行在滚动，不会看到「换行重新起头」的动作。
 *   - **段落接缝（原文空行处）中文 ↔ 中文补一个逗号**，免得两段无缝粘连读起来像一句话
 *     （`第一段，第二段`）；上一段末尾本来就有标点时不重复补，英文 / 中英混排仍按空格规则。
 *     段内折行（没有空行）不补逗号 —— 否则模型自己折的每一行都会多一个。
 *   - 整行超出终端宽度时从**头部**丢掉溢出字符、行首补一个 `…`，行尾永远是最新写下的 token；
 *     放得下就全量显示，不补 `…`。
 *   - 行首带 `Think: ` 标签（顶格，无竖线 gutter），始终钉在这一行最前面。
 *
 * 这里**没有**「短段回填补满整行」的逻辑：曾经有过（最后一段太短时把被顶出去的开头拉回来
 * 拼满行，还配过 `isStreaming` 闸门只在定型后补），但它会不断改变整行构成、打断「token 持续
 * 流动」的观感，已整体移除。现在短 thinking 就是短，行尾留白，不补。
 *
 * 标签用 `\x1b[23m` 关掉斜体再 `\x1b[3m` 打开，于是标签是正常字形、正文仍是 pi 给 thinking
 * 块的斜体 + thinkingText 颜色（终端不支持 ANSI 时不夹这对控制码）。
 *
 * 刻意**不再**输出 `… (123 tokens hidden)` 提示行：底部 spinner 已经在数 token 了。
 *
 * ## 硬性不折行（本扩展的核心约束）
 *
 * 本扩展输出的行必须**恰好一行**，绝不允许被 pi 二次折行 —— thinking 内容不会被仔细阅读，
 * 格式整洁比内容完整更重要，所以宁可截掉字符（补 `…`）也不折行。全行拼接、头部截断、
 * 反引号配对、出口兜底截断的全部实现与理由都在 `./thinking-collapse/window.ts`
 * （那个模块**不 import pi / pi-tui**，宽度函数注入，因此 `node --test` 能直接跑它）。
 *
 * 行宽度量用 pi-tui 的 `visibleWidth`（和 pi 自己的渲染器同一套实现），所以本扩展预裁出来的
 * 行在 pi 那边不会再被二次折行。
 *
 * **刻意不注册命令**：窗口形态只有这一种，没有需要用户调的状态，也没有开关；
 * 曾经有过 `/thinking-collapse off | on | <n>`，已移除。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { buildThinkingWindow } from "./thinking-collapse/window.ts";

/** 终端明显不支持 ANSI 时不要夹控制码，否则会把 `\x1b[23m` 当字面字符画出来。 */
function ansiCapable(): boolean {
	return process.env.TERM !== "dumb" && !process.env.NO_COLOR;
}

export default function (pi: ExtensionAPI) {
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant-thinking") return markdown;
		return buildThinkingWindow(markdown, context.availableWidth, visibleWidth, ansiCapable());
	});
}
