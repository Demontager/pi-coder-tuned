/**
 * Tests for plan-doc.ts — the plan document's path generation (pure logic).
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/plan-doc.test.ts
 *
 * Three things matter most:
 *   1. The slug must be **plain English kebab-case**: CJK and punctuation fold away; path
 *      separators and `..` must never reach the filename (the slug is free text the model
 *      wrote and lands in the filename verbatim — a leak hands it a path to write outside
 *      `.pi/plans/`).
 *   2. Collisions append `-2` / `-3` and **never overwrite** an existing plan.
 *   3. The date is the local calendar, not UTC (a cross-timezone session's date may differ
 *      by a day).
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

/** Fixed instant: 2026-09-24 15:04:05 local time. */
const NOW = new Date(2026, 8, 24, 15, 4, 5);

describe("planDocSlug", () => {
	it("a short English name becomes the slug verbatim (lowercased)", () => {
		assert.equal(planDocSlug("m5-entity-runtime"), "m5-entity-runtime");
		assert.equal(planDocSlug("M5 Entity Runtime"), "m5-entity-runtime");
	});

	it("mixed CJK/English keeps only the English words", () => {
		assert.equal(planDocSlug("修复 m5 entity runtime 的 bug"), "m5-entity-runtime-bug");
	});

	it("an all-Chinese slug falls back to plan (no transliteration)", () => {
		assert.equal(planDocSlug("给审批闸加三个选项"), "plan");
	});

	it("a long Chinese summary from the model never becomes a huge filename (only English words survive, the rest folds away)", () => {
		const slug = planDocSlug(
			"两个问题的真因都已实测定位：反复弹框是因为批准按命令原文记（换命令、换会话就重问）；grep 那次不是误报，是同一条规则",
		);
		assert.equal(slug, "grep");
		assert.ok([...slug].length < 20);
	});

	it("whitespace and punctuation fold into single hyphens", () => {
		assert.equal(planDocSlug("add  plan\tdoc"), "add-plan-doc");
		assert.equal(planDocSlug("feat: x, y"), "feat-x-y");
		assert.equal(planDocSlug("snake_case_name"), "snake-case-name");
	});

	it("markdown inline wrappers are stripped", () => {
		assert.equal(planDocSlug("fix `plan.ts` **state**"), "fix-plan-ts-state");
	});

	it("path separators are cleaned: a slug cannot write outside .pi/plans/", () => {
		const slug = planDocSlug("../../etc/passwd");
		assert.ok(!slug.includes("/"), `slug must not contain /: ${slug}`);
		assert.ok(!slug.includes("\\"), `slug must not contain \\: ${slug}`);
		assert.ok(!slug.startsWith("."), `slug must not start with .: ${slug}`);
		assert.equal(slug, "etc-passwd");
	});

	it("Windows reserved characters and control characters are cleaned", () => {
		const slug = planDocSlug('a<b>c:d"e|f?g*h\u0000i');
		assert.equal(slug, "a-b-c-d-e-f-g-h-i");
	});

	it("leading/trailing hyphens and dots are stripped", () => {
		assert.equal(planDocSlug("  --x--  "), "x");
		assert.equal(planDocSlug("..."), "plan");
		assert.equal(planDocSlug("中文-trailing"), "trailing");
	});

	it("empty / non-string / cleaned-to-empty all fall back to plan", () => {
		assert.equal(planDocSlug(""), "plan");
		assert.equal(planDocSlug("   "), "plan");
		assert.equal(planDocSlug(undefined), "plan");
		assert.equal(planDocSlug("///"), "plan");
	});

	it("an overlong slug truncates to the cap, leaving no trailing hyphen", () => {
		const long = planDocSlug("word-".repeat(200));
		assert.ok([...long].length <= MAX_SLUG_LENGTH, [...long].length);
		assert.ok(!long.endsWith("-"), long);
	});

	it("truncation never splits a surrogate pair", () => {
		const emoji = planDocSlug("😀".repeat(200));
		assert.equal(emoji, "plan"); // every emoji folds away
	});
});

describe("localDateString", () => {
	it("uses the local calendar, not UTC", () => {
		assert.equal(localDateString(NOW), "2026-09-24");
	});

	it("month and day are zero-padded", () => {
		assert.equal(localDateString(new Date(2026, 0, 5, 1, 2, 3)), "2026-01-05");
	});
});

describe("buildPlanDocPath", () => {
	it("lands at <cwd>/.pi/plans/YYYY-MM-DD-<slug>.md", () => {
		const path = buildPlanDocPath({ cwd: "/repo", slug: "add-options", now: NOW });
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-add-options.md`);
	});

	it("a mixed CJK/English slug keeps only the English part", () => {
		const path = buildPlanDocPath({ cwd: "/repo", slug: "修复 m5 entity runtime", now: NOW });
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-m5-entity-runtime.md`);
	});

	it("the fallback slug is used when none is given", () => {
		const path = buildPlanDocPath({ cwd: "/repo", now: NOW });
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-plan.md`);
	});

	it("no exists → no collision handling (the plain name is used first)", () => {
		const path = buildPlanDocPath({ cwd: "/repo", slug: "x", now: NOW });
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-x.md`);
	});

	it("collisions append -2 / -3, never overwriting an existing file", () => {
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

	it("no suffix when the plain name is free", () => {
		const path = buildPlanDocPath({
			cwd: "/repo",
			slug: "x",
			now: NOW,
			exists: () => false,
		});
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-x.md`);
	});

	it("with all 99 suffixes taken it falls back to hour-min-sec — still never overwriting", () => {
		const path = buildPlanDocPath({
			cwd: "/repo",
			slug: "x",
			now: NOW,
			exists: (candidate) => !candidate.endsWith("-150405.md"),
		});
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-x-150405.md`);
	});

	it("a trailing-slash cwd still produces a clean path", () => {
		const path = buildPlanDocPath({ cwd: "/repo/", slug: "x", now: NOW });
		assert.equal(path, `/repo/${PLAN_DOC_DIR}/2026-09-24-x.md`);
	});

	it("path traversal inside a slug cannot reach the final path", () => {
		const path = buildPlanDocPath({ cwd: "/repo", slug: "../../../etc/passwd", now: NOW });
		assert.ok(path.startsWith(`/repo/${PLAN_DOC_DIR}/`), path);
		assert.ok(!path.includes(".."), path);
	});
});
