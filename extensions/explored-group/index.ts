/**
 * explored-group — folds consecutive "read-only lookups" into one `Explored` group block.
 *
 * User's decision, 2026-10-06. Shape in `render.ts`; classification and group-break rules in
 * `registry.ts` / `classify.ts`.
 *
 * ## What this extension does (three things)
 *
 * 1. **Takes over rendering of the native `grep` / `find` / `ls`** — they cannot group on their
 *    own (with `defaultTools` enabled, each block renders 10–21 lines, even wordier than the
 *    collapsed bash blocks), so they follow the same route as bash / read: "join `Explored` if
 *    foldable, otherwise render as-is". The matching `defaultTools` change lives in
 *    `clients/pi/config/settings.json`.
 *
 * 2. **Wires the group-break events** — the `read` / `bash` blocks are registered by other
 *    extensions (`read-path-collapse.ts` / `bash-command-collapse.ts`) that only handle
 *    rendering and never learn when thinking / narration / user messages appear. Break
 *    information is only obtainable here, so this file feeds it to `registry`.
 *
 * 3. **Registers member status for the native tools** — at `tool_execution_end`, ok / error is
 *    written back to the group, and the header dot recolors accordingly (user's rule: white =
 *    still running, green = all succeeded, red = any error).
 *
 * ## Why replay via `message_*` events instead of `tool_call`
 *
 * `tool_call` only carries tool info; it cannot see ordering like "a thinking sits in front of
 * this one" — and the break rules are judged precisely by **content order**. So the authoritative
 * source is the assistant message's content array: `replayMessage()` walks it in order, breaking
 * on thinking / non-empty text. `message_update` fires repeatedly during streaming; `registry`
 * deduplicates internally by message, so no double breaks.
 *
 * `tool_call` only adds a **fallback** break for **non-foldable** tools (native grep/find/ls and
 * read/bash are covered by the message replay, but other tools — write / edit / subagent … — are
 * outside the classification scope of the content array; this path guarantees that "a write
 * happened" also breaks the group).
 *
 * ## This file does not import the bash / read extensions
 *
 * The three extensions each import `explored-group/`'s pure functions and the registry (a
 * `globalThis` singleton), with no dependency on each other — any one of them can be missing and
 * the rest still work (only that side's blocks drop out of the folding).
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition } from "@earendil-works/pi-coding-agent";
import { arm, ensureRegistered, isLeader, markMemberReady, markMessageReady, markReadyIfSettled, noteToolCall, noteUserMessage, replayMessage, setLeaderInvalidate, setMemberStatus, shouldHideWhilePending } from "./registry.ts";
import { EMPTY_COMPONENT, createGroupTree } from "./render.ts";

/**
 * Open the gate: grouping only becomes effective after "a session has actually run".
 *
 * `session_start` is the first event of an interactive start, but it is not necessarily sent in
 * `--print`, `/reload`, or scenarios where a session is constructed only to render history — so
 * `message_*` also opens it (`replayMessage` arms internally). Opening on both keeps the gate
 * invisible to real runs and only blocks "extension loaded but no session ever ran".
 */
function armOnStart(): void {
	arm();
}

/**
 * Replay history entries to replay the break events (second round, 2026-10-06).
 *
 * ## Why this is needed
 *
 * Group breaking relies entirely on `message_*` / `user` message events, and **pi does not emit
 * them when rebuilding history**: `renderInitialMessages()` → `renderSessionItems()` only
 * constructs `ToolExecutionComponent`s and renders them, emitting no extension events at all
 * (verified: after `session_start(reason:"resume")` this is what happens immediately).
 *
 * So blocks from history could only register via `ensureRegistered` inside `renderCall` — and
 * would **all merge into one block**: measured over 367 sessions, 319 would become "the whole
 * session is one Explored", the largest holding 326 members with only 5 rows on screen — history
 * effectively lost. The HEAD version only kept a few blocks apart thanks to family-based breaks;
 * this round removed family-based breaks, amplifying the risk, so this had to be added.
 *
 * ## How
 *
 * On `session_start` (with `reason` `resume` / `fork`, or any scenario with existing history),
 * `sessionManager.buildContextEntries()` is replayed in order — through the **same**
 * `replayMessage` / `noteUserMessage` as during streaming, so there is exactly one set of break
 * rules, never two semantics.
 */
function hydrateFromHistory(ctx: ExtensionContext): void {
	const entries = ctx.sessionManager?.buildContextEntries?.();
	if (!Array.isArray(entries)) return;
	arm();
	for (const entry of entries) {
		const message = (entry as { message?: unknown } | null)?.message ?? entry;
		if ((message as { role?: string } | null)?.role === "user") noteUserMessage();
		else {
			replayMessage(message);
			// Blocks in history are all "already streamed" (they were executed long before the
			// session was saved) — the gate must be opened for them too, otherwise every rebuilt
			// line stays not-ready and the whole history vanishes from the tree.
			markMessageReady(message);
		}
	}
}

/** Native tools this extension takes over (rendering + grouping). */
const NATIVE_TOOLS = new Set(["grep", "find", "ls"]);

/**
 * Give a native read-only tool the "join the group if foldable, otherwise render as-is" rendering.
 *
 * Same technique as `read-path-collapse.ts`: the `...base` spread inherits description /
 * parameters / execute, adding only `renderShell: "self"` and the two renderers.
 * `renderShell: "self"` is required — under the default shell, `ToolExecutionComponent` keeps a
 * `Spacer(1)` alive, so a member block rendering 0 lines still leaves one blank line (the bash
 * side stepped in the same pit; see the `renderShell` comment in `bash-command-collapse.ts`).
 */
function withGroupedRendering(base: ToolDefinition, toolName: string): ToolDefinition {
	return {
		...base,
		renderShell: "self",
		renderCall(args, theme, context) {
			// Arguments still streaming (constructed with args=`{}`, filled piece by piece):
			// **draw nothing at all**; once args are complete, draw `Explored` directly. Without
			// hiding, this frame would fall back to the built-in renderer below and the screen
			// would first show a native block (`grep // in .` / `find  in .`), jumping to the
			// group only on the next frame (the user's 2026-10-06 report: "a stretch of grey text
			// streams out first, then folds"). See `shouldHideWhilePending`.
			if (shouldHideWhilePending(toolName, args, context.isPartial === true)) return EMPTY_COMPONENT;
			// Render-time fallback for opening the gate (the primary signal is `message_end` /
			// `tool_execution_end`; see `markReadyIfSettled`).
			markReadyIfSettled(context.toolCallId, context.argsComplete === true, context.isPartial === true);
			const group = ensureRegistered(context.toolCallId, toolName, args);
			if (!group) {
				// Genuinely non-foldable (e.g. reading a SKILL.md) → fall back to the built-in
				// renderer; it has its own compact shape.
				return base.renderCall?.(args, theme, context) ?? EMPTY_COMPONENT;
			}
			if (!isLeader(context.toolCallId)) return EMPTY_COMPONENT;
			setLeaderInvalidate(context.toolCallId, () => context.invalidate());
			return createGroupTree({
				groupId: context.toolCallId,
				theme,
				cwd: context.cwd,
				expanded: context.expanded === true,
			});
		},
		renderResult(result, options, theme, context) {
			// In collapsed mode **the whole group (leader included) draws no output** — the same
			// rule as the bash / read sides. Expanded mode lets each member expand its own content.
			if (!context.expanded && ensureRegistered(context.toolCallId, toolName, context.args)) {
				return EMPTY_COMPONENT;
			}
			return base.renderResult?.(result, options, theme, context) ?? EMPTY_COMPONENT;
		},
	};
}

export default function (pi: ExtensionAPI) {
	// Open the gate (see `armOnStart`): without a running session, no rendering is taken over.
	// With existing history (resume / fork / reload), replay it — those scenarios emit no
	// `message_*`, so break events can only be rebuilt here, otherwise the whole history merges
	// into one block (see `hydrateFromHistory`).
	pi.on("session_start", (_event, ctx) => {
		armOnStart();
		hydrateFromHistory(ctx);
	});

	// ── Take over rendering of the native grep / find / ls ──────────────────
	// These three tools are enabled via `defaultTools` (see
	// `clients/pi/config/settings.json`); their definitions are pi built-ins, and only the
	// rendering layer is swapped here.
	pi.registerTool(withGroupedRendering(createGrepToolDefinition(process.cwd()) as ToolDefinition, "grep"));
	pi.registerTool(withGroupedRendering(createFindToolDefinition(process.cwd()) as ToolDefinition, "find"));
	pi.registerTool(withGroupedRendering(createLsToolDefinition(process.cwd()) as ToolDefinition, "ls"));

	// ── Breaks: replay assistant messages in content order ──────────────────
	// The authoritative source. `message_update` fires repeatedly while streaming; the registry
	// deduplicates by message.
	pi.on("message_start", (event) => {
		replayMessage(event.message);
	});
	pi.on("message_update", (event) => {
		replayMessage(event.message);
	});
	pi.on("message_end", (event) => {
		if (event.message?.role === "user") noteUserMessage();
		else {
			replayMessage(event.message);
			// The moment "the command finished streaming" (user, 2026-10-07): the tool calls in
			// this message can now enter the tree. Must run after replayMessage — settle the
			// breaks and registrations first, then open the gate in one sweep.
			markMessageReady(event.message);
		}
	});

	// ── Break fallback: non-foldable tool calls ─────────────────────────────
	// Native grep/find/ls and read/bash are covered by the message replay; this guarantees that
	// **other** tools (write / edit / subagent / task_* …) also break the group.
	pi.on("tool_call", (event) => {
		if (NATIVE_TOOLS.has(event.toolName) || event.toolName === "read" || event.toolName === "bash") return;
		noteToolCall(event.toolCallId, event.toolName, event.args);
	});

	// ── Member status → the header dot's color ──────────────────────────────
	pi.on("tool_execution_end", (event) => {
		// Execution finished ⇒ arguments are necessarily final (pi cannot execute with truncated
		// args). This is the **fallback gate-opening** for `message_end`: measured paths exist
		// that never get that event (only `tool_execution_end`); without this, such a block stays
		// permanently invisible (and the model-error / Esc-interrupt paths behave the same).
		markMemberReady(event.toolCallId);
		setMemberStatus(event.toolCallId, event.isError ? "error" : "ok");
	});
}
