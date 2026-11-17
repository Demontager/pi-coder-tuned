/**
 * simple-task — a lightweight task-list extension.
 *
 * Between 2026-09-23 and 2026-09-24 it doubled as plan-mode's execution-phase progress
 * board (approving a plan mirrored its steps here, id = step number, text prefixed
 * `plan: n. `). That mirroring was removed together with plan-mode's execute state:
 * once a plan is approved, progress belongs to the model — it calls `task_set` whenever
 * it wants a list; the extension no longer builds one for it nor reads its state. This
 * extension is now an ordinary task list.
 *
 * Feature set follows @thunstack/pi-task-list (session-scoped, agent-managed, no plan
 * mode needed); the look follows @tintinweb/pi-tasks (● header stats + ◻/◼/✔ symbols +
 * a star spinner + strikethrough on done items).
 *
 * Why write it instead of using the two ready-made ones:
 *   - @tintinweb/pi-task-list is full-featured but heavy (a dozen files + file-locked
 *     store + a pile of options), and its default taskScope writes
 *     `.pi/tasks/tasks-<sessionId>.json` into the working repo — every repo needs a
 *     .gitignore line;
 *   - @thunstack/pi-task-list is light enough, but its style is hardcoded
 *     (☐ ◐ ☑ ⚠ ↷ + 📋 emoji) — changing the style means forking to a local-path
 *     package and maintaining upstream sync yourself.
 *   Writing our own avoids the fork's maintenance burden — the style can change freely.
 *
 * Deliberately kept lightweight:
 *   - three states (pending / in_progress / done); no sections, no dependency graph,
 *     no notes;
 *   - three tools + one command;
 *   - zero npm dependencies: only host-provided pi / pi-tui (peerDependencies);
 *   - **zero file writes**: state hangs on the session log via pi.appendEntry() —
 *     nothing is written into the working repo;
 *   - all colors go through theme.fg(), nothing hardcoded — a pi theme change is a
 *     palette change;
 *   - no task-title length enforcement (pi-task-list's 3–15-word check keeps hurting
 *     short titles).
 *
 * Lives at `~/.pi/agent/extensions/simple-task/` (pi supports a subdirectory form
 * under extensions: drop an index.ts inside — see the placement table in
 * docs/extensions.md), an auto-discovery directory — `/reload` hot-reloads it.
 *
 * Note: never write `extensions/`+asterisk+`/index.ts` globs inside comments — an
 * asterisk right after a slash would close the block comment early and everything
 * after parses as code.
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	cloneState,
	countByStatus,
	describeTasks,
	emptyState,
	isComplete,
	type State,
	type TaskStatus,
} from "./types.ts";
// only buildWidgetLines is imported: GLYPHS is only used by the widget's own rendering — this file no longer touches the glyph table.
import { buildWidgetLines } from "./widget.ts";
import { widgetGaps } from "./gap.ts";

const WIDGET_KEY = "simple-task";
const ENTRY_TYPE = "simple-task-state";
const SPINNER_MS = 150;
const TOOL_NAMES = ["task_set", "task_update", "task_get"] as const;

/** Tool results carry structured state for renderResult's counts. */
interface ToolDetails {
	action: "set" | "update" | "get";
	state: State;
}

const STATUS_VALUES = ["pending", "in_progress", "done"] as const;

export default function simpleTaskExtension(pi: ExtensionAPI): void {
	let state: State = emptyState();
	let enabled = true;
	let frame = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastCtx: ExtensionContext | undefined;

	// ── Persistence ─────────────────────────────────────────────────────────

	/**
 * State hangs on the session log (pi.appendEntry) — no file is ever written.
 * This is the extension's most important design decision: it neither pollutes the
 * working repo nor loses state across a resume.
 */
	function persist(): void {
		pi.appendEntry(ENTRY_TYPE, { state: cloneState(state), enabled, updatedAt: Date.now() });
	}

	/**
 * getBranch(), not getEntries(): branch navigation (rewind to an old message and
 * continue) must follow the current branch — otherwise a discarded branch's task state
 * resurrects.
 * Take the last entry — each is a full snapshot, so the newest is the current state.
 */
	function reconstruct(ctx: ExtensionContext): void {
		state = emptyState();
		enabled = true;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as { state?: State; enabled?: boolean } | undefined;
			if (data?.state) state = cloneState(data.state);
			if (typeof data?.enabled === "boolean") enabled = data.enabled;
		}
	}

	// ── UI ────────────────────────────────────────────────────────────────

	/**
 * The spinner timer only runs while an in-progress task exists.
 * The frame increment happens only here (copied from pi-tasks — its comment explains
 * it well):
 * if the increment lived inside updateUi(), animation speed would track the agent's
 * busyness — spinning fast when busy, freezing when idle.
 */
	function stopTimer(): void {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	function ensureTimer(): void {
		const needsAnimation = enabled && state.tasks.some((task) => task.status === "in_progress");
		if (needsAnimation && timer === undefined) {
			timer = setInterval(() => {
				frame += 1;
				// the timer can outlive the session: touching ctx.ui after it goes stale throws
				// (docs/extensions.md: a captured ctx is stale after session replacement — using it throws),
				// and the throw happens before render, where render's try/catch cannot catch it.
				// so it is guarded here and the timer stopped outright — no ctx, no point animating.
				try {
					updateUi(lastCtx);
				} catch {
					stopTimer();
					lastCtx = undefined;
				}
			}, SPINNER_MS);
		} else if (!needsAnimation) {
			stopTimer();
		}
	}

	function updateUi(ctx?: ExtensionContext): void {
		if (!ctx) return;
		lastCtx = ctx;

		const visible = enabled && state.active && state.tasks.length > 0;
		if (!visible) {
			// ctx may already be stale (session ended / reload / session switch) — the ctx.ui getter throws.
			// swallow it — the UI was going away anyway; nothing to render.
			try {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			} catch {
				/* ctx is dead */
			}
			ensureTimer();
			return;
		}

		// snapshot + re-register every time: the factory closes over the snapshot (state cannot mutate mid-render),
		// while `frame` is mutable and read at render time — that is why the spinner spins.
		const snapshot = cloneState(state);
		try {
			ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				// self-reference: at render time the component needs its own identity to locate itself inside the above-editor widget container —
				// that is how it knows whether other widgets (pi-subagents's async block, the recap…) still sit above/below
				// and pads a blank row accordingly. Details and rationale in gap.ts's file header.
				const component = {
					render(width: number): string[] {
						// a render exception must never escape and crash the host process — worst case, this widget's frame is empty.
						// pi-tasks has the same guard; its comment gives the reason.
						try {
							const lines = buildWidgetLines(snapshot, frame, theme, width);
							if (lines.length === 0) return lines;
							const gaps = widgetGaps(tui, component, width);
							if (gaps.above) lines.unshift("");
							if (gaps.below) lines.push("");
							return lines;
						} catch {
							return [];
						}
					},
					invalidate() {},
				};
				return component;
			});
		} catch {
			stopTimer();
			lastCtx = undefined;
			return;
		}
		ensureTimer();
	}

	function setState(next: State, ctx?: ExtensionContext): void {
		state = cloneState(next);
		persist();
		updateUi(ctx);
	}

	function details(action: ToolDetails["action"]): ToolDetails {
		return { action, state: cloneState(state) };
	}

	function assertEnabled(): void {
		if (!enabled) throw new Error("Task tracking is disabled for this session. Use /tasks on to re-enable.");
	}

	// ── Tools ───────────────────────────────────────────────────────────────

	// all three tools carry `renderShell: "self"`: pi stops wrapping the block in `contentBox`
	// (tool-execution.js's `Box(1, 1, bgFn)`) — so
	//   ① **no background** (pending's `toolPendingBg` / success's `toolSuccessBg` /
	//      failure's `toolErrorBg` are all skipped — selfRenderContainer is a plain Container,
	//      `renderContainer instanceof Box` is false, and bgFn cannot attach),
	//   ② **no top/bottom border rows and no left/right padding** (all drawn by that Box).
	// same look as the bash (bash-command-collapse.ts) / read (read-path-collapse.ts) blocks:
	// above the block only pi self-mode's fixed blank row remains (`lines.push("")` in render()); below, it hugs
	// the next message. The Text returned by renderCall / renderResult is `new Text(…, 1, 0)`:
	// **paddingX = 1** restores the one-column left margin the default `Box(1, 1)` shell used to give — each line leads with a space,
	// not flush-left (user 2026-09-26); **paddingY = 0** keeps no blank rows above/below; no bgFn, so no Box wrap.
	pi.registerTool({
		name: "task_set",
		label: "Task Set",
		renderShell: "self",
		description:
			"Create or replace the session task list for multi-step work. Pass an empty array to clear the list.",
		promptSnippet: "Create or replace the session task list.",
		promptGuidelines: [
			"Use task_set for 3+ meaningful steps, multiple files or phases, debugging/research loops, validation passes, or when the user asks for progress tracking.",
			"Do not use task_set for simple Q&A, quick explanations, or one or two obvious actions.",
			"When the objective changes or the current list is obsolete, replace it with task_set instead of appending forever.",
			"Mark progress with task_update rather than writing done markers in prose.",
		],
		parameters: Type.Object({
			tasks: Type.Array(Type.String({ description: "Short actionable task label" }), {
				description: "Ordered task list items; an empty array clears the list",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			assertEnabled();
			const raw = Array.isArray(params?.tasks) ? params.tasks : [];
			// only whitespace and empty strings are filtered — no word-count validation; pi-task-list's 3–15-word rule keeps hurting short titles.
			const texts = raw.map((item) => String(item).trim()).filter((text) => text.length > 0);

			if (texts.length === 0) {
				setState(emptyState(), ctx);
				return {
					content: [{ type: "text" as const, text: "Task list cleared." }],
					details: details("set"),
				};
			}

			setState(
				{
					active: true,
					nextId: texts.length + 1,
					tasks: texts.map((text, index) => ({ id: index + 1, text, status: "pending" as TaskStatus })),
				},
				ctx,
			);
			return {
				content: [{ type: "text" as const, text: `Task list set with ${texts.length} task(s).` }],
				details: details("set"),
			};
		},
		renderCall(args, theme) {
			const count = Array.isArray(args?.tasks) ? args.tasks.length : 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("task_set ")) + theme.fg("muted", `${count} task(s)`),
				1,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const data = result.details as ToolDetails | undefined;
			const count = data?.state.tasks.length ?? 0;
			const text = count === 0 ? "Task list cleared." : `Task list ready: ${count} task(s)`;
			return new Text(theme.fg("success", "✔ ") + theme.fg("muted", text), 1, 0);
		},
	});

	pi.registerTool({
		name: "task_update",
		label: "Task Update",
		renderShell: "self",
		description: "Update the status of one task in the active task list.",
		promptSnippet: "Update one task's status in the active task list.",
		promptGuidelines: [
			"Use task_update immediately when starting or finishing a tracked task.",
			"Prefer marking a task in_progress before starting and done when it finishes — that is what drives the spinner. The order is not enforced, so a direct pending → done is tolerated rather than corrected.",
			"Prefer task_update over text-only done markers whenever a task list is active.",
		],
		parameters: Type.Object({
			id: Type.Number({ description: "Task ID to update" }),
			status: Type.Union(STATUS_VALUES.map((value) => Type.Literal(value)), {
				description: "New status: pending, in_progress, or done",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			assertEnabled();
			if (!state.active || state.tasks.length === 0) throw new Error("No active task list. Call task_set first.");
			const task = state.tasks.find((item) => item.id === params.id);
			if (!task) throw new Error(`Task #${params.id} not found.`);

			const next = cloneState(state);
			const target = next.tasks.find((item) => item.id === params.id);
			if (target) target.status = params.status as TaskStatus;

			setState(next, ctx);
			const completeText = isComplete(state) ? " All tasks are now complete." : "";
			return {
				content: [{ type: "text" as const, text: `Task #${params.id} → ${params.status}.${completeText}` }],
				details: details("update"),
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("task_update ")) +
					theme.fg("muted", `#${args?.id ?? "?"} → ${args?.status ?? "?"}`),
				1,
				0,
			);
		},
		renderResult(result, _options, theme) {
			// a content element may be ImageContent — its type must be checked before reading text
			const first = result?.content?.[0];
			const text =
				first && "text" in first && typeof first.text === "string" ? first.text : "updated";
			return new Text(theme.fg("success", "✔ ") + theme.fg("muted", text), 1, 0);
		},
	});

	pi.registerTool({
		name: "task_get",
		label: "Task Get",
		renderShell: "self",
		description: "Read the active task list with current statuses.",
		promptSnippet: "Read the active task list.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			assertEnabled();
			const lines = describeTasks(state);
			const text = lines.length === 0 ? "No active task list." : lines.join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: details("get"),
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("task_get")), 1, 0);
		},
		renderResult(result, _options, theme) {
			const data = result.details as ToolDetails | undefined;
			const count = data?.state.tasks.length ?? 0;
			const { done } = data ? countByStatus(data.state) : { done: 0 };
			return new Text(
				theme.fg("success", "✔ ") + theme.fg("muted", count === 0 ? "No active task list" : `${done}/${count} done`),
				1,
				0,
			);
		},
	});

	// ── Command ─────────────────────────────────────────────────────────────

	async function handleTasksCommand(args: string, ctx: ExtensionContext): Promise<void> {
		lastCtx = ctx;
		const sub = args.trim().toLowerCase();

		if (sub === "off" || sub === "on") {
			enabled = sub === "on";
			persist();
			updateUi(ctx);
			ctx.ui.notify(enabled ? "Task tracking enabled." : "Task tracking disabled for this session.", "info");
			return;
		}

		if (sub === "clear") {
			setState(emptyState(), ctx);
			ctx.ui.notify("Task list cleared.", "info");
			return;
		}

		// the default (incl. "status" and no args): print the current list
		if (!enabled) {
			ctx.ui.notify("Task tracking is disabled. Use /tasks on to re-enable.", "info");
			return;
		}
		const lines = describeTasks(state);
		if (lines.length === 0) {
			ctx.ui.notify("No active task list.", "info");
			return;
		}
		const { done, inProgress, pending } = countByStatus(state);
		ctx.ui.notify(
			`${state.tasks.length} task(s) — ${done} done, ${inProgress} in progress, ${pending} open\n${lines.join("\n")}`,
			"info",
		);
	}

	pi.registerCommand("tasks", {
		description: "Show or manage the task list — /tasks [status|clear|on|off]",
		handler: async (args, ctx) => handleTasksCommand(args, ctx),
	});

	// ── Events ──────────────────────────────────────────────────────────────

	/**
 * The timer must stop the moment the session ends — the spinner timer would keep
 * ticking past it, and by then lastCtx is dead: reading ctx.ui throws.
 * docs/extensions.md explicitly asks to "register an idempotent session_shutdown
 * handler that closes any session-scoped resource you started" — this setInterval is
 * such a resource.
 */
	pi.on("session_shutdown", async () => {
		stopTimer();
	});

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		reconstruct(ctx);
		updateUi(ctx);
	});

	// after branch navigation the state must be rebuilt — a discarded branch's state would resurrect otherwise
	pi.on("session_tree", async (_event, ctx) => {
		reconstruct(ctx);
		updateUi(ctx);
	});

	// on compaction, a fully-done list is cleared — the next batch of work starts clean
	pi.on("session_before_compact", async (_event, ctx) => {
		if (isComplete(state)) setState(emptyState(), ctx);
	});

	/**
 * Before each turn, inject the current list into the context (display: false —
 * not shown in the TUI), so the model knows what is done and need not guess.
 *
 * Fix: Don't inject when all tasks are complete — completed state creates
 * a strong "everything is done" pattern that can overshadow new instructions
 * in the same turn, causing the model to summarize instead of acting.
 */
	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!enabled || !state.active || state.tasks.length === 0) return;
		if (isComplete(state)) return;
		const lines = describeTasks(state);
		return {
			message: {
				customType: "simple-task-context",
				content: `Current task list (update statuses with task_update as you progress):\n${lines.join("\n")}`,
				display: false,
			},
		};
	});
}
