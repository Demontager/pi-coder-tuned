/**
 * Tests for spinner-frames.ts — working spinner 幻彩帧表的排布、去重与主题指纹。
 *
 * Run with:  node --test clients/pi/extensions/working-indicator/spinner-frames.test.ts
 *
 * 被测模块不 import pi / pi-tui，断言直接比对帧字符串的「颜色前缀 + 盲文字符」两段。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DEFAULT_FRAMES_PER_COLOR,
	SPINNER_COLOR_TOKENS,
	SPINNER_FRAMES,
	SPINNER_INTERVAL_MS,
	buildSpinnerPalette,
	type SpinnerColorize,
} from "./spinner-frames.ts";

/** 七个色槽各给一个可区分的「颜色」；`fg` 的形状就是「颜色前缀 + 原文」。 */
const DISTINCT: Record<string, string> = Object.fromEntries(
	SPINNER_COLOR_TOKENS.map((token, index) => [token, `<c${index}>`]),
);

/** 与模块内部同一口径的独立实现，用来交叉验证帧表周期（测公倍数性质，不是抄公式）。 */
function gcd(a: number, b: number): number {
	return b === 0 ? a : gcd(b, a % b);
}

/** 帧表周期的独立算法：lcm(盲文帧数, 每色帧数 × 颜色数)。 */
function expectedPeriod(framesPerColor: number, colorCount: number): number {
	const colorCycle = framesPerColor * colorCount;
	return (10 * colorCycle) / gcd(10, colorCycle);
}

/** 假主题：`colorize(token, text)` → `颜色 + text`（与 `theme.fg` 同形，颜色靠前缀区分）。 */
function fakeTheme(colors: Record<string, string>): SpinnerColorize {
	return (token, text) => `${colors[token] ?? `<${token}>`}${text}`;
}

/** 从帧字符串里取回颜色前缀（盲文帧都在 BMP 内，各占 1 个 UTF-16 单元）。 */
function colorOf(frame: string, colors: Record<string, string>): string {
	for (const color of Object.values(colors)) {
		if (frame.startsWith(color) && frame.length === color.length + 1) return color;
	}
	throw new Error(`帧里没有已知颜色前缀：${frame}`);
}

/** 从帧字符串里取回盲文字符。 */
function frameOf(frame: string): string {
	return frame.at(-1) as string;
}

/** 颜色段：连续同色帧合并成一段。 */
function colorRuns(frames: string[], colors: Record<string, string>): Array<{ color: string; length: number }> {
	const runs: Array<{ color: string; length: number }> = [];
	for (const frame of frames) {
		const color = colorOf(frame, colors);
		const last = runs.at(-1);
		if (last !== undefined && last.color === color) last.length += 1;
		else runs.push({ color, length: 1 });
	}
	return runs;
}

/**
 * 换色点在圈内的**相位**（帧号 % 10）：集合里只有一个元素 = 每圈都在盲文的同一位置换色，
 * 多元素 = 换色点逐圈漂移（`framesPerColor` 不整除 10 时）。
 */
function changePhases(frames: string[], colors: Record<string, string>): Set<number> {
	const phases = new Set<number>();
	for (const [index, frame] of frames.entries()) {
		if (index === 0) continue;
		if (colorOf(frame, colors) !== colorOf(frames[index - 1] as string, colors)) {
			phases.add(index % SPINNER_FRAMES.length);
		}
	}
	return phases;
}

describe("buildSpinnerPalette 的帧表排布", () => {
	it("没有配置时用七个色槽、每色 19 帧（默认值），周期 1330 帧", () => {
		const palette = buildSpinnerPalette(fakeTheme(DISTINCT));
		assert.deepEqual(palette.tokens, [...SPINNER_COLOR_TOKENS]);
		assert.equal(DEFAULT_FRAMES_PER_COLOR, 19);
		assert.equal(SPINNER_INTERVAL_MS, 80);
		// 19 帧 × 80ms = 1520ms ≈ 1.5s 一换色；周期 = lcm(10, 19 × 7) = 1330 帧 ≈ 106s。
		assert.equal(palette.frames?.length, 1330);
		assert.equal(palette.frames?.length, expectedPeriod(19, 7));
	});

	it("旋转照旧：第 i 帧的盲文就是 pi 默认序列的第 i % 10 帧", () => {
		const frames = buildSpinnerPalette(fakeTheme(DISTINCT)).frames as string[];
		for (const [index, frame] of frames.entries()) {
			assert.equal(frameOf(frame), SPINNER_FRAMES[index % SPINNER_FRAMES.length]);
		}
	});

	it("颜色按帧数推进：每段恰好 framesPerColor 帧，顺序就是 tokens 顺序", () => {
		const runs = colorRuns(buildSpinnerPalette(fakeTheme(DISTINCT)).frames as string[], DISTINCT);
		assert.equal(runs.length, 70); // 1330 帧 / 每段 19 帧
		assert.ok(runs.every((run) => run.length === DEFAULT_FRAMES_PER_COLOR));
		for (const [index, run] of runs.entries()) {
			assert.equal(run.color, DISTINCT[SPINNER_COLOR_TOKENS[index % SPINNER_COLOR_TOKENS.length] as string]);
		}
	});

	it("默认帧表回绕无缝：末帧是本圈末帧 + 调色板末色，换色点相位遍历全部 10 个位置", () => {
		const frames = buildSpinnerPalette(fakeTheme(DISTINCT)).frames as string[];
		const last = frames[frames.length - 1] as string;
		assert.equal(frameOf(last), SPINNER_FRAMES[9]);
		assert.equal(colorOf(last, DISTINCT), DISTINCT["toolTitle"]);
		assert.equal(frameOf(frames[0] as string), SPINNER_FRAMES[0]);
		assert.equal(colorOf(frames[0] as string, DISTINCT), DISTINCT["accent"]);

		// 19 与盲文圈长 10 互质：换色点每换一次就往圈内错一步，相位遍历全部 10 个位置
		// （帧表周期 lcm(10, 19 × 7) = 1330 帧 ≈ 106s，比一轮调色板的 133 帧长得多）。
		assert.equal(frames.length, DEFAULT_FRAMES_PER_COLOR * SPINNER_COLOR_TOKENS.length * 10);
		assert.equal(changePhases(frames, DISTINCT).size, SPINNER_FRAMES.length);
	});

	it("framesPerColor 可调：1 = 每帧换色，3 = 周期 210 帧且换色点逐圈漂移", () => {
		const perFrame = buildSpinnerPalette(fakeTheme(DISTINCT), { framesPerColor: 1 });
		assert.equal(perFrame.frames?.length, expectedPeriod(1, 7));
		assert.ok(colorRuns(perFrame.frames as string[], DISTINCT).every((run) => run.length === 1));

		const holdThree = buildSpinnerPalette(fakeTheme(DISTINCT), { framesPerColor: 3 });
		assert.equal(holdThree.frames?.length, expectedPeriod(3, 7));
		assert.ok(colorRuns(holdThree.frames as string[], DISTINCT).every((run) => run.length === 3));
		// 3 不整除 10：换色点不在盲文的同一个位置（相位多于一个 = 彩带在圈内漂）。
		assert.ok(changePhases(holdThree.frames as string[], DISTINCT).size > 1);
	});

	it("非法 framesPerColor：0 / 负数 / NaN / Infinity 退回默认，小数取整", () => {
		for (const [value, hold] of [
			[0, DEFAULT_FRAMES_PER_COLOR],
			[-3, DEFAULT_FRAMES_PER_COLOR],
			[Number.NaN, DEFAULT_FRAMES_PER_COLOR],
			[Number.POSITIVE_INFINITY, DEFAULT_FRAMES_PER_COLOR],
			[2.9, 2],
		] as const) {
			const palette = buildSpinnerPalette(fakeTheme(DISTINCT), { framesPerColor: value });
			assert.equal(colorRuns(palette.frames as string[], DISTINCT)[0]?.length, hold, `framesPerColor=${value}`);
			assert.equal(palette.frames?.length, expectedPeriod(hold, 7), `framesPerColor=${value}`);
		}
	});

	it("tokens 可换成子集：两个色槽、每色 5 帧 → 周期 lcm(10, 10) = 10 帧", () => {
		const palette = buildSpinnerPalette(fakeTheme(DISTINCT), { framesPerColor: 5, tokens: ["accent", "warning"] });
		assert.deepEqual(palette.tokens, ["accent", "warning"]);
		assert.equal(palette.frames?.length, expectedPeriod(5, 2));
		assert.deepEqual(
			colorRuns(palette.frames as string[], DISTINCT).map((run) => run.color),
			[DISTINCT["accent"], DISTINCT["warning"]],
		);
	});
});

describe("buildSpinnerPalette 的颜色去重与降级", () => {
	it("当前主题里同色的两个槽位只留一个（不留连续两段同色）", () => {
		// pi-coder-summer-night 实测撞车：success == toolDiffAdded、warning == toolTitle。
		const theme = fakeTheme({
			...DISTINCT,
			toolDiffAdded: DISTINCT["success"] as string,
			toolTitle: DISTINCT["warning"] as string,
		});
		const palette = buildSpinnerPalette(theme);
		assert.deepEqual(palette.tokens, ["accent", "success", "warning", "syntaxKeyword", "toolDiffRemoved"]);
		assert.equal(palette.frames?.length, expectedPeriod(19, 5));

		const runs = colorRuns(palette.frames as string[], DISTINCT);
		assert.ok(runs.every((run) => run.length === 19));
		for (const [index, run] of runs.entries()) {
			assert.notEqual(run.color, runs[index + 1]?.color, `第 ${index} 段与下一段同色`);
		}
		// 撞车的是后出现的那个槽位（去重保留首次出现者）。
		assert.ok(!palette.tokens.includes("toolDiffAdded"));
		assert.ok(!palette.tokens.includes("toolTitle"));
	});

	it("只剩一种颜色时不下发帧表（调用方保持 pi 默认 spinner）", () => {
		const allSame = fakeTheme(Object.fromEntries(SPINNER_COLOR_TOKENS.map((token) => [token, "<all>"])));
		const palette = buildSpinnerPalette(allSame);
		assert.equal(palette.frames, null);
		assert.deepEqual(palette.tokens, ["accent"]);
	});

	it("恒等主题（NO_COLOR / 非 TUI）也是单色 → frames 为 null", () => {
		const identity: SpinnerColorize = (_token, text) => text;
		assert.equal(buildSpinnerPalette(identity).frames, null);
	});

	it("指纹随主题变、同主题稳定（换肤后靠它决定重装）", () => {
		const first = buildSpinnerPalette(fakeTheme(DISTINCT)).signature;
		assert.equal(buildSpinnerPalette(fakeTheme(DISTINCT)).signature, first);
		assert.notEqual(buildSpinnerPalette(fakeTheme({ ...DISTINCT, accent: "<other>" })).signature, first);

		// 被去重丢掉的槽位（颜色与前一个槽位撞车）改了颜色也不影响指纹 —— 它不参与轮换。
		const signatureWithDropped = (dropped: string): string =>
			buildSpinnerPalette(
				fakeTheme({ ...DISTINCT, toolDiffAdded: dropped, toolTitle: DISTINCT["warning"] as string }),
			).signature;
		assert.equal(
			signatureWithDropped(DISTINCT["accent"] as string),
			signatureWithDropped(DISTINCT["success"] as string),
		);
	});

	it("取色探针是非空文本（空串取色分辨不出色槽）", () => {
		const probes: string[] = [];
		buildSpinnerPalette((token, text) => {
			probes.push(text);
			return `${token}${text}`;
		});
		assert.ok(probes.length >= SPINNER_COLOR_TOKENS.length);
		assert.ok(probes.every((text) => text.length > 0));
	});
});
