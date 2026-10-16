/**
 * git.ts — read the worktree's (+added,-deleted) line counts vs HEAD
 *
 * Likewise **no pi imports**: git runs through an injected `exec` (a thin `pi.exec`
 * interface), and files are read with plain Node fs — so `node --test` drives it
 * directly (a real temp git repo, see git.test.ts).
 *
 * The rules:
 * - tracked files: `git diff --numstat HEAD` = staged + unstaged vs HEAD. An empty
 *   repo (no HEAD) degrades to `git diff --numstat` + `git diff --cached --numstat`
 *   (worktree vs index, plus index vs the empty tree).
 * - untracked files: `git ls-files --others --exclude-standard --full-name`
 *   (repo-root-relative paths — `rev-parse --show-toplevel` makes them absolute),
 *   lines counted one by one.
 * - caps: at most 200 untracked files, 512KiB per file, NUL-containing (binary)
 *   files skipped — a statusline wants "how much just changed", not an audit;
 *   over-cap means undercounting, never an error.
 *
 * Everything runs with `--no-optional-locks` — it never contends for the user's own
 * index.lock.
 */

import { open } from "node:fs/promises";
import { join } from "node:path";
import type { DiffStat } from "./line.ts";

export interface ExecResultLike {
	stdout: string;
	code: number;
	killed: boolean;
}

/** The structural subset of `pi.exec` this uses. */
export type GitExecutor = (
	command: string,
	args: string[],
	options: { cwd: string; timeout: number; signal?: AbortSignal },
) => Promise<ExecResultLike>;

const GIT_TIMEOUT_MS = 3_000;
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_FILE_BYTES = 512 * 1024;

/** Non-git dir / git failure / aborted → undefined. */
export async function readGitDiffStat(
	exec: GitExecutor,
	cwd: string,
	signal: AbortSignal,
): Promise<DiffStat | undefined> {
	const run = (args: string[]) =>
		exec("git", ["--no-optional-locks", ...args], { cwd, timeout: GIT_TIMEOUT_MS, signal }).catch(
			() => undefined,
		);

	const [tracked, untracked, toplevel] = await Promise.all([
		run(["diff", "--numstat", "HEAD"]),
		run(["ls-files", "--others", "--exclude-standard", "--full-name"]),
		run(["rev-parse", "--show-toplevel"]),
	]);
	if (signal.aborted || !tracked || tracked.killed) return undefined;

	let stat: DiffStat | undefined = tracked.code === 0 ? parseNumstat(tracked.stdout) : undefined;
	if (!stat) {
		// an empty repo (no HEAD): worktree vs index plus index vs the empty tree — uncommitted content counts too.
		const [worktree, staged] = await Promise.all([run(["diff", "--numstat"]), run(["diff", "--cached", "--numstat"])]);
		if (!worktree || worktree.code !== 0 || worktree.killed) return undefined;
		stat = sumDiffStats(
			parseNumstat(worktree.stdout),
			staged && staged.code === 0 && !staged.killed ? parseNumstat(staged.stdout) : undefined,
		);
	}

	const root = toplevel && toplevel.code === 0 ? firstLine(toplevel.stdout) : undefined;
	if (!root || !untracked || untracked.code !== 0 || untracked.killed) return stat;

	const files = splitLines(untracked.stdout).slice(0, MAX_UNTRACKED_FILES);
	if (files.length === 0) return stat;
	return { added: stat.added + (await countUntrackedLines(files, root, signal)), deleted: stat.deleted };
}

/** `git diff --numstat` text → accumulated added/deleted; a binary row's "-" counts 0. */
export function parseNumstat(output: string): DiffStat {
	let added = 0;
	let deleted = 0;
	for (const line of splitLines(output)) {
		const [adds, dels] = line.split("\t");
		added += toCount(adds);
		deleted += toCount(dels);
	}
	return { added, deleted };
}

/** Merge the two numstats in the empty-repo branch (worktree vs index + index vs empty tree). */
export function sumDiffStats(base: DiffStat, other: DiffStat | undefined): DiffStat {
	if (!other) return base;
	return { added: base.added + other.added, deleted: base.deleted + other.deleted };
}

/** Text line count: by newlines; a trailing unterminated line still counts; empty text is 0. */
export function countTextLines(text: string): number {
	if (!text) return 0;
	let lines = 0;
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) lines += 1;
	}
	return text.endsWith("\n") ? lines : lines + 1;
}

async function countUntrackedLines(
	files: string[],
	root: string,
	signal: AbortSignal,
): Promise<number> {
	let total = 0;
	for (const relative of files) {
		if (signal.aborted) break;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(join(root, relative), "r");
			const { size } = await handle.stat();
			if (!size || size > MAX_UNTRACKED_FILE_BYTES) continue;
			const buffer = Buffer.allocUnsafe(size);
			const { bytesRead } = await handle.read(buffer, 0, size, 0);
			const content = buffer.subarray(0, bytesRead);
			if (content.includes(0)) continue; // binary
			total += countTextLines(content.toString("utf8"));
		} catch {
			// permission denied / racy delete / abort: count 0 — the statusline does not error on it.
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}
	return total;
}

function toCount(value: string | undefined): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function splitLines(output: string): string[] {
	return output.split(/\r?\n/).filter(Boolean);
}

function firstLine(output: string): string | undefined {
	return output.split(/\r?\n/)[0]?.trim();
}
