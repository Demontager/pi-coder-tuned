/**
 * 让 pi 支持像 Claude Code 那样直接输入 exit / quit 退出。
 *
 * 实现方式：监听 `input` 事件（在扩展命令之后、skill/template 展开之前触发），
 * 当输入去空格后正好是退出词时返回 { action: "handled" }（跳过 agent，不进 LLM），
 * 同时调用 ctx.shutdown() 做优雅退出 —— 会话照常落盘，退出前会触发 session_shutdown。
 *
 * 细节：
 *   - 只在 ctx.mode === "tui" 时生效：--print / --mode json / --mode rpc 里 "exit" 仍是普通 prompt
 *     （注意 --print 的 event.source 也是 "interactive"，所以不能只靠 source 判断；
 *     且 print 模式下 shutdown 本来就是 no-op，拦下来只会静默丢掉 prompt）。
 *   - 精确整行匹配，所以 "exit the loop and print a summary" 这类正常提问不受影响；
 *     带附件（图片）时也放行。
 *   - 大小写不敏感；默认退出词 exit / quit / bye。
 *     可用环境变量覆盖：PI_EXIT_WORDS="exit,quit"；设为 "off" 则整体关闭。
 *   - 顺带注册 /exit 作为内置 /quit 的别名。
 *   - agent 正在跑的时候输入 exit：shutdown 会被推迟到空闲后再执行，即等当前这轮结束才退出。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_WORDS = ["exit", "quit", "bye"];

function exitWords(): string[] | null {
	const raw = process.env.PI_EXIT_WORDS;
	if (!raw) return DEFAULT_WORDS;
	const trimmed = raw.trim();
	if (!trimmed) return DEFAULT_WORDS;
	if (trimmed.toLowerCase() === "off") return null;
	const words = trimmed
		.split(",")
		.map((w) => w.trim().toLowerCase())
		.filter(Boolean);
	return words.length > 0 ? words : null;
}

export default function (pi: ExtensionAPI) {
	const words = exitWords();
	if (!words) return; // PI_EXIT_WORDS=off

	pi.on("input", async (event, ctx) => {
		if (ctx.mode !== "tui" || event.source !== "interactive") return { action: "continue" };
		if (event.images && event.images.length > 0) return { action: "continue" };

		const text = event.text.trim().toLowerCase();
		if (!words.includes(text)) return { action: "continue" };

		ctx.ui.notify("bye 👋", "info");
		ctx.shutdown();
		return { action: "handled" };
	});

	pi.registerCommand("exit", {
		description: "Exit pi cleanly (alias of /quit)",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
