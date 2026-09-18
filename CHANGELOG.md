# Changelog

All notable changes to this package. The extensions themselves are snapshot copies from the author's pi environment; their individual histories live in that repository.

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
- **436 unit tests** runnable with `npm test`, plus the pure-logic module split that makes them possible.
- English documentation: [installation](docs/installation.md), [configuration](docs/configuration.md), [extensions](docs/extensions.md), [themes](docs/themes.md), [development](docs/development.md).
- The original Chinese handbook, kept verbatim as [docs/handbook.zh.md](docs/handbook.zh.md).

### Not included

- `config/models.json`, and the `defaultProvider` / `defaultModel` / `modelThinkingLevels` keys in `config/settings.json`. Provider registrations point at a local gateway and are machine-specific.
