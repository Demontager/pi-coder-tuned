/**
 * plan-mode's pure logic layer: the two-state state machine + the bash write judgment during
 * plan phase.
 *
 * Imports no pi / pi-tui, so `node --test clients/pi/extensions/plan-mode/plan.test.ts` covers
 * every branch directly.
 *
 * ## The state machine (two states, aligned with Claude Code)
 *
 *   bypass ──shift+tab / enter_plan_mode──▶ plan ──exit_plan_mode + approval──▶ doc-writing ──▶ bypass
 *     ▲                                     │                                       │
 *     └──────────── request changes / shift+tab ────┘◀──────────── reject (stay in plan) ─────┘
 *
 * **There is no execute state**: after approval write access is restored and the state goes
 * straight back to bypass — "implement per the plan document" is a one-shot instruction
 * handed to the model (in the tool result), not a phase the extension holds. Progress goes
 * back to the model too — it calls `task_set` itself if it wants a task list; the extension
 * no longer mirrors steps or tracks `[DONE:n]` (changed 2026-09-24; rationale in README's
 * plan-mode section).
 *
 * Inside plan there is a **doc-writing sub-state** (`docWriting`), entered when the user
 * picks a with-document route in the approval box. It is deliberately **not a third phase** —
 * the phase stays `plan`, so bash write interception, tool shrinkage, and `exit_plan_mode`'s
 * entry check all keep working; the only differences are that the per-round injected context
 * switches to the doc-writing instruction and `write` alone returns to the tool table
 * (`planModeToolSet(active, true)`), pinned by the `tool_call` hook to the plan document's
 * one path. When the document is written (the `tool_result` hook sees the write succeed), it
 * wraps up: back to bypass, tool set restored, and the wrap-up instruction splits by
 * `docMode` — `execute-with-doc` tells the model to implement, `doc-only` to report the
 * document path and stop.
 *
 * Entering plan snapshots `pi.getActiveTools()`; exiting **restores it verbatim**: the local
 * pi's tool table carries twenty-plus dynamically registered extension tools (mcp /
 * ask_user_question / task_set / task_update …), and a hardcoded whitelist would eat them all
 * (that is exactly what the official plan-mode example does — deliberately not copied).
 *
 * ## The bash judgment
 *
 * Judging "would this command change the workspace", at **simple-command** granularity —
 * split on `;` `&` `|` `&&` `||` `(` `)` and newlines, so `cat a.txt && rm -rf b` is stopped
 * by the rm segment, not waved through by the cat. Four classes of writes are recognized:
 *
 *   1. write redirects: `>` / `>>` (an fd prefix like `2> f` is not an arg; an fd dup like
 *      `2>&1` is not a write)
 *   2. write commands: rm / mv / cp / sed -i / tee / dd / git commit / npm install / sudo …
 *   3. global dangerous flags: `--fix` / `--write` / `--in-place` (eslint --fix,
 *      prettier --write …)
 *   4. heredoc bodies are stripped before judging, so a write command inside "read a heredoc"
 *      is not misjudged
 *
 * **This is a guardrail for a cooperating model, not a sandbox.** The model is explicitly
 * told it cannot change code during plan; this layer only catches the writes it casually
 * issues and hands the reason back (the error result is the model's feedback). Really
 * stopping hostile writes needs an OS-level sandbox — out of this extension's scope. Two
 * known leak shapes: `$(...)` substitution inside double quotes, and commands like
 * `npm run <script>` whose side effects depend on the script — both deliberately let through
 * (better to let through than to block all normal exploration).
 */

// =============================================================================
// Tool set
// =============================================================================

/** pi's write tools (`powershell` is bash's Windows-side equivalent). */
export const WRITE_TOOLS = ["edit", "write", "powershell"] as const;

/**
 * The active tools during plan: write tools removed, **everything else kept verbatim**.
 * Order and dedupe follow pi's own convention so dynamically registered tools are neither
 * lost nor duplicated.
 *
 * `allowWrite` is the doc-writing sub-state's switch: the model then needs `write` to put
 * the plan into a file, but `edit` (modifying existing code) and `powershell` (another
 * write channel) stay removed. The one `write` let back is pinned once more by the
 * `tool_call` hook: only the plan document's path is writable.
 */
export function planModeToolSet(activeTools: readonly string[], allowWrite = false): string[] {
	const hidden = new Set<string>(WRITE_TOOLS);
	if (allowWrite) hidden.delete("write");
	return [...new Set(activeTools.filter((name) => !hidden.has(name)))];
}

// =============================================================================
// State machine
// =============================================================================

export type PlanPhase = "bypass" | "plan";

/**
 * The route the user picked in the approval dialog (both write a document; the difference is
 * whether implementation follows).
 *   - execute-with-doc: write the plan document, then implement per it
 *   - doc-only: write the plan document only, do not implement
 */
export type PlanDocMode = "execute-with-doc" | "doc-only";

export interface PlanState {
	phase: PlanPhase;
	/** plan phase: the pre-entry active-tool snapshot, restored verbatim on exit. */
	toolsBeforePlan?: string[];
	/**
 * plan phase: the full plan text (markdown) the model submitted via `exit_plan_mode`,
 * awaiting user approval.
 * Same shape as Claude Code's `ExitPlanMode(plan)` — no longer a list of structured steps:
 * step-ification belonged to the "extension holds progress" era; with progress handed back
 * to the model it only serves display and filename generation.
 */
	pending?: string;
	/** Which route the user chose (remembered until the document is written — the wrap-up instruction splits on it). */
	docMode?: PlanDocMode;
	/**
 * Doc-writing sub-state: the model is turning the plan into a document.
 * The phase stays "plan" (bash write interception and tool shrinkage all keep working); this
 * boolean is the only distinguishing signal — the per-round context switches from read-only
 * exploration to the doc-writing instruction, and `write` comes back alone.
 */
	docWriting?: boolean;
	/**
 * The doc-writing sub-state's target path: computed and persisted at the moment the user
 * picks a route.
 * It cannot be recomputed on every injection — the collision check asks the filesystem, and
 * after `/resume` a recompute could yield a different `-2` suffix, then the model would
 * write a different file. Compute once, pin it in the state.
 */
	pendingDocPath?: string;
	/**
 * This submission's `summary` (the model's one-line summary).
 * Two uses: the "plan summary" line in the doc-writing instruction, and the doc-name fallback
 * when the model forgets `slug`.
 * Persisted: inside the doc-writing sub-state, after `/resume`, it is still needed to
 * recompute the same path.
 */
	planSummary?: string;
}

export function initialPlanState(): PlanState {
	return { phase: "bypass" };
}

/**
 * Enter plan mode. Already in plan → return unchanged (do not overwrite the tool snapshot).
 * Doc-related fields are cleared too: a previous plan's docMode / docWriting / pendingDocPath
 * / pending mean nothing to a new plan (a leftover docWriting would inject the doc-writing
 * instruction straight into the new round).
 */
export function enterPlan(state: PlanState, activeTools: readonly string[]): PlanState {
	if (state.phase === "plan") return state;
	return {
		phase: "plan",
		toolsBeforePlan: [...activeTools],
		pending: undefined,
		docMode: undefined,
		docWriting: undefined,
		pendingDocPath: undefined,
		planSummary: undefined,
	};
}

/** Leave plan mode for bypass; the tool snapshot clears with it (the restore itself is the caller's job). */
export function cancelPlan(state: PlanState): PlanState {
	return {
		phase: "bypass",
		toolsBeforePlan: undefined,
		pending: undefined,
		docMode: undefined,
		docWriting: undefined,
		pendingDocPath: undefined,
		planSummary: undefined,
	};
}

/** The model submits the full plan via exit_plan_mode; it awaits user approval. */
export function submitPlan(state: PlanState, plan: string, summary?: string): PlanState {
	if (state.phase !== "plan") return state;
	const trimmedSummary = typeof summary === "string" ? summary.trim() : "";
	return {
		...state,
		pending: plan,
		planSummary: trimmedSummary === "" ? undefined : trimmedSummary,
	};
}

/**
 * User rejection: **stays in plan** (not back to bypass), waiting for the model's revised
 * plan.
 * The tool snapshot is kept — the next `exit_plan_mode` just overwrites pending.
 * Doc-writing sub-state flags are cleared: a rejection voids this submission (incl. the route
 * choice).
 */
export function rejectPlan(state: PlanState): PlanState {
	if (state.phase !== "plan") return state;
	return { ...state, pending: undefined, docMode: undefined, docWriting: undefined, pendingDocPath: undefined };
}

/**
 * Enter the doc-writing sub-state: the phase stays "plan" (bash write interception and tool
 * shrinkage depend on it); only the docWriting flag flips and the chosen route + target path
 * are remembered. pending and the tool snapshot stay untouched — routing the wrap-up still
 * needs them. Already inside → return unchanged (idempotent; does not overwrite the pinned
 * path).
 */
export function enterDocWriting(state: PlanState, docMode: PlanDocMode, docPath: string): PlanState {
	if (state.phase !== "plan") return state;
	if (state.docWriting) return state;
	return { ...state, docMode, docWriting: true, pendingDocPath: docPath };
}

export interface DocWriteOutcome {
	/** The state after wrap-up: phase back to bypass, document fields cleared. */
	state: PlanState;
	/** The route the user chose — the wrap-up instruction splits on it. */
	docMode: PlanDocMode;
	/** The plan document's path (the wrap-up instruction reports it to user and model). */
	docPath: string;
}

/**
 * Doc-writing wrap-up: the plan document has landed (verified by the caller); state returns
 * to bypass.
 *
 * Outside the sub-state (docWriting falsy) returns undefined — that is not a wrap-up.
 *
 * **The caller restores the tool set before using the return value**: the restore needs the
 * `toolsBeforePlan` snapshot from the old state, and the new state has already cleared it
 * (same convention as `cancelPlan`).
 */
export function completeDocWrite(state: PlanState): DocWriteOutcome | undefined {
	if (state.phase !== "plan" || !state.docWriting) return undefined;
	const docPath = state.pendingDocPath;
	if (typeof docPath !== "string" || docPath === "") return undefined;
	return {
		state: cancelPlan(state),
		docMode: state.docMode ?? "execute-with-doc",
		docPath,
	};
}

/**
 * The tool set to restore on plan exit: the entry snapshot preferred; absent → fall back to
 * the current active tools (when `--tools` was changed mid-session, honoring the new load
 * result beats restoring a stale snapshot).
 */
export function restoredToolSet(state: PlanState, activeTools: readonly string[]): string[] {
	return state.toolsBeforePlan ? [...state.toolsBeforePlan] : [...activeTools];
}

// =============================================================================
// The bash judgment
// =============================================================================

export interface BashVerdict {
	ok: boolean;
	/** The refusal reason, returned to the model as a tool-error result. */
	reason?: string;
}

/** One simple command: command word + args, plus the redirect targets it writes to disk. */
interface SimpleCommand {
	words: string[];
	writes: string[];
}

/**
 * Command words that write to disk. Only **definite workspace-changers** are listed;
 * `npm run` / `make`-style commands whose side effects depend on script content are
 * deliberately not listed (see the file header's trade-off).
 */
const WRITE_COMMANDS = new Set([
	"rm",
	"rmdir",
	"mv",
	"cp",
	"install",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"chgrp",
	"ln",
	"tee",
	"truncate",
	"dd",
	"shred",
	"patch",
	"sudo",
	"doas",
	"su",
	"kill",
	"pkill",
	"killall",
	"reboot",
	"shutdown",
	"systemctl",
	"service",
	"launchctl",
	"vi",
	"vim",
	"nvim",
	"nano",
	"emacs",
	"code",
	"subl",
	"make",
]);

/** `git`'s write subcommands; reads like `git status/log/diff/show/branch -a` are not listed. */
const GIT_WRITE_SUBCOMMANDS = new Set([
	"add",
	"commit",
	"push",
	"pull",
	"merge",
	"rebase",
	"reset",
	"checkout",
	"switch",
	"restore",
	"stash",
	"clean",
	"cherry-pick",
	"revert",
	"tag",
	"init",
	"clone",
	"rm",
	"mv",
	"apply",
	"am",
	"gc",
	"prune",
	"update-ref",
	"symbolic-ref",
	"worktree",
	"submodule",
]);

/** Package managers' write subcommands. */
const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "bun", "pip", "pip3", "poetry", "gem", "cargo", "go", "composer", "brew"]);
const PACKAGE_WRITE_SUBCOMMANDS = new Set([
	"install",
	"i",
	"add",
	"remove",
	"rm",
	"uninstall",
	"ci",
	"link",
	"publish",
	"update",
	"upgrade",
	"get",
	"dlv",
]);

/** System package managers: nearly every subcommand modifies the system. */
const SYSTEM_PACKAGE_MANAGERS = new Set(["apt", "apt-get", "dnf", "yum", "apk", "pacman", "port", "macports"]);

/** Any command carrying one of these flags counts as a write. */
const WRITE_FLAGS = new Set(["--fix", "--write", "--in-place", "--replace"]);

/**
 * Targets that do not count as changing the workspace when written: `cmd 2>/dev/null` is a
 * model mannerism — blocking it is pure noise.
 * Only true black-hole devices are listed; no real path (not even `/tmp/x`) is in here.
 */
const HARMLESS_WRITE_TARGETS = new Set([
	"/dev/null",
	"/dev/stderr",
	"/dev/stdout",
	"/dev/tty",
	"/dev/zero",
	"nul",
]);

/** Wrapper commands skipped as transparent prefixes (`sudo -u root rm -rf x` must still recognize the `rm`). */
const WRAPPER_COMMANDS = new Set(["env", "command", "nohup", "time", "nice", "xargs", "builtin", "exec"]);

/**
 * Whether a bash command is allowed during plan phase.
 * On `{ ok: false, reason }` the caller should return `reason` to the model as a tool-error
 * result.
 */
export function inspectBashCommand(command: string): BashVerdict {
	const scanned = stripHeredocBodies(command);
	for (const simple of splitSimpleCommands(scanned)) {
		const writes = simple.writes.filter((target) => !HARMLESS_WRITE_TARGETS.has(target));
		if (writes.length > 0) {
			return blocked(`Redirection writes to ${writes.map(quote).join(", ")}`);
		}
		const verdict = inspectSimpleCommand(simple);
		if (!verdict.ok) return verdict;
	}
	return { ok: true };
}

function inspectSimpleCommand(simple: SimpleCommand): BashVerdict {
	const { head, args } = unwrap(simple.words);
	if (!head) return { ok: true };

	for (const arg of args) {
		if (!WRITE_FLAGS.has(arg)) continue;
		return blocked(`Command \`${head}\` has write argument ${arg}`);
	}

	if (WRITE_COMMANDS.has(head)) {
		if (head === "systemctl" || head === "service" || head === "launchctl") {
			const action = args.find((arg) => !arg.startsWith("-"));
			if (!action || action === "status" || action === "show" || action === "list-units" || action === "is-active") {
				return { ok: true };
			}
			return blocked(`Command \`${head} ${action}\``);
		}
		// `make --dry-run` / `-n` only prints what it would run — changes nothing
		if (head === "make" && args.some((arg) => arg === "--dry-run" || arg === "--just-print" || arg === "-n")) {
			return { ok: true };
		}
		return blocked(`Command \`${head}\``);
	}

	if (head === "git") {
		const sub = args.find((arg) => !arg.startsWith("-"));
		if (!sub || !GIT_WRITE_SUBCOMMANDS.has(sub)) return { ok: true };
		// `git branch -a` / `git config --get` are reads and pass explicitly; a write subcommand without those switches lands on git's write list.
		return blocked(`Command \`git ${sub}\``);
	}

	if (PACKAGE_MANAGERS.has(head)) {
		const sub = args.find((arg) => !arg.startsWith("-"));
		if (!sub || !PACKAGE_WRITE_SUBCOMMANDS.has(sub)) return { ok: true };
		return blocked(`Command \`${head} ${sub}\``);
	}

	if (SYSTEM_PACKAGE_MANAGERS.has(head)) return blocked(`Command \`${head}\``);

	// `sed` / `perl` / `awk` count as writes only with an in-place-edit switch
	if (head === "sed" || head === "perl") {
		if (args.some((arg) => arg === "-i" || arg.startsWith("-i.") || arg === "--in-place")) {
			return blocked(`Command \`${head} -i\``);
		}
	}

	// `find … -delete` / `-exec rm`-style writes hang on the arguments
	if (head === "find" && args.some((arg) => arg === "-delete" || arg === "-exec" || arg === "-execdir")) {
		return blocked("Command `find` has a write action (-delete / -exec)");
	}

	// `truncate` and friends are already in the list; rarer shapes beyond `>| file` get no extra handling.

	return { ok: true };
}

/** Skip `FOO=bar` assignments and `env`/`sudo`-style wrappers to reach the real command word and its args. */
function unwrap(words: readonly string[]): { head: string; args: string[] } {
	let index = 0;
	while (index < words.length) {
		const word = words[index]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPER_COMMANDS.has(word)) {
			index += 1;
			continue;
		}
		// the wrapper's own switches (`nice -n 10 rm`) are skipped
		if (word.startsWith("-")) {
			index += 1;
			continue;
		}
		break;
	}
	const head = words[index]?.split("/").pop() ?? "";
	return { head, args: words.slice(index + 1) };
}

function blocked(reason: string): BashVerdict {
	return { ok: false, reason: `Writes are not permitted during planning: ${reason}` };
}

function quote(text: string): string {
	return /[\s"'`$]/.test(text) ? `"${text}"` : text;
}

/**
 * Split on shell simple-command boundaries, quote/escape aware.
 *
 * Known trade-off: `$(...)` substitution inside double quotes is treated as plain text (not
 * split), because the common `echo "…" > file` has its `>` outside the quotes — already
 * caught by the write-redirect rule — and splitting inside quotes would only add false
 * positives.
 */
export function splitSimpleCommands(command: string): SimpleCommand[] {
	const segments: SimpleCommand[] = [];
	let words: string[] = [];
	let writes: string[] = [];
	let token = "";
	let hasToken = false;
	let quote: '"' | "'" | null = null;
	/** The redirect just scanned: the next word is its target, not an ordinary arg. */
	let redirect: "write" | "read" | "dup" | null = null;

	// only a really-emitted word may clear the "waiting for a redirect target" state: for `>  out.txt`,
	// where spaces sit between the operator and the target, pushToken() at the space must not clear it early.
	const pushToken = () => {
		if (!hasToken) return;
		if (redirect === "write") writes.push(token);
		else if (redirect === null) words.push(token);
		// a read / dup target is neither an arg nor a write
		token = "";
		hasToken = false;
		redirect = null;
	};

	const endSegment = () => {
		pushToken();
		if (words.length > 0 || writes.length > 0) segments.push({ words, writes });
		words = [];
		writes = [];
		redirect = null;
	};

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;

		if (quote === "'") {
			if (char === "'") quote = null;
			else token += char;
			continue;
		}
		if (quote === '"') {
			if (char === "\\") {
				const next = command[index + 1];
				if (next !== undefined && '"\\$`'.includes(next)) {
					token += next;
					index += 1;
				} else {
					token += char;
				}
			} else if (char === '"') {
				quote = null;
			} else {
				token += char;
			}
			continue;
		}

		if (char === "\\") {
			const next = command[index + 1];
			if (next !== undefined) {
				token += next;
				hasToken = true;
				index += 1;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			hasToken = true;
			continue;
		}
		if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")" || char === "\n") {
			endSegment();
			continue;
		}
		if (char === " " || char === "\t" || char === "\r") {
			pushToken();
			continue;
		}
		if (char === ">" || char === "<") {
			// the digit prefix of `2> f` is a file descriptor, not a command word
			if (hasToken && /^\d+$/.test(token)) {
				token = "";
				hasToken = false;
			}
			while (command[index + 1] === char) index += 1;
			const dup = command[index + 1] === "&";
			if (dup) index += 1;
			redirect = char === ">" ? (dup ? "dup" : "write") : dup ? "dup" : "read";
			continue;
		}

		token += char;
		hasToken = true;
	}
	endSegment();

	return segments;
}

/**
 * Replace heredoc bodies with blank lines (line structure preserved), so a write command
 * inside "read a script" is not judged as real execution.
 * No closing delimiter → **return as-is**: better to keep the body and keep scanning
 * (conservative) than to misjudge from an incomplete parse.
 */
export function stripHeredocBodies(command: string): string {
	const lines = command.split("\n");
	const kept: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const heredoc = findHeredoc(line);
		kept.push(line);
		if (!heredoc) continue;

		const { delimiter, stripTabs } = heredoc;
		let end = index + 1;
		for (; end < lines.length; end += 1) {
			const candidate = lines[end]!;
			const body = stripTabs ? candidate.replace(/^\t+/, "") : candidate;
			if (body.trimEnd() === delimiter) break;
			kept.push("");
		}
		if (end >= lines.length) return command; // no terminator: return the whole thing verbatim
		kept.push(lines[end]!);
		index = end;
	}

	return kept.join("\n");
}

/** Find `<<DELIM` / `<<-DELIM` / `<<'DELIM'` in a line and return the delimiter. */
function findHeredoc(line: string): { delimiter: string; stripTabs: boolean } | undefined {
	let quote: '"' | "'" | null = null;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index]!;
		if (quote) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char !== "<" || line[index + 1] !== "<") continue;
		if (line[index + 2] === "<") {
			index += 2; // here-string: no body
			continue;
		}
		let cursor = index + 2;
		const stripTabs = line[cursor] === "-";
		if (stripTabs) cursor += 1;
		while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
		const delimiter = readDelimiter(line, cursor);
		if (delimiter) return { delimiter, stripTabs };
		index = cursor;
	}
	return undefined;
}

function readDelimiter(line: string, start: number): string | undefined {
	const quote = line[start];
	if (quote === "'" || quote === '"') {
		const end = line.indexOf(quote, start + 1);
		if (end === -1) return undefined;
		const value = line.slice(start + 1, end);
		return value.length > 0 ? value : undefined;
	}
	const match = /^[^\s;&|<>()]+/.exec(line.slice(start));
	return match ? match[0] : undefined;
}
