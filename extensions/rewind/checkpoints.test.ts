/**
 * Tests for the pi-rewind checkpoint core.
 *
 * Run with:  node --test ~/.pi/agent/extensions/rewind/checkpoints.test.ts
 *
 * Each test gets its own throwaway project + agent dir under the OS temp dir,
 * so neither the real repo nor ~/.pi is touched.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  MAX_CHECKPOINTS_PER_SESSION,
  RETENTION_DAYS,
  attachEntryId,
  captureExternalFile,
  captureFileStates,
  createCheckpoint,
  deleteCheckpoint,
  diffExternalFiles,
  diffTrees,
  externalRestorePlan,
  findUnresolvedCheckpoint,
  gc,
  git,
  isWorktreeCovered,
  latestSafetyCheckpoint,
  listCheckpoints,
  listCheckpointsNewestFirst,
  listProjectDirs,
  mergeDiffs,
  openStore,
  pruneSession,
  pruneStaleSessions,
  restoreCheckpoint,
  snapshotTree,
  summarizeDiff,
  type RewindStore,
} from "./checkpoints.ts";

const created: string[] = [];

/** Fresh project + agent dir pair; the temp base is removed after each test. */
function fixture(): { root: string; agentDir: string; store: RewindStore } {
  const base = mkdtempSync(join(tmpdir(), "pi-rewind-test-"));
  created.push(base);
  const root = join(base, "project");
  const agentDir = join(base, "agent");
  mkdirSync(root, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { root, agentDir, store: openStore(root, agentDir) };
}

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

/** Write a file outside the project root (the agent dir is a sibling of it). */
function writeOutside(store: RewindStore, rel: string, content: string): string {
  const full = join(dirname(store.root), "agent", rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return full;
}

/** Bytes stored under a pre-image blob name. */
function blobText(store: RewindStore, blob: string | null): string {
  assert.ok(blob, "expected a pre-image blob");
  return readFileSync(join(store.filesDir, blob), "utf8");
}

function realGit(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@test",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@test",
    },
  }).trim();
}

async function treeFiles(store: RewindStore, tree: string): Promise<string[]> {
  const out = await git(store, ["ls-tree", "-r", "--name-only", tree]);
  return out ? out.split("\n") : [];
}

describe("checkpoints core", () => {
  afterEach(() => {
    while (created.length > 0) {
      rmSync(created.pop()!, { recursive: true, force: true });
    }
  });

  it("snapshots the worktree without needing a real git repo", async () => {
    const { root, store } = fixture();
    write(root, "a.txt", "hello\n");
    write(root, "sub/b.txt", "world\n");

    const tree = await snapshotTree(store);
    assert.match(tree, /^[0-9a-f]{40}$/);
    assert.deepEqual(await treeFiles(store, tree), ["a.txt", "sub/b.txt"]);
  });

  it("respects .gitignore and never snapshots ignored paths", async () => {
    const { root, store } = fixture();
    write(root, ".gitignore", "node_modules/\n*.log\n");
    write(root, "keep.txt", "keep\n");
    write(root, "node_modules/dep.js", "junk\n");
    write(root, "debug.log", "noise\n");

    const tree = await snapshotTree(store);
    assert.deepEqual(await treeFiles(store, tree), [".gitignore", "keep.txt"]);
  });

  it("reuses the commit when the worktree is unchanged", async () => {
    const { root, store } = fixture();
    write(root, "a.txt", "hello\n");

    const first = await createCheckpoint(store, { sessionId: "s1", kind: "prompt", prompt: "first" });
    const second = await createCheckpoint(store, { sessionId: "s1", kind: "prompt", prompt: "second" });

    assert.equal(second.tree, first.tree);
    assert.equal(second.commit, first.commit);
    assert.notEqual(second.id, first.id);
    assert.deepEqual(
      listCheckpoints(store, "s1").map((cp) => cp.prompt),
      ["first", "second"],
    );
    assert.deepEqual(
      listCheckpointsNewestFirst(store, "s1").map((cp) => cp.prompt),
      ["second", "first"],
    );
  });

  it("records a distinct tree once files change and diffs them", async () => {
    const { root, store } = fixture();
    write(root, "a.txt", "v1\n");
    const before = await createCheckpoint(store, { sessionId: "s2", kind: "prompt", prompt: "before" });

    write(root, "a.txt", "v2\n");
    const after = await createCheckpoint(store, { sessionId: "s2", kind: "prompt", prompt: "after" });

    assert.notEqual(after.tree, before.tree);
    const diff = await diffTrees(store, before.tree, after.tree);
    assert.deepEqual(diff.entries, [{ status: "M", path: "a.txt" }]);
    assert.equal(summarizeDiff(diff), "1 file: ~1");
    assert.equal((await diffTrees(store, after.tree, after.tree)).empty, true);
    assert.equal(summarizeDiff({ entries: [], empty: true }), "no file changes");
  });

  it("reports added, modified and deleted files in a diff", async () => {
    const { root, store } = fixture();
    write(root, "a.txt", "a\n");
    write(root, "b.txt", "b\n");
    write(root, "c.txt", "c\n");
    const before = await snapshotTree(store);

    write(root, "a.txt", "a2\n");
    rmSync(join(root, "b.txt"));
    write(root, "d.txt", "d\n");
    const after = await snapshotTree(store);

    const diff = await diffTrees(store, before, after);
    const byPath = Object.fromEntries(diff.entries.map((entry) => [entry.path, entry.status]));
    assert.equal(byPath["a.txt"], "M");
    assert.equal(byPath["b.txt"], "D");
    assert.equal(byPath["d.txt"], "A");
    assert.equal(summarizeDiff(diff), "3 files: +1 ~1 -1");
  });

  it("restores modified, deleted and newly created files while sparing ignored ones", async () => {
    const { root, store } = fixture();
    write(root, ".gitignore", "ignored/\n");
    write(root, "keep.txt", "original\n");
    write(root, "gone.txt", "exists at checkpoint\n");
    write(root, "ignored/build.js", "artifact\n");

    const checkpoint = await createCheckpoint(store, { sessionId: "s4", kind: "prompt", prompt: "p" });

    write(root, "keep.txt", "agent rewrote this\n");
    rmSync(join(root, "gone.txt"));
    write(root, "created-by-agent.txt", "should disappear\n");
    write(root, "ignored/new-build.js", "should survive\n");

    const result = await restoreCheckpoint(store, checkpoint);

    assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "original\n");
    assert.equal(readFileSync(join(root, "gone.txt"), "utf8"), "exists at checkpoint\n");
    assert.equal(existsSync(join(root, "created-by-agent.txt")), false);
    assert.deepEqual(result.removed, ["created-by-agent.txt"]);
    assert.equal(existsSync(join(root, "ignored/new-build.js")), true);
  });

  it("never touches the project's own git index, HEAD, status or refs", async () => {
    const { root, agentDir } = fixture();
    realGit(root, ["init", "--quiet"]);
    write(root, "tracked.txt", "v1\n");
    realGit(root, ["add", "-A"]);
    realGit(root, ["commit", "--quiet", "-m", "init"]);
    const headBefore = realGit(root, ["rev-parse", "HEAD"]);

    const store = openStore(root, agentDir);
    const checkpoint = await createCheckpoint(store, { sessionId: "s5", kind: "prompt", prompt: "p" });

    write(root, "tracked.txt", "v2\n");
    write(root, "untracked.txt", "new\n");
    realGit(root, ["add", "untracked.txt"]);

    await restoreCheckpoint(store, checkpoint);

    assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "v1\n");
    assert.equal(existsSync(join(root, "untracked.txt")), false);
    assert.equal(realGit(root, ["rev-parse", "HEAD"]), headBefore);
    // The staged entry is still in the user's index even though the file is gone.
    assert.match(realGit(root, ["ls-files", "--cached"]), /untracked\.txt/);
    // The user's repo carries no checkpoint refs and no checkpoint objects.
    assert.equal(realGit(root, ["for-each-ref", "refs/pi-rewind"]), "");
    assert.equal(realGit(root, ["status", "--porcelain"]).includes("pi-rewind"), false);
  });

  it("adopts the real repo's info/exclude so excluded paths survive a restore", async () => {
    const base = mkdtempSync(join(tmpdir(), "pi-rewind-test-"));
    created.push(base);
    const root = join(base, "project");
    const agentDir = join(base, "agent");
    mkdirSync(root, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    // The real repo (and its exclude file) must exist before the store opens,
    // which is the order pi sees in practice.
    realGit(root, ["init", "--quiet"]);
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "exclude"), "secret/\n", "utf8");
    write(root, "tracked.txt", "v1\n");

    const store = openStore(root, agentDir);
    const checkpoint = await createCheckpoint(store, { sessionId: "s6", kind: "prompt", prompt: "p" });
    write(root, "secret/keys.txt", "created after the checkpoint\n");

    // The exclude file really was adopted, so the path is not even snapshotted.
    const tree = await snapshotTree(store);
    assert.equal((await treeFiles(store, tree)).includes("secret/keys.txt"), false);

    await restoreCheckpoint(store, checkpoint);
    assert.equal(existsSync(join(root, "secret/keys.txt")), true);
  });

  it("attaches entry ids exactly once and finds unresolved checkpoints", async () => {
    const { store } = fixture();
    const checkpoint = await createCheckpoint(store, { sessionId: "s7", kind: "prompt", prompt: "p" });

    assert.equal(checkpoint.entryId, undefined);
    assert.equal(findUnresolvedCheckpoint(store, "s7")?.id, checkpoint.id);
    assert.equal(attachEntryId(store, "s7", checkpoint.id, "entry-1"), true);
    assert.equal(listCheckpoints(store, "s7")[0].entryId, "entry-1");
    assert.equal(findUnresolvedCheckpoint(store, "s7"), undefined);
    // Never overwrites an existing id, and ignores unknown ids.
    assert.equal(attachEntryId(store, "s7", checkpoint.id, "entry-2"), false);
    assert.equal(listCheckpoints(store, "s7")[0].entryId, "entry-1");
    assert.equal(attachEntryId(store, "s7", "nope", "entry-3"), false);
  });

  it("keeps safety checkpoints separate and exposes the newest one", async () => {
    const { root, store } = fixture();
    await createCheckpoint(store, { sessionId: "s8", kind: "prompt", prompt: "p" });
    assert.equal(latestSafetyCheckpoint(store, "s8"), undefined);

    const first = await createCheckpoint(store, { sessionId: "s8", kind: "safety", timestamp: 1000 });
    write(root, "marker.txt", "x\n");
    const second = await createCheckpoint(store, { sessionId: "s8", kind: "safety", timestamp: 2000 });

    assert.equal(latestSafetyCheckpoint(store, "s8")?.id, second.id);
    assert.notEqual(second.tree, first.tree);
  });

  it("prunes a session to the cap but keeps safety rows", async () => {
    const { root, store } = fixture();
    write(root, "a.txt", "seed\n");
    const sessionId = "s9";
    const total = MAX_CHECKPOINTS_PER_SESSION + 5;

    for (let i = 0; i < total; i += 1) {
      await createCheckpoint(store, {
        sessionId,
        kind: "prompt",
        prompt: `prompt ${i}`,
        timestamp: 1_700_000_000_000 + i * 1000,
      });
    }
    const safety = await createCheckpoint(store, { sessionId, kind: "safety", timestamp: 1_799_000_000_000 });

    assert.equal(await pruneSession(store, sessionId), 5);

    const remaining = listCheckpoints(store, sessionId);
    assert.equal(remaining.length, MAX_CHECKPOINTS_PER_SESSION + 1);
    assert.equal(remaining.some((cp) => cp.id === safety.id), true);
    assert.equal(remaining.some((cp) => cp.prompt === "prompt 0"), false);
    assert.equal(remaining.some((cp) => cp.prompt === `prompt ${total - 1}`), true);

    const refs = await git(store, ["for-each-ref", "--format=%(refname)", "refs/pi-rewind"]);
    assert.equal(refs.split("\n").filter(Boolean).length, remaining.length);
  });

  it("sweeps sessions past the retention window", async () => {
    const { store } = fixture();
    const now = Date.now();
    await createCheckpoint(store, {
      sessionId: "old",
      kind: "prompt",
      prompt: "old",
      timestamp: now - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
    });
    await createCheckpoint(store, { sessionId: "fresh", kind: "prompt", prompt: "fresh", timestamp: now });

    assert.equal(await pruneStaleSessions(store, now), 1);
    assert.deepEqual(listCheckpoints(store, "old"), []);
    assert.equal(listCheckpoints(store, "fresh").length, 1);
    assert.equal(await pruneStaleSessions(store, now), 0);
  });

  it("deletes a single checkpoint and its ref", async () => {
    const { store } = fixture();
    const checkpoint = await createCheckpoint(store, { sessionId: "s10", kind: "prompt", prompt: "p" });

    await deleteCheckpoint(store, checkpoint);

    assert.deepEqual(listCheckpoints(store, "s10"), []);
    assert.equal(await git(store, ["for-each-ref", "--format=%(refname)", "refs/pi-rewind"]), "");
  });

  it("keeps checkpoint objects reachable so gc cannot prune a live checkpoint", async () => {
    const { root, store } = fixture();
    write(root, "a.txt", "checkpointed\n");
    const checkpoint = await createCheckpoint(store, { sessionId: "s11", kind: "prompt", prompt: "p" });

    await gc(store);
    write(root, "a.txt", "mutated after checkpoint\n");
    await restoreCheckpoint(store, checkpoint);

    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "checkpointed\n");
  });

  it("isolates sessions and lists project dirs", async () => {
    const { agentDir, store } = fixture();
    await createCheckpoint(store, { sessionId: "alpha", kind: "prompt", prompt: "a" });
    await createCheckpoint(store, { sessionId: "beta", kind: "prompt", prompt: "b" });

    assert.deepEqual(listCheckpoints(store, "alpha").map((cp) => cp.prompt), ["a"]);
    assert.deepEqual(listCheckpoints(store, "beta").map((cp) => cp.prompt), ["b"]);
    assert.deepEqual(listCheckpoints(store, "gamma"), []);

    const dirs = listProjectDirs(agentDir);
    assert.ok(dirs.some((dir) => dir.endsWith(store.projectKey)));
  });

  it("starts a fresh list after a corrupt metadata file and keeps working", async () => {
    const { store } = fixture();
    await createCheckpoint(store, { sessionId: "s12", kind: "prompt", prompt: "p" });
    writeFileSync(store.metaFile, "{ not json", "utf8");

    assert.deepEqual(listCheckpoints(store, "s12"), []);

    const checkpoint = await createCheckpoint(store, { sessionId: "s12", kind: "prompt", prompt: "q" });
    assert.deepEqual(listCheckpoints(store, "s12").map((cp) => cp.id), [checkpoint.id]);
  });

  it("reopens the same store for the same root and keeps its checkpoints", async () => {
    const { root, agentDir, store } = fixture();
    write(root, "a.txt", "hello\n");
    const checkpoint = await createCheckpoint(store, { sessionId: "s13", kind: "prompt", prompt: "p" });

    const reopened = openStore(root, agentDir);
    assert.equal(reopened.gitDir, store.gitDir);
    assert.deepEqual(listCheckpoints(reopened, "s13").map((cp) => cp.id), [checkpoint.id]);

    // A different root gets a different shadow repo.
    const otherRoot = join(dirname(root), "other");
    mkdirSync(otherRoot, { recursive: true });
    const otherStore = openStore(otherRoot, agentDir);
    assert.notEqual(otherStore.projectKey, store.projectKey);
    assert.deepEqual(listCheckpoints(otherStore, "s13"), []);
  });
});

/**
 * The worktree snapshot only sees tracked paths under the project root. Files
 * the agent edits elsewhere (`~/.pi/agent/themes/…`) — or in an ignored path —
 * are captured as pre-image blobs instead, which is what makes `/rewind` show
 * and perform a code restore for them.
 */
describe("pre-images for files the worktree snapshot cannot see", () => {
  afterEach(() => {
    while (created.length > 0) {
      rmSync(created.pop()!, { recursive: true, force: true });
    }
  });

  it("tells snapshot-covered paths from captured ones", async () => {
    const { root, store } = fixture();
    write(root, ".gitignore", "local.settings\nnode_modules/\n");
    write(root, "a.txt", "a\n");
    write(root, "local.settings", "ignored\n");
    const outside = writeOutside(store, "themes/verdigris.json", "{}\n");

    assert.equal(isWorktreeCovered(store, join(root, "a.txt")), true);
    assert.equal(isWorktreeCovered(store, join(root, "sub/b.txt")), true);
    assert.equal(isWorktreeCovered(store, join(root, "local.settings")), false);
    assert.equal(isWorktreeCovered(store, outside), false);
  });

  it("records one pre-image per file per checkpoint, and skips covered paths", async () => {
    const { root, store } = fixture();
    write(root, "a.txt", "in the worktree\n");
    const outside = writeOutside(store, "themes/t.json", "v1\n");
    await createCheckpoint(store, { sessionId: "s", kind: "prompt", prompt: "tweak the theme" });

    assert.equal(captureExternalFile(store, "s", "a.txt"), false);
    assert.equal(captureExternalFile(store, "s", join(root, "a.txt")), false);
    assert.equal(captureExternalFile(store, "s", outside), true);

    // The turn keeps writing to it; only the first touch is the pre-image.
    writeFileSync(outside, "v2\n");
    assert.equal(captureExternalFile(store, "s", outside), false);

    // A file that does not exist yet is recorded as "delete on restore".
    const created = join(dirname(store.root), "agent", "themes", "new.json");
    assert.equal(captureExternalFile(store, "s", created), true);

    const files = listCheckpoints(store, "s")[0].files!;
    assert.deepEqual(
      files.map((file) => [file.path, file.blob === null]),
      [
        [outside, false],
        [created, true],
      ],
    );
    assert.equal(blobText(store, files[0].blob), "v1\n");
  });

  it("diffs pre-images against the disk state", async () => {
    const { store } = fixture();
    const modified = writeOutside(store, "a.json", "before\n");
    const vanished = writeOutside(store, "b.json", "before\n");
    const created = join(dirname(store.root), "agent", "c.json");
    const untouched = writeOutside(store, "d.json", "same\n");
    await createCheckpoint(store, { sessionId: "s", kind: "prompt", prompt: "p" });
    for (const path of [modified, vanished, created, untouched]) {
      assert.equal(captureExternalFile(store, "s", path), true);
    }

    writeFileSync(modified, "after\n");
    rmSync(vanished);
    writeFileSync(created, "appeared later\n");

    const diff = diffExternalFiles(store, externalRestorePlan(listCheckpoints(store, "s"), 0));
    assert.deepEqual(diff.entries, [
      { status: "M", path: modified },
      { status: "D", path: vanished },
      { status: "A", path: created },
    ]);
    assert.equal(diff.empty, false);
    assert.equal(diffExternalFiles(store, []).empty, true);
    // A tree diff and a pre-image diff of the same path are reported once.
    assert.deepEqual(
      mergeDiffs({ entries: [{ status: "M", path: modified }], empty: false }, diff).entries.length,
      3,
    );
  });

  it("restores, recreates and deletes outside-project files", async () => {
    const { store } = fixture();
    const modified = writeOutside(store, "a.json", "before\n");
    const deleted = writeOutside(store, "b.json", "before\n");
    const created = join(dirname(store.root), "agent", "c.json");
    await createCheckpoint(store, { sessionId: "s", kind: "prompt", prompt: "p" });
    for (const path of [modified, deleted, created]) {
      assert.equal(captureExternalFile(store, "s", path), true);
    }
    writeFileSync(modified, "after\n");
    rmSync(deleted);
    writeFileSync(created, "appeared later\n");

    const targets = listCheckpoints(store, "s");
    const plan = externalRestorePlan(targets, 0);
    const result = await restoreCheckpoint(store, targets[0], { files: plan });

    assert.equal(readFileSync(modified, "utf8"), "before\n");
    assert.equal(readFileSync(deleted, "utf8"), "before\n");
    assert.equal(existsSync(created), false);
    assert.deepEqual(result.removed, [created]);
  });

  it("resolves each path from the earliest touch at or after the checkpoint", async () => {
    const { store } = fixture();
    const file = writeOutside(store, "theme.json", "v0\n");

    const first = await createCheckpoint(store, { sessionId: "s", kind: "prompt", prompt: "one" });
    assert.equal(captureExternalFile(store, "s", file), true);
    writeFileSync(file, "v1\n");

    const second = await createCheckpoint(store, { sessionId: "s", kind: "prompt", prompt: "two" });
    assert.equal(captureExternalFile(store, "s", file), true);
    writeFileSync(file, "v2\n");

    const all = listCheckpoints(store, "s");
    assert.equal(all.length, 2);
    assert.equal(blobText(store, externalRestorePlan(all, 0)[0].blob), "v0\n");
    assert.equal(blobText(store, externalRestorePlan(all, 1)[0].blob), "v1\n");

    // The undo net snapshots the current bytes, not the recorded pre-image.
    const undo = captureFileStates(store, externalRestorePlan(all, 0));
    assert.equal(blobText(store, undo[0].blob), "v2\n");
    assert.equal(listCheckpoints(store, "s").filter((cp) => cp.files?.length).length, 2);
  });

  it("drops pre-image blobs once no checkpoint references them", async () => {
    const { store } = fixture();
    const file = writeOutside(store, "theme.json", "v1\n");
    const first = await createCheckpoint(store, { sessionId: "s", kind: "prompt", prompt: "one" });
    assert.equal(captureExternalFile(store, "s", file), true);
    writeFileSync(file, "v2\n");
    await createCheckpoint(store, { sessionId: "s", kind: "prompt", prompt: "two" });
    assert.equal(captureExternalFile(store, "s", file), true);
    assert.deepEqual(
      listCheckpoints(store, "s").map((cp) => cp.files?.map((f) => blobText(store, f.blob))),
      [["v1\n"], ["v2\n"]],
    );

    assert.equal(readdirSync(store.filesDir).length, 2);
    await deleteCheckpoint(store, first);

    // Blob of the pruned checkpoint is gone; the surviving one is kept.
    const left = readdirSync(store.filesDir);
    assert.equal(left.length, 1);
    assert.equal(readFileSync(join(store.filesDir, left[0]), "utf8"), "v2\n");
    assert.deepEqual(
      listCheckpoints(store, "s").map((cp) => cp.prompt),
      ["two"],
    );
  });
});
