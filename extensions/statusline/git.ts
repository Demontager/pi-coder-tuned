/**
 * git.ts — 读工作区相对 HEAD 的 (+新增行,-删除行)
 *
 * 同样**不 import pi**：git 通过注入的 `exec`（`pi.exec` 的瘦接口）调用，纯 Node fs 读文件，
 * 所以能被 `node --test` 直接驱动（真实的临时 git 仓库，见 git.test.ts）。
 *
 * 口径：
 * - 已跟踪文件：`git diff --numstat HEAD` = staged + unstaged 相对 HEAD。空仓库（无 HEAD）
 *   退化成 `git diff --numstat` + `git diff --cached --numstat`（工作区 vs index，再加 index vs 空树）。
 * - 未跟踪文件：`git ls-files --others --exclude-standard --full-name`（仓库根相对路径，
 *   跟着 `rev-parse --show-toplevel` 拼绝对路径），逐个数行。
 * - 上限：最多 200 个未跟踪文件、单文件 512KiB，含 NUL 的（二进制）跳过 —— 状态栏要的是
 *   「刚刚改了多少」，不是精确审计；超限就少算，绝不报错。
 *
 * 全程带 `--no-optional-locks`，不会去抢用户自己的 index.lock。
 */

import { open } from "node:fs/promises";
import { join } from "node:path";
import type { DiffStat } from "./line.ts";

export interface ExecResultLike {
	stdout: string;
	code: number;
	killed: boolean;
}

/** `pi.exec` 的结构化子集。 */
export type GitExecutor = (
	command: string,
	args: string[],
	options: { cwd: string; timeout: number; signal?: AbortSignal },
) => Promise<ExecResultLike>;

const GIT_TIMEOUT_MS = 3_000;
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_FILE_BYTES = 512 * 1024;

/** 非 git 目录 / git 调用失败 / 已 abort → undefined。 */
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
		// 空仓库（无 HEAD）：工作区 vs index 加上 index vs 空树，未提交的内容也算进来。
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

/** `git diff --numstat` 文本 → 累加的 added/deleted；二进制列的 "-" 记 0。 */
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

/** 空仓库分支里把两个 numstat 合起来（工作区 vs index + index vs 空树）。 */
export function sumDiffStats(base: DiffStat, other: DiffStat | undefined): DiffStat {
	if (!other) return base;
	return { added: base.added + other.added, deleted: base.deleted + other.deleted };
}

/** 文本行数：按换行计，末行没有换行也算一行；空文本 0。 */
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
			if (content.includes(0)) continue; // 二进制
			total += countTextLines(content.toString("utf8"));
		} catch {
			// 权限 / 竞态删除 / abort：算 0 就行，状态栏不为此报错。
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
