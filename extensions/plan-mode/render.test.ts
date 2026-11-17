/**
 * Tests for render.ts — plan-mode's statusline text.
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/render.test.ts
 *
 * render.ts imports no pi / pi-tui: the `plain` theme drops colors so the visible text can be
 * asserted; the `painted` theme wraps each segment as `slot(text)` so the semantic slot used
 * can be asserted.
 *
 * Since 2026-09-24 **there is no steps widget**: a plan is a markdown document (no per-step
 * checkboxes), and progress belongs to the model (it calls `task_set` if it wants a list —
 * that is simple-task's widget's job). So this file pins only the four status-row shapes and
 * their color slots.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STATUS_KEY, type PlanTheme, formatPlanStatus } from "./render.ts";

const plain: PlanTheme = { fg: (_color, text) => text };
const painted: PlanTheme = { fg: (color, text) => `${color}(${text})` };

describe("status row", () => {
	it("bypass shows ⏵ bypass (this cell is the mode indicator — every state has text)", () => {
		assert.equal(formatPlanStatus(plain, { phase: "bypass" }), "⏵ bypass");
	});

	it("bypass keeps showing even with leftover plan fields (not only drawn at toggle time)", () => {
		assert.equal(formatPlanStatus(plain, { phase: "bypass", pending: "leftover plan" }), "⏵ bypass");
		assert.equal(formatPlanStatus(plain, { phase: "bypass", docWriting: true }), "⏵ bypass");
	});

	it("plan state: while waiting for the model's submission it shows only ⏸ plan", () => {
		assert.equal(formatPlanStatus(plain, { phase: "plan" }), "⏸ plan");
	});

	it("plan state: a submitted plan awaiting approval adds \"awaiting approval\"", () => {
		assert.equal(formatPlanStatus(plain, { phase: "plan", pending: "# Plan" }), "⏸ plan · awaiting approval");
	});

	it("plan state: the doc-writing sub-state adds \"writing document\", taking precedence over \"awaiting approval\"", () => {
		assert.equal(formatPlanStatus(plain, { phase: "plan", docWriting: true }), "⏸ plan · writing document");
		assert.equal(
			formatPlanStatus(plain, { phase: "plan", docWriting: true, pending: "# Plan" }),
			"⏸ plan · writing document",
			"pending survives inside the sub-state (the doc-writing instruction needs it), but the row should say a doc is being written",
		);
	});

	it("color slots: plan → warning, the sub-state's tail → accent, bypass → toolDiffRemoved (red)", () => {
		assert.equal(formatPlanStatus(painted, { phase: "plan" }), "warning(⏸) warning(plan)");
		assert.equal(formatPlanStatus(painted, { phase: "plan", pending: "x" }), "warning(⏸) warning(plan) muted(· awaiting approval)");
		assert.equal(
			formatPlanStatus(painted, { phase: "plan", docWriting: true }),
			"warning(⏸) warning(plan) accent(· writing document)",
		);
		// bypass is "protection off", flagged in the deleted-line foreground (red in all three skins).
		assert.equal(formatPlanStatus(painted, { phase: "bypass" }), "toolDiffRemoved(⏵) toolDiffRemoved(bypass)");
	});

	it("bypass does not use dim/muted (going back to the resting color would hide it again)", () => {
		const rendered = formatPlanStatus(painted, { phase: "bypass" });
		assert.ok(!rendered.includes("dim("), rendered);
		assert.ok(!rendered.includes("muted("), rendered);
	});

	it("the setStatus key is fixed as plan-mode (statusline's second row splices in registration order — fewer keys is better)", () => {
		assert.equal(STATUS_KEY, "plan-mode");
	});
});
