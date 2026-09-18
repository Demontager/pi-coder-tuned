/**
 * subagent-log-guard 的纯判定层：一段写向 stderr 的文本，是 pi-subagents 的诊断行吗？
 * 不 import pi / pi-tui / 任何运行时依赖，所以 `node --test` 可以直接跑（见 filter.test.ts）。
 */

/** pi-subagents 的诊断前缀：它的 console.warn / console.error 调用点统一以它开头。 */
export const SUBAGENT_LOG_PREFIX = "[pi-subagents]";

export interface ChunkSplit {
	/** 原样放行给终端的内容（非诊断时就是原文，可能为空串） */
	passThrough: string;
	/** 拦下的诊断（已去掉前缀与首尾空白）；长度 > 0 表示这一段是诊断 */
	captured: string[];
}

/** process.stderr.write 的 chunk 可能是 string 也可能是 Uint8Array，统一成文本再比。 */
export function chunkToText(chunk: string | Uint8Array): string {
	return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
}

/**
 * 只看**开头**：Node 的 console.warn / console.error 会把整条消息格式化成「文本 + 换行」
 * 一次写入，所以 pi-subagents 的诊断必然落在 chunk 的开头。
 * 反过来，出现在 chunk 中间的 `[pi-subagents]` 不是诊断开头（可能是模型输出、别的扩展
 * 打印的引用文本），放行才不会误吞别人的内容。
 */
export function splitSubagentDiagnostics(text: string): ChunkSplit {
	if (!text.startsWith(SUBAGENT_LOG_PREFIX)) {
		return { passThrough: text, captured: [] };
	}
	return { passThrough: "", captured: [text.slice(SUBAGENT_LOG_PREFIX.length).trim()] };
}
