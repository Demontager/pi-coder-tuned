/**
 * Tests for validate.ts — 归一化（行终止符 / 单行化 / 截断）+ 运行时校验。
 *
 * Run with:  node --test clients/pi/extensions/ask-user-question/validate.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ERROR_DUPLICATE_OPTION_LABEL,
	ERROR_DUPLICATE_QUESTION,
	ERROR_NO_QUESTIONS,
	ERROR_RESERVED_LABEL,
	ERROR_TOO_FEW_OPTIONS,
	ERROR_TOO_MANY_OPTIONS,
	ERROR_TOO_MANY_QUESTIONS,
	normalizeLineTerminators,
	normalizeParams,
	validateQuestionnaire,
} from "./validate.ts";
import { MAX_HEADER_LENGTH, MAX_LABEL_LENGTH, type AskParams } from "./types.ts";

function option(label: string, description = "desc") {
	return { label, description };
}

function params(overrides: Partial<AskParams> = {}): AskParams {
	return {
		questions: [
			{
				question: "Which library should we use?",
				header: "Library",
				options: [option("date-fns"), option("dayjs")],
			},
		],
		...overrides,
	};
}

test("normalizeLineTerminators: CRLF 折成 LF，落单 CR 删除", () => {
	assert.equal(normalizeLineTerminators("a\r\nb"), "a\nb");
	assert.equal(normalizeLineTerminators("GEMBA\r_LOG\r_FILE"), "GEMBA_LOG_FILE");
	assert.equal(normalizeLineTerminators("a\nb"), "a\nb");
});

test("normalizeParams: header 超长截断补 …", () => {
	const long = "x".repeat(MAX_HEADER_LENGTH + 10);
	const out = normalizeParams(params({ questions: [{ ...params().questions[0], header: long }] }));
	const header = out.questions[0].header;
	assert.equal(header.length, MAX_HEADER_LENGTH);
	assert.ok(header.endsWith("…"));
});

test("normalizeParams: label 超长截断补 …", () => {
	const long = "y".repeat(MAX_LABEL_LENGTH + 5);
	const out = normalizeParams(
		params({ questions: [{ ...params().questions[0], options: [option(long), option("b")] }] }),
	);
	assert.equal(out.questions[0].options[0].label.length, MAX_LABEL_LENGTH);
	assert.ok(out.questions[0].options[0].label.endsWith("…"));
});

test("normalizeParams: header/label/description 单行化（空白串折叠），question 保留换行", () => {
	const out = normalizeParams(
		params({
			questions: [
				{
					question: "line one\r\nline two",
					header: "  Auth\r\nmethod  ",
					options: [{ label: "  A\r\nB ", description: "d1\n\n  d2 " }],
				},
				{ ...params().questions[0], question: "other" },
			],
		}),
	);
	assert.equal(out.questions[0].question, "line one\nline two");
	assert.equal(out.questions[0].header, "Auth method");
	assert.equal(out.questions[0].options[0].label, "A B");
	assert.equal(out.questions[0].options[0].description, "d1 d2");
});

test("normalizeParams: multiSelect 归一成布尔，不改入参", () => {
	const input = params({ questions: [{ ...params().questions[0], multiSelect: undefined }] });
	const out = normalizeParams(input);
	assert.equal(out.questions[0].multiSelect, false);
	assert.equal(input.questions[0].multiSelect, undefined);
});

test("validateQuestionnaire: 合法问卷通过", () => {
	assert.deepEqual(validateQuestionnaire(normalizeParams(params())), { ok: true });
});

test("validateQuestionnaire: 空 questions → no_questions", () => {
	const result = validateQuestionnaire({ questions: [] });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.error, "no_questions");
		assert.equal(result.message, ERROR_NO_QUESTIONS);
	}
});

test("validateQuestionnaire: 超过 4 题 → too_many_questions", () => {
	const q = params().questions[0];
	const five = {
		questions: [1, 2, 3, 4, 5].map((i) => ({ ...q, question: `Q${i}?`, header: `H${i}` })),
	};
	const result = validateQuestionnaire(five);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.error, "too_many_questions");
		assert.equal(result.message, ERROR_TOO_MANY_QUESTIONS);
	}
});

test("validateQuestionnaire: 重复问题文本 → duplicate_question", () => {
	const q = params().questions[0];
	const result = validateQuestionnaire({ questions: [q, { ...q, header: "Again" }] });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.error, "duplicate_question");
		assert.equal(result.message, ERROR_DUPLICATE_QUESTION);
	}
});

test("validateQuestionnaire: 选项太少 / 太多", () => {
	const q = params().questions[0];
	const tooFew = validateQuestionnaire({ questions: [{ ...q, options: [option("only")] }] });
	assert.equal(tooFew.ok, false);
	if (!tooFew.ok) {
		assert.equal(tooFew.error, "too_few_options");
		assert.equal(tooFew.message, ERROR_TOO_FEW_OPTIONS);
	}
	const tooMany = validateQuestionnaire({
		questions: [{ ...q, options: [option("a"), option("b"), option("c"), option("d"), option("e")] }],
	});
	assert.equal(tooMany.ok, false);
	if (!tooMany.ok) {
		assert.equal(tooMany.error, "too_many_options");
		assert.equal(tooMany.message, ERROR_TOO_MANY_OPTIONS);
	}
});

test("validateQuestionnaire: 保留 label（Other / Type something.）被拒", () => {
	for (const label of ["Other", "Type something."]) {
		const result = validateQuestionnaire({
			questions: [{ ...params().questions[0], options: [option(label), option("b")] }],
		});
		assert.equal(result.ok, false, `label ${label} should be rejected`);
		if (!result.ok) {
			assert.equal(result.error, "reserved_label");
			assert.equal(result.message, ERROR_RESERVED_LABEL);
		}
	}
});

test("validateQuestionnaire: 同题重复 label → duplicate_option_label", () => {
	const result = validateQuestionnaire({
		questions: [{ ...params().questions[0], options: [option("same"), option("same")] }],
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.error, "duplicate_option_label");
		assert.equal(result.message, ERROR_DUPLICATE_OPTION_LABEL);
	}
});

test("reserved_label 短路在 duplicate_option_label 之前（两个 Other）", () => {
	const result = validateQuestionnaire({
		questions: [{ ...params().questions[0], options: [option("Other"), option("Other")] }],
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error, "reserved_label");
});

test("归一化后再校验：\"Other\\r\" 不能溜过 reserved_label", () => {
	const normalized = normalizeParams({
		questions: [{ ...params().questions[0], options: [option("Other\r"), option("b")] }],
	});
	assert.equal(normalized.questions[0].options[0].label, "Other");
	const result = validateQuestionnaire(normalized);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error, "reserved_label");
});
