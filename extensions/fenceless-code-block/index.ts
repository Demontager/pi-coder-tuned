/**
 * fenceless-code-block — Markdown 代码块去掉围栏（不加底色）
 *
 * 本文件只做接线：把 pi-tui 的量度 / 折行函数交给 `render.ts` 的纯逻辑。原型补丁本身在
 * `installFencelessCodeBlocks` 里 —— 为什么必须打原型、为什么打得中（bundle 内联 vs 加载器
 * virtualModules），见 `render.ts` 的文件头。
 *
 * 只管围栏：代码正文保持 pi 原本的 `mdCodeBlock` 前景色，不铺底色、不碰引用块的 gutter，
 * 也不改行尾补白（那是 `Markdown.render()` 自己的事）。所以不需要 `ctx`、不注册任何事件 ——
 * 扩展在模块求值时就把补丁装好。
 *
 * `PI_FENCELESS_CODE=off` 关闭（与 `PI_LOGO=off` 同一套约定）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { installFencelessCodeBlocks } from "./render.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_FENCELESS_CODE === "off") return;

	installFencelessCodeBlocks({
		Markdown,
		measure: visibleWidth,
		wrap: wrapTextWithAnsi,
	});
}
