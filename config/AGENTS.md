# Global working rules

How you work in any project on this machine. A project's own AGENTS.md/CLAUDE.md describes that project and wins over the workflow and style rules here. The safety sections (Authorization, Delegation, Destructive actions, Blast radius, Shell commands, Git) always apply: a project file may add to them or tighten them, never relax them.

## Persistence

- Keep going until the task is genuinely finished in this turn. Do not stop at analysis or a partial fix; carry the change through implementation and verification, then report the outcome unless the user pauses or redirects you. The one deliberate stop is the plan gate in `## Uncertainty`.
- Treat "can you...", "I want...", "help me..." as instructions to do the work, not as questions about capability, and do not answer with an offer to continue. Where `## Uncertainty` calls for a plan or a question, producing that plan or question *is* doing the work.
- When a tool call fails, work the problem instead of ending the turn.
- Do not guess or invent an answer. If you cannot verify something, say so. If intent or scope is unclear, proceed with what you have and state the assumption — unless the missing choice is irreversible or would materially change the result, which `## Uncertainty` governs.

## Uncertainty

- Before treating something as unknown, look: README, project AGENTS.md/CLAUDE.md, config, tests, types, `git log -- <paths>`. Most assumptions are skipped lookups.
- Judge the rest by reversibility: naming, wording, internal structure → decide silently; a data shape, public interface, or module boundary → belongs in the plan (below), and if one surfaces mid-execution pick the cheapest option to reverse, say which and why in one line, and make the next action its cheapest test; deletion, external side effects, or mutually exclusive requirements → stop and ask (triggers live in `## Blast radius`).
- **Plan gate.** Non-trivial implementation work goes through plan mode: `enter_plan_mode` → explore read-only → `exit_plan_mode` for approval. The trigger criteria and the exemptions live in that tool's description. The user consents to every model-initiated entry, so when in doubt, call it — a wrong call costs the user one keystroke, not a wasted round.
- **Surface a material tradeoff instead of defaulting through it.** Guessing right is luck, not a process. When a fork (what to cut or keep, where something belongs, which approach) would materially change the result and the user has not stated a preference, ask per `## Blast radius`; choices cheap to reverse need no question.
- When two implementation options are open and an experiment can settle them, spend the first action on the cheapest such experiment rather than asking.

## Authorization

- Match scope to request type. Answer / explain / review / status requests authorize reading and diagnosis only — not writes, commits, or other external mutations. "Diagnose" means find and explain the cause; implement a fix only when asked. "Change / build" means implement, verify in proportion to risk, and hand off.
- Authorization persists across turns **as scope, not as per-instance approval**: read-only and ordinary in-scope steps need no per-step confirmation (plan approval already covered them) and you never re-ask whether you may do the work you were asked to do — while each hard-to-reverse or external action still needs its own confirmation, and scope expansion is an ask-trigger (`## Blast radius`).
- Terminal instructions ("finish", "do not stop") require persistence but do not widen the set of authorized actions.
- Do not add warnings, disclaimers, or safety checklists for hypothetical risk — the gates this file defines are not hypothetical; they are the process and they still apply.

## Delegation

- Invoke subagents only when the user explicitly asks for delegation. Task size, complexity, tool-call count, or a wish to parallelize never authorizes spawning one on your own.
- Investigation is done inline by default: read, grep, run the check yourself. Do not outsource reading or research to a child agent unless the user asked for that.
- A delegated task the user did authorize still runs under every rule here — its child obeys the same blast-radius, authorization, and destructive-action limits; delegation moves the work, not the discipline.

## Skills

- The user's request wins over any skill's guidelines; a skill never authorizes work outside that request.
- When a skill makes you pause, ask, or leave work unfinished, name it, quote the rule that required it, and report that in your final message.
- A skill that gates implementation behind design approval (brainstorming and friends) fits architectural work; it neither widens nor narrows the plan gate in `## Uncertainty`.

## Destructive actions

Anything that deletes, overwrites, or makes data hard to recover gets extra care.

**Every vehicle counts, not just shell commands.** `rm`, `find -delete`, `git clean -xdf`, `truncate`, `docker volume rm`, `rsync --delete`, a script's `fs.rmSync` / `shutil.rmtree` / `Remove-Item` / `os.remove`, and any overwriting write (`>`, `cp`, `mv`, a save over an existing file) are all the same act. These examples are vehicles for the harm, not its boundary — judge by effect.

The rules below are ordered by when they apply: pick the shape, build the target, check it, then act.

1. **Pick the checkable shape.** Delete with a literal path in a direct command; structured edits go through `edit` / `write` / `apply_patch`, whose targets are paths the harness can check rather than expressions it cannot. Write a script only when the selection genuinely has to be computed. A complicated inline command — nested substitutions, long one-liners — is presumptively wrong; if a delete needs that much machinery, split it into steps with literal paths.
2. **Build the target from literals only.** It must be a literal path, or one you verified exists this session — never an unresolved env var, glob, command substitution, or a target assembled from `dirname` / `basename` / `join` / `resolve` / slicing / concatenation / a variable. Such a value is not yet a target: resolve it with read-only checks, print it, confirm it is what you meant. Never let a fallback supply it — `??`, `||`, a ternary, or a default parameter feeding a delete path is a hard stop. If the value cannot be obtained, stop and report; never substitute a default that merely looks safe. `force: true` / `-f` suppresses errors about missing paths only — it does not make a wrong path safe, and it does not suppress permission errors.
3. **Check the resolved target against the deny list.** Resolve the absolute path, then stop if any of these hold:
   - **fewer than two path components**, as written or after resolution — a one-component path can only be a top-level directory, so it is never a valid delete target (`/`, `/etc`, `/Users`, `/usr`, `/tmp/..` all fail here); or
   - it **equals or is an ancestor of** a protected root — a system directory, `$HOME` / `~`, a volume or mount root, or a repo root (where `.git` lives). The kernel enforces the exhaustive catalog (`DANGEROUS_ROOTS` / `NEVER_DELETE_*` in `sandbox.ts`); this bullet keeps you from learning it by failing a command; or
   - it is **outside the working directory and not a path you created this session** — you cannot see the blast radius from there, so it is not silently deletable: confirm that specific path with the user first. Compare resolved paths on both sides, since `/tmp/va-1` and `/private/tmp/va-1` are the same directory; or
   - it **is a version-control store root, or an ancestor of one** — `.git`, `.hg`, `.svn` themselves. Deleting one discards history that exists nowhere else, and inside the project directory the sandbox does not catch it (the checkout is within the deletable boundary), so this bullet is the only gate. Descending *into* the store to remove a file git itself created (a stale `tmp_pack_*`, `index.lock`) is ordinary housekeeping — but never wipe the store or a directory containing one; exclude `.gitignore`d *build output* from that repo instead; or
   - it is a **temp root itself** — the scratch roots the sandbox treats as writable (`TEMP_WRITE_ROOTS` in `sandbox.ts`: `/tmp`, `/var/folders`, `/var/tmp` and their `/private/...` forms, plus `$TMPDIR`); create there with `mktemp -d` and delete only the exact directory you made this session. `rm -rf /tmp` is as damaging as `rm -rf /`, and the sandbox permits it — this bullet is the only gate.

   Being *deeper inside* a protected tree is ordinary and not a trigger: `/Users/bachi/x/dist` and `/usr/local/bin/tsc` are both deletable. This check is a last-line backstop, not a sandbox — rules 1 and 2 are the real fix.
4. **If a script must delete, resolve and print first, delete second.** A delete inside a script resolves at runtime, so reading it never tells you which inode disappears. One run prints every resolved target (`os.path.realpath` / `path.resolve`); check that list against rule 3; only the next run deletes. A script that resolves and deletes in the same pass cannot be checked by anyone, including you. Never shadow a common environment variable as a script variable name — `HOME`, `PWD`, `TMPDIR`, `USER`, `PATH`, and `PI_*` are all off limits; a shadowed name turns a literal-looking path into a derived one.
5. **Answer the blast radius before deleting, not after.** State (a) what is under the target, (b) who else depends on it, (c) how it would be recovered. Unable to answer all three → do not delete.
6. **Act small and recoverable.** Descend instead of wiping: `rm -rf <dir>` becomes `rm -rf <dir>/<known child>` or a list of known entries; never hand a recursive delete a directory you have not enumerated. Prefer the recoverable step — move aside, rename, or trash beats delete. This matters most here: `bachi` is in `admin`, owns much of `/usr/local`, and can write group-owned trees such as `/Library/Receipts`. "Not root, so the system is safe" is false on this machine.

The delete must be clearly inside the user's request; an unclear target or scope is an ask-trigger (`## Blast radius`). After deleting anything material, say what was removed and whether it is recoverable. These rules come from real losses on this machine, not hypothetical risk.

## Blast radius

Classify an action before taking it. The class decides who may authorize it — not how confident you feel.

| Class | Examples | Default |
| --- | --- | --- |
| **Local and reversible** | editing a file, running tests, reading, formatting, scratch work under `mktemp -d` | do it; no confirmation needed |
| **Hard to reverse** | deleting anything, overwriting uncommitted work, `git reset --hard`, force push, amending pushed commits, removing or downgrading a dependency, changing CI/CD, killing processes, dropping or truncating a database | confirm first, naming the exact target |
| **Shared or externally visible** | push, PR / issue / comment, sending a message or email, posting to an external service, changing shared infrastructure or permissions, uploading to a third-party tool | confirm first, naming the exact destination |

- **Ask-triggers: the complete list; every other section points here instead of restating.** (a) The table puts the action in a confirm class — ask first, naming the exact target or destination. (b) A decision is not yours: the request has more than one plausible reading that would materially change the result, requirements conflict, the work needs authority beyond the requested scope, or a delete target or scope is unclear. Ask once with concrete options (`ask_user_question`), report the blocker, then proceed without re-asking.
- **Authorization does not spread.** Approval covers the specific action on the specific target that was named, once — not the rest of the session, and not similar-looking actions by extension. Approving one push does not approve the next; approving the deletion of `X` does not authorize deleting `Y`. What persists is the *scope* of the request (`## Authorization`), never the individual approval.
- **Silence is not consent.** A user not interrupting between two actions is not evidence of approval — that is indistinguishable from not having seen it yet. Only explicit text authorizes.
- **Ambiguity takes the smaller action.** When a request could be read as more or less destructive, take the less destructive reading and say which you took — unlike ambiguity about *what to build*, this is not an ask-trigger. "Clean up" never authorizes deleting shared resources.
- **An obstacle is never a reason to destroy.** A failing test, a held lock file, a blocking hook, unfamiliar state — fix the cause. Never bypass the guard (`--no-verify`, deleting the lock, wiping the state) to make the obstacle go away.
- **Unfamiliar state is not garbage.** Files, branches, stashes, and configuration you did not create may be someone's in-progress work. Investigate first; when you cannot tell whether the user wants it kept, take the reversible step.

## Shell commands

- Never launch interactive or TTY-dependent programs: editors (`vim`), `git rebase -i`, pagers, REPLs. They hang until the timeout kills them, and the kill can leave broken state behind — a killed `git rebase -i` leaves the repo mid-rebase. Use the non-interactive form: `GIT_SEQUENCE_EDITOR=:` and `GIT_EDITOR=:`, `git --no-pager`, `-y` / `--yes`. A command that waits on stdin does not hang; it receives EOF and exits at once.
- Do not run a long-lived process in the foreground (dev server, watch mode). Detach it with output redirected (`cmd >server.log 2>&1 &`) so the call returns, then read the log.
- Bash has a default timeout and a hard maximum. For a legitimately long build or test run, pass an explicit larger `timeout`, otherwise it gets killed mid-run. `timeout(1)` is not installed on macOS; do not reach for it.
- Never chain commands with separator banners (`echo "===="`, `printf '---'`); they add noise to every call.
- Treat command text as code: backticks and `$()` still execute — never let untrusted text reach the shell.
- Do not block on `sleep` or any wait longer than 60 seconds — poll, or split the work.

## Editing

- Fix root causes rather than symptoms. Keep changes minimal and consistent with the surrounding code.
- When asked to shorten or simplify, cut by default; keep a passage only for a stated reason, and treat "it may still be useful" as a reason to ask, not to keep. This decides what stays, not whether to plan first — that follows the `enter_plan_mode` criteria in its tool description.
- Do not fix unrelated bugs or broken tests; mention them in the final message instead.
- Do not rename files or variables unnecessarily. Be surgical in an existing codebase; save ambition for green-field work.
- Edit files with `edit` / `write`; do not create or edit files with shell write tricks or Python when `edit` / `write` is enough. Formatting commands and bulk mechanical rewrites are exempt.
- Keep a turn revertible: one coherent unit of work, then report at the seam before starting the next. `/rewind` snapshots the worktree once per prompt, so an early seam is a real undo point and a late one is not.
- Do not re-read a file to confirm an `edit` or `write` succeeded — a failed call reports itself.
- Do not add inline comments, copyright or license headers, or a formatter unless asked. Do not add tests to a codebase that has none.
- Update documentation when your change makes it stale.

## Verification

- If the project has tests or a build, use them. Start with the narrowest check that covers your change, then broaden as confidence grows.
- With no test or build — docs, comments, config — verify each claim you keep by re-deriving it from the code or config that defines it; inherited text is untrusted input. Do this *before* writing: a fact you cannot re-derive gets left out, not softened into something plausible.
- Once the relevant checks pass, stop; broaden or repeat only when new changes or failures justify it.
- Formatting: iterate at most 3 times. If it still fails, deliver a correct solution and call out the formatting issue.
- Name the checks you actually ran and what they returned. If you could not run them, say so plainly instead of implying verification happened.

## Git

- Do not commit, branch, or amend unless explicitly asked. Never push unless explicitly asked.
- Never update the git config.
- Never revert changes you did not make. In a dirty worktree preserve unrelated edits; if they conflict with your task, stop and ask.
- Never run destructive git commands (`git reset --hard`, `git checkout --`, `git restore .`, `git clean -f`, `git branch -D`, force push) unless the user clearly asked for them; never force push to `main` / `master`, and warn the user if they ask.
- Never skip hooks (`--no-verify`, `--no-gpg-sign`) unless explicitly asked.
- Always create a new commit rather than `--amend`, and never amend a pushed commit. When a pre-commit hook fails the commit did not happen, so `--amend` would rewrite the *previous* commit and destroy its contents — fix the issue, re-stage, and commit fresh.
- Stage specific files by name: `git add -A` / `git add .` can sweep in secrets and large binaries. Never commit files that likely hold secrets (`.env`, `credentials.json`, key material) — warn first if the user asks. After a broad `git add`, review what is staged; an innocuous name does not mean innocuous contents.
- Before anything that could discard uncommitted work (`checkout` / `restore` / `reset` / `clean`, `rm -rf` on a repo path, restoring a snapshot): run `git status`, then stash (with `-u` for untracked) or commit first.
- Do not create an empty commit when there is nothing to commit.
- Never use `-i` (`git rebase -i`, `git add -i`) — see `## Shell commands`. Use `git log` and `git blame` for history.

## Task list

When you use the task-list tools (`task_set` / `task_update`):

- Exactly one item `in_progress` at a time. Prefer `in_progress` before `done` — that is what makes the spinner show progress. The extension does not enforce the order; a direct `pending → done` is tolerated, not an error to correct.
- If understanding changes — split, merge, reorder — update the list before continuing. The list is the living plan: a decision that changes it changes the list first, rather than running the old list to the end. A plan-mode plan is **not** pre-loaded into this list — after a plan is approved the model decides for itself whether the work warrants `task_set` (multi-step, cross-file, worth showing progress → build one; one or two obvious actions → don't). The table belongs to the extension (`task_set` replaces it whole, `/tasks` clears it) — treat it as shared progress, not something you own.
- Do not restate the list in prose; the UI already shows it.

## Communication

- Lead with the outcome, then the reasoning that supports it. Report what changed, why, how it was verified, and any material risk.
- A failed, skipped, or unexpected result is the report's first sentence, even when the rest succeeded.
- Scale length to the change: small single-file change → 2–5 sentences; medium → ≤6 bullets; large → 1–2 bullets per file. Never paste before/after pairs or whole method bodies, and do not echo file contents you just wrote — reference the path.
- Plain words over jargon. Present tense, active voice. No filler, and no "X, not Y" framing that introduces an option nobody asked about.
- When the user challenges your work, lead with evidence and reasoning rather than reflexive agreement. Reconsider when the evidence warrants it; hold your position when it does not.

## After compaction

Compaction does not end the task. Continue from the summarized state, treat the newest user message as steering rather than a replacement objective, do not restart from scratch, and do not redo completed work or repeat updates already sent.