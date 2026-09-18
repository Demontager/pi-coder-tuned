/**
 * Tests for the /rewind menu flow, driven by a scripted mock command context.
 *
 * Run with:  node --test ~/.pi/agent/extensions/rewind/flow.test.ts
 *
 * The TUI dialogs cannot be exercised headlessly, so `ctx.ui.select` /
 * `ctx.ui.confirm` are replaced with a queue of canned answers, and the
 * scrollable picker (`deps.pick`, see picker.ts) with `scriptedPicker` below.
 * Every side effect (notify text, navigateTree calls, files on disk) is
 * asserted.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  type Checkpoint,
  captureExternalFile,
  createCheckpoint,
  latestSafetyCheckpoint,
  listCheckpoints,
  openStore,
  snapshotTree,
  type RewindStore,
} from "./checkpoints.ts";
import {
  NEVER_MIND_LABEL,
  UNDO_LABEL,
  buildActions,
  buildPickerItems,
  formatCheckpointLabel,
  formatDiffPreview,
  formatTime,
  runRewindFlow,
  snippetOf,
  type PickOutcome,
  type Picker,
  type PickerItem,
} from "./flow.ts";

const created: string[] = [];

interface MockCtx {
  ctx: any;
  selects: string[];
  confirms: boolean[];
  notifications: Array<{ message: string; type?: string }>;
  navigations: Array<{ targetId: string; summarize: boolean }>;
  selectTitles: string[];
  selectOptionLists: string[][];
  confirmations: Array<{ title: string; message: string }>;
}

/** Mock command context whose dialogs answer from a script. */
function mockCtx(options: { selects?: string[]; confirms?: boolean[] } = {}): MockCtx {
  const state: MockCtx = {
    selects: [...(options.selects ?? [])],
    confirms: [...(options.confirms ?? [])],
    notifications: [],
    navigations: [],
    selectTitles: [],
    selectOptionLists: [],
    confirmations: [],
    ctx: null as any,
  };

  state.ctx = {
    hasUI: true,
    ui: {
      select: async (title: string, optionsList: string[]) => {
        state.selectTitles.push(title);
        state.selectOptionLists.push(optionsList);
        return state.selects.length > 0 ? state.selects.shift() : undefined;
      },
      confirm: async (title: string, message: string) => {
        state.confirmations.push({ title, message });
        return state.confirms.length > 0 ? state.confirms.shift() : false;
      },
      notify: (message: string, type?: string) => state.notifications.push({ message, type }),
      theme: { fg: (_slot: string, text: string) => text },
    },
    navigateTree: async (targetId: string, opts?: { summarize?: boolean }) => {
      state.navigations.push({ targetId, summarize: Boolean(opts?.summarize) });
      return { cancelled: false };
    },
  };

  return state;
}

/**
 * Scripted `deps.pick`: answers from a queue and records the rows it was
 * offered. A bare string means "the user picked the row with this label" — the
 * same thing a human does — so tests never hardcode the row-value encoding; an
 * explicit `PickOutcome` stands in for the other statuses.
 */
function scriptedPicker(answers: Array<PickOutcome | string>): {
  pick: Picker;
  offered: Array<{ title: string; items: PickerItem[] }>;
} {
  const offered: Array<{ title: string; items: PickerItem[] }> = [];
  const pick: Picker = async (_ctx, title, items) => {
    offered.push({ title, items });
    const answer = answers.shift();
    if (answer === undefined) return { status: "cancelled" };
    if (typeof answer !== "string") return answer;
    const item = items.find((candidate) => candidate.label === answer);
    assert.ok(item, `picker was not offered a row labelled ${answer}`);
    return { status: "picked", value: item.value };
  };
  return { pick, offered };
}

function fixture(): { root: string; store: RewindStore } {
  const base = mkdtempSync(join(tmpdir(), "pi-rewind-flow-"));
  created.push(base);
  const root = join(base, "project");
  const agentDir = join(base, "agent");
  mkdirSync(root, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { root, store: openStore(root, agentDir) };
}

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

/**
 * Two checkpoints plus the edits the second prompt's turn made afterwards.
 * Mirrors the real flow: a checkpoint is taken *before* the turn runs, so its
 * tree is the pre-edit state while the worktree now holds the edits.
 */
async function twoCheckpoints(
  root: string,
  store: RewindStore,
  sessionId = "sess",
): Promise<{ first: Checkpoint; second: Checkpoint }> {
  write(root, "a.txt", "v1\n");
  const first = await createCheckpoint(store, {
    sessionId,
    kind: "session-start",
    timestamp: 1_700_000_000_000,
  });
  const second = await createCheckpoint(store, {
    sessionId,
    kind: "prompt",
    prompt: "please change a.txt",
    entryId: "entry-2",
    timestamp: 1_700_000_060_000,
  });
  // The turn's tool then edits the file.
  write(root, "a.txt", "v2\n");
  return { first, second };
}

describe("formatting helpers", () => {
  it("renders labels, snippets and times", () => {
    const checkpoint: Checkpoint = {
      id: "x",
      sessionId: "s",
      kind: "prompt",
      prompt: "first line\nsecond line",
      tree: "t",
      commit: "c",
      timestamp: new Date(2026, 8, 14, 9, 5).getTime(),
    };
    assert.equal(formatCheckpointLabel(checkpoint, 3), `#3  ${formatTime(checkpoint.timestamp)}  first line`);
    assert.equal(snippetOf("first line\nsecond line"), "first line");
    assert.equal(snippetOf(""), "(empty prompt)");
    assert.equal(snippetOf("x".repeat(80)).length, 60);
    assert.match(snippetOf("x".repeat(80)), /…$/);

    const sessionStart: Checkpoint = { ...checkpoint, kind: "session-start", prompt: "" };
    assert.match(formatCheckpointLabel(sessionStart, 1), /Session start$/);
    const safety: Checkpoint = { ...checkpoint, kind: "safety", prompt: "" };
    assert.match(formatCheckpointLabel(safety, 2), /Before a rewind$/);
  });

  it("offers code actions only when there are file changes", () => {
    const changed = { entries: [{ status: "M" as const, path: "a.txt" }], empty: false };
    const unchanged = { entries: [], empty: true };

    assert.deepEqual(
      buildActions(changed, true).map((choice) => choice.label),
      [
        "Restore code and conversation",
        "Restore conversation (keep current files)",
        "Restore code (keep conversation)",
        "Summarize from here (frees context)",
        NEVER_MIND_LABEL,
      ],
    );
    // Claude Code hides the code options when nothing would be reverted.
    assert.deepEqual(
      buildActions(unchanged, true).map((choice) => choice.label),
      [
        "Restore conversation (keep current files)",
        "Summarize from here (frees context)",
        NEVER_MIND_LABEL,
      ],
    );
    // Without a conversation target only the code path remains.
    assert.deepEqual(
      buildActions(changed, false).map((choice) => choice.label),
      ["Restore code (keep conversation)", NEVER_MIND_LABEL],
    );
    assert.deepEqual(buildActions(unchanged, false).map((choice) => choice.label), [NEVER_MIND_LABEL]);
  });

  it("previews a diff and truncates long ones", () => {
    assert.equal(formatDiffPreview({ entries: [], empty: true }), "No file changes.");

    const entries = Array.from({ length: 20 }, (_unused, i) => ({
      status: i === 0 ? "A" : i === 1 ? "D" : "M",
      path: `file${i}.txt`,
    }));
    const preview = formatDiffPreview({ entries, empty: false });
    assert.match(preview, /20 files: \+1 ~18 -1/);
    assert.match(preview, /\+ file0\.txt/);
    assert.match(preview, /- file1\.txt/);
    assert.match(preview, /… and 5 more/);
    // summary + 15 listed paths + truncation note
    assert.equal(preview.split("\n").length, 17);
  });
});

describe("buildPickerItems", () => {
  const checkpoint = (id: string, timestamp: number): Checkpoint => ({
    id,
    sessionId: "sess",
    kind: "prompt",
    prompt: `prompt ${id}`,
    tree: "tree",
    commit: "commit",
    timestamp,
  });

  it("lists checkpoints newest first, between the undo and Never mind rows", () => {
    const oldest = checkpoint("a", 1_700_000_000_000);
    const middle = checkpoint("b", 1_700_000_060_000);
    const newest = checkpoint("c", 1_700_000_120_000);

    const items = buildPickerItems([oldest, middle, newest], true);

    assert.equal(items[0].label, UNDO_LABEL);
    assert.equal(items.at(-1)!.label, NEVER_MIND_LABEL);
    assert.deepEqual(
      items.slice(1, -1).map((item) => item.label),
      [
        formatCheckpointLabel(newest, 3),
        formatCheckpointLabel(middle, 2),
        formatCheckpointLabel(oldest, 1),
      ],
    );
    // Values address the oldest → newest array the flow indexes into.
    assert.deepEqual(items.slice(1, -1).map((item) => item.value), ["cp:2", "cp:1", "cp:0"]);
  });

  it("omits the undo row when there is nothing to undo", () => {
    const only = checkpoint("a", 1);
    const items = buildPickerItems([only], false);

    assert.deepEqual(items.map((item) => item.label), [
      formatCheckpointLabel(only, 1),
      NEVER_MIND_LABEL,
    ]);
  });
});

describe("runRewindFlow", () => {
  afterEach(() => {
    while (created.length > 0) {
      rmSync(created.pop()!, { recursive: true, force: true });
    }
  });

  it("reports when the session has no checkpoints", async () => {
    const { store } = fixture();
    const mock = mockCtx();

    const outcome = await runRewindFlow(mock.ctx, { store, sessionId: "empty" });

    assert.equal(outcome, "no checkpoints");
    assert.deepEqual(mock.selectTitles, []);
    assert.deepEqual(mock.notifications, [{ message: "No checkpoints yet for this session", type: "warning" }]);
  });

  it("lists checkpoints newest first and backs out on Never mind", async () => {
    const { root, store } = fixture();
    await twoCheckpoints(root, store);
    const mock = mockCtx({ selects: [`#2  ${formatTime(1_700_000_060_000)}  please change a.txt`, NEVER_MIND_LABEL] });

    const outcome = await runRewindFlow(mock.ctx, { store, sessionId: "sess" });

    assert.equal(outcome, "cancelled");
    assert.equal(mock.selectTitles[0], "Rewind to a checkpoint");
    assert.deepEqual(mock.selectOptionLists[0], [
      `#2  ${formatTime(1_700_000_060_000)}  please change a.txt`,
      `#1  ${formatTime(1_700_000_000_000)}  Session start`,
      NEVER_MIND_LABEL,
    ]);
    assert.deepEqual(mock.navigations, []);
  });

  it("backs out when the picker is dismissed", async () => {
    const { root, store } = fixture();
    await twoCheckpoints(root, store);
    const mock = mockCtx({ selects: [] });

    assert.equal(await runRewindFlow(mock.ctx, { store, sessionId: "sess" }), "cancelled");
    assert.deepEqual(mock.navigations, []);
  });

  it("restores code and conversation together", async () => {
    const { root, store } = fixture();
    const { second } = await twoCheckpoints(root, store);
    write(root, "b.txt", "created after the checkpoint\n");
    const treeBeforeRewind = await snapshotTree(store);

    const mock = mockCtx({
      selects: [
        `#2  ${formatTime(second.timestamp)}  please change a.txt`,
        "Restore code and conversation",
      ],
      confirms: [true],
    });

    const outcome = await runRewindFlow(mock.ctx, { store, sessionId: "sess" });

    assert.equal(outcome, "restored code and conversation");
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "v1\n");
    assert.equal(existsSync(join(root, "b.txt")), false);
    assert.deepEqual(mock.navigations, [{ targetId: "entry-2", summarize: false }]);
    // The pre-restore state is kept as the undo net.
    assert.equal(latestSafetyCheckpoint(store, "sess")?.tree, treeBeforeRewind);
    assert.match(mock.notifications[0].message, /Restored files to checkpoint #2/);
  });

  it("restores the conversation only and leaves files alone", async () => {
    const { root, store } = fixture();
    const { second } = await twoCheckpoints(root, store);

    const mock = mockCtx({
      selects: [
        `#2  ${formatTime(second.timestamp)}  please change a.txt`,
        "Restore conversation (keep current files)",
      ],
    });

    const outcome = await runRewindFlow(mock.ctx, { store, sessionId: "sess" });

    assert.equal(outcome, "restored conversation");
    assert.deepEqual(mock.navigations, [{ targetId: "entry-2", summarize: false }]);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "v2\n");
    assert.equal(latestSafetyCheckpoint(store, "sess"), undefined);
    // Picker + action menu, nothing else.
    assert.equal(mock.selectTitles.length, 2);
  });

  it("restores code only and keeps the conversation", async () => {
    const { root, store } = fixture();
    const { first } = await twoCheckpoints(root, store);

    const mock = mockCtx({
      selects: [`#1  ${formatTime(first.timestamp)}  Session start`, "Restore code (keep conversation)"],
      confirms: [true],
    });

    const outcome = await runRewindFlow(mock.ctx, { store, sessionId: "sess" });

    assert.equal(outcome, "restored code");
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "v1\n");
    assert.deepEqual(mock.navigations, []);
  });

  it("summarizes from the selected point", async () => {
    const { root, store } = fixture();
    const { second } = await twoCheckpoints(root, store);

    const mock = mockCtx({
      selects: [
        `#2  ${formatTime(second.timestamp)}  please change a.txt`,
        "Summarize from here (frees context)",
      ],
    });

    const outcome = await runRewindFlow(mock.ctx, { store, sessionId: "sess" });

    assert.equal(outcome, "summarized");
    assert.deepEqual(mock.navigations, [{ targetId: "entry-2", summarize: true }]);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "v2\n");
  });

  it("does not touch files when the restore confirmation is declined", async () => {
    const { root, store } = fixture();
    const { second } = await twoCheckpoints(root, store);

    const mock = mockCtx({
      selects: [
        `#2  ${formatTime(second.timestamp)}  please change a.txt`,
        "Restore code (keep conversation)",
      ],
      confirms: [false],
    });

    const outcome = await runRewindFlow(mock.ctx, { store, sessionId: "sess" });

    assert.equal(outcome, "cancelled");
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "v2\n");
    assert.deepEqual(mock.navigations, []);
    assert.equal(latestSafetyCheckpoint(store, "sess"), undefined);
  });

  it("shows the changed files in the confirmation dialog", async () => {
    const { root, store } = fixture();
    const { second } = await twoCheckpoints(root, store);

    const mock = mockCtx({
      selects: [
        `#2  ${formatTime(second.timestamp)}  please change a.txt`,
        "Restore code (keep conversation)",
      ],
      confirms: [false],
    });

    await runRewindFlow(mock.ctx, { store, sessionId: "sess" });

    // Second select is the action menu, titled with the diff summary.
    assert.match(mock.selectTitles[1], /1 file: ~1/);
    assert.deepEqual(mock.selectOptionLists[1], [
      "Restore code and conversation",
      "Restore conversation (keep current files)",
      "Restore code (keep conversation)",
      "Summarize from here (frees context)",
      NEVER_MIND_LABEL,
    ]);
  });

  it("offers only conversation actions when nothing changed on disk", async () => {
    const { root, store } = fixture();
    write(root, "a.txt", "stable\n");
    const checkpoint = await createCheckpoint(store, {
      sessionId: "sess",
      kind: "prompt",
      prompt: "a read-only question",
      entryId: "entry-9",
    });

    const mock = mockCtx({
      selects: [
        `#1  ${formatTime(checkpoint.timestamp)}  a read-only question`,
        "Restore conversation (keep current files)",
      ],
    });

    const outcome = await runRewindFlow(mock.ctx, { store, sessionId: "sess" });

    assert.equal(outcome, "restored conversation");
    assert.deepEqual(mock.selectOptionLists[1], [
      "Restore conversation (keep current files)",
      "Summarize from here (frees context)",
      NEVER_MIND_LABEL,
    ]);
  });

  it("offers and performs an undo of the previous rewind", async () => {
    const { root, store } = fixture();
    const { second } = await twoCheckpoints(root, store);

    // First rewind: roll the code back to the state before the prompt.
    const firstMock = mockCtx({
      selects: [
        `#2  ${formatTime(second.timestamp)}  please change a.txt`,
        "Restore code (keep conversation)",
      ],
      confirms: [true],
    });
    await runRewindFlow(firstMock.ctx, { store, sessionId: "sess" });
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "v1\n");

    // Second rewind: undo it.
    const undoMock = mockCtx({ selects: [UNDO_LABEL], confirms: [true] });
    const outcome = await runRewindFlow(undoMock.ctx, { store, sessionId: "sess" });

    assert.equal(outcome, "undid last rewind");
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "v2\n");
    assert.equal(undoMock.selectOptionLists[0][0], UNDO_LABEL);
    assert.match(undoMock.notifications[0].message, /Undid the last rewind/);
    // The undo net is consumed.
    assert.equal(latestSafetyCheckpoint(store, "sess"), undefined);
  });

  it("keeps the undo entry out of the checkpoint list", async () => {
    const { root, store } = fixture();
    const { second } = await twoCheckpoints(root, store);

    const rewindMock = mockCtx({
      selects: [
        `#2  ${formatTime(second.timestamp)}  please change a.txt`,
        "Restore code (keep conversation)",
      ],
      confirms: [true],
    });
    await runRewindFlow(rewindMock.ctx, { store, sessionId: "sess" });

    const listingMock = mockCtx({ selects: [NEVER_MIND_LABEL] });
    await runRewindFlow(listingMock.ctx, { store, sessionId: "sess" });

    const options = listingMock.selectOptionLists[0];
    assert.equal(options[0], UNDO_LABEL);
    assert.equal(options.filter((option) => option.includes("Before a rewind")).length, 0);
    assert.equal(listCheckpoints(store, "sess").filter((cp) => cp.kind === "safety").length, 1);
  });

  it("reports a conversation rewind failure without losing the restored files", async () => {
    const { root, store } = fixture();
    const { second } = await twoCheckpoints(root, store);

    const mock = mockCtx({
      selects: [
        `#2  ${formatTime(second.timestamp)}  please change a.txt`,
        "Restore code and conversation",
      ],
      confirms: [true],
    });
    mock.ctx.navigateTree = async () => {
      throw new Error("navigation exploded");
    };

    const outcome = await runRewindFlow(mock.ctx, { store, sessionId: "sess" });

    assert.equal(outcome, "conversation rewind failed");
    // Files were still rolled back.
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "v1\n");
    assert.match(mock.notifications.at(-1)!.message, /Conversation rewind failed: navigation exploded/);
  });

  it("offers a code restore for files the worktree snapshot cannot see", async () => {
    const { root, store } = fixture();
    // The agent-dir sibling: exactly where ~/.pi/agent/themes lives in practice.
    const outside = join(dirname(root), "agent", "themes", "verdigris.json");
    const created = join(dirname(root), "agent", "themes", "scratch.json");
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, "border: old\n");
    write(root, "a.txt", "untouched by the turn\n");

    const checkpoint = await createCheckpoint(store, {
      sessionId: "sess",
      kind: "prompt",
      prompt: "change the theme border",
      entryId: "entry-1",
    });
    assert.equal(captureExternalFile(store, "sess", outside), true);
    assert.equal(captureExternalFile(store, "sess", created), true);
    writeFileSync(outside, "border: new\n");
    writeFileSync(created, "made during the turn\n");

    const mock = mockCtx({
      selects: [
        `#1  ${formatTime(checkpoint.timestamp)}  change the theme border`,
        "Restore code and conversation",
      ],
      confirms: [true],
    });

    const outcome = await runRewindFlow(mock.ctx, { store, sessionId: "sess" });

    assert.equal(outcome, "restored code and conversation");
    assert.equal(readFileSync(outside, "utf8"), "border: old\n");
    assert.equal(existsSync(created), false);
    // The worktree diff is empty here — the pre-images are the only evidence.
    assert.match(mock.selectTitles[1], /2 files: \+1 ~1/);
    assert.deepEqual(mock.selectOptionLists[1], [
      "Restore code and conversation",
      "Restore conversation (keep current files)",
      "Restore code (keep conversation)",
      "Summarize from here (frees context)",
      NEVER_MIND_LABEL,
    ]);
    assert.match(mock.confirmations[0].message, /themes\/verdigris\.json/);
    assert.match(mock.confirmations[0].message, /themes\/scratch\.json/);
    assert.deepEqual(mock.navigations, [{ targetId: "entry-1", summarize: false }]);
    assert.match(mock.notifications[0].message, /Restored files to checkpoint #1 \(2 files: \+1 ~1, removed 1 newer file\(s\)\)/);
  });

  it("undoes a rewind that changed an outside-project file", async () => {
    const { root, store } = fixture();
    const outside = join(dirname(root), "agent", "themes", "t.json");
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, "old\n");

    const checkpoint = await createCheckpoint(store, {
      sessionId: "sess",
      kind: "prompt",
      prompt: "tweak the theme",
      entryId: "entry-1",
    });
    assert.equal(captureExternalFile(store, "sess", outside), true);
    writeFileSync(outside, "new\n");

    const rewindMock = mockCtx({
      selects: [
        `#1  ${formatTime(checkpoint.timestamp)}  tweak the theme`,
        "Restore code (keep conversation)",
      ],
      confirms: [true],
    });
    assert.equal(await runRewindFlow(rewindMock.ctx, { store, sessionId: "sess" }), "restored code");
    assert.equal(readFileSync(outside, "utf8"), "old\n");

    const undoMock = mockCtx({ selects: [UNDO_LABEL], confirms: [true] });
    assert.equal(await runRewindFlow(undoMock.ctx, { store, sessionId: "sess" }), "undid last rewind");
    assert.equal(readFileSync(outside, "utf8"), "new\n");
  });

  it("hides conversation actions for a checkpoint without an entry id", async () => {
    const { root, store } = fixture();
    write(root, "a.txt", "v1\n");
    const checkpoint = await createCheckpoint(store, {
      sessionId: "sess",
      kind: "prompt",
      prompt: "prompt without an entry yet",
    });
    write(root, "a.txt", "v2\n");

    const mock = mockCtx({
      selects: [
        `#1  ${formatTime(checkpoint.timestamp)}  prompt without an entry yet`,
        "Restore code (keep conversation)",
      ],
      confirms: [true],
    });

    const outcome = await runRewindFlow(mock.ctx, { store, sessionId: "sess" });

    assert.equal(outcome, "restored code");
    assert.deepEqual(mock.selectOptionLists[1], ["Restore code (keep conversation)", NEVER_MIND_LABEL]);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "v1\n");
  });
});

/**
 * The scrollable picker is the production path (index.ts passes pickFromList);
 * `ctx.ui.select` is only the fallback for hosts that cannot render extension
 * components. These cases pin the wiring between the two.
 */
describe("picker wiring", () => {
  afterEach(() => {
    while (created.length > 0) {
      rmSync(created.pop()!, { recursive: true, force: true });
    }
  });

  it("drives the flow from the picker, leaving only the action menu to select", async () => {
    const { root, store } = fixture();
    const { first, second } = await twoCheckpoints(root, store);
    write(root, "b.txt", "created after the checkpoint\n");

    const { pick, offered } = scriptedPicker([formatCheckpointLabel(second, 2)]);
    const mock = mockCtx({ selects: ["Restore code and conversation"], confirms: [true] });

    const outcome = await runRewindFlow(mock.ctx, { store, sessionId: "sess", pick });

    assert.equal(outcome, "restored code and conversation");
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "v1\n");
    assert.equal(existsSync(join(root, "b.txt")), false);
    assert.deepEqual(mock.navigations, [{ targetId: "entry-2", summarize: false }]);
    // The picker was offered the checkpoint rows (undo row absent: nothing to
    // undo yet), and the built-in select was only used for the action menu.
    assert.equal(offered.length, 1);
    assert.equal(offered[0].title, "Rewind to a checkpoint");
    assert.deepEqual(offered[0].items.map((item) => item.label), [
      formatCheckpointLabel(second, 2),
      formatCheckpointLabel(first, 1),
      NEVER_MIND_LABEL,
    ]);
    assert.equal(mock.selectTitles.length, 1);
    assert.match(mock.selectTitles[0], /^#2 /);
  });

  it("cancels without falling back when the picker is dismissed", async () => {
    const { root, store } = fixture();
    await twoCheckpoints(root, store);
    const { pick } = scriptedPicker([]);
    const mock = mockCtx();

    assert.equal(await runRewindFlow(mock.ctx, { store, sessionId: "sess", pick }), "cancelled");
    // A picker answer is final — the plain list is not consulted.
    assert.deepEqual(mock.selectTitles, []);
    assert.deepEqual(mock.navigations, []);
  });

  it("ignores a picker value that names no row", async () => {
    const { root, store } = fixture();
    await twoCheckpoints(root, store);
    const { pick } = scriptedPicker([{ status: "picked", value: "cp:99" }]);
    const mock = mockCtx();

    assert.equal(await runRewindFlow(mock.ctx, { store, sessionId: "sess", pick }), "cancelled");
    assert.deepEqual(mock.navigations, []);
    assert.deepEqual(mock.selectTitles, []);
  });

  it("falls back to the plain list when the host cannot render the picker", async () => {
    const { root, store } = fixture();
    const { first, second } = await twoCheckpoints(root, store);
    const { pick } = scriptedPicker([{ status: "unsupported" }]);
    const mock = mockCtx({
      selects: [
        formatCheckpointLabel(second, 2),
        "Restore conversation (keep current files)",
      ],
    });

    const outcome = await runRewindFlow(mock.ctx, { store, sessionId: "sess", pick });

    assert.equal(outcome, "restored conversation");
    assert.deepEqual(mock.navigations, [{ targetId: "entry-2", summarize: false }]);
    // Same rows, same order — `ctx.ui.select` just cannot scroll them.
    assert.deepEqual(mock.selectOptionLists[0], [
      formatCheckpointLabel(second, 2),
      formatCheckpointLabel(first, 1),
      NEVER_MIND_LABEL,
    ]);
  });

  it("undoes a rewind from the picker's undo row", async () => {
    const { root, store } = fixture();
    const { second } = await twoCheckpoints(root, store);

    const rewind = scriptedPicker([formatCheckpointLabel(second, 2)]);
    await runRewindFlow(
      mockCtx({ selects: ["Restore code (keep conversation)"], confirms: [true] }).ctx,
      {
        store,
        sessionId: "sess",
        pick: rewind.pick,
      },
    );
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "v1\n");

    const undo = scriptedPicker([UNDO_LABEL]);
    const mock = mockCtx({ confirms: [true] });
    const outcome = await runRewindFlow(mock.ctx, { store, sessionId: "sess", pick: undo.pick });

    assert.equal(outcome, "undid last rewind");
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "v2\n");
    assert.equal(undo.offered[0].items[0].label, UNDO_LABEL);
    assert.match(mock.notifications[0].message, /Undid the last rewind/);
  });
});
