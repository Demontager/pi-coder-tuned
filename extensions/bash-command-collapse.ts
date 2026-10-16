/**
 * Bash Command Collapse Extension
 *
 * Reshapes the display of bash tool calls to the form the user specified on 2026-09-21: at most two
 * lines for the command (`Run ` prefix, overflow at end of line becomes a single `…`), and the result
 * hangs under the same tree (`│ ` continuation, `└ ` appears exactly once). Purely a display layer:
 * the tool-call arguments sent to the model and the raw text in the session record are unchanged.
 *
 * ## Target shape (sample provided by the user)
 *
 * `Run ` replaces pi's built-in `$ `; the command gets at most **2 visual lines**, and line 2 **only
 * replaces its tail with `…` no matter how much overflows** (never advances to a 3rd line); when the
 * command itself is longer, a `… +N lines` marker is added under line 2. Both lines start aligned to
 * the `n` column of `Run ` (column 3).
 *
 * ```
 * Run cd /Users/bachi/Library/pnpm/store/v11/links/@earendil-works/pi-cod
 *   ing-agent/0.86.0/5813aee6dbf81477902199f3db54e13ab115c8902b3ab00a
 *   … +1 lines
 * ```
 *
 * That is the **in-flight** shape: continuation lines and `… +N lines` use fixed-width space indent.
 * Once the command finishes, those lines' prefixes switch to `│ ` (the tree connects) and results
 * start hanging under `Run `:
 *
 * ```
 * Run cd /Users/bachi/Library/pnpm/store/v11/links/@earendil-works/pi-cod
 * │ ing-agent/0.86.0/5813aee6dbf81477902199f3db54e13ab115c8902b3ab00a
 * │ … +1 lines
 * │ … (20 earlier lines, ctrl+o to expand)
 * └ first substantive output line
 *   second output line
 *   Took 2.4s
 * ```
 *
 * `└ ` **appears exactly once**, on the **first substantive output line** — everything except the
 * truncation hint (`… (N earlier lines, ctrl+o to expand)`); content lines below it (further output,
 * warnings, the `Took Xs` footer, `(no output)` when there is none) all use fixed-width indent (`  `)
 * to align to the body column and draw no vertical bar — the tree "lands" at `└`. There is one space
 * between `└ ` and the body after it, supplied by `└ ` itself.
 *
 * **`│` / `└` are structural glyphs, not body text**: the whole tree's verticals and corners are
 * uniformly `muted`, each forming **its own SGR segment** (`styleCommandLine` closes the prefix's
 * color before the body, `prefixTreeLines` likewise colors only the prefix) — a prefix never
 * inherits the color of the token after it (a command continuation line can be followed by string /
 * path / comment tokens of any kind; the `│` on a path line once drifted along with the path color).
 *
 * **Only the word `Run` is bold** (`toolTitle` normal color + bold); the space after it and the
 * whole command body are not bold — bold is `\x1b[1m…\x1b[22m` and must hug that word; wrapping the
 * whole prefix would make the trailing gap look wider (see `styleCommandPrefix`).
 *
 * `Run ` (4 columns) is 2 columns wider than the old `$ ` (2 columns), so the first line's wrap
 * budget must be charged 4 columns — `renderCommandLines`' `firstRowBudget` and the continuation
 * indent are both computed live from `COMMAND_PROMPT` / `COMMAND_CHAIN`; no hardcoded numbers.
 *
 * ## Collapsed view: break-all hard wrap + end-of-line `…` + `… +N lines`
 *
 * The wrap rule is the CSS `word-break: break-all` model: fill grapheme by grapheme up to the
 * column budget, **break exactly when the next one does not fit**, wherever the break lands — word
 * or path middle alike. See `hardWrapRows`.
 *
 * Why not pi-tui's `wrapTextWithAnsi`: it is **greedy word wrap + hard split of overlong words** — a
 * word that does not fit the rest of the current line is **moved wholesale to the next line** and
 * then split. Measured on a 79-column terminal, `Run cp <78-col path>` rendered as `Run cp` alone on
 * a line plus the path split mid-string across two lines: dozens of columns wasted at line end (the
 * ugly "early wrap" look), and the command separated from its argument. Hard wrap fills every line.
 *
 * A third path was tried in between (commit 9024c26): no wrap at all — truncate the line tail to `…`
 * when it does not fit. It avoids early wrap, but a long command left only one visible line and lost
 * the rest; the current "2 lines + end `…` + `… +N lines`" is the compromise the user picked:
 * **no matter the overflow it only eats the last 1 line**, and the line count stays predictable.
 *
 * The line budget (`limit`, `DEFAULT_LINES = 2`) counts **visual lines**, not source lines: one
 * overlong single-line command fills the whole budget instead of painting a dozen rows, while a
 * multi-line command of short lines (heredocs etc.) still shows its first 2 source lines — neither
 * case runs away. The N in `… +N lines` counts **whole source lines** only (every source line not
 * reached after line 2 counts as 1, and fragments already wrapped but not placed count as 1 each) —
 * no token estimation; exact and checkable at a glance. The expanded state (ctrl+o) uses the same
 * hard-wrap rules, just without a line limit — the wrap rules must match, or expanded would show
 * "early wrap" again.
 *
 * Syntax highlighting (`styleCommandLine`) follows the wrap: token offsets are **source-line**
 * coordinates, and wrapped fragments carry their own start offset within the source line
 * (`WrappedRow.start`; the prefix does not participate in wrapping, so no conversion needed) — both
 * sides compare in the same coordinates and line up; without that offset, continuation lines'
 * colors would all shift.
 *
 * ## Output preview line count (pi hardcodes 5; changed here to 3)
 *
 * pi hardcodes the bash output preview at `const BASH_PREVIEW_LINES = 5` in
 * `core/tools/renderers/bash.js`: a module-private constant, not exported from the package, not in
 * `BashToolOptions`, and with no corresponding setting in `docs/settings.md` — **no global config to
 * change**, so it can only be post-processed in the extension (`withPreviewLimit` /
 * `trimPreviewLines`).
 *
 * The approach is post-processing pi's rendered component rather than rewriting the whole
 * resultRenderer, so all of pi's semantics survive (truncation-footer culling, warnings, `Took Xs`,
 * expanded state, images); only the preview section is touched. Two key points: ① **render child by
 * child** rather than taking the flattened line array (in a flat array you cannot tell which rows
 * are the preview); ② trimmed line counts must be folded into the hint line's count or "how many
 * lines were hidden" lies — when pi emitted a hint line, rewrite its number **in place** (preserving
 * pi's colors and the real key name); when pi did not (output ≤ 5 lines), build one ourselves,
 * otherwise those 1-2 lines silently disappear.
 *
 * The expanded state (ctrl+o) is automatically unaffected: pi then uses `new Text(...)` instead of
 * the preview component, the duck check skips it, and the full output is never trimmed.
 *
 * ## Output tree gutter (`│` continuations / a single `└`)
 *
 * When the command finishes, continuation lines switch from bare indent to `│ ` and results hang
 * under the same tree — command on top, output below, the hierarchy readable at a glance. `└ `
 * appears **once in the whole result**, on the first substantive output line (shape set by the user
 * on 2026-09-21: `└` no longer lands on the last line). Details and three non-obvious points are in
 * `prefixTreeLines`.
 *
 * Implemented inside `withPreviewLimit` (it already had to walk child by child to find "which child
 * is the output"; the gutter uses the same check). Three deliberate design decisions:
 *   ① **No gutter and no trimming in expanded state (ctrl+o)** — expanded means verbatim full output.
 *   ② **`└ ` must be applied once over all children's lines** (`prefixTreeLines(out)` called once at
 *     the end), not one tree per child: warnings / `Took` sections would grow another `└ ` and the
 *     screen would show two cornered content lines (observed in testing). Blank lines stay blank —
 *     except the `\n\n` before the failure status, see the next section.
 *   ③ The output section renders at `width - 2` (`GUTTER_WIDTH`) or adding the prefix overflows; other
 *     sections of the result (warnings / `Took`) are rendered by pi at full width and would stick out
 *     2 columns on wider terminals — a known cosmetic quirk, only visible with "overlong warnings +
 *     wide terminal" (short lines like `Took Xs` are unaffected).
 *
 * ## Failure status (`Command exited with code N` / ... timed out ... / ... aborted)
 *
 * Two things the user asked for on 2026-09-21: the notice should be error-colored, and the two blank
 * lines above it must not break the tree. Both have the same root cause: **pi welds the failure
 * status into the output body** — not a separate field, and `details` carries no marker
 * (`core/tools/bash.ts` throws `throw new Error(appendStatus(text, status))` in three places, and
 * `appendStatus` is `` `${text}\n\n${status}` `` — note its usual `text ? … : ""` ternary always
 * takes the "has text" branch here, because `formatOutput` already replaced empty output with
 * `(no output)`). The result body is `theme.fg("toolOutput", …)`ed line by line and joined, so:
 *   - the status line shares the output color (gray by default) — to turn it red it must be
 *     **recognized by text shape and recolored** (`isFailureStatusLine` + `colorizeFailureStatus`,
 *     done in `prefixTreeLines`, where the final line array already exists);
 *   - the `\n\n` before the status renders as **two blank lines** in collapsed state (`\n\n` → two
 *     empty lines), and sandwiched between preview and hint that is the "two-layer break" the user
 *     saw (invisible in expanded state because Text wraps). `trimPreviewLines` lifts the status
 *     together with the blank lines before it out for separate handling: the blanks are not drawn,
 *     and the status is treated as a line **guaranteed one slot** of the preview (otherwise it would
 *     be trimmed away — observed: with the status trimmed, the whole block shrank to one
 *     `│ … (N earlier lines)` plus two blank lines), then the status goes back at the tail. Blanks
 *     are lifted **contiguously**: trailing blank lines owned by the output itself
 *     (`printf "a\n\n\n"`) are eaten along too, or they would open the same break — trailing blank
 *     lines carry no information and the freed budget is better spent on real output lines.
 *
 * The resulting shape is "details follow the body, aligned with a two-cell indent", same family as
 * `Took` / warnings:
 *
 * ```
 * Run for f in a b; do echo "-- $f"; done; exit 2
 * └ -- a
 *   -- b
 *   Command exited with code 2      ← red (error slot)
 * ```
 *
 * **Both checks are required**: `context.isError` (this run really errored) + the whole line matching
 * one of the three shapes above. Shape alone would also redden the normal output of
 * `echo "Command exited with code 2"`, and would lift it as a status when it happens to sit at the
 * tail (the regression test watches exactly that); `isError` alone would redden the entire output body.
 *
 * ## Duration-footer threshold (short commands draw no `Took`)
 *
 * pi's built-in result renderer draws a `Took X.Xs` line at the end **unconditionally** (whenever
 * `state.startedAt` is set), and it is a **full-line footer**: for the vast majority of
 * tens-of-milliseconds commands it just wastes one row of height, plus an extra separator blank line
 * (the footer is `new Text("\n" + …)`, and that leading `\n` is the blank row between body and footer):
 *
 * ```
 * $ echo hello
 * └ hello
 *
 *  Took 0.1s
 * ```
 *
 * So for **short commands the whole footer is dropped** (including its separator blank line) — the
 * block becomes "command line + output + bottom boundary blank", wasting no row. The threshold
 * defaults to 2000ms (constant `DEFAULT_MIN_TIME_FOOTER_MS`); `PI_BASH_MIN_TIME_MS` changes it at
 * startup, and `0` = always show (disables the optimization).
 *
 * The check uses the **real duration** `endedAt - startedAt` (the same quantity pi prints), not the
 * footer's text — that text is `(ms / 1000).toFixed(1)`, rounded, so judging by it produces edge
 * cases like "shows 2.0s but actually ran 1.96s". The rule is hide when threshold >= elapsed, so any
 * number that can appear is necessarily >= 2.0s — a self-contradicting `Took 1.9s` cannot occur.
 *
 * In streaming mode (`PI_BASH_STREAM=on`) the `Elapsed X.Xs` during execution goes through the same
 * check (same footer, wording follows `isPartial`): short commands never flash that line, and it
 * appears only after 2s — exactly the "worth a glance" moment. In non-streaming (default) the check
 * runs once at end of execution, which is the semantics the user wanted.
 *
 * Implemented inside `withPreviewLimit` (it already renders child by child and already passes
 * warnings / `Took` through as "non-output children"); the check is `isTimeFooterChild`: last
 * position + text shape, both required.
 *
 * ## bash command syntax highlighting (lightweight)
 *
 * Command lines are colored by shell lexing: command name `syntaxFunction`, options `-x/--xxx`
 * `syntaxKeyword`, quoted strings and paths `syntaxString`, `$VAR`/`NAME=` assignments
 * `syntaxVariable`, `|`/`&&`/redirections `syntaxOperator`, `#` comments `syntaxComment`, and the
 * `Run ` prefix uses `toolTitle` (normal color, not dim). Colors go through the theme's `syntax*`
 * slots (same family as markdown code blocks), so they follow theme changes automatically. On by
 * default; `PI_BASH_HIGHLIGHT=off` returns to "whole line toolTitle bold" — deliberately **no**
 * `/bash-highlight` command: a pure visual toggle needs only the env entry point, not a slash command.
 *
 * Modeled on `@sting8k/pi-droid-styling`'s `tool-tags/bash.ts`, which is likewise a **hand-written
 * shell tokenizer** (`tokenizeShellLinePreservingText` + `colorShellWord`) and only falls back to
 * pi's exported `highlightCode(line, "bash")` when tokenization fails (unclosed quote). That
 * fallback path is not adopted here — `highlightCode` returns a **whole line with ANSI**, while this
 * extension's wrap is break-all hard wrap and must "wrap plain text first, color after" (doing it the
 * other way cuts SGR sequences in half — see the comment in renderCall); an ANSI-carrying line
 * cannot feed `hardWrapRows`. So a tokenization failure falls back to single-color bold instead of
 * a different highlighter.
 *
 * Alignment: token offsets are **source-line** coordinates; wrap fragments are **post-wrap**
 * coordinates and carry their own start offset — `styleCommandLine` converts both tokens and body to
 * source-line coordinates before comparing; the three steps of offset conversion (the fragment's own
 * `start`, subtracting head width from the 2nd fragment on, the line-end `…` going on plain text
 * only) are in `renderCommandLines`. Three points:
 *   ① When a token is cut in two by wrapping, both halves keep the same color — visually fine.
 *   ② Quote state persists **across source lines** (`openQuote`), so the second line of a multi-line
 *     string (`git commit -m "…\n…"`) is not re-tokenized as a command. Heredoc bodies get no such
 *     treatment (`<<EOF` is not a quote) and are colored as a command line — harmless, just imprecise.
 *   ③ Collapsed-away lines do not participate in coloring (they never enter the render path).
 *
 * ## Independent color for the output body (extension token `bashOutput`)
 *
 * pi's built-in bash result renderer hardcodes the output body as `theme.fg("toolOutput", line)` —
 * that is **the shared slot for all tool output** (read / grep / ls bodies and `…` placeholders all
 * eat it), so tuning bash output's color alone requires bypassing it. The trick: inside the
 * **synchronous window where we delegate to the built-in renderer**, temporarily point the theme's
 * `toolOutput` at `bashOutput` (`withBashOutputColor()`) — then only the output body changes color;
 * the command line (`toolTitle` + self-drawn syntax highlight), the collapse hints (`muted` / `dim`),
 * the tree gutter (`muted`), and the `Took Xs` footer (`muted`) are all unaffected, and other tools'
 * output is untouched (their renderers do not run inside this window).
 *
 * Note that **the theme parameter passed to `renderResult` is useless**: pi's bash renderer signature
 * names the second theme parameter `_theme` and never uses it — output lines are colored via the
 * **module-level theme singleton**. That singleton (`Proxy` →
 * `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]`) is the same object the
 * extension receives as a renderer parameter, so mutating its `fgColors` table changes the value the
 * renderer sees.
 *
 * `bashOutput` is a token invented by this repo (not in pi's official schema — same route as the two
 * `toolDiffAddedBg`-style tokens: TypeBox validation lets unknown keys pass and `createTheme()`
 * collects them into the foreground table). **If a theme does not define it, nothing happens** (the
 * probe is one real `getFgAnsi()` call — pi throws `Unknown theme color: …` on unknown tokens), so
 * built-in themes and pi-coder-summer-night / pi-coder-catppuccin keep using `toolOutput`; currently
 * only `pi-coder-ayu.json` defines this token. The expanded state (ctrl+o) is output body too and is
 * likewise affected.
 *
 * ## No background fill and no boundary blank lines for the whole block
 *
 * The bash block carries **no background at all** (set by the user on 2026-09-21): none of pending's
 * `toolPendingBg`, success's `toolSuccessBg`, or failure's `toolErrorBg` is painted — the block is
 * ordinary body text, continuous with the surrounding transcript. State is conveyed by the color of
 * the dot on the first line (see the next section) — losing the background does not lose status
 * information.
 *
 * Implementation-wise this is **actively not painting**, not painting and then erasing: under
 * `renderShell: "self"`, pi no longer wraps the whole block in bgFn anyway (`selfRenderContainer` is
 * a plain `Container`; only the default-shell path wraps one), so as long as we do not wrap one
 * ourselves the block is clean. Hence `Box`'s `bgFn` gets `undefined` (`new Box(0, 0)`), and
 * `stateBgFn` was deleted wholesale — its only reason to exist was "paint back the background pi
 * would have applied under the default shell", which is no longer needed.
 *
 * ★ **Only bash loses it**: other tools (read / grep / edit / write / task_* …) go through pi's own
 * render path — `contentBox` and bgFn are entirely unaffected by this extension, which only registers
 * a renderer for the single `bash` tool and only changes the two components it returns itself.
 *
 * The top and bottom boundary blank lines went away for the same reason: the background's vertical
 * padding had been painted back by this extension itself (one blank line above the command line, one
 * below the block's last line — both were bg-colored blank rows, since `Box.applyBg` pads each row
 * to width before coloring), but back-to-back bash calls stretched the screen far too airy. Now the
 * whole block is just "command line + result" itself: the command is the block's first row and the
 * result is its last — not a single blank row is added.
 *
 * **The middle was always flush** (no blank line between command and output) — that was removed in an
 * earlier round on purpose (command and result are two separate Boxes whose `paddingY` would stack
 * into three blank rows).
 *
 * The command line's left-padding cell is no longer a space — it became the state dot (next section).
 *
 * ## The state dot on the command line's first row (`•`)
 *
 * A dot `•` (U+2022, 1 column wide) sits in front of the command's **first row**, colored by this
 * bash call's state (set by the user on 2026-09-21; originally `▎`, then swapped to `•` for looks —
 * the **coloring logic did not change by one character**):
 *
 * ```
 * • Run ls …path…
 *    python abc.py…
 * ```
 *
 *   - **Running (pending)** → `dim` (dark gray)
 *   - **Finished OK** → `toolDiffAdded` (the green of diff added-lines)
 *   - **Finished failed** → `toolDiffRemoved` (the red of diff removed-lines)
 *
 * **Only the `Run ` line gets it**: continuation lines (`│ ` / two-cell indent), the `… +N lines`
 * marker, and the whole result tree (`└ ` / two-cell indent) get nothing — the dot is the status
 * light of *this one bash call*, not a border of the block.
 *
 * Mounting: the caller's `Box` uses `paddingX: 0`, and those two left-margin cells **are painted by
 * the extension itself** (`withHeadBar`): first row is `•` + one space, the rest are two spaces. So
 * the dot lands on **column 0**, `Run` on column 2, all body text on column 4, and the `│` `└` of
 * continuation lines / the result tree also sit on column 2 — same column as the command line, with
 * body aligned to body.
 *
 * ★ **These two cells were bought by "shift body right one column"** (the user's second-round look
 * call on 2026-09-21: `▎Run …` had `Run` jammed against the state glyph; now `• Run …`). The same
 * change **shifted the result side one column right too** (`contentWidth = width - GUTTER_WIDTH - 1`
 * in `withPreviewLimit`), otherwise the command line at column 2 and the result tree at column 0
 * would be offset. When changing the left margin **both sides must change together** —
 * `INDENT_WIDTH` is those two 1s.
 *
 * `Box`'s `paddingX` is 0, so children receive the full width and each side deducts the columns it
 * spent (`width - 3` in `renderCall`, `width - 3` in `withPreviewLimit`). The dot goes on the
 * **first row only** (handled by index 0 in `renderCall`), including the `invalid arg` / empty
 * command `wrapTextWithAnsi` branch.
 *
 * All three slots exist in pi's schema unconditionally (`toolDiffAdded` / `toolDiffRemoved` / `dim`
 * are all required tokens), so unlike `bashOutput` no existence probe is needed; what is taken is the
 * **foreground** ANSI (`getFgAnsi`), followed by a `\x1b[39m`, so the color cannot bleed onto the
 * `Run` after it.
 *
 * Usage:
 *   /bash-preview             show the output-preview line count
 *   /bash-preview 5           change the output preview to 5 lines (1-50)
 *   /bash-preview off         restore pi's built-in 5-line preview
 *   /bash-timeout             show the bash execution deadline (default / cap / env overrides)
 *
 * Collapse is fixed on, keeping 2 visual lines + end `…` / `… +N lines` (the old `/bash-collapse`
 * command was deleted); the tree indent is fixed on (`PI_BASH_TREE` is retired), and streaming keeps
 * only `PI_BASH_STREAM=on`.
 *
 * Side responsibility number five: **no duration footer on short commands** — when the execution ran
 * < 2s by default, the `Took 0.1s` line (and its leading separator blank) is removed wholesale; see
 * the "duration-footer threshold" section above. `PI_BASH_MIN_TIME_MS` changes the threshold, `0` =
 * always show.
 *
 * Side responsibility number four: change the bash **output preview** from pi's built-in 5 lines to
 * 3 (`BASH_PREVIEW_LINES` is a module-private constant of pi — not exported and not a setting, so
 * only post-processing works; see the "output preview line count" section below). `/bash-preview`
 * adjusts it.
 *
 * Side responsibility number three: give every bash command a **mandatory execution deadline**
 * (default 120s, cap 600s — a copy of Claude Code's BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS
 * policy, see the comment block at CLAUDE_CODE_DEFAULT_TIMEOUT_MS below). pi's built-in bash timeout
 * has no default; without the injection it would wait forever.
 *
 * Side responsibility number two: make the on-screen display of bash tool calls **non-streaming**
 * (the default, aligned with opencode / codex). pi has **no** setting that can do this (the Shell
 * section of settings.md only has shellPath / shellCommandPrefix / npmCommand). And there are **two
 * independent streaming mechanisms** here that must be handled separately:
 *
 * (1) **Output streaming**: the built-in bash execute calls onUpdate() with a snapshot each time
 *     stdout/stderr data arrives, throttled to 100ms (BASH_UPDATE_THROTTLE_MS in renderers/bash.js),
 *     which reaches the TUI (interactive-mode.js) via the tool_execution_update event and repaints a
 *     partial result. How it is turned off: pass onUpdate as undefined — every update point in
 *     execute is guarded by `if (!onUpdate) return`, so the whole run produces zero updates. The
 *     renderer is unaffected: the component is created at `tool_execution_start` (unrelated to
 *     updates), and the final display goes through `tool_execution_end` → `updateResult(result,
 *     isPartial=false)`, so suppressing partials only drops the intermediate frames — the final one
 *     still appears as usual (5-line preview + expand hint + truncation hint + "Took Xs").
 *
 * (2) **Command-text streaming**: while the model generates the tool call, its arguments stream in
 *     (visible in the json events as toolcall_delta pieces arriving bit by bit: `{"command": "echo a`
 *     / `; sleep 0` / `.3; echo` …); on each piece pi calls updateArgs() → updateDisplay() → repaints
 *     renderCall once, so the command appears letter by letter. This is **completely unrelated** to
 *     (1); suppressing onUpdate cannot touch it.
 *
 *     The way to turn it off is to **separate the two points in time** (aligned with codex /
 *     opencode):
 *       point one: command characters all received (`context.argsComplete`) → renderCall emits the
 *       complete command at once;
 *       point two: command finished → renderResult repaints the result under the command.
 *     Concretely: renderCall returns a **zero-line component** (not even a placeholder row) while
 *     "args may still be streaming" (`!argsComplete && isPartial === true`).
 *     Note it cannot be gated on isPartial **alone**: isPartial only goes false at the final result,
 *     so using it alone would hold the command back until after the result, degenerating into
 *     "everything waits for the result".
 *     (setArgsComplete() is called at assistant message_end, ~60ms earlier than tool_execution_start —
 *     exactly the "command fully received" semantic point.)
 *     Nor on argsComplete **alone**: it is only set in the live stream; `/resume` and other history
 *     rebuild paths never call setArgsComplete (see the detailed note in renderCall), so using it
 *     alone would leave resumed bash blocks with only output and no command line at all (that was
 *     once the resume bug).
 *     A zero-line component also paints no empty box: Box.render begins with a
 *     `childLines.length === 0 → []` guard (paddingY is added only after it).
 *
 * Measured evidence:
 *   - `pi -p --mode json` on real pi counting events for the same
 *     `echo a; sleep 0.35; echo b; sleep 0.35; echo c`: with the extension loaded
 *     `tool_execution_update` = **0**; with `--no-extensions` running built-in bash = **4**; the tool
 *     result is `"a\nb\nc\n"` in both cases.
 *   - Calling the package root's exported createBashToolDefinition directly and counting onUpdate
 *     calls: with onUpdate = 4 calls (1 initial empty update + 3 output snapshots); with undefined =
 *     0 calls; the final result is byte-identical.
 *   - **Execution time unaffected**: same `echo a; sleep 0.5; echo b` — streaming average 545ms,
 *     non-streaming average 566ms (3 runs each; the 21ms delta is noise). The perceived "slower" is
 *     the inherent cost of non-streaming: the first output chunk used to appear at ~100ms, now
 *     nothing shows until the command completes — perceived latency = full command duration.
 *   - The real timeline of `echo hello`: toolcall_start → toolcall_end 197ms (args streaming,
 *     model side), toolcall_end → tool_execution_start 63ms, tool_execution_start → end only 31ms.
 *     I.e. the bulk of the "wait" is the model generating the tool call, not command execution.
 *
 * Why this must live in this extension instead of a new bash-stream.ts: same-name tool registration
 * across extensions is **first registration per name wins** (verbatim from the comment in runner.js's
 * getAllRegisteredTools, which iterates in extension load order = file-name order). This file sorts
 * earlier, so a new one would be **silently ignored**.
 *
 * The cost of non-streaming (deliberate — do not "optimize" it away):
 *   - **No progress feedback** between "command fully received" and "command finished" (just the
 *     command line — no output, no timer). The per-second timer in `renderResult` only starts when
 *     `options.isPartial` (`if (state.startedAt !== undefined && options.isPartial &&
 *     !state.interval)`); without partial it never starts and no "Elapsed" ticks — the
 *     "output + Took 12.3s" arrives only at the end. Commands are usually short, so this is
 *     acceptable; to watch a long task, use `PI_BASH_STREAM=on`.
 *   - What is sent to the model is **completely unchanged**: onUpdate only feeds the display layer
 *     (tool_execution_update → isPartial in tool-execution.js); it neither lands in the session on
 *     disk nor in the tool result, and execute's return value is byte-identical; renderCall likewise
 *     only changes display — tool-call arguments and session text are untouched.
 */

import type { BashToolOptions, ExtensionAPI, ThemeColor, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	ESCALATION_TITLE,
	boundaryFromEnv,
	buildSeatbeltProfile,
	classifyOutsidePaths,
	extractDeniedPaths,
	isSandboxEnabled,
	looksLikeSandboxDenial,
	memoryScopesFor,
	sessionScopeFor,
	wrapWithSandbox,
	writableRoots,
	type PathEnv,
} from "./bash-command-collapse/sandbox.ts";
import { getAllowlistStore, getSessionScopes, type AllowlistStore } from "./bash-command-collapse/allowlist.ts";

/**
 * How many **visual lines** the command line keeps in **collapsed** state (a hard-wrapped overlong
 * single-line command occupies at most this many).
 *
 * 2 is the look the user picked: line 1 fills to the brim, line 2 truncates any overflow to `…`;
 * when the command itself is longer, a `… +N lines` marker is added under line 2. See the file
 * header section "command line: 2 lines + `Run ` prefix".
 */
const DEFAULT_LINES = 2;

/**
 * The command-line prefix. The old look was pi's built-in `$ `; now `Run ` (see the file header
 * "command line: 2 lines + `Run ` prefix"). First line uses it, continuation lines use
 * `COMMAND_CHAIN` (the two affect the **body column** differently — wrapping and budget are each
 * computed against their own).
 */
const COMMAND_PROMPT = "Run ";
/**
 * Theme slot for the structural glyphs (`│ ` continuations of the `Run ` command line, `└ ` / `│ `
 * in the result) — **`muted`**.
 *
 * Why not `toolTitle` (what the `Run ` line uses): the command line's continuations and the result
 * tree's corner are two segments of **the same tree** and must share a color; `Run ` is the title
 * and takes `toolTitle` normal color, while the tree takes `muted` — the same slot as the result
 * side's `└ ` (`prefixTreeLines`). Thus `Run ` / `│` / `└ ` each take their place: prefix bright,
 * structure gray.
 */
const COMMAND_CHAIN_COLOR = "muted";
/**
 * The tree-gutter vertical-bar row: used by continuation lines before the command ends, continuation
 * lines after it finishes, and output/command truncation hints (see the file header "output tree
 * gutter"). 2 columns.
 */
const COMMAND_CHAIN = "│ ";
/** Pure indent (2 columns): continuation lines before the tree connects while the command runs, and body continuations after `└ ` in the result tree. */
const COMMAND_INDENT = "  ";
/** End-of-line overflow marker (shared by the last command line's tail and the head of truncation-hint lines). */
const ELLIPSIS = "…";

/**
 * Line count kept by the output preview (pi's built-in is 5; changed here to 3).
 *
 * pi hardcodes the count at `const BASH_PREVIEW_LINES = 5` in `core/tools/renderers/bash.js` — a
 * module-private constant, neither exported (`index.d.ts` lacks it) nor in `BashToolOptions`, and
 * `docs/settings.md` has no setting for it — so there is no global config to change and the only
 * option is post-processing in the extension. See the file header "output preview line count".
 */
const DEFAULT_OUTPUT_PREVIEW_LINES = 3;

/**
 * Display threshold for the duration footer (milliseconds): executions **shorter** than it do not
 * draw the `Took 0.1s` line.
 *
 * pi's built-in `renderResult` unconditionally draws a `Took X.Xs` line at the result's end
 * (whenever `state.startedAt` is set), and it is a full-line footer (plus its own leading blank
 * line) — pure waste of two rows for tens-of-milliseconds commands. See the file header
 * "duration-footer threshold".
 *
 * `PI_BASH_MIN_TIME_MS` adjusts it at startup; `0` is a legal value = always show (disables the
 * optimization).
 */
const DEFAULT_MIN_TIME_FOOTER_MS = 2000;

/**
 * Responsibility number three: enforce an **execution deadline** on every bash command (copied from
 * Claude Code's policy).
 *
 * Why it is mandatory: pi's built-in bash `timeout` is an optional parameter with **no default**
 * (the schema description literally says "Timeout in seconds (optional, no default timeout)", and
 * settings.md has no global tool timeout either), so when the model passes no timeout, a command
 * that never exits leaves pi **waiting forever**. And because this extension is non-streaming by
 * default (onUpdate stripped), the built-in renderer's `Elapsed` timer only starts under `isPartial`
 * (renderers/bash.js) — so on screen "process hung" and "merely slow" look identical: it neither
 * recovers on its own nor shows whether waiting is warranted.
 *
 * Claude Code's approach (verbatim from the v2.1.268 binary, where the JS is embedded):
 *   var xRo=120000, ARo=600000;                       // default 2min / cap 10min
 *   wCe(env)  → BASH_DEFAULT_TIMEOUT_MS else xRo       // default
 *   i7e(env)  → Math.max(BASH_MAX_TIMEOUT_MS else ARo, wCe(env))   // cap=max(configured,default)
 *   Math.min(z || Xe(), Be())                          // model-passed timeout **silently clamped**
 * The tool description also tells the model the numbers: "You may specify an optional timeout in
 * milliseconds (up to ${max}ms…). By default, your command will timeout after ${default}ms…".
 * Note its unit is ms while pi's bash parameter is **seconds**, so everything below divides by 1000.
 *
 * The env names reuse Claude Code's (BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS), so behavior
 * matches on both sides and migrated configs work directly; like Claude Code, process.env is read
 * **at call time** (not module load), so changing env at runtime takes effect.
 *
 * After the timeout, pi itself calls `killProcessTree(pid)` (the whole process tree, grandchildren
 * included) and returns "Command timed out after N seconds" with the accumulated output to the
 * model — that part is not ours to handle. The cost (same as Claude Code): legitimate long commands
 * (big builds, long test runs) get killed by the default deadline; the model must pass a larger
 * timeout itself (cap 10min) or raise the default via env.
 *
 * **Parity audit (checked item by item against the v2.1.268 binary — do not second-guess the numbers
 * below from documentation impressions)**:
 * Claude Code's env allowlist contains exactly three `BASH_*` of its own —
 * `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` / `BASH_MAX_OUTPUT_LENGTH` (the rest like
 * `BASH_ARGC` / `BASH_SOURCE` are bash's own internals). The first two are the pair above, aligned;
 * the third is **not adopted**: it only sizes the output read-back window (official wording: "on its
 * own only sizes the read-back window"), while pi's truncation is "keep last 2000 lines / 50KB +
 * write the full output to a temp file" — different mechanisms, and pi's `DEFAULT_MAX_LINES` /
 * `DEFAULT_MAX_BYTES` are module constants the extension cannot change.
 * Known differences (deliberate — do not "align" them):
 *   ① **Units**: Claude Code's timeout parameter is ms, pi's is seconds — so env is read as ms and
 *     divided by 1000 internally, and the tool description speaks seconds (do not change pi's
 *     parameter unit; it would contradict its own schema).
 *   ② **Invalid values**: Claude Code's `z || Xe()` passes **negative** numbers through verbatim
 *     (negatives are truthy); we normalize `<=0` / non-finite to the default — because pi's
 *     `resolveTimeoutMs` throws outright on `<=0`, and not normalizing would turn the tool call
 *     into a hard error. NaN behaves identically on both sides (falls to default).
 *   ③ **Timeout semantics**: pi throws (tool result carries isError=true) with accumulated output;
 *     Claude Code returns a normal result plus a timeout note — cannot be changed (the throw
 *     happens inside `base.execute`).
 *   ④ Claude Code's layers 2/3 (`run_in_background` + `BashOutput`/`KillShell` (new names
 *     `TaskOutput`/`TaskStop`) + `/bashes` + Ctrl+B, and `CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS`
 *     auto-backgrounding instead of killing) are **unimplemented**: pi has no counterparts;
 *     building them means three new tools + a process registry.
 *   ⑤ pi's own hard cap `MAX_TIMEOUT_MS = 2_147_483_647` (~24.8 days) is far above our 600s clamp,
 *     so it cannot trip pi's error.
 */
const CLAUDE_CODE_DEFAULT_TIMEOUT_MS = 120_000;
const CLAUDE_CODE_MAX_TIMEOUT_MS = 600_000;

/** Read a millisecond value from env; non-positive/non-numeric values count as unset (matches Claude Code's `!isNaN(r)&&r>0`). */
function readTimeoutEnvMs(name: string): number | undefined {
	const raw = process.env[name]?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Default deadline (seconds). */
function defaultTimeoutSeconds(): number {
	return (readTimeoutEnvMs("BASH_DEFAULT_TIMEOUT_MS") ?? CLAUDE_CODE_DEFAULT_TIMEOUT_MS) / 1000;
}

/** Deadline cap (seconds): Claude Code is `Math.max(configured cap, default)` — raising the default raises the cap along. */
function maxTimeoutSeconds(): number {
	return Math.max(readTimeoutEnvMs("BASH_MAX_TIMEOUT_MS") ?? CLAUDE_CODE_MAX_TIMEOUT_MS, readTimeoutEnvMs("BASH_DEFAULT_TIMEOUT_MS") ?? CLAUDE_CODE_DEFAULT_TIMEOUT_MS) / 1000;
}

/**
 * Compute the **effective deadline (seconds)** for this run — Claude Code's `Math.min(z || default,
 * max)`:
 *   - model passed nothing / an invalid value (0, negative, NaN, string) → fall to the default;
 *   - passed a value above the cap → **silently clamp to the cap** (no error; same behavior as
 *     Claude Code — its silent clamp is known issue #83824, copied here for parity).
 * Also avoids pi's hard error: the built-in resolveTimeoutMs throws outright on <=0 / non-finite.
 */
function effectiveTimeoutSeconds(requested: unknown): number {
	const max = maxTimeoutSeconds();
	const requestedSeconds = typeof requested === "number" ? requested : Number(requested);
	if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) return Math.min(defaultTimeoutSeconds(), max);
	return Math.min(requestedSeconds, max);
}

/** Grapheme segmenter (pi-tui does not export its own instance, so build one locally; Node's built-in Intl.Segmenter). */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One wrapped fragment: the body itself (**no prefix**), its character offset in the **source line**, and its own row's prefix. */
interface WrappedRow {
	text: string;
	start: number;
	prefix: string;
}

/**
 * **break-all hard wrap**: fill grapheme by grapheme up to the column budget and break exactly when
 * full — like CSS `word-break: break-all`, regardless of whether the break lands mid-word/mid-path.
 * **No content is dropped**: the fragments reassemble into the original (how they are placed or
 * truncated next is the caller's decision).
 *
 * Why not pi-tui's `wrapTextWithAnsi`: it is **greedy word wrap + hard split of overlong words** — a
 * word that does not fit the rest of the current line is **moved wholesale to the next line** and
 * then split. Measured on a 79-column terminal, `Run cp <78-col path>` rendered as `Run cp` alone on
 * a line plus the path split mid-string across two lines: dozens of columns wasted at line end (the
 * ugly "early wrap" look), and the command separated from its argument. Hard wrap fills every line,
 * with command body directly after `Run `.
 *
 * **Prefixes are per-row**: row 1 is `firstPrefix` (`Run `), the rest are `linePrefix` (`│ ` or
 * two-cell indent) — the budget is the body budget **after deducting that row's prefix width**, so a
 * row with its prefix fills exactly one line and never sticks a column past the gutter (`Run ` is 4
 * columns, `│ ` is 2; the body being off by one column between the two prefixes is deliberate: the
 * first row follows `Run `, continuations align to `Run `'s `n` column).
 *
 * **Carries offsets** (`WrappedRow.start`): command highlighting relies on it to splice "wrap first,
 * color after" together — token offsets are **source-line** coordinates while fragments are
 * **post-wrap** coordinates, and without this span they cannot be matched (see `styleCommandLine`).
 *
 * Wraps by grapheme, not by column-cutting characters: emoji / combining characters have segment
 * length ≠ 1 char, and cutting by char index would split them in half. A wide character (CJK etc.,
 * 2 columns) that cannot fit the remaining 1 column breaks **before** itself (leaving 1 blank
 * column at line end) — a grapheme is indivisible.
 *
 * @param firstPrefix prefix of row 1 (`Run `)
 * @param linePrefix  prefix of the remaining rows (`│ ` / two-cell indent)
 * @param firstRowBudget **whole-line** budget of row 1 (prefix included; the timeout suffix was already deducted)
 * @param restRowBudget  **whole-line** budget of the remaining rows
 */
function hardWrapRows(text: string, firstPrefix: string, linePrefix: string, firstRowBudget: number, restRowBudget: number): WrappedRow[] {
	const rows: WrappedRow[] = [];
	let row = "";
	let rowWidth = 0;
	let rowStart = 0;
	let prefix = firstPrefix;
	let budget = Math.max(1, firstRowBudget - visibleWidth(firstPrefix));
	for (const { segment, index } of graphemeSegmenter.segment(text)) {
		const w = visibleWidth(segment);
		// the rowWidth > 0 guard: a single grapheme wider than the whole row budget (extremely
		// narrow terminal) must still be placed, or this would loop forever on empty rows
		if (rowWidth > 0 && rowWidth + w > budget) {
			rows.push({ text: row, start: rowStart, prefix });
			prefix = linePrefix;
			budget = Math.max(1, restRowBudget - visibleWidth(linePrefix));
			row = segment;
			rowWidth = w;
			rowStart = index;
		} else {
			// an empty row means this is the row's first grapheme — record its offset in the source line
			if (row === "") rowStart = index;
			row += segment;
			rowWidth += w;
		}
	}
	rows.push({ text: row, start: rowStart, prefix });
	return rows;
}

/** A command line **awaiting coloring**: `text` is plain text (prefix and end `…` included), coloring info complete. */
interface PendingRow {
	text: string;
	prefix: string;
	/** Character offset of the body's start within the **source line** (0 for the first fragment, the fragment's own offset after). */
	sourceStart: number;
	tokens: ShellToken[] | null;
	/** This row's whole-line budget once its prefix is attached (for the truncation `…`). */
	budget: number;
}

/**
 * Render result of one command. `hiddenLines` is the number of **whole visual rows** not shown (`0`
 * = no marker row); the row eaten by the end-of-line `…` is counted too.
 */
interface CommandRender {
	lines: string[];
	hiddenLines: number;
}

function tokenizeShellLine(line: string, openQuote: string | null): { tokens: ShellToken[]; openQuote: string | null } {
	const tokens: ShellToken[] = [];
	let quote = openQuote;
	let commandExpected = true;
	let i = 0;

	while (i < line.length) {
		const char = line[i]!;

		// a quote left unclosed from a previous line: consume to this line's closing quote, or the rest of the line if none
		if (quote) {
			let j = i;
			while (j < line.length) {
				const c = line[j]!;
				if (c === "\\" && quote === '"' && j + 1 < line.length) {
					j += 2;
					continue;
				}
				if (c === quote) break;
				j++;
			}
			if (j >= line.length) {
				tokens.push({ kind: "string", start: i, end: line.length });
				i = line.length;
				continue;
			}
			tokens.push({ kind: "string", start: i, end: j + 1 });
			i = j + 1;
			quote = null;
			continue;
		}

		if (/\s/.test(char)) {
			let j = i;
			while (j < line.length && /\s/.test(line[j]!)) j++;
			tokens.push({ kind: "space", start: i, end: j });
			i = j;
			continue;
		}

		// `#` starts a comment only at **word start** (the `#` in `foo#bar` is an ordinary char)
		if (char === "#") {
			tokens.push({ kind: "comment", start: i, end: line.length });
			i = line.length;
			continue;
		}

		const operator = matchShellOperatorAt(line, i);
		if (operator !== null) {
			tokens.push({ kind: "operator", start: i, end: i + operator.length });
			commandExpected = SHELL_COMMAND_NEXT_OPS.has(operator);
			i += operator.length;
			continue;
		}

		// word: consume to whitespace / operator / end of line; a quote met midway is swallowed with the word
		let j = i;
		let wordQuote: string | null = null;
		while (j < line.length) {
			const c = line[j]!;
			if (wordQuote) {
				if (c === "\\" && wordQuote === '"' && j + 1 < line.length) {
					j += 2;
					continue;
				}
				if (c === wordQuote) wordQuote = null;
				j++;
				continue;
			}
			if (/\s/.test(c)) break;
			if (c === "'" || c === '"') {
				wordQuote = c;
				j++;
				continue;
			}
			if (SHELL_OPERATOR_CHARS.has(c)) break;
			if (c >= "0" && c <= "9" && isFdRedirectAt(line, j)) break;
			j++;
		}
		const word = line.slice(i, j);
		tokens.push({ kind: classifyShellWord(word, commandExpected), start: i, end: j });
		// an assignment prefix (`FOO=bar cmd`) is still followed by a command; every other word clears the "command expected" flag
		if (!SHELL_ASSIGN_PATTERN.test(stripOuterQuotes(word))) commandExpected = false;
		i = j;
		if (wordQuote) quote = wordQuote; // unclosed quote → hand the state to the next source line
	}

	return { tokens, openQuote: quote };
}

/**
 * Coloring of the command-line prefix. Three prefix kinds, three treatments:
 *   - `Run ` — **only the word `Run` is bold** (`toolTitle` normal color + bold); the space after it
 *     and the command body are not bold (user decision 2026-09-21: only the single word `Run` is
 *     the title);
 *   - `│ ` — **structural glyph**, same `muted` as the result side's `└ ` (`COMMAND_CHAIN_COLOR`),
 *     not bold;
 *   - two-cell indent (command still running, tree not yet connected) — plain spaces, uncolored; an
 *     empty string returns as-is (further fragments wrapped from the same source line have no prefix).
 *
 * Bold must **hug the word** (`bold("Run")`, not `bold(prefix)`): bold is SGR `\x1b[1m…\x1b[22m`,
 * and wrapping the prefix would bold the trailing space too — the gap before the body would look wider.
 */
function styleCommandPrefix(prefix: string, theme: any): string {
	if (prefix === "" || prefix === COMMAND_INDENT) return prefix;
	if (prefix === COMMAND_CHAIN) return theme.fg(COMMAND_CHAIN_COLOR, prefix);
	// `Run ` → `Run` (bold) + ` ` (plain)
	return theme.fg("toolTitle", theme.bold(prefix.slice(0, -1)) + prefix.slice(-1));
}

/**
 * Colorize **one command line**: `prefix` is colored wholesale as a **structural glyph** (`Run ` =
 * `toolTitle`, `│ ` / two-cell indent = `muted`; see `styleCommandPrefix`), and `body` is the
 * **prefix-free** body colored per token. With highlighting off, the body is wholly `toolTitle` +
 * bold (the pre-change look, only with `Run ` as the prefix).
 *
 * The prefix color **must be closed within this segment** (`\x1b[39m`, closed by `theme.fg` itself):
 * `│ ` is a **structural glyph**, not body; if a later token's color bled into the prefix, the `│`
 * on a path line would drift along with the path color (observed).
 *
 * `sourceStart` is the character offset of `body`'s start within the **source line** — token offsets
 * are also source-line coordinates and wrap fragments can start anywhere in the source line, so it
 * must travel along or continuation lines' syntax highlighting shifts wholesale.
 */
function styleCommandLine(prefix: string, body: string, tokens: ShellToken[] | null, sourceStart: number, theme: any): string {
	const head = styleCommandPrefix(prefix, theme);
	if (!tokens) return head + theme.fg("toolTitle", body);

	// the body is never bold (only the word `Run` is — see styleCommandPrefix)
	const style = (kind: ShellTokenKind, chunk: string) => {
		const color = SHELL_TOKEN_COLORS[kind];
		return color === null ? chunk : theme.fg(color, chunk);
	};

	const sourceEnd = sourceStart + body.length;
	let out = head;
	let cursor = sourceStart;
	for (const token of tokens) {
		if (token.end <= cursor) continue;
		if (token.start >= sourceEnd) break;
		const from = Math.max(token.start, cursor);
		const to = Math.min(token.end, sourceEnd);
		if (from > cursor) out += body.slice(cursor - sourceStart, from - sourceStart);
		out += style(token.kind, body.slice(from - sourceStart, to - sourceStart));
		cursor = to;
	}
	// tokens cover the whole line contiguously, so this is unreachable in normal flow; if reached, fall back plainly without dropping characters
	if (cursor < sourceEnd) out += theme.fg("toolTitle", body.slice(cursor - sourceStart));
	return out;
}

/**
 * Replace the last visible character of a line with `…`: the visible width of `prefix + text` stays
 * unchanged (empty body returns as-is).
 *
 * Why not `truncateToWidth(row, budget, ELLIPSIS)`: when the target string has **exactly filled** the
 * budget it returns as-is (`visibleWidth <= maxWidth` is left alone), and a full line is precisely
 * the most common overflow shape. A wide char takes 2 columns and may leave 1 blank column when it
 * cannot fit — acceptable (same wrap rule as `hardWrapRows`).
 */
function ellipsizeTail(prefix: string, text: string, budget: number): string {
	if (text === "") return text;
	const limit = Math.max(1, budget - visibleWidth(prefix));
	let out = "";
	let used = 0;
	for (const { segment } of graphemeSegmenter.segment(text)) {
		const w = visibleWidth(segment);
		if (used + w > limit - 1) break;
		out += segment;
		used += w;
	}
	return out + ELLIPSIS;
}

/**
 * Render one command (possibly several source lines): wrap into `limit` visual rows; what does not
 * fit goes into `hiddenLines`.
 *
 * Prefixes: the first source line starts with `firstPrefix` (`Run `); the continuations wrapped out
 * of it and every later source line use `linePrefix` (`│ ` or two-cell indent) — so continuation
 * bodies align to `Run `'s `n` column (see file header).
 *
 * Rules (see file header "command line: 2 lines + `Run ` prefix"):
 *   ① **Whenever there is overflow**, the tail of the last kept visual row is replaced with `…`
 *      (whether the overflow is one row's tail or several later rows); with no overflow, no `…` is
 *      drawn at all;
 *   ② `hiddenLines` = how many visual rows remain **after** the last kept row: each fragment of the
 *      current source line that was wrapped but not shown counts 1, and each later source line not
 *      reached counts 1.
 *
 * Wrapping and truncation both run on **plain text** (`hardWrapRows` / `ellipsizeTail` account for
 * their own prefix widths), and coloring happens last, row by row — the other way around would cut
 * SGR sequences in half.
 */
function renderCommandLines(
	lines: string[],
	firstPrefix: string,
	linePrefix: string,
	firstRowBudget: number,
	restRowBudget: number,
	openQuote: string | null,
	highlight: boolean,
	limit: number,
	theme: any,
): CommandRender {
	// lay everything out as **plain text** first (prefix + wrap + end `…`), colorize last — the end `…`
	// must go on plain text, or it would cut SGR sequences in half
	const pending: PendingRow[] = [];
	let hiddenLines = 0;
	let hiddenTail = 0;
	let quote = openQuote;

	for (let index = 0; index < lines.length; index++) {
		if (pending.length >= limit) {
			// every later source line counts as one row not shown (how many rows it would itself wrap into does not change that)
			hiddenLines += lines.length - index;
			break;
		}
		const line = lines[index]!;
		// the first source line starts with `Run `; the rest use their own continuation prefix
		const head = pending.length === 0 ? firstPrefix : linePrefix;
		const rows = hardWrapRows(line, head, linePrefix, Math.max(1, pending.length === 0 ? firstRowBudget : restRowBudget), restRowBudget);
		// quote state carries across source lines the same way (tokenization only affects coloring, not row order)
		const tokenized = highlight ? tokenizeShellLine(line, quote) : { tokens: null, openQuote: quote };
		quote = tokenized.openQuote;

		const room = limit - pending.length;
		const take = Math.min(rows.length, room);
		for (let i = 0; i < take; i++) {
			const row = rows[i]!;
			pending.push({
				text: row.text,
				prefix: row.prefix,
				sourceStart: row.start,
				tokens: tokenized.tokens,
				budget: row.prefix === firstPrefix ? firstRowBudget : restRowBudget,
			});
		}
		if (rows.length > take) {
			// this source line still has fragments unplaced: they are the "visual rows not shown"
			hiddenTail = rows.length - take;
			break;
		}
	}

	hiddenLines += hiddenTail;
	if (hiddenLines > 0 && pending.length > 0) {
		// content remains unshown: replace the tail of the last kept row with `…` (width unchanged)
		const last = pending[pending.length - 1]!;
		last.text = ellipsizeTail(last.prefix, last.text, last.budget);
	}

	return {
		lines: pending.map((row) => styleCommandLine(row.prefix, row.text, row.tokens, row.sourceStart, theme)),
		hiddenLines,
	};
}

type ShellTokenKind = "space" | "comment" | "operator" | "command" | "flag" | "string" | "path" | "variable" | "word";

/** One lexical unit; `start`/`end` are character offsets **within the source line** (excluding the `$ ` prefix). */
interface ShellToken {
	kind: ShellTokenKind;
	start: number;
	end: number;
}

/** token → theme color slot. `null` = not colored (whitespace emitted as-is). */
const SHELL_TOKEN_COLORS: Record<ShellTokenKind, ThemeColor | null> = {
	space: null,
	comment: "syntaxComment",
	operator: "syntaxOperator",
	command: "syntaxFunction",
	flag: "syntaxKeyword",
	string: "syntaxString",
	path: "syntaxString",
	variable: "syntaxVariable",
	word: "syntaxString",
};

/** `$VAR` / `${VAR}`. */
const SHELL_VAR_PATTERN = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;
/** Assignment: `NAME=`. */
const SHELL_ASSIGN_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * Operators, matched **longest first** — first match wins. The redirect entry carries an optional
 * numeric fd, so `2>&1` is cut as `2>&` (operator) + `1` (word) rather than treating `2` as an argument.
 */
const SHELL_OPERATOR_PATTERNS = [/^&&/, /^\|\|/, /^\|&/, /^;;/, /^<<-?/, /^\d*(?:>>|>&|<&|<|>)/, /^[|&;()]/];
/** Characters that can start an operator (coarse filter — avoids running the regex per character, which is O(n²) on long command lines). */
const SHELL_OPERATOR_CHARS = new Set(["|", "&", ";", "(", ")", "<", ">"]);
/** A new command follows these operators (`cmd1 | cmd2`); the rest (redirects etc.) are followed by arguments. */
const SHELL_COMMAND_NEXT_OPS = new Set(["|", "||", "&&", ";", "&", "|&", "("]);

function stripOuterQuotes(word: string): string {
	const match = /^(['"])([\s\S]*)\1$/.exec(word);
	return match ? match[2]! : word;
}

/** A bare number immediately before `<`/`>` is an fd redirect (`2>`); otherwise the `2` in `foo2` belongs to the word. */
function isFdRedirectAt(line: string, pos: number): boolean {
	let j = pos;
	while (j < line.length && line[j]! >= "0" && line[j]! <= "9") j++;
	const next = line[j];
	return next === "<" || next === ">";
}

/** Match an operator at `pos`; null when there is none. */
function matchShellOperatorAt(line: string, pos: number): string | null {
	const char = line[pos]!;
	if (!SHELL_OPERATOR_CHARS.has(char) && !(char >= "0" && char <= "9")) return null;
	const rest = line.slice(pos);
	for (const pattern of SHELL_OPERATOR_PATTERNS) {
		const match = pattern.exec(rest);
		if (match) return match[0];
	}
	return null;
}

/**
 * Word classification. Order matters: assignment > quoted string > option > `$VAR` > path >
 * command/argument. `"--foo"` is a quoted string, not an option; `$HOME/x` is a variable, not a path
 * (`$` wins).
 */
function classifyShellWord(word: string, commandExpected: boolean): ShellTokenKind {
	const normalized = stripOuterQuotes(word);
	if (SHELL_ASSIGN_PATTERN.test(normalized)) return "variable";
	if (word.startsWith("'") || word.startsWith('"')) return "string";
	if (word.startsWith("-") && word.length > 1) return "flag";
	if (SHELL_VAR_PATTERN.test(normalized)) return "variable";
	// containing `/` means a path; the extra branch covers bare `.` / `..` / `~`
	if (normalized.includes("/") || /^\.{1,2}(?:\/|$)/.test(normalized) || normalized.startsWith("~/")) return "path";
	return commandExpected ? "command" : "word";
}

/**
 * Tokenize one source line. Tokens **cover the whole line contiguously** (whitespace tokens
 * included), so wrap fragments can be sliced and colored by offset directly — no guessing which
 * fragment maps to which token.
 *
 * `openQuote` is an unclosed quote left by the previous source line: the second line of a multi-line
 * string counts as string wholesale instead of being re-tokenized as a new command. Tokenization
 * **cannot fail** (unlike the reference plugin, which returns undefined and falls back to
 * highlightCode) — an unclosed quote simply consumes to end of line and hands the state to the next
 * source line.
 */

/**
 * Colorize **one command line**: `prefix` is wholly `toolTitle` normal color (`Run ` / `│ ` /
 * two-cell indent); `body` is the **prefix-free** body, colored per token. With highlighting off the
 * body is `toolTitle` + bold (the pre-change look, only with `Run ` as the prefix).
 *
 * `sourceStart` is the character offset of `body`'s start within the **source line** — token offsets
 * are also source-line coordinates and wrap fragments can start anywhere in the source line, so it
 * must travel along or continuation lines' syntax highlighting shifts wholesale.
 */

/** pi's agent directory (`PI_CODING_AGENT_DIR` overrides; `~/.pi/agent` otherwise). */
function resolveAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	return envDir ? (envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir) : join(homedir(), ".pi", "agent");
}

/**
 * Key-name text for `app.tools.expand`, for the self-built hint line.
 *
 * Why not use pi's exported `keyText` / `keyHint` directly: the `@earendil-works/pi-coding-agent` /
 * `pi-tui` that an extension `import`s is the **npm/dist copy** the loader alias points to — a
 * different module instance from the one in pi's runtime (bundle). Measured (running `node` directly
 * under `~/.pi/agent/npm`): `keyHint("app.tools.expand", "to expand")` **throws** `Theme not
 * initialized. Call initTheme() first.` (it reads the copy's own theme singleton, while pi only
 * initialized the bundle's), and `keyText(...)` returns `""` (the copy's keybindings table is empty).
 * And a throw inside renderResult is silently caught by pi, falling back to
 * `createResultFallback()` — the whole custom rendering gone. So those two functions must never be
 * imported; the config file is read instead.
 *
 * The default `ctrl+o` is pi's default binding (the `app.tools.expand` row in `docs/keybindings.md`).
 */
function expandKeyText(): string {
	try {
		const parsed = JSON.parse(readFileSync(join(resolveAgentDir(), "keybindings.json"), "utf8"));
		const bound = parsed?.["app.tools.expand"];
		const keys = Array.isArray(bound) ? bound : [bound];
		const text = keys.filter((k: unknown): k is string => typeof k === "string" && k.trim() !== "").join("/");
		if (text) return text;
	} catch {
		// missing config file / parse failure / key unbound — all fall back to the default
	}
	return "ctrl+o";
}

/**
 * Normalize the duration-footer threshold (ms): unset / empty / illegal values (NaN, negative) all
 * fall to the default 2000; **`0` is a legal value** (always show — disables the optimization), so
 * the `value || DEFAULT` idiom cannot be used. Read once at registration, like `clampPreviewLines`.
 */
function resolveMinTimeFooterMs(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return DEFAULT_MIN_TIME_FOOTER_MS;
	const value = Number(raw.trim());
	return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_TIME_FOOTER_MS;
}

/**
 * Normalize the output-preview line count to an integer in 1-50; illegal values (NaN / <=0 /
 * fraction) all fall to the default 3. Deliberately Number, not parseInt: parseInt("2.5") silently
 * becomes 2, while here it should normalize to the default.
 */
function clampPreviewLines(value: number): number {
	if (!Number.isFinite(value) || value < 1 || value > 50 || !Number.isInteger(value)) return DEFAULT_OUTPUT_PREVIEW_LINES;
	return value;
}

/**
 * Read the shellPath / shellCommandPrefix settings so the overridden bash tool behaves identically
 * to the built-in one (the built-in tool is constructed by AgentSession from these two settings
 * values).
 */
function readShellOptions(): BashToolOptions {
	const paths = [join(resolveAgentDir(), "settings.json"), join(process.cwd(), ".pi", "settings.json")];

	const merged: Record<string, unknown> = {};
	for (const path of paths) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (parsed && typeof parsed === "object") Object.assign(merged, parsed);
		} catch {
			// missing file / parse failure — both fall back to defaults
		}
	}

	const options: BashToolOptions = {};
	if (typeof merged.shellPath === "string" && merged.shellPath) {
		options.shellPath = merged.shellPath.startsWith("~") ? join(homedir(), merged.shellPath.slice(1)) : merged.shellPath;
	}
	if (typeof merged.shellCommandPrefix === "string") {
		options.commandPrefix = merged.shellCommandPrefix;
	}
	return options;
}

/**
 * Strip leading blank lines from a component's rendered output.
 *
 * The built-in bash renderResult inserts a leading blank line before the output (`new Text("\n" +
 * styledOutput)`) — under the default shell that is "one row of spacing between command and output";
 * but this extension runs in self mode where command and output are two separate blocks, and that
 * row stacks with both Boxes' paddingY into three blank rows (observed). The user's 2026-09-21 shape
 * wants command and output **flush**, so the row is stripped as before.
 * Check ANSI before trim: a row may carry a foreground escape sequence and a direct trim() would
 * not be empty.
 * Only **leading** blanks are stripped: the blank between output and "Took" (also a `\n` prefix) is
 * deliberately kept, separating body from duration footer.
 */
function stripLeadingBlanks(inner: any) {
	return {
		render(width: number): string[] {
			const lines: string[] = inner.render(width);
			let i = 0;
			while (i < lines.length && lines[i].replace(/\x1b\[[0-9;]*m/g, "").trim() === "") i++;
			return i > 0 ? lines.slice(i) : lines;
		},
		invalidate() {
			inner.invalidate?.();
		},
	};
}

/**
 * Add the **block left margin** to every command row (`• ` + one column; see the file header "the
 * state dot on the command line's first row"): the first row is the state dot `•` + one space, all
 * other rows are two spaces.
 *
 * Why these cells must be painted by the extension instead of `Box`'s `paddingX`: what `Box` pads
 * is **the same on every row** — there would be nowhere to draw the first-row dot. So the caller's
 * `Box` uses `paddingX: 0` and the left margin moved here — making the first row `• Run …`,
 * continuation rows ` │ …` / `   …`, `Run`'s `R` (column 2) aligned with the `│` `└` of continuation
 * / result rows (also column 2), and all body columns (column 4) aligned too.
 *
 * The result-side path (`withPreviewLimit` / `prefixTreeLines`) hangs the same indent, minus the dot
 * — the user's second-round call on 2026-09-21 moved both sides one column right together, so the
 * width budgets of both sides must change together (see `INDENT_WIDTH`).
 *
 * Once moved inside, children render wider than they would inside `Box`, so callers must deduct the
 * spent columns themselves (`width - GUTTER_WIDTH - INDENT_WIDTH` in `renderCall` /
 * `withPreviewLimit`).
 */
function withHeadBar(lines: string[], bar: string): string[] {
	return lines.map((line, index) => (index === 0 ? `${bar} ${line}` : `  ${line}`));
}

/**
 * Which slot's color should paint the state dot for this command right now (user decision
 * 2026-09-21; the coloring logic **did not change by one character** when the glyph changed from `▎`
 * to `•`):
 *
 *   - running (`isPartial`) → `dim` (dark gray)
 *   - finished OK → `toolDiffAdded` (the green of diff added-lines)
 *   - finished failed → `toolDiffRemoved` (the red of diff removed-lines)
 *
 * All three slots are **required** in pi's theme schema (present in built-in dark / light and all
 * three custom skins), so unlike `bashOutput` no probe is needed; what is taken is the **foreground**
 * ANSI followed by a `\x1b[39m` terminator, so the color cannot bleed onto the `Run` after it.
 */
function stateBarAnsi(theme: any, isPartial: boolean, isError: boolean): string {
	const slot: ThemeColor = isPartial ? "dim" : isError ? "toolDiffRemoved" : "toolDiffAdded";
	return `${theme.getFgAnsi(slot)}\u2022\u001b[39m`;
}

/**
 * Columns the tree gutter occupies (`│ ` / `└ ` = 1 box-drawing char + 1 space = 2 columns).
 * Output child components must render at `width - GUTTER_WIDTH - INDENT_WIDTH`, or adding the prefix
 * overflows.
 */
const GUTTER_WIDTH = 2;
/**
 * The one extra column yielded beyond the gutter inside the block's **left margin** (the user's
 * second-round call on 2026-09-21: body shifted one more column right, `• Run …` rather than `▎Run …`).
 *
 * The command side and the result side **use the same value**: the command's first row is `• ` (dot
 * + space) and every result-tree row gets this extra cell in front (a command continuation prefix
 * `│ ` already carries one space, so it only needs this column added left of `COMMAND_PROMPT`).
 * Equal width on both sides keeps command and result aligned — change one side and you must change
 * the other.
 */
const INDENT_WIDTH = 1;
/** Tree rows of "more follows": command continuations, the command collapse marker, output truncation hints. */
const GUTTER_PIPE = COMMAND_CHAIN;
/** Continuation indent for "body content" in the tree (same width as `└ ` + block left margin — body stays aligned). */
const GUTTER_BODY = COMMAND_INDENT + " ".repeat(INDENT_WIDTH);
/** The one column beyond the gutter in the block's left margin (`INDENT_WIDTH` spaces), hung in front of **every** result row. */
const INDENT = " ".repeat(INDENT_WIDTH);

/**
 * The shape of the truncation-hint line the output preview supplies itself (`… (N earlier lines,
 * <key> to expand)`).
 */
function isPreviewHintLine(line: string): boolean {
	const plain = stripAnsiCodes(line);
	// `... ` is pi's built-in spelling (`truncateToWidth`'s ellipsis); `… ` is the one we
	// rewrite in `trimPreviewLines` — both shapes must be recognized.
	return (plain.startsWith("... (") || plain.startsWith(`${ELLIPSIS} (`)) && plain.includes("earlier lines");
}

/**
 * Whether this (SGR-stripped) plain text is pi's **failure status line**.
 *
 * pi welds the command's failure status **into the output body** — `core/tools/bash.ts` throws
 * `throw new Error(appendStatus(text, status))` in three places, where `appendStatus` is
 * `` `${text ? `${text}\n\n` : ""}${status}` ``. Three statuses: nonzero exit code / killed by
 * timeout / aborted — all failures.
 *
 * The result has no separate field and `details` carries no marker, so **the only way to color it
 * alone is recognizing the text shape**. That is why the caller must also add `context.isError` for
 * "this run really errored" — this function only judges the shape half (see the file header
 * "failure status" section).
 */
function isFailureStatusLine(line: string): boolean {
	const plain = stripAnsiCodes(line).trim();
	return /^Command (?:exited with code \d+|timed out after [\d.]+ seconds|aborted)$/.test(plain);
}

/**
 * Recolor the failure status line to the `error` foreground (called by `prefixTreeLines` before
 * tree-mounting; touches color only, never the text).
 *
 * pi writes `theme.fg("toolOutput", line)` (gray by default) — that row is a single SGR prefix plus
 * a `\u001b[39m` at the end, so stripping and rewrapping in `error` just works (no inner styling is
 * lost: there is none). The end padding is spliced back verbatim, so the visible width is unchanged.
 */
function colorizeFailureStatus(line: string, theme: any): string {
	if (!isFailureStatusLine(line)) return line;
	const padding = /\s+$/.exec(line)?.[0] ?? "";
	return theme.fg("error", stripAnsiCodes(line).replace(/\s+$/, "")) + padding;
}

/**
 * Paint the **whole result**'s line array into a tree: the **first substantive content row** gets
 * `└ `, the rows before it (truncation hints) get `│ `, the rows after it get a two-cell indent
 * (`  `), and blank rows stay blank.
 *
 * The user-specified shape (2026-09-21): `└ ` appears **once in the whole result**, on the first
 * substantive output row; content rows below it (second body row, warnings, the `Took Xs` footer)
 * draw no more verticals — only fixed-width indent aligns the body. The tree "lands" at `└` and
 * does not extend further:
 *
 * ```
 * Run cat big.txt
 * │ … (12 earlier lines, ctrl+o to expand)
 * └ line 12
 *   line 13
 * ```
 *
 * Three non-obvious points:
 *   ① **Prefixes must be applied once over all children's rows** (not one tree per child): `└ ` may
 *     appear only once in the whole block; per-child trees would grow another `└ ` in the second
 *     section (warnings / footer) — observed: two cornered content rows appear in the output.
 *   ② **Leading blank rows get no prefix**: that is the separator row between command and output
 *     (pi's `new Text("\n" + …)`), and the outer `stripLeadingBlanks` still relies on "this row is
 *     empty" to strip it — once prefixed it becomes non-empty and cannot be stripped (the row may
 *     carry a foreground escape sequence, so the emptiness check must strip ANSI before trim — same
 *     check as `stripLeadingBlanks`). A footer / warnings section's own leading blank is likewise
 *     left blank, serving as intra-result paragraph spacing.
 *   ③ The truncation-hint row (`… (N earlier lines, …)`) sits before the body, so it gets `│ `
 *     ("more follows"); `└ ` is reserved for the body's first row.
 *   ④ **The prefix is its own SGR segment** (`theme.fg("muted", GUTTER_PIPE)` wraps it alone) — the
 *     color of the body after it must never bleed up; the corner / vertical are structural glyphs,
 *     so `└ ` and the body after it share one gray.
 *   ⑤ **Blank rows above the bar get `│ ` too** (the user's second report on 2026-09-21: the blank
 *     row between `│ … (326 earlier lines…)` and `└ Node.js v26.4.0` sat bare and looked like a
 *     "break"). Such blanks come from the head of pi's preview window (`truncateToVisualLines` cuts
 *     backwards from the tail and blanks arrive as-is) or the separator blank before a failure
 *     status; `prefixTreeLines` fills `│ ` between `first` (the first non-blank row) and `start`
 *     (the first substantive content row, or the truncation-hint row above it). **Blanks below `└ `
 *     are not filled** — the tree already points at the first substantive output row there, and the
 *     stretch below is indent-aligned continuations (more output, warnings like `[Full output: …]`,
 *     `Took`), each its own section; more verticals would look like the tree continues (the user's
 *     third report on 2026-09-21: the row above `[Full output:` should not have `│`).
 *
 * Why not `setText(child,…)` to rewrite the child component directly: its render cache is fixed at
 * **first-render width** — feeding the prefix in would let it re-wrap the body itself (ANSI-aware
 * greedy word wrap), voiding the whole "wrap first, color after" hard-wrap shell. Rendering child by
 * child + hanging prefixes on the line array never changes row widths, so cache and actual display
 * stay consistent (see `withPreviewLimit`).
 */
function prefixTreeLines(lines: string[], theme: any, isError = false): string[] {
	const isBlank = (s: string) => stripAnsiCodes(s).trim() === "";
	// The leading run of blank rows is the separator between command and result (`stripLeadingBlanks` still relies on it for the empty check),
	// so blanks before `first` stay blank — the tree's starting point is `start` (the first substantive content row, or the truncation-hint row above it).
	let first = 0;
	while (first < lines.length && isBlank(lines[first]!)) first++;
	let start = first;
	while (start < lines.length && (isBlank(lines[start]!) || isPreviewHintLine(lines[start]!))) start++;
	if (start >= lines.length) return lines;
	// Blanks **above** the bar (after `first`, before `start`) get `│ ` — user decision 2026-09-21:
	// a blank row must not break the bar. These blanks come from the head of pi's preview window (`truncateToVisualLines`
	// cuts backwards from the tail, blanks arrive as-is) or the separator blank before a failure status — a bare blank reads as a "break".
	// Blanks **below** `└ ` are not filled: at the `└ ` row the tree already points at the first substantive output, and the stretch below is
	// indent-aligned continuations (more output, warnings like `[Full output: …]`, `Took`), each its own section;
	// more verticals would look like the tree continues (user's second report 2026-09-21: the row above `[Full output:` should not have `│`).
	const pipeBlank = (i: number) => i > first && i < start;
	return lines.map((line, i) => {
		if (isBlank(line)) return pipeBlank(i) ? INDENT + theme.fg("muted", GUTTER_PIPE) + line : line;
		if (i < start) return INDENT + theme.fg("muted", GUTTER_PIPE) + line;
		if (i === start) return INDENT + theme.fg("muted", "└ ") + (isError ? colorizeFailureStatus(line, theme) : line);
		return GUTTER_BODY + (isError ? colorizeFailureStatus(line, theme) : line);
	});
}

/**
 * The duration footer's **plain-text shape**: `Took 0.1s` (finished) / `Elapsed 1.2s` (streaming
 * mid-run, ticking every second). The decimal places are fixed by pi's `formatDuration`
 * (`(ms / 1000).toFixed(1)`, always one digit).
 */
const TIME_FOOTER_PATTERN = /^(?:Took|Elapsed) \d+\.\d+s$/;

/** Strip SGR escape sequences (the footer row is wrapped in `theme.fg("muted", …)` — both shape check and blank check must strip first). */
function stripAnsiCodes(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Whether this child is pi's **duration footer** (`new Text("\n" + theme.fg("muted", "Took 0.1s"), 0, 0)`).
 *
 * Both checks are required:
 *   ① `setText` exists = it is pi-tui's `Text` — `instanceof` cannot be used, for exactly the same
 *      reason as the preview component's duck check (the pi-tui an extension imports is the npm/dist
 *      copy the loader alias points to, a different class object from the `Text` in pi's runtime
 *      bundle; `instanceof` across instances is always false);
 *   ② after stripping ANSI and trimming it is exactly the `Took 0.1s` / `Elapsed 1.2s` shape.
 * The position condition (**must be the last child**) is judged alongside by `shouldHideTimeFooter`:
 * pi's `rebuildBashResultRenderComponent` addChilds in "output → warnings → footer" order, so the
 * footer is always last. Only both together justify calling the last child the footer — position
 * alone would delete "output body happens to be one `Took 1.2s` row" (in expanded state the body is
 * one `Text`), and shape alone would delete a lookalike last child.
 */
function isTimeFooterChild(child: any): boolean {
	if (typeof child?.setText !== "function" || typeof child.text !== "string") return false;
	return TIME_FOOTER_PATTERN.test(stripAnsiCodes(child.text).trim());
}

/**
 * Whether the duration footer should be dropped wholesale: **executions shorter than the threshold
 * do not draw that row** (default 2000ms, see `DEFAULT_MIN_TIME_FOOTER_MS`).
 *
 * `elapsedMs === undefined` means the duration is simply unknown (`state.startedAt` empty —
 * `/resume`d history blocks never call `markExecutionStarted`) — in that case pi had no footer to
 * draw anyway, so return false and keep hands off: "the output body happens to be one `Took 1.2s`
 * row" in expanded state will not be deleted by mistake. The threshold is compared against the
 * **same quantity** pi draws (`endedAt - startedAt`, see `elapsedMs` in renderResult), not the
 * rounded number on the footer.
 */
function shouldHideTimeFooter(lastChild: any, elapsedMs: number | undefined, minTimeFooterMs: number): boolean {
	if (elapsedMs === undefined || elapsedMs >= minTimeFooterMs) return false;
	return isTimeFooterChild(lastChild);
}

/**
 * Trim pi's built-in bash renderer's **output preview** from 5 lines to `previewLines`, mount the
 * tree gutter on the whole result, drop the duration footer on short commands, and supply `(no
 * output)` when there is none.
 *
 * pi's line count is hardcoded in its `BASH_PREVIEW_LINES = 5` (a module-private constant —
 * unchangeable, and no setting), so the only option is post-processing its component after the fact.
 * See the file header "output preview line count".
 *
 * The approach: **render child by child** rather than taking the whole Container's flattened row
 * array — in a flat array you cannot tell which rows belong to the preview (preview rows, warning
 * rows, and the Took row are all plain text in different foregrounds; guessing by color is fragile).
 * The child structure was verified: with non-empty output `children[0]` is the preview component,
 * whose row shape is fixed `["", (hint row?), ...preview rows]`; the warnings / `Took Xs` after it
 * are `Text` instances (each one's `\n` prefix renders as one blank row + body).
 *
 * The preview component is recognized by **duck typing** (`typeof child.setText !== "function"`)
 * rather than `instanceof Text`: the pi-tui an extension imports is the npm/dist copy the loader
 * alias points to — a different class object from the Text in pi's runtime bundle, so `instanceof`
 * across module instances is always false.
 *
 * All children's rows are first **spliced verbatim into one array**, then handed to
 * `prefixTreeLines` for a single tree pass — so `└ ` naturally lands on the **first substantive
 * content row** (the first body row of the output section; the truncation-hint row above it gets
 * `│ `), and later output rows / warnings / the `Took` footer only indent two cells.
 *
 * **Expanded state (ctrl+o) skips the whole block**: pi then uses `new Text("\n" + styledOutput)` —
 * one child holding all output, row count untrimmed — so not even the tree is mounted; expanded
 * means verbatim full output.
 *
 * The duration-footer filter (`shouldHideTimeFooter`) also lives here: when the last child is the
 * `Took X.Xs` footer and the real duration is below the threshold, it is skipped wholesale
 * (including its leading blank row — the separator between body and footer, which must not remain
 * when the footer is not drawn). See the file header "duration-footer threshold".
 */
function withPreviewLimit(
	inner: any,
	previewLines: number,
	theme: any,
	/** Expanded state (ctrl+o): pass the whole block through verbatim (no trimming, no tree). */
	expanded: boolean,
	/** pi currently gives a partial result (mid-stream) — decides whether "no output yet" should render as `(no output)`. */
	isPartial: () => boolean,
	/** This result is an error (`context.isError`) — failure status is only recognized when this is true, to avoid dyeing normal output. */
	isError: boolean,
	/** Real duration (ms; `undefined` = pi drew no footer at all). */
	elapsedMs: () => number | undefined,
	minTimeFooterMs: number,
) {
	return {
		render(width: number): string[] {
			const out: string[] = [];
			let trimmed = false;
			// The prefix takes gutter + left margin = 3 columns, so **the output preview renders at width - 3**: pi's preview rows wrap / truncate
			// against the width passed in (`truncateToVisualLines` internally calls `Text.render(width)`);
			// rendering at full width and then prefixing would overflow the terminal (`Box.applyBg` only clips — content would be lost).
			const contentWidth = Math.max(1, width - GUTTER_WIDTH - INDENT_WIDTH);
			// The duration-footer check lives inside render rather than being fixed when the component is grabbed: in streaming mode pi
			// `invalidate()`s once per second (the setInterval in the built-in renderResult), so the footer can appear the moment
			// the threshold is crossed, without waiting for the next partial result.
			let children: any[] = inner.children ?? [];
			if (shouldHideTimeFooter(children[children.length - 1], elapsedMs(), minTimeFooterMs)) {
				children = children.slice(0, -1);
			}
			// Expanded state (ctrl+o) means verbatim full output: no trimming, no gutter. pi uses
			// `new Text("\n" + styledOutput)` there — one child holds all output, passed through —
			// only the failure-status row is dyed red (the user wants the notice to be red; expanded state should be red too).
			// The left margin is still mounted (only the `INDENT_WIDTH` column, no gutter): in expanded state the output body column
			// lands in the same column-2 family as collapsed, so toggling ctrl+o does not make the block jump sideways.
			if (expanded) {
				const expandedWidth = Math.max(1, width - INDENT_WIDTH);
				for (const child of children) {
					const rendered = child.render(expandedWidth) as string[];
					out.push(...(isError ? rendered.map((line) => colorizeFailureStatus(line, theme)) : rendered).map((line) => INDENT + line));
				}
				return out;
			}
			for (const child of children) {
				const isOutput = !trimmed && typeof child.setText !== "function";
				if (!isOutput) {
					// For empty output pi adds no child at all (the built-in renderer's `if (output)` guard),
					// leaving the user a bare `Run xxx` line — cannot tell "really no output" from
					// "rendering broke". A `(no output)` row is supplied **where the output would appear** (in the user's sample
					// `└ ` hangs right in front of it), placing it before warnings / `Took`.
					// **Not supplied mid-execution**: in streaming mode pi first sends an empty partial snapshot
					// (`onUpdate({ content: [] })`), where "no output yet" does not mean "no output".
					out.push(...(trimmed || isPartial() ? child.render(contentWidth) : [theme.fg("toolOutput", "(no output)"), ...child.render(contentWidth)]));
					continue;
				}
				trimmed = true;
				// **The output section renders at contentWidth**: every row of the result gets a 2-column prefix; rendering at full width
				// without deducting it would push wrapped body past the terminal width.
				out.push(...trimPreviewLines(child.render(contentWidth), previewLines, contentWidth, theme, isError));
			}
			// Finally mount the tree in one pass: `└ ` appears once in the whole block (see prefixTreeLines ①)
			return prefixTreeLines(out, theme, isError);
		},
		invalidate() {
			inner.invalidate?.();
		},
	};
}

/**
 * Trim preview rows beyond the budget (keeping the **tail** — pi's preview is the output's last rows
 * anyway), and fold the trimmed count into the hint row's number.
 *
 * The hint row has two cases:
 *   ① pi already emitted one (output > 5 rows) — rewrite its number **in place**, leaving pi's
 *     colors and the real key name (the dim key name + muted description `keyHint` rendered)
 *     untouched, no style rebuilding. The regex matches plain ASCII digits and text inside SGR
 *     wrapping, so replacing on the styled string is safe.
 *   ② pi emitted none (output ≤ 5 rows, but we trimmed to 3) — a row must be fabricated, or those
 *     1-2 rows **silently disappear**. Replicate pi's format and colors with the passed-in `theme`
 *     (the one pi's runtime actually initialized); the key name is read from `keybindings.json`
 *     (see `expandKeyText`).
 */
function trimPreviewLines(lines: string[], previewLines: number, width: number, theme: any, isError: boolean): string[] {
	if (lines.length <= 1) return lines;
	const head = lines[0]; // leading blank row (kept or dropped at the outer stripLeadingBlanks' discretion)
	const body = lines.slice(1);
	const hintLine = isPreviewHintLine(body[0] ?? "") ? body[0] : undefined;
	const rows = hintLine ? body.slice(1) : body;

	// ① When the tail is pi's failure status (see the file header "failure status"), lift it together with the run of separator blanks
	// before it for separate handling: those blanks carry no information and must not eat preview budget (they are exactly what pushed
	// the status itself out of view). **Only recognized under `isError`** — the same words appearing in normal output (e.g. echoed back) are left alone.
	let status: string | undefined;
	let separators: string[] = [];
	let content = rows;
	if (isError && rows.length > 0 && isFailureStatusLine(rows[rows.length - 1]!)) {
		status = rows[rows.length - 1];
		let cut = rows.length - 1;
		while (cut > 0 && isBlankResultLine(rows[cut - 1]!)) cut -= 1;
		separators = rows.slice(cut, rows.length - 1);
		content = rows.slice(0, cut);
	}

	// ② Budget: the status takes one slot itself; the rest goes to content.
	const budget = Math.max(1, previewLines - (status === undefined ? 0 : 1));

	// ③ Window = the content's last `budget` rows (pi's preview keeps the tail anyway). When the whole window is blank rows,
	// pull it upward so the most recent body row stays in the window — blank rows must not hog the preview.
	let start = Math.max(0, content.length - budget);
	let end = content.length;
	if (content.length > 0 && content.slice(start).every((line) => isBlankResultLine(line))) {
		let last = content.length - 1;
		while (last >= 0 && isBlankResultLine(content[last]!)) last -= 1;
		if (last >= 0) {
			start = Math.max(0, last - budget + 1);
			end = last + 1;
		}
	}
	const window = content.slice(start, end);

	// ④ When not a single body row survives (content fully trimmed), put back the separator blanks before the status — the user's
	// 2026-09-21 shape: blanks carry `│`, not bare emptiness (see file header ⑤). Not restored when there is body:
	// `└ ` already landed on the body, and another `│` below it would look unfinished.
	const fillers = window.length === 0 && status !== undefined ? separators.slice(-budget) : [];

	// Nothing moved (no status, the window is the whole content, no blanks restored) → return `lines` verbatim: keeps pi's own
	// rows (the hint row's colors and wrap width are its decisions). Only the hint row's ellipsis is unified to `…`.
	if (status === undefined && fillers.length === 0 && window.length === content.length && end === content.length) {
		return hintLine === undefined ? lines : [head, withOurEllipsis(hintLine), ...rows];
	}

	// ⑤ The hint row's count = pi's original number (visual rows above its window) + our content rows not shown.
	// The separator blanks before the status do not count (they carry no information: counting them would give a failed command
	// whose content was fully shown a phantom `(2 earlier lines)` — observed).
	const hidden =
		(hintLine ? Number(/(\(\s*)(\d+)(\s*earlier lines)/.exec(hintLine)?.[2] ?? 0) : 0) + (content.length - window.length);
	const rendered: string[] = [];
	if (hidden > 0) {
		const hint = hintLine
			? withOurEllipsis(hintLine.replace(/(\(\s*)(\d+)(\s*earlier lines)/, (_m, open, _count, tail) => `${open}${hidden}${tail}`))
			: theme.fg("muted", `${ELLIPSIS} (${hidden} earlier lines,`) +
			  (expandKeyText() === "" ? "" : ` ${theme.fg("dim", expandKeyText())}`) +
			  theme.fg("muted", " to expand)");
		rendered.push(truncateToWidth(hint, width, ELLIPSIS));
	}
	return [head, ...rendered, ...fillers, ...window, ...(status === undefined ? [] : [status])];
}

/** pi's hint row uses three dots (`truncateToWidth`'s ellipsis); this extension unifies to a single `…`. */
function withOurEllipsis(line: string): string {
	return line.replace("...", ELLIPSIS);
}

/** Whether a (styled) result row is empty once SGR is stripped. */
function isBlankResultLine(line: string): boolean {
	return stripAnsiCodes(line).trim() === "";
}

/**
 * Inside a **synchronous window**, temporarily swap the theme's `toolOutput` to `bashOutput`, so the
 * output body painted by pi's built-in bash result renderer picks up its own color slot (see the
 * file header "independent color for the output body").
 *
 * Why it must be "swap the theme table" and not "hand a different theme object to the renderer":
 * pi's bash renderer **never looks at the theme parameter passed in** (`renderResult(result,
 * options, _theme, context)`) — it uses the module-level `theme` singleton (`Proxy` →
 * `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]`). That singleton and the renderer
 * parameter the extension receives **are the same object** (the singleton exists for cross-loader
 * sharing), so mutating its `fgColors` table makes the renderer's next `theme.fg("toolOutput",
 * line)` hit the new value.
 *
 * Four points:
 *   ① **Swap only inside the synchronous window**: `base.renderResult()` is synchronous — the output
 *      rows (expanded-state copy included) are all `theme.fg("toolOutput", …)`-baked into strings in
 *      this one call, so swapping in/out under try/finally cannot catch a second render; nor does
 *      the color **leak** to other tools (read / grep outputs are painted by their own renderers,
 *      outside this window).
 *   ② **If the theme has no `bashOutput`, do nothing** (built-in themes and pi-coder-summer-night /
 *      pi-coder-catppuccin all lack the token) — the probe is one real `theme.getFgAnsi()` call; pi
 *      throws `Unknown theme color: …` on unknown tokens.
 *   ③ `fgColors` is a public field of pi's `Theme` class (`Map<string, string>`, holding **resolved
 *      SGR prefixes**); if pi ever hides/renames it, this degrades to calling through unchanged (the
 *      `typeof … .set` check before returning), never throws — the color just stops applying.
 *   ④ Only `toolOutput` is touched: the command title / `... (N earlier lines …)` hint / `Took Xs`
 *      footer go through `toolTitle` / `muted`, and the command line and collapse hints are
 *      self-drawn — all unaffected.
 */
function withBashOutputColor<T>(theme: any, render: () => T): T {
	const fgColors = theme?.fgColors;
	if (typeof fgColors?.set !== "function" || typeof fgColors?.get !== "function") return render();
	let override: string;
	try {
		override = theme.getFgAnsi("bashOutput");
	} catch {
		return render();
	}
	const previous = fgColors.get("toolOutput");
	fgColors.set("toolOutput", override);
	try {
		return render();
	} finally {
		if (previous === undefined) fgColors.delete("toolOutput");
		else fgColors.set("toolOutput", previous);
	}
}

export default function (pi: ExtensionAPI) {
	// Collapse is fixed on, keeping DEFAULT_LINES visual rows (the old `/bash-collapse` command was deleted).
	// Output preview line count: pi's built-in is hardcoded at 5 (`BASH_PREVIEW_LINES`, module-private constant + no setting),
	// so only post-processing in the extension can change it. /bash-preview adjusts; PI_BASH_PREVIEW overrides at startup.
	let previewLines = clampPreviewLines(Number(process.env.PI_BASH_PREVIEW));
	// Duration-footer threshold (ms): executions shorter than it draw no `Took X.Xs` row (see file header "duration-footer threshold").
	// PI_BASH_MIN_TIME_MS=0 always shows. Read once at registration, like previewLines.
	// Streaming output switch: default off (non-streaming, aligned with opencode / codex). PI_BASH_STREAM=on restores pi's native streaming.
	const streaming = process.env.PI_BASH_STREAM?.trim().toLowerCase() === "on";
	// Duration-footer threshold (ms): executions shorter than it draw no `Took X.Xs` row (see file header "duration-footer threshold").
	// PI_BASH_MIN_TIME_MS=0 always shows. Read once at registration, like previewLines.
	const minTimeFooterMs = resolveMinTimeFooterMs(process.env.PI_BASH_MIN_TIME_MS);
	// Command syntax-highlight switch: default on. PI_BASH_HIGHLIGHT=off disables at startup (back to whole-line toolTitle bold).
	// Deliberately **no /bash-highlight command** — a pure visual toggle needs only the env entry point,
	// no reason to spend a slash command on it (unlike /bash-preview / /bash-timeout which are checked on the fly).
	// Expanded (ctrl+o) and collapsed share the same tokenizer, so the switch affects both.
	const highlightEnabled = process.env.PI_BASH_HIGHLIGHT?.trim().toLowerCase() !== "off";

	// ## Capability boundary (seatbelt sandbox) switch
	//
	// PI_SANDBOX=off disables it entirely; non-darwin platforms disable it automatically (no sandbox-exec —
	// better to lose this layer than fail every command with a missing binary).
	// Read once at registration: this is a startup switch — changing env mid-run must not make the same command sandboxed one moment and not the next.
	const sandboxOn = isSandboxEnabled();
	// Which shell runs the original command inside the sandbox. Consistent with readShellOptions(): the user's shellPath wins,
	// else /bin/bash. Note this is the shell **inside** the sandbox, unrelated to the outer shell pi itself spawns.
	const sandboxShellPath = readShellOptions().shellPath || "/bin/bash";
	// Persistent allowlist (`~/.pi/agent/sandbox-allowlist.json`, relocatable via `PI_SANDBOX_ALLOWLIST`).
	// Shares one globalThis singleton with the sandbox-boundary extension, so one side remembering takes effect on the other immediately.
	const allowlistPath = process.env.PI_SANDBOX_ALLOWLIST?.trim() || join(getAgentDir(), "sandbox-allowlist.json");
	// The IO that path classification needs (realpath / isDirectory) is injected here; sandbox.ts stays pure logic.
	const pathEnv: PathEnv = {
		home: homedir(),
		realpath: (p) => {
			try {
				return realpathSync(p);
			} catch {
				return undefined; // target does not exist (already deleted): lexical check only
			}
		},
		isDirectory: (p) => {
			try {
				return statSync(p).isDirectory();
			} catch {
				return false;
			}
		},
	};
	const sessionScopes = getSessionScopes();
	/** Get the allowlist store. env is only used for load-time filtering on first creation. */
	const allowlist = (): AllowlistStore => getAllowlistStore(allowlistPath, pathEnv);

	// cwd is only a fallback: the built-in execute uses ctx.cwd (the current session cwd of each call).
	const base: ToolDefinition<any, any, any> = createBashToolDefinition(process.cwd(), readShellOptions());

	pi.registerTool({
		name: base.name,
		label: base.label,
		// Copied from Claude Code: the default deadline and cap are **written into the tool description** for the model — otherwise
		// it does not know it can pass timeout, and long commands get killed by the default without knowing to raise it.
		// (The built-in description originally ended with just "Optionally provide a timeout in seconds." — no numbers.)
		description: `${base.description} By default, your command will time out after ${defaultTimeoutSeconds()} seconds. You may specify an optional timeout in seconds (up to ${maxTimeoutSeconds()} seconds); larger values are clamped to that maximum.`,
		parameters: base.parameters,
		// prompt metadata is not inherited from the built-in tool; it must be carried over explicitly
		promptSnippet: base.promptSnippet,
		promptGuidelines: base.promptGuidelines,
		constrainedSampling: base.constrainedSampling,
		executionMode: base.executionMode,
		prepareArguments: base.prepareArguments,
		// `renderShell: "self"` is what makes "not a single row on screen while command chars stream in" possible.
		// Under the default shell, ToolExecutionComponent's constructor keeps a permanent `Spacer(1)`, and render() goes
		// through `super.render(width)` (Container), painting every child — so even when renderCall
		// returns a zero-line component, that one blank row still renders (observed `[""]`). And the `hideComponent` path
		// is unreachable: in updateDisplay() any successful callRenderer return sets `hasContent` true —
		// all three branches set it, so the trailing `if (… && !hasContent …) hideComponent = true` never holds.
		// In self mode render() bypasses super.render() and only paints selfRenderContainer, so that Spacer
		// is never rendered; and the `contentLines.length === 0 → return []` guard at the top
		// delivers a true "empty means nothing painted". A side effect (**deliberately kept**): pi no longer wraps the block in bgFn
		// (under the default shell, contentBox wraps toolPendingBg / toolSuccessBg / toolErrorBg),
		// and we do not wrap one either — so the bash block has **no background at all** (user decision 2026-09-21, see file header
		// "the whole block has no background"). Other tools do not go through this path; their backgrounds are unaffected.
		renderShell: "self",
		// renderResult delegates to the built-in bash implementation (output preview / truncation hint / "Took Xs" are all its),
		// wrapped only in an **unbackgrounded** Box for the left margin; the footer row is filtered by threshold inside withPreviewLimit.
		// Note the `lastComponent` passed to the built-in must be the
		// **inner** component, not our Box — the built-in does `context.lastComponent ?? new
		// BashResultRenderComponent()` then clear() / addChild() on it; feeding it a Box would nest wrongly.
		// So the inner component lives in context.state for reuse across calls (state already stores startedAt/endedAt/interval).
		renderResult(result, options, theme, context) {
			const state = context.state;
			// renderCall uses this flag to decide whether to add the bottom boundary blank itself (only before the result arrives).
			// Set **before** delegating to the built-in: if the built-in throws, pi falls back to its own
			// fallback result component, which then owns the bottom boundary.
			state.resultSeen = true;
			// output body switches to the theme's `bashOutput` slot (no-op if the theme lacks it; see withBashOutputColor)
			const inner = withBashOutputColor(theme, () =>
				base.renderResult(result, options, theme, { ...context, lastComponent: state.innerComponent }),
			);
			state.innerComponent = inner;
			// isError must be read from **context**, not result: what pi passes to the resultRenderer is
			// `{ content: this.result.content, details: this.result.details }` — **no isError field**
			// (tool-execution.js's updateDisplay); isError only exists in getRenderContext()
			// (`isError: this.result?.isError ?? false`). Reading result.isError would yield undefined forever,
			// and failed commands would be dyed the success color.
			//
			// paddingY must be 0, and inner's leading blanks must be stripped — otherwise there would be
			// **three** blank rows between command and output (observed): ① callBox's bottom padding, ② resultBox's top padding,
			// ③ the built-in renderResult's own `new Text("\n" + styledOutput)` leading blank.
			// Row ③ under the default shell is "one row of spacing between command and output" (both then live in the same
			// contentBox with only that row between), but in self mode they are two separate Boxes
			// whose paddingY would stack, so all three are removed here and output sits flush under the command.
			// Nor is a bottom boundary blank added outside the block (user decision 2026-09-21: no blank space top or bottom —
			// see file header "no background, no boundary blanks").
			// Duration-footer threshold check (see file header "duration-footer threshold"): the **same quantity** pi prints —
			// `state.endedAt ?? Date.now()` minus `state.startedAt` (the built-in renderResult just filled endedAt in the call above).
			// Made a **function**, evaluated at render time: in streaming mode pi invalidates once per second,
			// so the footer appears naturally the moment the threshold is crossed, without waiting for the next partial.
			// Empty startedAt = pi drew no footer at all (`/resume`d history blocks never call markExecutionStarted);
			// return undefined then, and the filter logic keeps hands off entirely.
			const elapsedMs = () => (state.startedAt === undefined ? undefined : (state.endedAt ?? Date.now()) - state.startedAt);
			// `new Box(1, 0)`: **only the bgFn is gone** (the bash block carries no background — none of pending / success / failure
			// is painted, see file header "no background"); `paddingX: 1` is unchanged — that left-padding cell on the result side
			// aligns with the command line's `• ` (`withPreviewLimit` then mounts the `INDENT_WIDTH` column); removing it would leave
			// the block one column short of the command line; `paddingY: 0` leaves no blank rows above or below.
			const box = new Box(1, 0);
			box.addChild(
				stripLeadingBlanks(
					withPreviewLimit(inner, Math.max(1, Math.round(previewLines)), theme, options.expanded === true, () => options.isPartial === true, context.isError === true, elapsedMs, minTimeFooterMs),
				),
			);
			return box;
		},

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Turning streaming off means stripping onUpdate: every update point in the built-in execute is !onUpdate-guarded,
			// so the renderer only receives the final result. Return value and details are unaffected.
			//
			// At the same time the **effective deadline** is injected into params: pi's built-in bash has no default timeout — without
			// injection a command that never exits would hang forever. The injection only affects this run — the
			// toolCall.arguments persisted to the session are the model's verbatim copy, never rewritten.
			const nextParams = { ...params, timeout: effectiveTimeoutSeconds(params?.timeout) };
			const runOnUpdate = streaming ? onUpdate : undefined;

			// ## Capability boundary (seatbelt sandbox)
			//
			// The enforcement point is not "enumerating dangerous commands" but the **operating system**: the command runs inside
			// sandbox-exec; writes are unrestricted and only **deletion** is narrowed to the project directory + temp directories —
			// an out-of-boundary unlink is rejected by the kernel with EPERM (rename also goes through unlink — see the sandbox.ts header).
			// So normal operations never prompt; an out-of-boundary delete fails first — the user is only asked after failure.
			// This is Codex's model, and the only fail-closed one.
			//
			// Two authorization layers (user decision 2026-09-24):
			// - **dangerous directories** (system roots / bin / app install dirs / config kinds) ask every time, session-level exemption only;
			// - **ordinary directories** ask once, and on approval the directory scope is written to the persistent allowlist — never asked again (headless included).
			// Remembering a directory = merging it into the profile's `(allow file-write-unlink …)` — the delete succeeds inside
			// the sandbox while the rest of the command stays sandboxed — hence zero prompts and zero reruns for common paths.
			//
			// The wrapping only happens on this local params copy: the session persists the model's verbatim command,
			// and the renderer displays the original command too (not the sandbox-exec prefix string).
			const command = typeof params?.command === "string" ? params.command : "";
			if (!sandboxOn || command.trim() === "") {
				return base.execute(toolCallId, nextParams, signal, runOnUpdate, ctx);
			}

			const boundary = boundaryFromEnv(ctx?.cwd ?? process.cwd());
			// The profile carries the persistent allowlist + session exemptions: authorized directories enter the allow line
			// before the command runs, so deletes succeed inside the sandbox — no prompt, no rerun.
			const extraRoots = [...allowlist().roots(), ...sessionScopes.roots()];
			const wrapped = wrapWithSandbox(command, buildSeatbeltProfile(boundary, extraRoots), sandboxShellPath);

			let denialMessage: string | undefined;
			try {
				return await base.execute(toolCallId, { ...nextParams, command: wrapped }, signal, runOnUpdate, ctx);
			} catch (err) {
				// The built-in bash throws on nonzero exit, and the output body lives in the message — exactly the place to check
				// "was it the sandbox". Only EPERM / Operation not permitted count:
				// `Permission denied` is EACCES (file permission bits), not the sandbox — using it as the escalation signal
				// would misreport "this file was never permitted" as "sandbox-blocked".
				const message = err instanceof Error ? err.message : String(err);
				if (!looksLikeSandboxDenial(message)) throw err;
				denialMessage = message;
			}

			// ---- blocked by the sandbox: extract the denied paths from the failure output, go through two-layer authorization by directory ----
			const deniedPaths = extractDeniedPaths(denialMessage ?? "");
			if (deniedPaths.length === 0) {
				// No path extractable → when the target cannot be guessed, the by-directory memory logic must not run (same policy as
				// AGENTS.md's "Never derive a delete target").
				//
				// Here there is **no prompt** and no bare rerun outside the sandbox: the old behavior was "ask once at session level for the
				// whole command, rerun it outside the boundary on approval" — and that fallback branch is exactly where the heredoc
				// false positive (`/bin/bash: cannot create temp file for here document: EPERM`) got extracted as
				// "deleting /bin/bash" and popped the dangerous-directory dialog. `extractDeniedPaths` now uses exclusion to reject
				// such non-delete shapes at the source, so when no path is extracted only two possibilities remain: it truly was not a delete
				// (exec failure, nested sandbox unavailable), or it is a delete shape we do not recognize — both deserve
				// reporting as-is, not rerunning the whole command outside the entire boundary (that would hand over all deletion
				// capability for an unrecognized target). The way out is `/sandbox-boundary allow <dir>` — authorize and retry;
				// that path goes through the same safety gate and cannot persist a dangerous directory.
				//
				// Interactive and non-interactive (headless) take the same path: report the error as-is plus a `[sandbox]` hint line.
				throw new Error(
					`${denialMessage}

[Sandbox] Could not identify the blocked path; no confirmation dialog was shown. ` +
						`If deletion is intended, authorize it with /sandbox-boundary allow <directory>, then retry.` +
						`
Deletion boundary: ${writableRoots(boundary).join(", ")}`,
				);
			}

			const classification = classifyOutsidePaths(deniedPaths, {
				boundary,
				allowedRoots: allowlist().roots(),
				sessionRoots: sessionScopes.roots(),
				env: pathEnv,
			});

			// Never-delete tier: **no prompt, no override option at all**. The kernel deny line already blocked it
			// (`buildSeatbeltProfile` revokes after the allow lines); here we only explain why.
			// Interactive and headless take the same path — there is no "approve" action to give anyway.
			if (classification.blocked.length > 0) {
				throw new Error(
					`${denialMessage}

[Sandbox] These identity, credential, or manually maintained configuration paths are protected from deletion, regardless of authorization:
` +
						classification.blocked.map((d) => `  ${d.path}（${d.reason}）`).join("\n") +
						`
If deletion is necessary, perform it yourself in a terminal (or disable this layer with PI_SANDBOX=off).`,
				);
			}

			if (classification.dangerous.length === 0 && classification.ordinary.length === 0) {
				// All authorized yet still blocked: the allowlist may have just been updated on the other side (sandbox-boundary / manual allow)
				// while this run's profile was built before the update. Rerun once with the freshest list;
				// still blocked → report the error — no looping, and no escalation outside the sandbox.
				const retryRoots = [...allowlist().roots(), ...sessionScopes.roots()];
				const retry = wrapWithSandbox(command, buildSeatbeltProfile(boundary, retryRoots), sandboxShellPath);
				try {
					return await base.execute(toolCallId, { ...nextParams, command: retry }, signal, runOnUpdate, ctx);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (looksLikeSandboxDenial(message)) {
						throw new Error(
							`${message}

[Sandbox] Still denied after expanding the allowlist; path detection may be incorrect. ` +
								`Use /sandbox-boundary allow <directory> to authorize the path manually, then retry.`,
						);
					}
					throw err;
				}
			}

			// Unauthorized paths present: non-interactive environments are fail-closed (the persistent allowlist does apply under headless,
			// so reaching here means it did not hit; dangerous directories and unauthorized ordinary directories are all refused).
			if (!ctx?.hasUI) {
				const denied = [...classification.dangerous.map((d) => d.path), ...classification.ordinary];
				throw new Error(
					`${denialMessage}

[Sandbox] This command deletes unauthorized paths outside the deletion boundary; escalation is unavailable in non-interactive mode.
` +
						`Target: ${denied.join(", ")}\n` +
						`Deletion boundary: ${writableRoots(boundary).join(", ")}\n` +
						`Persistent allowlist: ${allowlist().roots().length} entries (view with /sandbox-boundary)`,
				);
			}

			const hasDangerous = classification.dangerous.length > 0;
			const foldPaths = (paths: readonly string[], limit = 3): string => {
				const shown = paths.slice(0, limit).map((p) => `  ${p}`);
				if (paths.length > limit) shown.push(`  … plus ${paths.length - limit} matches`);
				return shown.join("\n");
			};
			// Before prompting, compute "the scope that will be remembered" and state it in the dialog — the user approves that scope,
			// not unlimited authorization.
			const ordinaryScopes = memoryScopesFor(classification.ordinary, pathEnv, boundary.cwd);
			const dangerousScopes = classification.dangerous.map((d) => sessionScopeFor(d.path, pathEnv, boundary.cwd));

			let choice: string | undefined;
			if (hasDangerous) {
				// A dangerous directory present: use the stricter option set. Ordinary paths are listed too but can only ride along with this
				// approval (to remember them permanently they need their own ordinary-tier prompt on a command without dangerous paths).
				// pi's select only takes (title, options): the body must be spliced into the title (same approach as destructive-guard).
				const lines = [
					`⚠️ ${ESCALATION_TITLE} (high-risk directory)`,
					"",
					`Command: ${truncateToWidth(command, 160)}`,
					"",
					"High-risk paths (confirmation on each deletion; session-only exemptions):",
					foldPaths(classification.dangerous.map((d) => `${d.path}（${d.reason}）`)),
				];
				if (classification.ordinary.length > 0) {
					lines.push("", "Also includes ordinary out-of-boundary paths (approve this time only; not remembered):", foldPaths(classification.ordinary));
				}
				lines.push("", "Approval reruns the command, including any parts that already executed.", "Choose Deny to leave everything untouched.");
				choice = await ctx.ui.select(lines.join("\n"), ["Deny", "Allow once", "Allow for this session"]);
			} else {
				const lines = [
					`⚠️ ${ESCALATION_TITLE}`,
					"",
					`Command: ${truncateToWidth(command, 160)}`,
					"",
					"Delete targets (outside the deletion boundary):",
					foldPaths(classification.ordinary),
					"",
					ordinaryScopes.length > 0
						? `Remember these paths: ${ordinaryScopes.join(", ")} (future deletions within these directories will not prompt)`
						: "No safe persistent scope can be determined for these paths; approve each request individually.",
					"",
					"Approval reruns the command, including any parts that already executed.",
					"Choose Deny to leave everything untouched.",
				];
				choice = await ctx.ui.select(lines.join("\n"), [
					"Deny",
					"Allow for this session (and remember the directory)",
					"Allow once",
				]);
			}

			if (choice === undefined || choice === "Deny") {
				throw new Error(
					`${denialMessage}

[Sandbox] The user denied deletion outside the boundary: ` +
						[...classification.dangerous.map((d) => d.path), ...classification.ordinary].join(", ") +
						` (deletion boundary: ${writableRoots(boundary).join(", ")})`,
				);
			}

			// Apply authorization per the choice:
			// - `Allow for this session (and remember the directory)` → ordinary paths' scopes are **persisted** (remember still has
			//   the safety gate inside; dangerous scopes cannot get in). The "session" in the name is explained by the parenthetical and
			//   the notify below: it remembers more than `Allow once` — the directory — and still applies after restart.
			// - `Allow for this session` (dangerous branch) → dangerous paths' session scopes enter the session set, expiring on restart
			// - `Allow once` → only widens this one rerun's profile; nothing is remembered
			const onceRoots: string[] = [];
			if (choice === "Allow for this session (and remember the directory)") {
				const remembered = allowlist().remember(ordinaryScopes, "confirm", pathEnv);
				if (remembered.length > 0)
					ctx.ui.notify(
						`Permanently remembered ${remembered.length} directories (persists across restarts); future deletions within them will not prompt`,
						"info",
					);
				// Scopes rejected by the safety gate (no rememberable scope could be computed) still pass for this one run
				onceRoots.push(...ordinaryScopes.filter((s) => !remembered.includes(s)));
			} else if (choice === "Allow for this session") {
				sessionScopes.add(dangerousScopes);
				onceRoots.push(...classification.ordinary.map((p) => sessionScopeFor(p, pathEnv, boundary.cwd)));
			} else {
				// Allow once
				onceRoots.push(...ordinaryScopes, ...dangerousScopes);
			}

			// Rerun inside the sandbox with the just-approved directories (the rest of the command stays sandboxed).
			// Still blocked → report the error; no looping, no escalation outside the sandbox (manual /sandbox-boundary allow is the way out).
			const widenedRoots = [...allowlist().roots(), ...sessionScopes.roots(), ...onceRoots];
			const widened = wrapWithSandbox(command, buildSeatbeltProfile(boundary, widenedRoots), sandboxShellPath);
			try {
				return await base.execute(toolCallId, { ...nextParams, command: widened }, signal, runOnUpdate, ctx);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (looksLikeSandboxDenial(message)) {
					throw new Error(
						`${message}

[Sandbox] Still denied after expanding the approved scope; other paths may be blocked or path detection may be incorrect. ` +
							`Use /sandbox-boundary allow <directory> to authorize the path manually, then retry.`,
					);
				}
				throw err;
			}
		},

		renderCall(args, theme, context) {
			// The built-in renderCall relied on this to time ("Took 1.2s"); overridden, we maintain it ourselves
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}

			// In non-streaming mode, rein in the **command text's per-character refresh** — but split into two points in time (aligned with codex / opencode):
			//   point one: all command chars received (argsComplete) → paint the complete command at once;
			//   point two: command finished → the result is repainted under the command by renderResult.
			// The two points must stay separate: gating on isPartial would hold the command back until after the result, becoming
			// "everything waits for the result" — not the desired effect.
			//
			// Why the command refreshes char by char: while the model generates the tool call, its arguments stream in (toolcall_delta
			// piece by piece), and on each piece pi calls updateArgs() → updateDisplay() → repaints renderCall once.
			// So until all chars arrive, return a **zero-line component** (not even a placeholder row); the complete command appears after argsComplete.
			// Measured, this stretch dominates: `echo hello` takes ~290ms from toolcall_start to tool_execution_end —
			// 197ms of args streaming, 63ms toolcall_end→execution_start, and only 31ms of actual command execution.
			//
			// argsComplete is set at assistant message_end (setArgsComplete), ~60ms before
			// tool_execution_start — exactly the "command fully received" semantic point.
			// Returning a zero-line component is safe: Box.render begins with a `childLines.length === 0 → []` guard
			// (paddingY is added only after it), so no empty box is painted.
			// (updateDisplay passes a fresh context every time — getRenderContext builds the object on the spot,
			// so argsComplete reads the live value.)
			//
			// **But argsComplete is only set in the live stream**, so the check is "args may still be streaming"
			// rather than "args not finished": pi's interactive-mode.js only calls
			// `component.setArgsComplete()` in the `message_end` branch, while `/resume` (and renderInitialMessages /
			// compaction_end / rebuildChatFromMessages) rebuild history via `renderSessionItems`, which only does
			// `new ToolExecutionComponent(...)` + `component.updateResult(message)` —
			// **never calling setArgsComplete / markExecutionStarted** — so a history block's argsComplete
			// stays false forever. Gating on argsComplete alone would leave resumed bash blocks with only output —
			// the command line gone entirely (observed: RESTORE rendered ["", " hello"] while LIVE rendered
			// ["", " $ echo hello", " hello", "", " Took 0.0s"]).
			// isPartial plugs exactly this gap: true by default at construction, only updateResult(result, false)
			// sets it false — in the live stream that necessarily happens after argsComplete (tool_execution_end);
			// in history rebuilds it happens after the first render. Both paths emit the command, while the streaming phase
			// (isPartial still true) still paints nothing at all.
			// Side effect (acceptable): pressing Esc mid-stream to interrupt a tool call whose args have not finished
			// makes message_end(aborted) call updateResult(isPartial=false) without setting argsComplete —
			// so the command line does appear (with partial args as a `$ ...` placeholder) — seeing which command was
			// interrupted is more useful than a bare error line.
			if (!streaming && !context.argsComplete && context.isPartial === true) {
				return {
					render(): string[] {
						return [];
					},
					invalidate() {},
				};
			}

			const rawCommand = args?.command;
			const invalid = rawCommand !== undefined && rawCommand !== null && typeof rawCommand !== "string";
			const command = typeof rawCommand === "string" ? rawCommand : "";
			const timeout = args?.timeout;

			const commandDisplay = invalid ? theme.fg("error", "[invalid arg]") : command ? command : theme.fg("toolOutput", "...");
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
			// invalid / empty command goes through the pi-tui wrap branch; this row has no body to tokenize, so `Run`'s bold is assembled here
			const styledFull = theme.fg("toolTitle", theme.bold(COMMAND_PROMPT.trimEnd()) + " ") + commandDisplay + timeoutSuffix;

			// Cache lives in the component closure, not state: during streaming the args keep growing,
			// and state is shared by the whole row — caching by width there would return stale lines.
			let cachedWidth: number | undefined;
			let cachedExpanded: boolean | undefined;
			let cachedResultSeen: boolean | undefined;
			let cachedLines: string[] | undefined;

			const component = {
				render(width: number): string[] {
					// `Box`'s paddingX is 0 (the left margin is painted by `withHeadBar`: `• ` first row, two spaces elsewhere),
					// so children get the full width — here the three spent columns are deducted back: gutter 2 + left margin 1 + right edge.
					// See file header "the state dot on the command line's first row".
					const wrapWidth = Math.max(20, (width || 80) - GUTTER_WIDTH - INDENT_WIDTH);
					const limit = DEFAULT_LINES;
					// The cache key must carry expanded / resultSeen, or toggling ctrl+o or a result arriving would not refresh rendered rows
					const resultSeen = state.resultSeen === true;
					if (
						cachedLines &&
						cachedWidth === wrapWidth &&
						cachedExpanded === context.expanded &&
						cachedResultSeen === resultSeen
					)
						return cachedLines;

					let result: string[];
					// invalid (args.command not a string) / empty command goes through the pi-tui wrap branch: the text is fixed to
					// `Run [invalid arg]` / `Run ...`, far too short to ever wrap, and that branch preserves
					// nested styling as-is (error color / toolOutput color) — no need to rebuild it in the hard-wrap branch
					if (!context.expanded && !invalid) {
						// collapsed state: **break-all hard wrap** + a visual-row budget (`limit`, default 2 rows).
						// See file header "command line: 2 lines + `Run ` prefix".
						// The end `…` goes on **plain text** first, then the whole row is colored — the other way would cut SGR
						// sequences in half.
						const commandLines = (command || "...").split("\n");
						const suffixWidth = visibleWidth(timeoutSuffix);
						// Only the first row (and only it) must leave room for the timeout suffix, or a long command pushes it off
						const firstRowBudget = suffixWidth > 0 ? Math.max(4, wrapWidth - suffixWidth) : wrapWidth;
						// mid-run continuations use fixed-width indent; `│ ` is the "command finished" signal (the user's chosen look,
						// see file header "command line: 2 lines + `Run ` prefix")
						const linePrefix = resultSeen ? COMMAND_CHAIN : COMMAND_INDENT;
						const { lines, hiddenLines } = renderCommandLines(
							commandLines,
							COMMAND_PROMPT,
							linePrefix,
							firstRowBudget,
							wrapWidth,
							null,
							highlightEnabled,
							limit,
							theme,
						);
						result = lines.map((row, idx) => row + (idx === 0 ? timeoutSuffix : ""));
						// command itself not fully shown → `… +N lines` (no `│ ` mid-run, matching the continuations)
						if (hiddenLines > 0) {
							const hint = theme.fg("muted", `${linePrefix}${ELLIPSIS} +${hiddenLines} lines`);
							result = [...result, truncateToWidth(hint, wrapWidth, ELLIPSIS)];
						}
					} else if (invalid || !command) {
						// invalid (args.command not a string) / empty command: the text is fixed to `Run [invalid arg]`
						// / `Run ...`, far too short to ever wrap, and the wrap branch preserves nested styling
						// (error color / toolOutput color) — no need to rebuild it in the hard-wrap branch
						result = wrapTextWithAnsi(styledFull, wrapWidth);
					} else {
						// expanded state (ctrl+o): the full command is wanted, **still with break-all hard wrap** — greedy word wrap
						// would likewise move a long path wholesale to the next line and split it mid-string (the `Run `-then-wrap
						// look the user saw); expanded only lifts the line cap — the wrap rules must match.
						const commandLines = command.split("\n");
						const suffixWidth = visibleWidth(timeoutSuffix);
						const firstRowBudget = suffixWidth > 0 ? Math.max(4, wrapWidth - suffixWidth) : wrapWidth;
						// mid-run continuations use fixed-width indent, switching to `│ ` once finished (same rule as collapsed)
						const linePrefix = resultSeen ? COMMAND_CHAIN : COMMAND_INDENT;
						// shares the collapsed state's row-layout logic, only the line budget is lifted (`hiddenLines` is necessarily 0)
						const { lines } = renderCommandLines(
							commandLines,
							COMMAND_PROMPT,
							linePrefix,
							firstRowBudget,
							wrapWidth,
							null,
							highlightEnabled,
							Number.MAX_SAFE_INTEGER,
							theme,
						);
						result = lines.map((row, idx) => row + (idx === 0 ? timeoutSuffix : ""));
					}

					// The state dot `•` + left whitespace: hung on the first row only (user decision 2026-09-21, see file header "the
					// state dot on the command line's first row"). The result side mounts the same indent inside `withPreviewLimit` / `prefixTreeLines` — both sides aligned.
					result = withHeadBar(result, stateBarAnsi(theme, context.isPartial === true, context.isError === true));

					// End-of-line padding is the outer layer's job (`Box.render` pads every row to its width); not our concern here.
					cachedWidth = wrapWidth;
					cachedExpanded = context.expanded;
					cachedResultSeen = resultSeen;
					cachedLines = result;
					return result;
				},
				invalidate() {
					cachedWidth = undefined;
					cachedExpanded = undefined;
					cachedResultSeen = undefined;
					cachedLines = undefined;
				},
			};

			// `new Box(0, 0)`: **no bgFn** (the bash block carries no background — none of pending / success / failure is painted;
			// state is conveyed by the dot's color on the first row — see file header "no background"); both paddings are 0 too:
			// no blank rows above or below the block, and the left margin is painted by the component itself — `• ` on the first row, two spaces elsewhere (`withHeadBar`),
			// so children get the full width and the component deducts it back internally (`width - 3`).
			const box = new Box(0, 0);
			box.addChild(component);
			return box;
		},
	});

	pi.registerCommand("bash-preview", {
		description: "Bash output preview: off (Pi default: 5 lines) | <line count 1-50>",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "off") {
				previewLines = 5; // pi's BASH_PREVIEW_LINES — equivalent to not trimming
				ctx.ui.notify("Bash output preview restored to Pi's default of 5 lines", "info");
				return;
			}

			if (arg === "") {
				ctx.ui.notify(`Current output preview: first ${previewLines} lines (Pi default: 5; omitted content is indicated by 'earlier lines')`, "info");
				return;
			}

			// Number instead of parseInt: parseInt("2.5") silently becomes 2 (consistent with
			// clampPreviewLines' normalize strategy — fractions should be rejected, not silently truncated)
			const parsed = Number(arg);
			const next = clampPreviewLines(parsed);
			if (next !== parsed) {
				ctx.ui.notify("Usage: /bash-preview off | <integer 1-50>", "warning");
				return;
			}

			previewLines = next;
			ctx.ui.notify(`Bash output preview changed to the first ${previewLines} lines`, "info");
		},
	});

	// Read-only view of the effective deadline: default, cap, and whether env overrides.
	// Values are recomputed per call in execute, so what is shown here is always the real deadline of the next run.
	pi.registerCommand("bash-timeout", {
		description: "Show Bash timeouts (default / maximum / environment overrides)",
		handler: async (_args, ctx) => {
			const override = (name: string) => {
				const value = readTimeoutEnvMs(name);
				return value === undefined ? "unset" : `${name}=${value}ms`;
			};
			ctx.ui.notify(
				`Default ${defaultTimeoutSeconds()}s, maximum ${maxTimeoutSeconds()}s；env：${override("BASH_DEFAULT_TIMEOUT_MS")} / ${override("BASH_MAX_TIMEOUT_MS")} (restart Pi after changes)`,
				"info",
			);
		},
	});
}
