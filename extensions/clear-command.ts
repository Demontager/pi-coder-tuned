/**
 * Adds a /clear command to pi, equivalent to the built-in /new (start a fresh session and clear the current context).
 *
 * Implementation: registers the extension command `clear`, which internally calls ctx.newSession() — the exact
 * same session-replacement flow the built-in /new uses (the old session fires session_shutdown, then the new
 * session is bound and receives session_start), so behavior, keybinding semantics, and on-disk format are
 * identical to /new.
 *
 * Details:
 *   - Await ctx.waitForIdle() first: calling newSession while the agent is running races the in-flight
 *     turn for the session; waiting for this turn (including auto-retry / auto-compaction / queued
 *     continuation) to finish is safe.
 *   - No parentSession / setup / withSession: a pristine new session with no context carried over.
 *   - result.cancelled means another extension vetoed the switch in session_before_new; show a notice
 *     instead of failing silently.
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
