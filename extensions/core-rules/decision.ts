/**
 * Pure decision logic: does this turn need a core-rules re-injection.
 *
 * The semantics mirror Codex's `AgentsMdState::render_diff`
 * (codex-rs/core/src/context/world_state/agents_md.rs): compare the current
 * snapshot against the baseline — unchanged → send nothing; changed → send
 * with a "replaces all previous" notice.
 * Its own module so `node --test` exercises it without pi's loader.
 */

/** Codex's `REPLACEMENT_NOTICE` equivalent: tells the model the newest copy wins on re-injection. */
export const REPLACEMENT_NOTICE = "These core rules replace all previously provided core rules.";

/**
 * The hashes of core-rules messages already in the projection, in order.
 * `undefined` marks a message carrying no hash (an old format / a hand edit)
 * — Codex's `PreviousSectionState::Unknown`: prior content exists, contents
 * unknown — conservatively re-inject.
 */
export type PriorHashes = (string | undefined)[];

export type InjectionDecision =
	| { action: "skip"; reason: "no-rules-file" | "unchanged" | "disabled" }
	| { action: "inject"; replacement: boolean };

/**
 * @param currentHash the hash of the current `AGENTS.core.md` contents;
 *                    undefined when the file is missing or unreadable
 * @param priorHashes the core-rules message hashes in the model-visible
 *                    projection (compaction drops old entries automatically)
 */
export function decideInjection(currentHash: string | undefined, priorHashes: PriorHashes): InjectionDecision {
	if (currentHash === undefined) return { action: "skip", reason: "no-rules-file" };
	// absent from the projection = session start, or the last injection was compacted away — both are Codex's full re-injection moments.
	if (priorHashes.length === 0) return { action: "inject", replacement: false };
	const last = priorHashes[priorHashes.length - 1];
	if (last === currentHash) return { action: "skip", reason: "unchanged" };
	// the content changed, or the prior hash is unknowable: re-inject and declare replacement.
	return { action: "inject", replacement: true };
}

/** Prepend the replacement notice to the rules body (Codex does `format!("{REPLACEMENT_NOTICE}\n\n{}", text)`). */
export function renderBody(rulesText: string, replacement: boolean): string {
	return replacement ? `${REPLACEMENT_NOTICE}\n\n${rulesText}` : rulesText;
}
