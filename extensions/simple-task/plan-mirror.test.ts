/**
 * Tests for plan-mirror.ts — the plan-mode ⇄ simple-task mirror contract.
 *
 * Run with:  node --test clients/pi/extensions/simple-task/plan-mirror.test.ts
 *
 * 纯函数，无 pi 依赖。重点覆盖三条边界：前缀与步号必须成对可逆、`rebuildTasks` 不能
 * 重置正在进行的镜像条目、非镜像任务不能被计划步骤冲掉。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	MIRROR_PREFIX,
	type PlanMirrorItem,
	buildMirrorText,
	isMirrorText,
	mirroredDoneSteps,
	nextAvailableId,
	parseMirrorStep,
	rebuildTasks,
} from "./plan-mirror.ts";
import type { Task } from "./types.ts";

const item = (step: number, text: string, done = false): PlanMirrorItem => ({ step, text, done });

describe("文案前缀与步号", () => {
	it("buildMirrorText / parseMirrorStep 成对可逆", () => {
		for (const step of [1, 9, 10, 137]) {
			assert.equal(parseMirrorStep(buildMirrorText(item(step, "改 x"))), step);
		}
	});

	it("普通任务文案不算镜像条目", () => {
		assert.equal(isMirrorText("planning the migration"), false);
		assert.equal(parseMirrorStep("planning the migration"), undefined);
	});

	it("前缀对但步号坏了：仍算镜像文案，但取不到步号", () => {
		assert.equal(isMirrorText(`${MIRROR_PREFIX}九. 改 x`), true);
		assert.equal(parseMirrorStep(`${MIRROR_PREFIX}九. 改 x`), undefined);
	});

	it("步号为 0 不算（id 从 1 开始）", () => {
		assert.equal(parseMirrorStep(`${MIRROR_PREFIX}0. 改 x`), undefined);
	});
});

describe("mirroredDoneSteps", () => {
	it("只认镜像条目里的 done", () => {
		const done = mirroredDoneSteps({
			items: [
				{ id: 1, text: buildMirrorText(item(1, "第一步")), status: "done" },
				{ id: 2, text: buildMirrorText(item(2, "第二步")), status: "in_progress" },
				{ id: 3, text: "手建的任务", status: "done" },
			],
		});
		assert.deepEqual([...done], [1], "手建任务即使 id 撞上步号也不算");
	});

	it("状态缺失时返回空集合", () => {
		assert.deepEqual([...mirroredDoneSteps(undefined)], []);
	});
});

describe("rebuildTasks", () => {
	const task = (id: number, text: string, status: Task["status"]): Task => ({ id, text, status });

	it("镜像条目 id = 步号、按步号排序、文案带前缀", () => {
		const rebuilt = rebuildTasks([], [item(2, "第二步"), item(1, "第一步")]);
		assert.deepEqual(rebuilt.map((t) => t.id), [1, 2]);
		assert.equal(rebuilt[0]!.text, `${MIRROR_PREFIX}1. 第一步`);
		assert.ok(rebuilt.every((t) => t.status === "pending"));
	});

	it("已 done 的步骤写成 done", () => {
		assert.deepEqual(rebuildTasks([], [item(1, "一", true), item(2, "二")]).map((t) => t.status), ["done", "pending"]);
	});

	it("正在进行的镜像条目不被打回 pending（否则每次同步都闪一下 spinner）", () => {
		const current = [task(1, buildMirrorText(item(1, "一")), "in_progress")];
		assert.equal(rebuildTasks(current, [item(1, "一")])[0]!.status, "in_progress");
	});

	it("非镜像任务全部保留，并排在镜像条目之后", () => {
		const current = [task(7, "手建的任务", "pending")];
		const rebuilt = rebuildTasks(current, [item(1, "第一步")]);
		assert.deepEqual(rebuilt.map((t) => t.id), [1, 7]);
		assert.equal(rebuilt[1]!.text, "手建的任务");
	});

	it("空快照只清掉镜像条目，手建任务留下", () => {
		const current = [task(1, buildMirrorText(item(1, "一")), "done"), task(2, "手建", "pending")];
		assert.deepEqual(rebuildTasks(current, []).map((t) => t.text), ["手建"]);
	});
});

describe("rebuildTasks 的 id 空间", () => {
	const task = (id: number, text: string, status: Task["status"]): Task => ({ id, text, status });

	it("与镜像步号撞号的手建任务被顺延，不再出现重复 id", () => {
		const current = [task(1, "手建甲", "pending"), task(2, "手建乙", "pending")];
		const rebuilt = rebuildTasks(current, [item(1, "计划一"), item(2, "计划二")]);
		const ids = rebuilt.map((t) => t.id);
		assert.deepEqual(ids, [1, 2, 3, 4], `期望 1,2 给镜像、手建顺延到 3,4，实际 ${ids}`);
		assert.equal(new Set(ids).size, ids.length, "id 必须唯一");
		assert.equal(rebuilt[2]!.text, "手建甲");
		assert.equal(rebuilt[3]!.text, "手建乙");
	});

	it("手建任务排在镜像之后，且保持原有先后顺序", () => {
		const current = [task(9, "手建甲", "pending"), task(3, "手建乙", "pending")];
		const rebuilt = rebuildTasks(current, [item(1, "计划一")]);
		assert.deepEqual(rebuilt.map((t) => t.text), ["plan: 1. 计划一", "手建甲", "手建乙"]);
		// 不撞号的 id 一个都不动：模型可能还拿着上一轮 `task_get` 里的 `#3`。
		assert.deepEqual(rebuilt.map((t) => t.id), [1, 9, 3]);
	});

	it("顺延的编号从「最大已用 id + 1」继续，不会二次撞号", () => {
		const current = [task(3, "手建甲", "pending"), task(2, "手建乙", "pending")];
		const rebuilt = rebuildTasks(current, [item(1, "计划一"), item(2, "计划二")]);
		assert.deepEqual(rebuilt.map((t) => t.text), [
			"plan: 1. 计划一",
			"plan: 2. 计划二",
			"手建甲",
			"手建乙",
		]);
		assert.deepEqual(rebuilt.map((t) => t.id), [1, 2, 3, 4], "#2 撞号后从 max(已用 id)=3 之后取 4");
	});

	it("手建任务的 in_progress 不串染到同号镜像步骤", () => {
		const current = [task(2, "手建乙", "in_progress")];
		const rebuilt = rebuildTasks(current, [item(1, "计划一"), item(2, "计划二")]);
		const mirror2 = rebuilt.find((t) => t.text === "plan: 2. 计划二");
		assert.equal(mirror2?.status, "pending", "镜像 #2 不该继承手建 #2 的 in_progress");
		assert.equal(rebuilt.find((t) => t.text === "手建乙")?.status, "in_progress", "手建任务自己的状态要保留");
	});

	it("镜像条目的 in_progress 仍然保留（防 spinner 闪）", () => {
		const current = [task(1, buildMirrorText(item(1, "一")), "in_progress")];
		assert.equal(rebuildTasks(current, [item(1, "一")])[0]!.status, "in_progress");
	});
});

describe("nextAvailableId", () => {
	it("取最大 id + 1；空清单从 1 开始", () => {
		assert.equal(nextAvailableId([]), 1);
		assert.equal(nextAvailableId([{ id: 3, text: "x", status: "pending" }]), 4);
	});
});
