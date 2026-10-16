/**
 * core-rules — re-push the global AGENTS.md's core rules to the context's
 * tail mid-session.
 *
 * ## The problem it solves
 *
 * pi's global `~/.pi/agent/AGENTS.md` is **user-level**: `renderProjectContext`
 * (dist/core/system-prompt.js) concatenates it into the system prompt's
 * `<project_context>` section — after preamble / tools / rules / docs — and
 * the project AGENTS.md (105KB in this repo) follows right after. So it sits
 * mid-blob inside a 124KB block at index 0 — sent on every request, never
 * lost, but always at the very front: as the conversation grows its recency
 * decays, and instruction-following weakens with it.
 *
 * ## How Codex solves it (this extension follows suit)
 *
 * Codex's AGENTS.md is **not in the system prompt** — it is a world-state
 * section:
 *
 *   - `context/user_instructions.rs`: `role: "user"`, wrapped in
 *     `# AGENTS.md instructions` … `</INSTRUCTIONS>` markers with a directory
 *     label. Base instructions take `role: "developer"`.
 *   - `context/world_state/agents_md.rs`: `AgentsMdState` implements
 *     `WorldStateSection` (ID `agents_md`); `render_diff` compares the current
 *     snapshot against the baseline — **unchanged → nothing is sent**,
 *     changed → sent with a `REPLACEMENT_NOTICE` ("These AGENTS.md
 *     instructions replace all previously provided AGENTS.md
 *     instructions.").
 *   - `compact.rs`: after compaction `reference_context_item` is cleared →
 *     the next turn's `should_inject_full_context` is true → a full
 *     re-injection, and
 *     `insert_initial_context_before_last_real_user_or_summary` places it
 *     **before the last real user message** (near the tail — high recency).
 *
 * So Codex's triggers are three: session start, the first turn after each
 * compaction, and a real content change — no repeat injections otherwise.
 * This extension covers all three with **one check** (`decision.ts`): scan
 * the model-visible projection for our own message — absent = session start
 * or already compacted away; present but a different hash = content changed;
 * same hash = skip.
 *
 * ## Where it lands on pi's side
 *
 * The message `before_agent_start` returns is appended by pi as a
 * `role: "custom"` custom_message entry, **persisted into the session** —
 * and in `agent-session.js` the user message is pushed first, the hook
 * message second — so it lands **after the user message**, even later than
 * Codex's "before the last user message" — better recency.
 *
 * Compaction drops old entries from the projection automatically
 * (`buildContextEntries` counts from `firstKeptEntryId`), so "absent from
 * the projection" naturally covers Codex's compaction re-injection — no
 * separate `session_compact` hook needed.
 *
 * ## What is injected
 *
 * Not the 26KB global AGENTS.md verbatim, but a distilled set of the rules
 * that must not decay: the three destructive-action rules, blast-radius
 * tiers, authorization scope, the plan gate, delegation discipline, skill
 * triggers, the git/shell bottom lines.
 * The full text still lives in the system prompt — this just re-pushes the
 * least-decayable pieces to the tail.
 * A missing file is skipped silently (no error, no injection) — an optional
 * enhancement must not make pi's startup noisy.
 *
 * `PI_CORE_RULES=off` disables it entirely.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { decideInjection, renderBody, type PriorHashes } from "./decision.ts";

/** The injected message's customType — also the marker used when scanning the projection. */
export const CORE_RULES_TYPE = "core-rules";

/** The rules file name (placed inside pi's agent dir). */
export const RULES_FILENAME = "AGENTS.core.md";

/** pi's agent dir (`PI_CODING_AGENT_DIR` overrides, else `~/.pi/agent`). */
export function resolveAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	return envDir ? (envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir) : join(homedir(), ".pi", "agent");
}

/** Read the rules file; missing or unreadable → undefined (the caller skips silently). */
export function loadRules(agentDir: string): string | undefined {
	try {
		const text = readFileSync(join(agentDir, RULES_FILENAME), "utf-8");
		return text.trim() === "" ? undefined : text;
	} catch {
		return undefined;
	}
}

/** The content hash — the "did it change" check (Codex uses a structured snapshot compare). */
export function hashRules(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Collect the hashes of existing core-rules messages inside the
 * model-visible projection, in appearance order.
 *
 * Only `custom_message` entries count (that is what `before_agent_start`'s
 * returned message becomes); a missing `details.hash` records undefined —
 * Codex's `PreviousSectionState::Unknown`: prior content known to exist but
 * not what it said — conservatively re-inject.
 */
export function collectPriorHashes(entries: readonly unknown[]): PriorHashes {
	const hashes: PriorHashes = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as { type?: unknown; customType?: unknown; details?: unknown };
		if (record.type !== "custom_message" || record.customType !== CORE_RULES_TYPE) continue;
		const details = record.details as { hash?: unknown } | undefined;
		hashes.push(typeof details?.hash === "string" ? details.hash : undefined);
	}
	return hashes;
}

export default function coreRules(pi: ExtensionAPI): void {
	if (process.env.PI_CORE_RULES === "off") return;

	pi.on("before_agent_start", async (_event, ctx) => {
		const agentDir = resolveAgentDir();
		const text = loadRules(agentDir);
		const currentHash = text === undefined ? undefined : hashRules(text);
		const decision = decideInjection(currentHash, collectPriorHashes(ctx.sessionManager.buildContextEntries()));
		if (decision.action === "skip" || text === undefined) return undefined;

		return {
			message: {
				customType: CORE_RULES_TYPE,
				content: renderBody(text, decision.replacement),
				display: false,
				details: { hash: currentHash },
			},
		};
	});
}
