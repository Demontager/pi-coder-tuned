/**
 * Tests for bar.ts — 纯逻辑：吃掉落内边距那一格、换成竖线；背景槽转前景取色；补丁幂等。
 *
 * Run with:  node --test clients/pi/extensions/user-message-bar/bar.test.ts
 *
 * 这里用**手写的假行**（形状照 `UserMessageComponent.render` 的真实输出抄：行首 `\x1b[48;…m`、
 * 行尾 `\x1b[49m`、恢复会话首行前面还有 `\x1b]133;A\x07`），只用 ANSI 剥离与字符计数做断言，
 * 所以不需要 pi / pi-tui。真实链路（补丁真的打在 pi 渲染用的那个类上）在 `index.test.ts`。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { BAR_GLYPH, addBarToLine, installUserMessageBar, resolveBarAnsi } from "./bar.ts";

const BG = "\u001b[48;2;27;28;29m";
const BG_RESET = "\u001b[49m";
const FG = "\u001b[38;2;198;200;209m";
const FG_RESET = "\u001b[39m";
const ZONE = "\u001b]133;A\u0007";
const BAR = "\u001b[38;2;45;44;93m\u258f\u001b[39m";

/** 去掉所有零宽序列后的可见文本（这些 fixture 全是等宽字符，长度即列数）。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

test("常规行：行首内边距空格换成竖线，其余字节不变", () => {
	const line = `${BG} ${FG}你好${FG_RESET}    ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(result, `${BG}${BAR}${FG}你好${FG_RESET}    ${BG_RESET}`);
	assert.equal(plain(result), `${BAR_GLYPH}你好    `, "第一格变成竖线，正文原样");
	assert.equal(plain(result).length, plain(line).length, "行宽不变");
});

test("空的内边距行（盒子的上下留白）也吃第一格", () => {
	const line = `${BG}${" ".repeat(20)}${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(plain(result), `${BAR_GLYPH}${" ".repeat(19)}`);
	assert.equal(plain(result).length, 20);
});

test("OSC 133 zone 标记与底色序列都留在竖线前面", () => {
	const line = `${ZONE}${BG} 正文${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(result, `${ZONE}${BG}${BAR}正文${BG_RESET}`, "zone 标记与底色前缀原样保留");
	assert.equal(plain(result), `${BAR_GLYPH}正文`);
});

test("outputPad = 0：不吃正文，改为从行尾补白里抵消一格", () => {
	const line = `${BG}${FG}正文${FG_RESET}   ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	// 行首的底色 + 前景前缀都算零宽前缀：竖线落在它们之后、正文之前
	assert.equal(result, `${BG}${FG}${BAR}正文${FG_RESET}  ${BG_RESET}`);
	assert.equal(plain(result).length, plain(line).length, "行宽不变");
});

test("outputPad = 0 且正文正好铺满一行：宁可这行没有竖线，也不能撑宽", () => {
	const line = `${BG}${FG}正文正好铺满${FG_RESET}${BG_RESET}`;
	assert.equal(addBarToLine(line, BAR), line);
});

test("正文里的空格不算补白（后面还有内容），不吃字符", () => {
	const line = `${BG}${FG}a b${FG_RESET}${BG_RESET}`;
	assert.equal(addBarToLine(line, BAR), line, "行首是正文、行尾没补白 → 原样返回");
});

test("空行与纯转义行不抛，原样返回", () => {
	assert.equal(addBarToLine("", BAR), "");
	assert.equal(addBarToLine(BG_RESET, BAR), BG_RESET);
});

test("取色：默认槽位是 diff 新增行行号色 toolDiffAdded（前景槽，不做转换）", () => {
	const theme = {
		getFgAnsi: (name: string) => {
			if (name === "toolDiffAdded") return "\u001b[38;2;137;184;194m"; // #89b8c2 = summer-night 的 teal
			throw new Error(`Unknown theme color: ${name}`);
		},
		getBgAnsi: (name: string) => {
			throw new Error(`Unknown theme background color: ${name}`);
		},
	};
	assert.equal(resolveBarAnsi(theme), "\u001b[38;2;137;184;194m");
});

test("取色：背景槽 selectedBg 转成前景（38/48 等值）", () => {
	const theme = {
		getFgAnsi: (name: string) => {
			throw new Error(`Unknown theme color: ${name}`);
		},
		getBgAnsi: (name: string) => {
			assert.equal(name, "selectedBg");
			return "\u001b[48;2;45;44;93m";
		},
	};
	assert.equal(resolveBarAnsi(theme), "\u001b[38;2;45;44;93m");
});

test("取色：256 色皮肤同样只换 38/48 这一个数字", () => {
	const theme = {
		getFgAnsi: () => {
			throw new Error("Unknown theme color");
		},
		getBgAnsi: () => "\u001b[48;5;17m",
	};
	assert.equal(resolveBarAnsi(theme), "\u001b[38;5;17m");
});

test("取色：槽位名是前景槽时直接用，不做转换", () => {
	const theme = {
		getFgAnsi: (name: string) => (name === "accent" ? "\u001b[38;2;149;196;206m" : (() => { throw new Error("no"); })()),
		getBgAnsi: () => {
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(theme, "accent"), "\u001b[38;2;149;196;206m");
});

test("取色：首选槽位不存在时按兜底顺序退到 accent，全没有则 undefined", () => {
	const noSelected = {
		getFgAnsi: (name: string) => {
			if (name === "accent") return "\u001b[38;2;1;2;3m";
			throw new Error("no");
		},
		getBgAnsi: () => {
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(noSelected), "\u001b[38;2;1;2;3m", "toolDiffAdded / selectedBg 都缺失 → accent");

	// 旧皮肤常见：只有 selectedBg、没有 toolDiffAdded —— 应落到 selectedBg 的 38 转换上
	const legacy = {
		getFgAnsi: (name: string) => {
			throw new Error("no");
		},
		getBgAnsi: (name: string) => {
			if (name === "selectedBg") return "\u001b[48;2;45;44;93m";
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(legacy), "\u001b[38;2;45;44;93m", "toolDiffAdded 缺失 → selectedBg");

	const empty = {
		getFgAnsi: () => {
			throw new Error("no");
		},
		getBgAnsi: () => {
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(empty), undefined);
	assert.equal(resolveBarAnsi(undefined), undefined);
});

test("补丁：只包一层，重复安装只换取色源", () => {
	let renderCalls = 0;
	class Fake {
		render(width: number): string[] {
			renderCalls += 1;
			return [`${BG} body${" ".repeat(Math.max(0, width - 5))}${BG_RESET}`];
		}
	}

	const first = installUserMessageBar({
		UserMessageComponent: Fake as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => ({ getFgAnsi: () => "\u001b[38;2;1;2;3m", getBgAnsi: () => "" }),
		glyph: "|",
	});
	assert.equal(first, true);

	const second = installUserMessageBar({
		UserMessageComponent: Fake as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => ({ getFgAnsi: () => "\u001b[38;2;4;5;6m", getBgAnsi: () => "" }),
		glyph: "|",
	});
	assert.equal(second, false, "第二次不该再包一层");

	const lines = new Fake().render(10);
	assert.equal(renderCalls, 1, "原始 render 只被调用一次");
	assert.equal(lines.length, 1);
	assert.equal(plain(lines[0]), "|body     ", "只加一条竖线，且换成了新的取色源");
	assert.equal(lines[0].includes("\u001b[38;2;4;5;6m"), true, "取色源已更新");
});

test("补丁：取色源拿不到颜色时原样返回（不抛、不加）", () => {
	class Fake {
		render(): string[] {
			return [`${BG} body${BG_RESET}`];
		}
	}
	installUserMessageBar({
		UserMessageComponent: Fake as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => undefined,
		glyph: "|",
	});
	assert.deepEqual(new Fake().render(), [`${BG} body${BG_RESET}`]);
});

test("补丁：原型没有 render 时什么都不做", () => {
	class Weird {}
	const installed = installUserMessageBar({
		UserMessageComponent: Weird as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => ({ getFgAnsi: () => "\u001b[38;2;1;2;3m", getBgAnsi: () => "" }),
	});
	assert.equal(installed, false);
});
