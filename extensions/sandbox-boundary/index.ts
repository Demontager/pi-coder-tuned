/**
 * Sandbox Boundary — covers the one thing the bash sandbox cannot reach for the
 * **non-shell file tools**: deletion.
 *
 * ## Why it exists
 *
 * Bash commands are already wrapped by the seatbelt sandbox (see
 * `bash-command-collapse/sandbox.ts`), but pi's `write` / `edit` tools **do not go through a
 * shell** — they are direct `fs` calls inside the extension process, invisible to the
 * sandbox. The capability the sandbox withholds is exactly one (out-of-boundary
 * `file-write-unlink`), so only the same one needs covering here: **deleting** files outside
 * the boundary asks; writing does not.
 *
 * ## The rule (decided by the user 2026-09-24)
 *
 * > A write target outside the writable boundary does not prompt; only deleting a file
 * > outside the sandbox prompts.
 *
 * Therefore:
 *
 * - `write` / `edit` / `multiedit` — always pass, boundary unchecked. They only create or
 *   overwrite content; no inode disappears. The overwritten old content belongs to
 *   "reversibility", owned by git and the AGENTS.md `## Destructive actions` discipline —
 *   not this gate's job.
 * - `apply_patch` — only the paths on `*** Delete File: <path>` lines are checked.
 *   `Update File` / `Add File` are writes and pass.
 *
 * ## The three authorization tiers (same set as the bash sandbox; decided by the user
 * 2026-09-24, the "never delete" tier added that day)
 *
 * Out-of-boundary deletions are judged in three tiers by target path. The judgment core is
 * `sandbox.ts`'s `classifyOutsidePaths`, and memory lands on the same globalThis singleton
 * in `allowlist.ts` — so a directory remembered on the bash side takes effect here
 * instantly and vice versa; the two sides cannot drift:
 *
 * - **never delete** (identity / credentials / handwritten config: `~/.zshrc`, `~/.ssh`,
 *   `~/.gnupg`…): **no dialog, no allow option** — fail-closed outright. Allowlists, session
 *   exemptions, and `PI_SANDBOX_EXTRA_WRITE` cannot override. The whole patch is rejected
 *   together.
 *   On 2026-09-25 the user moved `~/.config`, `~/.pi`, `~/.claude`, `~/.codex` out of this
 *   tier — they are tool-state dirs (locks / caches / session logs) and follow the ordinary
 *   tier below.
 * - **dangerous paths** (system roots / bin / app install dirs / `~/Library` / anything
 *   containing `.git`): asked every time; only session-level exemption
 *   (`Allow for this session`), reset on restart.
 * - **ordinary paths**: asked once; `Allow for this session (and remember the directory)`
 *   writes the directory scope into the persistent allowlist — never asked again (incl.
 *   headless).
 *
 * One difference from the bash side: `apply_patch` is a `tool_call` hook — it can block
 * **before** execution and already knows every target path (bash must fail first and scrape
 * stderr). So there is no "re-run the command" cost here and `Allow once` simply passes this
 * once, remembered nowhere.
 *
 * ## The experience
 *
 * Writes **never prompt**, and neither do deletions inside the boundary (incl. regenerable
 * caches like `~/.cache`, `~/Library/Caches`) — that is the vast majority of operations.
 * Only out-of-boundary deletes ask.
 * Hits on the persistent allowlist pass silently but get a `notify` line (otherwise the user
 * wonders "why did it stop asking").
 * Non-interactive environments (`pi -p`, subagents): the persistent allowlist **applies**
 * (the authorization was given interactively); dangerous dirs and unauthorized ordinary dirs
 * fail-closed — with nobody at the screen, "default yes" is no boundary at all.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	boundaryFromEnv,
	classifyOutsidePaths,
	isSandboxEnabled,
	memoryScopeFor,
	memoryScopesFor,
	neverDeleteReasonFor,
	sessionScopeFor,
	writableRoots,
	type PathEnv,
	type WriteBoundary,
} from "../bash-command-collapse/sandbox.ts";
import { getAllowlistStore, getSessionScopes } from "../bash-command-collapse/allowlist.ts";

/**
 * Tools that can carry deletion intent.
 *
 * `write` / `edit` / `multiedit` are deliberately **not** in this set — they write, never
 * delete (see the file-header rule). `apply_patch`'s `*** Delete File:` is the only
 * "a non-shell tool can delete files" shape.
 */
const GUARDED_TOOLS = new Set(["apply_patch"]);

/**
 * Take the paths **to be deleted** from the tool input.
 *
 * `apply_patch`'s shape is the `patch` text; paths sit on `*** Delete File: <path>` lines.
 * `Update File` / `Add File` are writes and pass per the rule, so they are not extracted.
 * Unrecognized input falls through to "no targets → pass": the bash sandbox and the
 * AGENTS.md discipline still apply — a guessed-wrong shape must not block a normal write.
 */
function deleteTargetPaths(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const obj = input as Record<string, unknown>;
	const out: string[] = [];

	if (typeof obj.patch === "string" && obj.patch) {
		for (const line of obj.patch.split("\n")) {
			const m = /^\*\*\* Delete File: (.+)$/.exec(line.trim());
			if (m?.[1]) out.push(m[1].trim());
		}
	}

	// a few implementations put delete targets in dedicated fields — recognize those too.
	for (const key of ["deletePaths", "deletedPaths"]) {
		const value = obj[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string" && item) out.push(item);
			}
		}
	}

	return out;
}

export default function (pi: ExtensionAPI) {
	// shares the bash sandbox's switch: PI_SANDBOX=off disables both together — no
	// "bash bounded, apply_patch unbounded" half-open state.
	const enabled = isSandboxEnabled();
	const allowlistPath = process.env.PI_SANDBOX_ALLOWLIST?.trim() || join(getAgentDir(), "sandbox-allowlist.json");
	const sessionScopes = getSessionScopes();
	// the IO the path classification needs (realpath / isDirectory) is injected here; sandbox.ts stays pure logic.
	const pathEnv: PathEnv = {
		home: homedir(),
		realpath: (p) => {
			try {
				return realpathSync(p);
			} catch {
				return undefined;
			}
		},
		isDirectory: (p) => {
			try {
				return statSync(p).isDirectory();
			} catch {
				return false;
			}
		},
	};
	const allowlist = () => getAllowlistStore(allowlistPath, pathEnv);
	let stats = { checked: 0, remembered: 0, confirmed: 0, blocked: 0 };

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;

		const paths = deleteTargetPaths(event.input);
		// unrecognizable delete targets → pass: this is not "slipping through" — the tool shape simply has no deletable target to judge.
		// the real backstop is the bash sandbox (a deletion must land on some path in the end).
		if (paths.length === 0) return undefined;

		const boundary: WriteBoundary = boundaryFromEnv(ctx.cwd ?? process.cwd());
		stats.checked += paths.length;
		const classification = classifyOutsidePaths(paths, {
			boundary,
			allowedRoots: allowlist().roots(),
			sessionRoots: sessionScopes.roots(),
			env: pathEnv,
		});

		const pending = [...classification.dangerous.map((d) => d.path), ...classification.ordinary];

		// the never-delete tier: no dialog, no allow option — fail-closed outright.
		// the whole patch is rejected together (same rule as "allow only when everything is covered") — otherwise
		// a `*** Delete File: ~/.ssh/id_rsa` mixed into a patch would ride through on the legit ops.
		if (classification.blocked.length > 0) {
			stats.blocked += classification.blocked.length;
			return {
				block: true,
				reason:
					`These identity, credential, or manually maintained configuration paths cannot be deleted regardless of authorization:
` +
					classification.blocked.map((d) => `  ${d.path} (${d.reason})`).join("\n") +
					`
If deletion is necessary, perform it yourself in a terminal (or disable this layer with PI_SANDBOX=off).`,
			};
		}

		if (pending.length === 0) {
			// everything landed inside the boundary / persistent allowlist / session exemptions. On an allowlist hit,
			// add one notify line or the user wonders "why did it stop asking". (In-boundary deletes do not notify — that is most operations.)
			if (classification.covered.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`Deletion targets already allowlisted; allowed: ${classification.covered.join(", ")}`, "info");
			}
			return undefined;
		}

		const roots = writableRoots(boundary).join(", ");

		// non-interactive: the persistent allowlist already applied during classify above (hits landed in covered) —
		// reaching here means no coverage → fail-closed.
		if (!ctx.hasUI) {
			stats.blocked += pending.length;
			return {
				block: true,
				reason:
					`Deletion targets are outside the boundary and unauthorized; denied in non-interactive mode.
` +
					`Target: ${pending.join(", ")}
Deletion boundary: ${roots}\n` +
					`Persistent allowlist: ${allowlist().roots().length} entries (pre-authorize with /sandbox-boundary allow <directory> in an interactive session)`,
			};
		}

		const foldPaths = (list: readonly string[], limit = 3): string => {
			const shown = list.slice(0, limit).map((p) => `  ${p}`);
			if (list.length > limit) shown.push(`  … plus ${list.length - limit} matches`);
			return shown.join("\n");
		};
		const hasDangerous = classification.dangerous.length > 0;
		const ordinaryScopes = memoryScopesFor(classification.ordinary, pathEnv, boundary.cwd);
		const dangerousScopes = classification.dangerous.map((d) => sessionScopeFor(d.path, pathEnv, boundary.cwd));

		let choice: string | undefined;
		if (hasDangerous) {
			const lines = [
				"⚠️ Deletion targets outside the boundary (high-risk directories)",
				"",
				"High-risk paths (confirmation on each deletion; session-only exemptions):",
				foldPaths(classification.dangerous.map((d) => `${d.path} (${d.reason})`)),
			];
			if (classification.ordinary.length > 0) {
				lines.push("", "Also includes ordinary out-of-boundary paths (approve this time only; not remembered):", foldPaths(classification.ordinary));
			}
			lines.push("", `Deletion boundary: ${roots}`, "", "Choose Deny to leave everything untouched.");
			// pi's select only takes (title, options): the body must be spliced into the title (same approach as destructive-guard).
			choice = await ctx.ui.select(lines.join("\n"), ["Deny", "Allow once", "Allow for this session"]);
		} else {
			const lines = [
				"⚠️ Deletion targets outside the boundary",
				"",
				"Delete targets: ",
				foldPaths(classification.ordinary),
				"",
				ordinaryScopes.length > 0
					? `Remember these paths: ${ordinaryScopes.join(", ")} (future deletions within these directories will not prompt)`
					: "No safe persistent scope can be determined for these paths; approve each request individually.",
				"",
				`Deletion boundary: ${roots}`,
				"",
				"Choose Deny to leave everything untouched.",
			];
			choice = await ctx.ui.select(lines.join("\n"), [
				"Deny",
				"Allow for this session (and remember the directory)",
				"Allow once",
			]);
		}

		if (choice === undefined || choice === "Deny") {
			stats.blocked += pending.length;
			return {
				block: true,
				reason: `The user denied deletion outside the boundary: ${pending.join(", ")} (deletion boundary: ${roots})`,
			};
		}

		if (choice === "Allow for this session (and remember the directory)") {
			const remembered = allowlist().remember(ordinaryScopes, "confirm", pathEnv);
			stats.remembered += remembered.length;
			if (remembered.length > 0)
				ctx.ui.notify(
					`Permanently remembered ${remembered.length} directories (persists across restarts); future deletions within them will not prompt`,
					"info",
				);
		} else if (choice === "Allow for this session") {
			// the dangerous branch's session-level exemption: nothing written to disk, dies on restart.
			sessionScopes.add(dangerousScopes);
		}
		// `Allow once`: remember nothing; just let this one through.

		stats.confirmed += pending.length;
		return undefined;
	});

	pi.registerCommand("sandbox-boundary", {
		description: "Show deletion boundary and allowlist; forget <path> removes an entry, clear empties it, allow <path> pre-authorizes",
		handler: (args, ctx) => {
			if (!enabled) {
				ctx.ui.notify("Boundary checks are disabled (PI_SANDBOX=off or non-macOS platform).", "info");
				return;
			}
			const boundary = boundaryFromEnv(ctx.cwd ?? process.cwd());
			const [sub, ...rest] = args.trim().split(/\s+/);
			const store = allowlist();

			if (sub === "forget") {
				const target = rest.join(" ");
				if (!target) {
					ctx.ui.notify("Usage: /sandbox-boundary forget <path>", "warning");
					return;
				}
				const removed = store.forget(target);
				ctx.ui.notify(removed ? `Removed allowlist entry: ${target}` : `No such allowlist entry: ${target}`, removed ? "info" : "warning");
				return;
			}
			if (sub === "clear") {
				const n = store.clear();
				ctx.ui.notify(n > 0 ? `Cleared allowlist (${n} entries)` : "The allowlist was already empty", "info");
				return;
			}
			if (sub === "allow") {
				const target = rest.join(" ");
				if (!target) {
					ctx.ui.notify("Usage: /sandbox-boundary allow <path>", "warning");
					return;
				}
				const scope = memoryScopeFor(target, pathEnv, boundary.cwd);
				if (!scope) {
					const never = neverDeleteReasonFor(target, pathEnv);
					ctx.ui.notify(
						never
							? `Protected identity, credential, or manually maintained configuration data cannot be pre-authorized: ${target}`
							: `Cannot determine a safe persistent scope (path is too shallow or high-risk): ${target}`,
						"warning",
					);
					return;
				}
				const remembered = store.remember([scope], "command", pathEnv);
				ctx.ui.notify(
					remembered.length > 0 ? `Pre-authorized: ${scope}` : `${scope} is already allowlisted or was blocked by a safety check`,
					"info",
				);
				return;
			}

			const entries = store.entries();
			const lines = [
				`Deletion boundary: ${writableRoots(boundary).join(", ")}`,
				`Session counts: checked ${stats.checked}, remembered ${stats.remembered}, confirmed ${stats.confirmed}, denied ${stats.blocked}`,
				"",
				`Persistent allowlist (${store.filePath}): ${entries.length} entries`,
				...(entries.length > 0 ? entries.map((e) => `  ${e.path} (${e.source}, ${e.addedAt.slice(0, 10)})`) : ["  (none)"]),
				"",
				`Session exemptions (expire on restart): ${sessionScopes.roots().length ? sessionScopes.roots().join(", ") : "(none)"}`,
				"",
				"High-risk directories (system roots / bin / application directories / ~/Library / paths containing .git) prompt on every deletion and only allow session exemptions.",
				"Protected identity, credential, or manually maintained configurations (~/.zshrc, ~/.ssh, ~/.gnupg, etc.) are denied without approval options.",
				"Writes are not blocked (write / edit also work outside the boundary); Bash commands have the same deletion boundary enforced by the seatbelt sandbox.",
				"Subcommands: forget <path> removes an entry · clear empties the list · allow <path> pre-authorizes. PI_SANDBOX=off disables this layer.",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
