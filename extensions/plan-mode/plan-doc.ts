/**
 * plan-doc.ts — the plan document's **path generation** (pure logic; no pi / pi-tui / node:fs).
 *
 * The document body is written by the model itself (the explored background, file structure,
 * and verification approaches exist only in its context — an extension-written doc could only
 * be as thin as a task list). This module answers exactly one question: **which file to
 * write to**.
 *
 * ## Convention
 *
 *   <cwd>/.pi/plans/YYYY-MM-DD-<slug>.md
 *
 *   - `.pi/plans/`: pi-specific, semantically separate from the git-tracked `.claude/plans/`
 *     (Claude Code's plans); `docs/` is "frozen artifacts, not a generated directory", so
 *     dynamic plan documents do not go there.
 *   - The date uses the **local calendar** (same convention as usage-report.js); same-day
 *     plans are distinguished by slug.
 *   - The slug comes from `exit_plan_mode`'s `slug` parameter (the model's short English name,
 *     e.g. `m5-entity-runtime`); absent or cleaned-to-empty falls back to `plan`.
 *   - A name collision (same day, same slug) appends `-2` / `-3` instead of overwriting —
 *     overwriting would destroy the previous plan.
 *
 * ## Why `exists` is injected
 *
 * The collision check must ask the filesystem, but this module stays pure for testability
 * (same rule as plan.ts / plan-text.ts). The caller passes `existsSync`; tests pass a fake to
 * cover the `-2` / `-3` branches.
 *
 * ## Why the slug is "plain English kebab-case"
 *
 * The filename must be short and scannable. A long Chinese sentence stuffed into a filename
 * becomes a hundred-plus-column path (hit for real:
 * `2026-09-24-<a long Chinese plan title>…md`) — neither truncatable nor readable in a
 * terminal. A meaningful short English name can only come from the model (pure logic does no
 * translating/transliterating), so `exit_plan_mode` requires a `slug` parameter and this
 * module only **cleans** it into a safe shape: lowercase, and every character outside
 * `[a-z0-9]` (incl. CJK, punctuation, spaces, path separators, control chars) folds to `-`.
 *
 * That rule doubles as the security boundary: `/` `\` fold away, so a slug cannot write
 * outside `.pi/plans/`; leading `.` is stripped, so `..` cannot escape and `.foo.md` does not
 * become a hidden file. An empty result falls back to `plan` — never a broken name like
 * `.pi/plans/2026-09-24-.md`.
 */

import { join } from "node:path";

/** The plan-document directory (relative to cwd). */
export const PLAN_DOC_DIR = ".pi/plans";

/** Max slug length (in code points). */
export const MAX_SLUG_LENGTH = 60;

/** Cap on the collision suffix; past it, fall back to a timestamp — a usable path is guaranteed. */
const MAX_COLLISION_SUFFIX = 99;

/** The fallback slug when cleaning leaves nothing. */
const FALLBACK_SLUG = "plan";

/**
 * Characters kept in a slug: lowercase letters and digits. Everything else (CJK, punctuation,
 * whitespace, path separators, control chars) folds to `-`.
 */
const KEEP_CHARS = /[^a-z0-9]+/g;

export interface PlanDocPathOptions {
	/** The working directory (`ctx.cwd`). */
	cwd: string;
	/** `exit_plan_mode`'s `slug` (the short English name); absent or cleaned-to-empty uses the fallback slug. */
	slug?: string;
	/** The current time, default `new Date()`; tests inject a fixed value. */
	now?: Date;
	/**
 * Whether a candidate path is already taken. The caller passes `existsSync`; omitting it skips
 * collision handling (tests covering the `-2` branch must pass it explicitly).
 */
	exists?: (path: string) => boolean;
}

/** The plan document's absolute path. */
export function buildPlanDocPath(options: PlanDocPathOptions): string {
	const now = options.now ?? new Date();
	const dir = join(options.cwd, ...PLAN_DOC_DIR.split("/"));
	const slug = planDocSlug(options.slug);
	const base = `${localDateString(now)}-${slug}`;

	if (!options.exists) return join(dir, `${base}.md`);

	const first = join(dir, `${base}.md`);
	if (!options.exists(first)) return first;
	for (let suffix = 2; suffix <= MAX_COLLISION_SUFFIX; suffix += 1) {
		const candidate = join(dir, `${base}-${suffix}.md`);
		if (!options.exists(candidate)) return candidate;
	}

	// 99 same-named plans: extreme case — fall back to hour-min-sec, still never overwriting an existing file
	const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return join(dir, `${base}-${stamp}.md`);
}

/**
 * Build the filename slug from the model's `slug` (plain English kebab-case).
 *
 * Steps: strip markdown inline wrappers → lowercase → fold non-`[a-z0-9]` chars to `-` →
 * collapse consecutive `-` → strip leading/trailing `-` and `.` → truncate by code points →
 * fall back when empty.
 * CJK folds away in whole runs: `"fix the m5 entity runtime"` → `m5-entity-runtime`,
 * an all-Chinese slug falls back to `plan`.
 */
export function planDocSlug(slug: string | undefined): string {
	if (typeof slug !== "string") return FALLBACK_SLUG;

	const cleaned = slug
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.toLowerCase()
		.replace(KEEP_CHARS, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+/, "")
		.replace(/[-.]+$/, "");

	if (cleaned === "") return FALLBACK_SLUG;
	return truncateByCodePoints(cleaned, MAX_SLUG_LENGTH).replace(/[-.]+$/, "") || FALLBACK_SLUG;
}

/** Local calendar date `YYYY-MM-DD` (not UTC — a cross-timezone session's date may differ by a day). */
export function localDateString(now: Date): string {
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function pad(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

/** Truncate by code points (`slice` splits a surrogate pair into half a char — emoji would break). */
function truncateByCodePoints(text: string, max: number): string {
	const points = [...text];
	return points.length <= max ? text : points.slice(0, max).join("");
}
