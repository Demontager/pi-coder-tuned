/**
 * 给 pi 增加 /clear 指令，效果等同于内置的 /new（开一个全新会话，清空当前上下文）。
 *
 * 实现方式：注册扩展命令 clear，内部调用 ctx.newSession() —— 这正是内置 /new 走的
 * 同一条会话替换流程（旧会话先触发 session_shutdown，再绑定新会话，新会话拿到
 * session_start），所以行为、快捷键语义、落盘格式都和 /new 完全一致。
 *
 * 细节：
 *   - 先 await ctx.waitForIdle()：agent 正在跑的时候直接 newSession 会和运行中的
 *     turn 抢会话，等这轮（含自动重试 / 自动压缩 / 排队续跑）结束再换才安全。
 *   - 不传 parentSession / setup / withSession，即纯净的新会话，不做任何上下文搬运。
 *   - result.cancelled 说明有别的扩展在 session_before_new 里否决了这次切换，
 *     此时给一条提示而不是静默失败。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Start a new session (alias of /new)",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const result = await ctx.newSession();
			if (result?.cancelled) {
				ctx.ui.notify("New session cancelled by an extension", "warning");
			}
		},
	});
}
