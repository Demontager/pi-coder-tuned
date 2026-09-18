# rewind — Claude Code style checkpointing and `/rewind` for pi

Automatic working-tree checkpoints plus a Claude Code style rewind menu, and
`Esc` + `Esc` bound to `/rewind` instead of pi's built-in tree navigator.

## What it does

- **Snapshots the working tree before every user prompt that starts a turn**
  (Claude Code's checkpoint model), plus one at session start.
- **Catches the files that snapshot cannot see.** A checkpoint only covers
  tracked paths under the project root, so edits to `~/.pi/agent/themes/…`, an
  ignored `.env` or anything else outside the worktree would leave no trace —
  and a checkpoint with no visible change used to hide the code options
  entirely. Right before an `edit`/`write` tool runs, the file's bytes are
  copied into a pre-image blob, so those files come back too. See
  [Files outside the project](#files-outside-the-project).
- **`/rewind`** (or **`Esc` twice at an empty prompt**) opens the rewind menu:

  ```
   ────────────────────────────────────────────────────────────────────
   Rewind to a checkpoint
     #48  16:52  probe prompt 048 — …
   → #41  16:45  probe prompt 041 — …
     #40  16:44  probe prompt 040 — …
     (21/62)
     ↑↓ navigate  pageUp/pageDown page  enter select  escape/ctrl+c cancel
   ────────────────────────────────────────────────────────────────────
  ```

  The list is a **window sized to the terminal** and scrolls with the cursor:
  pi's built-in `ctx.ui.select()` renders one row per option and never scrolls,
  so a session with enough checkpoints produced a dialog taller than the
  viewport — and since pi-tui paints only the last `terminal.rows` lines of the
  document, the title and the `→` cursor row were the first things to disappear.
  The picker (`picker.ts` + `viewport.ts`) keeps the whole dialog inside the
  viewport, centres the window on the selection and shows a `(12/37)` position
  line, so the arrow is always visible. Rows still show the same
  `#N  HH:MM  prompt` labels, numbered oldest → newest.

  Keys: `↑`/`↓` (or `j`/`k`) move one row and clamp at both ends,
  `PageUp`/`PageDown` move a window, `Home`/`End` jump to the ends,
  `Enter` selects, `Esc` cancels (they follow the `tui.select.*` keybindings,
  and the paging hint only appears when the list is actually longer than the
  window). Hosts that cannot render extension components (RPC, print) fall back
  to the plain `ctx.ui.select()` list.

  then offers, for the selected checkpoint:

  | Action | Effect |
  | --- | --- |
  | Restore code and conversation | files + session tree back to that point |
  | Restore conversation (keep current files) | session tree only |
  | Restore code (keep conversation) | files only |
  | Summarize from here (frees context) | pi's native branch summary of everything after that point |
  | Never mind | back out |

  The two code options appear **only** when the checkpoint has file changes to
  revert (Claude Code parity) — counted over the worktree *and* the pre-images —
  and a confirmation dialog lists exactly which files will change before
  anything is touched.
- Conversation restore uses pi's native `navigateTree`, which drops the
  selected user message and **puts its text back into the editor** — the same
  behavior Claude Code documents.
- Footer status: `◆ N checkpoints`.
- An `↩ Undo last rewind` entry appears after a code restore, backed by an
  automatic pre-restore snapshot, so a rewind can itself be undone.

## Storage: a shadow git repository

Snapshots live in a **separate git dir outside the project**, not in the
project's own repository:

```
~/.pi/agent/rewind/<sha1(project path)[:16]>/
├── git/               # shadow GIT_DIR (commits + refs/pi-rewind/<id>)
├── files/             # pre-image blobs (content addressed) for outside files
└── checkpoints.json   # per-session checkpoint metadata
```

Consequences worth knowing:

- The project's **git history, index, HEAD, refs and `git status` are never
  touched**. A restore cannot move HEAD or discard staged work.
- Checkpointing also works when the directory is **not a git repo**.
- `.gitignore` is respected, and the real repo's `.git/info/exclude` is copied
  into the shadow repo, so ignored paths are never snapshotted and therefore
  never deleted by a restore's `git clean` (which runs without `-x`).
- Checkpoints are reachable through `refs/pi-rewind/<id>`, so `git gc --auto`
  can never prune a live checkpoint.
- Per session: 100 checkpoints max (Claude Code's number); oldest are pruned.
  Sessions whose newest checkpoint is older than 30 days are swept at startup
  (Claude Code's retention window), followed by a background `git gc`.
- A snapshot of an unchanged worktree reuses the previous commit, so read-only
  turns cost nothing but a metadata row.

Measured on this repo (105 files): cold snapshot 137 ms, warm 48 ms.

## Files outside the project

The worktree snapshot cannot see two kinds of files, and both are exactly the
kind the agent is asked to edit:

- anything **outside the project root** — `~/.pi/agent/themes/*.json`,
  `~/.claude/settings.json`, `~/.zshrc`, another checkout on the same machine;
- anything inside the root that **`.gitignore` hides from `git add -A`** —
  `.env`, `local.settings.json`, a scratch directory.

The extension therefore also captures **pre-images**. The `tool_call` hook fires
*after* `tool_execution_start` and *before* the tool runs — the last moment the
old bytes still exist — and, for `edit` / `write` targets the worktree snapshot
does not cover, copies the file into the project's blob store and records it on
the session's newest checkpoint:

- coverage is decided by path prefix plus `git check-ignore`, which applies
exactly the rules `git add -A` uses (the project's `.gitignore` files and the
  shadow repo's `info/exclude`), so a path is captured only when the snapshot
  really cannot restore it;
- blobs are content addressed (`files/<sha1>`), so the same content is stored
  once no matter how many checkpoints reference it;
- the **first touch inside a turn wins**, so the record is the file as it was
  before that turn changed it; a path touched in later turns resolves to the
  earliest checkpoint at or after the one you rewind to;
- a file that did not exist yet is recorded as *missing*, so a restore deletes
  it (the same thing `git clean -fd` does for new files inside the root);
- blobs no live checkpoint references are dropped when checkpoints are pruned,
  so the store stays bounded;
- the `↩ Undo last rewind` safety checkpoint carries the current bytes of every
  file the restore is about to touch, so an undo covers them too.

Limits worth knowing: only `edit` and `write` calls are tracked — a `bash`
command (`sed -i`, `cat >`) that writes **outside** the root is not parseable and
therefore not captured (inside the root it is still covered by the worktree
snapshot); files larger than 8 MB are skipped rather than copied.

## Esc + Esc

pi's own double-escape action is `doubleEscapeAction` in
`~/.pi/agent/settings.json` (default `"tree"`). This extension replaces it:

```json
{ "doubleEscapeAction": "none" }
```

The extension counts two raw `Esc` presses within 500 ms while the agent is
idle, the editor is empty and no dialog is open, then dispatches `/rewind`
through pi's command path (so the handler gets a command context with
`navigateTree`, which a raw-input handler never has).

Details that matter:

- The **second** press is consumed (`{ consume: true }`). Without that, the
  escape would land on the selector that `/rewind` just focused synchronously
  and instantly cancel it. Consuming also keeps the press from pi's built-in
  double-escape action, so `/rewind` takes over even if `doubleEscapeAction`
  is still `"tree"` or `"fork"`.
- The **first** press is passed through untouched, so a lone `Esc` still aborts
  streaming, aborts a running `!` bash command and cancels dialogs.
- Presses are ignored while streaming (`isIdle()`), while the editor has text,
  and while any extension dialog is open (tracked via `ui_prompt_start` /
  `ui_prompt_end`), matching Claude Code's "double `Esc` at an empty prompt".

To get pi's tree navigator back on `Esc` + `Esc`, remove this extension and
set `doubleEscapeAction` back to `"tree"`; `/tree` always works regardless.

## Differences from Claude Code (all deliberate)

| Claude Code | Here |
| --- | --- |
| Tracks only its file-editing tools; **bash-made changes are not tracked** | Whole-worktree snapshots, so bash edits, subagent edits and any other edit inside the root are captured too; edits outside the root (or in ignored paths) are captured as pre-images by the same `edit`/`write` hook |
| Snapshots the edited files themselves | Worktree snapshot for the project, pre-image blobs only for what it cannot see: no duplicate copies of tracked files |
| No redo of a rewind | `↩ Undo last rewind`, backed by a pre-restore snapshot |
| No confirmation before a code restore | One confirmation listing the changed files |
| `Summarize up to here` | Not offered — pi can summarize an abandoned branch or compact the whole context, but not "everything before an entry while keeping later messages" |
| Skips symlinked / hard-linked paths on restore | git materializes symlinks as symlinks, so no skip list is needed |
| Checkpoints survive resume | Same — metadata is keyed by session id |

Known gap: a follow-up message that pi delivers inside a running turn still
gets its own checkpoint (it is a user message), unlike Claude Code's
"messages sent mid-turn are not checkpointed".

## Files

```
rewind/
├── index.ts              # entry: session lifecycle, checkpoint + pre-image hooks, /rewind, Esc+Esc
├── checkpoints.ts        # pure shadow-git core (no pi imports)
├── flow.ts               # the /rewind menu flow
├── picker.ts             # the scrollable checkpoint picker (pi-tui component)
├── viewport.ts           # pure layout budget: how many list rows fit the terminal
├── checkpoints.test.ts   # 23 tests for the core
├── flow.test.ts          # 26 tests for the flow (scripted mock dialogs)
└── viewport.test.ts      # 8 tests for the picker layout budget
```

pi auto-loads only `index.ts` from a subdirectory (`extensions/*/index.ts`);
the other files are plain modules and tests.

## Tests

```bash
node --test ~/.pi/agent/extensions/rewind/checkpoints.test.ts
node --test ~/.pi/agent/extensions/rewind/flow.test.ts
node --test ~/.pi/agent/extensions/rewind/viewport.test.ts
```

57 tests, no npm dependencies. The core tests create throwaway projects and
agent dirs under the OS temp dir and assert the real repo's index/HEAD/status
stay untouched; the flow tests drive the menu with a scripted mock command
context, since TUI dialogs cannot be exercised headlessly (the picker is
reached through the injectable `deps.pick`, with the `ctx.ui.select()` fallback
covered separately); the viewport tests assert that the dialog — list, chrome
and the rows pi paints below the editor — fits the terminal at every height.

The picker itself was verified live in a tmux-driven TUI with 62 checkpoints:
at 24 rows it shows 14 rows plus `(1/62)`, at 14 rows it shrinks to 4, in both
cases with the title, the borders and the arrow on screen; `PageDown` jumps a
window (`(1/62)` → `(29/63)`), `End` lands on `Never mind` with the arrow still
visible, and picking `#4` of five checkpoints holding distinct file contents
restored exactly that version (`v5` → `v4`), with `↩ Undo last rewind` putting
`v5` back. `Esc` cancelling the picker and `Esc` + `Esc` opening it (a single
`Esc` not) were re-checked there too.

Earlier live checks (unchanged by the picker): `/rewind` restore, a lone `Esc`
still aborting streaming, and `Esc` + `Esc` correctly doing nothing while the
editor holds text. The outside-project path was verified the same way: a
`write` to a file outside the root was captured as a pre-image, the menu then
read `1 file: ~1` for a project whose worktree was untouched and offered the
code options, the restore put the old bytes back, and `↩ Undo last rewind` put
the new ones back again.
