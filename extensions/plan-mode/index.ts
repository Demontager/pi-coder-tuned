/**
 * pi-plan-mode — a Claude Code-style plan mode.
 *
 * Two states: bypass → plan (read-only exploration; the model produces a plan). Aligned with
 * Claude Code:
 *
 *   - `exit_plan_mode`'s argument is **a complete plan text** (same shape as cc's
 *     `ExitPlanMode(plan)`), not a list of structured steps.
 *   - **There is no execute state after approval**: the extension turns the plan into a plan
 *     document (`.pi/plans/`, written by the model itself), then returns straight to bypass
 *     and restores write access — "implement per the document" is handed to the model as a
 *     one-shot instruction. Progress also goes back to the model: if it wants a task list it
 *     calls `task_set` itself; the extension no longer mirrors steps or tracks progress.
 *
 * ## The approval dialog (three choices)
 *
 *   Write plan and implement  the model writes the plan to .pi/plans/<date>-<slug>.md; on write
 *                            success it wraps up automatically and enters implementation
 *   Write plan only           same, but the wrap-up instruction is "report the path and stop —
 *                            do not implement"
 *   Request changes           stays in plan state, waiting for user feedback before resubmitting
 *
 * Both approval routes pass through **the doc-writing sub-state** (`docWriting`; phase stays
 * plan): `write` alone returns to the tool set, but the `tool_call` hook pins it to the plan
 * document's path; the `tool_result` hook sees that write succeed and wraps up automatically
 * (the model does not need to call exit_plan_mode a second time).
 *
 * ## Entry points
 *
 *   shift+tab      toggles mode (normal ⇄ plan). pi reserved it for the built-in
 *                  app.thinking.cycle and the extension cannot take it (the runner skips
 *                  registerShortcut calls that conflict with a built-in), so it is intercepted
 *                  through ctx.ui.onTerminalInput **before** the key reaches the editor and
 *                  consumed there. The cost is the thinking-level cycle key being swallowed, so
 *                  on first start this extension rebinds app.thinking.cycle to ctrl+shift+t in
 *                  ~/.pi/agent/keybindings.json (only while that key still holds pi's default;
 *                  a user's own config is respected).
 *   /plan          manual toggle (equivalent to shift+tab)
 *   /plan-status   show the current state
 *   --plan         start in plan mode
 *   auto-enter     an enter_plan_mode tool is registered — the model calls it when it judges
 *                  the task to be big; that is Claude Code's mechanism (not a keyword
 *                  heuristic). The routing criteria live entirely in this tool's description
 *                  (CC-isomorphic: its system prompt contains not a single plan rule) and
 *                  global AGENTS.md keeps only a pointer. The model path also passes a
 *                  **user-consent dialog** (CC's "must consent to entering plan mode"): the
 *                  user can pick "implement directly" to decline, so the criteria can afford
 *                  to be loose — a false positive costs one keypress, not a wasted round.
 *                  PI_PLAN_MODE_CONSENT=off disables that dialog.
 *
 * ## Constraints (tool removal + bash interception — two independent gates)
 *
 *   1. Tool set: entering plan removes edit / write / powershell from the active tools;
 *      exiting restores the **exact** pre-entry snapshot. The local pi's tool table carries
 *      twenty-plus dynamically registered extension tools — a hardcoded whitelist would eat
 *      them all, so snapshot-and-restore is the only safe option. The doc-writing sub-state
 *      puts write back alone (`planModeToolSet(active, true)`).
 *   2. tool_call hook: write-class bash (redirects / rm / git commit / npm install …) is
 *      blocked whether or not it is in the tool table; inside the doc-writing sub-state write
 *      may only target the plan document's one path. The refusal reason goes back to the
 *      model as a tool-error result. See plan.ts for the judgment details.
 *
 * This is a guardrail for a cooperating model, not a sandbox — see plan.ts's file header for
 * the trade-off.
 *
 * ## Plan persistence
 *
 * State lives in `pi.appendEntry("plan-mode")` (never enters the model context); the plan
 * document lands in the workspace's `.pi/plans/` (gitignored — plans are process artifacts).
 * Nothing else is added to the workspace.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	type PlanDocMode,
	type PlanState,
	cancelPlan,
	completeDocWrite,
	enterDocWriting,
	enterPlan,
	initialPlanState,
	inspectBashCommand,
	planModeToolSet,
	rejectPlan,
	restoredToolSet,
	submitPlan,
} from "./plan.ts";
import {
	buildDocWriteContext,
	buildDocWrittenMessage,
	buildPlanModeContext,
	buildRejectedMessage,
	truncatePlanForDialog,
} from "./plan-text.ts";
import { buildPlanDocPath } from "./plan-doc.ts";
import { STATUS_KEY, formatPlanStatus } from "./render.ts";
import { THINKING_FALLBACK_KEY, keybindingsPath, rebindThinkingKey } from "./keybinding.ts";

/** Turn the whole extension off. */
const DISABLED = (process.env.PI_PLAN_MODE ?? "").trim().toLowerCase() === "off";
/** Turn off only auto-enter (shift+tab and /plan still work). */
const AUTO_DISABLED = (process.env.PI_PLAN_MODE_AUTO ?? "").trim().toLowerCase() === "off";
/** Turn off the consent dialog before a model-initiated enter (back to "a call enters directly"). */
const CONSENT_DISABLED = (process.env.PI_PLAN_MODE_CONSENT ?? "").trim().toLowerCase() === "off";

const ENTER_TOOL = "enter_plan_mode";
const EXIT_TOOL = "exit_plan_mode";
/** The custom-entry type holding the persisted state in the session. */
const ENTRY_TYPE = "plan-mode";

/** The approval dialog's three choices (order = default-selection order; first is the recommended route). */
const CHOICE_EXECUTE = "Write plan and implement";
const CHOICE_DOC_ONLY = "Write plan only";
const CHOICE_REJECT = "Request changes";

/**
 * The consent dialog's two choices (first = default selection = accept the model's request).
 *
 * This is Claude Code's mechanism: its `EnterPlanMode` is `shouldDefer: true`, its description
 * says "This tool REQUIRES user approval - they must consent to entering plan mode", and the
 * dialog is `Yes, enter plan mode` / `No, start implementing now`. Precisely because every
 * entry requires a nod, CC can afford loose criteria (it even keeps "err on the side of
 * planning") — the dialog absorbs the cost of false positives.
 * Without that dialog, loose criteria become pure noise (measured: 15.5% of user instructions
 * entered plan).
 */
const CONSENT_PLAN = "Enter plan mode (read-only exploration)";
const CONSENT_IMPL = "Implement directly";

/**
 * `enter_plan_mode`'s tool description = the entire routing criteria.
 *
 * The criteria live only here; global AGENTS.md keeps just a pointer (Claude Code-isomorphic:
 * its system prompt has no plan rules at all — 7 positive conditions + 4 exemptions +
 * GOOD/BAD examples all sit in the tool description). That way the criteria are right in
 * front of the model at the moment it decides whether to call, and they cannot drift away
 * from AGENTS.md. Structure follows CC: when to use (7) / when not to use (4 exemptions) /
 * examples / notes.
 */
const ENTER_TOOL_DESCRIPTION = `Enter plan mode (read-only exploration): explain the design, wait for approval, then implement.

## When to use
Use for nontrivial implementation work involving any of:
1. Meaningful new features whose placement, behavior, or error handling is undecided.
2. Multiple substantially different approaches (Redis/memory/file caching; WS/SSE/polling).
3. Changes to existing behavior or structure with an undecided target design.
4. Architectural or technology tradeoffs.
5. Changes across more than 2-3 files.
6. Unclear requirements requiring exploration, profiling, or root-cause analysis.
7. User preferences determining the approach: enter plan mode first, explore, then ask informed questions.

## When not to use
Skip for small one/two-line fixes, a well-specified single function, detailed unambiguous user instructions, or pure research/exploration/review producing conclusions rather than changes.

## Examples
Use for authentication, database optimization, dark themes, or adding a profile deletion button that needs UI/API/error-handling decisions. Skip for README typos, a console.log, or identifying routing files.

## Notes
- Requires user consent. The dialog allows Implement directly instead.
- User-initiated shift+tab, /plan, or --plan needs no further consent.
- If brainstorming has not happened, read the brainstorming skill's SKILL.md from the available-skills list and follow it: clarify requirements and present 2-3 options with tradeoffs. In plan mode, do not write docs/superpowers/specs/ or commit: writes are blocked. exit_plan_mode submits the design and saves the approved plan under .pi/plans/. Use ask_user_question for clarification.`;

interface PersistedState {
	phase: PlanState["phase"];
	pending?: string;
	toolsBeforePlan?: string[];
	docMode?: PlanDocMode;
	docWriting?: boolean;
	pendingDocPath?: string;
	planSummary?: string;
}

/**
 * Collapse a persisted entry's phase into the current union; anything unrecognizable counts
 * as `"bypass"`.
 *
 * A whitelist check backstops every historical value: the 2026-09-23 rename `normal` →
 * `bypass`, and the `execute` state deleted on 2026-09-24 (restored from an old session it
 * becomes bypass — that approval left no extension-held state behind, so letting it through
 * loses nothing).
 */
function normalizePhase(value: unknown): PlanState["phase"] {
	return value === "plan" ? "plan" : "bypass";
}

/** The persisted entry's docMode gets the same whitelist collapse: unrecognizable = never chosen. */
function normalizeDocMode(value: unknown): PlanDocMode | undefined {
	return value === "execute-with-doc" || value === "doc-only" ? value : undefined;
}

/** The persisted entry's pending: before 2026-09-24 it was a step array; only strings are accepted now (old plans are dropped). */
function normalizePending(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export default function planMode(pi: ExtensionAPI) {
	if (DISABLED) return;

	const state: PlanState = initialPlanState();
	/** The most recent ctx: the onTerminalInput callback receives none, and shift+tab needs one. */
	let currentCtx: ExtensionContext | undefined;
	/** The old ctx goes stale during session replacement (/clear, /new, /resume); render failures are always swallowed. */
	let restoreInProgress = false;
	/** Do not steal keys while pi's own dialog is open — hand them to the dialog. */
	let dialogOpen = false;
	let thinkingKeyChecked = false;
	/** Unsubscribe function for the shift+tab raw-input listener (reentrancy guard; see attachInputListener). */
	let inputUnsubscribe: (() => void) | null = null;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// =========================================================================
	// Rendering
	// =========================================================================

	function render(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, formatPlanStatus(ctx.ui.theme, state));
		} catch {
			// inside the session-replace window the ctx may already be invalidated by pi. Rendering is best-effort and must never kill the process
			// (the local user-message-bar extension hit the same hole — the cost was pi exiting outright).
		}
	}

	// =========================================================================
	// Persistence (session entries only)
	// =========================================================================

	function persist(): void {
		const payload: PersistedState = {
			phase: state.phase,
			pending: state.pending,
			toolsBeforePlan: state.toolsBeforePlan,
			docMode: state.docMode,
			docWriting: state.docWriting,
			pendingDocPath: state.pendingDocPath,
			planSummary: state.planSummary,
		};
		pi.appendEntry(ENTRY_TYPE, payload);
	}

	/**
 * Only the newest record **on the current branch** counts.
 *
 * Uses getBranch() rather than getEntries(): the latter returns **all** entries
 * (`session-manager.js`'s `fileEntries.filter(...)`), including branches discarded by rewind /
 * fork / branch navigation — using it would resurrect a plan that is no longer on any branch
 * at the next start. pi's docs/extensions.md also requires getBranch() for rebuilding
 * branch-sensitive state.
 */
	function restore(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getBranch();
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index] as { type?: string; customType?: string; data?: PersistedState };
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !entry.data) continue;
			state.phase = normalizePhase(entry.data.phase);
			state.pending = normalizePending(entry.data.pending);
			state.toolsBeforePlan = entry.data.toolsBeforePlan;
			state.docMode = normalizeDocMode(entry.data.docMode);
			state.docWriting = entry.data.docWriting === true ? true : undefined;
			state.pendingDocPath = typeof entry.data.pendingDocPath === "string" ? entry.data.pendingDocPath : undefined;
			state.planSummary = typeof entry.data.planSummary === "string" ? entry.data.planSummary : undefined;
			break;
		}
		// after a plan-state restore the tool set must shrink with it (the tool set itself is not in the session entry; recomputed from the current table).
		// inside the doc-writing sub-state write must be present.
		if (state.phase === "plan") {
			if (!state.toolsBeforePlan) state.toolsBeforePlan = pi.getActiveTools();
			pi.setActiveTools(planToolSet(state.toolsBeforePlan, state.docWriting === true));
		}
	}

	// =========================================================================
	// State transitions
	// =========================================================================

	/**
 * The active tools during plan: pi's write tools plus the now-useless enter_plan_mode are
 * removed.
 * `allowWrite` is the doc-writing sub-state's switch: write alone is put back (its path still
 * pinned by the tool_call hook).
 */
	function planToolSet(active: readonly string[], allowWrite = false): string[] {
		return planModeToolSet(active, allowWrite).filter((name) => name !== ENTER_TOOL);
	}

	function enter(ctx: ExtensionContext | undefined, reason: "user" | "model"): void {
		if (state.phase === "plan") return;
		// the snapshot must be taken **before** removing tools — the exit restores from it verbatim (incl. twenty-plus extension tools)
		const before = pi.getActiveTools();
		Object.assign(state, enterPlan(state, before));
		pi.setActiveTools(planToolSet(before));
		persist();
		render(ctx);
		if (ctx?.hasUI) {
			ctx.ui.notify(
				reason === "model"
					? "Entered plan mode (read-only) because this task needs planning. Press shift+tab to exit anytime."
					: "Entered plan mode: read-only exploration; the model will propose a design first. Toggle with shift+tab.",
				"info",
			);
		}
	}

	function leave(ctx: ExtensionContext | undefined, notify = true): void {
		const tools = restoredToolSet(state, pi.getActiveTools());
		Object.assign(state, cancelPlan(state));
		pi.setActiveTools(tools);
		persist();
		render(ctx);
		if (notify && ctx?.hasUI) ctx.ui.notify("Exited plan mode; write access restored.", "info");
	}

	function toggle(ctx: ExtensionContext | undefined): void {
		if (state.phase === "bypass") enter(ctx, "user");
		else leave(ctx);
	}

	// =========================================================================
	// shift+tab interception
	// =========================================================================

	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		dialogOpen = false;
		restoreInProgress = true;
		try {
			restore(ctx);
		} finally {
			restoreInProgress = false;
		}
		attachInputListener(ctx);

		if (pi.getFlag("plan") === true && state.phase !== "plan") enter(ctx, "user");
		render(ctx);

		if (!thinkingKeyChecked && (event.reason === "startup" || event.reason === "reload")) {
			thinkingKeyChecked = true;
			ensureThinkingKeyRebound(ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		currentCtx = undefined;
		inputUnsubscribe?.();
		inputUnsubscribe = null;
	});

	/**
 * shift+tab is intercepted here **before** it reaches the editor.
 *
 * It is consumed only when "TUI + idle + no extension dialog + not inside a session-switch
 * window": pi's own pickers (/model, /sessions …) eat shift+tab themselves, and stealing it
 * would leave the user unable to switch options inside a dialog. While busy (streaming) it is
 * not stolen either — pi's thinking-level cycle works as usual. Deliberate: plan mode only
 * toggles when you are standing still.
 *
 * The reentrancy guard matters: `session_start` runs once each for `/reload`, `/new`,
 * `/resume`; one listener added per run would make a single shift+tab toggle twice (a
 * no-op). pi clears old listeners via `clearExtensionTerminalInputListeners()` on session
 * switch, but `/reload` does not guarantee it — so the previous listener is unsubscribed
 * here first.
 */
	function attachInputListener(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		inputUnsubscribe?.();
		inputUnsubscribe = null;
			try {
			inputUnsubscribe = ctx.ui.onTerminalInput((data) => {
				// must use pi's own matchesKey — **never** hand-roll `data !== "\x1b[Z"`:
				// shift+tab has three encodings — bare CSI (`\x1b[Z`), the Kitty keyboard protocol's CSI-u
				// (`\x1b[9;2u` and friends), and xterm modifyOtherKeys. pi proactively enables the Kitty
				// protocol at startup (`terminal.js` sends `\x1b[>{flags}u\x1b[?u\x1b[c` and awaits the reply),
				// and once enabled a real terminal stops sending `\x1b[Z` — a hardcoded compare goes fully dead
				// (hit for real: worked in a pty, no response to shift+tab in a real Ghostty).
				if (!matchesKey(data, "shift+tab")) return undefined;
				const current = currentCtx;
				if (!current || current.mode !== "tui") return undefined;
				if (dialogOpen || restoreInProgress) return undefined;
				if (!current.isIdle()) return undefined;
				toggle(current);
				return { consume: true };
			});
		} catch {
			// the host has no raw-input channel: shift+tab is unavailable, /plan still works
		}
	}

	pi.on("ui_prompt_start", async () => {
		dialogOpen = true;
	});
	pi.on("ui_prompt_end", async () => {
		dialogOpen = false;
	});

	// =========================================================================
	// Commands
	// =========================================================================

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration → approval → write plan document)",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			toggle(ctx);
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show plan mode status",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			if (state.phase === "bypass") {
				ctx.ui.notify("plan mode: bypass (inactive)", "info");
				return;
			}
			const lines: string[] = [];
			if (state.docWriting) {
				lines.push(`plan mode: plan (writing document)`);
				lines.push(`Target document: ${state.pendingDocPath ?? "(path unavailable)"}`);
			} else {
				lines.push("plan mode: plan (read-only exploration)");
			}
			if (state.pending) {
				const first = state.pending.split("\n").find((line) => line.trim() !== "") ?? "";
				lines.push(`Plan awaiting approval: ${first.trim().slice(0, 60)} (total: ${state.pending.split("\n").length} lines)`);
			}
			if (state.planSummary) lines.push(`Summary: ${state.planSummary}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// =========================================================================
	// Auto-enter: the model tool
	// =========================================================================

	if (!AUTO_DISABLED) {
		pi.registerTool({
			name: ENTER_TOOL,
			label: "Enter Plan Mode",
			description: ENTER_TOOL_DESCRIPTION,
			parameters: Type.Object({
				reason: Type.Optional(Type.String({ description: "Why this task needs planning first (one sentence)" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				currentCtx = ctx;
				const reason = typeof params.reason === "string" && params.reason.trim() !== "" ? params.reason.trim() : "";
				// the consent dialog exists only on the model path: shift+tab / /plan / --plan go through enter(ctx, "user"),
				// which is already the user's own decision — asking again is pure noise. No UI (pi -p) means nobody to bother,
				// so no dialog there either — headless behavior stays as before.
				if (ctx.hasUI && !CONSENT_DISABLED) {
					const choice = await ctx.ui.select(
						`The model requests plan mode (read-only exploration).${reason ? `

Reason: ${reason}` : ""}\n\n` +
							`${CONSENT_PLAN}: explore read-only and propose a design; implementation starts only after your approval
` +
							`${CONSENT_IMPL}: skip planning and implement your instructions now`,
						[CONSENT_PLAN, CONSENT_IMPL],
					);
					// esc (undefined) counts as a decline, matching CC's "must consent" —
					// the most common path ("too lazy, just implement") costs a single key.
					if (choice !== CONSENT_PLAN) {
						ctx.ui.notify("Skipped plan mode; implementing directly.", "info");
						return {
							content: [
								{
									type: "text",
									text: `The user chose direct implementation, without entering plan mode. Follow the user's instructions now; do not call again: ${ENTER_TOOL}.`,
								},
							],
							details: { phase: state.phase, consented: false },
						};
					}
				}
				enter(ctx, "model");
				return {
					content: [
						{
							type: "text",
							text: `Entered plan mode (read-only). ${reason ? `Reason: ${reason}.` : ""}
edit / write are disabled; Bash writes are blocked. Read the code first; use ask_user_question for decisions that need user input. When the design is ready, call ${EXIT_TOOL} to submit.`,
						},
					],
					details: { phase: state.phase, consented: true },
				};
			},
		});
	}

	// the only exit from plan phase: submit the plan for user approval
	pi.registerTool({
		name: EXIT_TOOL,
		label: "Submit Plan",
		description:
			"Submit the design for user approval in plan mode. Do not modify files before calling. The user can approve implementation or request further planning.",
		parameters: Type.Object({
			plan: Type.String({
				description:
					"Complete user-facing design (Markdown): problem, current state and constraints, planned files and changes, and verification. Do not provide only step headings.",
			}),
			slug: Type.String({
				description:
					"Plan filename slug: 3-5 lowercase English words, digits, and hyphens, e.g. m5-entity-runtime or plan-doc-english-slug. Avoid Chinese, spaces, and punctuation; they are stripped, with plan as fallback. Filename: <date>-<slug>.md.",
			}),
			summary: Type.Optional(Type.String({ description: "One-sentence design summary" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;
			if (state.phase !== "plan") {
				return {
					content: [{ type: "text", text: `Not in plan mode (current: ${state.phase}); no plan submission is needed.` }],
					details: { accepted: false, phase: state.phase },
				};
			}
			if (state.docWriting) {
				return {
					content: [
						{
							type: "text",
							text: `Currently writing the plan document: use the write tool to save it to \`${state.pendingDocPath}\`. The extension finishes this phase after a successful write; do not call again: ${EXIT_TOOL}.`,
						},
					],
					details: { accepted: false, phase: state.phase, docWriting: true },
				};
			}

			const plan = typeof params.plan === "string" ? params.plan.trim() : "";
			if (plan === "") {
				return {
					content: [{ type: "text", text: "The plan is empty. Submit a complete design: problem, files to change, and verification." }],
					details: { accepted: false, phase: state.phase },
				};
			}
			const summary = typeof params.summary === "string" && params.summary.trim() !== "" ? params.summary.trim() : undefined;
			// slug feeds the document name; when the model forgets it, fall back to summary (if the cleaned summary is all-CJK it still lands on `plan`).
			const slug = typeof params.slug === "string" && params.slug.trim() !== "" ? params.slug.trim() : summary;

			Object.assign(state, submitPlan(state, plan, summary));
			persist();
			render(ctx);

			// the confirm/select dialog is a non-scrollable Text, and the main-screen render pins the viewport to the bottom —
			// a long plan is guaranteed unreadable in full. It is clipped to one screen; the clipped part still reached the terminal buffer, and the user
			// can scroll back for the full text (repaints are frozen during the dialog).
			const dialogPlan = truncatePlanForDialog(
				plan,
				{
					rows: process.stdout.rows || Number(process.env.LINES) || 24,
					columns: process.stdout.columns || 80,
				},
				wrapTextWithAnsi,
			);
			// a non-interactive run (`pi -p`) has no dialog to show: auto-take the recommended route (write doc + implement),
			// better than a deadlock — the model already finished planning, and stalling here wastes the whole run.
			const choice = ctx.hasUI
				? await ctx.ui.select(`Approve this plan?

${dialogPlan}`, [CHOICE_EXECUTE, CHOICE_DOC_ONLY, CHOICE_REJECT])
				: CHOICE_EXECUTE;

			if (choice === undefined || choice === CHOICE_REJECT) {
				Object.assign(state, rejectPlan(state));
				persist();
				render(ctx);
				return {
					content: [{ type: "text", text: buildRejectedMessage() }],
					details: { accepted: false, phase: state.phase },
				};
			}

			const docMode: PlanDocMode = choice === CHOICE_DOC_ONLY ? "doc-only" : "execute-with-doc";
			// the path is computed and pinned at the moment the user picks a route: the name-collision check asks the filesystem,
			// and a later recompute could yield a different -2 suffix — then the model would write to a different file.
			const docPath = buildPlanDocPath({ cwd: ctx.cwd, slug, exists: existsSync });
			Object.assign(state, enterDocWriting(state, docMode, docPath));
			// put write back (the other write tools stay removed); its target path is pinned by the tool_call hook.
			if (!state.toolsBeforePlan) state.toolsBeforePlan = pi.getActiveTools();
			pi.setActiveTools(planToolSet(state.toolsBeforePlan, true));
			persist();
			render(ctx);
			return {
				content: [
					{
						type: "text",
						text: `The user approved the plan and selected '${choice}'. Use the write tool to save the plan document to \`${docPath}\` — the only file writable in this phase. After a successful write, the extension finishes this phase and provides the next instructions; do not call again: ${EXIT_TOOL}.`,
					},
				],
				details: { accepted: true, docMode, docPath },
			};
		},
	});

	// =========================================================================
	// per-round context injection + write interception
	// =========================================================================

	pi.on("before_agent_start", async (_event, ctx) => {
		currentCtx = ctx;
		if (state.phase !== "plan") return undefined;
		// re-shrink every round: the model may have just called enter_plan_mode, and another extension may have touched the tool table
		if (!state.toolsBeforePlan) state.toolsBeforePlan = pi.getActiveTools();
		pi.setActiveTools(planToolSet(state.toolsBeforePlan, state.docWriting === true));
		if (state.docWriting && state.pendingDocPath) {
			return {
				message: {
					customType: "plan-doc-write-context",
					content: buildDocWriteContext(state.pendingDocPath, state.pending ?? "", state.planSummary),
					display: false,
				},
			};
		}
		return {
			message: {
				customType: "plan-mode-context",
				content: buildPlanModeContext(ctx.cwd),
				display: false,
			},
		};
	});

	/**
 * The second gate: write-class bash is always blocked; inside the doc-writing sub-state write
 * may only target the plan document's one path.
 * The tools removed from the table are edit / write / powershell (the sub-state restores
 * write); bash stays, so this hook is the thing that actually stops `echo x > f` /
 * `git commit` / `npm install`.
 * The refusal reason goes back to the model as a tool-error result — the only feedback it
 * ever sees.
 */
	pi.on("tool_call", async (event, ctx) => {
		if (state.phase !== "plan") return undefined;

		if (event.toolName === "write") {
			// outside the sub-state write is not in the tool table at all — this is a belt-and-suspenders check
			if (!state.docWriting) {
				return {
					block: true,
					reason: `Files cannot be written during planning. Explain the design and submit it using ${EXIT_TOOL}, then wait for user approval.`,
				};
			}
			const target = typeof event.input.path === "string" ? event.input.path : "";
			if (resolve(ctx.cwd, target) !== state.pendingDocPath) {
				return {
					block: true,
					reason: `Only the plan document may be written in this phase: requested target is \`${resolve(ctx.cwd, target)}\`, but the plan document path is \`${state.pendingDocPath}\`. Write to the latter; wait for this phase to finish and write access to be restored before changing other files.`,
				};
			}
			return undefined;
		}

		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		const verdict = inspectBashCommand(command);
		if (verdict.ok) return undefined;
		return {
			block: true,
			reason: `${verdict.reason}
Currently in plan mode (read-only): explain the design and submit it using ${EXIT_TOOL}; write access returns after user approval.`,
		};
	});

	/**
 * The doc-writing sub-state's auto wrap-up: the instant the model's write of the plan document
 * succeeds, the state returns to bypass, the tool set is restored, and the wrap-up instruction
 * (implement / report-path-only) **replaces** write's normal success text — the model sees
 * what to do next in the same round, without calling any more tools.
 *
 * The check is strictly triple: write tool + success + the path is exactly the pinned one. A
 * failed write (isError) does not wrap up — the model sees the error and retries itself.
 */
	pi.on("tool_result", async (event, ctx) => {
		currentCtx = ctx;
		if (state.phase !== "plan" || !state.docWriting) return undefined;
		if (event.toolName !== "write" || event.isError) return undefined;
		const target = typeof event.input.path === "string" ? event.input.path : "";
		if (resolve(ctx.cwd, target) !== state.pendingDocPath) return undefined;

		const outcome = completeDocWrite(state);
		if (!outcome) return undefined;
		// the restore needs the snapshot from the old state — it must be read before Object.assign
		const tools = restoredToolSet(state, pi.getActiveTools());
		Object.assign(state, outcome.state);
		pi.setActiveTools(tools);
		persist();
		render(ctx);
		if (ctx.hasUI) ctx.ui.notify(`Plan document saved: ${outcome.docPath}`, "info");
		return {
			content: [{ type: "text", text: buildDocWrittenMessage(outcome.docMode, outcome.docPath) }],
		};
	});

	// back in bypass, stale plan context is filtered out of the model's context (it should not see outdated instructions)
	pi.on("context", async (event) => {
		if (state.phase !== "bypass") return undefined;
		return {
			messages: event.messages.filter((message) => {
				const type = (message as { customType?: string }).customType;
				return type !== "plan-mode-context" && type !== "plan-doc-write-context";
			}),
		};
	});
}

// =============================================================================
// Thinking-key rebinding
// =============================================================================

/**
 * At startup, ensure the thinking cycle has yielded its key; failures notify without throwing
 * and are not retried.
 *
 * Three cases:
 *   - the config already binds to the fallback (written by this extension, or by the user) → **fully silent**
 *   - bound to another key (the user's own choice) → **fully silent**, respect the user config
 *   - no binding at all → write the fallback and notify once
 *   - the config file is not valid JSON (unreadable, dare not touch) → tell the user to handle it manually
 */
function ensureThinkingKeyRebound(ctx: ExtensionContext): void {
	const path = keybindingsPath();
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		raw = "";
	}

	const { value, outcome } = rebindThinkingKey(raw, path);
	if (!outcome.changed) {
		// already bound (by anyone) → silent. Only "config is broken and we dare not touch it" warrants a warning.
		if (outcome.needsAttention === true && ctx.hasUI) {
			ctx.ui.notify(
				`Plan mode uses shift+tab, but automatic remapping failed (${outcome.reason}). Manually remap app.thinking.cycle to ${THINKING_FALLBACK_KEY} (${path}).`,
				"warning",
			);
		}
		return;
	}

	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, value, "utf8");
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Plan mode uses shift+tab; thinking-level cycling was remapped to ${THINKING_FALLBACK_KEY} (${path}; takes effect after /reload)`,
				"info",
			);
		}
	} catch {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Plan mode uses shift+tab. In ${path}, remap app.thinking.cycle to ${THINKING_FALLBACK_KEY}.`,
				"warning",
			);
		}
	}
}
