/**
 * Prompt-to-settlement timing, displayed before the delayed recap.
 * agent_end is not final: recovery and verification may continue the run.
 * Steering and queued follow-ups belong to the same run until agent_settled.
 * UI only: no inference, session entries, or model-context changes.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const WIDGET_KEY = "stop-hook";
const LABELS = ["Done", "Cooked", "Brewed", "Built", "Baked", "Crafted"];

function duration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	if (hours) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export default function (pi: ExtensionAPI) {
	let startedAt: number | undefined;
	let running = false;
	let toolCalls = 0;
	let stopReason: string | undefined;

	function clear(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		try {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// Session replacement can invalidate the old UI context.
		}
	}

	function reset(_event: unknown, ctx: ExtensionContext): void {
		startedAt = undefined;
		running = false;
		toolCalls = 0;
		stopReason = undefined;
		clear(ctx);
	}

	pi.on("input", (event, ctx) => {
		if (ctx.mode !== "tui" || event.source === "extension") return;
		// A steering message must not erase the work already measured. If an
		// earlier input was handled without running the agent, replace its time.
		if (!running) startedAt = performance.now();
		clear(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || running) return;
		startedAt ??= performance.now();
		running = true;
		toolCalls = 0;
		stopReason = undefined;
		clear(ctx);
	});

	pi.on("tool_execution_start", () => {
		// Count executions, including failed attempts, rather than streamed
		// argument chunks or shell commands nested inside a single bash call.
		if (running) toolCalls += 1;
	});

	pi.on("message_end", (event) => {
		if (running && event.message.role === "assistant") stopReason = event.message.stopReason;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!running || startedAt === undefined) return;
		const elapsed = performance.now() - startedAt;
		const label = stopReason === "aborted" ? "Interrupted"
			: stopReason === "error" ? "Failed"
			: LABELS[Math.floor(Math.random() * LABELS.length)];
		// Pick once at settlement, not during rendering or terminal resizing.
		const text = `${label} in ${duration(elapsed)}. Used ${toolCalls} tool ${toolCalls === 1 ? "call" : "calls"}.`;
		reset(_event, ctx);
		if (ctx.mode !== "tui") return;
		try {
			ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
				render(width: number): string[] {
					if (width < 1) return [];
					const prefix = ` ${theme.fg("accent", "✦")} `;
					if (width <= 3) return [truncateToWidth(prefix, width, ""), ""];
					const lines = wrapTextWithAnsi(theme.fg("dim", text), width - 3)
						.map((line, i) => truncateToWidth((i ? "   " : prefix) + line, width, ""));
					return [...lines, ""];
				},
				invalidate() {},
			}), { placement: "aboveEditor" });
		} catch {
			// A cosmetic widget must never interfere with the agent.
		}
	});

	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("session_shutdown", reset);
}
