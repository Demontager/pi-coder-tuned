/**
 * Tests for git.ts — the (+added,-deleted) working-tree counter.
 *
 * Run with:  node --test clients/pi/extensions/statusline/git.test.ts
 *
 * git.ts never imports pi: it takes an injected `exec`, so these tests drive the real
 * `git` binary against throwaway repos in a temp dir. That covers the exact argv we send
 * (`--numstat HEAD`, `ls-files --others --full-name`, `rev-parse --show-toplevel`) and the
 * root-relative path joining, which a stub could not prove.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { countTextLines, parseNumstat, readGitDiffStat, sumDiffStats, type GitExecutor } from "./git.ts";

const exec: GitExecutor = async (command, args, options) => {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		timeout: options.timeout,
	});
	if (result.error) throw result.error;
	return { stdout: result.stdout ?? "", code: result.status ?? 1, killed: result.signal !== null };
};

function git(cwd: string, ...args: string[]) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

const dirs: string[] = [];

/** New repo with one commit containing `lines.txt` (3 lines). */
function makeRepo(body: string[] = ["a", "b", "c"]): string {
	const dir = mkdtempSync(join(tmpdir(), "statusline-git-"));
	dirs.push(dir);
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "t");
	writeFileSync(join(dir, "lines.txt"), `${body.join("\n")}\n`);
	git(dir, "add", "lines.txt");
	git(dir, "commit", "-qm", "init");
	return dir;
}

const noopSignal = (): AbortSignal => new AbortController().signal;

describe("parseNumstat", () => {
	it("sums added and deleted columns", () => {
		assert.deepEqual(parseNumstat("12\t3\tgateway/config.yaml\n1\t0\tadapter/index.js\n"), {
			added: 13,
			deleted: 3,
		});
	});

	it("counts binary files as zero", () => {
		assert.deepEqual(parseNumstat("-\t-\tassets/blob.png\n4\t1\tline.ts"), { added: 4, deleted: 1 });
	});

	it("is zero for an empty diff", () => {
		assert.deepEqual(parseNumstat(""), { added: 0, deleted: 0 });
	});
});

describe("countTextLines", () => {
	it("counts a trailing open line and ignores the final newline", () => {
		assert.equal(countTextLines(""), 0);
		assert.equal(countTextLines("a"), 1);
		assert.equal(countTextLines("a\n"), 1);
		assert.equal(countTextLines("a\nb"), 2);
		assert.equal(countTextLines("a\nb\n"), 2);
	});
});

describe("sumDiffStats", () => {
	it("merges the empty-repo fallback halves", () => {
		assert.deepEqual(sumDiffStats({ added: 2, deleted: 1 }, { added: 5, deleted: 0 }), {
			added: 7,
			deleted: 1,
		});
		assert.deepEqual(sumDiffStats({ added: 2, deleted: 1 }, undefined), { added: 2, deleted: 1 });
	});
});

describe("readGitDiffStat", () => {
	it("counts tracked edits plus untracked files", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "lines.txt"), "a\nb\nX\n"); // "c" gone, "X" new: +1 / -1
		writeFileSync(join(repo, "note.txt"), "u1\nu2\nu3\n"); // untracked +3
		assert.deepEqual(await readGitDiffStat(exec, repo, noopSignal()), { added: 4, deleted: 1 });
	});

	it("counts repo-wide, including untracked files below the cwd", async () => {
		const repo = makeRepo();
		mkdirSync(join(repo, "deep", "deeper"), { recursive: true });
		writeFileSync(join(repo, "lines.txt"), "a\nb\nX\n"); // +1 / -1
		writeFileSync(join(repo, "deep", "deeper", "new.txt"), "s1\ns2\n"); // untracked below cwd
		const nested = join(repo, "deep");
		assert.deepEqual(await readGitDiffStat(exec, nested, noopSignal()), { added: 3, deleted: 1 });
	});

	it("reports zero for a clean tree", async () => {
		const repo = makeRepo();
		assert.deepEqual(await readGitDiffStat(exec, repo, noopSignal()), { added: 0, deleted: 0 });
	});

	it("skips untracked binaries and oversized files", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "blob.bin"), Buffer.from([0x89, 0, 1, 2, 0, 3]));
		writeFileSync(join(repo, "big.txt"), Buffer.alloc(600 * 1024, 0x41)); // > 512KiB
		assert.deepEqual(await readGitDiffStat(exec, repo, noopSignal()), { added: 0, deleted: 0 });
		writeFileSync(join(repo, "small.txt"), "one\ntwo\n");
		assert.deepEqual(await readGitDiffStat(exec, repo, noopSignal()), { added: 2, deleted: 0 });
	});

	it("counts staged files in a repo without any commit", async () => {
		const repo = mkdtempSync(join(tmpdir(), "statusline-empty-"));
		dirs.push(repo);
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "t@example.com");
		git(repo, "config", "user.name", "t");
		writeFileSync(join(repo, "staged.txt"), "s1\ns2\n");
		writeFileSync(join(repo, "loose.txt"), "l1\n");
		git(repo, "add", "staged.txt");
		assert.deepEqual(await readGitDiffStat(exec, repo, noopSignal()), { added: 3, deleted: 0 });
	});

	it("returns undefined outside a repository", async () => {
		const plain = mkdtempSync(join(tmpdir(), "statusline-nogit-"));
		dirs.push(plain);
		writeFileSync(join(plain, "file.txt"), "x\n");
		assert.equal(await readGitDiffStat(exec, plain, noopSignal()), undefined);
	});

	it("returns undefined once the signal is aborted", async () => {
		const repo = makeRepo();
		const controller = new AbortController();
		controller.abort();
		assert.equal(await readGitDiffStat(exec, repo, controller.signal), undefined);
	});

	it("returns undefined when git itself cannot run", async () => {
		const repo = makeRepo();
		const broken: GitExecutor = async () => {
			throw new Error("ENOENT git");
		};
		assert.equal(await readGitDiffStat(broken, repo, noopSignal()), undefined);
	});

	it("never asks git for optional locks", async () => {
		const repo = makeRepo();
		const argv: string[][] = [];
		const spy: GitExecutor = async (command, args, options) => {
			argv.push([command, ...args]);
			return exec(command, args, options);
		};
		await readGitDiffStat(spy, repo, noopSignal());
		assert.ok(argv.length >= 3, `expected at least 3 git calls, got ${argv.length}`);
		for (const call of argv) {
			assert.equal(call[0], "git");
			assert.equal(call[1], "--no-optional-locks", call.join(" "));
		}
	});
});

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
