/**
 * pi-destructive-guard — catches dangerous deletions **before** the tool call executes.
 *
 * Background: on 2026-09-23, a verification script contained
 *
 *     fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true })
 *
 * Because `s.log[0].x` did not exist, `?? "/tmp"` kicked in, `dirname("/tmp")` gave `"/"`,
 * and it deleted for 2.5 minutes as the local user. Root-owned trees survived on permissions;
 * everything writable by `bachi` (most of `/usr/local`, parts of `/Library`, `~/Music`,
 * `~/.vim` …) was gone, with **no second copy anywhere**.
 *
 * The `## Destructive actions` section in AGENTS.md was written two hours before the incident
 * and did not stop it — because that discipline constrains "me", while the incident was
 * "what a script I wrote did at run time". This extension fills exactly that gap: it hooks
 * `tool_call`, inspects arguments **before** execution, and is deterministic code — it does
 * not rely on the model's self-restraint.
 *
 * ## The three gates
 *
 * 1. **bash / powershell**: extract the deletion targets and apply the AGENTS.md assertions
 *    (fewer than two path segments / protected roots / ancestors of protected roots / system
 *    trees / VCS store roots / fallback values and path arithmetic). Wrapper commands at the
 *    head (`sudo` / `env` / `nice` …) are skipped, and **inline code** inside the command
 *    (`node -e '…'` / `sh -c '…'` / `python3 -c '…'`) plus **heredoc bodies fed to an
 *    interpreter via stdin** (`sh - <<EOF … EOF`) are judged again as subcommands — the
 *    incident's shape lives there.
 * 2. **write / edit**: check the **content about to be written** for the deletion shapes
 *    above. The incident's dangerous code was written into a file earlier — the "run the
 *    script" step looked completely harmless. Claude Code's classifier has the matching rule
 *    (`WRITTEN FILE EXECUTION`: the write is itself an action, judged at write time) — this
 *    gate is the same idea.
 * 3. **Before running a script**: commands like `node verify-a.mjs` / `bash deploy.sh` /
 *    `./x.mjs` get **that file read in** and run through the same checks before execution.
 *    This is the only effective interception point for the incident's own line — "run a
 *    script" shows no danger at the command word; the danger is in the file's content.
 *
 * ## The second incident of 2026-09-23 (same day, while gate three was being added)
 *
 * `~/.zshrc`, `~/.gitconfig`, `~/.zprofile`, `~/.pi/agent/sessions/` were all deleted while
 * the two existing gates **passed every single** deleted target: the protection table only
 * guarded the roots themselves (`/`, `$HOME`, `/Users`) — nothing inside a root was caught;
 * AGENTS.md said "outside the working directory needs confirmation" but the code never
 * implemented it (`evaluateTarget` took `cwd` only to resolve relative paths); and commands
 * that destroy uncommitted work like `git reset --hard` were not recognized either — that is
 * exactly what rolled back the just-written gate three.
 *
 * The three patches: `outside-workdir` (outside cwd and not a temp dir → confirm),
 * `self-protection` (the guard's own directory and global rule files → block), and
 * `vcs-history-loss` (`git reset --hard` / `checkout --` / `restore` / `stash drop`).
 *
 * ## Behavior
 *
 * `block` refuses outright (a tool-error result goes back to the model); `confirm` asks once
 * in the TUI, and non-interactive environments always refuse (fail closed — same semantics
 * as Claude Code classifier's `automode-unavailable`).
 *
 * Environment:
 *   `PI_DESTRUCTIVE_GUARD=off`     turn it all off
 *   `PI_DESTRUCTIVE_GUARD=block`   refuse even at the confirm tier (stricter)
 *   `PI_DESTRUCTIVE_GUARD=notify`  notify only, block nothing (observe a while, collect false positives)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
	evaluateTarget,
	expandQuotedWords,
	extractInlineCode,
	extractStdinScript,
	inspectBash,
	inspectCommand,
	splitSegments,
	splitWords,
	stripQuotes,
	unwrapCommand,
	type Finding,
} from "./targets.ts";
import { inspectWrittenContent, worstSeverity, type WriteFinding, type WriteSeverity } from "./writes.ts";

/** The operating mode. */
type Mode = "on" | "off" | "block" | "notify";

/** Per-session stats, for `/destructive-guard`. */
interface Stats {
	checked: number;
	blocked: number;
	confirmed: number;
	allowed: number;
	notified: number;
	/** The user picked "preview what would be deleted first" (also a block, but the model lists the targets first). */
	previewed: number;
	/** How many script files the runtime check (gate three) looked at. */
	runtimeChecked: number;
	/** Script files that could not be read (missing / too large / not a literal path); counted only, never blocked. */
	runtimeSkipped: number;
	/** Hits that were recorded but not blocked (writes onto non-executable targets, quotations). */
	noted: number;
}

/** The hook's return value. */
interface Verdict {
	block: true;
	reason: string;
}

/** The slice of the hook context this extension uses. */
interface GuardContext {
	hasUI?: boolean;
	cwd?: string;
	ui: {
		notify: (text: string, level: string) => void;
		select: (prompt: string, options: string[]) => Promise<string>;
	};
}

/** Write-class tool names → their content field. `edit` uses the old/new pair. */
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch"]);

/** The script-file size cap: beyond it the file is not read (no giant files in memory, no stalled tool calls). */
export const SCRIPT_READ_LIMIT_BYTES = 64 * 1024;

/** Interpreter → its "run a file" shape. */
const SCRIPT_INTERPRETERS = new Set([
	"node",
	"deno",
	"bun",
	"python",
	"python3",
	"ruby",
	"perl",
	"php",
	"bash",
	"sh",
	"zsh",
	"dash",
	"ksh",
]);

/** Directly executable script suffixes (`./deploy.sh`). */
const EXECUTABLE_SCRIPT_SUFFIXES = [".sh", ".bash", ".zsh", ".mjs", ".cjs", ".js", ".py", ".rb", ".pl", ".php"];

function readMode(): Mode {
	const raw = (process.env.PI_DESTRUCTIVE_GUARD ?? "").trim().toLowerCase();
	if (raw === "off" || raw === "0" || raw === "false") return "off";
	if (raw === "block" || raw === "strict") return "block";
	if (raw === "notify" || raw === "dry-run") return "notify";
	return "on";
}

/** All text fields about to be written, from the tool's parameters. */
export function contentFields(input: unknown): string[] {
	if (typeof input !== "object" || input === null) return [];
	const record = input as Record<string, unknown>;
	const out: string[] = [];
	for (const key of ["content", "newText", "new_string", "text", "patch"]) {
		const value = record[key];
		if (typeof value === "string" && value !== "") out.push(value);
	}
	return out;
}

/** Render the findings into a reasoning blurb for the model. */
export function renderFindings(findings: readonly Finding[]): string {
	const lines = findings.map(
		(finding) =>
			`  · ${finding.target}${finding.resolved && finding.resolved !== finding.target ? `  →  ${finding.resolved}` : ""}\n` +
			`    [${finding.rule}] ${finding.reason}`,
	);
	return lines.join("\n");
}

/**
 * Render the findings as **human-facing dialog body**: only the deletion fragments, the
 * resolved concrete paths, and a one-line plain reason.
 *
 * Separate from `renderFindings` (the model-facing version with `[rule]` tags) because the
 * audiences differ: the model needs rule names to map back to the discipline; a human only
 * needs "what gets deleted, why was I stopped, what do I do now".
 *
 * `command` is the whole original command, used only to decide whether an extra context line
 * is warranted: in a single-segment command the "containing command" is the `rm -rf <target>`
 * itself and repeating it is noise; only in chained commands (`&&` / `;` / `|`) does the
 * user need to know which segment it is.
 *
 * `limit` caps the dialog's height: pi's `ExtensionSelectorComponent` does **not scroll**, and
 * pi-tui only paints the document's last `terminal.rows` rows — when the dialog is taller
 * than the terminal **what gets clipped is the top** (the title and "what gets deleted").
 * So the count is hard-capped and the rest folds into one "plus N more" line.
 */
export function renderFindingsForHuman(findings: readonly Finding[], command = "", limit = 3): string {
	const seen = new Set<string>();
	const unique: Finding[] = [];
	for (const finding of findings) {
		// each target is named only once (a chained command may hit it repeatedly).
		const key = `${finding.target}\u0000${finding.resolved}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(finding);
	}
	if (unique.length === 0) return "";

	// only a chained command is worth an extra context line.
	const showSegment = splitSegments(command).length > 1;

	const shown = unique.slice(0, limit);
	const blocks = shown.map((finding) => {
		const lines: string[] = [];
		lines.push(`  Delete target: ${truncateMiddle(finding.target, 100)}`);
		if (finding.resolved && finding.resolved !== finding.target) {
			lines.push(`  Resolved path: ${finding.resolved}`);
		}
		if (showSegment && finding.segment && finding.segment.trim() !== finding.target.trim()) {
			lines.push(`  Command: ${truncateMiddle(finding.segment.trim(), 100)}`);
		}
		lines.push(`  Why blocked: ${finding.reason}`);
		return lines.join("\n");
	});

	const rest = unique.length - shown.length;
	if (rest > 0) blocks.push(`  … plus ${rest} similar matches (choose Cancel, then ask the model to list them)`);
	return blocks.join("\n\n");
}

/** Clip the middle of a long command, keeping head and tail (the whole command may be long inside a dialog). */
export function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const keep = Math.max(8, Math.floor((max - 3) / 2));
	return `${text.slice(0, keep)} … ${text.slice(text.length - keep)}`;
}

/** Render the write-side findings into a reasoning blurb. */
export function renderWriteFindings(findings: readonly WriteFinding[]): string {
	return findings
		.map((finding) => `  Line ${finding.line} [${finding.rule}] ${finding.reason}\n    ${finding.text}`)
		.join("\n");
}

/** The human version of write-side findings: line number + that line of code + why it was blocked. Same count cap (the dialog does not scroll). */
export function renderWriteFindingsForHuman(findings: readonly WriteFinding[], limit = 3): string {
	const shown = findings.slice(0, limit);
	const blocks = shown.map(
		(finding) => `  Line ${finding.line}: ${truncateMiddle(finding.text.trim(), 100)}
  Why blocked: ${finding.reason}`,
	);
	const rest = findings.length - shown.length;
	if (rest > 0) blocks.push(`  … plus ${rest} similar matches`);
	return blocks.join("\n\n");
}

/**
 * Extract "files about to be run as scripts" from a bash command.
 *
 * Three shapes: `node verify-a.mjs` / `python3 x.py` (interpreter + file), `./deploy.sh`
 * (directly executed script), and the same calls **inside inline code** (`sh -c 'node a.mjs'`).
 * Only **literal paths** count — a path built from variables cannot be read and must not be
 * guessed.
 */
export function extractScriptTargets(command: string, depth = 2): string[] {
	const out: string[] = [];
	for (const segment of splitSegments(command)) {
		const words = expandQuotedWords(splitWords(segment));
		if (words.length === 0) continue;
		const { head, args } = unwrapCommand(words);
		const positional = args.filter((arg) => !arg.startsWith("-"));
		const first = positional[0];

		if (SCRIPT_INTERPRETERS.has(head)) {
			// `node -e '…'` is inline code (gate one's job), not a file
			const inline = args.some((arg) => ["-e", "--eval", "-c", "-p", "--print"].includes(arg));
			if (!inline && first !== undefined && first !== "-" && first !== "/dev/stdin") {
				const target = stripQuotes(first);
				if (!target.includes("$") && !target.includes("`")) out.push(target);
			}
			continue;
		}

		// `./x.sh` / `../x.py` / `/abs/path/x.mjs`: the command word itself is the script file.
		// `unwrapCommand` flattens `/x/y` to `y`, so look at the first raw word.
		const rawHead = stripQuotes(words[0] ?? "");
		if (rawHead.startsWith("./") || rawHead.startsWith("../") || rawHead.startsWith("/")) {
			if (EXECUTABLE_SCRIPT_SUFFIXES.some((suffix) => rawHead.toLowerCase().endsWith(suffix))) {
				out.push(rawHead);
				continue;
			}
		}
	}

	// `sh -c 'node a.mjs'`: inline code may still contain script calls.
	if (depth > 0) {
		for (const run of [...extractInlineCode(command), ...extractStdinScript(command)]) {
			for (const nested of extractScriptTargets(run.code, depth - 1)) {
				if (!out.includes(nested)) out.push(nested);
			}
		}
	}
	return out;
}

/** Read a script about to be executed; unreadable → undefined (counted only, never blocked). */
export function readScriptForInspection(target: string, cwd: string): { path: string; content: string } | undefined {
	try {
		const resolved = path.resolve(cwd, target);
		const stat = statSync(resolved);
		if (!stat.isFile() || stat.size > SCRIPT_READ_LIMIT_BYTES) return undefined;
		return { path: resolved, content: readFileSync(resolved, "utf8") };
	} catch {
		return undefined;
	}
}

/**
 * Gate one: deletion-class commands (incl. inline code and heredoc bodies).
 *
 * `undefined` means pass; anything else is the blocking hook result.
 */
async function checkBashCommand(
	command: string,
	cwd: string,
	home: string,
	ctx: GuardContext,
	stats: Stats,
	mode: Mode,
): Promise<Verdict | undefined> {
	const inspected = inspectCommand(command, cwd, home);
	const findings = inspected.findings;
	const textFindings = inspected.textFindings.filter((finding) => finding.severity !== "info");

	if (findings.length === 0 && textFindings.length === 0) {
		stats.checked += 1;
		stats.allowed += 1;
		return undefined;
	}

	stats.checked += 1;
	const hardest = worstTextSeverity(findings, textFindings);
	const body = [renderFindingsForHuman(findings, command), renderWriteFindingsForHuman(textFindings)]
		.filter((part) => part !== "")
		.join("\n\n");
	const rawBody = [renderFindings(findings), renderWriteFindings(textFindings)]
		.filter((part) => part !== "")
		.join("\n\n");

	if (mode === "notify") {
		stats.notified += 1;
		if (ctx.hasUI) ctx.ui.notify(`destructive-guard would block:
${body}`, "warning");
		return undefined;
	}

	if (hardest === "block" || mode === "block") {
		stats.blocked += 1;
		return {
			block: true,
			reason:
				`destructive-guard blocked this deletion:
${rawBody}\n\n` +
				`If deletion is intended, explain the target and reason, then use incremental confirmation (list contents first, or use a reversible move/rename).`,
		};
	}

	// confirm: ask once in the TUI; non-interactive environments fail closed.
	if (!ctx.hasUI) {
		stats.blocked += 1;
		return {
			block: true,
			reason: `destructive-guard blocked this deletion (confirmation is unavailable in this environment; denied fail-closed):
${rawBody}`,
		};
	}

	const choice = await ctx.ui.select(
		`⚠️ destructive-guard: This command deletes files and requires confirmation

` +
			`${body}\n\n` +
			`Cancel deletes nothing. Preview asks the model to list the deletion targets first.`,
		["Cancel", "Preview deletion targets", "Confirm deletion"],
	);
	if (choice === "Confirm deletion") {
		stats.confirmed += 1;
		return undefined;
	}
	if (choice === "Preview deletion targets") {
		stats.previewed += 1;
		return {
			block: true,
			reason:
				`destructive-guard: The user requested a preview. Do not execute this deletion yet. ` +
				`Use read-only commands (ls / find without -delete / du / git clean -n) to show the exact deletion targets. ` +
				`After confirmation, execute using literal paths. Reasons:
${rawBody}`,
		};
	}
	stats.blocked += 1;
	return { block: true, reason: "destructive-guard: The user cancelled this deletion." };
}

/** The strictest tier across the shell side and the text side. */
function worstTextSeverity(findings: readonly Finding[], textFindings: readonly WriteFinding[]): "block" | "confirm" {
	if (findings.some((finding) => finding.verdict === "block")) return "block";
	if (worstSeverity(textFindings) === "block") return "block";
	return "confirm";
}

/**
 * Gate three: commands like `node verify-a.mjs` / `bash deploy.sh` / `./x.mjs` — read the
 * file in and judge it before execution.
 *
 * `undefined` means pass (no hits, or info-tier only); anything else is the blocking hook
 * result.
 */
async function checkScriptTargets(
	command: string,
	cwd: string,
	home: string,
	ctx: GuardContext,
	stats: Stats,
	mode: Mode,
): Promise<Verdict | undefined> {
	const targets = extractScriptTargets(command);
	if (targets.length === 0) return undefined;

	for (const target of targets) {
		const script = readScriptForInspection(target, cwd);
		if (script === undefined) {
			// unreadable → pass (missing / too large / not a file): this is a guardrail, not a sandbox —
			// a dialog over an unreadable path would only be noise.
			stats.runtimeSkipped += 1;
			continue;
		}
		stats.runtimeChecked += 1;

		const scriptDir = path.dirname(script.path);
		const textFindings = inspectWrittenContent(script.content, {
			targetPath: script.path,
			evaluateLiteral: (literal) => toLiteralVerdict(evaluateTarget(literal, scriptDir, home)),
		}).filter((finding) => finding.severity !== "info");
		const shellFindings = inspectBash(script.content, path.dirname(script.path), home);
		if (textFindings.length === 0 && shellFindings.length === 0) continue;

		const hardest = worstTextSeverity(shellFindings, textFindings);
		const body = [renderFindingsForHuman(shellFindings, command, 2), renderWriteFindingsForHuman(textFindings, 2)]
			.filter((part) => part !== "")
			.join("\n\n");
		const rawBody = [renderFindings(shellFindings), renderWriteFindings(textFindings)]
			.filter((part) => part !== "")
			.join("\n\n");

		if (mode === "notify") {
			stats.notified += 1;
			if (ctx.hasUI) ctx.ui.notify(`destructive-guard would block the script ${script.path}:
${body}`, "warning");
			continue;
		}

		if (hardest === "block" || mode === "block" || !ctx.hasUI) {
			stats.blocked += 1;
			return {
				block: true,
				reason:
					`destructive-guard blocked the script ${script.path}: it contains dangerous deletion calls.
${rawBody}\n\n` +
					`First use literal targets and verify the resolved absolute paths, then run the script.`,
			};
		}

		const choice = await ctx.ui.select(
			`⚠️ destructive-guard: The script about to run contains dangerous deletion calls

` +
				`File: ${script.path}\n\n${body}\n\n` +
				`This matches the 2026-09-23 incident: dangerous code was written into a script earlier, while the execution command looked harmless.`,
			["Cancel", "Confirm run"],
		);
		if (choice !== "Confirm run") {
			stats.blocked += 1;
			return { block: true, reason: `destructive-guard: The user cancelled running ${script.path}.` };
		}
		stats.confirmed += 1;
	}
	return undefined;
}

/** Adapt gate one's verdict into the shape the write-side injector wants. */
function toLiteralVerdict(finding: Finding | undefined): { rule: string; reason: string; verdict: "block" | "confirm" } | undefined {
	if (finding === undefined) return undefined;
	return { rule: finding.rule, reason: finding.reason, verdict: finding.verdict };
}

export default function (pi: ExtensionAPI) {
	let mode = readMode();
	const stats: Stats = {
		checked: 0,
		blocked: 0,
		confirmed: 0,
		allowed: 0,
		notified: 0,
		previewed: 0,
		runtimeChecked: 0,
		runtimeSkipped: 0,
		noted: 0,
	};

	pi.registerCommand("destructive-guard", {
		description: "Show destructive-guard status and what it has caught this session",
		handler: async (_args, ctx) => {
			const lines = [
				`Mode: ${mode}${mode === "notify" ? " (notify only; do not block)" : ""}${mode === "block" ? " (also deny actions that require confirmation)" : ""}`,
				`Checked ${stats.checked} deletion actions this session`,
				`Denied ${stats.blocked} · preview requested ${stats.previewed} · confirmed ${stats.confirmed} · allowed ${stats.allowed} · notified ${stats.notified}`,
				`Scripts inspected before execution: ${stats.runtimeChecked} · unreadable/skipped: ${stats.runtimeSkipped} · logged without blocking: ${stats.noted} matches`,
				"",
				"Environment variable: PI_DESTRUCTIVE_GUARD = off | on | block | notify",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", async () => {
		mode = readMode();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (mode === "off") return undefined;

		// pi's cwd is more accurate than `process.cwd()` (the tool call follows the session/subagent).
		const cwd = ctx.cwd ?? process.cwd();
		const home = homedir();
		const guardCtx: GuardContext = { hasUI: ctx.hasUI, cwd, ui: ctx.ui };

		// ---- gate one: deletion-class commands (incl. inline code and heredoc bodies) ----
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = typeof event.input?.command === "string" ? event.input.command : "";
			if (command !== "") {
				const verdict = await checkBashCommand(command, cwd, home, guardCtx, stats, mode);
				if (verdict !== undefined) return verdict;
			}
		}

		// ---- gate three: script files about to be executed ----
		// `node verify-a.mjs` shows no danger at the command word; the danger is in the file's content.
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = typeof event.input?.command === "string" ? event.input.command : "";
			if (command !== "") {
				const verdict = await checkScriptTargets(command, cwd, home, guardCtx, stats, mode);
				if (verdict !== undefined) return verdict;
			}
		}

		// ---- gate two: deletion code inside written content ----
		if (!WRITE_TOOLS.has(event.toolName)) return undefined;

		const blocks = contentFields(event.input);
		if (blocks.length === 0) return undefined;

		const targetPath = writeTargetPath(event.input);
		const all = blocks.flatMap((block) =>
			inspectWrittenContent(block, {
				targetPath,
				evaluateLiteral: (literal) =>
					toLiteralVerdict(
						evaluateTarget(literal, targetPath === undefined ? cwd : path.dirname(path.resolve(cwd, targetPath)), home),
					),
			}),
		);
		if (all.length === 0) return undefined;

		// hits on non-executable targets (`.md` / `.html` …) are only recorded: written prose does not run.
		const findings = all.filter((finding) => finding.severity !== "info");
		if (findings.length === 0) {
			stats.noted += 1;
			return undefined;
		}

		stats.checked += 1;

		if (mode === "notify") {
			stats.notified += 1;
			if (ctx.hasUI) ctx.ui.notify(`destructive-guard would block this write:
${renderWriteFindingsForHuman(findings)}`, "warning");
			return undefined;
		}

		if (worstSeverity(findings) === "block" || mode === "block" || !ctx.hasUI) {
			stats.blocked += 1;
			const why = [
				"destructive-guard blocked this write: the code contains dangerous deletion patterns.",
				renderWriteFindings(findings),
				"",
				"Deleting files is allowed, but these patterns can calculate the wrong target (" +
					"in the 2026-09-23 incident, fs.rmSync(path.dirname(x ?? \"/tmp\")) " +
					"became equivalent to rm -rf /).",
				"Use literal targets, verify resolved absolute paths before deletion, and abort when a protected path matches.",
			].join("\n");
			return { block: true, reason: why };
		}

		const choice = await ctx.ui.select(
			`⚠️ destructive-guard: Code being written to ${writeTargetLabel(event.input)} contains dangerous deletion calls

` +
				`${renderWriteFindingsForHuman(findings)}\n\n` +
				`Deleting files is allowed, but these patterns can calculate the wrong target (in the incident, dirname(x ?? "/tmp") led to rm -rf /).`,
			["Cancel", "Confirm write"],
		);
		if (choice !== "Confirm write") {
			stats.blocked += 1;
			return { block: true, reason: `destructive-guard: The user cancelled this write.` };
		}
		stats.confirmed += 1;
		return undefined;
	});
}

/** The write target's display name (tells the user which file it is in the dialog). */
export function writeTargetLabel(input: unknown): string {
	if (typeof input !== "object" || input === null) return "the file";
	const record = input as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath", "filename"]) {
		const value = record[key];
		if (typeof value === "string" && value !== "") return ` ${value}`;
	}
	return "the file";
}

/** The write target's path (used by the "non-executable target" check). undefined when unavailable. */
export function writeTargetPath(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath", "filename"]) {
		const value = record[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return undefined;
}
