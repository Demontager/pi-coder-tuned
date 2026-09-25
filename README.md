# pi-coder-tuned

**English-first Pi extensions, tuned for local models.**

A fork of [jayli/pi-coder](https://github.com/jayli/pi-coder), based on upstream
2.1.3 (`d68d965`). Includes **29 extensions and 3 themes**, with English UI,
cache-safe local recaps, and exact context-token counts. Original authorship
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
| Context display | `Ctx 2.9%` | `Ctx 7,602/262,144 2.9%` |
| Outside Git | `ᗌ no git \| (no git)` | Both empty Git segments omitted |
| Inside Git | Branch and added/deleted line counts | Retained |
| Task lists | Model-driven `task_set` / `task_update` | Retained; not automatically forced |
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

### Exact context counts

```text
⚡️ cyber-tiel-35b-a3b/max | Ctx 7,602/262,144 2.9%
```

Counts come from Pi's reported context usage, not inference from the percentage.
Unknown values display `?`. The configured context capacity is not free memory;
it is the model's context window. Existing warning/error colors and width-aware
footer truncation remain in place.

## Included functionality

- Collapsed Bash/read output, edit/write diffs, thinking display, working indicator.
- Task list tools, question dialogs, plan mode, shadow-Git rewind checkpoints.
- MCP integration, model-default persistence, prompt history, theme selection.
- Destructive-action guard, sandbox boundary, verification gate and `/goal`.
- Three upstream themes, retaining their original names for compatibility.

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
