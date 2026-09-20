# Themes

Three themes ship with this package: `pi-coder-summer-night` (the one `config/settings.json` selects), `pi-coder-catppuccin` and `pi-coder-ayu`. All three carry the `pi-coder-` prefix, so their names cannot collide with themes from another installed package. Before 2.0.0 they shipped as `summer-night`, `catppuccin` and `ayu`.

## Switching themes

Two ways, both with the same result:

- `/theme` — the picker from `theme-command.ts`. Arrow keys preview live, Enter persists to `settings.json`, Esc leaves settings untouched. `/theme pi-coder-summer-night` switches directly.
- `/settings` → Theme — pi's built-in path, which also mixes in the light/dark auto modes.

pi loads themes from three places:

```
~/.pi/agent/themes/*.json      # global
.pi/themes/*.json              # project, after the project is trusted
<package>/themes/*.json        # packages — this is how these three arrive
```

The copy commands in [installation.md](installation.md#apply-the-global-config-files) put them in the global directory as well; that is optional, since the package already provides them.

## The three themes

### `pi-coder-summer-night`

The author's own palette and the current default: a Tokyo Night blue base (`night` `#1a1b26`, `panel` `#16161e`, `select` `#2d2c5d`, `find` `#283457`) carrying foregrounds and line colors taken from [iceberg.vim](https://github.com/cocopon/iceberg.vim) — body text `#c6c8d1` (iceberg's `Normal`), `muted` `#818596` (`StatusLine`), `dim` and `Think:` rows `#6b7089` (`Comment`), plus `red` `#e27878`, `green` `#b4be82`, `yellow` `#e2a478`, `magenta` `#a093c7`, `teal` `#89b8c2` and `blue` `#84a0c6`. Against `night` that is roughly 10.2:1 for body text, 4.7:1 for `muted` and 3.5:1 for `dim` — dimmer than pi-coder-catppuccin, so comments and settings hints read faintly. If that is too faint, raise `vars.ui`, `vars.dimText` and `vars.ayuThinking` (the last two are separate variables holding the same grey).

The file has 40 `vars` and no literal color values: every entry in `colors` is a variable reference, `export` included (`panel` / `night` / `select`), and `text` points at `fg` rather than the terminal default. Variable names are not a reliable guide to what they hold — several still carry Tokyo Night's names while containing iceberg colors (`teal` holds a cyan, `moonLilac` another cyan, `ayuThinking` the same grey as `dim`). `bashOutput` is defined here too (`#818596`, its own variable), and `toolDiffAdded` points at `addedGreen` (`#8bc391`) rather than `teal` or `green` — the string color — so added-line numbers and the `+` column carry the conventional green: 7.83:1 on the `addedLine` background, and 4.96:1 for body text over the 30% inline tint `tool-diff.ts` lays down. It is no longer the same color as `success`, which stays `teal`. That slot is also what [`user-message-bar`](extensions.md#user-message-bar--the-user-message-box) paints its bar with.

### `pi-coder-catppuccin`

A port of Catppuccin Mocha from [bacnh85/pi-extensions](https://github.com/bacnh85/pi-extensions). The palette lives in `vars` (36 of them) and `colors` only references it. Two entries are empty strings meaning "terminal default": `text` and `syntaxVariable`. The upstream file's single 256-color index (`toolPendingBg: 233`) was converted to hex `#140e1e`, so all three themes in this package are free of integer color values — `bgAnsi()` emits `48;5;N` for an integer, which mixes poorly with a truecolor palette.

### `pi-coder-ayu`

A port of the official `ayu-dark` palette from [iodic/pi-ayu-themes](https://github.com/iodic/pi-ayu-themes), reformatted to the same four-section shape as `pi-coder-catppuccin.json` and with all 55 colors going through `vars`. Like `pi-coder-summer-night` — and unlike `pi-coder-catppuccin` — it defines `bashOutput`.

Four deliberate deviations from upstream:

1. **Strings vs. added diff lines.** Upstream points `syntaxString` (strings in code) and `toolDiffAdded` (the foreground of added diff lines, including line numbers and `+`) at the same green `#AAD94C`. Here `syntaxString` points at a darker `stringGreen` (`#67a567`) so code strings and diff additions do not glow identically; diff additions keep the upstream green. Side effect: the new green is close in luminance to `muted`, so strings and comments are told apart mostly by hue.
2. **Thinking borders.** Upstream paints `thinkingXhigh` red (`#D95757`). Here `thinkingXhigh` and `thinkingMax` are both a neutral grey (`#626262`), because the editor border takes the color of the current level and this setup defaults to `xhigh` — a red border reads as an error. The top two levels are now distinguished from each other only by luminance.
3. **Pending and finished tool cards are exchanged, and the pending value was re-tuned.** Upstream has `toolPendingBg: #10151F` (darker) and `toolSuccessBg: #171F24` (lighter); this file uses `#1f1f1f` for pending and `#10151F` for success, so a tool call that is still running gets the lighter background and a finished one the darker. The pending value then moved repeatedly (`#171F24` → `#191919` → `#1d1c1d` → `#1b1c1d` → `#1f1f1f`), and it is set by a variable of its own: only `toolPendingBg` changed, while `userMessageBg` / `customMessageBg` keep `#1b1c1d`. Nothing in the file explains the choice — it is a value inversion, not a renamed variable. Against its earlier value `#1b1c1d`, the slightly lighter card costs a tenth of text contrast: body 8.77:1 (was 9.08:1), `muted` 3.47:1 (3.59), `dim` 2.31:1 (2.39).
4. **User message text has a fixed color.** `userMessageText` points at `textColor` (`#dbdbdd`, a var added for it) rather than `fg`, the terminal's default foreground, so user messages read the same on any terminal.

## Anatomy of a theme file

```jsonc
{
  "$schema": "...",
  "name": "pi-coder-summer-night",     // must equal the file name (minus .json)
  "vars": { "panelBg": "#0e1622", ... },
  "colors": { "bg": "panelBg", ... },
  "export": { "pageBg": "panelBg", "cardBg": "bg", "infoBg": "infoBg" }
}
```

- Every non-`#` value in `colors` is looked up in `vars`. A missing reference throws `Variable reference not found`, **the whole theme fails to load**, and pi falls back to the built-in `dark` theme without an error message. This is the single most common way to break a theme.
- An empty string means "terminal default foreground" — used by `text` and, in pi-coder-catppuccin, `syntaxVariable`.
- `export` only affects HTML produced by `/export`; when it is missing, pi derives those colors from `userMessageBg`. In these files it is set explicitly, and through `vars` references like every other color.

## Custom tokens

Three tokens in these files are **not** part of pi's official theme schema:

| Token | Read by | Effect |
| --- | --- | --- |
| `toolDiffAddedBg` | `tool-diff.ts` | Full-line background of added diff lines. |
| `toolDiffRemovedBg` | `tool-diff.ts` | Full-line background of removed diff lines. |
| `bashOutput` | `bash-command-collapse.ts` | Foreground of bash output text only. |

All three themes define the two diff backgrounds. `pi-coder-ayu` and `pi-coder-summer-night` also define `bashOutput`.

### Why they work at all

Three things line up:

1. Theme validation uses TypeBox's `Compile().Check()`, which **allows unknown keys** — the `additionalProperties: false` in pi's `theme-schema.json` is not on the executed path.
2. `createTheme()` puts any color that is not one of the seven known background tokens into the `fgColors` table.
3. `getFgAnsi()` looks colors up **by key**, without checking the key against the union type. Since a background SGR is a foreground SGR with `38` replaced by `48`, an unknown token can be resolved and used as a background.

If pi ever validates strictly, these tokens stop resolving. Nothing breaks loudly: `tool-diff` silently falls back to the much flatter `toolSuccessBg` / `toolErrorBg`, and `bash-command-collapse` falls back to `toolOutput`.

### `bashOutput` in detail

pi's built-in bash renderer hardcodes output text to `toolOutput`, a slot shared by every tool (`read`, `grep`, `ls` all use it). To give bash output its own color, `bash-command-collapse.ts` temporarily swaps that one key in the module-level theme singleton while it delegates to the built-in renderer — the swap window must be synchronous, and it can only touch this one key.

The extension probes for the token by calling `getFgAnsi("bashOutput")` and does nothing if it throws `Unknown theme color: ...`. So:

- Themes without `bashOutput` (including pi's built-ins and `pi-coder-catppuccin`) are unaffected — bash output simply uses `toolOutput`.
- To split the color out for any theme, add one `vars` entry and one `colors` line, exactly as `pi-coder-ayu` does.
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
