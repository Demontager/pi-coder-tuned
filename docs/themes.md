# Themes

Three themes ship with this package: `summer-night` (the one `config/settings.json` selects), `catppuccin` and `ayu`.

## Switching themes

Two ways, both with the same result:

- `/theme` — the picker from `theme-command.ts`. Arrow keys preview live, Enter persists to `settings.json`, Esc leaves settings untouched. `/theme summer-night` switches directly.
- `/settings` → Theme — pi's built-in path, which also mixes in the light/dark auto modes.

pi loads themes from three places:

```
~/.pi/agent/themes/*.json      # global
.pi/themes/*.json              # project, after the project is trusted
<package>/themes/*.json        # packages — this is how these three arrive
```

The copy commands in [installation.md](installation.md#apply-the-global-config-files) put them in the global directory as well; that is optional, since the package already provides them.

## The three themes

### `summer-night`

The author's own palette and the current default: a near-black blue base with high-contrast accents. Body text sits at roughly 8.4–9.2:1 on panels. Its greys are deliberately dimmer than catppuccin's — `muted` around 3.3–3.8:1 and `dim` around 2.2–2.6:1 — so comments, `Think:` rows and settings hints read faintly. If that is too faint, raise `vars.muted` and `vars.dimmed`.

`text` is `""`, the terminal's own default foreground. Three values are literals rather than `vars` references: `syntaxComment` (`#95a1b0`), `thinkingXhigh` and `thinkingMax` (both `#4b7cc2`). The Chinese handbook still describes this file as having no literal colors — the file has since changed; trust the file.

### `catppuccin`

A port of Catppuccin Mocha from [bacnh85/pi-extensions](https://github.com/bacnh85/pi-extensions). The palette lives in `vars` (36 of them) and `colors` only references it. Two entries are empty strings meaning "terminal default": `text` and `syntaxVariable`. The upstream file's single 256-color index (`toolPendingBg: 233`) was converted to hex `#140e1e`, so all three themes in this package are free of integer color values — `bgAnsi()` emits `48;5;N` for an integer, which mixes poorly with a truecolor palette.

### `ayu`

A port of the official `ayu-dark` palette from [iodic/pi-ayu-themes](https://github.com/iodic/pi-ayu-themes), reformatted to the same four-section shape as `catppuccin.json` and with all 55 colors going through `vars`. It is the only theme here that defines `bashOutput` (see below).

Two deliberate deviations from upstream, both documented in the file's own comments:

1. **Strings vs. added diff lines.** Upstream points `syntaxString` (strings in code) and `toolDiffAdded` (the foreground of added diff lines, including line numbers and `+`) at the same green `#AAD94C`. Here `syntaxString` points at a darker `stringGreen` (`#67a567`) so code strings and diff additions do not glow identically; diff additions keep the upstream green. Side effect: the new green is close in luminance to `muted`, so strings and comments are told apart mostly by hue.
2. **Thinking borders.** Upstream paints `thinkingXhigh` red (`#D95757`). Here `thinkingXhigh` and `thinkingMax` are both a neutral grey (`#626262`), because the editor border takes the color of the current level and this setup defaults to `xhigh` — a red border reads as an error. The top two levels are now distinguished from each other only by luminance.

## Anatomy of a theme file

```jsonc
{
  "$schema": "...",
  "name": "summer-night",     // must equal the file name (minus .json)
  "vars": { "panelBg": "#0e1622", ... },
  "colors": { "bg": "panelBg", ... },
  "export": { "pageBg": "panelBg", "cardBg": "bg", "infoBg": "infoBg" }
}
```

- Every non-`#` value in `colors` is looked up in `vars`. A missing reference throws `Variable reference not found`, **the whole theme fails to load**, and pi falls back to the built-in `dark` theme without an error message. This is the single most common way to break a theme.
- An empty string means "terminal default foreground" — used by `text` and, in catppuccin, `syntaxVariable`.
- `export` only affects HTML produced by `/export`; when it is missing, pi derives those colors from `userMessageBg`. In these files it is set explicitly (and `summer-night` uses literal hex there).

## Custom tokens

Three tokens in these files are **not** part of pi's official theme schema:

| Token | Read by | Effect |
| --- | --- | --- |
| `toolDiffAddedBg` | `tool-diff.ts` | Full-line background of added diff lines. |
| `toolDiffRemovedBg` | `tool-diff.ts` | Full-line background of removed diff lines. |
| `bashOutput` | `bash-command-collapse.ts` | Foreground of bash output text only. |

All three themes define the two diff backgrounds. Only `ayu` defines `bashOutput`.

### Why they work at all

Three things line up:

1. Theme validation uses TypeBox's `Compile().Check()`, which **allows unknown keys** — the `additionalProperties: false` in pi's `theme-schema.json` is not on the executed path.
2. `createTheme()` puts any color that is not one of the seven known background tokens into the `fgColors` table.
3. `getFgAnsi()` looks colors up **by key**, without checking the key against the union type. Since a background SGR is a foreground SGR with `38` replaced by `48`, an unknown token can be resolved and used as a background.

If pi ever validates strictly, these tokens stop resolving. Nothing breaks loudly: `tool-diff` silently falls back to the much flatter `toolSuccessBg` / `toolErrorBg`, and `bash-command-collapse` falls back to `toolOutput`.

### `bashOutput` in detail

pi's built-in bash renderer hardcodes output text to `toolOutput`, a slot shared by every tool (`read`, `grep`, `ls` all use it). To give bash output its own color, `bash-command-collapse.ts` temporarily swaps that one key in the module-level theme singleton while it delegates to the built-in renderer — the swap window must be synchronous, and it can only touch this one key.

The extension probes for the token by calling `getFgAnsi("bashOutput")` and does nothing if it throws `Unknown theme color: ...`. So:

- Themes without `bashOutput` (including pi's built-ins, `summer-night` and `catppuccin`) are unaffected — bash output simply uses `toolOutput`.
- To split the color out for any theme, add one `vars` entry and one `colors` line, exactly as `ayu` does.
- `bashOutput` does not appear in the `/theme` preview swatches, which only draw pi's standard token list.

## Editing or porting a theme

Renaming a theme means changing **three** places: the file name, the `name` field inside it, and `theme` in `settings.json`. `loadThemeJson()` resolves `${name}.json`, so a mismatch shows the old name in the picker or leaves `theme` pointing at nothing. If the theme lives in `~/.pi/agent/themes/`, only the file name and `name` field matter; pi matches the setting by name.

A theme cannot verify itself. `toolDiffAddedBg` misspelled is silently ignored, and a bad `vars` reference silently drops you to `dark`. After writing a theme, at minimum:

```js
// parse with pi's own loader and resolve every token
validateThemeJson(path, themeJson)
const theme = loadThemeFromPath(path, "truecolor")   // and "256color"
for (const key of Object.keys(colors)) {
  theme.getFgAnsi(key); theme.getBgAnsi(key)   // throws on a missing vars reference
}
```

If you are porting an upstream theme, parse both files and compare `getFgAnsi()` / `getBgAnsi()` per token name. Identical values mean a faithful port; a difference is either an oversight or a deviation that belongs in a comment.
