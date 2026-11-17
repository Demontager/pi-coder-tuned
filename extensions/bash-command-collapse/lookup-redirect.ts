/**
 * lookup-redirect — the **hard decision** for "this bash command should have used a native tool".
 *
 * ## Why it exists
 *
 * Prompts (`promptSnippet` / `AGENTS.md`) are **suggestions**: the model may read them and still not comply.
 * The user's requirement — "use native find/ls/grep when that's what the command is doing" — is a
 * deterministic requirement that can only be enforced in the loop layer: this module makes the call, and the
 * `tool_call` handler in `bash-command-collapse.ts` blocks the invocation accordingly, handing the correct
 * call form back to the model (policy set by the user on 2026-10-06).
 *
 * ## Orientation: better to miss a block than to block wrong
 *
 * Only a command that is **purely a single lookup end to end** is blocked — every effective stage's verb must
 * be a "fetch content" kind (`grep` / `find` / `ls` / `cat` / `head` / `sed -n`). The moment any of these
 * appears:
 *
 *   - transformers (`awk` / `jq` / `sort` / `wc` / `cut` / `tr` / `uniq` …) — native tools cannot do that
 *   - execution (`node` / `python3` / `npm` / `git` / `make` …) — that is genuinely running something
 *   - write redirections, `sed -i`, heredoc bodies
 *
 * it is **not** blocked. Those are legitimately bash work; blocking would only force the model to spend an
 * extra round, which costs more than the tokens saved.
 *
 * Likewise, `find` with `-maxdepth` / `-mtime` / `-size` / `-exec`, `grep` with `-v` / `-c` / `-A`,
 * `sed` without `-n`, multi-path `grep pat f1 f2` — none are blocked: the native tool schemas cannot express
 * them, and after blocking, the model could only reach for a different bash command anyway — a net loss of
 * a round.
 *
 * ## `.gitignore` is a difference that must be disclosed
 *
 * Native `grep` / `find` respect `.gitignore` (skipping `node_modules/`, `dist/`); bash's `grep -r` does not —
 * verified: in the same repo `rg` found only `visible.txt`, while `grep -rn` additionally found
 * `ignored/hidden.txt`. So the block message **must** spell this out and give the workaround (passing the
 * ignored directory explicitly as `path` pierces it — verified); otherwise "use native" becomes a silent miss.
 */

import { segmentVerb, splitShellSegments } from "../explored-group/classify.ts";

export type NativeLookupTool = "grep" | "find" | "ls" | "read";

export interface LookupRedirect {
	/** The native tool to suggest (the highest-priority family when several are mixed). */
	tool: NativeLookupTool;
	/** Invocation hint extracted from the command (best-effort; undefined when nothing could be extracted). */
	hint?: { pattern?: string; path?: string; args?: Record<string, unknown> };
	/** All native-tool families appearing in the command, used for wording. */
	tools: NativeLookupTool[];
}

/** The `grep` family: searching text. */
const GREP_VERBS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
/** The `find` family: finding files by name. */
const FIND_VERBS = new Set(["find", "fd"]);
/** The `ls` family: listing directories. */
const LS_VERBS = new Set(["ls", "tree", "eza"]);
/** The `read` family: fetching file contents (`sed` requires an extra `-n` check). */
const READ_VERBS = new Set(["cat", "bat", "head", "sed", "nl"]);

/** Pure navigation/output verbs: they carry no lookup intent, skip them. */
const SKIP_VERBS = new Set(["cd", "pushd", "popd", "pwd", "echo", "printf", "true", "false", ":", "export", "set"]);

/**
 * Truncation idiom at the end of a pipeline (`… | head -30` / `… | tail -5`) — native tools have `limit`,
 * so this truncation equals their built-in behavior and must not let the whole command slip through.
 *
 * The check is strict: only **pure count** forms (`-30` / `-n 30`) are accepted, with **no file name at the
 * end** — `head -20 README.md` genuinely reads a file (that is `read`), not pipeline truncation.
 */
function isTruncationStage(verb: string, args: string[], isLast: boolean): boolean {
	if (!isLast) return false;
	if (verb !== "head" && verb !== "tail") return false;
	const positionals = args.filter((t) => !t.startsWith("-"));
	if (positionals.length > 0) return false; // a file name means reading a file
	// `-30` / `-n 30` / `--lines=30` / bare `-n` / head with no args
	if (args.length === 0) return true;
	return args.every((t) => /^-\d+$/.test(t) || t === "-n" || /^--lines(=|$)/.test(t));
}

/** Letters allowed inside combined short flags (`-rn` / `-i` …). `v` / `c` / `l` / `A` / `B` / `C` are **not** included. */
const GREP_OK_SHORT_FLAGS = /^-[nriIsShHEFGwxR]+$/;

/**
 * Traces of shell expansion: globbing and command substitution.
 *
 * **Native tools do no expansion** — `ls({ path: "*.md" })` returns `Path not found: …/*.md` (verified).
 * So blocking a call that carries expansion is a **wrong block**: the model copies the suggestion verbatim,
 * fails, and has to discover "use bash so the shell expands" on its own — a net loss of a round. Usage that
 * depends on expansion belongs in bash anyway.
 *
 * Only `*` `?` `` ` `` `$(` are recognized; `[` `{` are **not**: in `grep -n '[a-z]\+' f` the brackets are a
 * regex, not a glob — treating them as expansion would miss a pile of lookups that should be blocked.
 */
const SHELL_EXPANSION = /[*?`]|\$\(/;

/**
 * Unexpanded shell variables (`$D` / `${D}` / `$f`).
 *
 * Same logic as globbing: native tools do no parameter expansion — `read({path: "$D/settings.md"})` would
 * look for a directory literally named `$D`. When we cannot tell what a variable is bound to (the assignment
 * could sit anywhere on the same line) we **do not block** — measured: 562 suggestions (13.8%) in the full
 * corpus carried unexpanded variables, the third big category of "copying the suggestion would fail".
 */
const SHELL_VARIABLE = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;

/** Whether any argument token needs shell expansion first. */
function hasShellExpansion(tokens: string[]): boolean {
	return tokens.some((t) => SHELL_EXPANSION.test(t) || SHELL_VARIABLE.test(t));
}

/** Strip one layer of quotes. */
function unquote(value: string): string {
	return value.replace(/^(['"])(.*)\1$/s, "$2");
}

/**
 * Take a segment's first positional argument, **without splitting inside quotes**.
 *
 * `segmentVerb` splits on whitespace, so `cd "/a b/proj"` lands on `"/a` — quoted paths with spaces get
 * shredded. Using such a shred to compose the `cd` target / as `path` hands the model a suggestion **that
 * cannot run at all** (observed: `cd "/Users/…/Application Support/logs" && ls` once produced
 * `path: "\"/Users/bachi/Library/Application"`).
 *
 * Returns the full argument with quotes stripped; undefined when there is no positional.
 */
function firstPositionalQuoted(segment: string): string | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i]!;
		if (quote) {
			if (ch === quote) { quote = null; continue; }
			current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') { quote = ch; continue; }
		if (/\s/.test(ch)) {
			if (current) { tokens.push(current); current = ""; }
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	// Skip the verb and flags, take the first positional.
	const rest = tokens.slice(1).filter((t) => !t.startsWith("-"));
	return rest[0];
}

/**
 * Join a `cd` target with a relative path (the real target of `cd /p && cat f` is `/p/f`).
 *
 * **This is the core of "the suggestion actually runs"**: `hint.path` is fed to the native tool, which
 * resolves it under the **current cwd** — not the directory after the command's `cd`. Without the join the
 * model reads **a different file** (or gets `Path not found`); and measured 74% of blocks carry a `cd`
 * prefix + relative path, so the cost is huge.
 *
 * Absolute paths / `~` / `.` / glob-bearing targets are returned as-is: the first is already complete, the
 * middle two are relative to the current directory anyway, and globs should never reach here (commands with
 * expansion were already passed through at `stageFamily`).
 */
function joinWithCd(p: string | undefined, cdTarget: string | undefined, cdUnresolved: boolean): string | undefined {
	if (typeof p !== "string" || p === "") return p;
	if (p.startsWith("/") || p.startsWith("~")) return p;
	// Globs / command substitution / unexpanded variables / leftover quotes are not ours to join: commands
	// carrying the former two already passed at the decision layer; the latter two are shreds left after escaped
	// quotes shredded tokenization (e.g. `grep -nE "^import|from \\\""` takes the pattern tail as path) — the join would only produce an unrunnable suggestion.
	if (/[*?`]|\$\(/.test(p) || SHELL_VARIABLE.test(p)) return p;
	// Leftover quotes = **shreds** left when escaped quotes shredded tokenization (`grep -nE "^import|from \\\""`
	// takes the pattern tail as path). Joining is meaningless and handing it over as a suggestion is wrong — give no path.
	if (/["']/.test(p)) return undefined;
	if (p === ".") return p;
	// `cd` target known: join into an absolute path (the real target of `cd /p && cat f` is `/p/f`).
	if (cdTarget !== undefined) {
		if (/[*?`]|\$\(/.test(cdTarget) || SHELL_VARIABLE.test(cdTarget)) return undefined;
		return `${cdTarget.replace(/\/+$/, "")}/${p}`;
	}
	// When the `cd` target can only be known through shell expansion (`cd "$DIR" && cat f`): a relative path
	// under the current cwd points to **a different file** — a silently wrong target is worse than an error; better give no path and let the model map it.
	if (cdUnresolved) return undefined;
	return p;
}

interface Stage {
	verb: string;
	args: string[];
}

/** Split a segment into "stages in the pipeline" — split on `|`, not inside quotes. */
function splitPipeline(segment: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i]!;
		if (quote) {
			current += ch;
			if (ch === quote && segment[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "|") {
			out.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	out.push(current);
	return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Decide which family a stage of a command belongs to; `"skip"` = navigation/meaningless, `null` = **not
 * blockable** (its presence lets the whole command through).
 */function stageFamily(stage: string): NativeLookupTool | "skip" | null {
	const { verb, args } = segmentVerb(stage);
	if (!verb) return "skip";
	if (SKIP_VERBS.has(verb)) return "skip";

	if (GREP_VERBS.has(verb)) {
		// All flags must map onto the native schema (`-n` ignored, `-r` ignored, `-i` → ignoreCase, `--include` → glob).
		for (const token of args) {
			if (!token.startsWith("-")) continue;
			if (GREP_OK_SHORT_FLAGS.test(token)) continue;
			if (/^--include(=|$)/.test(token)) continue;
			return null; // `-v` / `-c` / `-A` / `--exclude` … native cannot express these
		}
		// At most two positionals (pattern + a single path); multiple paths are not blocked.
		const positionals = args.filter((t) => !t.startsWith("-"));
		if (positionals.length > 2) return null;
		// No path and non-recursive = content comes from **stdin** (`env | grep`, `cmd | grep`, `cat f | grep pat`).
		// Native grep only searches files and cannot offer a "call this instead" suggestion → do not block.
		// `grep -rn pat` (recursive, no path) is the exception: GNU grep searches the current directory — expressible natively.
		//
		// Note: `cat a.txt | grep pat` could in theory derive `path: a.txt`, but `splitShellSegments`
		// **treats `|` and `;` as the same separator** (both split into independent segments), so it cannot distinguish
		// `cat a.txt | grep pat` (grep reads the pipe) from `cat a.txt; grep pat` (grep reads stdin) —
		// when unsure, do not block (measured: these add up to only 0.4% of blockable volume, not worth the risk).
		const recursive = args.some((t) => /^-[^-]*[rR]/.test(t));
		if (positionals.length < 2 && !recursive) return null;
		// A path carrying glob/command substitution needs shell expansion first — copying it natively would fail.
		if (hasShellExpansion(positionals.slice(1).map(unquote))) return null;
		return "grep";
	}

	if (FIND_VERBS.has(verb)) {
		// Only `-name` / `-iname` / `-type` are recognized; any other predicate (`-maxdepth` / `-mtime` / `-exec`…) passes.
		let i = 0;
		while (i < args.length) {
			const token = args[i]!;
			if (token === "-name" || token === "-iname" || token === "-type") {
				if (args[i + 1] === undefined) return null;
				i += 2;
				continue;
			}
			if (token.startsWith("-")) return null;
			i += 1;
		}
		// Search roots produced by shell expansion (`find * -name x`) → copying natively would fail.
		const dirs = args.filter((t) => !t.startsWith("-")).map(unquote);
		if (hasShellExpansion(dirs.slice(0, 1))) return null;
		return "find";
	}

	if (LS_VERBS.has(verb)) {
		// `-R` recursion is beyond native; other flags pass (native gives names only — the block message says so).
		if (args.some((t) => /^-[^-]*R/.test(t))) return null;
		// Metadata flags (`-l` / `-t` / `-S` / `-h`) are **still blocked** — a deliberate policy, not an oversight:
		// most `ls -la` on screen just wants to see what is in the directory and native `ls` names suffice; when
		// size/time is truly needed the block message points to bash `stat` / `du` (those two are not blocked). The
		// cost: the rare `ls -la` genuinely launched for metadata burns one extra round — measured tiny (of 3 real
		// blocks in the corpus, 2 used `ls` again next round, i.e. the model did get sent to another bash instead of
		// native — kept). (To let it pass later, change the check to `/^-[^-]*[lthS]/` and sync `explored-group`'s collapse policy and these unit tests.)
		const positionals = args.filter((t) => !t.startsWith("-")).map(unquote);
		// Globs (`ls *.md` / `ls -d */`) need shell expansion — copying natively would fail.
		if (hasShellExpansion(positionals)) return null;
		// Listing several paths at once — native `ls` takes a single path; copying would silently drop the rest (same rule as `cat a b`).
		if (positionals.length > 1) return null;
		return "ls";
	}

	if (READ_VERBS.has(verb)) {
		if (verb === "sed") {
			// Only the "print range" form `sed -n '1,60p' file` is equivalent to read(offset/limit).
			if (!args.includes("-n")) return null;
			const script = args.find((t) => !t.startsWith("-"));
			if (!script || !/^\d+(,\d+)?p$/.test(unquote(script))) return null;
		}
		const positionals = args.filter((t) => !t.startsWith("-")).map(unquote);
		// `cat a b c` — native read reads one file per call → do not block (avoid forcing extra rounds).
		let files = verb === "sed" ? positionals.slice(1) : positionals;
		// In `head -n 20 f`, `20` is the **value** of `-n`, not a file name — failing to drop it counts it as "two files"
		// and passes the whole command (observed: `head -n 20 f` slipped through while the synonymous `head -20 f` blocked).
		if (verb === "head" || verb === "tail") {
			const nIdx = args.indexOf("-n");
			const count = nIdx >= 0 ? args[nIdx + 1] : undefined;
			if (count !== undefined && /^\d+$/.test(count)) files = files.filter((f) => f !== count);
		}
		if (files.length !== 1) return null;
		// `cat *.log` needs shell expansion — copying natively would fail.
		if (hasShellExpansion(files)) return null;
		return "read";
	}

	return null;
}

/** Extract the "call it like this" hint. Returns undefined when nothing can be extracted — wording falls back to generic. */
function buildHint(tool: NativeLookupTool, stages: Stage[], cdTarget: string | undefined, cdUnresolved: boolean): LookupRedirect["hint"] {
	const positionals = (args: string[]) => args.filter((t) => !t.startsWith("-")).map(unquote);
	const join = (p: string | undefined) => joinWithCd(p, cdTarget, cdUnresolved);
	for (const stage of stages) {
		if (tool === "grep" && GREP_VERBS.has(stage.verb)) {
			const pos = positionals(stage.args);
			const hint: Record<string, unknown> = { pattern: pos[0] };
			// No path given: prefer the `cd` target, then `.`; when the `cd` target is unresolvable, do not guess (see `joinWithCd`).
			const path = join(pos[1] ?? (cdUnresolved && cdTarget === undefined ? undefined : cdTarget ?? "."));
			hint.path = path;
			// `^-[^-]*i`: only `i` inside **short flags** counts. The old `/^-.*i/` would take the `i` in `--include=*.ts`
			// for `-i` (observed: `grep -rn foo --include=*.ts .` produced ignoreCase:true), and the model copying it
			// gets a silently widened search — this kind of "copy the suggestion and it is wrong" costs more than not blocking.
			if (stage.args.some((t) => /^-[^-]*i/.test(t))) hint.ignoreCase = true;
			const include = stage.args.find((t) => t.startsWith("--include="));
			if (include) hint.glob = unquote(include.slice("--include=".length));
			return { pattern: pos[0], path, args: { pattern: pos[0], ...hint } };
		}
		if (tool === "find" && FIND_VERBS.has(stage.verb)) {
			const nameIdx = stage.args.findIndex((t) => t === "-name" || t === "-iname");
			const pattern = nameIdx >= 0 ? unquote(stage.args[nameIdx + 1] ?? "") : "";
			const path = join(positionals(stage.args)[0] ?? (cdUnresolved && cdTarget === undefined ? undefined : cdTarget ?? "."));
			return { pattern, path, args: { pattern, path } };
		}
		if (tool === "ls" && LS_VERBS.has(stage.verb)) {
			const explicit = positionals(stage.args)[0];
			const path = explicit !== undefined
				? join(explicit)
				: cdUnresolved && cdTarget === undefined ? undefined : cdTarget ?? ".";
			return { path, args: { path } };
		}
		if (tool === "read" && READ_VERBS.has(stage.verb)) {
			const pos = positionals(stage.args);
			// In `head -n 20 f`, `20` is `-n`'s value, not a file name — careless handling writes `path: "20"` into the hint.
			const names = stage.verb === "head" || stage.verb === "tail"
				? pos.filter((p) => !/^\d+$/.test(p) || !stage.args.includes("-n"))
				: pos;
			const file = stage.verb === "sed" ? names[1] : names[0];
			const resolved = join(file);
			const args: Record<string, unknown> = { path: resolved };
			if (stage.verb === "head") {
				// Both `head -20 f` and `head -n 20 f` must be recognized (the latter originally missed the limit — a bare read).
				const afterN = stage.args.includes("-n") ? stage.args[stage.args.indexOf("-n") + 1] : undefined;
				const n = afterN !== undefined && /^\d+$/.test(afterN)
					? afterN
					: stage.args.find((t) => /^-\d+$/.test(t));
				if (n) args.limit = Number(String(n).replace(/^-/, ""));
			}
			if (stage.verb === "sed") {
				// `sed -n '92,121p' f` → read({path, offset: 92, limit: 121 - 92 + 1})
				// single-line form `sed -n '42p' f` → offset 42, limit 1
				const range = unquote(pos[0] ?? "").match(/^(\d+)(?:,(\d+))?p$/);
				if (range) {
					const start = Number(range[1]);
					const end = range[2] === undefined ? start : Number(range[2]);
					if (end >= start) {
						args.offset = start;
						args.limit = end - start + 1;
					}
				}
			}
			return { path: resolved, args };
		}
	}
	return undefined;
}

/**
 * Decide whether this bash command is "a single lookup that should have used a native tool".
 *
 * Non-null return = block it and hand the suggested native call to the model; null = pass to bash.
 */
export function detectBashLookup(command: string): LookupRedirect | null {
	const trimmed = command.trim();
	if (trimmed === "") return null;

	const segments = splitShellSegments(trimmed);
	if (segments.length === 0) return null;

	// First pass through the read-only allowlist: write redirections / `sed -i` / unknown verbs (node, python, git, npm…)
	// are rejected here; the semantics share the same shell parsing as explored-group's collapse decision.
	const stages: Stage[] = [];
	const families: NativeLookupTool[] = [];

	let cdTarget: string | undefined;
	// When the `cd` target needs shell expansion (`cd "$DIR"` / `cd /x/*/pkg`), relative paths cannot be used as path.
	let cdUnresolved = false;

	for (const segment of segments) {
		const pipeline = splitPipeline(segment);
		for (let si = 0; si < pipeline.length; si++) {
			const stage = pipeline[si]!;
			const { verb, args } = segmentVerb(stage);
			// A trailing `| head -N` is just the truncation idiom — native tools have `limit`, so skip rather than pass.
			if (isTruncationStage(verb, args, si === pipeline.length - 1)) continue;
			const family = stageFamily(stage);
			if (family === null) return null;
			if (family === "skip") {
				// Record the target of `cd X &&` along the way: when a later grep gives no path, that is the effective scope.
				// Use quote-aware tokenization — `segmentVerb` splits on whitespace and would shred `"/a b"` into `"/a`.
				if (verb === "cd") {
					const target = firstPositionalQuoted(stage);
					// When the `cd` target needs shell expansion (`cd "$DIR"`, `cd /x/*/pkg`), **clear** it:
					// otherwise a later relative path would be taken verbatim as `path` (e.g. `path: "f.ts"`),
					// which under the current cwd points to **a different file** — a silently wrong target is worse than an error.
					// After clearing, `buildHint` falls back to the empty-`cdTarget` path (usually `undefined` →
					// rendered as "map it to the schema yourself"), and the model knows where to look.
					cdTarget = target && target !== "-" && !SHELL_VARIABLE.test(target) && !SHELL_EXPANSION.test(target)
						? target
						: undefined;
					cdUnresolved = cdTarget === undefined;
				}
				continue;
			}
			stages.push({ verb, args });
			if (!families.includes(family)) families.push(family);
		}
	}

	if (families.length === 0 || stages.length === 0) return null;

	// Priority: grep > find > ls > read. The intent of `cat f | grep pat` is grep (path=f);
	// taking the leftmost would misclassify it as read.
	const priority: NativeLookupTool[] = ["grep", "find", "ls", "read"];
	const tool = priority.find((t) => families.includes(t)) ?? families[0]!;
	const hint = buildHint(tool, stages, cdTarget, cdUnresolved);
	return { tool, hint, tools: families };
}

/** The "copy this line" text of a native-call suggestion. */
function callSnippet(redirect: LookupRedirect): string {
	const args = redirect.hint?.args;
	if (!args || Object.values(args).some((v) => v === undefined)) return `\`${redirect.tool}\` tool`;
	const body = Object.entries(args)
		.map(([k, v]) => `${k}: ${typeof v === "number" ? v : JSON.stringify(v)}`)
		.join(", ");
	return `\`${redirect.tool}({ ${body} })\``;
}

/**
 * Block message: the body shown to the model.
 *
 * Three parts: **what to call** / **why** / **the `.gitignore` exception**. It must be short (every block costs
 * tokens), but the `.gitignore` exception cannot be dropped — dropping it means silent misses.
 */
export function renderLookupRedirect(redirect: LookupRedirect): string {
	const lines = [
		`[lookup gate] This bash command is a pure ${redirect.tool} lookup — it was intercepted; use pi's native tools instead.`,
		``,
		`Call instead: ${callSnippet(redirect)}`,
	];
	if (!redirect.hint?.args) {
		lines.push(`(map the arguments yourself to the \`${redirect.tool}\` tool's schema)`);
	}
	lines.push(
		``,
		`Why: native tools are faster, truncate their own output (no transcript flooding), and save tokens.`,
	);
	if (redirect.tool === "grep" || redirect.tool === "find") {
		lines.push(
			`Note: the native \`${redirect.tool}\` respects \`.gitignore\` (it skips \`node_modules/\`, \`dist/\`, etc.); ` +
				`to search an ignored tree, pass that directory **explicitly** as \`path\` (explicit paths are not filtered).`,
		);
	}
	if (redirect.tool === "ls") {
		lines.push(`Note: the native \`ls\` returns entry names only; for size/mtime metadata use bash \`stat\` / \`du\` (never intercepted).`);
	}
	lines.push(
		``,
		`(This gate can be disabled with \`PI_BASH_LOOKUP_GATE=off\`; compound lookups, transformers, writes, and test commands are never intercepted.)`,
	);
	return lines.join("\n");
}
