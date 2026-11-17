/**
 * subagent-log-guard's pure decision layer: is a chunk of text bound for
 * stderr a pi-subagents diagnostic line?
 * No pi / pi-tui / runtime imports, so `node --test` runs it directly (see
 * filter.test.ts).
 */

/** pi-subagents's diagnostic prefix: all its console.warn / console.error call sites lead with it. */
export const SUBAGENT_LOG_PREFIX = "[pi-subagents]";

export interface ChunkSplit {
	/** The content passed to the terminal verbatim (the whole input when not a diagnostic — may be ""). */
	passThrough: string;
	/** The intercepted diagnostics (prefix and outer whitespace stripped); length > 0 means this chunk was diagnostic. */
	captured: string[];
}

/** process.stderr.write's chunk may be a string or a Uint8Array — normalized to text for comparison. */
export function chunkToText(chunk: string | Uint8Array): string {
	return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
}

/**
 * Only the **start** is checked: Node's console.warn / console.error writes
 * the whole formatted message as "text + newline" in one go, so a
 * pi-subagents diagnostic always leads the chunk.
 * Conversely, a `[pi-subagents]` mid-chunk is not a diagnostic start (it
 * could be model output or quoted text another extension prints) — letting
 * it through avoids eating someone else's content.
 */
export function splitSubagentDiagnostics(text: string): ChunkSplit {
	if (!text.startsWith(SUBAGENT_LOG_PREFIX)) {
		return { passThrough: text, captured: [] };
	}
	return { passThrough: "", captured: [text.slice(SUBAGENT_LOG_PREFIX.length).trim()] };
}
