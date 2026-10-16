# destructive-guard

Blocks dangerous deletions **before** a tool call executes. This is the direct
response to two accidental-deletion incidents on 2026-09-23.

## Why it exists

**The first incident** (earlier that day) came down to one line:

```js
fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true })
```

Three links chained: `s.log[0].x` did not exist → `?? "/tmp"` supplied a
harmless-looking default → `path.dirname("/tmp")` produced `"/"`. It ran for
about 2.5 minutes with the local user's privileges. Root-owned trees survived
on permissions alone; everything `bachi` could write (most of `/usr/local`,
parts of `/Library`, `~/Music`, `~/.vim`…) was gone — **with no second copy
anywhere**: Time Machine was not configured, and the APFS snapshot count was 0.

`AGENTS.md`'s `## Destructive actions` section had been written two hours
before the incident — it did not stop it. That discipline constrains "me";
the incident happened in "what the script I wrote did at runtime". **Text
cannot restrain execution outside my control.**

**The second incident** (that same evening, in session `01a0ceb9`) happened
**while gate three of this very extension was being added**: `~/.zshrc`,
`~/.gitconfig`, `~/.zprofile`, and `~/.pi/agent/sessions/` all vanished.
Replaying the guard's own code afterwards showed that both gates then in
place passed **every** deleted target:

```
pass <= rm -rf ~/.pi/agent/sessions      pass <= rm -f ~/.zshrc
pass <= rm -f ~/.gitconfig               pass <= rm -f ~/.zprofile
pass <= rm -rf ~/.pi/agent
```

Three structural reasons: the protection table only guarded the **roots**
themselves (`/`, `$HOME`, `/Users`) — anything *inside* a root passed;
`AGENTS.md` said "confirm before deleting outside the working directory" but
the code never implemented it (`evaluateTarget` accepted `cwd` only to build
relative paths); and destructive git commands like `git reset --hard` were
not in the recognition set — that one rolled back the just-written gate
three.

This extension closes that segment: it hooks pi's `tool_call` event and
inspects arguments **before execution**. It is deterministic code — it does
not rely on the model's self-restraint, and it cannot be talked around.

## The three gates

**Gate one: deletion commands** (`bash` / `powershell`)

Extracts deletion targets and applies the `AGENTS.md` rule set. Recognized
commands:

| Command | Extracted targets |
| --- | --- |
| `rm` / `unlink` / `shred` / `truncate` | non-switch arguments (everything after `--` counts) |
| `find … -delete` / `find … -exec rm` | the path after `find`, before the first switch |
| `git clean -fdx` | the current directory |
| `git reset --hard` / `checkout --` / `restore` / `stash drop\|clear` / `branch -D` | no path target; the whole command is recorded as `vcs-history-loss` |
| `rsync --delete` | the destination |
| PowerShell `Remove-Item` | whether the target is a literal |

The verdict has four tiers:

- **block** — fewer than two path segments (`/`, `/etc`, `/tmp/..`); equal
  to a protected root (`/System`, `/Library`, `/Applications`, `/Users`,
  `/usr`, `/bin`, `/sbin`, `/etc`, `/opt`, `/private`, `$HOME`); an
  **ancestor** of one; equal to `$HOME`; **the guard itself** (see below).
- **confirm** — inside a system tree (`/System`, `/Library`,
  `/usr/local/Cellar`, `/private/etc`…); a VCS store root (`.git` / `.hg` /
  `.svn`); a target carrying a fallback value (`??` / `||` / `${X:-y}`); a
  computed target (`dirname()` / `$(…)` / a variable); **outside the
  working directory** (see below).
- **ok** — everything else. `/Users/bachi/x/dist`, `/tmp/scratch`,
  `/usr/local/bin/tsc` all pass.

Gate one also **drills down**: leading wrappers (`sudo` / `doas` / `env` /
`nice` / `xargs`…) are skipped, and **inline code** inside the command
(`node -e '…'` / `sh -c '…'` / `python3 -c '…'`) plus **heredoc bodies fed
to an interpreter on stdin** (`sh - <<EOF … EOF`) are judged as
sub-commands (two levels at most). The first incident's shape lives exactly
there — the danger was not on the command word.

**Confirm outside the working directory** (`outside-workdir`, added after
the second incident)

`AGENTS.md`'s third rule: "outside the working directory, and not a path
this session created → confirm first". "Created by this session" cannot be
judged statically — **the temp directories are the only reliable
approximation** (`/tmp`, `/private/tmp`, `/var/folders`) — so the check is:
the resolved path sits inside the `$HOME` subtree, outside the `cwd`
subtree, and not inside a temp directory → confirm. It only fires inside
the home subtree: both incidents' entire damage surface was inside
`$HOME`, and asking about `/usr/local/bin/tsc`-style package-manager
territory every time would just be noise (`AGENTS.md` explicitly allows
those).

**The guard must protect itself** (`self-protection`, block)

In the second incident both `rm -rf ~/.pi/agent/extensions/destructive-guard`
and `rm -f ~/.pi/agent/AGENTS.md` passed — the guard could not see itself,
nor the discipline defining it. Deleting the former disarms it on the spot;
deleting the latter erases the source of its judgment — so this tier is
block, not confirm. It covers: any `…/extensions/destructive-guard` (the
repo copy and the live install alike), `~/.pi/agent/AGENTS.md`, and the
`extensions` / `sessions` / `rewind` subtrees under `~/.pi/agent` (the
extensions, session records, and rewind snapshots — deleting them destroys
both the guard and its recovery path in one stroke).

**Destructive git commands** (`vcs-history-loss`, confirm)

What they destroy is not a filesystem path but the **only copy** of content
in the worktree / index / stash — a separate extractor (not forced into the
target model). Recognized: `git reset --hard`, `git checkout -- <path>`,
`git restore`, `git stash drop|clear`, `git branch -D`. Not recognized:
`git checkout <branch>`, `git checkout -b`, `git reset --soft|--mixed`,
`git stash push|list`, `git branch -d`, `git clean -n` (dry run) — branch
switching and soft resets destroy nothing, and false positives would turn
the guard into noise.

**Gate two: deletion code inside written content** (`write` / `edit` /
`multiedit` / `apply_patch`)

Inspects **the content being written**. In the incident, the dangerous code
had been written into a file earlier — the "run the script" step looked
completely harmless (`node verify-a.mjs`) and gate one could not see it.
Claude Code's classifier has the matching rule (`WRITTEN FILE EXECUTION`:
"writing is itself an action — judged by what it does when run"); this gate
is the same idea.

Recognized shapes: a deletion API line with a fallback value / a target
produced by path arithmetic / a bare root or `..` climb / a shell-variable
target / a PowerShell recursive delete with a non-literal target. Comment
lines do not count (they never execute). Literal targets
(`fs.rmSync("/Users")`) go through the injected protected-root table from
gate one — `writes.ts` itself does not know which directories are
protected.

**Gate three: read the file and judge it before running a script** (added
after the second incident)

Commands like `node verify-a.mjs` / `bash deploy.sh` / `./x.mjs`: **the
file is read** before execution and run through the same judgment as gates
one and two. This is the **only effective interception point** for the
first incident's line — "run a script" shows no danger on the command
word; the danger is in the file's contents.

All three forms are recognized: interpreter + file, directly executed
scripts (`./x.sh` / `/abs/x.mjs`), and the same calls **inside inline
code** (`sh -c 'node a.mjs'`). Only **literal paths** count: a path built
from a variable cannot be read and must not be guessed. An unreadable file
passes and is counted (`runtimeSkipped`) — this is a guardrail, not a
sandbox; a dialog for a path that does not exist would only become noise.
The size cap is 64 KiB (`SCRIPT_READ_LIMIT_BYTES`).

## Behavior

`block` refuses outright — the reason goes back to the model as a tool
error. `confirm` shows a picker once in the TUI; **non-interactive
environments always refuse** (fail closed — the same semantics as Claude
Code's classifier `automode-unavailable`).

The confirm dialog is **written for a human**, not a verbatim command dump:

- The title is fixed — "this command contains deletion actions; confirm
  before running" — and the body lists only the hits.
- Each hit shows four lines: **delete** (the target verbatim), **resolved
  path** (when resolvable), **in command** (shown only for chained
  commands — a single segment does not repeat itself), **why blocked**
  (one plain sentence, no `[rule]` tag).
- Command substitutions / variable expansions (`$(dirname …)` / `${VAR}` /
  backticks) count as **one word** during tokenization — they are never
  split at spaces into non-path fragments like `$(dirname` + `"$LOG")`.
- The dialog **does not scroll** (pi's `ExtensionSelectorComponent` has no
  scrollbar, and pi-tui only draws the last `terminal.rows` lines — an
  overflow clips the top), so more than 3 hits collapse into a single
  "… plus N more" line.
- Three options: **Cancel** (the default — deletes nothing), **preview
  what would be deleted first** (blocks and lets the model list the
  targets with read-only commands), **confirm deletion**.

## Switches

| `PI_DESTRUCTIVE_GUARD` | Behavior |
| --- | --- |
| unset / `on` | the default: block refuses, confirm asks |
| `block` | confirm refuses outright too (stricter) |
| `notify` | notifies without blocking — **run this first** to collect false positives |
| `off` | does nothing |

`/destructive-guard` shows the current mode and this session's counts
(checked / blocked / previewed / confirmed / passed / notified).

First-time use: run a day on `PI_DESTRUCTIVE_GUARD=notify` to see whether
it false-positives, then switch to the default.

## Files

| File | Contents |
| --- | --- |
| `targets.ts` / `targets.test.ts` | Gate one's pure logic: target extraction + tokenization + verdicts + inline-code/heredoc drill-down + destructive git commands + outside-workdir/self-protection rules (no IO, no pi deps) |
| `writes.ts` / `writes.test.ts` | Gate two's pure logic: dangerous deletion shapes inside written content (literal targets go through the injected judge) |
| `index.ts` / `index.test.ts` | The wiring: the `tool_call` hook, the three gates, gate three's script read, the mode switch, `/destructive-guard` |

## Tests

```bash
node --test clients/pi/extensions/destructive-guard/targets.test.ts \
            clients/pi/extensions/destructive-guard/writes.test.ts \
            clients/pi/extensions/destructive-guard/index.test.ts
```

109 cases. `index.test.ts` loads the extension through pi's own loader —
no fake pi object; one group pins the dialog text (targets do not show as
fragments, resolvable targets show resolved paths, single-segment commands
do not repeat "in command", over-limit collapsing, dedup), plus gate three
end-to-end (incident script blocked / clean script passed / unreadable
passed / `sh -c` nesting), destructive git commands blocked without
misfires, the incident's full damage surface hitting `outside-workdir`,
and the guard itself hitting `self-protection`. In `targets.test.ts` the
"must block" and "must pass" groups matter equally — a guard that always
prompts is no guard at all.

## Known boundaries

- **Tokenization, no symlink following.** Following them means touching
  the disk; what is wanted here is deterministic, testable, side-effect-free
  judgment. On macOS `/etc` → `/private/etc`, and both paths sit in the
  protection table — nothing is lost.
- **No full data-flow analysis.** The aim is catching real shapes with few
  false positives, not proving safety. A target passed across functions
  (`const t = compute(); rmSync(t)`) is not recognized — `AGENTS.md`'s
  discipline covers that.
- **It blocks "dangerous shapes", not "deletion itself".** Ordinary
  cleanup (a repo's `dist`, `node_modules`, temp directories under `/tmp`)
  passes.
- **`outside-workdir` approximates "created this session" with temp
  directories.** A static check cannot tell whether a path was just made
  by this session; `/tmp` / `/private/tmp` / `/var/folders` is the only
  reliable approximation. The cost: a **real** temp file inside home but
  outside the workdir asks once — that is exactly the second incident's
  damage surface, and one ask is worth it.
- **Gate three passes unreadable scripts.** Missing / over 64 KiB /
  non-literal-path scripts are counted, not blocked: a guardrail, not a
  sandbox. A real capability boundary needs an OS-level sandbox (Codex's
  seatbelt/landlock route) — a lexical gate always has holes past its
  enumeration; these two incidents were two such holes.
- **A blocklist is fail-open by nature.** This extension enumerates "bad
  shapes"; everything past the enumeration passes. It lowers the odds —
  it proves nothing. Global files under `$HOME` are truly immunized by
  backups (Time Machine / APFS snapshots / a dotfiles repo), never by any
  gate.
