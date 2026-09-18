/**
 * pi-rewind core — checkpoint storage on a shadow git repository.
 *
 * Zero pi imports: pure git + fs operations so the whole module is testable
 * with `node --test`.
 *
 * Why a shadow repo instead of refs in the user's repository (the approach
 * pi-rewind/checkpoint-pi use):
 *   - the user's repo keeps zero extra refs, objects and history entries;
 *   - the user's real index/HEAD are never touched, so a restore cannot move
 *     HEAD or discard staged work (Claude Code behaves the same way: its
 *     checkpoints "live beside your git history, not inside it");
 *   - checkpointing also works when the working directory is not a git repo.
 *
 * A checkpoint is a worktree tree object plus a commit that keeps it reachable
 * through refs/pi-rewind/<id>, so `git gc --auto` can never prune a live
 * checkpoint. Snapshotting respects .gitignore (plus the real repo's
 * info/exclude, copied into the shadow repo once), so node_modules and friends
 * are never copied into snapshots.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";

/** Ref namespace that keeps checkpoint objects reachable inside the shadow repo. */
export const REF_PREFIX = "refs/pi-rewind";

/** Claude Code keeps file snapshots for the 100 most recent checkpoints per session. */
export const MAX_CHECKPOINTS_PER_SESSION = 100;

/** Claude Code's retention sweep deletes snapshots ~30 days after the session last saved one. */
export const RETENTION_DAYS = 30;

/** Pre-images larger than this are skipped: they would bloat the shadow store. */
export const MAX_EXTERNAL_FILE_BYTES = 8 * 1024 * 1024;

export type CheckpointKind = "session-start" | "prompt" | "safety";

/**
 * Pre-image of a file the worktree snapshot cannot see — one outside the
 * project root, or one inside it that `.gitignore` hides from `git add -A`.
 *
 * `blob` names a content-addressed copy under <projectDir>/files, or is null
 * when the file did not exist at capture time (so a restore deletes it).
 */
export interface ExternalFile {
  /** Absolute path of the file on disk. */
  path: string;
  /** Content-addressed blob name, or null for "did not exist". */
  blob: string | null;
}

export interface Checkpoint {
  /** Unique id; also the shadow-repo ref name suffix. */
  id: string;
  /** Session this checkpoint belongs to. */
  sessionId: string;
  /** "session-start" = snapshot taken when the session opened,
   *  "prompt" = snapshot taken before a user prompt,
   *  "safety" = snapshot taken right before a code restore (undo net). */
  kind: CheckpointKind;
  /** User prompt text ("" for session-start / safety checkpoints). */
  prompt: string;
  /** Session entry id of the user message, once resolved. Conversation
   *  restore navigates the session tree to this entry. */
  entryId?: string;
  /** Worktree tree sha in the shadow repo. */
  tree: string;
  /** Pre-images of files this checkpoint's turn edited outside the worktree
   *  snapshot (recorded lazily, first touch wins). */
  files?: ExternalFile[];
  /** Commit sha holding the tree (reachable via refs/pi-rewind/<id>). */
  commit: string;
  /** Epoch ms. */
  timestamp: number;
}

export interface RewindStore {
  /** Absolute path of the snapshot working tree (the project directory). */
  root: string;
  /** Shadow GIT_DIR — outside the project, never the project's own .git. */
  gitDir: string;
  /** Metadata file holding every session's checkpoint list. */
  metaFile: string;
  /** Directory holding the pre-image blobs referenced by `files`. */
  filesDir: string;
  /** Stable per-project key (hash of the root path). */
  projectKey: string;
}

export interface DiffEntry {
  /** git name-status letter: A / M / D / R… / T */
  status: string;
  path: string;
}

export interface CheckpointDiff {
  entries: DiffEntry[];
  /** True when the two trees are identical (nothing to restore). */
  empty: boolean;
}

export interface RestoreResult {
  /** Untracked files that were deleted because the checkpoint did not have them. */
  removed: string[];
}

interface StoreMeta {
  version: 1;
  root: string;
  updatedAt: number;
  sessions: Record<string, Checkpoint[]>;
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

export interface GitRunOptions {
  input?: string;
  /** Resolve with stderr instead of rejecting on a non-zero exit code. */
  allowFailure?: boolean;
}

/** Run git against the shadow repo. Args are passed as an array (no shell). */
export function git(
  store: RewindStore,
  args: string[],
  options: GitRunOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: store.root,
      env: shadowEnv(store),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else if (options.allowFailure) resolve(stderr.trim());
      else reject(new Error(stderr.trim() || `git ${args[0]} failed (code ${code})`));
    });

    if (child.stdin) {
      if (options.input) child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

/** git env for the shadow repo: strips inherited git plumbing variables so a
 *  stray GIT_DIR/GIT_INDEX_FILE in pi's environment can never redirect us. */
function shadowEnv(store: RewindStore): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_COMMON_DIR",
  ]) {
    delete env[key];
  }
  env.GIT_DIR = store.gitDir;
  env.GIT_WORK_TREE = store.root;
  // commit-tree needs an identity; checkpoint commits are never authored by the user.
  env.GIT_AUTHOR_NAME = "pi-rewind";
  env.GIT_AUTHOR_EMAIL = "pi-rewind@pi";
  env.GIT_COMMITTER_NAME = "pi-rewind";
  env.GIT_COMMITTER_EMAIL = "pi-rewind@pi";
  return env;
}

/** Absolute path of the directory that holds every project's shadow repo. */
export function rewindBaseDir(agentDir: string): string {
  return join(agentDir, "rewind");
}

/** Stable per-project key so two checkouts of the same repo do not collide. */
export function projectKeyFor(root: string): string {
  return createHash("sha1").update(root).digest("hex").slice(0, 16);
}

/**
 * Open (and on first use create) the shadow repo for `root`.
 * Idempotent; safe to call on every session start.
 */
export function openStore(root: string, agentDir: string): RewindStore {
  const absoluteRoot = resolveRoot(root);
  const projectKey = projectKeyFor(absoluteRoot);
  const projectDir = join(rewindBaseDir(agentDir), projectKey);
  const gitDir = join(projectDir, "git");
  const metaFile = join(projectDir, "checkpoints.json");
  const filesDir = join(projectDir, "files");

  mkdirSync(projectDir, { recursive: true });

  if (!existsSync(join(gitDir, "HEAD"))) {
    mkdirSync(gitDir, { recursive: true });
    // `git init <path>` would create <path>/.git (it treats the argument as a
    // work tree), so the repo structure is initialised through GIT_DIR instead.
    const child = spawnSyncGit(["init", "--quiet", "--initial-branch=pi-rewind"], {
      GIT_DIR: gitDir,
    });
    if (child.status !== 0) {
      throw new Error(`git init failed for ${gitDir}: ${child.stderr || `code ${child.status}`}`);
    }
  }

  // Re-adopted on every open so later edits to the real repo's exclude file
  // are picked up; a missing file leaves any previous copy untouched.
  adoptRealRepoExcludes(absoluteRoot, gitDir);

  return { root: absoluteRoot, gitDir, metaFile, filesDir, projectKey };
}

function resolveRoot(root: string): string {
  // A normalized absolute path is stable enough for the project key; realpath
  // would add a failure mode on dangling symlinks.
  const absolute = resolvePath(root);
  return absolute.replace(/\/+$/, "") || "/";
}

/**
 * Copy the real repository's info/exclude into the shadow repo so paths the
 * user deliberately keeps out of git are not snapshotted (and therefore not
 * deleted by a restore's `git clean`).
 */
function adoptRealRepoExcludes(root: string, gitDir: string): void {
  const realExclude = join(root, ".git", "info", "exclude");
  try {
    if (!statSync(realExclude).isFile()) return;
    mkdirSync(join(gitDir, "info"), { recursive: true });
    copyFileSync(realExclude, join(gitDir, "info", "exclude"));
  } catch {
    // No real repo, or nothing to adopt — both fine.
  }
}

/** Small sync git helper used only for `git init` during openStore. */
function spawnSyncGit(
  args: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stderr: string } {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    env: { ...process.env, ...envOverrides },
  });
  return { status: result.status, stderr: (result.stderr || "").trim() };
}

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

export function readMeta(store: RewindStore): StoreMeta {
  try {
    const parsed = JSON.parse(readFileSync(store.metaFile, "utf8")) as StoreMeta;
    if (parsed && parsed.version === 1 && parsed.sessions) return parsed;
  } catch {
    // Missing or corrupt metadata: start over. Checkpoint objects stay in the
    // shadow repo but become unreachable and are collected by the next gc.
  }
  return { version: 1, root: store.root, updatedAt: 0, sessions: {} };
}

export function writeMeta(store: RewindStore, meta: StoreMeta): void {
  meta.updatedAt = Date.now();
  mkdirSync(dirname(store.metaFile), { recursive: true });
  writeFileSync(store.metaFile, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

export function listCheckpoints(store: RewindStore, sessionId: string): Checkpoint[] {
  const meta = readMeta(store);
  const list = meta.sessions[sessionId] ?? [];
  // Defensive copy, oldest first.
  return [...list].sort((a, b) => a.timestamp - b.timestamp);
}

/** Newest-first view used by the menu. */
export function listCheckpointsNewestFirst(store: RewindStore, sessionId: string): Checkpoint[] {
  return listCheckpoints(store, sessionId).reverse();
}

function replaceSessionList(
  store: RewindStore,
  sessionId: string,
  mutate: (list: Checkpoint[]) => Checkpoint[],
): void {
  const meta = readMeta(store);
  const current = meta.sessions[sessionId] ?? [];
  const next = mutate([...current].sort((a, b) => a.timestamp - b.timestamp));
  if (next.length === 0) delete meta.sessions[sessionId];
  else meta.sessions[sessionId] = next;
  writeMeta(store, meta);
}

/** Attach the resolved user-message entry id to a checkpoint. */
export function attachEntryId(
  store: RewindStore,
  sessionId: string,
  checkpointId: string,
  entryId: string,
): boolean {
  let found = false;
  replaceSessionList(store, sessionId, (list) =>
    list.map((cp) => {
      if (cp.id !== checkpointId || cp.entryId) return cp;
      found = true;
      return { ...cp, entryId };
    }),
  );
  return found;
}

/** Oldest checkpoint of a session that still lacks an entry id. */
export function findUnresolvedCheckpoint(
  store: RewindStore,
  sessionId: string,
): Checkpoint | undefined {
  return listCheckpoints(store, sessionId).find((cp) => cp.kind === "prompt" && !cp.entryId);
}

/** Newest safety checkpoint (the "undo last rewind" target), if any. */
export function latestSafetyCheckpoint(
  store: RewindStore,
  sessionId: string,
): Checkpoint | undefined {
  const safety = listCheckpoints(store, sessionId).filter((cp) => cp.kind === "safety");
  return safety.length > 0 ? safety[safety.length - 1] : undefined;
}

// ---------------------------------------------------------------------------
// snapshot / checkpoint creation
// ---------------------------------------------------------------------------

/**
 * Hash the current worktree into the shadow repo and return its tree sha.
 * Also leaves the shadow index warm, which keeps later snapshots cheap.
 */
export async function snapshotTree(store: RewindStore): Promise<string> {
  // -A stages modifications, deletions and new files; .gitignore still applies.
  await git(store, ["add", "-A", "--ignore-errors", "--"], { allowFailure: true });
  return git(store, ["write-tree"]);
}

export interface CreateCheckpointOptions {
  sessionId: string;
  kind: CheckpointKind;
  prompt?: string;
  entryId?: string;
  /** Reuse an existing tree sha instead of hashing the worktree again. */
  tree?: string;
  /** Pre-images for files outside the worktree snapshot (safety checkpoints). */
  files?: ExternalFile[];
  timestamp?: number;
}

/**
 * Snapshot the worktree and record a checkpoint.
 *
 * When the worktree is unchanged since the session's previous checkpoint the
 * existing commit is reused (no new object, no new ref) — read-only turns cost
 * nothing but a metadata row.
 */
export async function createCheckpoint(
  store: RewindStore,
  options: CreateCheckpointOptions,
): Promise<Checkpoint> {
  const timestamp = options.timestamp ?? Date.now();
  const tree = options.tree ?? (await snapshotTree(store));
  const previous = listCheckpoints(store, options.sessionId);
  const reusable = previous.find((cp) => cp.tree === tree);

  let commit: string;
  if (reusable) {
    commit = reusable.commit;
  } else {
    const message = [
      `pi-rewind ${options.kind}`,
      `session ${options.sessionId}`,
      `created ${new Date(timestamp).toISOString()}`,
      options.prompt ? `prompt ${options.prompt.slice(0, 200)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    commit = await git(store, ["commit-tree", tree], { input: message });
  }

  const id = `${options.kind}-${timestamp}-${createHash("sha1").update(`${tree}:${timestamp}`).digest("hex").slice(0, 8)}`;
  await git(store, ["update-ref", `${REF_PREFIX}/${id}`, commit]);

  const checkpoint: Checkpoint = {
    id,
    sessionId: options.sessionId,
    kind: options.kind,
    prompt: options.prompt ?? "",
    ...(options.entryId ? { entryId: options.entryId } : {}),
    ...(options.files && options.files.length > 0 ? { files: options.files } : {}),
    tree,
    commit,
    timestamp,
  };

  replaceSessionList(store, options.sessionId, (list) => [...list, checkpoint]);
  return checkpoint;
}

// ---------------------------------------------------------------------------
// pre-images: files the worktree snapshot cannot see
// ---------------------------------------------------------------------------

/**
 * A checkpoint only snapshots the worktree under the project root, and
 * `git add -A` skips `.gitignore`d paths. Everything the agent edits elsewhere
 * (`~/.pi/agent/themes/…`, `~/.claude/settings.json`, an ignored `.env`) would
 * therefore be invisible to `/rewind` — its diff would come out empty and the
 * menu would hide the code options entirely (the bug this section fixes).
 *
 * Such files are captured lazily instead: right before an `edit`/`write` tool
 * runs, the bytes on disk are copied into the project's blob store and recorded
 * on the session's newest checkpoint. The first touch inside a turn wins, so
 * the record is the state as it was *before* the turn changed it.
 */

/**
 * Is `path` covered by the worktree snapshot (inside the root and not ignored)?
 * Only then can the shadow tree restore it, so only uncovered paths need a
 * pre-image. `git check-ignore` is consulted because it applies exactly the
 * rules `git add -A` uses — the project's `.gitignore` files plus the shadow
 * repo's `info/exclude` (copied from the real repo).
 */
export function isWorktreeCovered(store: RewindStore, path: string): boolean {
  const rel = relative(store.root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  const result = spawnSync("git", ["check-ignore", "-q", "--", rel], {
    cwd: store.root,
    env: shadowEnv(store),
    stdio: ["ignore", "ignore", "ignore"],
  });
  // 0 = ignored, 1 = not ignored, anything else = no answer -> treat as covered.
  return result.status !== 0;
}

/** Absolute form of a tool's `path` argument (relative resolves to the cwd). */
export function resolveTargetPath(store: RewindStore, path: string): string {
  return isAbsolute(path) ? resolvePath(path) : resolvePath(store.root, path);
}

/**
 * Copy `path`'s current bytes into the blob store.
 * Returns the blob name, null when the file does not exist (a pre-image that
 * means "delete it on restore"), or undefined when it is not storable
 * (directory, oversized, unreadable). Content addressing dedupes versions.
 */
function storeBlob(store: RewindStore, path: string): string | null | undefined {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.size > MAX_EXTERNAL_FILE_BYTES) return undefined;
    const content = readFileSync(path);
    const name = createHash("sha1").update(content).digest("hex");
    const target = join(store.filesDir, name);
    if (!existsSync(target)) {
      mkdirSync(store.filesDir, { recursive: true });
      writeFileSync(target, content);
    }
    return name;
  } catch {
    return undefined;
  }
}

/** Do the bytes on disk still match the pre-image? */
function blobMatches(store: RewindStore, record: ExternalFile): boolean {
  if (record.blob === null) return !existsSync(record.path);
  try {
    return readFileSync(record.path).equals(readFileSync(join(store.filesDir, record.blob)));
  } catch {
    return false;
  }
}

/**
 * Record `path`'s current content as a pre-image on the session's newest
 * checkpoint. Returns true when something was recorded.
 *
 * Called from the `tool_call` handler before the tool runs; the caller must
 * serialize it with `createCheckpoint` (both rewrite the metadata file).
 */
export function captureExternalFile(
  store: RewindStore,
  sessionId: string,
  path: string,
): boolean {
  const absolute = resolveTargetPath(store, path);
  if (isWorktreeCovered(store, absolute)) return false;

  const meta = readMeta(store);
  const list = meta.sessions[sessionId];
  if (!list || list.length === 0) return false;
  const ordered = [...list].sort((a, b) => a.timestamp - b.timestamp);
  const newest = ordered[ordered.length - 1];
  if (newest.files?.some((file) => file.path === absolute)) return false;

  const blob = storeBlob(store, absolute);
  if (blob === undefined) return false;

  meta.sessions[sessionId] = list.map((cp) =>
    cp.id === newest.id
      ? { ...cp, files: [...(cp.files ?? []), { path: absolute, blob }] }
      : cp,
  );
  writeMeta(store, meta);
  return true;
}

/**
 * The restore target for `checkpoints[fromIndex..]` (oldest first): the first
 * pre-image recorded for each path, so a file edited in several turns resolves
 * to how it looked before the earliest of them.
 */
export function externalRestorePlan(
  checkpoints: Checkpoint[],
  fromIndex = 0,
): ExternalFile[] {
  const first = new Map<string, ExternalFile>();
  for (let i = Math.max(0, fromIndex); i < checkpoints.length; i += 1) {
    for (const file of checkpoints[i].files ?? []) {
      if (!first.has(file.path)) first.set(file.path, file);
    }
  }
  return [...first.values()];
}

/** What restoring `records` would change on disk right now. */
export function diffExternalFiles(
  store: RewindStore,
  records: ExternalFile[],
): CheckpointDiff {
  const entries: DiffEntry[] = [];
  for (const record of records) {
    if (record.blob === null) {
      // Not in the checkpoint: a restore removes it.
      if (existsSync(record.path)) entries.push({ status: "A", path: record.path });
      continue;
    }
    if (!existsSync(record.path)) {
      entries.push({ status: "D", path: record.path });
      continue;
    }
    if (!blobMatches(store, record)) entries.push({ status: "M", path: record.path });
  }
  return { entries, empty: entries.length === 0 };
}

/** Pre-images of how these paths look right now (the undo net for a restore). */
export function captureFileStates(
  store: RewindStore,
  records: ExternalFile[],
): ExternalFile[] {
  const captured: ExternalFile[] = [];
  for (const record of records) {
    const blob = storeBlob(store, record.path);
    if (blob === undefined) continue;
    captured.push({ path: record.path, blob });
  }
  return captured;
}

/**
 * Put pre-images back on disk: write the blob's bytes, or delete the file when
 * the checkpoint predates it. Returns the paths that were deleted.
 */
export async function restoreExternalFiles(
  store: RewindStore,
  records: ExternalFile[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const record of records) {
    if (record.blob === null) {
      if (existsSync(record.path)) {
        rmSync(record.path, { force: true });
        removed.push(record.path);
      }
      continue;
    }
    if (blobMatches(store, record)) continue;
    const content = readFileSync(join(store.filesDir, record.blob));
    mkdirSync(dirname(record.path), { recursive: true });
    writeFileSync(record.path, content);
  }
  return removed;
}

/** Drop blobs no checkpoint references any more. */
export function pruneBlobs(store: RewindStore): number {
  let names: string[];
  try {
    names = readdirSync(store.filesDir);
  } catch {
    return 0;
  }

  const referenced = new Set<string>();
  const meta = readMeta(store);
  for (const list of Object.values(meta.sessions)) {
    for (const checkpoint of list) {
      for (const file of checkpoint.files ?? []) {
        if (file.blob) referenced.add(file.blob);
      }
    }
  }

  let removed = 0;
  for (const name of names) {
    if (referenced.has(name)) continue;
    rmSync(join(store.filesDir, name), { force: true });
    removed += 1;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// diff / restore
// ---------------------------------------------------------------------------

/** File-level difference between two checkpoint trees. */
export async function diffTrees(
  store: RewindStore,
  fromTree: string,
  toTree: string,
): Promise<CheckpointDiff> {
  if (fromTree === toTree) return { entries: [], empty: true };
  const out = await git(store, [
    "diff-tree",
    "-r",
    "--name-status",
    "--no-commit-id",
    "-M",
    fromTree,
    toTree,
  ]);
  if (!out) return { entries: [], empty: true };

  const entries: DiffEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "?";
    // Renames report "R100\told\tnew"; keep the new path.
    const path = parts.length >= 3 ? parts[2] : parts[1] ?? "?";
    entries.push({ status: status.charAt(0), path });
  }
  return { entries, empty: entries.length === 0 };
}

/** Combined file-level difference of two diffs, keeping the first status per path. */
export function mergeDiffs(first: CheckpointDiff, second: CheckpointDiff): CheckpointDiff {
  const seen = new Set(first.entries.map((entry) => entry.path));
  const entries = [
    ...first.entries,
    ...second.entries.filter((entry) => !seen.has(entry.path)),
  ];
  return { entries, empty: entries.length === 0 };
}

/** Human-readable one-line summary of a diff, e.g. "3 files: +1 ~1 -1". */
export function summarizeDiff(diff: CheckpointDiff): string {
  if (diff.empty) return "no file changes";
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const entry of diff.entries) {
    if (entry.status === "A") added += 1;
    else if (entry.status === "D") deleted += 1;
    else modified += 1;
  }
  const bits: string[] = [];
  if (added) bits.push(`+${added}`);
  if (modified) bits.push(`~${modified}`);
  if (deleted) bits.push(`-${deleted}`);
  return `${diff.entries.length} file${diff.entries.length === 1 ? "" : "s"}: ${bits.join(" ")}`;
}

export interface RestoreOptions {
  /** Pre-images to put back after the worktree reset. Defaults to the
   *  checkpoint's own `files` (right for a safety checkpoint, whose records are
   *  a snapshot of the state it is meant to restore). A rewind passes the plan
   *  built by `externalRestorePlan` for the selected point instead. */
  files?: ExternalFile[];
}

/**
 * Restore the working tree to a checkpoint.
 *
 * Only the working tree changes: the project's own git index/HEAD are never
 * touched, and ignored files (node_modules, build output, …) are never deleted
 * because `git clean` runs without -x.
 */
export async function restoreCheckpoint(
  store: RewindStore,
  checkpoint: Checkpoint,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  await git(store, ["read-tree", "--reset", "-u", checkpoint.tree]);
  const cleanOutput = await git(store, ["clean", "-fd"], { allowFailure: true });
  const removed: string[] = [];
  for (const line of cleanOutput.split("\n")) {
    const match = /^Removing\s+(.*)$/.exec(line.trim());
    if (match?.[1]) removed.push(match[1]);
  }
  removed.push(...(await restoreExternalFiles(store, options.files ?? checkpoint.files ?? [])));
  return { removed };
}

// ---------------------------------------------------------------------------
// pruning
// ---------------------------------------------------------------------------

/** Drop a checkpoint's ref and metadata row. */
export async function deleteCheckpoint(
  store: RewindStore,
  checkpoint: Checkpoint,
): Promise<void> {
  await git(store, ["update-ref", "-d", `${REF_PREFIX}/${checkpoint.id}`], {
    allowFailure: true,
  });
  replaceSessionList(store, checkpoint.sessionId, (list) => list.filter((cp) => cp.id !== checkpoint.id));
  pruneBlobs(store);
}

/**
 * Keep at most `max` prompt/session-start checkpoints per session
 * (Claude Code's 100). Safety checkpoints are always kept — they are the undo
 * net for a restore that already happened.
 */
export async function pruneSession(
  store: RewindStore,
  sessionId: string,
  max = MAX_CHECKPOINTS_PER_SESSION,
): Promise<number> {
  const all = listCheckpoints(store, sessionId);
  const prunable = all.filter((cp) => cp.kind !== "safety");
  if (prunable.length <= max) return 0;

  const victims = prunable.slice(0, prunable.length - max);
  const victimIds = new Set(victims.map((cp) => cp.id));
  for (const victim of victims) {
    await git(store, ["update-ref", "-d", `${REF_PREFIX}/${victim.id}`], { allowFailure: true });
  }
  replaceSessionList(store, sessionId, (list) => list.filter((cp) => !victimIds.has(cp.id)));
  pruneBlobs(store);
  return victims.length;
}

/**
 * Retention sweep: drop every session whose newest checkpoint is older than
 * `days` days, mirroring Claude Code's ~30 day snapshot cleanup.
 */
export async function pruneStaleSessions(
  store: RewindStore,
  now = Date.now(),
  days = RETENTION_DAYS,
): Promise<number> {
  const meta = readMeta(store);
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let deleted = 0;

  for (const [sessionId, list] of Object.entries(meta.sessions)) {
    const newest = list.reduce((max, cp) => Math.max(max, cp.timestamp), 0);
    if (newest >= cutoff) continue;
    for (const cp of list) {
      await git(store, ["update-ref", "-d", `${REF_PREFIX}/${cp.id}`], { allowFailure: true });
      deleted += 1;
    }
    delete meta.sessions[sessionId];
  }

  if (deleted > 0) writeMeta(store, meta);
  pruneBlobs(store);
  return deleted;
}

/** Reclaim objects whose refs were deleted. Best-effort and non-blocking. */
export function gc(store: RewindStore): Promise<void> {
  return git(store, ["gc", "--quiet", "--prune=now"], { allowFailure: true }).then(() => undefined);
}

/** Remove a whole project's shadow repo (used by tests and manual cleanup). */
export function removeStore(store: RewindStore): void {
  rmSync(join(store.gitDir, ".."), { recursive: true, force: true });
}

/** Every project directory under the rewind base dir. */
export function listProjectDirs(agentDir: string): string[] {
  const base = rewindBaseDir(agentDir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(base, entry.name));
}
