/**
 * Tests for line.ts — the statusline main line and the extension-status line.
 *
 * Run with:  node --test clients/pi/extensions/statusline/line.test.ts
 *
 * line.ts never imports pi / pi-tui, so plain fakes reach every branch: `plain` drops
 * colours (assert exact visible text), `painted` wraps each run as `color(text)` (assert
 * which theme colour slot every part uses).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	type StatuslineGitSource,
	type StatuslineSource,
	type StatuslineState,
	type StatuslineTheme,
	BRANCH_ICON,
	composeFooterLines,
	ELLIPSIS,
	formatExtensionStatuses,
	formatMainLine,
} from "./line.ts";

const plain: StatuslineTheme = { fg: (_color, text) => text };
const painted: StatuslineTheme = { fg: (color, text) => `${color}(${text})` };

const FLASH = { id: "qwen3.8-flash" };
const DOC = "⚡️ qwen3.8-flash/xhigh | Ctx 0.0%";

function sourceOf(
	percent: number | null = 0,
	model: { id?: string } | null = FLASH,
	level = "xhigh",
): StatuslineSource {
	const resolved = model === null ? undefined : model;
	return {
		model: resolved,
		thinkingLevel: level,
		getContextUsage: () => (percent === null ? undefined : { percent }),
	};
}

function gitOf(
	branch: string | null,
	statuses: ReadonlyMap<string, string> = new Map(),
): StatuslineGitSource {
	return { getGitBranch: () => branch, getExtensionStatuses: () => statuses };
}

function stateOf(overrides: Partial<StatuslineState> = {}): StatuslineState {
	return { streaming: false, activeTools: new Map(), diffStat: undefined, ...overrides };
}

describe("BRANCH_ICON", () => {
	it("pins the exact code point of the branch glyph", () => {
		// 近形字符很容易贴错（同区块的 ⑂ / ⑃ / ⑁ 长得几乎一样），所以用转义把码位钉死，不依赖裸字形。
		assert.equal(BRANCH_ICON, "\u2442");
		assert.equal(BRANCH_ICON.codePointAt(0), 0x2442);
		assert.equal([...BRANCH_ICON].length, 1);
	});
});

describe("formatMainLine", () => {
	it("renders the documented line inside a repo", () => {
		assert.equal(
			formatMainLine(plain, sourceOf(0), gitOf("main"), stateOf({ diffStat: { added: 0, deleted: 0 } })),
			`${DOC} | \u2442 main | (+0,-0)`,
		);
	});

	it("shows real diff counts", () => {
		assert.equal(
			formatMainLine(plain, sourceOf(), gitOf("main"), stateOf({ diffStat: { added: 12, deleted: 3 } })),
			`${DOC} | \u2442 main | (+12,-3)`,
		);
	});

	it("shows zeros before the first git read lands", () => {
		assert.equal(formatMainLine(plain, sourceOf(), gitOf("main"), stateOf()), `${DOC} | \u2442 main | (+0,-0)`);
	});

	it("replaces both git segments outside a repo", () => {
		assert.equal(
			formatMainLine(plain, sourceOf(), gitOf(null), stateOf({ diffStat: { added: 9, deleted: 9 } })),
			`${DOC} | \u2442 no git | (no git)`,
		);
	});

	it("renders a detached head", () => {
		assert.ok(formatMainLine(plain, sourceOf(), gitOf("detached"), stateOf()).includes("\u2442 detached"));
	});

	it("appends thinking while streaming and the tool name instead once a tool runs", () => {
		assert.equal(
			formatMainLine(plain, sourceOf(), gitOf("main"), stateOf({ streaming: true })),
			`${DOC} | \u2442 main | (+0,-0) | thinking`,
		);
		assert.equal(
			formatMainLine(
				plain,
				sourceOf(),
				gitOf("main"),
				stateOf({ streaming: true, activeTools: new Map([["bash", 1]]) }),
			),
			`${DOC} | \u2442 main | (+0,-0) | bash`,
		);
	});

	it("annotates repeated and additional concurrent tools", () => {
		const twice = formatMainLine(plain, sourceOf(), gitOf("main"), stateOf({ activeTools: new Map([["read", 2]]) }));
		const several = formatMainLine(
			plain,
			sourceOf(),
			gitOf("main"),
			stateOf({ activeTools: new Map([["read", 1], ["bash", 1]]) }),
		);
		assert.ok(twice.endsWith("| read×2"), twice);
		assert.ok(several.endsWith("| read+1"), several);
	});

	it("questions the context when usage is unknown", () => {
		assert.equal(
			formatMainLine(plain, sourceOf(null, { id: "mystery" }), gitOf("main"), stateOf()),
			"⚡️ mystery/xhigh | Ctx ? | \u2442 main | (+0,-0)",
		);
	});

	it("survives a missing model", () => {
		assert.equal(
			formatMainLine(plain, sourceOf(null, null), gitOf(null), stateOf()),
			"⚡️ no-model/xhigh | Ctx ? | \u2442 no git | (no git)",
		);
	});

	it("appends the current thinking level to the model id", () => {
		for (const level of ["off", "low", "high", "max"]) {
			assert.ok(
				formatMainLine(plain, sourceOf(0, FLASH, level), gitOf("main"), stateOf()).startsWith(
					`⚡️ qwen3.8-flash/${level} | `,
				),
				level,
			);
		}
	});

	it("drops the level suffix when it is empty or the getter throws", () => {
		assert.ok(
			formatMainLine(plain, sourceOf(0, FLASH, ""), gitOf("main"), stateOf()).startsWith(
				"⚡️ qwen3.8-flash | ",
			),
		);
		const throwing: StatuslineSource = {
			model: FLASH,
			get thinkingLevel(): never {
				throw new Error("stale context");
			},
			getContextUsage: () => ({ percent: 0 }),
		};
		assert.ok(
			formatMainLine(plain, throwing, gitOf("main"), stateOf()).startsWith("⚡️ qwen3.8-flash | "),
		);
	});

	it("treats throwing context getters as unknown", () => {
		const stale: StatuslineSource = {
			get model(): never {
				throw new Error("stale context");
			},
			get thinkingLevel(): never {
				throw new Error("stale context");
			},
			getContextUsage(): never {
				throw new Error("stale context");
			},
		};
		assert.equal(formatMainLine(plain, stale, gitOf("main"), stateOf()), "⚡️ no-model | Ctx ? | \u2442 main | (+0,-0)");
	});

	it("paints labels and separators dim, model / branch / percent by role", () => {
		assert.equal(
			formatMainLine(painted, sourceOf(0), gitOf("main"), stateOf({ diffStat: { added: 1, deleted: 2 } })),
			"⚡️ accent(qwen3.8-flash)dim(/)syntaxFunction(xhigh)dim( | )dim(Ctx) success(0.0%)dim( | )" +
				"dim(\u2442) accent(main)dim( | )dim(()success(+1)dim(,)error(-2)dim())",
		);
	});

	it("shifts the context colour at 70% and 90%", () => {
		const colored = (percent: number | null) => formatMainLine(painted, sourceOf(percent), gitOf("main"), stateOf());
		assert.ok(colored(69.9).includes("success(69.9%)"));
		assert.ok(colored(70).includes("warning(70.0%)"));
		assert.ok(colored(95.4).includes("error(95.4%)"));
		assert.ok(colored(null).includes("dim(?)"));
	});

	it("paints the state segment warning and nothing when idle", () => {
		assert.ok(
			formatMainLine(painted, sourceOf(), gitOf("main"), stateOf({ streaming: true })).endsWith("dim( | )warning(thinking)"),
		);
		assert.ok(
			formatMainLine(
				painted,
				sourceOf(),
				gitOf("main"),
				stateOf({ activeTools: new Map([["bash", 1]]) }),
			).endsWith("dim( | )warning(bash)"),
		);
		assert.equal(formatMainLine(painted, sourceOf(), gitOf("main"), stateOf()).includes("thinking"), false);
	});
});

describe("formatExtensionStatuses", () => {
	it("joins statuses set by other extensions", () => {
		const statuses = new Map([
			["cwd", " 📁 /Users/bachi/jaylli/litellm-any"],
			["rewind", "◆ 3 checkpoints"],
		]);
		assert.equal(
			formatExtensionStatuses(plain, gitOf("main", statuses)),
			"📁 /Users/bachi/jaylli/litellm-any | ◆ 3 checkpoints",
		);
	});

	it("keeps pre-coloured status text verbatim and mutes plain text", () => {
		const esc = String.fromCharCode(27);
		const coloured = `${esc}[2m` + "◆ " + "checkpoints" + `${esc}[0m`;
		const statuses = new Map([
			["rewind", coloured],
			["cwd", " 📁 /tmp/repo"],
		]);
		const rendered = formatExtensionStatuses(painted, gitOf("main", statuses));
		assert.ok(rendered.startsWith(coloured + "dim( | )"), rendered);
		assert.ok(rendered.endsWith("muted(📁 /tmp/repo)"), rendered);
	});

	it("skips blank values and its own statusline key", () => {
		const statuses = new Map([
			["statusline", "stale"],
			["retry", "   "],
			["cwd", " 📁 /tmp/repo"],
		]);
		assert.equal(formatExtensionStatuses(plain, gitOf("main", statuses)), "📁 /tmp/repo");
		assert.equal(formatExtensionStatuses(plain, gitOf("main", new Map())), "");
	});

	it("caps the status line at five entries", () => {
		const statuses = new Map(
			Array.from({ length: 7 }, (_, i): [string, string] => [`k${i}`, `v${i}`]),
		);
		const rendered = formatExtensionStatuses(plain, gitOf("main", statuses));
		assert.equal(rendered.split(" | ").length, 5);
		assert.ok(rendered.endsWith("v4") && !rendered.includes("v5"), rendered);
	});
});

describe("composeFooterLines", () => {
	function recorder() {
		const calls: Array<{ text: string; width: number; ellipsis: string }> = [];
		const truncate = (text: string, max: number, ellipsis: string) => {
			calls.push({ text, width: max, ellipsis });
			return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}${ellipsis}` : text;
		};
		return { calls, truncate };
	}

	it("indents every line by exactly one space and never wraps", () => {
		const { truncate } = recorder();
		const statuses = new Map([["cwd", " 📁 /tmp/repo"]]);
		const lines = composeFooterLines(
			plain,
			sourceOf(),
			gitOf("main", statuses),
			stateOf(),
			200,
			truncate,
		);
		assert.equal(lines.length, 2);
		for (const line of lines) {
			assert.ok(line.startsWith(" "), JSON.stringify(line));
			assert.ok(!line.startsWith("  "), JSON.stringify(line));
			assert.equal(line.includes("\n"), false);
		}
		assert.ok(lines[0]?.includes(`${DOC} | \u2442 main | (+0,-0)`), lines[0]);
		assert.equal(lines[1], " 📁 /tmp/repo");
	});

	it("emits a single line when no other extension set a status", () => {
		const lines = composeFooterLines(plain, sourceOf(), gitOf("main"), stateOf(), 200, (t) => t);
		assert.equal(lines.length, 1);
	});

	it("truncates an over-long line and leaves a short one intact", () => {
		const { calls, truncate } = recorder();
		const lines = composeFooterLines(
			plain,
			sourceOf(),
			gitOf("main", new Map([["cwd", " 📁 /tmp/repo"]])),
			stateOf(),
			20,
			truncate,
		);
		assert.equal(calls.length, 2);
		assert.equal(calls[0]?.width, 20);
		assert.equal(calls[0]?.ellipsis, ELLIPSIS);
		assert.equal([...(lines[0] ?? "")].length, 20, lines[0]);
		assert.ok(lines[0]?.endsWith(ELLIPSIS), lines[0]);
		assert.equal(lines[0]?.includes("\n"), false);
		assert.equal(lines[1], " 📁 /tmp/repo");
	});

	it("renders nothing for a non-positive width", () => {
		assert.deepEqual(composeFooterLines(plain, sourceOf(), gitOf("main"), stateOf(), 0, (t) => t), []);
	});
});
