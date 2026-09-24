/**
 * 纯判定：这一轮要不要重新注入核心规则。
 *
 * 语义照 Codex 的 `AgentsMdState::render_diff`（codex-rs/core/src/context/world_state/agents_md.rs）：
 * 拿当前快照和 baseline 比，不变就什么都不发，变了才发并带上「替换此前全部」的声明。
 * 独立成模块是为了让 `node --test` 不经过 pi 的 loader 也能直接测。
 */

/** Codex 的 `REPLACEMENT_NOTICE` 同义句：重注入时告诉模型以最新这份为准。 */
export const REPLACEMENT_NOTICE = "These core rules replace all previously provided core rules.";

/**
 * 投影里已有的 core-rules 消息的 hash，按出现顺序。
 * `undefined` 表示那条消息没带 hash（旧格式 / 手工编辑过）—— 对应 Codex 的
 * `PreviousSectionState::Unknown`：知道有前文，但不知道内容，保守地重注入。
 */
export type PriorHashes = (string | undefined)[];

export type InjectionDecision =
	| { action: "skip"; reason: "no-rules-file" | "unchanged" | "disabled" }
	| { action: "inject"; replacement: boolean };

/**
 * @param currentHash 当前 `AGENTS.core.md` 内容的 hash；文件缺失或读不到时传 undefined
 * @param priorHashes 模型可见投影里已有的 core-rules 消息 hash（压缩后旧条目自动出投影）
 */
export function decideInjection(currentHash: string | undefined, priorHashes: PriorHashes): InjectionDecision {
	if (currentHash === undefined) return { action: "skip", reason: "no-rules-file" };
	// 投影里没有 = 会话刚开始，或上一次注入已被压缩掉 —— 两种都是 Codex 的全量重注入时机。
	if (priorHashes.length === 0) return { action: "inject", replacement: false };
	const last = priorHashes[priorHashes.length - 1];
	if (last === currentHash) return { action: "skip", reason: "unchanged" };
	// 内容变了，或前文 hash 不可知：重注入并声明替换。
	return { action: "inject", replacement: true };
}

/** 把替换声明拼在规则正文前面（Codex 是 `format!("{REPLACEMENT_NOTICE}\n\n{}", text)`）。 */
export function renderBody(rulesText: string, replacement: boolean): string {
	return replacement ? `${REPLACEMENT_NOTICE}\n\n${rulesText}` : rulesText;
}
