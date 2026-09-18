/**
 * pi-rewind — Claude Code style checkpointing and /rewind for pi.
 *
 * What it does
 *   - Snapshots the working tree before every user prompt that starts a turn
 *     (Claude Code's checkpoint model), stored on a shadow git repository under
 *     ~/.pi/agent/rewind/<project>/git — the project's own git history, index
 *     and refs are never touched.
 *   - Catches the files that snapshot cannot see: anything an `edit`/`write`
 *     tool touches outside the project root (or inside it but `.gitignore`d,
 *     or under a nested repo) is copied into a pre-image blob right before the
 *     tool runs, so a rewind restores those too.
 *   - `/rewind` (or Esc twice at an empty prompt) opens the rewind menu:
 *     restore code and conversation, restore conversation, restore code,
 *     summarize from here, never mind.
 *   - Conversation restore uses pi's native session-tree navigation, which
 *     drops the selected user message and puts its text back into the editor —
 *     exactly what Claude Code does.
 *
 * Esc + Esc
 *   pi's built-in double-escape action (`doubleEscapeAction` in settings.json,
 *   default "tree") is replaced by this extension. Set it to "none" so the
 *   built-in tree navigator no longer fires:
 *
 *     { "doubleEscapeAction": "none" }
 *
 *   The extension then counts two raw Esc presses within 500 ms while the agent
 *   is idle and the editor is empty, and dispatches /rewind. Escapes are never
 *   consumed, so Esc still aborts streaming, aborts a running `!` bash command
 *   and cancels dialogs exactly as before. When the setting is not "none" the
 *   extension warns once at session start.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_CHECKPOINTS_PER_SESSION,
  type RewindStore,
  attachEntryId,
  captureExternalFile,
  createCheckpoint,
  gc,
  listCheckpoints,
  openStore,
  pruneSession,
  pruneStaleSessions,
} from "./checkpoints.ts";
import { runRewindFlow } from "./flow.ts";
import { pickFromList } from "./picker.ts";

/** Claude Code / pi both use a 500 ms double-escape window. */
const DOUBLE_ESCAPE_WINDOW_MS = 500;
const STATUS_KEY = "rewind";

interface RewindState {
  store: RewindStore | null;
  sessionId: string | null;
  /** Reason the store could not be opened; reported once, then silent. */
  disabledReason: string | null;
  /** Latest context, used by the raw-input handler (it receives no ctx). */
  ctx: ExtensionContext | null;
  /** True while an extension dialog is open (ui_prompt_start/end). */
  dialogOpen: boolean;
  /** Timestamp of the previous bare Esc press, 0 when the window expired. */
  lastEscapeAt: number;
  /** Serializes every git operation that touches the shadow index. */
  queue: Promise<unknown>;
  /** Guards against repeating the doubleEscapeAction warning. */
  warnedAboutSetting: boolean;
}

export default function (pi: ExtensionAPI) {
  const state: RewindState = {
    store: null,
    sessionId: null,
    disabledReason: null,
    ctx: null,
    dialogOpen: false,
    lastEscapeAt: 0,
    queue: Promise.resolve(),
    warnedAboutSetting: false,
  };

  /** Run git work one job at a time: two concurrent `git add` calls on the
   *  same shadow index would corrupt it. */
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = state.queue.then(task, task);
    state.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!state.store || !state.sessionId) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const count = listCheckpoints(state.store, state.sessionId).length;
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(
      STATUS_KEY,
      `${theme.fg("dim", "◆")} ${theme.fg("muted", `${count} checkpoint${count === 1 ? "" : "s"}`)}`,
    );
  }

  // ===========================================================================
  // Session lifecycle
  // ===========================================================================

  pi.on("session_start", async (_event, ctx) => {
    state.ctx = ctx;
    state.dialogOpen = false;
    state.lastEscapeAt = 0;

    const sessionId = ctx.sessionManager.getSessionId();
    state.sessionId = sessionId;

    try {
      state.store = openStore(ctx.cwd, getAgentDir());
      state.disabledReason = null;
    } catch (error) {
      state.store = null;
      state.disabledReason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Rewind unavailable: ${state.disabledReason}`, "warning");
      return;
    }

    // Esc+Esc replaces pi's built-in double-escape action; warn when the
    // setting still points at the tree navigator.
    warnIfDoubleEscapeStillBuiltIn(ctx);

    const store = state.store;
    const resumeCheckpointCount = listCheckpoints(store, sessionId).length;

    // Snapshot the state the session starts from. Not awaited: a cold shadow
    // index on a large repo can take seconds and must not delay startup.
    serialized(async () => {
      await createCheckpoint(store, { sessionId, kind: "session-start" });
      await pruneSession(store, sessionId, MAX_CHECKPOINTS_PER_SESSION);
      if (ctx.hasUI) updateStatus(ctx);
    }).catch(() => undefined);

    // Retention sweep + gc in the background.
    serialized(async () => {
      const swept = await pruneStaleSessions(store);
      if (swept > 0) await gc(store);
      if (resumeCheckpointCount > 0 && ctx.hasUI) updateStatus(ctx);
    }).catch(() => undefined);

    attachInputListener(ctx);
  });

  pi.on("session_shutdown", async () => {
    // Let in-flight checkpoint work finish before pi tears the session down.
    await state.queue.catch(() => undefined);
  });

  // ===========================================================================
  // Checkpoints: one per user prompt, taken before the turn runs
  // ===========================================================================

  /**
   * `message_end` for the user message is the moment pi records a prompt, and
   * it happens before any tool of that turn executes — so the snapshot really
   * is "the code as it was when you sent this". It also covers follow-up and
   * steered prompts, which `before_agent_start` never sees.
   *
   * The user entry itself only lands in the session tree a little later (pi
   * appends it while the assistant message is recorded), so the conversation
   * target is attached on the assistant message / turn end instead. Matching by
   * prompt text keeps multiple pending prompts apart.
   */
  pi.on("message_end", async (event, ctx) => {
    state.ctx = ctx;
    const role = event.message?.role;
    if (role !== "user" && role !== "assistant") return;
    if (!state.store || !state.sessionId) return;

    if (role === "user") {
      const prompt = messageText(event.message.content);
      const store = state.store;
      const sessionId = state.sessionId;
      // Awaited on purpose: the snapshot must be complete before this turn's
      // first tool can touch the working tree.
      await serialized(async () => {
        await createCheckpoint(store, { sessionId, kind: "prompt", prompt });
        await pruneSession(store, sessionId, MAX_CHECKPOINTS_PER_SESSION);
        if (ctx.hasUI) updateStatus(ctx);
      }).catch(() => undefined);
      return;
    }

    resolveEntryIds(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    state.ctx = ctx;
    resolveEntryIds(ctx);
  });

  function resolveEntryIds(ctx: ExtensionContext): void {
    const store = state.store;
    const sessionId = state.sessionId;
    if (!store || !sessionId) return;

    const all = listCheckpoints(store, sessionId);
    const unresolved = all.filter((cp) => cp.kind === "prompt" && !cp.entryId);
    if (unresolved.length === 0) return;

    const usedEntryIds = new Set(
      all.filter((cp) => cp.entryId).map((cp) => cp.entryId as string),
    );
    const branch = ctx.sessionManager.getBranch();

    for (const checkpoint of unresolved) {
      for (let i = branch.length - 1; i >= 0; i -= 1) {
        const entry = branch[i];
        if (entry.type !== "message") continue;
        if (entry.message.role !== "user") continue;
        if (usedEntryIds.has(entry.id)) continue;
        if (messageText(entry.message.content) !== checkpoint.prompt) continue;
        attachEntryId(store, sessionId, checkpoint.id, entry.id);
        usedEntryIds.add(entry.id);
        break;
      }
    }
  }

  // ===========================================================================
  // Pre-images: files the worktree snapshot cannot see
  // ===========================================================================

  /**
   * Fires after `tool_execution_start` and before the tool runs, which is the
   * only moment the old bytes are still on disk. Only the built-in file editors
   * are tracked — a `bash` command (`sed -i`, `cat >`) can touch anything and
   * is not parseable, so inside the project root those changes are still caught
   * by the worktree snapshot while edits *outside* the root are not.
   */
  pi.on("tool_call", async (event, ctx) => {
    state.ctx = ctx;
    if (!state.store || !state.sessionId) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const path = (event.input as { path?: unknown } | undefined)?.path;
    if (typeof path !== "string" || path === "") return;

    const store = state.store;
    const sessionId = state.sessionId;
    // Serialized with the checkpoint writes: both rewrite the metadata file.
    // Awaited, so the copy is complete before the tool can change the file.
    await serialized(async () => {
      captureExternalFile(store, sessionId, path);
    }).catch(() => undefined);
  });

  // ===========================================================================
  // /rewind
  // ===========================================================================

  pi.registerCommand("rewind", {
    description: "Rewind code and/or conversation to an earlier prompt (Claude Code style)",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      state.ctx = ctx;
      // Ignore Esc presses while the menu dialogs are open.
      state.dialogOpen = true;
      state.lastEscapeAt = 0;
      try {
        if (!state.store || !state.sessionId) {
          ctx.ui.notify(
            state.disabledReason
              ? `Rewind unavailable: ${state.disabledReason}`
              : "Rewind is not ready yet",
            "warning",
          );
          return;
        }
        // Late resolution attempt for prompts whose entry id is still missing.
        resolveEntryIds(ctx);
        await runRewindFlow(ctx, {
          store: state.store,
          sessionId: state.sessionId,
          // Scrollable picker: pi's built-in select renders every row, which
          // pushes the cursor out of the viewport on long sessions.
          pick: pickFromList,
        });
        if (ctx.hasUI) updateStatus(ctx);
      } finally {
        state.dialogOpen = false;
        state.lastEscapeAt = 0;
      }
    },
  });

  // ===========================================================================
  // Esc + Esc
  // ===========================================================================

  pi.on("ui_prompt_start", async () => {
    state.dialogOpen = true;
  });

  pi.on("ui_prompt_end", async () => {
    state.dialogOpen = false;
    state.lastEscapeAt = 0;
  });

  let inputUnsubscribe: (() => void) | null = null;

  function attachInputListener(ctx: ExtensionContext): void {
    if (inputUnsubscribe) return;
    inputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      // A bare Esc is exactly "\x1b"; arrow keys and other sequences are longer
      // and must not count towards a double press.
      if (data !== "\x1b") {
        state.lastEscapeAt = 0;
        return undefined;
      }
      // Never consume: Esc keeps aborting streams, `!` bash runs and dialogs.
      if (state.dialogOpen) return undefined;
      const current = state.ctx;
      if (!current || !current.isIdle()) return undefined;
      if (current.ui.getEditorText().trim() !== "") return undefined;

      const now = Date.now();
      if (now - state.lastEscapeAt <= DOUBLE_ESCAPE_WINDOW_MS) {
        state.lastEscapeAt = 0;
        dispatchRewind();
        // Consume this second press. Two reasons: the selector opened by
        // dispatchRewind() is focused synchronously, so an unconsumed Esc would
        // land on it and cancel the menu it just opened; and consuming keeps
        // the press from pi's built-in double-escape action, so /rewind takes
        // over even when `doubleEscapeAction` is still "tree" or "fork".
        return { consume: true };
      }
      // The first press is passed through untouched, so a lone Esc still
      // aborts streams, aborts `!` bash runs and cancels dialogs.
      state.lastEscapeAt = now;
      return undefined;
    });
  }

  /**
   * Dispatch the /rewind command through pi's own command path, so the handler
   * receives a command context (with navigateTree) — a shortcut or raw-input
   * handler only ever gets a plain context.
   */
  function dispatchRewind(): void {
    try {
      pi.sendUserMessage("/rewind", { expandPromptTemplates: true });
    } catch (error) {
      state.ctx?.ui.notify(
        `Could not open /rewind: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }

  function warnIfDoubleEscapeStillBuiltIn(ctx: ExtensionContext): void {
    if (state.warnedAboutSetting || !ctx.hasUI) return;
    state.warnedAboutSetting = true;
    try {
      const settingsPath = join(getAgentDir(), "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        doubleEscapeAction?: string;
      };
      const action = settings.doubleEscapeAction ?? "tree";
      if (action !== "none") {
        ctx.ui.notify(
          `Esc+Esc still opens pi's ${action} view. Set "doubleEscapeAction": "none" in ${settingsPath} to let /rewind take over.`,
          "warning",
        );
      }
    } catch {
      // No readable settings file — nothing to warn about.
    }
  }
}

/** Plain text of a message's content (string or content parts). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}
