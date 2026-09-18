# @bachi/pi-coder

A complete [Pi](https://pi.dev) coding-agent environment packaged for npm: **22 extensions**, **3 themes**, and the global config files that make them work together.

This is a working setup, not a collection of demos. Every extension is used daily: the statusline, the diff renderer, the task list, the checkpointer and the rest were written to fix specific annoyances, and each one documents the pi internals it depends on in its own file header.

## Install

```bash
pi install npm:@bachi/pi-coder
```

Extensions and themes are loaded straight from the package (see the `pi` manifest in `package.json`) — there is nothing to configure. Restart pi, then check `pi list` or run `pi config` to see every resource with its enable/disable toggle.

The two companion packages this environment is built around are separate installs:

```bash
pi install npm:pi-web-access   # pi_web_search / fetch_content / source_check / get_search_content
pi install npm:pi-subagents    # subagent / bg_wait / scripted workflows
```

They are deliberately not bundled: they are heavy, they have their own release cycles, and pi-subagents needs `settings.json` entries that only make sense once it is installed.

### Global config files

Four files in [`config/`](config) are not package resources — pi reads them from `~/.pi/agent/`, so copy the ones you want by hand. pi installs the package under `~/.pi/agent/npm/node_modules/@bachi/pi-coder` (project installs go to `.pi/npm/node_modules/`):

```bash
PKG=~/.pi/agent/npm/node_modules/@bachi/pi-coder

cp "$PKG/config/AGENTS.md"          ~/.pi/agent/AGENTS.md          # global working rules
cp "$PKG/config/settings.json"      ~/.pi/agent/settings.json      # read this first!
cp "$PKG/config/web-search.json"    ~/.pi/agent/web-search.json    # required by pi-web-access
mkdir -p ~/.pi/agent/themes
cp "$PKG/themes/"*.json             ~/.pi/agent/themes/            # optional: also shipped as a package theme
```

**Read [`config/settings.json`](config/settings.json) before copying it.** It overwrites your settings wholesale, and two of its entries are machine-specific:

- `npmCommand` pins `pnpm --config.node-linker=hoisted`. Remove it if you do not have pnpm, or `pi install` will fail.
- `doubleEscapeAction: "none"` hands Esc-Esc to the `rewind` extension instead of pi's built-in tree navigator.

`config/models.json` is **not** shipped: provider and model registrations point at a local gateway and belong to the machine that runs it. See [docs/configuration.md](docs/configuration.md).

## What you get

### Extensions

| Extension | What it does |
| --- | --- |
| [`bash-command-collapse.ts`](extensions/bash-command-collapse.ts) | Overrides `bash`: long commands collapse to N visual lines with a `… (N tokens hidden)` hint, hard-wrap at the column budget, shell syntax highlighting, and its own background box. |
| [`read-path-collapse.ts`](extensions/read-path-collapse.ts) | Overrides `read`'s title row: long paths stay on one line, ellipsis at the front, file name kept whole. |
| [`tool-diff.ts`](extensions/tool-diff.ts) | Overrides `edit`/`write`: Claude Code style full-line diff backgrounds, line-number gutter, inline and syntax highlighting. |
| [`thinking-collapse.ts`](extensions/thinking-collapse.ts) | Thinking blocks render as one continuous horizontally scrolling line labelled `Think: `. |
| [`prompt-editor.ts`](extensions/prompt-editor.ts) | A `❯ ` gutter in the editor, plus a blank line between the autocomplete list and the statusline. |
| [`fenceless-code-block/`](extensions/fenceless-code-block/) | Markdown code blocks lose their fences (syntax colors kept, no background added). |
| [`statusline/`](extensions/statusline/) | Replaces the footer: model/thinking level, context usage, git branch and diff stat, plus a second line for extension statuses. |
| [`startup-logo/`](extensions/startup-logo/) | Static header logo with version and shortened cwd, and prunes `[Context]`/`[Prompts]`/`[Themes]` from the startup list. |
| [`working-indicator/`](extensions/working-indicator/) | Semantic working message (`Tools Calling`, `Editing`, `Writing`, `Reading`, `Thinking`) with per-segment token counts and elapsed time. |
| [`simple-task/`](extensions/simple-task/) | Task list driven by `task_set` / `task_update` / `task_get` and `/tasks`; state rides the session log, never the repo. |
| [`recap/`](extensions/recap/) | `/recap`, plus an automatic summary above the editor after 30s of idling. |
| [`rewind/`](extensions/rewind/) | Shadow-git checkpoints and `/rewind` (or Esc Esc) to restore code and/or conversation. |
| [`ask-user-question/`](extensions/ask-user-question/) | An `ask_user_question` tool: up to 4 questions with 2–4 described options plus a free-text row, answered in the terminal. |
| [`auto-default-model/`](extensions/auto-default-model/) | Writes every model switch to `settings.json` — the Ctrl+S step, automated. |
| [`subagent-log-guard/`](extensions/subagent-log-guard/) | Stops `[pi-subagents]` stderr diagnostics from corrupting the TUI. |
| [`cwd-statusline.ts`](extensions/cwd-statusline.ts) | Prints the full working directory as a second statusline line. |
| [`below-editor-after-statusline.ts`](extensions/below-editor-after-statusline.ts) | Moves `belowEditor` widgets underneath the statusline. |
| [`folder-history.ts`](extensions/folder-history.ts) | Persists command history per working directory and injects it into the editor's native ↑/↓. |
| [`theme-command.ts`](extensions/theme-command.ts) | `/theme` with live preview: arrow keys preview, Enter persists, Esc cancels. |
| [`init-command.ts`](extensions/init-command.ts) | Claude Code style `/init`: update `CLAUDE.md`, else `AGENTS.md`, else create `AGENTS.md`. |
| [`clear-command.ts`](extensions/clear-command.ts) | `/clear` as an alias of `/new`. |
| [`exit-command.ts`](extensions/exit-command.ts) | `exit`, `quit` or `bye` on an otherwise empty prompt quits pi; `/exit` too. |

See [docs/extensions.md](docs/extensions.md) for commands, switches, caveats and the pi internals each extension relies on.

### Themes

`summer-night` (the default here), `catppuccin` and `ayu` — all three reference-only palettes with no literal colors in `colors`, plus two custom diff-background tokens that [`tool-diff.ts`](extensions/tool-diff.ts) reads. Details in [docs/themes.md](docs/themes.md).

### Commands

`/ask` `/bash-collapse` `/bash-preview` `/bash-stream` `/bash-timeout` `/bash-tree` `/clear` `/exit` `/init` `/read-collapse` `/recap` `/rewind` `/tasks` `/theme`

Esc Esc opens `/rewind` (requires `doubleEscapeAction: "none"`).

### Environment switches

Every switch is read from the environment, so they can be set per project or in a shell alias. `off` always disables, and an unset variable always means "on" unless noted.

| Variable | Default | Effect |
| --- | --- | --- |
| `PI_ASK_USER_QUESTION=off` | on | Do not register the `ask_user_question` tool. |
| `PI_AUTO_DEFAULT_MODEL=off` | on | Do not persist model switches to `settings.json`. |
| `PI_BASH_HIGHLIGHT=off` | on | Disable shell syntax highlighting in bash title rows. |
| `PI_BASH_MIN_TIME_MS` | `2000` | Only show the elapsed-time footer above this duration. |
| `PI_BASH_PREVIEW` | `3` | bash output preview lines (1–50); `off` restores pi's built-in. |
| `PI_BASH_SPINNER=off` | on | Disable the `●` spinner on running bash rows. |
| `PI_BASH_STREAM=on` | off | Use pi's native streaming for bash instead of the collapse path. |
| `PI_BASH_TREE=off` | on | Disable tree indentation (`│`/`└`) for bash output. |
| `PI_BELOW_EDITOR_AFTER_STATUSLINE=off` | on | Leave `belowEditor` widgets where pi puts them. |
| `PI_CWD_ICON` | ` 📁` | Icon used by `cwd-statusline`. |
| `PI_CWD_STATUSLINE=off` | on | Do not print the cwd status line. |
| `PI_EDITOR_AUTOCOMPLETE_GAP=off` | on | Do not add the blank line under the autocomplete list. |
| `PI_EDITOR_AUTOCOMPLETE_SHIFT` | `1` | Columns to shift the autocomplete list left. |
| `PI_EDITOR_PROMPT` | `❯` | Editor prompt character. |
| `PI_EXIT_WORDS` | `exit,quit,bye` | Comma-separated quit words; `off` disables the input interception. |
| `PI_FENCELESS_CODE=off` | on | Keep Markdown code fences. |
| `PI_FOLDER_HISTORY_INJECT` | `100` | History entries injected from previous sessions. |
| `PI_LOGO=off` | on | Do not install the startup header. |
| `PI_READ_COLLAPSE=off` | on | Keep pi's built-in `read` title row. |
| `PI_SPINNER_COLOR_HOLD` | `19` | Frames per color in the spinner cycle. |
| `PI_SPINNER_RAINBOW=off` | on | Disable the rainbow spinner. |
| `PI_STATUSLINE_FREEZE=off` | on | Disable the footer freeze that hides the one-frame flash on session switch. |
| `PI_SUBAGENT_LOG_GUARD` | `drop` | `notify` shows the diagnostics through `ctx.ui.notify`; `off` disables the guard. |
| `PI_WORKING_SUMMARY=off` | on | Disable the prompt summary line. |
| `PI_WORKING_SUMMARY_GAP` | `1` | Minimum blank columns between the working label and the summary. |
| `PI_WORKING_SUMMARY_LLM=off` | on | Truncate the summary instead of asking a model to compress it. |
| `PI_WORKING_SUMMARY_MODEL` | session model | `provider/modelId` used for the summary request. |
| `PI_WORKING_SUMMARY_TRIGGER` | `1.2` | Ask for a summary when the prompt exceeds this multiple of the available width. |

## Requirements

- pi **0.85.1** or newer (the extensions are written against this version's internals), Node **22.19+**.
- macOS or Linux. Nothing is Windows-specific, but it is untested there.
- Optional but assumed by a few extensions: `pi-web-access` (the web tools) and `pi-subagents` (subagent events, fleet status line).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/installation.md](docs/installation.md) | Install, verify, upgrade, uninstall, and the local-checkout workflow. |
| [docs/configuration.md](docs/configuration.md) | Every shipped config file, what was removed from the snapshot, and why. |
| [docs/extensions.md](docs/extensions.md) | Reference for all 22 extensions: commands, switches, caveats, storage. |
| [docs/themes.md](docs/themes.md) | Theme files, the custom tokens, and the rules that make them load. |
| [docs/development.md](docs/development.md) | Running the 436 unit tests, verifying against a real pi, publishing. |
| [docs/handbook.zh.md](docs/handbook.zh.md) | The original Chinese handbook this package was extracted from: the author's machine, gateway setup, and the full rationale behind every design decision. |

## Development

```bash
npm test        # node --test, 436 tests
```

The pure-logic modules are deliberately free of `@earendil-works/pi-*` imports so they run under plain `node --test`; see [docs/development.md](docs/development.md) for the layout rules, the verification procedure and the traps this codebase documents.

## License

MIT — see [LICENSE](LICENSE).
