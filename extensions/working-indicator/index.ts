/**
 * working-indicator.ts — semantic working spinner text + elapsed-seconds display + trailing `●`
 * while bash executes
 *
 * pi's built-in working loader shows only a fixed "Working" during streaming — you cannot tell
 * what it is doing or how long it has been running. This extension replaces it via
 * `ctx.ui.setWorkingMessage()` with state-aware text plus a per-second elapsed counter at the tail.
 *
 * Text rules:
 *   bash tool          → Tools Calling (↓ N tokens · D)
 *   edit tool          → Editing         (↓ N tokens · D)
 *   write tool         → Writing         (↓ N tokens · D)
 *   read tool          → Reading         (↓ N tokens · D)
 *   model thinking     → Thinking        (↓ N tokens · D)
 *   everything else    → Working         (D)
 *   (unknown tools included)
 *
 * Colors: **the label takes the body color (normal white); the stats segment after it keeps pi's
 * default muted gray**. See `formatWorkingMessage`'s comment — colors must be spliced into the
 * message string itself, because pi colors "the whole message" and offers no per-segment entry.
 *
 * Duration format: under 60s → `42s`; 60s+ → `1m 23s`; 1h+ → `1h 23m 32s`.
 *
 * Token accounting: `↓ N tokens` is **the current small segment's output**, not a per-turn
 * accumulation. Each thinking segment (`thinking_start`) and each tool-argument segment
 * (`toolcall_start`) restarts at 0 — otherwise a turn running several tools would show an
 * ever-climbing number and "how big this bash command is" would be invisible. Implementation
 * keeps per-segment counters (one for thinking, one for tool args); the displayed number follows
 * the current label: `Thinking` shows the thinking counter, `Tools Calling` / `Editing` /
 * `Writing` / `Reading` show the tool-args counter. Text segments (`text_delta`) deliberately
 * are not counted: they never display, and accumulating them would only pollute later segments.
 *
 * Four implementation premises established by measurement (all verified):
 *   1. **`usage.output` stays 0 during streaming** (probe: thinking_start / toolcall_start /
 *      several text_delta points all 0), so the token count can only be estimated from
 *      streamed characters, never read from usage.
 *   2. **`toolcall_start`'s `partial.content[contentIndex].name` already carries the tool
 *      name** (probe saw `block.type=toolCall block.name=bash`), so the tool state can show
 *      while args still stream — no waiting for `tool_execution_start`.
 *   3. No existing extension uses `setWorkingMessage` / `setWorkingIndicator` (grep: 0 hits;
 *      `setStatus` is only used by simple-task / cwd-statusline in the footer), so there is
 *      no same-name override conflict.
 *   4. **`toolcall_checkpoint` is not in the event union extensions see** — pi-ai's
 *      `AssistantMessageEvent` only has start / text_* / thinking_* / toolcall_{start,delta,end}
 *      / done / error; checkpoint is a `MessageFrame` used inside the TUI / session encoder,
 *      downstream of the event stream. So every arg delta reaches the extension as
 *      `toolcall_delta`, and per-segment counting is already complete — no catch-up segment
 *      is needed for resumed sessions (adding one would double-count deltas).
 *
 * Duration accounting: seconds are a **turn-level** clock (from `agent_start`), not per
 * activity. That way `Working (42s)` and `Tools Calling (… · 42s)` show the same number and
 * never snap back to 0 on a state switch — resetting the clock per activity would destroy the
 * "how long this turn has taken" meaning. **Token counts are the opposite — per-segment**:
 * duration answers "how long the turn ran", tokens answer "how much this segment produced" —
 * deliberately different scopes.
 *
 * There is also a **right-aligned prompt summary** at the row tail (layout computed by
 * `working-summary.ts`): the current turn's user input **flattened to one line**, leading
 * characters kept, truncated with `…` when too long — like
 *
 *     ⠧ Working (23s)                        ✦ /init I want to optimize…
 *
 * meant to remind you "what this round is actually doing" during a long task. The flattening
 * rules live in `flattenPrompt`: multi-line folds into one sentence (join spacing decided by
 * both sides' characters; no space at a CJK break), indents / tabs / space runs collapse,
 * ANSI escapes and zero-width chars are stripped, Markdown layout noise (list bullets /
 * quotes / headings / code-fence marker lines) removed — truncation applies to the whole
 * text, not just the first line. Points worth noting:
 *   - The prompt is captured on `input` ("Fired when user input is received, before agent
 *     processing"): a normal message is the user's verbatim text, a skill / template command is
 *     the raw command line before expansion. **Extension commands (e.g. /init) are the
 *     exception** — pi consumes the raw command line before the `input` event
 *     (`agent-session.prompt()` runs `_tryExecuteExtensionCommand` first and returns on a hit),
 *     so the only text the extension sees is what the command handler sends via
 *     `sendUserMessage`; /init therefore shows the flattened leading chars of its constructed
 *     prompt, not "/init …".
 *   - Flattening is computed **once and cached** in `input` (`promptText`), not recomputed per
 *     refresh — refresh runs on every streaming delta and a tens-of-KB paste cannot be rescanned
 *     each time.
 *   - Mid-stream steer / followUp also fire `input`, updating the summary to the newest
 *     instruction.
 *   - **A long prompt asynchronously asks the model for a one-line summary** (decision / prompt
 *     / cleanup in `summary-request.ts`; this file only sends the request and guards the
 *     reply): when the flattened original exceeds the available width × `PI_WORKING_SUMMARY_TRIGGER`
 *     (default 1, i.e. request whenever it does not fit), a target column count is computed
 *     from the **same available width** and the model is asked to state "what this prompt does"
 *     in one line. The request runs parallel to the main round — no `await`, no render path
 *     blocked; on arrival it replaces the original text; on absence / timeout / error / empty
 *     reply the truncated original keeps showing, and after `PI_WORKING_SUMMARY_RETRY_MS`
 *     (default 3s) it is **retried once** — at most two requests per prompt, then it gives up
 *     (a new prompt / turn end cancels the pending retry). An overlong reply is never asked
 *     again: truncate by visible width (re-asking would only make the cell jump). The
 *     *flattened* original is what gets measured (unlike the old implementation that looked
 *     only at the first line) — whenever the whole thing exceeds the threshold it requests,
 *     so a multi-line pasted prompt gets a summary too.
 *     Cost: this machine's gateway **hard-codes thinking** into these model routes
 *     (`thinking: {type: enabled}` + `reasoning_effort: max` in `extra_body`, not client-
 *     switchable), so every request carries thinking: measured 3-20s and 600-1400 thinking
 *     tokens. Defaults to the current session model; for cheaper/faster use
 *     `PI_WORKING_SUMMARY_MODEL=provider/modelId`, or `PI_WORKING_SUMMARY_LLM=off` to disable.
 *   - Right-alignment works by "filling the row's visible width to exactly the budget": pi's
 *     working message goes through Text's word-wrap, which emits a verbatim single line only
 *     when not overlong (see working-summary.ts header). Budget = terminal columns − 4
 *     (spinner "⠧ " 2 cols + Text paddingX 1 each side); the terminal width is re-read via
 *     `process.stdout.columns` each refresh, so resize self-heals on the next 1s tick.
 *   - The summary segment has its own **whole-segment cap = half the terminal width**
 *     (`floor(cols / 2)`, `✦ ` prefix included): no matter how much room remains on a wide
 *     terminal, the summary never exceeds half the screen, so a long prompt cannot squeeze the
 *     status text to a few columns; headroom freed by the cap folds into the gap, right-
 *     alignment unchanged. The request's target length uses the same
 *     `availableSummaryTextWidth`, so "how long the model should write" and "how many columns
 *     can actually show" share one math.
 *   - Exact only for the **standalone spinner row** (statusContainer). If the working
 *     indicator is embedded in the editor's top border (built-in editor's embedWorkingStatus
 *     mode; the local prompt-editor.ts does not enable embedding, so the standalone row is
 *     used), the border renderer clips the overlong part and the summary degrades gracefully
 *     to not shown (wrapping happens at the gap's spaces; row 1 remains the original text) —
 *     a half summary is never rendered.
 *   - Colors: `✦` uses syntaxKeyword (the syntax-highlight keyword color — prominent but not
 *     harsh in every theme); the summary body uses muted (same as the stats segment, no
 *     attention fight with the label).
 *   - Switches: `PI_WORKING_SUMMARY=off` disables the whole summary; `PI_WORKING_SUMMARY_LLM=off`
 *     disables only the model compression (falls back to "flatten + truncate");
 *     `PI_WORKING_SUMMARY_TRIGGER=<n>` tunes the trigger ratio (default 1 = request whenever
 *     it does not fit; larger tolerates truncation first — see `SUMMARY_TRIGGER_RATIO`);
 *     `PI_WORKING_SUMMARY_MODEL=provider/modelId` picks the summary model (defaults to the
 *     session model; a cheap fast model also works — the summary is only a side request);
 *     `PI_WORKING_SUMMARY_GAP=<n>` tunes the minimum gap between left segment and summary
 *     (default 1 column; under right-alignment the actual gap is usually far larger — this
 *     value is only the narrow-terminal floor).
 *
 * ## Spinner rainbow frames (`spinner-frames.ts`)
 *
 * pi's working spinner is ten braille frames in one accent color. This extension replaces it
 * with **the same braille family cycling a palette**: accent → success → warning →
 * syntaxKeyword → toolDiffAdded → toolDiffRemoved → toolTitle, each color ≈1.5s (19 frames ×
 * 80ms = 1520ms; 1500ms is not a multiple of 80ms so the nearest, 19 frames, is used — 1.3%
 * off; evolved 400ms → 800ms → 1520ms per the requirement's pace), and rotation speed identical
 * to pi's default (same ten braille frames, same 80ms interval) — so it looks like "the familiar
 * spinner, just changing colors".
 *
 * The frame table can only have colors **pre-baked**: `ctx.ui.setWorkingIndicator({ frames })`
 * renders custom frames verbatim (pi's Loader skips `spinnerColorFn` when
 * `renderIndicatorVerbatim` is true), so the frame string must carry its own color. Hence the
 * table must be reinstalled after a theme change — `refresh()` compares the palette fingerprint
 * while reading the theme each second (stable within one theme, guaranteed to change on skin
 * swap) and reinstalls only then (a reinstall resets the animation phase, so it must not run
 * blindly inside every tick).
 * How the table is laid out, how colliding color slots dedupe, and how monochrome themes
 * degrade are all in `spinner-frames.ts`'s header comment (pure module, 12 `node --test` cases).
 *
 * Three moments the table gets installed:
 *   - `agent_start`: the turn begins and the spinner has not rendered yet, so the phase reset
 *     is invisible; it also covers both "last turn's indicator was displaced by
 *     `ask_user_question`" and "pi's `resetExtensionUI()` on session replace restored the
 *     default frames".
 *   - the fingerprint check inside `refresh()`: self-heals within a second of `/theme`.
 *   - `tool_execution_end` of `ask_user_question`: that extension freezes the spinner to a
 *     single frame (⠿) during its questionnaire, and its no-arg `setWorkingIndicator()` on
 *     exit restores **pi's default frames** (it does not know about this extension's rainbow
 *     frames) — so reinstall right when the questionnaire ends, or the rest of the turn drops
 *     back to monochrome.
 *
 * The seven slots may collide under the current theme (measured on pi-coder-summer-night:
 * success == toolDiffAdded, warning == toolTitle); colliders keep only one. If only one color
 * survives (monochrome theme / `NO_COLOR` / identity `fg`), no table is installed at all — pi's
 * default spinner stays, since an "animation" whose every frame looks identical is pointless.
 * Switches: `PI_SPINNER_RAINBOW=off` returns to monochrome accent; `PI_SPINNER_COLOR_HOLD=<frames>`
 * tunes how long each color lasts (default 19 frames ≈ 1.5s; 1 = every frame, a strobe at 80ms,
 * not a rainbow).
 *
 * ## Bash-executing `●` (working line tail)
 *
 * Requirement verbatim: hang `●` after `⠼ Tools Calling (13m 59s)` — appears once a bash
 * execution exceeds 1 second, disappears when execution ends; while multiple bashes run, it
 * blinks as soon as any crosses 1s and disappears only after **all** finish. This is a
 * relocation of the retired bash first-row `$ ` → `● ` spinner (the command block no longer
 * shows `●`): same contract as the old version — 1s threshold, 500ms lit/dark cadence,
 * `PI_BASH_SPINNER=off` disables.
 *
 * Implementation splits in two: pure logic in the sibling module `bash-spinner.ts` (shape /
 * threshold / concurrency registry, imports no pi — `node --test` cases in
 * `bash-spinner.test.ts`), timers here in `index.ts`:
 *   - `tool_execution_start` (toolName=bash) books in, `tool_execution_end` books out, keyed
 *     by `toolCallId` — parallel bashes supported naturally;
 *   - every `refresh()` runs `driveBashSpinner(now)`: threshold crossed → run the 500ms cadence
 *     (flip phase + repaint); not yet → arm a one-shot timer at the **earliest** execution's
 *     deadline so `●` appears exactly on time (a non-streaming command may see no upstream
 *     events while executing — without self-driving it would never repaint);
 *   - the marker segment is spliced at the end of the left segment (label + stats), before the
 *     summary layout, always 2 columns (lit `" ●"` / dark two spaces) — so the right-aligned
 *     prompt summary never bounces with the blink;
 *   - stopping happens in three places: `agent_settled` / `session_shutdown` (turn end,
 *     session replace), the stale-ctx path's try/catch (`stopActivity`), and the `refresh()`
 *     early-return branch (not inside a turn).
 *   - One labeling fix rides along: `executingTool` changed from a single string to a
 *     `toolCallId → toolName` Map — in a parallel batch the tool that finishes first no longer
 *     clears the name of one still running (otherwise a long bash's `●` would hang after
 *     `Working` instead of `Tools Calling`). The label still takes the last-started tool —
 *     the priority semantics are unchanged.
 *
 * ## Turn-end marker `✻ Churned for 3m 37s · done 11:52 PM` (turn-marker.ts)
 *
 * User decision 2026-10-07: when a round finishes, the spinner simply vanished leaving no
 * trace — it should be replaced in place by a static end marker. The text / word list / clock
 * all live in `turn-marker.ts` (one of ten words picked at random, 12-hour `11:52 PM`, the
 * whole row in dim — same tier as the `Recap:` label in the recap line; pure module, tests in
 * `turn-marker.test.ts`); this file only owns timing and placement:
 *   - Placement is **the widget area above the editor** (same area as the recap summary / task
 *     list), not the old statusContainer: pi calls `clearStatusIndicator("working")` at the
 *     app layer's `agent_end`, and `setWorkingMessage` / `setWorkingVisible` only work during
 *     streaming — there is no API for a statusContainer render outside a turn. The row count
 *     stays identical: with the spinner, the stretch above the editor is "blank + text + blank"
 *     (it carries one leading blank, and the lower blank is the widget area's leading blank);
 *     the marker slot is likewise three rows — the widget area's leading blank + the marker +
 *     **a trailing blank the component itself supplies** (user 2026-10-07: the marker must
 *     have a blank below it, same as when the spinner was there) — so the editor does not
 *     shift up one row.
 *   - Timing: `agent_settled` (the real end of a turn — `agent_end` can still be followed by
 *     auto-retry / compaction / queued follow-ups). Duration = wall clock from `agent_start`
 *     to `agent_settled`, reusing the spinner's own `formatDuration` — the end duration never
 *     disagrees with the spinner's last frame.
 *   - Only normal completion counts: the outcome is recorded at `agent_before_settle`
 *     (`agent_settled` carries no payload); `aborted` / `error` draw nothing — ESC
 *     interruption keeps its current behavior, the spinner simply vanishes.
 *   - Cleanup: `agent_start` (the next turn gives the slot back to the spinner),
 *     `session_shutdown`; pi's `resetExtensionUI()` also clears extension widgets on
 *     session replace.
 *   - Switch: `PI_TURN_MARKER=off`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	BASH_SPINNER_BLINK_MS,
	BASH_SPINNER_COLOR,
	BashRunTracker,
	bashSpinnerSuffix,
} from "./bash-spinner.ts";
import {
	DEFAULT_MIN_GAP,
	SUMMARY_MARKER,
	availableSummaryTextWidth,
	flattenPrompt,
	layoutPromptSummary,
} from "./working-summary.ts";
import {
	DEFAULT_FRAMES_PER_COLOR,
	SPINNER_INTERVAL_MS,
	buildSpinnerPalette,
	type SpinnerPalette,
} from "./spinner-frames.ts";
import {
	DEFAULT_TRIGGER_RATIO,
	buildSummaryRequestPrompt,
	cleanSummaryText,
	planSummaryRequest,
} from "./summary-request.ts";
import {
	TURN_MARKER_WIDGET_KEY,
	formatEndClock,
	formatTurnMarker,
	pickTurnVerb,
} from "./turn-marker.ts";

/** Tool name → label. Unlisted tools all fall back to Working (per the requirement, "everything else shows Working"). */
const TOOL_LABELS: Record<string, string> = {
	bash: "Tools Calling",
	edit: "Editing",
	write: "Writing",
	read: "Reading",
};

const THINKING_LABEL = "Thinking";
const DEFAULT_LABEL = "Working";
/**
 * The questionnaire tool's name (registered by the `ask-user-question/` extension). It freezes
 * the working indicator to a single frame during its questionnaire and restores pi's **default**
 * frames with a no-arg call on exit (see the file header "spinner rainbow frames"), so this
 * extension must reinstall its rainbow frames when it ends.
 */
const ASK_USER_QUESTION_TOOL = "ask_user_question";

/**
 * During dialogs the spinner freezes on this frame (same family as the `ask-user-question`
 * extension's — the full-block braille char, reading as "spinner paused" rather than a different
 * thing). pi-tui's Loader does not animate a single-frame indicator, so a frozen frame = the
 * 80ms repaint stopped.
 */
const FROZEN_SPINNER_FRAME = "⠿";

/**
 * The message's two color segments. The label uses `text` (normal body color — pale white on
 * dark themes); the stats segment uses `muted` — **the same slot** as pi's default color for
 * the whole working message, so that gray stretch renders identically to before (only the
 * escape's position changed: instead of wrapping the whole message once, the stats segment
 * carries its own prefix).
 */
const LABEL_COLOR = "text";
const STATS_COLOR = "muted";
/** The summary marker `✦`'s color: the syntax-highlight keyword color — a visual anchor at the row tail. */
const SUMMARY_MARKER_COLOR = "syntaxKeyword";

/**
 * Columns eaten by the spinner ("⠧ " = 2 cols) + the Text component's paddingX (1 each side):
 * the working message's visible-width budget = terminal columns − 4 (see file header).
 */
const SPINNER_AND_PADDING_COLUMNS = 4;

const SUMMARY_ENABLED = (process.env.PI_WORKING_SUMMARY ?? "").toLowerCase() !== "off";
/**
 * Switch for asking the model to compress an overlong prompt into one line (`PI_WORKING_SUMMARY_LLM=off`
 * falls back to "truncate only").
 * With `PI_WORKING_SUMMARY=off` the whole summary is hidden and no request is needed either.
 */
const SUMMARY_LLM_ENABLED = SUMMARY_ENABLED && (process.env.PI_WORKING_SUMMARY_LLM ?? "").toLowerCase() !== "off";
/**
 * How many times the available width the flattened prompt must exceed before a summary is
 * requested (`PI_WORKING_SUMMARY_TRIGGER`, default 1).
 * 1 = request whenever it does not fit (even one column over); larger values tolerate
 * truncation first: 1.2 ≈ compress only when nearly a fifth of the original is lost, 2 = more
 * than half. Values below 1 are meaningless (fall back to default).
 */
const SUMMARY_TRIGGER_RATIO = (() => {
	const parsed = Number.parseFloat(process.env.PI_WORKING_SUMMARY_TRIGGER ?? "");
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_TRIGGER_RATIO;
})();
/**
 * Which model serves the summary request (`PI_WORKING_SUMMARY_MODEL=provider/modelId`, e.g.
 * `litellm-any/deepseek-flash`).
 * Falls back to the current session model when unset / unresolvable — the summary is only a
 * side request and must not vanish over a misconfig.
 */
const SUMMARY_MODEL_SPEC = (process.env.PI_WORKING_SUMMARY_MODEL ?? "").trim();
/** Hard timeout for the summary request, aborted when reached. This machine's routes all force thinking, so one "compress to a line" takes 3-20s measured (qwen3.8-flash is slow on the max tier) — a bit wider than recap's 30s; a turn end also aborts early (nobody is watching by then). A timeout only wastes one request and does not affect the main task. */
const SUMMARY_TIMEOUT_MS = 45_000;
/** Default retry delay after a failed summary request (`PI_WORKING_SUMMARY_RETRY_MS` overrides). */
const DEFAULT_SUMMARY_RETRY_DELAY_MS = 3_000;
/**
 * How long to wait before retrying a failed first request (`PI_WORKING_SUMMARY_RETRY_MS`,
 * default 3s; 0 = retry immediately).
 * Failure is usually a one-off blip (upstream 5xx / connection cut / only thinking, no body)
 * and a second ask a few seconds later often succeeds; **only this one retry** (see
 * `SUMMARY_MAX_ATTEMPTS`).
 */
const SUMMARY_RETRY_DELAY_MS = (() => {
	const raw = (process.env.PI_WORKING_SUMMARY_RETRY_MS ?? "").trim();
	if (raw === "") return DEFAULT_SUMMARY_RETRY_DELAY_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SUMMARY_RETRY_DELAY_MS;
})();
/** Max attempts per summary request: first try + one retry; a second failure gives up for good. */
const SUMMARY_MAX_ATTEMPTS = 2;
/**
 * maxTokens for the summary request. **Must leave thinking its share**: this machine's gateway
 * forces `thinking: {type: enabled}` + `reasoning_effort: max` on these routes
 * (`extra_body` in `gateway/config.yaml`), unswitchable by the client; measured 600-1400
 * thinking tokens for one "compress to a line", and a small budget gets eaten entirely by
 * thinking with zero body left (measured 80 / 512 / 2048 all consumed).
 * 1024 reliably leaves body room on deepseek-flash / qwen3.8-flash / deepseek-flash-qd.
 *
 * Also: **do not pass `temperature: 0`** — these max-tier routes degenerate into unstoppable
 * long thinking at 0 (2048 fully eaten with zero body), while default temperature returns
 * normally in 3s.
 */
const SUMMARY_MAX_TOKENS = 1024;
/**
 * Headroom for "how wide the left segment (label + stats + `●`) is", used only when computing
 * the request's target length.
 * The request fires in `input` — the turn has not started and no real left segment exists, so
 * a conservative estimate is used: the longest tool-execution label (`Tools Calling (↓ N
 * tokens · D)`) plus the trailing `●`. On wide terminals the half-screen cap dominates anyway;
 * the estimate only matters on narrow terminals, where underestimating would clip the summary.
 */
const SUMMARY_LEFT_WIDTH_ESTIMATE = 34;
/**
 * Switch for the bash-executing `●`. The env name inherits the retired bash first-row spinner
 * (`PI_BASH_SPINNER`): the feature only moved its landing spot from the command block to the
 * working line's tail.
 */
const BASH_SPINNER_ENABLED = (process.env.PI_BASH_SPINNER ?? "").toLowerCase() !== "off";
/**
 * Rainbow spinner switch (`PI_SPINNER_RAINBOW=off` returns to pi's default monochrome accent
 * ten-frame).
 */
const SPINNER_RAINBOW_ENABLED = (process.env.PI_SPINNER_RAINBOW ?? "").toLowerCase() !== "off";
/**
 * Turn-end marker switch (`PI_TURN_MARKER=off` disables — back to "spinner simply vanishes at
 * turn end").
 * Shape / word list / 12-hour clock all live in `turn-marker.ts`.
 */
const TURN_MARKER_ENABLED = (process.env.PI_TURN_MARKER ?? "").toLowerCase() !== "off";
/**
 * The marker's color slot: `dim`, same tier as the `Recap:` label in the recap line (user
 * 2026-10-07). The whole row (including the leading `✻`) is one color segment, so one slot.
 */
const TURN_MARKER_COLOR = "dim";
/**
 * Watchdog hint switch (`PI_WORKING_INDICATOR_WATCHDOG=off` disables). With it off, the
 * spinner keeps showing plain Working during watchdog review — no special hint.
 */
const WATCHDOG_HINT_ENABLED = (process.env.PI_WORKING_INDICATOR_WATCHDOG ?? "").toLowerCase() !== "off";
/**
 * The text shown during watchdog review (user-specified, English, no duration/ellipsis).
 */
export const WATCHDOG_LABEL = "Subagent watchdog reviewing";
/**
 * How long after `agent_end` without a settle counts as "something is blocking" → switch to the
 * watchdog label.
 *
 * Rationale: pi-subagents' watchdog runs an independent model review inside `agent_end` on
 * **every turn that touched the repo** (measured 7~17s), and pi waits for all `agent_end`
 * handlers before clearing the spinner — so the spinner keeps spinning unexplained that whole
 * time. A normal turn's `agent_end` → `agent_settled` is millisecond-scale, so a 2s threshold
 * cannot false-positive; the only other thing that blocks that window is auto-compaction,
 * backstopped by the `session_before_compact` cancel (below). `PI_WORKING_INDICATOR_WATCHDOG_DELAY_MS`
 * overrides (for tests).
 */
export const DEFAULT_WATCHDOG_DELAY_MS = 2_000;
export const WATCHDOG_DELAY_MS = (() => {
	const raw = (process.env.PI_WORKING_INDICATOR_WATCHDOG_DELAY_MS ?? "").trim();
	if (raw === "") return DEFAULT_WATCHDOG_DELAY_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_WATCHDOG_DELAY_MS;
})();
/**
 * How many **frames** each rainbow color lasts (`PI_SPINNER_COLOR_HOLD`, default 19 frames ×
 * 80ms = 1520ms ≈ one color change per 1.5s; 1500ms is not a multiple of 80ms so the nearest
 * frame count is used). Unparseable / <1 falls back to the default; `spinner-frames.ts`
 * backstops non-finite values once more.
 */
const SPINNER_COLOR_HOLD = (() => {
	const parsed = Number.parseInt(process.env.PI_SPINNER_COLOR_HOLD ?? "", 10);
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_FRAMES_PER_COLOR;
})();
const SUMMARY_MIN_GAP = (() => {
	const parsed = Number.parseInt(process.env.PI_WORKING_SUMMARY_GAP ?? "", 10);
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MIN_GAP;
})();

/** Terminal columns; falls back to 80 when unavailable (non-TTY) or abnormally narrow. Re-read each refresh — resize self-heals. */
function terminalWidth(): number {
	const cols = process.stdout.columns;
	return Number.isFinite(cols) && cols >= 20 ? Math.floor(cols) : 80;
}

/** A theme interface using only `fg` — probes / unit tests can feed a fake with just `fg`. */
export interface WorkingMessageTheme {
	fg(color: string, text: string): string;
}

/**
 * Assemble the spinner text: the label (`Tools Calling` / `Editing` / …) takes the body color;
 * the stats segment after it (`(↓ 70 tokens · 10s)`) takes muted gray.
 *
 * Why self-color: pi's `WorkingStatusIndicator` hands the whole working message to
 * `theme.fg("muted", message)` (non-embedded; embedded in the editor border it uses the border
 * color) — there is no per-segment coloring entry, and `setWorkingMessage()` takes one string.
 * Fortunately `Theme.fg` only resets the foreground (it ends `\x1b[39m`, not `\x1b[0m`), so
 * "label dyed text + stats dyed muted" composes stably: the label's reset ends at its own end,
 * the stats segment carries its own muted prefix, and the outer muted is just one extra wrapper
 * — harmless.
 *
 * The stats segment's muted **must be written out explicitly** — it cannot rely on the outer
 * `fg("muted")`: the label's `\x1b[39m` already reset the outer foreground to the terminal
 * default, and without re-coloring that gray stretch would come out white.
 *
 * When no theme is available (theoretically only non-TUI contexts) it degrades to plain text:
 * the outer layer still renders pi's default color — the label just stops being white.
 */
export function formatWorkingMessage(
	theme: WorkingMessageTheme | undefined,
	label: string,
	stats: string | null,
): string {
	if (theme === undefined) return stats === null ? label : `${label} ${stats}`;
	const styledLabel = theme.fg(LABEL_COLOR, label);
	// the separating space is colored along with the stats segment so it does not sit alone on the terminal default color.
	return stats === null ? styledLabel : `${styledLabel}${theme.fg(STATS_COLOR, ` ${stats}`)}`;
}

/**
 * After the left segment (label + stats), pad the gap and attach the right-aligned prompt
 * summary. When it does not fit (terminal too narrow / left segment too wide / empty prompt),
 * the left segment returns verbatim — the summary is strictly an enhancement, never pushing
 * out existing info.
 *
 * The `summaryText` passed in is the flattened-and-cached whole prompt from the `input` event
 * (see file header); this function only does layout. Widths use pi-tui's `visibleWidth` (the
 * same implementation the renderer wraps on); the layout math lives in `working-summary.ts`
 * (pure, unit-tested). The gap spaces sit between the two segments' color resets — owned by
 * neither (spaces carry no foreground anyway).
 */
function appendPromptSummary(
	theme: WorkingMessageTheme | undefined,
	left: string,
	summaryText: string | null,
): string {
	if (summaryText === null || summaryText === "") return left;
	const termWidth = terminalWidth();
	const layout = layoutPromptSummary({
		promptText: summaryText,
		leftWidth: visibleWidth(left),
		totalWidth: termWidth - SPINNER_AND_PADDING_COLUMNS,
		// the summary segment (incl. `✦ `) never exceeds half the screen, so a long prompt cannot squeeze the left status text away.
		maxWidth: Math.floor(termWidth / 2),
		widthOf: visibleWidth,
		minGap: SUMMARY_MIN_GAP,
	});
	if (layout === null) return left;
	const styledSummary =
		theme === undefined
			? `${SUMMARY_MARKER} ${layout.summaryText}`
			: `${theme.fg(SUMMARY_MARKER_COLOR, SUMMARY_MARKER)}${theme.fg(STATS_COLOR, ` ${layout.summaryText}`)}`;
	return `${left}${" ".repeat(layout.gap)}${styledSummary}`;
}

/** Which model serves the summary: the `PI_WORKING_SUMMARY_MODEL`-resolved one when available, else the session model. */
function resolveSummaryModel(ctx: ExtensionContext): NonNullable<ExtensionContext["model"]> | undefined {
	if (SUMMARY_MODEL_SPEC !== "") {
		const slash = SUMMARY_MODEL_SPEC.indexOf("/");
		if (slash > 0) {
			const found = ctx.modelRegistry.find(SUMMARY_MODEL_SPEC.slice(0, slash), SUMMARY_MODEL_SPEC.slice(slash + 1));
			if (found !== undefined) return found;
		}
	}
	return ctx.model;
}

/**
 * The available width (columns) assumed when requesting a model summary. Shares
 * `availableSummaryTextWidth` with the renderer, except the left-segment width is an estimate —
 * the request fires in `input`, before the turn starts, so no real left segment exists
 * (see `SUMMARY_LEFT_WIDTH_ESTIMATE`).
 */
function summaryRequestBudgetWidth(): number {
	const termWidth = terminalWidth();
	return availableSummaryTextWidth({
		leftWidth: SUMMARY_LEFT_WIDTH_ESTIMATE,
		totalWidth: termWidth - SPINNER_AND_PADDING_COLUMNS,
		maxWidth: Math.floor(termWidth / 2),
		widthOf: visibleWidth,
		minGap: SUMMARY_MIN_GAP,
	});
}

/** Extract text from an assistant response (an empty reply that only produced thinking → "", abandoning this summary). */
function textFromAssistant(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => (block as { type?: unknown; text?: unknown })?.type === "text")
		.map((block) => (block as { text?: unknown }).text)
		.filter((text): text is string => typeof text === "string")
		.join("\n");
}

/** Seconds-tick interval. 1s is enough — the display precision is seconds; tighter ticks are wasted renders. */
const TICK_MS = 1000;

/**
 * Duration formatting: under 60s → `42s`; 60s+ → `1m 23s`; 1h+ → `1h 23m 32s`.
 * The minutes field survives past 1 hour (not folded into pure minutes), matching the
 * `1h 23m 32s` shape.
 *
 * Exported for testability: the hour tier takes a real hour to trigger, so all three branches
 * are covered by unit tests, and the minutes tier was additionally frame-verified once on a
 * real long task (see README).
 */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	return `${minutes}m ${seconds}s`;
}

export default function (pi: ExtensionAPI) {
	/** Turn start instant; null = not inside a turn (no render, no timers). */
	let turnStartedAt: number | null = null;
	/**
 * This run's outcome (recorded at `agent_before_settle`, consumed once at `agent_settled`):
 * the end marker is drawn only on `completed` — ESC interruption / error endings keep the
 * current behavior (the spinner simply vanishes).
 */
	let turnOutcome: "completed" | "aborted" | "error" | null = null;

	/**
 * The current turn's user input **flattened** (captured on `input`, `flattenPrompt`ed once and
 * cached — see file header); null = not captured yet (a resumed session just keeps waiting)
 * and no summary shows. Deliberately not stored raw and recomputed per refresh — refresh runs
 * on every streaming delta.
 */
	let promptText: string | null = null;
	/**
 * The one-liner the model compressed (arrives async; null = not yet / not requested / failed).
 * Takes display precedence over `promptText`: once it arrives it stays until the turn ends
 * (at most two requests per prompt; a failed first retries after a delay; an overlong reply
 * is only truncated, never re-asked).
 */
	let promptSummaryText: string | null = null;
	/**
 * A counter incremented on each `input`. The model reply may come back slower than prompts
 * change (the user already started the next round / mid-stream steer): the reply is checked
 * against it, and a reply that is not its own generation is dropped — a stale prompt's summary
 * never lands on a new prompt.
 */
	let promptSeq = 0;
	/** The previous `input`'s raw text, used to swallow duplicate `input` events for the same message (see the `input` handler). */
	let lastInputText: string | null = null;
	/** The in-flight summary request; `abort()` stops it (new prompt / turn end / session close). */
	let summaryAbort: AbortController | null = null;
	/**
 * The pending summary-retry timer (one delayed retry after a first failure).
 * `cancelSummaryRequest()` clears it too — after a new prompt / turn end / session replace,
 * nobody wants that retry anymore.
 */
	let summaryRetryTimer: ReturnType<typeof setTimeout> | null = null;

	/**
 * Per-segment token-estimate counters: a wide char (CJK — 2 terminal columns) counts as 1
 * token, a narrow char as 1/4 (the `wide` below is derived from pi-tui's `visibleWidth`, no
 * hand-maintained code-point table).
 *
 * This accounting used to be shared with `tool-diff.ts`'s `estimateTokens` — its title row
 * later switched to showing `(+N -M)` line counts instead of token counts, that function was
 * deleted, and this is the only copy left.
 *
 * One counter per segment, zeroed when the segment starts, so the displayed number is always
 * "the current small segment's" amount. Kept separate rather than one shared accumulator for
 * another reason: during tool execution upstream may still push reasoning frames, and a shared
 * accumulator would count thinking chars into the bash command's number.
 *
 * **Incremental accumulation** here, not a full recompute each second: wide/narrow counts are
 * additive, so accumulating per delta equals a one-shot count over the whole text — O(delta)
 * instead of O(text).
 *
 * The text segment is not in the table: its token count never displays, and counting it would
 * only pollute the other segments.
 */
	type CounterKind = "thinking" | "toolcall";
	const counters: Record<CounterKind, { wide: number; narrow: number }> = {
		thinking: { wide: 0, narrow: 0 },
		toolcall: { wide: 0, narrow: 0 },
	};

	/** A new small segment begins: its counter zeroes out and counting restarts. */
	function resetCounter(kind: CounterKind): void {
		counters[kind].wide = 0;
		counters[kind].narrow = 0;
	}

	/** Accumulate wide/narrow char counts into the segment per delta. */
	function accumulate(kind: CounterKind, text: string): void {
		if (text === "") return;
		const points = [...text].length; // counted by code points — a surrogate pair does not count as 2 chars
		const wide = Math.max(0, visibleWidth(text) - points);
		counters[kind].wide += wide;
		counters[kind].narrow += Math.max(0, points - wide);
	}

	function tokenEstimate(kind: CounterKind): number {
		const counter = counters[kind];
		return Math.ceil(counter.wide + counter.narrow / 4);
	}

	/**
 * Currently executing tools: `toolCallId → toolName` (booked at `tool_execution_start`,
 * unbooked at `_end`).
 * A batch may run **several tools in parallel** (pi's parallel tool mode); keeping a single
 * string would clear the name when the first-finishing tool ends — the long bash still runs
 * but the label drops back to `Working`, and the `●` hangs after the wrong label. The label
 * takes the **last started** tool (inherited semantics: executing beats thinking, by start
 * order).
 */
	const executingTools = new Map<string, string>();

	/** The name of the last-started tool still executing; null when none. */
	function executingToolName(): string | null {
		let name: string | null = null;
		for (const toolName of executingTools.values()) name = toolName;
		return name;
	}

	/**
 * The registry of concurrent bash executions (see `bash-spinner.ts`): threshold / stickiness /
 * disappear conditions all live there; this file only owns the "when to blink" timers.
 */
	const bashRuns = new BashRunTracker();
	/** The marker's lit/dark phase (`bashSpinnerSuffix` renders the two states from it). */
	let bashSpinOn = false;
	let bashBlinkTimer: ReturnType<typeof setInterval> | null = null;
	let bashArmTimer: ReturnType<typeof setTimeout> | null = null;
	/** The tool whose arguments are still streaming (`toolcall_start` → `toolcall_end`). */
	let streamingTool: string | null = null;
	/** Whether a thinking segment is in progress (`thinking_start` → `thinking_end`). */
	let thinking = false;

	let timer: ReturnType<typeof setInterval> | null = null;
	let ctxRef: ExtensionContext | null = null;
	let lastMessage: string | null = null;
	/**
 * True during dialogs (`ui_prompt_start` → `ui_prompt_end`): all timers pause, the spinner
 * freezes to one frame, `refresh()` early-returns. Purpose: pi's main-screen render pins the
 * viewport to the bottom on every repaint, and during a dialog any periodic repaint (Loader's
 * 80ms animation, this extension's 1s ticking) yanks the user's manually scrolled position
 * back — a long-content dialog (the plan-mode approval box) becomes uninspectable. Frozen, the
 * terminal's own scrollback stops being stolen.
 */
	let uiPromptActive = false;
	/**
 * Whether the watchdog-review hint is showing. Set true when `WATCHDOG_DELAY_MS` elapses after
 * `agent_end` without a settle (refresh switches the label to WATCHDOG_LABEL); reset by any of
 * `agent_settled` / `agent_before_settle` / `session_before_compact` / `agent_start` /
 * `session_shutdown`.
 */
	let watchdogActive = false;
	let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
	/**
 * The palette fingerprint last installed (`spinner-frames.ts`'s `signature`): `refresh()`
 * recomputes it from the current theme every second and reinstalls only when it changed —
 * self-heals within a second of `/theme`, and the phase resets only on a real color change.
 */
	let spinnerSignature: string | null = null;

	/**
 * Which label to show now and which segment's token counter goes with it; null = fall back to
 * Working (no token segment).
 *
 * Priority: executing > args streaming > thinking. Executing beating thinking is deliberate —
 * upstream may keep pushing reasoning frames during tool execution, but the user cares about
 * "a command is running". A tool not in TOOL_LABELS falls back to Working directly, never
 * down to thinking (inherited semantics).
 */
	function currentActivity(): { label: string; counter: CounterKind } | null {
		const executing = executingToolName();
		if (executing !== null) {
			const label = TOOL_LABELS[executing];
			return label === undefined ? null : { label, counter: "toolcall" };
		}
		if (streamingTool !== null) {
			const label = TOOL_LABELS[streamingTool];
			return label === undefined ? null : { label, counter: "toolcall" };
		}
		if (thinking) return { label: THINKING_LABEL, counter: "thinking" };
		return null;
	}

	/** Split the current message into "label" and "stats segment" — the two take different colors and must be dyed separately. */
	function buildParts(now: number): { label: string; stats: string | null } {
		const duration = formatDuration(now - (turnStartedAt ?? now));
		const activity = currentActivity();
		if (activity === null) return { label: DEFAULT_LABEL, stats: `(${duration})` };
		return {
			label: activity.label,
			stats: `(↓ ${tokenEstimate(activity.counter)} tokens · ${duration})`,
		};
	}

	/** The rainbow palette under the current theme (recomputed live; `theme.fg` is a live proxy, so the same call picks up new colors after a skin swap). */
	function spinnerPalette(ctx: ExtensionContext): SpinnerPalette {
		return buildSpinnerPalette((token, text) => ctx.ui.theme.fg(token, text), {
			framesPerColor: SPINNER_COLOR_HOLD,
		});
	}

	/**
 * Install the palette onto pi (no dedupe check, no error guard). `frames === null` (current
 * theme cannot produce two distinguishable colors) → fall back to pi's default frames.
 */
	function applySpinnerPalette(ctx: ExtensionContext, palette: SpinnerPalette): void {
		spinnerSignature = palette.signature;
		if (palette.frames === null) {
			ctx.ui.setWorkingIndicator();
			return;
		}
		ctx.ui.setWorkingIndicator({ frames: palette.frames, intervalMs: SPINNER_INTERVAL_MS });
	}

	/**
 * Unconditionally install the rainbow frame table. Fails silently: every call site is a spot
 * where "a stale ctx must not topple the host" (`agent_start` / `tool_execution_end`) — a
 * stale ctx throws `This extension ctx is stale…`, in which case nothing needs doing.
 */
	function installRainbowSpinner(ctx: ExtensionContext): void {
		if (!SPINNER_RAINBOW_ENABLED) return;
		try {
			applySpinnerPalette(ctx, spinnerPalette(ctx));
		} catch {
			// stale ctx: do not touch the UI.
		}
	}

	/**
 * Reinstall only when the theme fingerprint changed (`refresh()` calls this every second).
 * A reinstall resets the animation phase, so it must not run blindly — the skin-swap moment
 * redraws the whole screen anyway and that one reset is invisible.
 */
	function syncRainbowSpinner(ctx: ExtensionContext): void {
		if (!SPINNER_RAINBOW_ENABLED) return;
		const palette = spinnerPalette(ctx);
		if (palette.signature === spinnerSignature) return;
		applySpinnerPalette(ctx, palette);
	}

	/**
 * Refresh the text. `setWorkingMessage` is called only when the string really changed, avoiding
 * pointless re-renders every second.
 *
 * `ctx.ui` access (reading the theme, writing the message) is wrapped in try/catch: after a
 * session replace or `/reload`, a stale ctx throws `This extension ctx is stale after session
 * replacement or reload` — and that throw happens **while reading `ctx.ui`**, earlier than any
 * component render; a leaked timer callback is enough to topple the host process — recap /
 * simple-task have hit the same hole.
 *
 * The theme is re-read every time (self-heals within a second of `/theme`), deliberately not
 * subscribing to theme-change events.
 */
	function refresh(): void {
		// during a dialog, do not touch the UI: timers are stopped, but event paths like tool_execution_start can still reach here.
		if (uiPromptActive) return;
		const ctx = ctxRef;
		if (ctx === null || turnStartedAt === null) {
			stopBashSpinner();
			return;
		}
		let message: string;
		try {
			const now = Date.now();
			// watchdog reviewing: show only the fixed text — no tokens/duration, and no bash spinner.
			// the user-specified text is the whole thing; adding a duration would imply "much longer still".
			if (watchdogActive) {
				message = formatWorkingMessage(ctx.ui.theme, WATCHDOG_LABEL, null);
				if (message !== lastMessage) {
					lastMessage = message;
					try {
						ctx.ui.setWorkingMessage(message);
					} catch {
						stopActivity();
					}
				}
				return;
			}
			driveBashSpinner(now);
			const parts = buildParts(now);
			let left = formatWorkingMessage(ctx.ui.theme, parts.label, parts.stats);
			left += bashSpinnerText(ctx.ui.theme);
			// once the model summary arrives it replaces the original; before that (or on failure) the truncated original shows.
			const summarySource = promptSummaryText ?? promptText;
			message = SUMMARY_ENABLED ? appendPromptSummary(ctx.ui.theme, left, summarySource) : left;
			// reinstall the rainbow table when the theme fingerprint changed (self-heals within a second of a skin swap); unchanged → no-op here.
			syncRainbowSpinner(ctx);
		} catch {
			// stale ctx: stop the timers — do not touch the UI with it again.
			stopActivity();
			return;
		}
		if (message === lastMessage) return;
		lastMessage = message;
		try {
			ctx.ui.setWorkingMessage(message);
		} catch {
			stopActivity();
		}
	}

	function startTimer(ctx: ExtensionContext): void {
		stopTimer();
		ctxRef = ctx;
		timer = setInterval(refresh, TICK_MS);
		// unref: the seconds timer must not hold the process open (no need to wait for it at exit).
		timer.unref?.();
	}

	function stopTimer(): void {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		ctxRef = null;
	}

	/**
 * Dialog start: stop this extension's three timers and freeze the spinner to a single frame.
 *
 * The frozen frame is **the crucial step**: pi's working indicator is pi-tui's `Loader`, which
 * carries an 80ms frame-animation timer calling `requestRender()` each frame — 12.5× more
 * frequent than this extension's 1s ticking and the main cause of the viewport being yanked to
 * the bottom. `Loader.restartAnimation()` early-returns on `frames.length <= 1`, so installing
 * a single frame stops that interval (the same trick the `ask-user-question` extension uses).
 *
 * Not `stopTimer()`: that would null `ctxRef`, making resume impossible when the dialog ends.
 */
	function pauseForUiPrompt(ctx: ExtensionContext): void {
		if (uiPromptActive) return;
		uiPromptActive = true;
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		stopBashSpinner();
		try {
			ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", FROZEN_SPINNER_FRAME)] });
		} catch {
			// stale ctx / unsupported host: a failed freeze does not break correctness — the dialog just still repaints.
		}
	}

	/**
 * Dialog end: reinstall the rainbow table (`installRainbowSpinner` installs unconditionally,
 * conveniently overwriting the frozen frame), restart the seconds timer, and refresh once
 * immediately (catching up on the seconds that passed during the dialog).
 *
 * The timer restarts only when truly inside a turn (both `ctxRef` and `turnStartedAt` set) —
 * a dialog can also happen outside a turn (e.g. the `/plan` command's confirm box), where no
 * seconds timer should materialize out of nothing.
 */
	function resumeAfterUiPrompt(): void {
		if (!uiPromptActive) return;
		uiPromptActive = false;
		const ctx = ctxRef;
		if (ctx === null) return;
		// restore the frame table: with rainbow on, reinstall unconditionally (conveniently overwriting the frozen frame); with it off, restore pi's default frames,
		// or the single frozen frame stays stuck.
		if (SPINNER_RAINBOW_ENABLED) installRainbowSpinner(ctx);
		else {
			try {
				ctx.ui.setWorkingIndicator();
			} catch {
				// stale ctx: do not touch the UI
			}
		}
		if (turnStartedAt !== null && timer === null) {
			timer = setInterval(refresh, TICK_MS);
			timer.unref?.();
		}
		refresh();
	}

	/** Stop `●`'s cadence / armed timers and return to the dark state (idempotent). */
	function stopBashSpinner(): void {
		if (bashBlinkTimer !== null) {
			clearInterval(bashBlinkTimer);
			bashBlinkTimer = null;
		}
		if (bashArmTimer !== null) {
			clearTimeout(bashArmTimer);
			bashArmTimer = null;
		}
		bashSpinOn = false;
	}

	/**
 * Blink cadence: once `●` is lit, flip phase + repaint every 500ms (same cadence as tool-diff's
 * `edit` / `write`).
 * Idempotent: already blinking → no-op (the phase is not reset, keeping cadence continuous
 * under concurrent bashes).
 */
	function startBashBlink(): void {
		if (bashBlinkTimer !== null) return;
		bashSpinOn = true; // first light: the crossing instant itself is the lit phase — no 500ms dark window
		bashBlinkTimer = setInterval(() => {
			bashSpinOn = !bashSpinOn;
			refresh();
		}, BASH_SPINNER_BLINK_MS);
		bashBlinkTimer.unref?.();
	}

	/**
 * Threshold not yet reached: arm a one-shot timer that repaints at the deadline so `●` appears
 * **exactly on time** (otherwise it waits for the next unrelated repaint — a non-streaming
 * command may see no upstream events while executing). Idempotent (an armed schedule or an
 * active blink returns early).
 */
	function armBashSpinner(delayMs: number): void {
		if (bashArmTimer !== null || bashBlinkTimer !== null) return;
		bashArmTimer = setTimeout(() => {
			bashArmTimer = null;
			refresh();
		}, Math.max(0, delayMs));
		bashArmTimer.unref?.();
	}

	/**
 * "Has any bash in this batch crossed the threshold" + timer driving — runs every refresh.
 * Crossed → stop arming, start the cadence; not yet → arm a one-shot at the earliest deadline;
 * no executions / switch off → stop everything.
 */
	function driveBashSpinner(now: number): void {
		if (!BASH_SPINNER_ENABLED || bashRuns.size === 0) {
			stopBashSpinner();
			return;
		}
		if (bashRuns.markCrossed(now)) {
			if (bashArmTimer !== null) {
				clearTimeout(bashArmTimer);
				bashArmTimer = null;
			}
			startBashBlink();
			return;
		}
		const delay = bashRuns.armDelay(now);
		if (delay !== null) armBashSpinner(delay);
	}

	/**
 * The row-tail marker segment (leading space included, **always 2 columns**; empty string when
 * hidden). Coloring happens here: `Theme.fg` only resets the foreground, so splicing it at the
 * left segment's tail does not disturb the segments already there.
 */
	function bashSpinnerText(theme: WorkingMessageTheme | undefined): string {
		if (!BASH_SPINNER_ENABLED || !bashRuns.shown) return "";
		const text = bashSpinnerSuffix(bashSpinOn);
		return theme === undefined ? text : theme.fg(BASH_SPINNER_COLOR, text);
	}

	/**
 * The turn-end marker: paint one static row where the spinner used to be (shape / word list in
 * `turn-marker.ts`).
 *
 * Why a widget rather than the working message: pi calls `clearStatusIndicator("working")` at
 * the app layer's `agent_end`, and `setWorkingMessage` / `setWorkingVisible` only work during
 * streaming — there is no API for the statusContainer to render outside a turn. The widget
 * area above the editor is the only place that can persist, and its row count matches exactly:
 * with the spinner, the stretch above is "blank + text + blank" (it carries one leading blank,
 * the lower blank being the widget area's); the marker slot is likewise three rows — the
 * widget area's leading blank + the marker + the trailing blank supplied below. The locally
 * installed prompt-editor does not enable embedWorkingStatus, so the spinner runs as a
 * standalone row and this holds exactly.
 *
 * Factory form rather than a string array: coloring must go through `theme`'s live proxy so a
 * `/theme` swap self-heals on rerender; a string array would bake the colors in at
 * registration time.
 *
 * One leading space is self-supplied: the spinner's and recap's indent come from the Text's
 * paddingX=1 (renderer-provided) — a widget component returns bare strings without it.
 *
 * The whole thing is wrapped in try/catch: `hasUI` and `ui` are the runner's assertActive
 * proxies, and a stale ctx throws **on the read**, earlier than the widget's render; the marker
 * is only decoration — a throw means skip it.
 */
	function showTurnMarker(ctx: ExtensionContext, text: string): void {
		try {
			if (!ctx.hasUI) return;
			ctx.ui.setWidget(TURN_MARKER_WIDGET_KEY, (_tui, theme) => ({
				render: (width: number) => [
					truncateToWidth(` ${theme.fg(TURN_MARKER_COLOR, text)}`, width, ""),
					// a trailing blank row (required by the user 2026-10-07): the spinner always had one below it
					// (the widget area's leading blank); without it the marker would hug the editor and the whole block shifts up a row.
					// conveniently it is also the gap between widgets: recap / simple-task's `gap.ts` adds nothing when the neighbor's last row
					// is blank — so two widgets still end up exactly one row apart.
					"",
				],
				invalidate() {},
			}));
		} catch {
			// stale ctx / unsupported host: skip silently.
		}
	}

	/** Clear the marker (the next turn starts; pi's `resetExtensionUI()` also clears on session replace). */
	function clearTurnMarker(ctx: ExtensionContext): void {
		try {
			ctx.ui.setWidget(TURN_MARKER_WIDGET_KEY, undefined);
		} catch {
			// stale ctx: do not touch the UI.
		}
	}

	/** Stale ctx (session replaced / `/reload`): stop all timers and wipe the books — do not touch the UI with it again. */
	function stopActivity(): void {
		stopTimer();
		stopBashSpinner();
		bashRuns.clear();
		cancelSummaryRequest();
		clearWatchdogHint();
	}

	/** Cancel the pending watchdog timer and reset the flag (idempotent). */
	function clearWatchdogHint(): void {
		if (watchdogTimer !== null) {
			clearTimeout(watchdogTimer);
			watchdogTimer = null;
		}
		watchdogActive = false;
	}

	/**
 * Arm a one-shot timer after `agent_end`: if the turn still has not settled at the deadline,
 * count it as a watchdog (or other blocker) running and switch the label to WATCHDOG_LABEL.
 * The timer is unref'd — it does not hold the process at exit.
 */
	function armWatchdogHint(): void {
		if (!WATCHDOG_HINT_ENABLED) return;
		clearWatchdogHint();
		watchdogTimer = setTimeout(() => {
			watchdogTimer = null;
			// at the deadline the turn must still be running (turnStartedAt non-null) to show; settled clears it first.
			if (turnStartedAt === null) return;
			watchdogActive = true;
			refresh();
		}, WATCHDOG_DELAY_MS);
		watchdogTimer.unref?.();
	}

	/** Extract the tool name from a `toolcall_start` partial. */
	function toolNameFromPartial(event: { contentIndex?: number; partial?: unknown }): string | null {
		const partial = event.partial as { content?: unknown[] } | undefined;
		const index = event.contentIndex;
		if (!Array.isArray(partial?.content) || typeof index !== "number") return null;
		const block = partial.content[index] as { name?: unknown } | undefined;
		return typeof block?.name === "string" ? block.name : null;
	}

	/** Stop the in-flight summary request and the pending retry (idempotent). They are only side requests — stopping them does not affect the main task. */
	function cancelSummaryRequest(): void {
		if (summaryRetryTimer !== null) {
			clearTimeout(summaryRetryTimer);
			summaryRetryTimer = null;
		}
		if (summaryAbort !== null) {
			summaryAbort.abort();
			summaryAbort = null;
		}
	}

	/**
 * When the prompt is too long, **asynchronously** ask the model to compress it to one line
 * (decision / prompt / cleanup in `summary-request.ts`).
 * It returns right after sending, without `await`: the main round runs fully parallel to the
 * request, and slow/failure only means the cell keeps showing the truncated original. The
 * reply has three guards: an aborted request, a mismatched generation, or a cleared prompt
 * (turn ended) all get dropped.
 *
 * A first failure (error / 45s timeout / thinking-only reply) auto-retries **once** after
 * `SUMMARY_RETRY_DELAY_MS` (`attempt`); a second failure gives up for good. Before retrying,
 * validity is re-checked: a new prompt / turn end / session replace all pass through
 * `cancelSummaryRequest()` (clearing the pending retry timer and nulling `summaryAbort`), and
 * `retryLater` recognizes "already cancelled" via `summaryAbort === controller` and gives up —
 * the 45s timeout aborts too but does not touch `summaryAbort`, so it counts as a failure and
 * retries normally.
 */
	function requestPromptSummary(ctx: ExtensionContext, prompt: string, seq: number, attempt = 0): void {
		if (ctx.mode !== "tui") return; // print / json / rpc modes have no working line — a wasted request.
		const model = resolveSummaryModel(ctx);
		if (model === undefined) return;

		const plan = planSummaryRequest({
			promptWidth: visibleWidth(prompt),
			budgetWidth: summaryRequestBudgetWidth(),
			triggerRatio: SUMMARY_TRIGGER_RATIO,
		});
		if (!plan.needed) return;

		const controller = new AbortController();
		summaryAbort = controller;
		const timeout = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
		timeout.unref?.();

		/** Counts as failure: schedule one retry if budget allows (not when cancelled / prompt changed / turn ended). */
		const retryLater = (): void => {
			if (attempt + 1 >= SUMMARY_MAX_ATTEMPTS) return;
			if (summaryAbort !== controller) return;
			if (seq !== promptSeq || promptText === null) return;
			summaryRetryTimer = setTimeout(() => {
				summaryRetryTimer = null;
				requestPromptSummary(ctx, prompt, seq, attempt + 1);
			}, SUMMARY_RETRY_DELAY_MS);
			summaryRetryTimer.unref?.();
		};

		void (async () => {
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				// cannot get a key: it will not get better in 3s, so no retry; already cancelled (a timeout, in the extreme case) likewise exits directly.
				if (!auth.ok || controller.signal.aborted) return;
				const response = await ctx.modelRegistry.complete(
					model,
					{
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: buildSummaryRequestPrompt(prompt, plan.targetWidth) }],
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						signal: controller.signal,
						maxTokens: SUMMARY_MAX_TOKENS,
						// deliberately **not** passing temperature: 0 degenerates these max-tier routes into unstoppable long thinking (see
						// the `SUMMARY_MAX_TOKENS` comment); the default temperature is stable.
						cacheRetention: "none",
					},
				);
				if (controller.signal.aborted || seq !== promptSeq || promptText === null) return;
				const text = cleanSummaryText(textFromAssistant(response));
				if (text === "") {
					// thinking only / only decoration (cleans to empty): count as failure — worth another ask.
					retryLater();
					return;
				}
				promptSummaryText = text;
				refresh();
			} catch {
				// timeout / abort / network error / model unavailable: retry once after a delay; a second failure keeps showing
				// the truncated original (the summary is only an enhancement — it must not disturb the main round).
				retryLater();
			} finally {
				clearTimeout(timeout);
				if (summaryAbort === controller) summaryAbort = null;
			}
		})().catch(() => {});
	}

	pi.on("input", async (event, ctx) => {
		// fires before agent processing: a normal message is the user's verbatim text, a skill/template command is the
		// raw command line before expansion, and an extension command's sendUserMessage fires again too (source=extension).
		// mid-stream steer / followUp also comes through here — the summary updates to the newest instruction.
		// flattening is computed once and cached here (refresh runs per delta — a whole rescan each time is unaffordable).
		//
		// a repeated fire of the same text reuses the cache: an extension command's sendUserMessage runs the same message
		// through `input` twice, and the second one must not invalidate the in-flight summary request and restart it.
		if (event.text === lastInputText) return;
		lastInputText = event.text;
		promptSeq += 1;
		cancelSummaryRequest();
		promptSummaryText = null;
		promptText = SUMMARY_ENABLED ? flattenPrompt(event.text) : null;
		if (SUMMARY_LLM_ENABLED && promptText !== null && promptText !== "") {
			requestPromptSummary(ctx, promptText, promptSeq);
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		turnStartedAt = Date.now();
		turnOutcome = null;
		resetCounter("thinking");
		resetCounter("toolcall");
		executingTools.clear();
		bashRuns.clear();
		stopBashSpinner();
		streamingTool = null;
		thinking = false;
		lastMessage = null;
		clearWatchdogHint();
		// print / json modes have no working loader row — a timer would run for nothing.
		if (ctx.hasUI) {
			// a new turn begins — the previous turn's end marker steps aside (a fresh one is drawn at this turn's end).
			clearTurnMarker(ctx);
			// install the frame table at turn start: the spinner has not rendered yet (it appears at streaming start), so the phase reset is invisible;
			// after a session replace, pi's resetExtensionUI() restores the indicator to default frames — covered here too.
			installRainbowSpinner(ctx);
			startTimer(ctx);
			refresh();
		}
	});

	pi.on("message_update", async (event) => {
		const streamEvent = event.assistantMessageEvent as
			| { type?: string; delta?: string; contentIndex?: number; partial?: unknown }
			| undefined;
		switch (streamEvent?.type) {
			// every *_start is the beginning of a small segment: that segment's counter zeroes and restarts.
			case "thinking_start":
				thinking = true;
				resetCounter("thinking");
				break;
			case "thinking_end":
				thinking = false;
				break;
			// text segment start = thinking segment end (in the normal order thinking_end arrives first; this is a fallback).
			// text_delta itself is not counted, so text_start needs no counter reset.
			case "text_start":
				thinking = false;
				break;
			case "toolcall_start": {
				const name = toolNameFromPartial(streamEvent as { contentIndex?: number; partial?: unknown });
				if (name !== null) streamingTool = name;
				resetCounter("toolcall");
				break;
			}
			case "toolcall_end":
				streamingTool = null;
				// deliberately not zeroing the toolcall counter: `tool_execution_start` arrives right after, and during execution
				// what shows is still this command's amount; zeroing would display `↓ 0 tokens` for the whole execution.
				break;
			// each delta lands in its own kind's segment, so reasoning frames never count into a tool command's number.
			case "thinking_delta":
				accumulate("thinking", typeof streamEvent.delta === "string" ? streamEvent.delta : "");
				break;
			case "toolcall_delta":
				accumulate("toolcall", typeof streamEvent.delta === "string" ? streamEvent.delta : "");
				break;
			// text_delta deliberately uncounted: the body segment's tokens never display, and accumulating would only pollute later segments.
		}
		refresh();
	});

	pi.on("tool_execution_start", async (event) => {
		executingTools.set(event.toolCallId, event.toolName);
		if (event.toolName === "bash") bashRuns.start(event.toolCallId, Date.now());
		// the args-streaming phase may not have gotten a name (partial missing the block) — the execution state is authoritative; patched here.
		streamingTool = null;
		refresh();
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		executingTools.delete(event.toolCallId);
		bashRuns.end(event.toolCallId);
		// on questionnaire exit the indicator restores pi's default frames (it does not know about this extension's rainbow); reinstalled here.
		if (event.toolName === ASK_USER_QUESTION_TOOL) installRainbowSpinner(ctx);
		refresh();
	});

	/**
 * `agent_end`: pi awaits every extension's agent_end handler in turn, and only afterwards fires
 * the app-layer agent_end (where the TUI clears the spinner). pi-subagents' watchdog blocks
 * inside that handler for 7~17s running its review model — so the spinner keeps spinning
 * unexplained. A one-shot timer is armed here: not settled by the deadline → switch the label
 * to the watchdog hint (see armWatchdogHint).
 */
	pi.on("agent_end", async () => {
		armWatchdogHint();
	});

	/**
 * Both compaction and the `/goal` evaluation happen **after** the app-layer agent_end (where pi
 * already cleared the spinner) and before agent_settled. The watchdog phase is finished by
 * then, so either event resets the hint — avoiding mislabeling compaction / verify-loop's
 * `/goal` evaluation as a watchdog.
 */
	pi.on("session_before_compact", async () => {
		clearWatchdogHint();
	});
	pi.on("agent_before_settle", async (event) => {
		// the outcome is only available here (`agent_settled` carries no payload) — the marker's draw-or-not hangs on it.
		turnOutcome = event.outcome;
		clearWatchdogHint();
	});

	/**
 * `agent_settled` is the turn's real end (`agent_end` can still be followed by auto-retry,
 * auto-compaction, or queued follow-ups — the spinner is still running during those, so the
 * clock cannot stop early).
 */
	pi.on("agent_settled", async (_event, ctx) => {
		// the marker needs both the turn duration and the outcome — both must be captured before state is cleared.
		const settledAt = Date.now();
		const startedAt = turnStartedAt;
		const completed = turnOutcome === "completed";
		stopActivity();
		turnStartedAt = null;
		turnOutcome = null;
		lastMessage = null;
		promptText = null;
		promptSummaryText = null;
		lastInputText = null;
		try {
			ctx.ui.setWorkingMessage(); // no-arg = restore pi's default text
		} catch {
			// stale ctx; ignore
		}
		// the marker: the spinner is already cleared by pi here — leave one row of "ran for X · done at Y" in its place.
		// only normal completion counts; `startedAt === null` (never saw agent_start, e.g. mid-run reload) draws nothing.
		if (!TURN_MARKER_ENABLED || !completed || startedAt === null) return;
		showTurnMarker(
			ctx,
			formatTurnMarker(pickTurnVerb(), formatDuration(settledAt - startedAt), formatEndClock(new Date(settledAt))),
		);
	});

	/**
 * During dialogs all periodic repaints freeze, letting the user scroll up through long content
 * (the plan-mode approval box).
 * The events come from pi's `withUIPrompt`, covering select / confirm / input / editor /
 * custom dialogs; nested dialogs are counted via `uiPromptDepth`, which only fires on the
 * outermost enter/exit — no need to guard nesting here.
 */
	pi.on("ui_prompt_start", async (_event, ctx) => {
		pauseForUiPrompt(ctx);
	});
	pi.on("ui_prompt_end", async () => {
		resumeAfterUiPrompt();
	});

	pi.on("session_shutdown", async () => {
		stopActivity();
		turnStartedAt = null;
		turnOutcome = null;
		promptText = null;
		promptSummaryText = null;
		// the dedupe key must be cleared too: in the new session the user may re-type a prompt identical to the last one,
		// and a stale value would skip it as a "duplicate input".
		lastInputText = null;
	});
}
