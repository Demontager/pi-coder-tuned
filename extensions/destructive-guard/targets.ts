/**
 * destructive-guard / targets.ts — extraction and judgment of deletion targets.
 *
 * Pure functions: no filesystem access, no pi imports (directly `node --test`-able). The
 * judgment rules come from `~/.pi/agent/AGENTS.md`'s `## Destructive actions` — turned into
 * code here.
 *
 * Why deterministic checking: in the 2026-09-23 incident the deletion target was
 * **computed** —
 *
 *     fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true })
 *
 * `s.log[0].x` missing → `?? "/tmp"` fallback → `dirname("/tmp")` = `"/"`. This class of
 * mistake needs no "semantic understanding" to find — pure symbolic analysis is more reliable
 * than LLM judgment and cannot be talked around.
 *
 * Lexical resolution (no symlink resolution) is deliberate: following symlinks needs disk
 * access, while what is wanted here is **deterministic, testable, zero-side-effect**.
 * `/etc` is a link to `/private/etc` on macOS — both paths are in the protection table, so
 * lexical resolution loses nothing.
 */

import { inspectWrittenContent, type WriteFinding } from "./writes.ts";

/** The three verdict tiers: `ok` pass, `confirm` ask once, `block` refuse outright. */
export type Verdict = "ok" | "confirm" | "block";

/** One finding record. */
export interface Finding {
	/** The target's verbatim text in the command (may carry quotes or variables). */
	target: string;
	/** The lexically resolved absolute path; empty when it still holds unexpanded variables. */
	resolved: string;
	verdict: Exclude<Verdict, "ok">;
	/** The rule name, for display. */
	rule: string;
	/** A one-line plain reason. */
	reason: string;
	/** The command segment this target lives in (after `&&` / `|` / `;` splitting), for display. */
	segment?: string;
}

/** One deletion call site: which command, deleting what. */
export interface DeleteSite {
	/** `rm` / `find` / `git clean` / `rsync` / `shred` / `truncate`. */
	command: string;
	/** The target texts, in command-line order. */
	targets: string[];
	/** The containing segment (after `&&` / `|` / `;` splitting), for display. */
	segment: string;
}

/** A stretch of source code about to be executed by an interpreter (inline code or a heredoc body). */
export interface InlineRun {
	/** `node` / `sh` / `python3` … */
	interpreter: string;
	/** The source body that will be executed. */
	code: string;
}

/**
 * Roots that must never be deleted: matching them or being their ancestor → `block`.
 *
 * Only "deleting it is catastrophic and almost never legitimate" entries are listed.
 * **Inside** them does not count — `/usr/local/bin/tsc` is self-installed and may still be
 * deletable; `/usr` itself may not.
 */
export const HARD_ROOTS: readonly string[] = [
	"/",
	"/System",
	"/Library",
	"/Applications",
	"/Users",
	"/usr",
	"/bin",
	"/sbin",
	"/etc",
	"/private",
	"/private/etc",
	"/private/var",
	"/private/var/db",
	"/private/var/root",
	"/Volumes",
	"/opt",
	"/var",
];

/**
 * Worth asking even inside: system-owned trees. Not in `HARD_ROOTS` because `/usr/local`
 * (where self-installed things go) lives under `/usr` — blocking all of `/usr` would jam
 * normal installs.
 *
 * Similarly a concrete file like `/usr/local/bin/tsc` is **self-installed** — deleting it is
 * normal maintenance and should not be asked about; so this tier only fires for **shallow
 * directory levels** — deep concrete files are not asked about (see `isInsideSystemTree`).
 */
export const SYSTEM_TREES: readonly string[] = [
	"/System",
	"/Library",
	"/Applications",
	"/usr/local/Cellar",
	"/usr/local/lib",
	"/private/etc",
	"/private/var/db",
	"/private/var/root",
	"/Volumes",
];

/** VCS store root names: deleting one loses the only copy of history. */
const VCS_DIRS = [".git", ".hg", ".svn"];

/**
 * Temp roots: what `mktemp -d` produces lands here — the practical proxy for "created by this
 * session itself".
 *
 * AGENTS.md's assertion is "outside the working directory **and not created by this
 * session**" needs confirming; "created by this session" cannot be judged statically, and
 * the temp dirs are its only reliable approximation — the guard's own tests and debug
 * scripts all live there, and prompting every time would be no guard at all. Both `/tmp`
 * and `/private/tmp` are listed: the former links to the latter on macOS and this module
 * deliberately does not resolve symlinks. `/var/tmp` and `/private/var/tmp` are added the
 * same way: the stock macOS bash 3.2's heredoc temp dir (compiled in, `TMPDIR` cannot move
 * it), kept in the same list as the seatbelt boundary's `TEMP_WRITE_ROOTS` so the two sides
 * do not drift on "what counts as a temp dir".
 */
const TEMP_ROOTS: readonly string[] = [
	"/tmp",
	"/private/tmp",
	"/var/folders",
	"/private/var/folders",
	"/var/tmp",
	"/private/var/tmp",
];

/**
 * Path suffixes / filenames the guard must protect for itself.
 *
 * In the second 2026-09-23 incident, `rm -rf ~/.pi/agent/extensions/destructive-guard` and
 * `rm -f ~/.pi/agent/AGENTS.md` were both **allowed** — the guard could not see itself, nor
 * the discipline that defines it. Deleting the former disarms it on the spot; deleting the
 * latter erases the source of the judgment rules — so this tier is `block`, not `confirm`.
 */
const SELF_PROTECTED_SUFFIXES: readonly string[] = [
	"/extensions/destructive-guard",
	"/extensions/destructive-guard/",
];

/** The guard's own filenames (protected when under the agent directory). */
const SELF_PROTECTED_BASENAMES: readonly string[] = ["AGENTS.md"];

/** Subtrees under the agent directory where "deleting equals disarming". */
const SELF_PROTECTED_AGENT_SUBTREES: readonly string[] = ["/extensions", "/rewind", "/sessions"];

/** The deletion commands recognized. */
const DELETE_COMMANDS = new Set(["rm", "unlink", "shred", "truncate"]);

/**
 * Wrapper commands skipped as transparent prefixes (`sudo -u root rm -rf x` must still
 * recognize the `rm`).
 * Same list as plan-mode's: these commands change nothing themselves; the real action comes
 * after.
 */
const WRAPPER_COMMANDS = new Set(["sudo", "doas", "env", "command", "nohup", "time", "nice", "xargs", "builtin", "exec"]);

/** Wrapper flags that "consume one value": `nice -n 10 rm`'s `10`, `env -u HOME rm`'s `HOME`. */
const WRAPPER_VALUE_FLAGS = new Set(["-n", "-u", "-C", "-S", "-s", "--user", "--unset", "--chdir"]);

/** Interpreters → their inline-code flags. The code in `node -e` / `sh -c` / `python3 -c` is what is about to run. */
const INLINE_CODE_FLAGS: Readonly<Record<string, readonly string[]>> = {
	node: ["-e", "--eval", "-p", "--print"],
	sh: ["-c"],
	bash: ["-c"],
	zsh: ["-c"],
	dash: ["-c"],
	ksh: ["-c"],
	python: ["-c"],
	python3: ["-c"],
	ruby: ["-e"],
	perl: ["-e"],
};

/**
 * Skip `FOO=bar` assignments and wrapper commands to reach the real command word and args.
 * `sudo`'s own flags (`-u root`) are dropped together with their values.
 */
export function unwrapCommand(words: readonly string[]): { head: string; args: string[] } {
	let index = 0;
	while (index < words.length) {
		const word = words[index]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			index += 1;
			continue;
		}
		const name = word.split("/").pop() ?? "";
		if (WRAPPER_COMMANDS.has(name)) {
			index += 1;
			// the wrapper's own flags and the values they consume
			while (index < words.length) {
				const flag = words[index]!;
				if (flag === "--") {
					index += 1;
					break;
				}
				if (!flag.startsWith("-")) break;
				index += WRAPPER_VALUE_FLAGS.has(flag) ? 2 : 1;
			}
			continue;
		}
		break;
	}
	const head = words[index]?.split("/").pop() ?? "";
	return { head, args: words.slice(index + 1) };
}

/**
 * Restore a shell word to the text it actually passes to the child process.
 *
 * Difference from `stripQuotes`: inside double quotes, `\"` / `\\` / `\$` / `\`` escapes
 * are eaten by the shell (in `sh -c "node -e 'fs.rmSync(\"/Users\")'"` the subcommand
 * really is `fs.rmSync("/Users")`); that layer must come off, or the inline code misjudges
 * as a syntax error.
 */
export function unquoteShellWords(raw: string): string {
	let text = raw.trim();
	for (let round = 0; round < 8; round += 1) {
		let peeled = false;
		if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
			// double quotes: only escapes for `"` `\` `$` `` ` `` are eaten; other backslashes stay
			text = text.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
			peeled = true;
		} else if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
			// single quotes: nothing inside is escaped
			text = text.slice(1, -1);
			peeled = true;
		}
		if (!peeled) break;
	}
	return text;
}

/**
 * For words that are wholly wrapped in quotes and still form a command line after stripping,
 * add an expanded variant: `sh -c "node -e '…'"`'s third word expands to `node -e '…'`,
 * letting the inline code be extracted.
 *
 * Only for `unwrapCommand` (inline-code extraction) — **not `splitWords`**, where the extra
 * words would be taken as real targets by `extractDeleteSites`, fabricating non-path things
 * like `node` / `-e`.
 */
export function expandQuotedWords(words: readonly string[]): string[] {
	const out: string[] = [];
	for (const word of words) {
		out.push(word);
		const peeled = unquoteShellWords(word);
		if (peeled !== word && peeled.includes(" ")) out.push(peeled);
	}
	return out;
}

/**
 * Extract "inline code about to be executed by an interpreter" from a segment.
 *
 * The incident's shape lives in gate one's blind spot: commands like
 * `node -e 'fs.rmSync(path.dirname(x ?? "/tmp"))'`, `sh -c 'rm -rf $DIR'`,
 * `python3 -c 'shutil.rmtree(os.path.dirname(p))'` carry no danger at the command word — it
 * is inside the interpreter's arguments. Scanning inline code as a subcommand closes the
 * blind spot.
 */
export function extractInlineCode(command: string): InlineRun[] {
	const found: InlineRun[] = [];
	for (const segment of splitSegments(command)) {
		const words = splitWords(segment);
		if (words.length === 0) continue;
		const { head, args } = unwrapCommand(expandQuotedWords(words));
		const flags = INLINE_CODE_FLAGS[head];
		if (flags === undefined) continue;

		for (let index = 0; index < args.length; index += 1) {
			const flag = unquoteShellWords(args[index]!);
			if (!flags.includes(flag)) continue;
			const code = args[index + 1];
			if (code === undefined) break;
			found.push({ interpreter: head, code: unquoteShellWords(code) });
			break;
		}
	}
	return found;
}

/**
 * Take the body from an `interpreter - <<EOF … EOF` "feed the script to the interpreter via
 * stdin" shape.
 * Same reasoning as inline code: the body is what will really run.
 */
export function extractStdinScript(command: string): InlineRun[] {
	const found: InlineRun[] = [];
	const lines = command.split("\n");

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const match = /^\s*([A-Za-z_][\w.\-/]*)\b[^\n]*?<<-?\s*(["']?)([A-Za-z_][\w]*)\2/.exec(line);
		if (!match) continue;
		const interpreter = (match[1] ?? "").split("/").pop() ?? "";
		if (INLINE_CODE_FLAGS[interpreter] === undefined) continue;

		const delimiter = match[3] ?? "";
		const body: string[] = [];
		for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
			if (lines[cursor]!.trim() === delimiter) {
				index = cursor;
				break;
			}
			body.push(lines[cursor]!);
		}
		if (body.length > 0) found.push({ interpreter, code: body.join("\n") });
	}
	return found;
}

/**
 * Lexical resolution: strip quotes → expand `~` → join cwd for relative paths → collapse `.`
 * and `..`.
 *
 * With unexpanded variables (`$VAR` / `${...}` / `$(...)` / backticks) returns "" — callers
 * read that as "target unknown" rather than treating a fake path as real.
 */
export function resolveLexical(raw: string, cwd: string, home: string): string {
	const unquoted = stripQuotes(raw);
	if (unquoted === "") return "";
	if (hasExpansion(unquoted)) return "";

	let path = unquoted;
	if (path === "~") path = home;
	else if (path.startsWith("~/")) path = home + path.slice(1);

	if (!path.startsWith("/")) path = cwd.replace(/\/+$/, "") + "/" + path;

	const out: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			out.pop();
			continue;
		}
		out.push(part);
	}
	return "/" + out.join("/");
}

/** A path's segment count (`/` is 0, `/tmp` is 1). */
export function componentCount(resolved: string): number {
	if (resolved === "" || resolved === "/") return 0;
	return resolved.split("/").filter((part) => part !== "").length;
}

/** Strip the outermost paired quotes (**multi-layer**: `"'code'"` must reach `code`). */
export function stripQuotes(raw: string): string {
	let text = raw.trim();
	// nested quotes (`sh -c "node -e '…'"`) need several rounds. Each round must be paired to continue,
	// so a half-finished concatenation like `"a" + "b"` does not keep shrinking.
	for (let round = 0; round < 8; round += 1) {
		let peeled = false;
		for (const quote of ['"', "'"]) {
			if (text.length >= 2 && text.startsWith(quote) && text.endsWith(quote)) {
				text = text.slice(1, -1).trim();
				peeled = true;
			}
		}
		if (!peeled) break;
	}
	return text;
}

/** Whether it contains unexpanded shell expansions (variables, command substitution, backticks). */
export function hasExpansion(text: string): boolean {
	return text.includes("$") || text.includes("`");
}

/**
 * Judge a single target. `cwd` / `home` come from the caller (keeping it pure).
 */
export function evaluateTarget(raw: string, cwd: string, home: string): Finding | undefined {
	const text = stripQuotes(raw);
	const finding = (verdict: Exclude<Verdict, "ok">, rule: string, reason: string, resolved = ""): Finding => ({
		target: raw,
		resolved,
		verdict,
		rule,
		reason,
	});

	// explicit home dir / root synonyms: dead without even resolving.
	if (text === "/" ) return finding("block", "filesystem-root", "The target is the filesystem root");
	if (text === "~" || text === "$HOME" || text === "${HOME}") {
		return finding("block", "home-root", "The target is the home directory itself");
	}

	// a fallback value sitting on the deletion target: the incident's direct cause.
	if (/\?\?|\|\||\$\{[A-Za-z_][A-Za-z0-9_]*:-/.test(text)) {
		return finding("confirm", "fallback-in-target", "The deletion target has a fallback value (a missing value falls back to a default path)");
	}

	// a computed target: dirname / basename / variables / command substitution.
	if (/\bdirname\b|\bbasename\b/.test(text) || hasExpansion(text)) {
		return finding(
			"confirm",
			"derived-target",
			"The deletion target is computed (variable / $(…) / dirname, etc.) and cannot be determined statically. Resolve and verify the exact path before deleting",
		);
	}

	const resolved = resolveLexical(text, cwd, home);
	if (resolved === "") {
		return finding("confirm", "derived-target", "The deletion target cannot be resolved statically (variable or command substitution); the exact path is unknown before execution");
	}

	const depth = componentCount(resolved);
	if (depth < 2) {
		return finding("block", "top-level", `Resolves to ${resolved}, with only ${depth} path components (top-level directories cannot be deletion targets)`, resolved);
	}

	if (resolved === home) {
		return finding("block", "home-root", "The target is the home directory itself", resolved);
	}

	for (const root of HARD_ROOTS) {
		if (root === "/") continue;
		if (resolved === root) {
			return finding("block", "protected-root", `The target is the protected root ${root}`, resolved);
		}
		if (root.startsWith(resolved + "/")) {
			return finding("block", "ancestor-of-protected", `${resolved} is an ancestor of the protected directory ${root}`, resolved);
		}
	}

	for (const tree of SYSTEM_TREES) {
		if (resolved === tree || resolved.startsWith(tree + "/")) {
			return finding("confirm", "system-tree", `${resolved} is inside the system directory ${tree}`, resolved);
		}
	}

	for (const dir of VCS_DIRS) {
		if (resolved === dir || resolved.endsWith("/" + dir)) {
			return finding("confirm", "vcs-store", `${resolved} is version-control storage; deleting it loses the only copy of history`, resolved);
		}
	}

	// the guard itself: deleting it disarms on the spot, so block not confirm.
	const selfFinding = evaluateSelfProtection(resolved, home);
	if (selfFinding !== undefined) return finding("block", selfFinding.rule, selfFinding.reason, resolved);

	// AGENTS.md's third assertion: outside the working directory and not created by this session → confirm.
	// "created by this session" is not statically decidable; temp dirs are its only reliable approximation (see TEMP_ROOTS).
	// fires only inside the **home subtree**: both incidents' entire loss surface was inside `$HOME`, while
	// package-manager turf like `/usr/local/bin/tsc` would only produce noise (AGENTS.md explicitly says it is deletable).
	const outside = evaluateOutsideWorkdir(resolved, cwd, home);
	if (outside !== undefined) return finding("confirm", outside.rule, outside.reason, resolved);

	return undefined;
}

/** Whether the resolved path is the guard itself (or the discipline that defines it). */
function evaluateSelfProtection(resolved: string, home: string): { rule: string; reason: string } | undefined {
	for (const suffix of SELF_PROTECTED_SUFFIXES) {
		if (resolved.endsWith(suffix.replace(/\/$/, ""))) {
			return {
				rule: "self-protection",
				reason: `${resolved} is destructive-guard's own directory; deleting it disables this guard`,
			};
		}
	}

	const agentDir = `${home}/.pi/agent`;
	if (resolved === agentDir || resolved.startsWith(`${agentDir}/`)) {
		const rest = resolved.slice(agentDir.length);
		const basename = rest.split("/").filter(Boolean).at(-1) ?? "";
		if (SELF_PROTECTED_BASENAMES.includes(basename) && rest.split("/").filter(Boolean).length === 1) {
			return {
				rule: "self-protection",
				reason: `${resolved} is a global rules file used by destructive-guard; deleting it removes the policy source`,
			};
		}
		for (const subtree of SELF_PROTECTED_AGENT_SUBTREES) {
			if (rest === subtree || rest.startsWith(`${subtree}/`)) {
				return {
					rule: "self-protection",
					reason: `${resolved} is in Pi's agent directory${subtree}: it contains extensions, session records, and rewind snapshots; deletion destroys both safeguards and recovery data`,
				};
			}
		}
	}
	return undefined;
}

/** Whether the resolved path is "outside the working directory and not inside a temp dir". */
function evaluateOutsideWorkdir(
	resolved: string,
	cwd: string,
	home: string,
): { rule: string; reason: string } | undefined {
	if (!isUnder(resolved, home)) return undefined;
	if (isUnder(resolved, cwd)) return undefined;
	if (TEMP_ROOTS.some((root) => isUnder(resolved, root))) return undefined;

	return {
		rule: "outside-workdir",
		reason:
			`${resolved} is outside the working directory (${cwd}); the full impact is not visible from here. ` +
			`Confirm the exact path before execution (AGENTS.md, Destructive actions, assertion 3)`,
	};
}

/** Whether `child` is `parent` itself or under it (compared as resolved absolute paths). */
export function isUnder(child: string, parent: string): boolean {
	if (parent === "" || parent === "/") return false;
	const base = parent.replace(/\/+$/, "");
	return child === base || child.startsWith(`${base}/`);
}

/**
 * Extract all deletion call sites from a bash command.
 *
 * Covers `rm` (incl. `-rf` / `-fr` / `--recursive`), `find … -delete` and `find … -exec rm`,
 * `git clean -f`, `rsync --delete`, `shred`, `truncate`. Lexical splitting only — nothing is
 * executed.
 */
export function extractDeleteSites(command: string): DeleteSite[] {
	const sites: DeleteSite[] = [];
	for (const segment of splitSegments(command)) {
		const words = splitWords(segment);
		if (words.length === 0) continue;

		const unwrapped = unwrapCommand(expandQuotedWords(words));
		const head = unwrapped.head;
		const args = unwrapped.args;

		if (DELETE_COMMANDS.has(head)) {
			const targets = nonFlagArgs(args);
			if (targets.length > 0) sites.push({ command: head, targets, segment });
			continue;
		}

		if (head === "find") {
			// targets = the paths after `find` and before the first switch (`-name` / `-delete` are switches).
			const targets = args.filter((arg, index) => !arg.startsWith("-") && args.slice(0, index).every((prior) => !prior.startsWith("-")));
			const deletes = args.some((arg) => arg === "-delete" || arg === "-delete;");
			const execRms = /-exec\s+(rm|unlink|shred)\b/.test(segment);
			if ((deletes || execRms) && targets.length > 0) {
				sites.push({ command: "find", targets, segment });
			}
			continue;
		}

		if (head === "git") {
			const sub = args.find((arg) => !arg.startsWith("-"));
			if (sub === "clean" && args.some((arg) => /^-[a-zA-Z]*[fx]/.test(arg))) {
				sites.push({ command: "git clean", targets: ["."], segment });
			}
			continue;
		}

		if (head === "rsync" && args.includes("--delete")) {
			const positional = nonFlagArgs(args);
			const dest = positional.at(-1);
			if (dest !== undefined) sites.push({ command: "rsync --delete", targets: [dest], segment });
			continue;
		}
	}
	return sites;
}

/**
 * A command's complete judgment: shell-side deletion targets + text-side deletion API calls.
 *
 * Both must be read together: `sh -c 'rm -rf $D'` hits the former,
 * `node -e 'fs.rmSync(dirname(x))'` hits the latter, and they are equally dangerous.
 */
export interface CommandInspection {
	/** Shell side (`rm` / `find -delete` / subcommands peeled out of inline code). */
	findings: Finding[];
	/** Text side (`fs.rmSync(…)` / `shutil.rmtree(…)` / a `rm -rf $VAR` written into a script). */
	textFindings: WriteFinding[];
}

/**
 * Fully judge a bash command: the command itself + the inline code / heredoc bodies it is
 * about to hand to an interpreter.
 *
 * The incident's shape (`node -e 'fs.rmSync(path.dirname(x ?? "/tmp"))'`) does not live at
 * the command word — it is only visible by recursively judging inline code as a subcommand;
 * the depth limit blocks hostile nesting.
 */
export function inspectCommand(command: string, cwd: string, home: string, depth = 2): CommandInspection {
	const findings = inspectBash(command, cwd, home);
	const textFindings = inspectWrittenContent(command, {
		evaluateLiteral: (literal) => {
			const finding = evaluateTarget(literal, cwd, home);
			if (finding === undefined) return undefined;
			return { rule: finding.rule, reason: finding.reason, verdict: finding.verdict };
		},
	});

	if (depth <= 0) return { findings, textFindings };

	for (const run of [...extractInlineCode(command), ...extractStdinScript(command)]) {
		if (run.code.trim() === "") continue;
		const nested = inspectCommand(run.code, cwd, home, depth - 1);
		for (const finding of nested.findings) {
			if (finding.segment === undefined) finding.segment = `${run.interpreter} -c`;
			if (!findings.includes(finding)) findings.push(finding);
		}
		for (const finding of nested.textFindings) {
			// dedupe keeps severity: the outer "whole command" hit is usually info-tier (the inline code is inside shell quotes),
			// and must not swallow the recursively-found confirm-tier hit.
			const key = `${finding.line}\u0000${finding.rule}\u0000${finding.severity}`;
			if (!textFindings.some((prior) => `${prior.line}\u0000${prior.rule}\u0000${prior.severity}` === key)) {
				textFindings.push({ ...finding, reason: `[${run.interpreter} -c] ${finding.reason}` });
			}
		}
	}

	return { findings, textFindings };
}

/**
 * Git commands that discard **uncommitted work**.
 *
 * Unlike path deletion, their target is not a filesystem path but the one-of-a-kind content
 * in the worktree / index / stash — so they get their own extractor (not shoehorned into the
 * target model).
 *
 * In the second 2026-09-23 incident the just-written "gate three" was rolled back to HEAD by
 * a `git reset` — and the `extractDeleteSites` of that day returned an empty array for it:
 * the gate never even looked.
 */
export function extractGitHistoryLoss(command: string): Finding[] {
	const findings: Finding[] = [];

	for (const segment of splitSegments(command)) {
		const words = splitWords(segment);
		if (words.length === 0) continue;
		const { head, args } = unwrapCommand(words);
		if (head !== "git") continue;

		const positional = args.filter((arg) => !arg.startsWith("-"));
		const sub = positional[0];
		if (sub === undefined) continue;

		const push = (rule: string, reason: string): void => {
			findings.push({ target: segment.trim(), resolved: "", verdict: "confirm", rule, reason, segment });
		};

		if (sub === "reset" && args.some((arg) => arg === "--hard")) {
			push(
				"vcs-history-loss",
				"git reset --hard discards all uncommitted working-tree and staged changes, which have no saved stash or commit",
			);
			continue;
		}

		// `git checkout -- <path>`: discards worktree changes.
		// only the `--`-separated shape counts — `git checkout <branch>` / `git checkout -b <branch>` switches branches,
		// losing nothing; `--` is the reliable "paths follow, not a branch" signal.
		if (sub === "checkout" && args.includes("--")) {
			push("vcs-history-loss", "git checkout -- discards uncommitted working-tree changes that may have no other copy");
			continue;
		}

		if (sub === "restore") {
			push("vcs-history-loss", "git restore discards uncommitted working-tree/staged changes that may have no other copy");
			continue;
		}

		if (sub === "stash" && (positional[1] === "drop" || positional[1] === "clear")) {
			push("vcs-history-loss", `git stash ${positional[1]} discards stashed work; the stash may be its only copy`);
			continue;
		}

		if (sub === "branch" && args.some((arg) => /^-[a-zA-Z]*D/.test(arg) || arg === "--delete" || arg === "--force")) {
			push("vcs-history-loss", "git branch -D removes a branch with unmerged commits that may have no other reference");
			continue;
		}
	}
	return findings;
}

/**
 * Fully judge a bash command and return all findings.
 *
 * `cwd` / `home` resolve relative paths and `~`.
 */
export function inspectBash(command: string, cwd: string, home: string): Finding[] {
	const findings: Finding[] = [];
	for (const site of extractDeleteSites(command)) {
		for (const target of site.targets) {
			const finding = evaluateTarget(target, cwd, home);
			if (finding) {
				finding.segment = site.segment;
				findings.push(finding);
			}
		}
	}
	findings.push(...extractGitHistoryLoss(command));
	return findings;
}

/** Split segments on shell `;` `&&` `||` `|` `&` and newlines, quote-aware. */
export function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let token = "";
	let quote: '"' | "'" | null = null;
	let depth = 0;

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;

		if (quote !== null) {
			token += char;
			if (quote === "'" && char === "'") quote = null;
			else if (quote === '"' && char === '"') quote = null;
			else if (quote === '"' && char === "\\" && index + 1 < command.length) {
				token += command[index + 1]!;
				index += 1;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			token += char;
			continue;
		}
		// command substitution does not split: `$(a; b)` is one word's business.
		if (char === "$" && command[index + 1] === "(") depth += 1;
		if (char === ")" && depth > 0) depth -= 1;
		if (depth === 0 && (char === ";" || char === "\n" || char === "&" || char === "|")) {
			if (char === "&" && command[index + 1] === "&") index += 1;
			if (char === "|" && command[index + 1] === "|") index += 1;
			if (token.trim() !== "") segments.push(token.trim());
			token = "";
			continue;
		}
		token += char;
	}
	if (token.trim() !== "") segments.push(token.trim());
	return segments;
}

/** Split a segment into words, quote-aware; quotes stay inside the words (stripped at judgment time). */
export function splitWords(segment: string): string[] {
	const words: string[] = [];
	let token = "";
	let hasToken = false;
	let quote: '"' | "'" | null = null;

	for (let index = 0; index < segment.length; index += 1) {
		const char = segment[index]!;

		if (quote !== null) {
			token += char;
			hasToken = true;
			if (quote === "'" && char === "'") quote = null;
			else if (quote === '"' && char === '"') quote = null;
			else if (quote === '"' && char === "\\" && index + 1 < segment.length) {
				token += segment[index + 1]!;
				index += 1;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			token += char;
			hasToken = true;
			continue;
		}
		// command/parameter substitution (`$(...)` / `${...}` / backticks) counts as one word.
		// otherwise `rm -rf $(dirname "$LOG")` splits at the space into `$(dirname` and `"$LOG")` —
		// two fragments that display as non-paths in the dialog.
		if ((char === "$" && (segment[index + 1] === "(" || segment[index + 1] === "{")) || char === "`") {
			const end = scanSubstitution(segment, index);
			token += segment.slice(index, end);
			hasToken = true;
			index = end - 1;
			continue;
		}
		if (char === " " || char === "\t") {
			if (hasToken) words.push(token);
			token = "";
			hasToken = false;
			continue;
		}
		// `>` and friends are not handled here: this module only cares about "what gets deleted", not redirects.
		token += char;
		hasToken = true;
	}
	if (hasToken) words.push(token);
	return words;
}

/**
 * Scan from `start` (pointing at `$(` / `${` / a backtick) to just past the matching closer;
 * return the end index (exclusive).
 * Quote-aware, paren-counted; no match → eat to end (better one bigger word than fragments).
 */
export function scanSubstitution(segment: string, start: number): number {
	const open = segment[start]!;
	if (open === "`") {
		for (let index = start + 1; index < segment.length; index += 1) {
			if (segment[index] === "\\") {
				index += 1;
				continue;
			}
			if (segment[index] === "`") return index + 1;
		}
		return segment.length;
	}
	const isParen = segment[start + 1] === "(";
	const openChar = isParen ? "(" : "{";
	const closeChar = isParen ? ")" : "}";
	let depth = 0;
	let quote: '"' | "'" | null = null;
	// skip the leading `$'.
	let index = segment[start] === "$" ? start + 1 : start;
	for (; index < segment.length; index += 1) {
		const char = segment[index]!;
		if (quote !== null) {
			if (char === "\\") {
				index += 1;
				continue;
			}
			if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === openChar) depth += 1;
		else if (char === closeChar) {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return segment.length;
}

/** Non-switch args; everything after `--` counts as a target. */
export function nonFlagArgs(args: readonly string[]): string[] {
	const out: string[] = [];
	let afterDoubleDash = false;
	for (const arg of args) {
		if (arg === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (!afterDoubleDash && arg.startsWith("-") && arg !== "-") continue;
		out.push(arg);
	}
	return out;
}
