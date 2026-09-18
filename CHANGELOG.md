# Changelog

All notable changes to this package. The extensions themselves are snapshot copies from the author's pi environment; their individual histories live in that repository.

## 1.1.0 — 2026-09-18

Snapshot sync: the environment gained an MCP client and a startup fix for pi's built-in footer, and the `ayu` theme was resynced.

### Added

- **`mcp/`** — MCP servers registered directly as pi tools (`mcp__<server>__<tool>`, Claude Code's naming). Config follows Claude Code's `.mcp.json` shape: global `~/.pi/agent/mcp.json` plus the nearest project `.mcp.json`. Three transports, implemented without `@modelcontextprotocol/sdk`: stdio, streamable HTTP and legacy HTTP+SSE. `${VAR}` / `${VAR:-default}` expansion, and `headersCommand` (aliases `headersHelper` / `http_headers_helper`) for dynamic auth headers. Commands: `/mcp`, `/mcp reload`, `/mcp <server>`. Diagnostics stay in an in-memory ring buffer rather than on stderr.
- **`statusline/footer-suppress.ts`** — pi's built-in footer is patched to render zero lines during the boot window, so it no longer paints its default state line before this statusline is installed. `PI_STATUSLINE_BOOT_SUPPRESS=off` disables it.
- Two `ayu` captures in the README, and a `pi.image` gallery preview in `package.json`.

### Changed

- `themes/ayu.json` resynced: `userMessageText` now points at a new `textColor` var (`#dbdbdd`), and `toolPendingBg` now matches `userMessageBg` (`#1b1c1d`).
- The suite grows from **454 to 596 tests**.

### Not included

- `config/mcp.json` — the snapshot's entries hold absolute paths of local MCP server executables, the same class of machine-specific value as `models.json`'s gateway registrations. `config/models.json` and the three model-selection keys in `config/settings.json` remain out as well.

## 1.0.0 — 2026-09-18

First release. A complete pi coding-agent environment packaged for npm.

### Added

- **22 extensions** under `extensions/`, copied verbatim from the author's `~/.pi/agent/extensions/`:
  - Tool rendering: `bash-command-collapse.ts`, `read-path-collapse.ts`, `tool-diff.ts`, `thinking-collapse.ts`, `fenceless-code-block/`
  - TUI chrome: `statusline/`, `cwd-statusline.ts`, `startup-logo/`, `below-editor-after-statusline.ts`, `prompt-editor.ts`, `working-indicator/`
  - Workflow: `simple-task/`, `recap/`, `rewind/`, `init-command.ts`, `theme-command.ts`, `folder-history.ts`, `clear-command.ts`, `exit-command.ts`
  - Model and tooling: `auto-default-model/`, `ask-user-question/`, `subagent-log-guard/`
- **3 themes** under `themes/`: `summer-night` (default), `catppuccin`, `ayu` — including the two custom diff-background tokens and `bashOutput`.
- **Global config files** under `config/`: `AGENTS.md`, `settings.json`, `web-search.json`, `pi-statusline.json`.
- **454 unit tests** runnable with `npm test`, plus the pure-logic module split that makes them possible.
- English documentation: [installation](docs/installation.md), [configuration](docs/configuration.md), [extensions](docs/extensions.md), [themes](docs/themes.md), [development](docs/development.md).
- The original Chinese handbook, kept verbatim as [docs/handbook.zh.md](docs/handbook.zh.md).

### Not included

- `config/models.json`, and the `defaultProvider` / `defaultModel` / `modelThinkingLevels` keys in `config/settings.json`. Provider registrations point at a local gateway and are machine-specific.
