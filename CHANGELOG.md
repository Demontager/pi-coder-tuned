# Changelog

All notable changes to this package. The extensions themselves are snapshot copies from the author's pi environment; their individual histories live in that repository.

## 2.0.0 — 2026-09-19

Snapshot sync: the three themes were renamed with a `pi-coder-` prefix, so their names cannot collide with themes from another installed package.

### Changed

- **`themes/`** — `summer-night.json`, `catppuccin.json` and `ayu.json` became `pi-coder-summer-night.json`, `pi-coder-catppuccin.json` and `pi-coder-ayu.json`; each file's `name` field followed, and `config/settings.json` now selects `pi-coder-summer-night`.
- Theme names resolve through the `name` field, not the file name, so **an installed `settings.json` that still says `"theme": "summer-night"` silently falls back to pi's built-in `dark`** until it is updated — `/theme` writes the new value. That is why this is a major release.
- References updated: the comments in `bash-command-collapse.ts`, `read-path-collapse.ts`, `tool-diff.ts`, `working-indicator/index.ts`, `working-indicator/spinner-frames.ts` and `spinner-frames.test.ts`, plus [README](README.md), [docs/themes.md](docs/themes.md), [docs/configuration.md](docs/configuration.md), [docs/development.md](docs/development.md) and [docs/handbook.zh.md](docs/handbook.zh.md). Palette names (`ayu-dark`, Catppuccin Mocha, Ayu) are untouched.

### Unchanged

- No color value moved: the three theme files are byte-identical to 1.1.1 apart from the `name` field, and the extension sources differ only in those comment lines.
- The test suite stays at 596 tests.

## 1.1.1 — 2026-09-19

Snapshot sync: the bash and read display toggles were cut back to a fixed default plus environment variables.

### Changed

- **`bash-command-collapse.ts`** — folding is always on and always keeps 3 visual lines. The `/bash-collapse` command is gone (it switched folding off and also set the line budget), and with it the `enabled` / `maxLines` variables and the cache-key fields they fed. `ctrl+o` still expands the command in full.
- **`bash-command-collapse.ts`** — tree indentation and streaming lost their commands as well (`/bash-tree`, `/bash-stream`); both are now read-only startup switches (`PI_BASH_TREE=off`, `PI_BASH_STREAM=on`), so their mutable state became `const`. `/bash-preview` and `/bash-timeout` are the only commands this extension still registers.
- **`read-path-collapse.ts`** — `/read-collapse` removed; `PI_READ_COLLAPSE=off` is now the only way to keep pi's built-in title row. The startup default is unchanged.
- Documentation resynced to match: the command list in [README](README.md), the command table and both tool sections in [docs/extensions.md](docs/extensions.md), the post-install checklist in [docs/installation.md](docs/installation.md), and the one stale `/bash-stream on` sentence in [docs/handbook.zh.md](docs/handbook.zh.md).

### Unchanged

- Defaults before and after this sync are identical: folding on at 3 lines, tree indentation on, streaming off, `read` path collapse on.
- The test suite stays at 596 tests; the removed command handlers were not covered.

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
