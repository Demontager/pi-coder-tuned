/**
 * plan-mode's keybinding-rebind logic (pure functions).
 *
 * Two reasons it lives in its own file: `index.ts` imports pi-tui (`visibleWidth`) and cannot
 * be imported by tests without node_modules in the repo; and the rule "never overwrite the
 * user's own config" deserves a place of its own to be nailed down — an extension silently
 * rebinding someone else's keys without guardrails is obnoxious behavior.
 *
 * ## Background
 *
 * shift+tab is owned by pi's built-in `app.thinking.cycle`. Plan mode wants it, so this
 * extension intercepts and consumes the key before it reaches the editor, while rebinding the
 * thinking-level cycle **to ctrl+shift+t** — the user loses no functionality.
 *
 * Rebinding boundary: the write happens only when `app.thinking.cycle` has **no explicit
 * config at all** (i.e. it is still on pi's default shift+tab). Anything the user configured
 * themselves — this key or another — is left untouched: their own config clearly outranks the
 * extension's preference.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The thinking-level cycle's new binding (shift+tab yielded to plan mode). */
export const THINKING_FALLBACK_KEY = "ctrl+shift+t";

/** The description of the occupied binding (used in the notice text; tests reference it too). */
export const THINKING_KEYBINDING_ID = "app.thinking.cycle";

export interface RebindOutcome {
	/** Whether a file write is needed. */
	changed: boolean;
	path: string;
	/** Why nothing was changed (user-facing notice); empty when changed. */
	reason?: string;
	/**
 * Does the user need to handle it manually (broken config we dare not touch)?
 * Kept separate from `reason`: `reason` is for logs/triage, `needsAttention` decides whether
 * to notify the user. "Already bound" belongs to the latter — it is exactly the state we want,
 * and notifying would only be noise.
 */
	needsAttention?: boolean;
}

export function keybindingsPath(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "keybindings.json");
}

/**
 * Given keybindings.json's raw text, return "what should be written" + "why".
 *
 * - file missing / empty: generate a new config containing only this entry
 * - valid JSON object without `app.thinking.cycle`: add it, all other keys kept verbatim
 * - `app.thinking.cycle` already present (user's own config, or this extension's previous
 *   write): **touch nothing**
 * - not valid JSON / not an object: leave it alone (better to not change than to break the
 *   user's config file)
 */
export function rebindThinkingKey(raw: string, path = keybindingsPath()): { value: string; outcome: RebindOutcome } {
	let config: Record<string, unknown> = {};

	if (raw.trim() !== "") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { value: raw, outcome: { changed: false, path, reason: "Configuration is invalid JSON; unchanged", needsAttention: true } };
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {
				value: raw,
				outcome: { changed: false, path, reason: "Configuration is not a JSON object; unchanged", needsAttention: true },
			};
		}
		config = parsed as Record<string, unknown>;
	}

	if (config[THINKING_KEYBINDING_ID] !== undefined) {
		// already bound — whether by this extension's earlier write or the user's own config, this is exactly the state we want:
		// no file write, no notice (reminding on every startup would become noise).
		return {
			value: raw,
			outcome: { changed: false, path, reason: `${THINKING_KEYBINDING_ID} already has a binding; unchanged` },
		};
	}

	config[THINKING_KEYBINDING_ID] = THINKING_FALLBACK_KEY;
	return { value: `${JSON.stringify(config, null, 2)}\n`, outcome: { changed: true, path } };
}
