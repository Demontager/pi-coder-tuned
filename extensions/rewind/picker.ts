/**
 * pi-rewind picker — the scrollable checkpoint selector behind `/rewind`.
 *
 * Why not `ctx.ui.select()`: pi's built-in extension selector appends one row
 * per option and never scrolls (`ExtensionSelectorComponent.updateList()`), so
 * a session with more checkpoints than the terminal has rows produces a dialog
 * taller than the viewport — and pi-tui paints only the **last**
 * `terminal.rows` lines of the document, which cuts the dialog's top away:
 * the title, and the `→` cursor row it opens on. The user is left with a list
 * whose selection arrow is somewhere off screen.
 *
 * This picker keeps the dialog inside the viewport instead: the list window is
 * sized to the terminal (`pickerListRows` in viewport.ts) and pi-tui's
 * `SelectList` windows the rows around the selection, so the arrow is always
 * visible and the list scrolls. `SelectList` also draws a `(12/37)` position
 * line while scrolling, and it is theme-aware and mouse-aware for free.
 *
 * Movement keys are handled here rather than inside `SelectList` for two
 * reasons: `SelectList` wraps around at both ends (`up` on the newest
 * checkpoint jumps to the oldest) while pi's own dialogs clamp, and it has no
 * page/home/end handling. Keys therefore clamp, `PageUp`/`PageDown` move a
 * window at a time, `Home`/`End` jump to the ends, and `j`/`k` work like they
 * do in pi's built-in selector. `Enter`/`Esc` are left to `SelectList`, so
 * their configured bindings apply.
 *
 * Hosts that cannot render extension components (RPC, print) make
 * `ctx.ui.custom()` resolve `undefined`; the caller (`pickValue` in flow.ts)
 * then falls back to `ctx.ui.select()`.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  DynamicBorder,
  getSelectListTheme,
  keyHint,
  keyText,
  rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Key,
  SelectList,
  Text,
  type TuiMouseEvent,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";

import type { PickOutcome, PickerItem } from "./flow.ts";
import { pickerListRows } from "./viewport.ts";

export async function pickFromList(
  ctx: ExtensionCommandContext,
  title: string,
  items: PickerItem[],
): Promise<PickOutcome> {
  const picked = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
    const rows = pickerListRows(tui.terminal?.rows);
    const list = new SelectList(items, Math.min(items.length, rows), getSelectListTheme());
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);

    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("border", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(list);
    container.addChild(new Line(() => hintLine(theme, items.length > rows)));
    container.addChild(new DynamicBorder((text: string) => theme.fg("border", text)));

    /** Where the cursor is; `SelectList` exposes the selected item, not its index. */
    const cursor = (): number => {
      const item = list.getSelectedItem();
      return item ? items.indexOf(item) : 0;
    };
    const moveTo = (index: number): void => {
      list.setSelectedIndex(Math.max(0, Math.min(items.length - 1, index)));
    };

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (keybindings.matches(data, "tui.select.up") || data === "k") {
          moveTo(cursor() - 1);
        } else if (keybindings.matches(data, "tui.select.down") || data === "j") {
          moveTo(cursor() + 1);
        } else if (keybindings.matches(data, "tui.select.pageUp")) {
          moveTo(cursor() - rows);
        } else if (keybindings.matches(data, "tui.select.pageDown")) {
          moveTo(cursor() + rows);
        } else if (matchesKey(data, Key.home)) {
          moveTo(0);
        } else if (matchesKey(data, Key.end)) {
          moveTo(items.length - 1);
        } else {
          list.handleInput(data);
        }
        tui.requestRender();
      },
      handleMouse: (event: TuiMouseEvent) => container.handleMouse(event),
    };
  });

  // `undefined` is what a host that cannot render custom components returns;
  // `null` is this component's own cancel value.
  if (picked === undefined) return { status: "unsupported" };
  if (picked === null) return { status: "cancelled" };
  return { status: "picked", value: picked };
}

/** Footer hint. The paging keys only matter once the list does not fit. */
function hintLine(theme: Theme, pageable: boolean): string {
  const parts = [rawKeyHint("↑↓", "navigate")];
  if (pageable) {
    // Both page keys in one hint: `keyHint` would print the key name twice.
    const keys = `${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")}`;
    parts.push(`${theme.fg("dim", keys)}${theme.fg("muted", " page")}`);
  }
  parts.push(keyHint("tui.select.confirm", "select"), keyHint("tui.select.cancel", "cancel"));
  return `  ${parts.join("  ")}`;
}

/** A single line that truncates to the render width instead of wrapping into two. */
class Line implements Component {
  constructor(private readonly text: () => string) {}

  render(width: number): string[] {
    return [truncateToWidth(this.text(), width, "…")];
  }

  invalidate(): void {
    // Nothing cached: the text is rebuilt from the live theme on every render.
  }
}
