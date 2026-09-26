# pi-coder-tuned

**English-first Pi extensions, tuned for local models.**

<img width="1490" height="911" alt="sample_window" src="https://github.com/user-attachments/assets/976c2eb1-d0c7-40c6-ad5f-7a7df7a5edc1" />

Live Demo
[pi-coder-tuned_live.webm](https://github.com/user-attachments/assets/3f17ee89-7a3b-4f03-95f3-e336234d0dfe)


A fork of [jayli/pi-coder](https://github.com/jayli/pi-coder), based on upstream
2.1.3 (`d68d965`). Includes **30 extensions and 3 themes**, with English UI,
cache-safe local recaps, turn timing, and compact context-token counts. Original authorship
and MIT license are preserved.

## Install from GitHub

```bash
pi install git:github.com/Demontager/pi-coder-tuned
```

Restart Pi, then use `/theme` to choose `pi-coder-ayu`, `pi-coder-catppuccin`, or
`pi-coder-1337`. No npm publication, startup translation step, or machine-local
patches are required. Each extension remains individually selectable in `pi config`.

```bash
pi update --extensions
```

An unpinned Git install tracks the repository's default branch. A tag or commit
can be pinned by appending `@REF`; pinned refs do not move during updates.

### Switching from upstream or the earlier local wrappers

```bash
pi remove npm:@bachi/pi-coder
pi install git:github.com/Demontager/pi-coder-tuned
```

If you used our earlier machine-local setup, remove the `local/recap-guard/index.ts`
and `local/pi-coder-english/index.ts` entries from the `extensions` array in
`~/.pi/agent/settings.json`. Do not load the fork alongside upstream or these
wrappers: they register the same tools and commands. Keep your model settings,
authentication, session history, and selected theme.

## What is tuned?

| Feature | Upstream 2.1.3 | pi-coder-tuned |
|---|---|---|
| UI and extension instructions | Mixed English and Chinese | English production labels/messages and instructions |
| Local recap | Separate model completion after idle | Excerpt from the existing response; no recap inference request |
| Remote recap | Chinese output requested | English output requested |
| Context display | `Ctx 2.9%` | `Ctx 8k/262k 2.9%` |
| Outside Git | `ᗌ no git \| (no git)` | Both empty Git segments omitted |
| Inside Git | Branch and added/deleted line counts | Retained |
| Task lists | Model-driven `task_set` / `task_update` | Retained; not automatically forced |
| Completed-turn counter | No final timing widget | Elapsed time and tool-call count before the recap |
| Safety dialogs | Original decisions and mixed-language labels | Same decisions, English labels |

### English interface

The initial translation covers **530 Chinese string literals** across deletion
confirmations, plan approval, theme menus, MCP diagnostics, `/init`, `/goal`, and
verification messages. It preserves user text, filenames, and multilingual input
recognition. Original comments, test fixtures, and the historical Chinese handbook
remain available; this is UI localization, not a translation of every repository file.

### Recaps without disrupting local KV cache

Single-slot llama.cpp servers (`--parallel 1`) share one conversation cache. A
separate short recap request can replace its cached prefix, making the next long
prompt require a full prefill again.

This fork instead extracts up to **120 characters** from the latest completed
assistant response for local models. It skips thinking/tool-call blocks and code
fences. Code-only answers get an English placeholder. It reuses upstream's
**10-second idle timer**, subagent wait logic, cancellation, widget layout, and
idempotent `/recap` command. No recap authentication lookup, inference request,
session entry, or context mutation occurs in extraction mode.

| `PI_RECAP_MODE` | Behavior |
|---|---|
| unset / `auto` | Extract for `llama-local` or loopback URLs; generate for other providers |
| `extract` | Request-free extraction for every provider, including a LAN inference server |
| `model` | Explicitly use model-generated recaps, including for local endpoints |

Example for a server on another machine:

```bash
PI_RECAP_MODE=extract pi
```

An extracted recap is an **excerpt, not an LLM summary or translation**. It uses
the response's language. Remote generated recaps receive an English instruction.
The cache guarantee applies to recap: other extensions, such as working-indicator's
prompt summary and `/goal` evaluation, can still make their own model requests.

### Compact context counts

```text
⚡️ cyber-tiel-35b-a3b/max | Ctx 8k/262k 2.9%
```

Counts come from Pi's reported context usage, not inference from the percentage.
Values of 1,000 or more are rounded to the nearest thousand using decimal `k`:
7,490 becomes `7k`, 7,500 becomes `8k`, and 262,144 becomes `262k`.
Smaller counts remain whole numbers. The percentage is calculated independently
from the unrounded usage and retains one decimal place.
Unknown values display `?`. The configured context capacity is not free memory;
it is the model's context window. Existing warning/error colors and width-aware
footer truncation remain in place.

### Completed-turn counter

[`stop-hook.ts`](extensions/stop-hook.ts) automatically shows a result above the
editor as soon as the agent finishes, before the delayed recap:

```text
✦ Crafted in 2m 14s. Used 12 tool calls.

✦ Recap: Built and verified the CLI…
```

Each completed run randomly chooses **Done, Cooked, Brewed, Built, Baked, or
Crafted**. The label stays fixed when the screen redraws. Timing starts at prompt
submission and ends at Pi's final `agent_settled` event, including tool execution,
confirmation waits, retries, and compaction. Steering and queued follow-ups are
included in the same measurement until Pi settles. The count includes all tool
execution starts (including failed attempts); a Bash call counts once regardless
of how many shell commands it contains. Background subagents' internal calls are
not counted. Interrupted or failed model runs use `Interrupted` or `Failed`.

The widget clears on the next prompt or session change. It makes no model requests
and adds nothing to model context. It is bundled automatically; no `-e` flag or
`PI_TURN_COUNTER_WORD` variable is needed. Disable it individually in `pi config`.
If you tested the standalone prototype, remove
`~/.pi/agent/extensions/turn-counter.ts` and stop passing its `-e` option when
switching to this bundled version: Pi auto-discovers personal extensions too.

## Included functionality

### Extensions

| Extension | What it does |
|---|---|
| [`bash-command-collapse.ts`](extensions/bash-command-collapse.ts) | Compact Bash commands and tree-shaped output, with success/error indicators. |
| [`read-path-collapse.ts`](extensions/read-path-collapse.ts) | Compact read results and width-aware file paths. |
| [`tool-diff.ts`](extensions/tool-diff.ts) | Full-line edit/write diffs with line numbers and syntax highlighting. |
| [`thinking-collapse.ts`](extensions/thinking-collapse.ts) | Compact, horizontally scrolling thinking blocks. |
| [`user-message-bar/`](extensions/user-message-bar/) | Accent-colored bars beside user messages. |
| [`prompt-editor.ts`](extensions/prompt-editor.ts) | Prompt gutter, Bash mode, and autocomplete spacing. |
| [`fenceless-code-block/`](extensions/fenceless-code-block/) | Syntax-highlighted code blocks without visible fences. |
| [`statusline/`](extensions/statusline/) | Model, compact context counts, Git information, and extension statuses. |
| [`startup-logo/`](extensions/startup-logo/) | Startup logo, Pi version, and working directory. |
| [`working-indicator/`](extensions/working-indicator/) | Live activity labels, token estimates, and elapsed time. |
| [`stop-hook.ts`](extensions/stop-hook.ts) | Completed-run duration and tool-call count, with a random label before the recap. |
| [`simple-task/`](extensions/simple-task/) | Model-driven task lists and `/tasks`. |
| [`recap/`](extensions/recap/) | `/recap` and delayed idle recaps; request-free excerpts for local models. |
| [`rewind/`](extensions/rewind/) | Shadow-Git checkpoints and `/rewind`. |
| [`ask-user-question/`](extensions/ask-user-question/) | Structured questions answered in the terminal. |
| [`mcp/`](extensions/mcp/) | MCP server tools and `/mcp` diagnostics. |
| [`auto-default-model/`](extensions/auto-default-model/) | Persists model selection in settings. |
| [`subagent-log-guard/`](extensions/subagent-log-guard/) | Keeps subagent diagnostics from disrupting the TUI. |
| [`cwd-statusline.ts`](extensions/cwd-statusline.ts) | Working directory in the statusline. |
| [`below-editor-after-statusline.ts`](extensions/below-editor-after-statusline.ts) | Places below-editor widgets under the statusline. |
| [`folder-history.ts`](extensions/folder-history.ts) | Per-directory prompt history. |
| [`theme-command.ts`](extensions/theme-command.ts) | Theme selection with live preview. |
| [`plan-mode/`](extensions/plan-mode/) | Read-only planning, plan approval, and permission modes. |
| [`core-rules/`](extensions/core-rules/) | Refreshes distilled global rules in context when needed. |
| [`verify-loop/`](extensions/verify-loop/) | Verification checks after changes and `/goal` continuation. |
| [`sandbox-boundary/`](extensions/sandbox-boundary/) | Shared deletion boundary; macOS seatbelt integration. |
| [`destructive-guard/`](extensions/destructive-guard/) | Checks destructive operations and requests confirmation when enabled. |
| [`init-command.ts`](extensions/init-command.ts) | Creates or updates project instructions with `/init`. |
| [`clear-command.ts`](extensions/clear-command.ts) | `/clear` alias for `/new`. |
| [`exit-command.ts`](extensions/exit-command.ts) | `/exit` and plain exit/quit/bye prompts. |

### Themes and companions

- Collapsed Bash/read output, edit/write diffs, thinking display, working indicator.
- Task list tools, question dialogs, plan mode, shadow-Git rewind checkpoints.
- MCP integration, model-default persistence, prompt history, theme selection.
- Destructive-action guard, sandbox boundary, verification gate and `/goal`.
- Three upstream themes, retaining their original names for compatibility.

The package `assets/`, `config/`, and `themes/` directories also contain short English
README files so GitHub's file browser explains their purpose directly.

Optional companions are installed separately:

```bash
pi install npm:pi-web-access
pi install npm:pi-subagents
```

Neither is required for the request-free recap path. See [the extension reference](docs/extensions.md)
for individual commands and switches.

## Requirements and configuration

Validated against **Pi 0.87.1**. Upstream's stated baseline is Pi 0.85.1+ and
Node 22.19+; older Pi versions and Windows have not been validated for this fork.
The macOS seatbelt boundary remains macOS-only; it is not a Linux kernel sandbox.

Installation loads extensions and themes. It does not overwrite your global
settings or install models, credentials, MCP servers, or skills. The files under
`config/` are optional upstream reference configurations, not a recommended
wholesale replacement for an existing setup. In particular, inspect their
package manager, package list, and watchdog settings before adopting them.

## Development and upstream updates

```bash
npm install --omit=peer
npm run check:english
npm test
```

Pi-dependent tests require an importable Pi library. If discovery cannot locate
it, set `PI_TEST_PI_ENTRY=/absolute/path/to/pi-coding-agent/dist/index.js`.
Those tests explicitly skip if Pi is absent. OS-dependent tests skip on unsupported
platforms. See [tuned development notes](docs/tuned-development.md).

Translations are committed directly to source. Maintainers merging upstream
can extend `tools/english-catalog.json` and run `npm run localize`, then review
the diff and test. There is no runtime dependency on the original package and
no translation compiler running on users' machines.

## Credits and license

Original project: **jayli / @bachi**, [pi-coder](https://github.com/jayli/pi-coder).
Fork maintained at [Demontager/pi-coder-tuned](https://github.com/Demontager/pi-coder-tuned).
Built for [Pi](https://github.com/earendil-works/pi). MIT; see [LICENSE](LICENSE).
This is an independent fork, not an official upstream release.
