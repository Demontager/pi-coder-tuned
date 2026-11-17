/**
 * explored-group / classify — decides whether a tool call **belongs to the "read-only lookup" family**,
 * and which category it falls into.
 *
 * Pure functions, zero pi dependencies (`node --test` runs directly, no loader needed). Three consumers:
 *   - `registry.ts`: decides whether a tool block renders 0 lines and joins the current group
 *   - `phrases.ts`: decides what the line says (category → phrase verb)
 *   - `index.ts`: decides whether a tool call should **break** the current group (non-foldable = break)
 *
 * ## Three foldable sources
 *
 * | Source | Fold condition |
 * |---|---|
 * | `read` | always (reading a file is reading a file) |
 * | native `grep` / `find` / `ls` | always |
 * | `bash` | **all read-only**: the first verb of every effective segment is on the read-only allowlist, and there is no write redirection |
 *
 * The "all read-only" rule is deliberately **conservative** — better to fold too little than to fold wrongly:
 *
 *   - `cd X && grep -n foo a.ts | head -20`         → fold (`grep`/`head` are both allowlisted)
 *   - `node --test index.test.ts 2>&1 | grep -E …`  → **no fold** (`node` is not allowlisted)
 *   - `cat > /tmp/x.mjs <<'EOF' … EOF`              → **no fold** (write redirection)
 *   - `cd X && python3 - <<'PY' … open(p,"w") …`   → **no fold** (`python3` is not allowlisted)
 *
 * In other words: **"ran something real and just happened to grep afterwards" is not a broad read** — it is
 * a real execution whose output the model needs to see. In the target session, commands like
 * `node --test … | grep -E '^ℹ'` make up a fair share; folding them would erase "I ran the tests"
 * from the screen — which would be wrong.
 *
 * ## heredoc bodies must be stripped first
 *
 * The body of `cat > f <<'EOF' … EOF` would otherwise be split line-by-line into shell segments where
 * `import` / `const` / `}` all get treated as commands. `stripHeredocBodies` removes the body before
 * splitting; it **keeps** the command head (including `cat > f`), so the write redirection still hits →
 * non-foldable.
 */

/** Read-only verb allowlist: any occurrence means "this segment's intent is to look". */
const READ_VERBS = new Set([
	// content search
	"grep", "egrep", "fgrep", "rg", "ag", "ack",
	// path listing / metadata
	"ls", "find", "fd", "tree", "eza", "du", "stat", "realpath", "readlink",
	"which", "type", "mdfind", "locate", "dirname", "basename",
	// read contents / count / compare
	"cat", "bat", "head", "tail", "less", "more", "nl", "tac",
	"cut", "tr", "wc", "diff", "comm", "jq", "yq", "file",
	"sort", "uniq", "column", "fold", "md5", "shasum", "sha256sum", "xxd", "od", "strings",
	// sed / awk are read-only by default (`sed -i` is caught separately by the in-place check, see below)
	"sed", "awk", "gawk", "perl",
]);

/** Read-only `git` subcommands. Everything else (add/commit/push/checkout/…) is non-foldable. */
const GIT_READ_SUBCOMMANDS = new Set([
	"status", "log", "diff", "show", "branch", "rev-parse", "config",
	"ls-files", "blame", "cat-file", "describe", "shortlog", "remote", "grep",
]);

/** Pure navigation/output verbs: they do not affect the verdict and are skipped outright. */
const NOOP_VERBS = new Set([
	"cd", "pushd", "popd", "echo", "printf", "export", "set", "unset", "source", ".",
	"true", "false", ":", "pwd", "sleep", "wait", "test", "[", "[[", "date", "uname",
]);

/** Command wrappers: skip them to reach the real verb. */
const WRAPPERS = new Set(["sudo", "env", "nohup", "command", "exec", "builtin", "time", "xargs"]);

export type FoldKind = "read" | "search" | "list" | "git" | null;

/**
 * The `skill` case of pi's "compact shape" detection — a `read` of a `SKILL.md`.
 *
 * Mirrors pi `read.js`'s `getCompactReadClassification` (module-private, so it has to be replicated):
 * a file named `SKILL.md` is the skill shape, and the label is the **containing directory name**
 * (`…/skills/commit/SKILL.md` → `commit`).
 *
 * Why this has to be decided at the classify layer (not the rendering layer): the user reported on
 * 2026-10-06 that "reading a Skill file all became `└ Read …/skills/systematic-debugging/SKILL.md`"
 * and asked to restore pi's original `• [skill] commit (ctrl+o to expand)`. Grouping happens
 * **first** inside `renderCall` (a hit renders 0 lines and the leader draws the tree); once it takes
 * over, that `[skill]` branch in pi's renderer never runs — so the exemption must happen at the
 * "does this block join a group" layer, not by rewording the rendering.
 *
 * Measured scale (440 sessions across the repo, 2613 read calls): `SKILL.md` **332 times**, pi's own
 * docs/examples 194 times, `AGENTS.md`/`CLAUDE.md` 88 times — all three compact shapes are genuinely
 * frequent. But **only SKILL.md is exempted** (user's decision, 2026-10-06): `read docs` / `read resource`
 * stay foldable, because the skill look is the only one the user called out, and "read pi's docs once"
 * is indistinguishable from "read a project file once" in an exploration context.
 */
export function isSkillRead(toolName: string, args: unknown): boolean {
	if (toolName !== "read") return false;
	const pathArg = (args as { path?: unknown } | null | undefined)?.path;
	if (typeof pathArg !== "string" || pathArg === "") return false;
	// Only need to check "is the last segment SKILL.md". Accept both separators (same as pi's basename);
	// no resolve — the verdict depends on the file name alone, and behavior is identical when the path
	// fails to resolve (reading a non-existent file).
	const trimmed = pathArg.replace(/[/\\]+$/, "");
	const lastSegment = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
	return lastSegment === "SKILL.md";
}

export interface FoldVerdict {
	/** Non-null when foldable — it is also the category of this line's phrase. */
	kind: FoldKind;
	/**
	 * **Arguments have not fully arrived yet, so no verdict can be made** (see `isPendingArgs`).
	 *
	 * This is a completely different thing from `kind: null`: `pending` means "decide later",
	 * `null` means "definitely non-foldable". Treating it as the latter breaks the group before
	 * the arguments arrive — exactly the "consecutive calls did not merge" the user saw.
	 */
	pending?: boolean;
	/** Reason when non-foldable (logging/debug only, not part of the verdict). */
	reason?: string;
}

/**
 * Strip heredoc bodies, keep command heads.
 *
 * Supports `<<EOF` / `<<'EOF'` / `<<"EOF"` / `<<-EOF` (the indented form: the terminator may have
 * leading tabs). The terminator line matches by **equality after trimming whitespace** (in `<<-`
 * semantics tabs get stripped; a blanket trim is more permissive here, whose only cost is that a
 * body line identical to the terminator ends the block early — such scripts are rare, and the
 * direction of the effect is only ever more conservative).
 */
export function stripHeredocBodies(command: string): string {
	const lines = command.split("\n");
	const out: string[] = [];
	let pending: string | null = null;
	for (const line of lines) {
		if (pending !== null) {
			if (line.trim() === pending) pending = null;
			continue;
		}
		const match = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
		out.push(line);
		if (match) pending = match[2]!;
	}
	return out.join("\n");
}

/**
 * Split by shell separators: `;` `\n` `&&` `||` `|` `&`.
 *
 * **Separators inside quotes do not split** (`grep -n 'a;b' f` is one segment); heredoc bodies are
 * already stripped. fd duplications like `>&2` / `2>&1` are flattened to a space first — otherwise
 * `&` would cut one segment into two.
 */
export function splitShellSegments(command: string): string[] {
	// Only flatten fd duplication (`2>&1` / `>&2`) — the `&` inside would be treated as a segment separator.
	// Do **not** strip redirection targets here: classification relies on it to decide "is there a write
	// out"; stripping would make `>/tmp/x` undetectable forever. The verb-tokenizing side handles that
	// separately via `stripRedirects`.
	const stripped = stripHeredocBodies(command).replace(/\d?>&\d?/g, " ");
	const out: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < stripped.length; i++) {
		const ch = stripped[i]!;
		if (quote) {
			current += ch;
			if (ch === quote && stripped[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") {
			if ((ch === "|" || ch === "&") && stripped[i + 1] === ch) i++;
			out.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	out.push(current);
	return out.map((s) => s.trim()).filter(Boolean);
}

/** Take a segment's first "real" verb, skipping `VAR=…` prefixes and `sudo/env/…` wrappers. */
export function segmentVerb(segment: string): { verb: string | null; args: string[] } {
	const tokens = segment.split(/\s+/).filter(Boolean);
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || /^[({!]$/.test(token)) {
			i++;
			continue;
		}
		const base = token.split("/").pop()!;
		if (WRAPPERS.has(base)) {
			i++;
			continue;
		}
		return { verb: base, args: tokens.slice(i + 1) };
	}
	return { verb: null, args: [] };
}

/** Write redirection (`>` / `>>`), excluding `/dev/null` and fd duplication. */
function hasWriteRedirect(segment: string): boolean {
	return /(^|[^>0-9])>>?\s*(?!\/dev\/null|&\d)\S/.test(segment.replace(/\d?>&\d?/g, " "));
}

/**
 * Strip redirections for **verb tokenizing** (classification keeps them; see the comment in
 * `splitShellSegments`).
 *
 * Without this, the positional arguments of `ls -la dir 2>/dev/null` would include `2>/dev/null`
 * and the phrase would become `List 2>/dev/null` — a real bug seen in practice.
 */
export function stripRedirects(segment: string): string {
	return segment
		// `2>/dev/null` / `>/tmp/x` / `>>log`: the `\d?` must capture the fd digit, otherwise the
		// `2` in `2>` becomes a positional argument (it once made `ls -la dir 2>/dev/null` read as
		// `List 2>/dev/null`).
		.replace(/\d?>>?\s*&?\d?\s*\S*/g, " ")
		// `< file` input redirection likewise
		.replace(/\d?<\s*\S+/g, " ")
		.trim();
}

/** `sed -i` / `perl -i` — in-place editing, not reading. */
function isInPlaceEdit(segment: string): boolean {
	return /\b(sed|perl)\b[^;|&]*?\s-[a-zA-Z]*i/.test(segment);
}

/**
 * Classify one segment; `null` means this segment is non-foldable (and so is the whole command).
 *
 * A command can span multiple categories (`grep … | head`); `classifyBash` merges them by priority.
 */
function classifySegment(segment: string): FoldKind | "native" | null {
	if (hasWriteRedirect(segment)) return null;
	if (isInPlaceEdit(segment)) return null;
	const { verb, args } = segmentVerb(segment);
	if (!verb || NOOP_VERBS.has(verb)) return "native"; // skip, no effect
	if (verb === "git") {
		const sub = args.find((t) => !t.startsWith("-")) ?? "";
		return GIT_READ_SUBCOMMANDS.has(sub) ? "git" : null;
	}
	if (verb === "sed" || verb === "awk" || verb === "gawk" || verb === "perl") return "read";
	if (verb === "grep" || verb === "egrep" || verb === "fgrep" || verb === "rg" || verb === "ag" || verb === "ack") {
		return "search";
	}
	if (verb === "ls" || verb === "find" || verb === "fd" || verb === "tree" || verb === "eza" || verb === "du" ||
		verb === "stat" || verb === "realpath" || verb === "readlink" || verb === "which" || verb === "type" ||
		verb === "mdfind" || verb === "locate" || verb === "dirname" || verb === "basename") {
		return "list";
	}
	if (READ_VERBS.has(verb)) return "read";
	return null;
}

/**
 * Decide whether a bash command is foldable, and give its category.
 *
 * The category comes from the **first effective segment** (same origin as the phrase line, which also
 * takes the first phrase) — so the verb on screen equals the category and the two can never contradict
 * each other. (**Family membership is a separate matter**: only the native `read` tool forms its own
 * family; bash-derived reads join the Search / List / Git families, see `registry.familyOf`.)
 *
 * Why not "the highest-priority category across all segments": a command often contains both `sed`
 * (read) and `grep` (search), e.g. `… ; sed -n '1,60p' CHANGELOG.md; echo …; grep -n version package.json`.
 * The old rule picked the highest by list > search > git > read, so it was classified as search while
 * the on-screen line said `Read CHANGELOG.md 1-60` — phrase verb and category mismatched (the third
 * example reported on 2026-10-06). With "first verb decides", both sides agree.
 */
export function classifyBash(command: string): FoldVerdict {
	const segments = splitShellSegments(command);
	let significant = 0;
	for (const segment of segments) {
		const kind = classifySegment(segment);
		if (kind === "native") continue; // navigation/output verbs, skip
		if (kind === null) return { kind: null, reason: segment.slice(0, 60) };
		significant++;
		// The first effective segment is the command's "main verb" — it is this line's verb / category
		if (significant === 1) return { kind };
	}
	return { kind: null, reason: "no significant verb" };
}

/**
 * Whether the arguments have not fully arrived — if they have, folding **can** be decided;
 * if not, do **not** decide.
 *
 * pi seeds a tool's arguments as `{}` at `content_block_start` (`event.content_block.input ?? {}`),
 * and only the subsequent `input_json_delta`s parse the real values in (see the stream accumulation
 * in `anthropic-messages`). So **at the very moment a tool block appears, its arguments are empty**.
 *
 * Classifying on empty arguments: `classifyBash("")` returns `null` for "no effective verb", the block
 * gets treated as "non-foldable" and **breaks the group** — when in fact it just has not been filled in
 * yet. The "clearly consecutive calls did not merge" report (2026-10-06) was exactly this: the previous
 * `read` had joined the group, and the next `bash` kicked it out because its arguments were still empty.
 *
 * The verdict follows "have this tool's required arguments arrived":
 *
 *   - `bash` — `command` must be a non-empty **string**; `undefined` / `""` both count as not arrived
 *   - `read` — `path` must be a non-empty string
 *   - `grep` / `find` — `pattern` must be a non-empty string
 *   - `ls` — **never pending**: `path` is optional in its schema (default = current directory);
 *     a missing argument is one of its normal values, not "not yet arrived"
 *
 * Note that `""` also counts as pending (rather than "definitely non-foldable"): real bash commands are
 * never empty strings, so an empty string can only mean still streaming. And if it truly stays empty
 * forever, the cost is only that this block skips grouping (renders normally) — far safer than breaking
 * the group wrongly.
 */
export function isPendingArgs(toolName: string, args: unknown): boolean {
	const obj = (args ?? {}) as Record<string, unknown>;
	const isFilled = (v: unknown): boolean => typeof v === "string" && v.length > 0;
	switch (toolName) {
		case "bash":
			return !isFilled(obj.command);
		case "read":
			return !isFilled(obj.path);
		case "grep":
		case "find":
			return !isFilled(obj.pattern);
		default:
			return false;
	}
}

/** Whether a tool call is a "read-only lookup"; if so, gives its category. */
export function classifyToolCall(toolName: string, args: unknown): FoldVerdict {
	// Arguments incomplete → **no verdict** — let the caller wait for the next frame;
	// never break a group on a guess
	if (isPendingArgs(toolName, args)) return { kind: null, pending: true, reason: "args pending" };
	// Reading a SKILL.md does not fold: pi has a dedicated `[skill] <directory>` compact shape for it
	// (user's decision, 2026-10-06); rationale and measured scale in `isSkillRead`. It sits **before**
	// the `read` branch and is **not** pending — it is a definitive "non-foldable" that breaks the group
	// as usual (lookups around a skill read should not merge into one group).
	if (isSkillRead(toolName, args)) return { kind: null, reason: "skill read" };
	if (toolName === "read") return { kind: "read" };
	if (toolName === "grep") return { kind: "search" };
	if (toolName === "find" || toolName === "ls") return { kind: "list" };
	if (toolName === "bash") {
		const command = typeof (args as { command?: unknown } | null | undefined)?.command === "string"
			? (args as { command: string }).command
			: "";
		return classifyBash(command);
	}
	return { kind: null, reason: `tool ${toolName}` };
}
