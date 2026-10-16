/**
 * explored-group / phrases — compresses a tool call into a one-line phrase inside the `Explored` group.
 *
 * Pure functions, zero pi dependencies. Target shape (user's decision, 2026-10-06, third revision):
 *
 *     • Explored
 *       └ Search "bashOutput" in clients/pi
 *         Read …/extensions/background-tasks/render.ts 100-169
 *         Read …/ttt/CLAUDE.md, …/ttt/package.json
 *
 * (The `└ ` appears exactly once per block, attached to the first line; other member lines indent by
 * four spaces — the drawing lives in `render.ts`.)
 *
 * ## Phrase table
 *
 * Coverage was measured against 19,847 real bash calls on this machine (counted after removing the
 * non-foldable ones); only the most frequent shapes are kept — rare ones fall through to the
 * `Explore <verb> <args summary>` fallback.
 *
 * | Command | Line |
 * |---|---|
 * | `grep/rg [-rn] PATTERN [FILE/DIR]` | `Search "PATTERN" [in PATH]` |
 * | `ls/fd/tree [PATH]` | `List PATH` |
 * | `find DIR -name GLOB` | `Find GLOB in DIR` |
 * | `git status\|log\|diff\|…` | `Git status` etc. |
 * | `sed -n 'A,Bp' FILE` | `Read FILE A-B` |
 * | `cat/head/tail/jq/wc/diff FILE` | `Read FILE` / `Tail FILE` |
 * | `stat FILE` | `Stat FILE` |
 * | `which a b` | `Which a b` |
 *
 * ## Path shortening (the user's rule: shorten to two directory levels)
 *
 * For `/Users/bachi/jaylli/ttt/a/b/CLAUDE.md` → `…/ttt/a/b/CLAUDE.md`, the `…` prefix is **not**
 * decided here — the rule is "keep at most two directory levels + the file name"; only longer ones
 * get the `…` prefix:
 *
 *     ~/.pi/agent/extensions/a/b/index.ts   →  …/a/b/index.ts      (6 levels, shortened)
 *     clients/pi/extensions/read.ts         →  …/pi/extensions/read.ts (3 dir levels, shortened)
 *     clients/pi/read.ts                    →  clients/pi/read.ts   (2 levels, kept as-is)
 *     src/index.ts                          →  src/index.ts         (1 level, kept as-is)
 *     package.json                          →  package.json         (no directory, kept as-is)
 *
 * Choice of base: **under cwd use the relative path** (shortest and most meaningful); under home use
 * `~`; otherwise use the absolute path, then shorten. The order must not be flipped —
 * `/Users/bachi/jaylli/litellm-any/...` is both "under home" and "under cwd"; we want the latter
 * (relative is shorter).
 */

import { classifyToolCall, segmentVerb, splitShellSegments, stripRedirects } from "./classify.ts";

/** Directory levels kept after shortening (user's decision, 2026-10-06: two). Change this one constant. */
export const PATH_TAIL_DIRS = 2;
/** Shortening prefix (U+2026 + slash), the same glyph as the `…` used by the bash-side collapse. */
const ELLIPSIS_PREFIX = "…/";

/** Strip one layer of quotes (single/double) and return the contents. */
function unquote(value: string): string {
	return value.replace(/^(['"])(.*)\1$/s, "$2");
}

/** Whether this looks like a path (contains `/`, or resembles a file name other than `foo.ts` / `.gitignore` / `Makefile`). */
function looksLikePath(token: string): boolean {
	return token.includes("/") || /\.[A-Za-z0-9]+$/.test(token);
}

/** Strip a `VAR=value` environment prefix (the `P=` part of `P=/path cmd`). */
function stripEnvPrefix(token: string): string | null {
	const match = token.match(/^[A-Za-z_][A-Za-z0-9_]*=(.*)$/s);
	return match ? match[1]! : null;
}

/**
 * Path shortening: **keep at most `PATH_TAIL_DIRS` directory levels + the last segment** (file or
 * directory name); only longer ones get the `…/` prefix.
 *
 * Base priority: cwd-relative → home-relative (`~`) → absolute. Reversing the order would turn
 * `/Users/bachi/jaylli/litellm-any/x.ts` into `~/jaylli/litellm-any/x.ts` (longer and more confusing).
 */
export function shortenPath(input: string, cwd: string | undefined): string {
	let value = unquote(input.trim());
	if (!value) return value;
	if (value === "~") return value;

	const home = process.env.HOME;
	if (cwd && (value === cwd || value.startsWith(`${cwd}/`))) {
		value = value === cwd ? "." : value.slice(cwd.length + 1);
	} else if (home && (value === home || value.startsWith(`${home}/`))) {
		value = value === home ? "~" : `~/${value.slice(home.length + 1)}`;
	}

	// `~` / `…` count as ordinary names in the level calculation (`~/a/b/c.ts` = 3 directories + file name).
	const parts = value.split("/").filter(Boolean);
	if (parts.length <= PATH_TAIL_DIRS + 1) return value;
	return `${ELLIPSIS_PREFIX}${parts.slice(-(PATH_TAIL_DIRS + 1)).join("/")}`;
}

/**
 * Pick "the token that looks like a path" from a command segment's positional arguments,
 * for use as the phrase's path.
 *
 * Three pitfalls, all verified against the 19,847-call corpus:
 *   ① `grep -rn PATTERN a.ts | grep -v node_modules` — the second grep's positional argument
 *      is `node_modules`, not a path. So segments with `-v` (inversion) yield no path.
 *   ② In `tail -60 _vimrc`, `-60` is a line count, not a file name; the `2` in `2>/dev/null`
 *     isn't either (that redirection is already stripped by `stripRedirects`). Judge by
 *     "has a dot / has a slash" + exclude pure numbers.
 *   ③ The fallback matters: the `f` in `cat f` / `grep -n x f` has neither dot nor slash and
 *     **must still count as a path**, otherwise these commands produce no phrase at all.
 */
function pickPathToken(args: string[]): string | undefined {
	const positionals = args
		.filter((token) => !token.startsWith("-"))
		.map(unquote)
		.filter((token) => token && token !== ";" && !/^\d+$/.test(token));
	// Prefer "has a slash" (most path-like), then "looks like a file name",
	// and fall back to the first positional argument
	return positionals.find((token) => token.includes("/"))
		?? positionals.find((token) => looksLikePath(token))
		?? positionals[0];
}

/** Take the first positional argument (`grep`'s PATTERN, `find`'s DIR, …). */
function firstPositional(args: string[]): string | undefined {
	return args
		.filter((token) => !token.startsWith("-"))
		.map(unquote)
		.find((token) => token.length > 0);
}

/** Clip an over-long single token (regex patterns are often long), eliding the middle. */
function clip(text: string, max = 48): string {
	if (text.length <= max) return text;
	const head = Math.ceil((max - 1) / 2);
	return `${text.slice(0, head)}…${text.slice(-(max - 1 - head))}`;
}

/** Recursive or not: `-r` / `-R` / `--recursive`, or an r inside combined short flags (`-rn`). */
function isRecursive(args: string[]): boolean {
	return args.some((token) => /^--recursive$/.test(token) || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(token));
}

/** Produce the phrase for one command segment; `null` means this segment is not worth a line (e.g. a bare `cd`). */
function phraseForSegment(segment: string, cwd: string | undefined): string | null {
	const { verb, args } = segmentVerb(stripRedirects(segment));
	if (!verb) return null;

	if (verb === "grep" || verb === "egrep" || verb === "fgrep" || verb === "rg" || verb === "ag" || verb === "ack") {
		if (args.includes("-v")) return null; // a filter segment, not a search segment
		const pattern = firstPositional(args);
		if (!pattern) return null;
		// Path = the first positional argument other than the pattern
		const rest = args.slice(args.indexOf(args.find((t) => unquote(t) === pattern) ?? pattern) + 1);
		const rawPath = pickPathToken(rest);
		const scope = rawPath
			? shortenPath(rawPath, cwd)
			: isRecursive(args) ? "." : undefined;
		return scope ? `Search "${clip(pattern)}" in ${scope}` : `Search "${clip(pattern)}"`;
	}

	if (verb === "ls" || verb === "tree" || verb === "eza" || verb === "fd" || verb === "du") {
		const positionals = args.filter((t) => !t.startsWith("-")).map(unquote).filter((t) => !/^\d+$/.test(t));
		const target = positionals[positionals.length - 1];
		const verbWord = verb === "du" ? "Size" : "List";
		return `${verbWord} ${target ? shortenPath(target, cwd) : "."}`;
	}

	if (verb === "find") {
		const positionals = args.filter((t) => !t.startsWith("-")).map(unquote);
		const glob = positionals.find((t) => t.includes("*") || t.includes("?"));
		const dir = positionals.find((t) => !t.includes("*") && !t.includes("?"));
		return glob
			? `Find ${clip(glob)}${dir ? ` in ${shortenPath(dir, cwd)}` : ""}`
			: `Find${dir ? ` in ${shortenPath(dir, cwd)}` : " files"}`;
	}

	if (verb === "git") {
		const sub = args.find((t) => !t.startsWith("-"));
		return sub ? `Git ${sub}` : "Git";
	}

	if (verb === "sed") {
		const positionals = args.filter((t) => !t.startsWith("-")).map(unquote);
		const range = positionals.find((t) => /^\d+,\d+p$/.test(t));
		const file = pickPathToken(positionals.filter((t) => t !== range));
		const where = file ? shortenPath(file, cwd) : undefined;
		const span = range ? ` ${range.slice(0, -1).replace(",", "-")}` : "";
		return where ? `Read ${where}${span}` : null;
	}

	if (verb === "head" || verb === "tail") {
		const file = pickPathToken(args.filter((t) => !/^-\d+$/.test(t)));
		if (!file) return null;
		return `${verb === "tail" ? "Tail" : "Read"} ${shortenPath(file, cwd)}`;
	}

	if (verb === "stat") {
		const file = pickPathToken(args);
		return file ? `Stat ${shortenPath(file, cwd)}` : null;
	}

	if (verb === "which" || verb === "type") {
		const names = args.filter((t) => !t.startsWith("-")).map(unquote).slice(0, 3);
		return names.length ? `Which ${names.join(" ")}` : null;
	}

	if (verb === "cat" || verb === "bat" || verb === "less" || verb === "more" || verb === "nl" || verb === "tac" ||
		verb === "cut" || verb === "wc" || verb === "diff" || verb === "comm" || verb === "jq" || verb === "yq" ||
		verb === "file" || verb === "sort" || verb === "uniq" || verb === "awk" || verb === "gawk" ||
		verb === "xxd" || verb === "od" || verb === "strings" || verb === "md5" || verb === "shasum") {
		const file = pickPathToken(args);
		if (!file) return null;
		const path = shortenPath(file, cwd);
		// `diff a b` yields both files (both sides of the comparison matter)
		if (verb === "diff") {
			const both = args.filter((t) => !t.startsWith("-")).map(unquote).filter((t) => looksLikePath(t)).slice(0, 2);
			if (both.length === 2) return `Diff ${shortenPath(both[0]!, cwd)} ${shortenPath(both[1]!, cwd)}`;
		}
		return `Read ${path}`;
	}

	return null;
}

/**
 * One tool call → one phrase line. Returning `null` means no phrase can be produced at this
 * moment (e.g. a bash command that is just `cd`); the caller should skip the line.
 *
 * Multiple files of a `read` are merged into one line by the **upper layer** (`render.ts`),
 * so only a single path is returned here.
 */
export function phraseForToolCall(
	toolName: string,
	args: unknown,
	cwd: string | undefined,
): string | null {
	if (toolName === "grep") {
		const pattern = (args as { pattern?: string })?.pattern;
		const path = (args as { path?: string })?.path;
		if (!pattern) return null;
		return path ? `Search "${clip(pattern)}" in ${shortenPath(path, cwd)}` : `Search "${clip(pattern)}"`;
	}
	if (toolName === "find") {
		const pattern = (args as { pattern?: string })?.pattern;
		const path = (args as { path?: string })?.path;
		if (!pattern) {
			return path ? `Find in ${shortenPath(path, cwd)}` : "Find files";
		}
		return `Find ${clip(pattern)}${path ? ` in ${shortenPath(path, cwd)}` : ""}`;
	}
	if (toolName === "ls") {
		const path = (args as { path?: string })?.path;
		return `List ${path ? shortenPath(path, cwd) : "."}`;
	}
	if (toolName === "read") {
		const path = (args as { path?: string })?.path;
		if (!path) return null;
		return `Read ${shortenPath(path, cwd)}${readSpanSuffix(args)}`;
	}
	if (toolName === "bash") {
		const command = (args as { command?: string })?.command ?? "";
		const verdict = classifyToolCall("bash", args);
		if (!verdict.kind) return null;
		const lines: string[] = [];
		for (const segment of splitShellSegments(command)) {
			const phrase = phraseForSegment(segment, cwd);
			if (phrase && !lines.includes(phrase)) lines.push(phrase);
		}
		return lines.length ? lines[0]! : null;
	}
	return null;
}

/** For tests and debugging: get **all** phrases of a bash command at once (multi-segment commands yield more than one). */
export function phrasesForBash(command: string, cwd: string | undefined): string[] {
	const lines: string[] = [];
	for (const segment of splitShellSegments(command)) {
		const phrase = phraseForSegment(segment, cwd);
		if (phrase && !lines.includes(phrase)) lines.push(phrase);
	}
	return lines;
}

/**
 * Line-number suffix for `read` — **same convention as pi's built-in title** (`formatReadLineRange`:
 * `startLine = offset ?? 1`, `endLine = limit !== undefined ? startLine + limit - 1 : ""`).
 *
 * All three argument shapes must be visible; none may be dropped (all exist in the real corpus,
 * counted across 440 sessions: `offset+limit` 1176 times, **`offset` only 40 times**,
 * **`limit` only 90 times**, neither 1287 times):
 *
 * | Call | Suffix |
 * |---|---|
 * | `{offset: 100, limit: 70}` | ` 100-169` |
 * | `{offset: 100}` | ` 100` |
 * | `{limit: 45}` | ` 1-45` |
 * | `{}` | empty |
 *
 * The old implementation gated on `offset && limit`, so when only one argument was given the
 * **entire span silently disappeared** — "which part was read" is one of the most important facts
 * on this line, and pi natively shows `:100` / `:1-45`; folding it away lost that (the user reported
 * "line-number information seems lost" on 2026-10-06).
 *
 * The `read` span is likewise preserved in merged lines (different spans of the same file are
 * different facts).
 */
export function readSpanSuffix(args: unknown): string {
	const offset = (args as { offset?: number })?.offset;
	const limit = (args as { limit?: number })?.limit;
	if (offset === undefined && limit === undefined) return "";
	const start = offset ?? 1;
	// Without `limit` only the start is known (same as pi: `endLine` stays empty; no guessing the length)
	return limit === undefined ? ` ${start}` : ` ${start}-${start + limit - 1}`;
}
