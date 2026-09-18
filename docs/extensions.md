# Extensions reference

22 extensions load from this package. Twelve are single files in `extensions/`, ten are directories whose entry point is `index.ts`. Two more directories (`thinking-collapse/`, `tool-diff/`) contain pure-logic modules only — they have no `index.ts`, so pi never loads them as extensions, but the top-level files import them.

Every extension is also documented in its own header comment (Chinese, except `rewind/`): the pi internals it relies on, the failure that motivated it and the trade-offs that are not visible in the code. This page is the map.

## Commands

| Command | Extension | Arguments |
| --- | --- | --- |
| `/ask` | `ask-user-question` | — Previews the questionnaire with a demo question. |
| `/bash-collapse` | `bash-command-collapse` | `off` \| `on` \| `<1-50>` — Collapsed visual lines for the command. |
| `/bash-preview` | `bash-command-collapse` | `off` \| `<1-50>` — Output preview lines; `off` restores pi's built-in preview. |
| `/bash-stream` | `bash-command-collapse` | `off` \| `on` — `on` uses pi's native streaming instead of the collapse path. |
| `/bash-timeout` | `bash-command-collapse` | — Prints the default, maximum and env-overridden bash timeout. |
| `/bash-tree` | `bash-command-collapse` | `off` \| `on` — Tree indentation (`│`/`└`) for bash output. |
| `/clear` | `clear-command` | — Alias of `/new`. |
| `/exit` | `exit-command` | — Alias of `/quit` (the argument-free form of the quit words). |
| `/init` | `init-command` | `[file.md] [extra instructions]` |
| `/read-collapse` | `read-path-collapse` | `off` \| `on` |
| `/recap` | `recap` | — Summarizes the conversation now. |
| `/rewind` | `rewind` | — Checkpoint menu; also Esc Esc at an empty prompt. |
| `/tasks` | `simple-task` | `status` (default) \| `clear` \| `on` \| `off` |
| `/theme` | `theme-command` | `[name]` — Without arguments: picker with live preview. |

## Tool overrides

pi registers one handler per tool name (first registration wins), so each of these owns a builtin tool outright.

### `bash-command-collapse.ts` — the `bash` tool

Collapses long commands to N visual lines (default 3) followed by `… (123 tokens hidden)`, hard-wrapping at the column budget the way CSS `word-break: break-all` does rather than pre-wrapping whole words: a 78-column path fills the line completely and breaks at the edge. `ctrl+o` expansion shows the command in full. The extension also draws its own background box, tree-indents output, syntax-highlights the command line, and can give bash output its own color through the `bashOutput` theme token ([themes.md](themes.md#bashoutput)).

- `PI_BASH_MIN_TIME_MS` (default `2000`) — only show the elapsed-time footer above this duration.
- `PI_BASH_HIGHLIGHT=off` — disable shell syntax highlighting.
- `PI_BASH_TREE=off` — disable tree indentation.
- `PI_BASH_SPINNER=off` — disable the `●` on running rows (implemented in `working-indicator`).

Two details that look simplified but cannot be: it decides "arguments are still streaming" from `!streaming && !argsComplete && isPartial === true` (both thresholds are required, or `/resume` replays lose the command line entirely), and `isError` must be read from `context`, not `result`, because pi's result renderer is called without that field.

### `read-path-collapse.ts` — the `read` tool

Keeps the `read` title row on exactly one line. Long paths lose their front and keep the informative tail — the file name and last directories — as `Read …@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:62-116`. No folding, no second row.

- `/read-collapse off | on`, `PI_READ_COLLAPSE=off` — restore pi's builtin title row.

### `tool-diff.ts` — the `edit` and `write` tools

Claude Code style diffs: full-line background for added and removed lines (including the line-number gutter), inline highlight of the changed span, and syntax highlighting. Both tools are re-registered with `renderShell: "self"`, which is what makes per-line backgrounds possible — the default shell paints whole blocks by status and would cover them.

The two line backgrounds come from theme tokens that pi's official schema does not define: `toolDiffAddedBg` and `toolDiffRemovedBg`. When a theme omits them, the extension falls back to the much flatter `toolSuccessBg` / `toolErrorBg`. See [themes.md](themes.md#custom-tokens).

### `thinking-collapse.ts` — thinking blocks

Registered as a markdown transformer for `assistant-thinking`. Every thinking block renders as **one continuous line**, no matter how many paragraphs, list items or fenced blocks the model wrote:

```
Think: …latest token keeps appending at the end
```

- Nothing is line-wrapped. When the line exceeds the terminal width, characters are dropped **from the front** and a leading `…` is added, so the end of the line is always the newest token.
- At paragraph seams (blank lines in the original) a Chinese comma is inserted between two Chinese paragraphs; a paragraph that already ends in punctuation is left alone, and Latin text keeps the space rule.
- There is deliberately no "backfill to fill the row" logic, and no `… (N tokens hidden)` notice — the spinner below already counts tokens.
- No command, no environment switch. The only form is this one.

### `fenceless-code-block/` — markdown code blocks

Removes code fences, including the language label, and lays the code out with pi's own indentation and syntax colors — no background is added. It works by patching `Markdown.prototype.renderToken` at module evaluation time, which is effective because pi's bundled loader points extensions at its own inlined `@earendil-works/pi-tui` namespace. Installing twice (after `/reload`) wraps only once.

- `PI_FENCELESS_CODE=off` — keep the fences.

## TUI chrome

### `statusline/` — the footer

Replaces pi's footer with one status line and one status row:

```
⚡️ qwen3.8-flash/xhigh | Ctx 0.0% | main | (+0,-0)
📁 /Users/you/project
```

The main row shows model/thinking level, context usage, git branch and diff stat; when the working directory is not a git repository it says `no git`. The second row renders whatever other extensions pass to `ctx.ui.setStatus()` (this is where `cwd-statusline`, `simple-task` and `rewind` write). Lines are truncated, never wrapped. Git reads happen on a debounced background path (400 ms after `turn_end`/`agent_end`/`tool_execution_end`, immediately on branch change, with a 30 s fallback poll) so the render path is a map lookup.

- `PI_STATUSLINE_FREEZE=off` — disable the footer freeze. On every session switch pi unconditionally restores its builtin footer and clears all `setStatus` values, and no extension hook runs before that frame. The guard replays the previous frame's lines instead, which removes a visible flash. Turning it off restores the flash.
- No config file. Colors come from `theme.fg(...)`, so `/theme` repaints on the next frame.

### `cwd-statusline.ts` — full working directory

Prints the complete `ctx.cwd` as an extension status line, deliberately uncompressed: no `~` shortening, no truncation of middle segments. Only terminal width truncates it, with an ellipsis, never a wrap.

- `PI_CWD_STATUSLINE=off`, `PI_CWD_ICON` (default ` 📁`).

### `startup-logo/` — the header

Replaces pi's header with a static pi logo, the version and the working directory (shortened to `~/...` inside the home directory), keeping the compact key hints below so no information is lost. It also prunes the `[Context]`, `[Prompts]` and `[Themes]` sections from the startup resource list — those three carry no information — while keeping `[Skills]`, `[Extensions]` and every diagnostic section. Pruning works by locating the mounted header component, so it only happens when the logo is installed.

The logo is static by design: no frame table, no timers, no `requestRender`. Narrow terminals degrade to a single-line wordmark.

- `PI_LOGO=off` — do not install the header.
- `header-guard.ts` freezes the header across session switches for the same reason the statusline freeze exists: pi restores its builtin header first, and that frame is visible.

### `below-editor-after-statusline.ts` — widget placement

pi mounts `belowEditor` widgets between the editor and the footer, which pushes the statusline to the very bottom of the screen. `pi-subagents`' fleet status line is registered that way. This extension finds the container holding the probe widget by object identity (never by index) and moves it to the end, so the fleet line sinks below the statusline and the editor keeps the statusline next to it.

The probe must be registered with `placement: "belowEditor"`. Omitting it silently moves the *upper* container instead, with no runtime error. Nothing happens if the container cannot be found.

- `PI_BELOW_EDITOR_AFTER_STATUSLINE=off`.

### `prompt-editor.ts` — the input box

Two cosmetic changes to the editor: a `❯ ` gutter (the real editing area is narrowed and the gutter is re-added per line, so cursor placement, IME positioning and mouse clicks all stay correct), and one blank line between a visible autocomplete list and the statusline. The blank line is only added when the list is actually rendered, judged by the public `isShowingAutocomplete()`.

- `PI_EDITOR_PROMPT` (default `❯`), `PI_EDITOR_AUTOCOMPLETE_GAP=off`, `PI_EDITOR_AUTOCOMPLETE_SHIFT` (default 1 column).

### `working-indicator/` — the working message

Replaces the fixed `Working` loader with a semantic label, a token count for the current segment and an elapsed time:

```
Tools Calling (↓ 70 tokens · 10s)      Editing (↓ 40 tokens · 3s)
Writing (↓ 120 tokens · 8s)            Reading (↓ 12 tokens · 1s)
Thinking (↓ 900 tokens · 22s)          Working (5s)
```

The token count is **per segment**, not per turn: each reasoning segment and each tool-argument segment starts from zero, so a `bash` command's count reflects that command. Body text is deliberately not counted. `usage.output` is always `0` while streaming, so counts are estimated from streamed characters. Elapsed time is `42s`, `1m 23s` or `1h 23m 32s`. The label uses the normal foreground color while the statistics stay muted, which requires composing everything into the single string pi receives.

The same extension draws the `●` on a running bash row.

- `PI_BASH_SPINNER=off`, `PI_SPINNER_RAINBOW=off`, `PI_SPINNER_COLOR_HOLD` (default `19` frames per color).
- `PI_WORKING_SUMMARY=off` — disable the prompt summary line entirely.
- `PI_WORKING_SUMMARY_LLM=off` — truncate long prompts instead of asking a model to compress them.
- `PI_WORKING_SUMMARY_TRIGGER` (default `1.2`) — ask for a summary when the prompt exceeds the available width by this factor.
- `PI_WORKING_SUMMARY_MODEL` — `provider/modelId` for that request; defaults to the session model so a typo can only cost the summary, never the request.
- `PI_WORKING_SUMMARY_GAP` (default `1`).

## Workflow

### `simple-task/` — task list

A lightweight task list: `task_set`, `task_update`, `task_get` and `/tasks`. Three states (`pending`, `in_progress`, `done`), no blocks, no dependency graph, no notes, no title-length validation.

State is written with `pi.appendEntry()`, so it rides the session log and **nothing is written into your repository** — no `.pi/tasks/*.json` to gitignore. Rebuilding reads `ctx.sessionManager.getBranch()`, not `getEntries()`, so branch navigation cannot resurrect a discarded branch's tasks.

`/tasks` with no argument or `status` prints the list, `clear` empties it, `on` / `off` toggle the widget.

### `recap/` — conversation summary

`/recap` summarizes the conversation on demand; the same summary appears automatically above the editor after **30 seconds of idling** with no new input, and disappears as soon as you type.

The delay is the point: the recap exists to tell you what a session was doing when you come back to the window, so it is idle-based rather than turn-based. The timer first asks whether any subagent is still running (an in-process RPC to `pi-subagents`, no file import — a missing package is treated as "no subagents") so a background delegation is never summarized as finished.

Deliberately not implemented: no local storage, no session entry, no configuration. The summary lives in memory only, so `/new` or `/resume` does not restore it and it is never sent to the model as context. The summary text itself is **generated in Chinese** (the prompt is hardcoded), which is worth knowing if you do not read Chinese.

### `rewind/` — checkpoints and `/rewind`

Claude Code style checkpointing. Before every prompt that starts a turn, the working tree is snapshotted into a **shadow git repository** under `~/.pi/agent/rewind/<project-hash>/git` with `GIT_DIR` pointed at it and `GIT_WORK_TREE` at your project. Your repository's HEAD, index, refs and status are never touched, and this works in directories that are not git repositories at all.

Files the snapshot cannot see — anything `edit`/`write` touches outside the project root, inside it but `.gitignore`d, or inside a nested repository — are covered by lazy pre-image mirroring driven by tool-call events, with blobs addressed by content.

`/rewind`, or Esc Esc at an empty prompt, opens a menu: restore code and conversation, conversation only, code only, summarize from here, or never mind. Conversation restore uses pi's native session-tree navigation, which drops the selected user message and puts its text back into the editor.

- **Requires `doubleEscapeAction: "none"`** in `settings.json`. The extension warns once at session start if the built-in tree navigator would fire instead. It consumes the second Esc (the selector takes focus synchronously, so letting it through would cancel the menu it just opened) while leaving the first Esc alone, so Esc still aborts streaming.
- Known limits: only the `edit` and `write` tools are tracked (`bash` writes outside the root cannot be parsed), and files larger than 8 MB are not copied.

### `init-command.ts` — `/init`

Claude Code style repository memory file generation. Target selection looks only at `ctx.cwd`:

1. `CLAUDE.md` exists → update `CLAUDE.md`
2. else `AGENTS.md` exists → update `AGENTS.md`
3. else create `AGENTS.md`

`/init <file.md> [extra instructions]` overrides the target and appends your requirements. The extension writes nothing itself: it resolves the target and sends a prompt as a user message, so the model's own `read`/`write`/`edit` calls do the work and you can watch and correct them. It waits for the current turn to finish before sending.

### `theme-command.ts` — `/theme`

A one-step theme picker with live preview. Arrow keys preview, Enter persists, Esc cancels. `/theme <name>` switches and persists directly.

The preview works because `ctx.ui.setTheme()` has two distinct paths: passing a **Theme object** only recolors the running UI (`setThemeInstance()`), while passing a **name** applies it and immediately writes `settings.json` (`setThemeName()`). So browsing never touches your settings, and only Enter does. In non-TUI modes the command notifies instead of silently failing.

### `folder-history.ts` — cross-session command history

Persists command history per working directory in `~/.pi/folder-history/<path-with-dashes>.jsonl` and injects previous sessions' entries into the editor's own history array, which makes the **native ↑/↓** walk across sessions.

The mechanism matters: previous sessions' entries are appended to the tail of `Editor.history` (tail = older), so ↑ goes further back in time. No shortcut is registered — a registered `up` key would swallow cursor movement in multi-line prompts and arrow navigation in every selector. `PI_FOLDER_HISTORY_INJECT` (default `100`) caps how many entries come from earlier sessions.

### `clear-command.ts` — `/clear`

Alias of `/new` implemented through `ctx.newSession()` — the same replacement flow the builtin uses, so behavior and on-disk format match. It calls `ctx.waitForIdle()` first so an in-flight turn (including retries and auto-compaction) is never racing the session swap.

### `exit-command.ts` — quit words

Typing `exit`, `quit` or `bye` as the entire prompt quits pi cleanly (sessions are saved; `session_shutdown` still runs). Matching is exact and case-insensitive, so "exit the loop and print a summary" is untouched, and messages with attachments pass through. It only applies in TUI mode: in `--print`, `--mode json` and RPC mode these remain ordinary prompts. Also registers `/exit` as an alias of `/quit`.

- `PI_EXIT_WORDS="exit,quit"` — replace the words; `off` disables the interception.

## Model and tooling

### `auto-default-model/` — persistent model switches

pi's `/model` picker only changes the current session; persisting it takes a separate Ctrl+S (`setModel(model, { persist: true })`). This extension performs that step automatically on every model switch — the picker, Ctrl+P cycling, a subagent profile switch, anything that calls `pi.setModel()`.

It writes through pi's own `SettingsManager`, so it uses the same file lock as pi (`proper-lockfile`), merges only the changed fields into the newest on-disk content, and therefore cannot clobber concurrent `/theme` or `/settings` writes. It skips session restore (`source === "restore"`) and skips no-op writes. Failures are notified; successes are silent, because the model name is already visible in the statusline.

- `PI_AUTO_DEFAULT_MODEL=off`.

### `ask-user-question/` — the `ask_user_question` tool

A Claude Code style structured question tool. The model asks instead of guessing; a questionnaire appears in the terminal with up to **4 questions**, each with **2–4** described options, a free-text row appended automatically, Space to multi-select, ↑/↓ to navigate and Esc to abandon the whole questionnaire. Answers return to the model as structured text.

The labels `Other` and `Type something.` are reserved — validation rejects them — and the number of questions and options is enforced by the tool's TypeBox schema, while string length limits are enforced by runtime truncation. Non-TUI hosts (RPC, print) fall back to sequential `select`/`input` dialogs. The tool removes itself in child sessions where `ctx.hasUI` is false.

- `PI_ASK_USER_QUESTION=off` — do not register the tool.
- `/ask` previews the dialog with a demo questionnaire.

### `subagent-log-guard/` — stderr guard

`pi-subagents` prints launch diagnostics such as `[pi-subagents] Agent 'researcher': host runtime tool availability omitted [...]` with `console.warn`. In interactive mode pi does not take over stdout/stderr, so that text is written straight into the alternate screen at the hardware cursor — right on top of the editor row — and the differential renderer will not repaint it. The result is permanent garbage across the input box.

This extension wraps `process.stderr.write` in processes that have a UI and stops lines beginning with `[pi-subagents]` from reaching the terminal. Only that prefix is filtered; everything else writes through untouched. Processes without a UI (RPC, print, subagent runners) are not patched at all, which is why background subagent diagnostics still land in `runner.stderr.log`.

- `PI_SUBAGENT_LOG_GUARD=notify` — route the messages through `ctx.ui.notify(..., "warning")` instead of dropping them.
- `PI_SUBAGENT_LOG_GUARD=off` — remove the guard (useful when tracing who printed a line).

## Extension interactions

- **Esc Esc is shared.** `rewind` replaces pi's built-in double-Escape action and needs `doubleEscapeAction: "none"`; see above.
- **The `bash` tool can only be registered once.** Everything that shapes its rendering lives in `bash-command-collapse.ts` for that reason — a second file registering `bash` would be ignored silently.
- **`recap` imports `simple-task/gap.ts`.** The neighbour-gap heuristic is shared rather than duplicated, so `recap` and `simple-task` must be installed together. In this package they always are; if you copy extensions individually, copy both.
- **The theme preview and the theme files are coupled.** `/theme` persists the name it previewed, and the name must match the `theme` field's expectations in [themes.md](themes.md).
- **Three extensions read theme tokens that pi's schema does not define** (`toolDiffAddedBg`, `toolDiffRemovedBg`, `bashOutput`) and degrade quietly when a theme omits them.

## State on disk

| Location | Written by | Contents |
| --- | --- | --- |
| `~/.pi/agent/settings.json` | `auto-default-model` | `defaultProvider` / `defaultModel` on every model switch. |
| `~/.pi/agent/rewind/<project-hash>/git` | `rewind` | Shadow git repository with pre-turn snapshots. Never touched by your repository. |
| `~/.pi/folder-history/<path-with-dashes>.jsonl` | `folder-history` | Command history per working directory. |
| Session log (via `appendEntry`) | `simple-task` | Task list state; discarded with the session, never written to the repo. |
| In memory only | `recap` | The current summary; lost on `/new` or `/resume` by design. |
| Nothing | everything else | The remaining extensions are pure display or event wiring. |

## Adding, disabling and removing extensions

- **Disable one** — `pi config` lists every resource from packages and local directories with an on/off toggle, in global or project scope. Or set the switch listed above when the extension has one.
- **Remove one** — delete its file (or its directory) from the package, or copy the ones you want into `~/.pi/agent/extensions/` and stop installing the package. Deleting subdirectories is safe except for the two helper pairs: `thinking-collapse/`, `tool-diff/` and `simple-task/` are imported by other files.
- **Edit one** — work in a checkout and run pi against it; see [development.md](development.md).
