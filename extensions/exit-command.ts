/**
 * Let pi exit on a bare `exit` / `quit`, like Claude Code.
 *
 * How: listen to the `input` event (fired after extension commands, before
 * skill/template expansion); when the trimmed input is exactly an exit word,
 * return { action: "handled" } (skips the agent — never reaches the LLM) and
 * call ctx.shutdown() for a graceful exit — the session persists as usual and
 * session_shutdown fires.
 *
 * Details:
 *   - only active at ctx.mode === "tui": in --print / --mode json / --mode rpc,
 *     "exit" stays an ordinary prompt (note --print's event.source is also
 *     "interactive" — source alone cannot distinguish; and shutdown is a no-op
 *     in print mode anyway — intercepting would just silently drop the prompt);
 *   - exact whole-line matching, so "exit the loop and print a summary" is
 *     unaffected; messages with attachments (images) also pass through;
 *   - case-insensitive; default exit words: exit / quit / bye.
 *     Overridable: PI_EXIT_WORDS="exit,quit"; "off" disables the extension;
 *   - also registers /exit as an alias of the built-in /quit;
 *   - typing exit while the agent runs: the shutdown defers until idle — the
 *     current turn finishes first.
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
