/**
 * Tests for plan-doc.ts — 计划文档的路径生成（纯逻辑）。
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/plan-doc.test.ts
 *
 * 三件事最要紧：
 *   1. slug 必须是**纯英文 kebab-case**：CJK 与标点一律折掉，路径分隔符与 `..` 进不了
 *      文件名（slug 是模型写的自由文本，会直接进文件名，漏掉就等于给了它一个往
 *      `.pi/plans/` 之外写文件的路径）。
 *   2. 撞名追加 `-2` / `-3`，**绝不覆盖**已有计划。
 *   3. 日期是本地日历，不是 UTC（跨时区会话里 UTC 会差一天）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	MAX_SLUG_LENGTH,
	PLAN_DOC_DIR,
	buildPlanDocPath,
	localDateString,
	planDocSlug,
} from "./plan-doc.ts";

/** 固定时刻：2026-09-24 15:04:05 本地时间。 */
const NOW = new Date(2026, 8, 24, 15, 4, 5);

describe("planDocSlug", () => {
	it("英文短名原样成 slug（转小写）", () => {
		assert.equal(planDocSlug("m5-entity-runtime"), "m5-entity-runtime");
		assert.equal(planDocSlug("M5 Entity Runtime"), "m5-entity-runtime");
	});

	it("中英混合只留英文词", () => {
		assert.equal(planDocSlug("修复 m5 entity runtime 的 bug"), "m5-entity-runtime-bug");
	});

	it("纯中文退回 plan（不做音译）", () => {
		assert.equal(planDocSlug("给审批闸加三个选项"), "plan");
	});

	it("模型写的中文长句总结不会变成超长文件名（只留英文词，其余折掉）", () => {
		const slug = planDocSlug(
			"两个问题的真因都已实测定位：反复弹框是因为批准按命令原文记（换命令、换会话就重问）；grep 那次不是误报，是同一条规则",
		);
		assert.equal(slug, "grep");
		assert.ok([...slug].length < 20);
	});

	it("空白与标点折成单个连字符", () => {
		assert.equal(planDocSlug("add  plan\tdoc"), "add-plan-doc");
		assert.equal(planDocSlug("feat: x, y"), "feat-x-y");
		assert.equal(planDocSlug("snake_case_name"), "snake-case-name");
	});

	it("去掉 markdown 行内包装", () => {
		assert.equal(planDocSlug("fix `plan.ts` **state**"), "fix-plan-ts-state");
	});

	it("路径分隔符被清掉：不能借 slug 写到 .pi/plans/ 之外", () => {
		const slug = planDocSlug("../../etc/passwd");
		assert.ok(!slug.includes("/"), `slug 不该含 /：${slug}`);
		assert.ok(!slug.includes("\\"), `slug 不该含 \\：${slug}`);
		assert.ok(!slug.startsWith("."), `slug 不该以 . 开头：${slug}`);
		assert.equal(slug, "etc-passwd");
	});

	it("Windows 保留字符与控制字符被清掉", () => {
		const slug = planDocSlug('a<b>c:d"e|f?g*h\u0000i');
		assert.equal(slug, "a-b-c-d-e-f-g-h-i");
	});

	it("首尾的连字符与点被剥掉", () => {
		assert.equal(planDocSlug("  --x--  "), "x");
		assert.equal(planDocSlug("..."), "plan");
		assert.equal(planDocSlug("中文-trailing"), "trailing");
	});

	it("空 / 非字符串 / 清洗后为空一律退回 plan", () => {
		assert.equal(planDocSlug(""), "plan");
		assert.equal(planDocSlug("   "), "plan");
		assert.equal(planDocSlug(undefined), "plan");
		assert.equal(planDocSlug("///"), "plan");
	});

	it("超长截断到上限，且尾部不留连字符", () => {
		const long = planDocSlug("word-".repeat(200));
		assert.ok([...long].length <= MAX_SLUG_LENGTH, [...long].length);
		assert.ok(!long.endsWith("-"), long);
	});

	it("截断不劈开代理对", () => {
		const emoji = planDocSlug("😀".repeat(200));
		assert.equal(emoji, "plan"); // emoji 全被折掉
	});
});

describe("localDateString", () => {
	it("用本地日历，不是 UTC", () => {
		assert.equal(localDateString(NOW), "2026-09-24");
	});

	it("月与日补零", () => {
		assert.equal(localDateString(new Date(2026, 0, 5, 1, 2, 3)), "2026-01-05");
	});
});

describe("buildPlanDocPath", () => {
	it("落在 <cwd>/.pi/plans/YYYY-MM-DD-<slug>.md", () => {
		const path = buildPlanDocPath({ cwd: "/repo", slug: "add-options", now: NOW });
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-add-options.md`);
	});

	it("中英混合的 slug 只留英文部分", () => {
		const path = buildPlanDocPath({ cwd: "/repo", slug: "修复 m5 entity runtime", now: NOW });
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-m5-entity-runtime.md`);
	});

	it("没有 slug 时用兜底 slug", () => {
		const path = buildPlanDocPath({ cwd: "/repo", now: NOW });
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-plan.md`);
	});

	it("不传 exists 时不做撞名处理（第一次就用原名）", () => {
		const path = buildPlanDocPath({ cwd: "/repo", slug: "x", now: NOW });
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-x.md`);
	});

	it("撞名追加 -2 / -3，绝不覆盖已有文件", () => {
		const taken = new Set([
			`/repo/${PLAN_DOC_DIR}/2026-09-24-x.md`,
			`/repo/${PLAN_DOC_DIR}/2026-09-24-x-2.md`,
		]);
		const path = buildPlanDocPath({
			cwd: "/repo",
			slug: "x",
			now: NOW,
			exists: (candidate) => taken.has(candidate),
		});
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-x-3.md`);
	});

	it("原名可用时不加后缀", () => {
		const path = buildPlanDocPath({
			cwd: "/repo",
			slug: "x",
			now: NOW,
			exists: () => false,
		});
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-x.md`);
	});

	it("99 个后缀全被占用时退回时分秒，仍然不覆盖", () => {
		const path = buildPlanDocPath({
			cwd: "/repo",
			slug: "x",
			now: NOW,
			exists: (candidate) => !candidate.endsWith("-150405.md"),
		});
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-x-150405.md`);
	});

	it("cwd 带尾斜杠也能拼出干净路径", () => {
		const path = buildPlanDocPath({ cwd: "/repo/", slug: "x", now: NOW });
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-x.md`);
	});

	it("slug 里的路径穿越进不了最终路径", () => {
		const path = buildPlanDocPath({ cwd: "/repo", slug: "../../../etc/passwd", now: NOW });
		assert.ok(path.startsWith(`/repo/${PLAN_DOC_DIR}/`), path);
		assert.ok(!path.includes(".."), path);
	});
});
