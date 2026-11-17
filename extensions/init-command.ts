/**
 * /init: Claude Code-style — let the model analyze the current repo and create or
 * update its "memory file".
 *
 * How the target file is picked (when not given explicitly — only the `ctx.cwd`
 * level is considered):
 *   ① `CLAUDE.md` exists → update `CLAUDE.md`
 *   ② else `AGENTS.md` exists → update `AGENTS.md`
 *   ③ neither → create `AGENTS.md`
 * Explicit: `/init <file.md>` (the first word ending in `.md` is the path, the
 * rest is extra requirements), e.g. `/init docs/NOTES.md`, `/init /tmp/foo.md`,
 * `/init focus on build and test`.
 *
 * Why CLAUDE.md wins: this repo (and most of the author's projects) treats
 * `CLAUDE.md` as the body and `AGENTS.md` as a symlink to it — writing
 * `CLAUDE.md` loses nothing on copy/package.
 * pi recognizes both names (`docs/usage.md`'s Context Files: `AGENTS.md` or
 * `CLAUDE.md` load level by level up from cwd, `AGENTS.override.md` winning in
 * the same directory), so this order only decides "which file gets written",
 * never whether it loads.
 *
 * The extension itself **never writes files**: it only picks the target and
 * sends a prompt **as a user message** (`pi.sendUserMessage`) — the model's
 * read / write / edit do the on-disk work. That is exactly Claude Code's `/init`
 * shape (a command + a prompt): the user watches the model's process in the
 * session and can correct it midway; with the extension not touching files,
 * there is no "the extension secretly changed the repo" surprise.
 *
 * Three deliberate decisions:
 *   ① **`await ctx.waitForIdle()` first**: sending a user message while the
 *      agent runs either throws (no `deliverAs` given) or queues as a
 *      followUp — and the target check would go stale meanwhile: this turn may
 *      just have created/deleted `CLAUDE.md`, which would write the content
 *      into the wrong memory file. Judging + sending after the turn ends is
 *      the safest semantics (same reason `/clear` waits for idle first).
 *   ② **Only the cwd level — never search parents**: pi loads level by level;
 *      a user running `/init` inside a subdirectory means that subdirectory's
 *      own memory file — pass a path for anywhere else. Searching upward makes
 *      it far too easy to accidentally rewrite the repo root's memory file.
 *   ③ **No argument completion**: `/init` has only two fixed candidates — the
 *      value does not justify an extra pi-tui dependency surface; a custom
 *      path can be typed, with the usual `read`/`write` relative-path habits.
 *
 * `ctx.hasUI` false (print / json modes) → no notify — there is no UI for the
 * notice to go to; the command still sends the prompt.
 */

import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The auto-detection order: `CLAUDE.md` if present, else `AGENTS.md`. */
const CANDIDATES = ["CLAUDE.md", "AGENTS.md"];

/** Which file to create when neither candidate exists. */
const NEW_FILE = "AGENTS.md";

/** `statSync` follows symlinks — this very repo has `AGENTS.md -> CLAUDE.md`, so both names should count as "exists". */
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

interface InitTarget {
	/** The **absolute path** handed to the model for writing. */
	path: string;
	/** The path shown inside the prompt (relative inside the project, absolute as fallback). */
	display: string;
	exists: boolean;
	/** A path the user gave explicitly (the prompt says it differently and warns against touching the sibling file). */
	explicit: boolean;
}

/**
 * Parse `/init`'s args: the first word ending in `.md` is the target file; the
 * rest is extra requirements. No such word → the whole string is requirements
 * (`/init focus on build and test`).
 */
function parseArgs(args: string): { file?: string; extra: string } {
	const trimmed = args.trim();
	if (!trimmed) return { extra: "" };
	const match = /^(\S+\.md)(?:\s+([\s\S]*))?$/i.exec(trimmed);
	if (!match) return { extra: trimmed };
	return { file: match[1], extra: (match[2] ?? "").trim() };
}

/** Relative inside the project (a `../x` escaping it falls back to absolute — no hiding where it writes). */
function displayPath(cwd: string, path: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function resolveTarget(cwd: string, file: string | undefined): InitTarget {
	if (file) {
		const path = isAbsolute(file) ? file : resolve(cwd, file);
		return { path, display: displayPath(cwd, path), exists: isFile(path), explicit: true };
	}
	for (const name of CANDIDATES) {
		const path = resolve(cwd, name);
		if (isFile(path)) return { path, display: name, exists: true, explicit: false };
	}
	return { path: resolve(cwd, NEW_FILE), display: NEW_FILE, exists: false, explicit: false };
}

/**
 * The prompt. The points:
 *   - Make clear "the file is auto-loaded by every later session" — the model
 *     must know it is writing for the next agent.
 *   - Stress **only verified facts** (this repo's standing rule: no invented
 *     commands, no guessed paths).
 *   - When it exists, stress "read first, keep accurate content, do not rewrite
 *     for the sake of rewriting" — models happily rewrite the whole file,
 *     wiping the repo's hard-earned pitfalls list.
 *   - The "do not include" list (generic advice / directory trees / README
 *     repetition / temporary info) — the most effective lines in Claude Code's
 *     /init prompt, taken verbatim.
 */
function buildPrompt(target: InitTarget, cwd: string, extra: string): string {
	const action = target.exists ? "Update" : "Create";
	const lines = [
		`Analyze this codebase, then ${action} the memory file \`${target.display}\` (absolute path: \`${target.path}\`).`,
		"",
		"Pi automatically loads this file in **every subsequent session**, reading AGENTS.md / CLAUDE.md up from the working directory, with AGENTS.override.md taking precedence in the same directory. Write for the next agent working in this repository.",
		`Project root: \`${cwd}\``,
		"",
		target.exists
			? "The file **already exists**: read it first. Keep accurate content, remove outdated content, and add missing information. Avoid unnecessary rewrites and retain existing troubleshooting notes."
			: "The file **does not exist yet**: create it.",
		"",
		"Explore the repository first (README, dependency/build manifests, CI, tests, and main source). **Write only verified facts**: commands must exist and paths must be correct. Omit uncertain claims rather than inventing them.",
		"",
		"Include, in priority order:",
		"1. **Common commands**: install dependencies, build, test (including individual tests), lint, format, and start local services. State working directories and prerequisites. Use copyable code blocks.",
		"2. **Architecture and code map**: module responsibilities, typical request/build flow, conventions and layers, external dependencies, and generated files that should not be edited manually.",
		"3. **Repository-specific pitfalls**: non-obvious behavior, required workflows (commit format, linked configurations, synchronized copies), and common mistakes.",
		"",
		"Do not include:",
		"- Generic development advice such as writing unit tests, not committing secrets, or providing clear errors.",
		"- Directory trees, exhaustive file lists, or a repetition of the README.",
		"- Temporary information relevant only to the current task.",
		"",
		"Writing style:",
		"- Follow the existing file's language and style; use English for new files. Be concise and prefer useful facts over filler.",
	];
	if (!target.explicit) {
		lines.push(
			"- If AGENTS.md and CLAUDE.md both exist, or one symlinks to the other, **edit only the specified file**; do not duplicate its contents into the other.",
		);
	}
	lines.push(
		"- You may read other agent instructions (.cursorrules, .cursor/rules/, .github/copilot-instructions.md, .claude/) for missing information, but do not modify them.",
		"- Use write / edit tools at the absolute path above, not Bash cat/heredocs.",
		"- Finish with one or two sentences describing the changes.",
	);
	if (extra) lines.push("", `Additional requirements for this /init: ${extra}`);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("init", {
		description: "Analyze the repository and create/update its memory file (CLAUDE.md if present, otherwise AGENTS.md)",
		handler: async (args, ctx) => {
			const { file, extra } = parseArgs(args);
			// the target must be judged at send time: wait out a running agent first (see the file header ①).
			if (!ctx.isIdle()) {
				if (ctx.hasUI) ctx.ui.notify("Waiting for the current turn to finish before starting /init…", "info");
				await ctx.waitForIdle();
			}
			const target = resolveTarget(ctx.cwd, file);
			if (ctx.hasUI) {
				ctx.ui.notify(`${target.exists ? "Update" : "Create"} ${target.display} (${target.path})…`, "info");
			}
			pi.sendUserMessage(buildPrompt(target, ctx.cwd, extra));
		},
	});
}
