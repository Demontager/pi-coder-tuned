/**
 * ask-user-question — a Claude Code `AskUserQuestion`-style asking tool for pi.
 *
 * When requirements are unclear, the model stops guessing and calls
 * `ask_user_question`: a questionnaire of up to 4 questions pops up in the
 * terminal (2-4 described options each); ↑↓ picks, Space checks in multi-select,
 * landing on the auto-appended "Type something." row types a free answer, Esc
 * abandons the whole thing; the answers return to the model context as
 * structured text.
 *
 * The **contract** follows `npm:@juicesharp/rpiv-ask-user-question` (the params
 * shape, reserved labels, cancel semantics, removing the tool from the active
 * list on non-interactive hosts, falling back to select/input dialogs on RPC
 * hosts) — the implementation is original, dropping its preview sidebar,
 * per-question/global notes, i18n, overlay collapse, and ~560ms lazy-loaded
 * render graph: this extension uses `ctx.ui.custom()` with a plain-object
 * component (the examples/extensions/question.ts approach) — zero npm
 * dependencies, seven files, all testable logic in pure modules.
 *
 * The module split (`types/validate/answers/dialog/model` deliberately import
 * no pi / pi-tui, so `node --test clients/pi/extensions/ask-user-question/*.test.ts`
 * runs directly; `schema.ts` needs typebox and `view.ts` needs pi-tui — loaded
 * only inside pi's runtime):
 *
 *   types.ts    constants + the data model (single source of truth)
 *   schema.ts   the TypeBox params schema (count limits in schema, length caps
 *               truncated at runtime)
 *   validate.ts line-terminator normalization / single-lining / clipping +
 *               count & reserved-label checks
 *   answers.ts  result → the tool-result envelope for the model (incl. cancel
 *               and error paths)
 *   dialog.ts   the sequential select/input fallback for non-TUI hosts
 *   model.ts    the questionnaire state machine (a pure reducer: tab / cursor /
 *               toggle / submit / cancel)
 *   view.ts     the TUI shell (key decoding + rendering); index.ts registers
 *               the tool/command/reconcile
 *
 * Lives in `~/.pi/agent/extensions/ask-user-question/` (pi auto-discovers the
 * index.ts in a subdirectory) and supports `/reload`.
 * `PI_ASK_USER_QUESTION=off` never installs it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatAnswerScalar, buildResponse, errorResult } from "./answers.ts";
import { hasDialogUI, runDialogQuestionnaire } from "./dialog.ts";
import { normalizeParams, validateQuestionnaire } from "./validate.ts";
import { createQuestionnaireView } from "./view.ts";
import { AskParamsSchema } from "./schema.ts";
import {
	CUSTOM_ANSWER_LABEL,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type AskParams,
	type AskResult,
} from "./types.ts";

/** The tool name (the one identifier reconcile and /ask share). */
export const TOOL_NAME = "ask_user_question";

/**
 * The spinner freezes on this frame while the questionnaire blocks. A full
 * braille char was picked: same family as the default animation frames
 * (⠋⠙…) — it reads as "the spinner stopped", not "something else appeared".
 */
const FROZEN_SPINNER_FRAME = "⠿";

/**
 * Both host-capability error bodies are **written for the model**: they must
 * make clear "the user never saw the questions" — or the model reads a silent
 * failure as the user declining to answer and keeps guessing on its own.
 */
const ERROR_NO_UI =
	"Error: UI not available (running in non-interactive mode) — the user never saw the questions. Ask them as plain chat text instead, without using this tool.";
const ERROR_NO_DIALOG_UI =
	"Error: this client can render neither the questionnaire nor select/input dialogs — the user never saw the questions. Do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.";

const DESCRIPTION = `Ask the user one or more structured questions and wait for the answers. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Every question gets an automatically appended "${CUSTOM_ANSWER_LABEL}" row, so the user can always answer in their own words. Esc abandons the whole questionnaire and you receive "${"User declined to answer the questions"}" — that is a decline to answer, not an answer.
- Each question needs ${MIN_OPTIONS}-${MAX_OPTIONS} options, each with a concise label (1-5 words) and a description of what the choice means or costs.
- Set multiSelect: true when the choices are not mutually exclusive.
- If you recommend an option, put it first and append "(Recommended)" to its label.
- Do NOT author "${CUSTOM_ANSWER_LABEL}" or "Other" option labels — reserved labels are rejected at runtime.
- Group every clarifying question into ONE invocation (up to ${MAX_QUESTIONS}) instead of asking one at a time.`;

const PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;

/**
 * States "how to use it", never "how proactive to be": the asking threshold
 * (what merits interrupting the user) is AGENTS.md's `## Authorization`
 * section's job — not declared here. Before 2026-09-18 this file had a
 * "you cannot proceed" line — narrower than the DESCRIPTION's "Clarify
 * ambiguous instructions", contradicting it in one file while the narrow
 * version was the effective one.
 */
const PROMPT_GUIDELINES: string[] = [
	`Every ask_user_question option needs a concise label (1-5 words) plus a description of what the choice means or costs. Do NOT author "${CUSTOM_ANSWER_LABEL}" or "Other" labels — a free-text row is appended automatically and reserved labels are rejected.`,
	"Set multiSelect: true in ask_user_question when the choices are not mutually exclusive; put a recommended option first with \"(Recommended)\" appended to its label.",
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

/**
 * Run the questionnaire once. TUI takes the custom component; the other modes
 * (RPC / ACP hosts) take the sequential select/input dialogs; neither
 * available → no_dialog_ui.
 *
 * `ctx.ui.custom()` resolving to `undefined` can only mean "the host cannot
 * render custom UI" (a TUI questionnaire always resolves an AskResult — a
 * cancel counts) — so that is not a refusal: fall through to the dialog path.
 *
 * The TUI path **freezes the working-spinner animation** for the wait: the
 * user is being asked, not the model working — a still-spinning animation
 * reads like ongoing reasoning. pi-tui's Loader does not animate a single-
 * frame indicator (`restartAnimation` early-returns on `frames.length <= 1`),
 * and a custom frame is rendered verbatim (no spinnerColorFn), so the accent
 * color is baked in (same tone as the default spinner). On submit/cancel,
 * parameterless `setWorkingIndicator()` restores the default ten-frame
 * animation.
 * The freeze survives the once-per-second working-text refresh:
 * `setWorkingMessage` only rewrites text — it does not rebuild the indicator;
 * even if it did, interactive-mode passes the stored workingIndicatorOptions
 * along. The try/finally restores on answer, cancel, and host fallback
 * alike; while the questionnaire is open the component holds input focus and
 * no new turn can start — the frozen frame cannot leak into the next turn.
 * The local `working-indicator/` extension **does** install its own frame
 * set via `setWorkingIndicator` (the rainbow spinner: ten braille frames in
 * theme colors — see its README), but it only installs on `agent_start`, a
 * changed theme fingerprint, or `ask_user_question`'s `tool_execution_end` —
 * it re-installs the moment the questionnaire ends, so this parameterless
 * restore (back to pi's default ten frames) only covers it briefly; no
 * shared state is needed on either side.
 */
async function runQuestionnaire(ctx: ExtensionContext, params: AskParams) {
	if (ctx.mode !== "tui") {
		if (hasDialogUI(ctx.ui)) return buildResponse(await runDialogQuestionnaire(ctx.ui, params), params);
		return errorResult(ERROR_NO_DIALOG_UI, "no_dialog_ui");
	}

	ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", FROZEN_SPINNER_FRAME)] });
	try {
		const result = await ctx.ui.custom<AskResult | undefined>((tui, theme, _keybindings, done) =>
			createQuestionnaireView(tui, theme, params, done),
		);
		if (result === undefined) {
			if (hasDialogUI(ctx.ui)) return buildResponse(await runDialogQuestionnaire(ctx.ui, params), params);
			return errorResult(ERROR_NO_DIALOG_UI, "no_dialog_ui");
		}
		return buildResponse(result, params);
	} finally {
		ctx.ui.setWorkingIndicator();
	}
}

/**
 * On a non-interactive run (`pi -p` / JSON mode) the tool is removed from the
 * active list — the model never sees it, better than every call failing; an
 * interactive session later (a session swap inside the same process, etc.)
 * adds it back. Idempotent: with the state already right, the active list is
 * untouched (as are other extensions' tools).
 */
function reconcileTool(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const active = pi.getActiveTools();
	const present = active.includes(TOOL_NAME);
	if (!ctx.hasUI && present) {
		pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
	} else if (ctx.hasUI && !present) {
		pi.setActiveTools([...active, TOOL_NAME]);
	}
}

/** /ask's demo questionnaire: one Chinese single-select (exercises CJK wrapping) + one English multi-select (checks and the submit page). */
function demoParams(): AskParams {
	return {
		questions: [
			{
				question: "Which interaction style would you prefer for this questionnaire?",
				header: "Interaction style",
				options: [
					{ label: "Replace editor area (Recommended)", description: "Non-overlay ctx.ui.custom(): questionnaire replaces the editor; simplest implementation and stable rendering" },
					{ label: "Overlay", description: "Float above the conversation; keep the transcript visible, with additional focus/layout handling" },
					{ label: "Sequential dialogs", description: "Native select/input dialogs, one question at a time; no overview page; also used by RPC hosts" },
				],
			},
			{
				question: "Which extra affordances should the questionnaire support?",
				header: "Features",
				multiSelect: true,
				options: [
					{ label: "Option previews", description: "Markdown preview pane rendered beside the option list" },
					{ label: "Per-question notes", description: "Attach a free-text note to any single answer" },
					{ label: "Collapse overlay", description: "Hide the dialog with a key so you can scroll the transcript" },
				],
			},
		],
	};
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_ASK_USER_QUESTION === "off") return;

	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask User Question",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: AskParamsSchema,
		// a blocking UI: it must not run parallel to other tool calls — two popups in one turn would fight for input focus.
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// normalization runs before validation: the reserved-label and duplicate-label checks must see the text the user actually sees.
			const typed = normalizeParams(params as unknown as AskParams);
			if (!ctx.hasUI) return errorResult(ERROR_NO_UI, "no_ui");
			const validation = validateQuestionnaire(typed);
			if (!validation.ok) return errorResult(validation.message, validation.error);
			return runQuestionnaire(ctx, typed);
		},

		renderCall(args, theme) {
			const questions = (args as Partial<AskParams>)?.questions;
			const qs = Array.isArray(questions) ? questions : [];
			let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
			text += theme.fg("muted", qs.length === 1 ? (qs[0]?.question ?? "") : `${qs.length} questions`);
			for (const q of qs) {
				const options = Array.isArray(q?.options) ? q.options : [];
				const labels = options.map((o, i) => `${i + 1}. ${o?.label ?? ""}`);
				labels.push(`${labels.length + 1}. ${CUSTOM_ANSWER_LABEL}`);
				const head = qs.length === 1 ? "" : `[${q?.header ?? ""}] `;
				const multi = q?.multiSelect ? " (multi)" : "";
				text += `\n${theme.fg("dim", `  ${head}${labels.join(" · ")}${multi}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, context) {
			const details = result.details as AskResult | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.error) return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);

			const questions = (context.args as Partial<AskParams>)?.questions;
			const qs = Array.isArray(questions) ? questions : [];
			const lines = details.answers.map((a) => {
				const header = qs[a.questionIndex]?.header || `Q${a.questionIndex + 1}`;
				const answer = a.kind === "custom" ? `✎ ${a.answer ?? ""}` : formatAnswerScalar(a);
				return `${theme.fg("success", "✓")} ${theme.fg("muted", `${header}: `)}${theme.fg("text", answer)}`;
			});
			return new Text(lines.join("\n") || theme.fg("dim", "(no answers)"), 0, 0);
		},
	});

	pi.on("before_agent_start", (_event, ctx) => reconcileTool(pi, ctx));

	// verifying the UI without burning tokens: /ask pops a demo questionnaire (a Chinese single-select + an English multi-select),
	// taking the same runQuestionnaire path as the tool.
	pi.registerCommand("ask", {
		description: "Preview the ask_user_question dialog with a demo questionnaire",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("ask: no UI available in this mode", "warning");
				return;
			}
			const result = await runQuestionnaire(ctx, demoParams());
			const text = result.content[0]?.text ?? "";
			ctx.ui.notify(text.length > 240 ? `${text.slice(0, 240)}…` : text, "info");
		},
	});
}
