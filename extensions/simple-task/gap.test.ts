/**
 * Tests for gap.ts — the blank-line decision between two stacked editor widgets.
 *
 * Run with:  node --test clients/pi/extensions/simple-task/gap.test.ts
 *
 * Real TUI trees cannot be built headlessly, so the tree is faked with plain objects:
 * a Container is anything with a `children` array, a widget is anything with `render()`.
 * The module under test never imports pi / pi-tui (that is the point of gap.ts), so the
 * fakes are enough to cover every branch.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { widgetGaps } from "./gap.ts";

/** A widget that renders the given lines. `width` is recorded for assertions. */
function widget(lines: string[], seen?: number[]): { render(width: number): string[] } {
	return {
		render(width: number): string[] {
			seen?.push(width);
			return lines;
		},
	};
}

/** pi's own leading spacer: one empty line, no content. */
const spacer = widget([""]);

function container(children: unknown[]): { children: unknown[] } {
	return { children };
}

describe("widgetGaps", () => {
	it("adds nothing when the list is the only widget (pi's leading spacer above)", () => {
		const self = widget(["● 3 tasks (3 open)"]);
		const tui = container([container([spacer, self])]);
		assert.deepEqual(widgetGaps(tui, self, 80), { above: false, below: false });
	});

	it("adds a leading blank line when the async-subagent block sits directly above", () => {
		const self = widget(["● 6 tasks (1 done, 1 in progress, 4 open)", "  ✶ #2 …"]);
		const above = widget(["async subagent · background  ", "  ⠧ reviewer · running  ", "  output: /var/folders/…  "]);
		const tui = container([container([spacer, above, self])]);
		assert.deepEqual(widgetGaps(tui, self, 80), { above: true, below: false });
	});

	it("adds nothing when the neighbour above already ends with a blank line (recap)", () => {
		const self = widget(["● 3 tasks (3 open)"]);
		const recap = widget([" ✦ Recap: 修 gap 空行", ""]);
		const tui = container([container([spacer, recap, self])]);
		assert.deepEqual(widgetGaps(tui, self, 80), { above: false, below: false });
	});

	it("adds a trailing blank line when the other widget sits below the list", () => {
		const self = widget(["● 3 tasks (3 open)"]);
		const below = widget(["async subagent · background", "  ⠧ reviewer · running"]);
		const tui = container([container([spacer, self, below])]);
		assert.deepEqual(widgetGaps(tui, self, 80), { above: false, below: true });
	});

	it("adds nothing when the widget below already starts with a blank line (recap's own gap)", () => {
		const self = widget(["● 3 tasks (3 open)"]);
		const recap = widget(["", " ✦ Recap: 修 gap 空行"]);
		const tui = container([container([spacer, self, recap])]);
		assert.deepEqual(widgetGaps(tui, self, 80), { above: false, below: false });
	});

	it("adds both gaps when wedged between two widgets", () => {
		const self = widget(["● 3 tasks (3 open)"]);
		const above = widget(["async subagent · background"]);
		const below = widget(["✦ Recap: 上一轮摘要"]);
		const tui = container([container([spacer, above, self, below])]);
		assert.deepEqual(widgetGaps(tui, self, 80), { above: true, below: true });
	});

	it("finds itself in a deeply nested tree", () => {
		const self = widget(["● 1 task (1 open)"]);
		const above = widget(["async subagent · background"]);
		const tui = container([container([container([container([spacer, above, self])])])]);
		assert.deepEqual(widgetGaps(tui, self, 80), { above: true, below: false });
	});

	it("forwards the render width to the neighbours (pi renders a container at one width)", () => {
		const widths: number[] = [];
		const self = widget(["● 1 task (1 open)"]);
		const above = widget(["async subagent · background"], widths);
		const tui = container([container([spacer, above, self])]);
		widgetGaps(tui, self, 123);
		assert.deepEqual(widths, [123]);
	});

	it("adds nothing for a neighbour that renders no visible line at all", () => {
		const self = widget(["● 1 task (1 open)"]);
		const empty = widget([]);
		const blank = widget(["", "   ", "\x1b[2m\x1b[0m"]);
		const tui = container([container([spacer, empty, self, blank])]);
		assert.deepEqual(widgetGaps(tui, self, 80), { above: false, below: false });
	});

	it("treats an ANSI-only trailing line as blank (colour reset is not content)", () => {
		const self = widget(["● 1 task (1 open)"]);
		const above = widget(["async subagent · background", "\x1b[2m\x1b[0m"]);
		const tui = container([container([spacer, above, self])]);
		assert.deepEqual(widgetGaps(tui, self, 80), { above: false, below: false });
	});

	it("treats a throwing neighbour as visible content (better a gap than a missing one)", () => {
		const self = widget(["● 1 task (1 open)"]);
		const broken = {
			render(): string[] {
				throw new Error("boom");
			},
		};
		const tui = container([container([spacer, broken, self, broken])]);
		assert.deepEqual(widgetGaps(tui, self, 80), { above: true, below: true });
	});

	it("ignores a sibling without render()", () => {
		const self = widget(["● 1 task (1 open)"]);
		const notAWidget = { not: "a component" };
		const tui = container([container([spacer, notAWidget, self])]);
		assert.deepEqual(widgetGaps(tui, self, 80), { above: false, below: false });
	});

	it("adds nothing when the tree does not contain the component", () => {
		const self = widget(["● 1 task (1 open)"]);
		const other = widget(["async subagent · background"]);
		const tui = container([container([spacer, other])]);
		assert.deepEqual(widgetGaps(tui, self, 80), { above: false, below: false });
	});

	it("survives a cyclic tree instead of looping forever", () => {
		const self = widget(["● 1 task (1 open)"]);
		const outer = container([]);
		const inner = container([outer]);
		outer.children.push(inner);
		assert.deepEqual(widgetGaps(outer, self, 80), { above: false, below: false });
	});

	it("distinguishes components by identity, not by shape", () => {
		const self = widget(["● 1 task (1 open)"]);
		const twin = widget(["● 1 task (1 open)"]);
		const tui = container([container([spacer, twin, self])]);
		assert.deepEqual(widgetGaps(tui, self, 80), { above: true, below: false });
	});
});
