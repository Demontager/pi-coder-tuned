/**
 * Tests for bash-spinner.ts — working 行尾「bash 执行中 `●`」的形态与并发登记簿。
 *
 * Run with:  node --test clients/pi/extensions/working-indicator/bash-spinner.test.ts
 *
 * 被测模块不 import pi / pi-tui，断言直接比对纯文本 / 纯状态。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BASH_SPINNER_BLINK_MS,
	BASH_SPINNER_COLOR,
	BASH_SPINNER_DELAY_MS,
	BASH_SPINNER_MARKER,
	BASH_SPINNER_WIDTH,
	BashRunTracker,
	bashSpinnerSuffix,
} from "./bash-spinner.ts";

/** 可见宽度：本模块只出现 ASCII 空格与 `●`（U+25CF，1 列），逐字符数即可。 */
function widthOf(text: string): number {
	return [...text].length;
}

describe("bashSpinnerSuffix", () => {
	it("亮相位 `\" ●\"`、灭相位两格空格（绝不返回空串）", () => {
		assert.equal(bashSpinnerSuffix(true), ` ${BASH_SPINNER_MARKER}`);
		assert.equal(bashSpinnerSuffix(false), " ".repeat(BASH_SPINNER_WIDTH));
		assert.notEqual(bashSpinnerSuffix(false), "");
	});

	it("两态等宽**且等字符数**（右对齐摘要不随亮灭左右蹦）", () => {
		for (const text of [bashSpinnerSuffix(true), bashSpinnerSuffix(false)]) {
			assert.equal(widthOf(text), BASH_SPINNER_WIDTH);
			assert.equal([...text].length, BASH_SPINNER_WIDTH);
		}
	});

	it("返回的是**未上色**的纯文本（上色由扩展按色槽做）", () => {
		for (const text of [bashSpinnerSuffix(true), bashSpinnerSuffix(false)]) {
			assert.doesNotMatch(text, /\x1b\[/);
		}
	});

	it("色槽是 dim（退役的 bash 首行 spinner 同一个槽位）", () => {
		assert.equal(BASH_SPINNER_COLOR, "dim");
	});
});

describe("节拍常量", () => {
	it("门槛 1s、亮灭各 500ms、整除", () => {
		assert.equal(BASH_SPINNER_DELAY_MS, 1000);
		assert.equal(BASH_SPINNER_BLINK_MS, 500);
		assert.equal(BASH_SPINNER_DELAY_MS % BASH_SPINNER_BLINK_MS, 0);
	});
});

describe("BashRunTracker", () => {
	it("没有 bash 在跑：不显示、不需要排程", () => {
		const runs = new BashRunTracker();
		assert.equal(runs.size, 0);
		assert.equal(runs.shown, false);
		assert.equal(runs.markCrossed(0), false);
		assert.equal(runs.armDelay(0), null);
	});

	it("门槛内不显示，到点（1000ms）即显示", () => {
		const runs = new BashRunTracker();
		runs.start("a", 5_000);
		assert.equal(runs.markCrossed(5_999), false);
		assert.equal(runs.shown, false);
		assert.equal(runs.armDelay(5_999), 1);
		assert.equal(runs.markCrossed(6_000), true);
		assert.equal(runs.shown, true);
		assert.equal(runs.armDelay(6_000), null, "已跨过门槛就不再排程");
	});

	it("排程时刻 = 最早那个执行的截止点，且第一个执行结束后顺延到下一个", () => {
		const runs = new BashRunTracker();
		runs.start("a", 0);
		runs.start("b", 500);
		assert.equal(runs.armDelay(0), 1_000, "两个都在门槛内：等最早那个");
		runs.end("a");
		assert.equal(runs.armDelay(0), 1_500, "a 结束后等 b");
		assert.equal(runs.armDelay(1_500), 0, "已经到点就是 0，不再往后算");
	});

	it("粘性：跨过门槛的执行结束后，同批还没到门槛的照旧把标记撑住", () => {
		const runs = new BashRunTracker();
		runs.start("long", 0);
		runs.start("young", 900);
		assert.equal(runs.markCrossed(1_000), true, "long 跨过门槛");
		runs.end("long");
		assert.equal(runs.shown, true, "young 还在跑，标记不能灭");
		assert.equal(runs.markCrossed(1_100), true, "young 本身还没到门槛，靠粘性撑住");
		assert.equal(runs.armDelay(1_100), null, "已跨过门槛，不再为 young 排程");
		runs.end("young");
		assert.equal(runs.shown, false, "所有 bash 都结束 → 标记消失");
		assert.equal(runs.size, 0);
	});

	it("最后一个结束才消失：同批两个都在门槛之后，先结束一个不影响", () => {
		const runs = new BashRunTracker();
		runs.start("a", 0);
		runs.start("b", 0);
		assert.equal(runs.markCrossed(1_000), true);
		runs.end("a");
		assert.equal(runs.shown, true);
		runs.end("b");
		assert.equal(runs.shown, false);
	});

	it("换批次不继承粘性标志：新起的短命令得重新自己跨门槛", () => {
		const runs = new BashRunTracker();
		runs.start("a", 0);
		runs.markCrossed(1_000);
		runs.end("a");
		runs.start("b", 2_000);
		assert.equal(runs.markCrossed(2_100), false, "上一批的 sticky 已随登记簿清空复位");
		assert.equal(runs.shown, false);
		assert.equal(runs.armDelay(2_100), 900);
	});

	it("clear() 清空整本账（换回合 / 会话替换 / 旧 ctx）", () => {
		const runs = new BashRunTracker();
		runs.start("a", 0);
		runs.markCrossed(1_000);
		runs.clear();
		assert.equal(runs.size, 0);
		assert.equal(runs.shown, false);
		assert.equal(runs.armDelay(1_000), null);
	});
});
