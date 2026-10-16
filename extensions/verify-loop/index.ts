/**
 * verify-loop — the verification loop + evaluator, covering the heaviest blank cell from
 * issue #12.
 *
 * ## The problem
 *
 * Change completeness is **self-reported by the model**: the model edits files, says "done,
 * tests pass", and pi ends the turn — nothing in between verifies that sentence.
 * `~/.agents/skills/superpowers/verification-before-completion/` spends a whole document
 * asking the model not to do that ("NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION
 * EVIDENCE"), but text is a prompt — the model can ignore it, and it decays as the
 * conversation grows (exactly why `core-rules/` exists). This extension turns that
 * discipline from a prompt into a gate in code.
 *
 * ## The CC prototype (verified against the official docs: hooks / hooks-guide / goal)
 *
 * **The Stop hook (gate) fires automatically**: on every "Claude finishes responding"; a
 * `{"decision":"block","reason":...}` result prevents finishing, and `reason` is injected
 * as the next round's instruction. Two anti-loop measures: the input carries
 * `stop_hook_active`, and **8 consecutive blocks force a pass**
 * (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). Three hook types: `command` (deterministic script) /
 * `prompt` (one-shot model judgment returning `{ok, reason}`) / `agent` (experimental,
 * a tool-using subagent). abort does not fire Stop; API errors go through `StopFailure`,
 * also not fired.
 *
 * **`/goal` (evaluator) is set manually, then auto-evaluates every turn**: `/goal
 * <condition>` sets it and starts a turn immediately; afterwards each turn end sends "the
 * condition + the conversation so far" to a **small fast model** (default Haiku, **no tool
 * permissions**, "It doesn't run commands or read files independently"). Three verdicts:
 * not met (keep going, reason as guidance) / met (clear and record) / impossible (clear and
 * record the failure). Guardrails: several consecutive no-tool-call turns = no progress →
 * stop the loop, warn, **keep the goal**; a background subagent still running → skip this
 * turn; resume restores the goal but resets turn counting; `/clear`'s new session clears;
 * condition capped at 4000 chars.
 *
 * ## The pi landing spots (source-verified, pi 0.87.1)
 *
 * | CC | pi |
 * |---|---|
 * | `Stop` event | `agent_before_settle` (docs/extensions.md: "the final actionable boundary: it can append entries and request one continuation"; `agent-session.js:1142`) |
 * | `decision:"block"` + `reason` | return `{entries:[{type:"custom_message", display:true, …}], continue:true}` (`extensions/runner.js:662` `emitBoundary` → `_commitBoundaryDrafts` → `appendCustomMessageEntry`) |
 * | reason into the model's context | custom_message at `role:"custom"` → `convertToLlm` maps to `role:"user"` (`messages.js:89`) |
 * | reason visible to the user ("Stop hook feedback") | same entry `display:true` + `registerMessageRenderer` (`interactive-mode.js:3046` only builds a component for custom messages with display true) |
 * | `stop_hook_active` + 8-strike cap | count same-kind injected messages already in the projection (see "why no in-memory counter" below) |
 * | abort / StopFailure routing | `event.outcome !== "completed"` is always skipped (`agent-session.js:333` sets it by stopReason) |
 * | skip evaluation while background work runs | reuse `recap/subagents.ts`'s `hasActiveSubagentWork(pi.events)` (pi-subagents' in-process RPC) |
 * | small fast model evaluator | one standalone `ctx.modelRegistry.complete()` call, no tools (the pattern recap / working-indicator already proved) |
 * | conversation serialization | `serializeConversation(convertToLlm(projected messages))`, both exported from the pi package root |
 * | goal surviving resume | `pi.appendEntry` + `session_start` rebuilt from `getBranch()` (same as simple-task / plan-mode) |
 * | `◎ /goal active` indicator | `ctx.ui.setStatus("verify-goal", …)` |
 *
 * ## Why the counters are read from the projection, not memory
 *
 * `agent_start` fires again **on every boundary continuation** (`emit({type:"agent_start"})`
 * in `runAgentLoopContinue`), so any reset hung on agent_start would zero the count inside
 * the continuation chain and the cap would never work. Counting injected messages from the
 * projection is naturally branch-correct (branches dropped by rewind are absent), still
 * correct after resume, and needs no mutable state. Our injections are `role:"custom"`
 * (not user) so they do not cut the run window — the whole continuation chain shares one
 * window, exactly CC's "consecutive blocks within one turn" semantics.
 *
 * ## The only deliberate deviation from CC
 *
 * CC's hook infrastructure **ships with no hooks installed** (users opt in via
 * settings.json). We have no hook-config layer, so the gate **defaults to block on**, with
 * the trigger narrowed very tight (see gate.ts), plus `PI_VERIFY_LOOP=off|notify|block`
 * for a one-key switch.
 * Rationale: the trigger is deterministic, and the false-positive cost is bounded (at most
 * 2 continuation rounds by default).
 *
 * ## Switches
 *
 *   PI_VERIFY_LOOP=off|notify|block   gate strength, default block
 *   PI_VERIFY_LOOP_CAP=<n>            consecutive-block cap, default 2 (CC's general cap is 8)
 *   PI_VERIFY_PATTERN=strict|<regexp> verification-command recognizer; unset = any bash call
 *                                      counts (see gate.ts "why verification is 'ran a
 *                                      command'"); strict = test/build/lint shapes only
 *   PI_VERIFY_DOC_EXT=.md,.txt        editing these extensions is not a mutation (empty = none excluded)
 *   PI_GOAL_CAP=<n>                   /goal's continuation cap, default 8 (CC's number)
 *   PI_VERIFY_EVALUATOR_MODEL=p/m     the evaluator model; defaults to litellm-any/qwen3.8-flash,
 *                                      then the current session model
 *   PI_GOAL_CONTEXT_CHARS=<n>         the conversation char cap for the evaluator, default 120000
 *   PI_GOAL_TIMEOUT_MS=<n>            evaluation call timeout, default 45000
 *
 * ## Known boundaries (documented — do not fix as bugs)
 *
 * - **Writes inside bash do not count as mutations** (`sed -i` / redirects / scripts editing
 *   files). Lexical judgment does no data-flow analysis — same level as destructive-guard's
 *   rule.
 * - **The evaluator fails open**: call failure / timeout / unparsable verdict → the turn
 *   finishes and a notify fires. CC's hook failure also does not block; the evaluator is an
 *   enhancement and must not stall pi by breaking itself.
 * - **The evaluation call pays for thinking**: this gateway's routes pin
 *   `thinking: {type: enabled}` in `gateway/config.yaml`, which clients cannot turn off
 *   (qwen3.8-flash's `thinkingLevelMap.off` in models.json is null) — measured 3-20s per
 *   call. /goal is a per-session opt-in and the cost is visible.
 * - The gate only looks at **this run** (after the last user message): last turn's test run
 *   cannot vouch for this turn's change (verification-before-completion's iron rule is FRESH
 *   evidence).
 */

import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

import { hasActiveSubagentWork } from "../recap/subagents.ts";
import {
	buildEvaluatorPrompt,
	DEFAULT_CONTEXT_CHARS,
	EVALUATOR_SYSTEM_PROMPT,
	parseVerdict,
} from "./evaluator.ts";
import {
	DEFAULT_DOC_EXTENSIONS,
	DEFAULT_VERIFY_PATTERN,
	decideGate,
	renderGateMessage,
	STRICT_VERIFY_PATTERN,
	VERIFY_LOOP_CUSTOM_TYPE,
	type GateConfig,
	type GateMessage,
	type InjectKind,
} from "./gate.ts";
import {
	applyVerdict,
	clearGoal,
	CLEAR_ALIASES,
	countContinuations,
	decideGoalGate,
	DEFAULT_GOAL_CAP,
	emptyGoal,
	GOAL_ENTRY_TYPE,
	hasGoal,
	renderCapMessage,
	renderHaltMessage,
	renderNotMetMessage,
	renderStatus,
	renderTerminalMessage,
	reconstructGoal,
	setGoal,
	toEntryData,
	type GoalState,
} from "./goal.ts";

/** The evaluation call's timeout (this gateway's routes force thinking — measured 3-20s; a bit wider than recap's 30s). */
const DEFAULT_GOAL_TIMEOUT_MS = 45_000;

/** The default evaluator model: the cheapest tier on this machine (the qoder gateway's Qwen3.8-Flash). */
const DEFAULT_EVALUATOR_SPEC = "litellm-any/qwen3.8-flash";

const STATUS_KEY = "verify-goal";

// =============================================================================
// Config parsing (pure functions, unit-testable)
// =============================================================================

function parseMode(raw: string | undefined): GateConfig["mode"] {
	const value = (raw ?? "").trim().toLowerCase();
	if (value === "off") return "off";
	if (value === "notify") return "notify";
	return "block";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	const value = Number.parseInt((raw ?? "").trim(), 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseDocExtensions(raw: string | undefined): string[] {
	if (raw === undefined) return [...DEFAULT_DOC_EXTENSIONS];
	const list = raw
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter((item) => item !== "");
	return list.map((item) => (item.startsWith(".") ? item : `.${item}`));
}

function parseVerifyPattern(raw: string | undefined): RegExp | undefined {
	const text = (raw ?? "").trim();
	if (text === "") return DEFAULT_VERIFY_PATTERN;
	if (text.toLowerCase() === "strict") return STRICT_VERIFY_PATTERN;
	try {
		return new RegExp(text, "i");
	} catch {
		return DEFAULT_VERIFY_PATTERN;
	}
}

/** Read the gate config from env. Exported for tests. */
export function resolveGateConfig(env: NodeJS.ProcessEnv = process.env): GateConfig {
	return {
		mode: parseMode(env.PI_VERIFY_LOOP),
		verifyPattern: parseVerifyPattern(env.PI_VERIFY_PATTERN),
		docExtensions: parseDocExtensions(env.PI_VERIFY_DOC_EXT),
		blockCap: parsePositiveInt(env.PI_VERIFY_LOOP_CAP, 2),
	};
}

/** Read the goal config from env. Exported for tests. */
export function resolveGoalConfig(env: NodeJS.ProcessEnv = process.env): { cap: number; contextChars: number; timeoutMs: number; modelSpec: string } {
	return {
		cap: parsePositiveInt(env.PI_GOAL_CAP, DEFAULT_GOAL_CAP),
		contextChars: parsePositiveInt(env.PI_GOAL_CONTEXT_CHARS, DEFAULT_CONTEXT_CHARS),
		timeoutMs: parsePositiveInt(env.PI_GOAL_TIMEOUT_MS, DEFAULT_GOAL_TIMEOUT_MS),
		modelSpec: (env.PI_VERIFY_EVALUATOR_MODEL ?? "").trim(),
	};
}

/** Which model the evaluator uses: env-specified → default flash → current session model. */
export function resolveEvaluatorModel(
	ctx: ExtensionContext,
	modelSpec: string,
): NonNullable<ExtensionContext["model"]> | undefined {
	for (const spec of [modelSpec, DEFAULT_EVALUATOR_SPEC]) {
		const slash = spec.indexOf("/");
		if (slash <= 0) continue;
		const found = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
		if (found !== undefined) return found;
	}
	return ctx.model;
}

/** The injected entries' details shape (read by both the renderer and the counters). */
export interface VerifyLoopDetails {
	kind: InjectKind;
	at: number;
}

// =============================================================================
// The extension body
// =============================================================================

export default function verifyLoop(pi: ExtensionAPI): void {
	const gateConfig = resolveGateConfig();
	const goalConfig = resolveGoalConfig();

	let goal: GoalState = emptyGoal();

	function persist(): void {
		pi.appendEntry(GOAL_ENTRY_TYPE, toEntryData(goal));
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, hasGoal(goal) ? "◎ /goal active" : undefined);
		} catch {
			// ctx goes stale after a session swap (docs/extensions.md): losing it is fine — judgment is unaffected.
		}
	}

	// ── Session lifecycle ──────────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		try {
			goal = reconstructGoal(ctx.sessionManager.getBranch() as unknown[]);
		} catch {
			goal = emptyGoal();
		}
		updateStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		goal = emptyGoal();
	});

	// ── Rendering the injected messages (CC's "Stop hook feedback" line) ──────

	pi.registerMessageRenderer<VerifyLoopDetails>(VERIFY_LOOP_CUSTOM_TYPE, (message, { outputPad }, theme) => {
		const kind = message.details?.kind ?? "gate";
		const label =
			kind === "gate"
				? theme.fg("warning", "⚠ verify-loop:")
				: kind === "goal-met"
					? theme.fg("success", "◎ goal achieved:")
					: kind === "goal-impossible"
						? theme.fg("error", "◎ goal impossible:")
						: kind === "goal-halted" || kind === "goal-cap"
							? theme.fg("warning", "◎ goal stopped:")
							: theme.fg("accent", "◎ goal pending:");
		const body = typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n");
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${label}\n${body}`, 0, 0));
		return box;
	});

	// ── The /goal command ──────────────────────────────────────────────────────

	pi.registerCommand("goal", {
		description: "Set a completion condition evaluated by a separate model after each turn (/goal for status, /goal clear to remove)",
		handler: async (args, ctx) => {
			const text = args.trim();

			if (text === "") {
				const messages = ctx.sessionManager.buildContextEntries() as unknown as readonly GateMessage[];
				ctx.ui.notify(renderStatus(goal, Date.now(), goalConfig, countContinuations(messages)), "info");
				return;
			}

			if (CLEAR_ALIASES.has(text.toLowerCase())) {
				if (goal.condition === "") {
					ctx.ui.notify("No /goal set", "info");
					return;
				}
				const cleared = goal.condition;
				goal = clearGoal();
				persist();
				updateStatus(ctx);
				ctx.ui.notify(`Goal cleared: ${cleared}`, "info");
				return;
			}

			goal = setGoal(text, Date.now());
			persist();
			updateStatus(ctx);

			// CC: "Setting a goal starts a turn immediately, with the condition itself
			// as the directive. You don't need to send a separate prompt."
			pi.sendUserMessage(buildGoalDirective(goal.condition), {
				deliverAs: ctx.isIdle() ? undefined : "followUp",
			});
		},
	});

	// ── The boundary: gate first, goal second ──────────────────────────────────

	pi.on("agent_before_settle", async (event: AgentBeforeSettleEvent, ctx) => {
		// CC: abort does not fire Stop; API errors go through StopFailure — neither is gated.
		if (event.outcome !== "completed") return undefined;

		const messages = event.context.contextMessages as unknown as readonly GateMessage[];

		// 1) the deterministic gate (CC's command-type Stop hook)
		const decision = decideGate(messages, gateConfig);
		if (decision.action === "block") {
			const text = renderGateMessage(decision);
			if (gateConfig.mode === "notify") {
				if (ctx.hasUI) ctx.ui.notify(`[verify-loop] ${text.split("\n")[0]}`, "warning");
				return undefined;
			}
			return {
				entries: [...event.entries, customDraft("gate", text)],
				continue: true,
			};
		}

		// 2) goal evaluation (CC's prompt-type Stop hook / /goal)
		if (!hasGoal(goal)) return undefined;

		const gate = decideGoalGate(goal, messages, goalConfig);
		if (gate.action === "none") return undefined;

		if (gate.action === "cap") {
			return { entries: [...event.entries, customDraft("goal-cap", renderCapMessage(goal, goalConfig))] };
		}
		if (gate.action === "halt") {
			return { entries: [...event.entries, customDraft("goal-halted", renderHaltMessage(goal, gate.streak))] };
		}

		// CC: "If a subagent or a background shell command is still running when a turn
		// ends, Claude Code skips the evaluation for that turn."
		if (await subagentsBusy()) return undefined;

		const verdict = await evaluate(ctx, messages, goal.condition);
		if (verdict === undefined) {
			// fail-open: a broken evaluator must not block the turn (CC's hook failure does not block either).
			if (ctx.hasUI) ctx.ui.notify("[verify-loop] /goal evaluation failed; allowing this turn to finish", "warning");
			return undefined;
		}

		goal = applyVerdict(goal, verdict.verdict, verdict.reason);
		persist();
		updateStatus(ctx);

		if (verdict.verdict === "not_met") {
			return {
				entries: [
					...event.entries,
					customDraft("goal-not-met", renderNotMetMessage(goal, verdict.reason, goalConfig, gate.continuations)),
				],
				continue: true,
			};
		}
		const kind: InjectKind = verdict.verdict === "met" ? "goal-met" : "goal-impossible";
		return { entries: [...event.entries, customDraft(kind, renderTerminalMessage(goal, verdict.verdict, verdict.reason))] };
	});

	// ── Internals ──────────────────────────────────────────────────────────────

	function customDraft(kind: InjectKind, text: string) {
		return {
			type: "custom_message" as const,
			customType: VERIFY_LOOP_CUSTOM_TYPE,
			content: text,
			display: true,
			details: { kind, at: Date.now() } satisfies VerifyLoopDetails,
		};
	}

	async function subagentsBusy(): Promise<boolean> {
		try {
			return await hasActiveSubagentWork(pi.events);
		} catch {
			return false;
		}
	}

	async function evaluate(
		ctx: ExtensionContext,
		messages: readonly GateMessage[],
		condition: string,
	): Promise<{ verdict: "met" | "not_met" | "impossible"; reason: string } | undefined> {
		const model = resolveEvaluatorModel(ctx, goalConfig.modelSpec);
		if (model === undefined) return undefined;

		let conversation: string;
		try {
			conversation = serializeConversation(convertToLlm(messages as never));
		} catch {
			return undefined;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), goalConfig.timeoutMs);
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) return undefined;
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: EVALUATOR_SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: buildEvaluatorPrompt(condition, conversation, goalConfig.contextChars) }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: controller.signal,
					maxTokens: 512,
					temperature: 0,
					cacheRetention: "none",
				},
			);
			const text = response.content
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("")
				.trim();
			if (text === "") return undefined;
			return parseVerdict(text);
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	}
}

/** The directive for the turn /goal starts immediately (CC: the condition itself is the directive). */
export function buildGoalDirective(condition: string): string {
	return (
		`/goal completion condition set; work until it is satisfied:

${condition}\n\n` +
		`After each turn, a separate evaluator reads the conversation to determine whether the condition is met. It cannot run commands, ` +
		`so **evidence must appear in your output** (run commands and show their output or file contents).` +
		`Do not stop to await my confirmation before the condition is satisfied.`
	);
}
