/**
 * pi-rewind flow — the /rewind menu.
 *
 * Mirrors Claude Code's rewind menu: pick one of the prompts you sent during
 * this session, then choose what to roll back.
 *
 *   Restore code and conversation   → files + session tree back to that point
 *   Restore conversation            → session tree only (pi puts the prompt
 *                                     text back into the editor, same as
 *                                     Claude Code)
 *   Restore code                    → files only — the worktree changed since
 *                                     the checkpoint, plus the pre-images of
 *                                     files the agent edited outside the
 *                                     project root (or in an ignored path)
 *   Summarize from here             → compress everything after that point
 *                                     into a branch summary (pi's native
 *                                     navigateTree summarization)
 *   Never mind                      → back out
 *
 * Claude Code's "Summarize up to here" has no pi equivalent (pi can summarize
 * an abandoned branch or compact the whole context, but not "everything before
 * an entry while keeping later messages"), so it is not offered.
 *
 * The checkpoint picker itself lives in picker.ts: pi's built-in
 * `ctx.ui.select()` renders every row at once, which pushes the cursor row out
 * of the viewport once a session has enough checkpoints. `deps.pick` is the
 * seam — index.ts passes the scrolling picker, hosts that cannot render
 * extension components fall back to `ctx.ui.select()` here.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  type Checkpoint,
  type CheckpointDiff,
  type ExternalFile,
  type RewindStore,
  captureFileStates,
  createCheckpoint,
  deleteCheckpoint,
  diffExternalFiles,
  diffTrees,
  externalRestorePlan,
  latestSafetyCheckpoint,
  listCheckpoints,
  mergeDiffs,
  restoreCheckpoint,
  snapshotTree,
  summarizeDiff,
} from "./checkpoints.ts";

/** Longest prompt snippet shown in the picker. */
const PROMPT_SNIPPET_LENGTH = 60;
/** How many changed paths the confirmation dialog lists before truncating. */
const MAX_DIFF_LINES = 15;
/** Title of the checkpoint picker dialog. */
export const PICKER_TITLE = "Rewind to a checkpoint";

/** Values the picker hands back: the two synthetic rows, plus `cp:<index>`. */
const UNDO_VALUE = "undo";
const NEVER_MIND_VALUE = "never-mind";
const CHECKPOINT_VALUE_PREFIX = "cp:";

export const UNDO_LABEL = "↩ Undo last rewind (restore files from before it)";
export const NEVER_MIND_LABEL = "Never mind";

export interface RewindFlowDeps {
  store: RewindStore;
  sessionId: string;
  /**
   * Scrollable picker, wired up by index.ts to `pickFromList` (picker.ts).
   * Omitted in tests and on hosts that cannot render extension components —
   * `pickValue` then uses `ctx.ui.select()`, which renders every row at once.
   */
  pick?: Picker;
}

/** One row of the picker. `value` is what the flow acts on, `label` is shown. */
export interface PickerItem {
  value: string;
  label: string;
}

export type PickOutcome =
  | { status: "picked"; value: string }
  | { status: "cancelled" }
  | { status: "unsupported" };

export type Picker = (
  ctx: ExtensionCommandContext,
  title: string,
  items: PickerItem[],
) => Promise<PickOutcome>;

/** Labels for the picker, oldest → newest index numbering. */
export function formatCheckpointLabel(checkpoint: Checkpoint, position: number): string {
  const time = formatTime(checkpoint.timestamp);
  if (checkpoint.kind === "session-start") return `#${position}  ${time}  Session start`;
  if (checkpoint.kind === "safety") return `#${position}  ${time}  Before a rewind`;
  const snippet = snippetOf(checkpoint.prompt);
  return `#${position}  ${time}  ${snippet}`;
}

export function snippetOf(prompt: string): string {
  const firstLine = (prompt || "").split("\n")[0]?.trim() ?? "";
  if (!firstLine) return "(empty prompt)";
  if (firstLine.length <= PROMPT_SNIPPET_LENGTH) return firstLine;
  return `${firstLine.slice(0, PROMPT_SNIPPET_LENGTH - 1)}…`;
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Render a diff as the lines shown in the restore confirmation dialog. */
export function formatDiffPreview(diff: CheckpointDiff): string {
  if (diff.empty) return "No file changes.";
  const lines = diff.entries.slice(0, MAX_DIFF_LINES).map((entry) => `  ${statusGlyph(entry.status)} ${entry.path}`);
  if (diff.entries.length > MAX_DIFF_LINES) {
    lines.push(`  … and ${diff.entries.length - MAX_DIFF_LINES} more`);
  }
  lines.unshift(`  ${summarizeDiff(diff)}`);
  return lines.join("\n");
}

function statusGlyph(status: string): string {
  switch (status) {
    case "A":
      return "+";
    case "D":
      return "-";
    default:
      return "~";
  }
}

export interface ActionChoice {
  label: string;
  action: "code-and-conversation" | "conversation" | "code" | "summarize" | "cancel";
}

/**
 * Build the action menu for a selected checkpoint. Code options only appear
 * when there are file changes to revert, matching Claude Code.
 */
export function buildActions(diff: CheckpointDiff, hasConversationTarget: boolean): ActionChoice[] {
  const choices: ActionChoice[] = [];
  const canRestoreCode = !diff.empty;

  if (canRestoreCode && hasConversationTarget) {
    choices.push({ label: "Restore code and conversation", action: "code-and-conversation" });
  }
  if (hasConversationTarget) {
    choices.push({ label: "Restore conversation (keep current files)", action: "conversation" });
  }
  if (canRestoreCode) {
    choices.push({ label: "Restore code (keep conversation)", action: "code" });
  }
  if (hasConversationTarget) {
    choices.push({ label: "Summarize from here (frees context)", action: "summarize" });
  }
  choices.push({ label: NEVER_MIND_LABEL, action: "cancel" });
  return choices;
}

/**
 * Picker rows, in display order: the undo entry, then every checkpoint newest
 * first (the order the index numbering already implies), then "Never mind".
 * Claude Code's menu ends with that explicit row; Esc cancels too.
 */
export function buildPickerItems(targets: Checkpoint[], hasUndo: boolean): PickerItem[] {
  const items: PickerItem[] = [];
  if (hasUndo) items.push({ value: UNDO_VALUE, label: UNDO_LABEL });
  for (let i = targets.length - 1; i >= 0; i -= 1) {
    items.push({
      value: `${CHECKPOINT_VALUE_PREFIX}${i}`,
      label: formatCheckpointLabel(targets[i], i + 1),
    });
  }
  items.push({ value: NEVER_MIND_VALUE, label: NEVER_MIND_LABEL });
  return items;
}

/**
 * Ask for a row. The scrollable picker keeps a long checkpoint list inside the
 * viewport; a host that cannot render extension components (RPC, print) — and
 * the test harness — gets pi's plain `ctx.ui.select()` instead, where every row
 * is rendered at once.
 */
async function pickValue(
  ctx: ExtensionCommandContext,
  deps: RewindFlowDeps,
  items: PickerItem[],
): Promise<string | undefined> {
  const outcome: PickOutcome = deps.pick
    ? await deps.pick(ctx, PICKER_TITLE, items)
    : { status: "unsupported" };
  if (outcome.status === "picked") return outcome.value;
  if (outcome.status === "cancelled") return undefined;

  const label = await ctx.ui.select(
    PICKER_TITLE,
    items.map((item) => item.label),
  );
  if (label === undefined) return undefined;
  return items.find((item) => item.label === label)?.value;
}

/**
 * Run the whole rewind flow. Returns a short human-readable outcome so the
 * caller can log it; all user-facing messaging happens here.
 */
export async function runRewindFlow(
  ctx: ExtensionCommandContext,
  deps: RewindFlowDeps,
): Promise<string> {
  const { store, sessionId } = deps;
  // Oldest → newest; the menu renders them newest first.
  const targets = listCheckpoints(store, sessionId).filter((cp) => cp.kind !== "safety");

  if (targets.length === 0) {
    ctx.ui.notify("No checkpoints yet for this session", "warning");
    return "no checkpoints";
  }

  const safety = latestSafetyCheckpoint(store, sessionId);
  const items = buildPickerItems(targets, Boolean(safety));
  const picked = await pickValue(ctx, deps, items);
  if (picked === undefined || picked === NEVER_MIND_VALUE) return "cancelled";

  if (picked === UNDO_VALUE) {
    if (!safety) return "cancelled";
    return undoLastRewind(ctx, store, safety);
  }

  if (!picked.startsWith(CHECKPOINT_VALUE_PREFIX)) return "cancelled";
  const index = Number(picked.slice(CHECKPOINT_VALUE_PREFIX.length));
  if (!Number.isInteger(index) || index < 0 || index >= targets.length) return "cancelled";
  const target = targets[index];
  const position = index + 1;

  // What would a code restore actually change? The worktree diff covers the
  // project; the pre-image plan covers the files it cannot see.
  const files: ExternalFile[] = externalRestorePlan(targets, index);
  const currentTree = await snapshotTree(store);
  const diff = mergeDiffs(
    await diffTrees(store, target.tree, currentTree),
    diffExternalFiles(store, files),
  );
  const hasConversationTarget = Boolean(target.entryId);

  const actions = buildActions(diff, hasConversationTarget);
  const actionLabel = await ctx.ui.select(
    `#${position}  ${snippetOf(target.prompt)}  ·  ${summarizeDiff(diff)}`,
    actions.map((choice) => choice.label),
  );
  if (!actionLabel) return "cancelled";

  const choice = actions.find((candidate) => candidate.label === actionLabel);
  if (!choice || choice.action === "cancel") return "cancelled";

  const restoreCode = choice.action === "code-and-conversation" || choice.action === "code";
  const restoreConversation =
    choice.action === "code-and-conversation" || choice.action === "conversation";

  if (restoreCode) {
    const confirmed = await ctx.ui.confirm(
      "Restore code",
      `Roll the working tree back to checkpoint #${position}?\n\n${formatDiffPreview(diff)}\n\nFiles created after that point are deleted, and files the agent edited outside the project (or in an ignored path) are put back too. Ignored files nobody touched (node_modules, build output) are kept, and your git history is untouched.`,
    );
    if (!confirmed) return "cancelled";

    // Undo net: snapshot the state we are about to replace.
    try {
      await createCheckpoint(store, {
        sessionId,
        kind: "safety",
        tree: currentTree,
        files: captureFileStates(store, files),
      });
    } catch {
      // Without a safety checkpoint the rewind still proceeds; only the undo
      // entry is missing.
    }

    try {
      const result = await restoreCheckpoint(store, target, { files });
      ctx.ui.notify(
        `Restored files to checkpoint #${position} (${summarizeDiff(diff)}${
          result.removed.length > 0 ? `, removed ${result.removed.length} newer file(s)` : ""
        })`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`Restore failed: ${errorMessage(error)}`, "error");
      return "restore failed";
    }
  }

  if (restoreConversation) {
    const outcome = await rewindConversation(ctx, target.entryId!, false);
    if (outcome !== "ok") return outcome;
  } else if (choice.action === "summarize") {
    const outcome = await rewindConversation(ctx, target.entryId!, true);
    if (outcome !== "ok") return outcome;
  }

  if (choice.action === "summarize") return "summarized";
  if (restoreCode && restoreConversation) return "restored code and conversation";
  if (restoreCode) return "restored code";
  return "restored conversation";
}

/** Navigate the session tree to a checkpoint's user message. */
async function rewindConversation(
  ctx: ExtensionCommandContext,
  entryId: string,
  summarize: boolean,
): Promise<string> {
  try {
    const result = await ctx.navigateTree(entryId, { summarize });
    if (result.cancelled) return "cancelled";
    return "ok";
  } catch (error) {
    ctx.ui.notify(`Conversation rewind failed: ${errorMessage(error)}`, "error");
    return "conversation rewind failed";
  }
}

/** Restore the files captured right before the previous rewind. */
async function undoLastRewind(
  ctx: ExtensionCommandContext,
  store: RewindStore,
  safety: Checkpoint,
): Promise<string> {
  const confirmed = await ctx.ui.confirm(
    "Undo last rewind",
    "Put the files back the way they were before the last rewind?",
  );
  if (!confirmed) return "cancelled";

  try {
    // The safety checkpoint carries its own pre-images, so the worktree reset
    // and the outside-project files it is meant to restore both come from it.
    const result = await restoreCheckpoint(store, safety);
    await deleteCheckpoint(store, safety);
    ctx.ui.notify(
      `Undid the last rewind${result.removed.length > 0 ? ` (removed ${result.removed.length} file(s))` : ""}`,
      "info",
    );
    return "undid last rewind";
  } catch (error) {
    ctx.ui.notify(`Undo failed: ${errorMessage(error)}`, "error");
    return "undo failed";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
