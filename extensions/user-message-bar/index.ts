/**
 * user-message-bar — 用户消息框行首竖线（接线）
 *
 * 本文件只做接线：补丁装在 pi 的 `UserMessageComponent.prototype.render` 上，取色源来自
 * `ctx.ui.theme`；全部逻辑在 `bar.ts`（不 import pi，`node --test` 能直跑）。
 *
 * 补丁在**模块求值时就装**（此时取色源还是空，`bar.ts` 会安静地不加竖线），这样它一定赶在
 * 第一次渲染之前到位，不依赖事件顺序。`session_start` 一到就把取色源补成 `ctx.ui.theme` ——
 * 那是个跨 `/theme` 换肤的活 Proxy，换肤下一帧即跟随。顺序上这是安全的：0.85.1 的
 * `interactive-mode.js` 先 `rebindCurrentSession()`（→ `session.bindExtensions()` →
 * `emit(session_start)`）再 `renderInitialMessages()`，所以**恢复会话**时已存的消息拿到也
 * 是带竖线的渲染（实测 `pi --session <文件>` 验证）。
 *
 * `PI_USER_MESSAGE_BAR=off` 关闭；`PI_USER_MESSAGE_BAR_COLOR=<皮肤槽位名>` 换颜色
 * （默认 `toolDiffAdded`，即 diff 新增行行号的那个颜色；想要更暗可以试 `selectedBg`）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";

import { DEFAULT_COLOR_NAME, installUserMessageBar } from "./bar.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_USER_MESSAGE_BAR === "off") return;
	const colorName = process.env.PI_USER_MESSAGE_BAR_COLOR?.trim() || DEFAULT_COLOR_NAME;

	installUserMessageBar({ UserMessageComponent, theme: () => undefined, colorName });
	pi.on("session_start", (_event, ctx) => {
		installUserMessageBar({ UserMessageComponent, theme: () => ctx.ui.theme, colorName });
	});
}
