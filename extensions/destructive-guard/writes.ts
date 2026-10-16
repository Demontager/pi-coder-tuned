/**
 * destructive-guard / writes.ts — check a stretch of **executable text** for dangerous
 * deletion calls.
 *
 * Why a separate layer: in the 2026-09-23 incident the bash hook could not see the danger —
 * the dangerous thing was **a line of code written earlier**, and the "run the script" step
 * looked like just `node verify-a.mjs`, completely harmless. Claude Code's classifier has the
 * matching rule (`WRITTEN FILE EXECUTION`):
 *
 *   "A file write or edit is itself an action to evaluate. Judge the written or edited
 *    content against the BLOCK rules now, at write time ... do not defer to a later
 *    execution."
 *
 * This module does exactly one thing: recognize **the incident's shape** — "a deletion target
 * derived from a fallback value or path arithmetic" — in text. It deliberately does no full
 * data-flow analysis: the goal is few false positives while catching the real shape.
 *
 * ## The tightening after 2026-09-23 (false-positive governance)
 *
 * The first version used **substring** matching: `text.includes("rm")` plus a `||` on the
 * same line meant alarm. Replayed over all local sessions, only a handful of 58 hits were
 * real code — documents talking about deletion, tests asserting the guard's behavior, and
 * the guard's own error strings all matched (`const form = a || b` included). The judgment
 * was changed to three rules:
 *
 *   1. **Must be a real call**: `api(` with a non-identifier character on the left
 *      (`confirm(` / `transform(` do not count); on the shell side it must be a switched
 *      command word like `rm -rf` (a mention of "the rm part" in prose does not count).
 *   2. **The dangerous target must land inside the call's argument region**: `??` / `||` /
 *      `dirname()` / variables / a bare root / `..` must appear inside that call's parens
 *      (across lines too) — not merely on the same line.
 *   3. **Grading**: hits inside a non-executable target file (`.md` / `.html` / `.json` …),
 *      or inside a string literal with no execution sink on the same line (eval / execSync /
 *      sh -c …), degrade to `info` — recorded, no dialog.
 *
 * Gate three (the runtime check in `index.ts`) reuses this checker too: a script file about
 * to be run by `node <script>` faces the same criteria as "content just written".
 *
 * Pure functions, no pi imports, directly `node --test`-able.
 */

/** One finding. */
export interface WriteFinding {
	/** The hit's line number (1-based). */
	line: number;
	/** The hit line's verbatim text (clipped to 160 chars). */
	text: string;
	/** The rule name. */
	rule: string;
	/** A one-line plain reason. */
	reason: string;
	/**
 * `confirm` needs user approval; `block` refuses outright; `info` is only recorded
 * (non-executable target files, or quotations inside string literals).
 * The caller acts on the strictest finding.
 */
	severity: WriteSeverity;
}

/** How severe a finding is. */
export type WriteSeverity = "block" | "confirm" | "info";

/** Inspection options. */
export interface WriteInspectOptions {
	/** Where this text is being written / which script file it is (judges whether the target can execute). */
	targetPath?: string;
	/**
 * The literal-target judge (injected by the caller — typically `targets.ts`'s
 * `evaluateTarget`).
 * Injected rather than imported: this module must stay directly `node --test`-able without
 * cwd/home.
 * Returning `undefined` means that literal target passes.
 */
	evaluateLiteral?: (literal: string) => { rule: string; reason: string; verdict: "block" | "confirm" } | undefined;
}

/** The deletion-API names (longest first, so `rmSync` is not claimed by `rm`). */
const DELETE_APIS = [
	"os.removedirs",
	"shutil.rmtree",
	"rmdirSync",
	"unlinkSync",
	"os.remove",
	"rmSync",
	"rmdir",
	"unlink",
];

/** Path-arithmetic functions: using them on a deletion target makes it a "derived target". */
const PATH_OPS = /\b(dirname|basename|resolve|normalize|join|relative)\s*\(/;

/** A fallback value in the target (the incident's direct cause). */
const FALLBACK = /\?\?|\|\|/;

/** Variables / command substitution / template literals. */
const EXPANSION = /\$\{|\$[A-Za-z_]|`/;

/** A parent-directory segment: a standalone `..` (`...rest` and `?.` do not count). */
const PARENT_SEGMENT = /(^|[^\w.])\.\.([^\w.]|$)/;

/** A bare-root target: `("/")` / `('/')` / `(\`/\`)`. */
const BARE_ROOT = /[(,]\s*["'`]\/["'`]\s*[,)]/;

/** Shell-side deletion command words: must carry a switch (a prose mention of "the rm part" does not count).
 * The prefix allows quotes/backticks — `execSync("rm -rf $D")` and commands inside templates are real commands;
 * pure quotations are downgraded by the "literal" path below, not decided here. */
const SHELL_DELETE = /(?:^|[;&|(]|\s|["'`])(?:sudo\s+)?(rm|unlink|shred)\s+(-[^\s]+)([^;&|]*)/;

/** PowerShell's recursive delete. */
const POWERSHELL_DELETE = /Remove-Item\b[^\n]*-(?:Recurse|Force)\b/i;

/** These on the same line mean "this text will be executed" — even inside a string it is not pure data. */
const EXEC_SINK = /\b(exec|execSync|spawn|spawnSync|execFile|fork|eval|Function|os\.system|popen|subprocess|child_process|system)\b|\b(sh|bash|zsh)\s+-c\b/;

/**
 * Target-file extensions whose content never executes: what is written there cannot run.
 * Only genuinely non-executing ones are listed; `.json` / `.svg` / `.xml` are data, and a
 * script inside `.html` does not run because it was written.
 */
const NON_EXECUTABLE_EXTENSIONS = new Set([
	".md",
	".markdown",
	".mdx",
	".txt",
	".rst",
	".html",
	".htm",
	".xml",
	".svg",
	".json",
	".jsonl",
	".ndjson",
	".csv",
	".tsv",
	".log",
	".diff",
	".patch.txt",
]);

/** Whether the target file never executes its content. No path → treated as executable (better to ask). */
export function isNonExecutableTarget(targetPath: string | undefined): boolean {
	if (targetPath === undefined || targetPath === "") return false;
	const lower = targetPath.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot < 0) return false;
	return NON_EXECUTABLE_EXTENSIONS.has(lower.slice(dot));
}

/** One string/template-literal range. */
export interface QuotedRange {
	start: number;
	end: number;
	kind: '"' | "'" | "`";
	/** Whether the template carries `${…}`: if so it is real code (spliced into a command), not a quotation. */
	interpolates: boolean;
}

/**
 * Scan the whole text and mark the ranges inside string/template literals.
 * Templates additionally carry `interpolates`: a template with `${…}` is real code (spliced
 * into commands), not a quotation.
 */
export function quotedRanges(content: string): QuotedRange[] {
	const ranges: QuotedRange[] = [];
	let quote: '"' | "'" | "`" | null = null;
	let start = 0;

	for (let index = 0; index < content.length; index += 1) {
		const char = content[index]!;
		if (quote === null) {
			if (char === '"' || char === "'" || char === "`") {
				quote = char;
				start = index;
			}
			continue;
		}
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === quote) {
			const body = content.slice(start + 1, index);
			ranges.push({ start, end: index + 1, kind: quote, interpolates: quote === "`" && body.includes("${") });
			quote = null;
		}
	}
	if (quote !== null) {
		const body = content.slice(start + 1);
		ranges.push({ start, end: content.length, kind: quote, interpolates: quote === "`" && body.includes("${") });
	}
	return ranges;
}

function insideRanges(ranges: readonly QuotedRange[], index: number): QuotedRange | undefined {
	return ranges.find((range) => index >= range.start && index < range.end);
}

/** Scan from `open` (pointing at `(`) to the matching `)` and return the region's text. No match → eat to end. */
export function balancedRegion(content: string, open: number): string {
	let depth = 0;
	let quote: '"' | "'" | "`" | null = null;

	for (let index = open; index < content.length; index += 1) {
		const char = content[index]!;
		if (quote !== null) {
			if (char === "\\") {
				index += 1;
				continue;
			}
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) return content.slice(open, index + 1);
		}
	}
	return content.slice(open);
}

/** Whether this argument region carries a "derived target" shape; returns the matching rule's name. */
function classifyRegion(region: string): { rule: string; reason: string } | undefined {
	if (FALLBACK.test(region)) {
		return {
			rule: "fallback-in-delete",
			reason: "The deletion argument uses a fallback (`??` / `||`); a missing value substitutes a default path that may not be the intended target",
		};
	}
	if (PATH_OPS.test(region)) {
		const op = PATH_OPS.exec(region)?.[1] ?? "dirname";
		return {
			rule: "derived-delete-target",
			reason: `The deletion target comes from ${op}(), not a literal path; explicitly verify the resolved path before deleting`,
		};
	}
	if (EXPANSION.test(region)) {
		return {
			rule: "derived-delete-target",
			reason: "The deletion target is computed from a variable, command substitution, or template string; the exact path cannot be determined statically",
		};
	}
	if (BARE_ROOT.test(region) || PARENT_SEGMENT.test(region.replace(/["'`]/g, " "))) {
		return { rule: "root-or-parent-delete", reason: "The deletion target is a root directory or a parent traversal (`..`)" };
	}
	return undefined;
}

/**
 * The first literal argument of a call (`rmSync("/Users", …)`'s `/Users`).
 * undefined when absent or not a literal.
 */
export function firstLiteralArg(region: string): string | undefined {
	const open = region.indexOf("(");
	if (open < 0) return undefined;
	const after = region.slice(open + 1).replace(/^\s+/, "");
	const match = /^(["'`])([^"'`]*)\1/.exec(after);
	if (!match) return undefined;
	const body = match[2] ?? "";
	// a variable inside a template is not a literal
	if (body.includes("${")) return undefined;
	return body;
}

/** The line number the `index`-th character sits on (1-based). */
function lineAt(content: string, index: number): number {
	let line = 1;
	for (let cursor = 0; cursor < index; cursor += 1) {
		if (content[cursor] === "\n") line += 1;
	}
	return line;
}

/** The line's verbatim text (for display). */
function lineText(content: string, line: number): string {
	const raw = content.split("\n")[line - 1] ?? "";
	return raw.length > 160 ? raw.slice(0, 160) + "…" : raw;
}

/** Whether this line is a comment/doc line (does not execute). */
function isCommentLine(text: string): boolean {
	const trimmed = text.trim();
	return (
		trimmed === "" ||
		trimmed.startsWith("//") ||
		trimmed.startsWith("#") ||
		trimmed.startsWith("*") ||
		trimmed.startsWith("/*") ||
		trimmed.startsWith("<!--") ||
		trimmed.startsWith(">")
	);
}

/** Strip doc markup so a quotation like `<code>rm -rf b</code>` is not judged a command word.
 * Only **non-interpolating** backtick segments are stripped: a template with `${…}` is real
 * code (`execSync(\`rm -rf ${D}\`)`) — stripping it would lose a real command. */
function stripDocMarkup(text: string): string {
	return text
		.replace(/<code>[\s\S]*?<\/code>/gi, " ")
		.replace(/<pre>[\s\S]*?<\/pre>/gi, " ")
		.replace(/`([^`]*)`/g, (whole, body: string) => (body.includes("${") ? whole : " "));
}

/**
 * Check a stretch of text for dangerous deletion calls.
 *
 * Returns all findings; the caller decides dialog vs. record-only by `severity`.
 */
export function inspectWrittenContent(content: string, options: WriteInspectOptions = {}): WriteFinding[] {
	if (content === "") return [];

	const findings: WriteFinding[] = [];
	const quoted = quotedRanges(content);
	const downgradeAll = isNonExecutableTarget(options.targetPath);

	const push = (line: number, rule: string, reason: string, literal = false, forced?: WriteSeverity): void => {
		const raw = content.split("\n")[line - 1] ?? "";
		if (isCommentLine(raw)) return;
		findings.push({
			line,
			text: lineText(content, line),
			rule,
			reason,
			severity: forced ?? (downgradeAll || literal ? "info" : "confirm"),
		});
	};

	// ---- shape one: real deletion-API calls (across lines too) ----
	for (const api of DELETE_APIS) {
		const escaped = api.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		// the preceding char must not be part of an identifier (`myrmSync(` does not count) — but `.` must pass:
		// `fs.rmSync(` / `os.remove(` is exactly the method-call shape.
		const pattern = new RegExp(`(?:^|[^\\w])${escaped}\\s*\\(`, "g");
		for (const match of content.matchAll(pattern)) {
			const start = match.index + match[0].length - 1;
			const region = balancedRegion(content, start);
			const line = lineAt(content, match.index);
			const hit = classifyRegion(region);
			if (hit) {
				const where = insideRanges(quoted, match.index);
				// quotations inside strings are not blocked (unless the same line has an execution sink) — but a template with `${…}` is real code.
				const literal =
					where !== undefined &&
					!where.interpolates &&
					!EXEC_SINK.test(content.split("\n")[line - 1] ?? "");
				push(line, hit.rule, hit.reason, literal);
				continue;
			}

			// literal targets: `fs.rmSync("/Users")` / `fs.rmSync("/")`-style calls must be judged by the caller-injected
			// judge (the protected-roots table) — this module does not know which directories are protected.
			const literalArg = firstLiteralArg(region);
			const verdict = literalArg === undefined ? undefined : options.evaluateLiteral?.(literalArg);
			if (verdict === undefined) continue;
			push(line, verdict.rule, verdict.reason, false, verdict.verdict);
		}
	}

	// ---- shape two: shell delete commands (a `rm -rf $VAR` written into a script) ----
	content.split("\n").forEach((raw, index) => {
		const text = stripDocMarkup(raw);
		if (isCommentLine(text)) return;

		const shell = SHELL_DELETE.exec(text);
		if (shell) {
			const flags = shell[2] ?? "";
			const target = shell[3] ?? "";
			const recursive = /[rR]/.test(flags.replace(/^--/, ""));
			const risky = EXPANSION.test(target) || /(^|[^\w.])\.\.([^\w.]|$)/.test(target) || /^["'`]?\/["'`]?$/.test(target.trim());
			if (recursive && risky) {
				// quotations are downgraded the same way (except templates carrying `${…}`).
				const at = text.indexOf("rm ") >= 0 ? raw.indexOf("rm ") : raw.indexOf(shell[1] ?? "rm");
				const where = insideRanges(quoted, Math.max(0, at));
				const literal = where !== undefined && !where.interpolates && !EXEC_SINK.test(text);
				push(
					index + 1,
					"shell-variable-target",
					"The shell deletion target is a variable or parent traversal; an empty variable can turn it into something like `rm -rf /*`",
					literal,
				);
			}
		}

		if (POWERSHELL_DELETE.test(text)) {
			const hasLiteral = /Remove-Item[^\n]*["'][A-Za-z]:[\\\/]|Remove-Item[^\n]*["']\//.test(text);
			if (!hasLiteral) {
				push(index + 1, "derived-delete-target", "Remove-Item -Recurse uses a variable or expression, not a literal path; resolve and verify it before recursive deletion");
			}
		}
	});

	return findings;
}

/** The strictest severity among the findings (`info` when none). */
export function worstSeverity(findings: readonly WriteFinding[]): WriteSeverity {
	if (findings.some((finding) => finding.severity === "block")) return "block";
	return findings.some((finding) => finding.severity === "confirm") ? "confirm" : "info";
}

/**
 * Extract a tool call's target argument from a line (for the error message's "what it would
 * delete").
 * undefined when not found.
 */
export function firstStringArg(text: string, api: string): string | undefined {
	const index = text.indexOf(api);
	if (index < 0) return undefined;
	const after = text.slice(index + api.length);
	const match = /^\s*\(\s*(["'`])([^"'`]*)\1/.exec(after);
	return match?.[2];
}
