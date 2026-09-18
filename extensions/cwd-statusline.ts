/**
 * cwd-statusline — 在 statusline 底部单独一行显示当前工作目录（完整绝对路径）
 *
 * 走 ctx.ui.setStatus() 输出一条 extension status，由本地 statusline 扩展
 * （`extensions/statusline/`）渲染在主行下面的第二行：那条路径不被任何路径压缩规则处理，
 * 所以看得到完整 pwd。超长只按终端宽度截断加省略号，不折行。
 *
 * 历史备注：这一行原来由第三方包 `npm:@narumitw/pi-statusline` 渲染。它会先 trim() status 文本、
 * 再按 emoji 拆出图标，配置里的 `extensionStatusIcons.cwd = " 📁"` 是唯一能控制行首缩进的地方；
 * 现在的 statusline 扩展直接渲染 status 原文（trim 后统一缩进一格），所以 PI_CWD_ICON 说了算。
 *
 * 可调环境变量：
 *   PI_CWD_STATUSLINE  设为 off 关闭本扩展
 *   PI_CWD_ICON        图标，默认 📁
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "cwd";
const ICON = process.env.PI_CWD_ICON ?? " 📁";
const DISABLED = (process.env.PI_CWD_STATUSLINE ?? "").toLowerCase() === "off";

export default function (pi: ExtensionAPI) {
	if (DISABLED) return;

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		// statusline 扩展会把 status 文本原样渲染（只 trim 一次并统一缩进一格），
		// 所以这里只发「图标 + 空格 + 绝对路径」。
		ctx.ui.setStatus(STATUS_KEY, `${ICON} ${ctx.cwd}`);
	};

	// session_start：启动 / 新建 / resume / fork 都会触发，是设置初始值的地方
	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	// session_info_changed：会话元信息变化时兜底刷新
	pi.on("session_info_changed", async (_event, ctx) => refresh(ctx));
	// turn_start：每轮开始时刷新一次，保证目录信息始终是最新的
	pi.on("turn_start", async (_event, ctx) => refresh(ctx));
}
