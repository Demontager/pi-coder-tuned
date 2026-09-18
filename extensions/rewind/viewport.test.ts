/**
 * Tests for the picker layout budget.
 *
 * Run with:  node --test ~/.pi/agent/extensions/rewind/viewport.test.ts
 *
 * The point of these cases is the invariant, not the arithmetic: whatever the
 * terminal height, the dialog (list + its own chrome) plus the rows pi paints
 * below it must fit the viewport. That is what keeps the selection arrow on
 * screen for a session with more checkpoints than the terminal has rows.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_TERMINAL_ROWS,
  PICKER_CHROME_ROWS,
  PICKER_MAX_LIST_ROWS,
  PICKER_TAIL_RESERVE_ROWS,
  pickerListRows,
  resolveTerminalRows,
} from "./viewport.ts";

describe("resolveTerminalRows", () => {
  it("falls back for values a non-TTY host reports", () => {
    assert.equal(resolveTerminalRows(undefined), DEFAULT_TERMINAL_ROWS);
    assert.equal(resolveTerminalRows(Number.NaN), DEFAULT_TERMINAL_ROWS);
    assert.equal(resolveTerminalRows(0), DEFAULT_TERMINAL_ROWS);
    assert.equal(resolveTerminalRows(-3), DEFAULT_TERMINAL_ROWS);
  });

  it("keeps real heights, floored to whole rows", () => {
    assert.equal(resolveTerminalRows(41), 41);
    assert.equal(resolveTerminalRows(41.9), 41);
  });
});

describe("pickerListRows", () => {
  it("leaves the chrome and the rows below the editor alone", () => {
    assert.equal(pickerListRows(24), 24 - PICKER_CHROME_ROWS - PICKER_TAIL_RESERVE_ROWS);
    assert.equal(pickerListRows(30), 30 - PICKER_CHROME_ROWS - PICKER_TAIL_RESERVE_ROWS);
  });

  it("caps tall terminals so the picker stays a picker", () => {
    assert.equal(pickerListRows(120), PICKER_MAX_LIST_ROWS);
    assert.equal(pickerListRows(1_000), PICKER_MAX_LIST_ROWS);
  });

  it("never returns less than one row, however short the terminal", () => {
    assert.equal(pickerListRows(1), 1);
    assert.equal(pickerListRows(8), 1);
    assert.equal(pickerListRows(12), 2);
  });

  it("falls back to the assumed height when the size is unknown", () => {
    assert.equal(pickerListRows(undefined), pickerListRows(DEFAULT_TERMINAL_ROWS));
  });

  it("degrades to a single row on terminals shorter than the dialog chrome", () => {
    for (let rows = 1; rows < PICKER_CHROME_ROWS + PICKER_TAIL_RESERVE_ROWS; rows += 1) {
      assert.equal(pickerListRows(rows), 1, `rows=${rows}`);
    }
  });

  it("keeps the whole dialog inside the viewport at every height", () => {
    // The dialog is the list plus its own chrome; the tail reserve stands in for
    // the footer and the widgets pi paints below the editor container.
    // Below this the chrome + tail reserve alone already fill the screen, so
    // there is nothing to fit — see the single-row case above.
    const minimumRows = PICKER_CHROME_ROWS + PICKER_TAIL_RESERVE_ROWS + 1;
    for (let rows = minimumRows; rows <= 200; rows += 1) {
      const painted = pickerListRows(rows) + PICKER_CHROME_ROWS + PICKER_TAIL_RESERVE_ROWS;
      assert.ok(painted <= rows, `rows=${rows} would paint ${painted} lines`);
    }
  });
});
