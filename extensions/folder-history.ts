/**
 * Folder-based Command History (local rework of npm:pi-command-history@0.2.0)
 *
 * Persists command history per working directory, reused across sessions.
 * History file: ~/.pi/folder-history/<path-with-dashes>.jsonl
 *
 * The biggest difference from upstream: **no keybindings are registered at
 * all**.
 * Upstream used ctrl+up / ctrl+down, which macOS's Mission Control steals (the
 * terminal never sees them), and which collided with pi's built-in
 * tui.altScreen.previousPrompt / nextPrompt (a conflict warning at startup).
 *
 * Now the cross-session history is injected into the editor's own history
 * list — **the native ↑ / ↓ browse across sessions**:
 *   - in pi-tui's Editor.history, history[0] = newest, larger index = older;
 *     ↑ at the first visual line goes older, ↓ goes newer;
 *   - pi only seeds "this session's" user messages into history at startup
 *     (renderInitialMessages → populateHistory), so native ↑/↓ used to reach
 *     only the current session;
 *   - we **append older sessions' records to the history array's tail** (tail
 *     = older), giving [current newest…oldest, previous newest…oldest, even
 *     earlier…] — ↑ walks older, ↓ walks newer.
 *
 * Why "inject into history" rather than registering up/down keys: an
 * extension's shortcut is checked first in CustomEditor.handleInput
 * (onExtensionShortcut first), and registering "up" would eat the multiline
 * input's cursor-up plus every picker's ↑/↓ navigation (model select,
 * /resume's list…). History injection keeps the native semantics intact:
 * inside a multiline prompt ↑/↓ still moves the cursor — history browsing
 * only kicks in at the first visual line (or while already browsing).
 *
 * The implementation point: ctx.ui.getEditorComponent() returns a **factory
 * function** (EditorFactory), not the editor instance — so the history array
 * is unreachable; the factory must be wrapped to inject at instantiation.
 * Extensions load in filename order (folder-history.ts sorts before
 * prompt-editor.ts), and prompt-editor's session_start setEditorComponent
 * would overwrite our factory — so wrap once synchronously plus once more in
 * setTimeout(0) (after every session_start handler has run), with a symbol
 * marker preventing nested re-wrapping.
 *
 * Tunable env var:
 *   PI_FOLDER_HISTORY_INJECT  max entries injected into the editor history,
 *                             default 100 (= pi-tui's built-in history cap)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HISTORY_DIR = join(homedir(), ".pi", "folder-history");
const MAX_HISTORY = 500; // how many entries the history file keeps
// the injection cap defaults to 100: pi-tui's Editor.addToHistory pops the oldest once history exceeds 100,
// so injecting more would only be trimmed entry by entry on later submits — matching the built-in cap.
const MAX_INJECT = Number(process.env.PI_FOLDER_HISTORY_INJECT || 100);
const WRAPPED = Symbol.for("pi.folder-history.wrapped");

function getHistoryFile(cwd: string): string {
	const name = cwd.replace(/\//g, "-");
	return join(HISTORY_DIR, `${name}.jsonl`);
}

/** The oldest-first deduplicated history (in file write order). */
function loadHistory(cwd: string): string[] {
	const file = getHistoryFile(cwd);
	if (!existsSync(file)) return [];

	try {
		const lines = readFileSync(file, "utf-8")
			.split("\n")
			.filter((l) => l.trim());

		const entries: string[] = [];
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.text && entry.cwd === cwd) {
					entries.push(entry.text);
				}
			} catch {
				// skip malformed lines
			}
		}

		// Deduplicate keeping last occurrence, then trim to max
		const seen = new Map<string, number>();
		entries.forEach((text, i) => seen.set(text, i));
		const unique = [...seen.entries()]
			.sort((a, b) => a[1] - b[1])
			.map(([text]) => text);

		return unique.slice(-MAX_HISTORY);
	} catch {
		return [];
	}
}

function appendHistory(cwd: string, text: string): void {
	mkdirSync(HISTORY_DIR, { recursive: true });
	const file = getHistoryFile(cwd);
	const entry = JSON.stringify({ cwd, text, ts: Date.now() });
	appendFileSync(file, entry + "\n", "utf-8");
}

/** The user inputs already in the current session (avoids injecting the same entry twice on resume). */
function collectSessionTexts(sessionManager: unknown): Set<string> {
	const texts = new Set<string>();
	try {
		const entries = (sessionManager as { getEntries?: () => unknown[] })?.getEntries?.() ?? [];
		for (const entry of entries as Array<Record<string, any>>) {
			if (entry?.type !== "message") continue;
			const message = entry.message;
			if (message?.role !== "user") continue;
			const content = message.content;
			if (typeof content === "string") {
				const trimmed = content.trim();
				if (trimmed) texts.add(trimmed);
			} else if (Array.isArray(content)) {
				const text = content
					.filter((block: any) => block?.type === "text" && typeof block.text === "string")
					.map((block: any) => block.text)
					.join("\n")
					.trim();
				if (text) texts.add(text);
			}
		}
	} catch {
		// sessionManager shape changed — just skip dedupe
	}
	return texts;
}

/**
 * Inject into the editor's history: history[0] = newest, larger index = older —
 * so old records append to the **tail**, in newest-first order.
 */
function injectIntoEditor(
	editor: unknown,
	entriesOldestFirst: string[],
	exclude: Set<string>,
): number {
	if (!editor || typeof editor !== "object") return 0;

	const existing = (editor as { history?: unknown }).history;
	const injectOldestFirst = entriesOldestFirst.filter(
		(text) => !exclude.has(text) && !(Array.isArray(existing) && existing.includes(text)),
	).slice(-MAX_INJECT);
	if (injectOldestFirst.length === 0) return 0;

	if (!Array.isArray(existing)) {
		// fallback: without a history array, add entries via the public API (oldest-first → the newest lands at history[0])
		const addToHistory = (editor as { addToHistory?: (t: string) => void }).addToHistory;
		if (typeof addToHistory !== "function") return 0;
		for (const text of injectOldestFirst) addToHistory.call(editor, text);
		return injectOldestFirst.length;
	}

	existing.push(...injectOldestFirst.slice().reverse());
	return injectOldestFirst.length;
}

export default function (pi: ExtensionAPI) {
	let currentCwd = "";
	let sessionTexts = new Set<string>();

	/** Wrap the editor factory once, injecting cross-session history at instantiation. */
	function installEditorWrapper(ctx: any): boolean {
		if (!ctx?.hasUI) return false;

		const previous = ctx.ui.getEditorComponent();
		if (previous && (previous as any)[WRAPPED]) return false; // already our wrapper — do not nest

		ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
			const editor = previous
				? previous(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings);
			injectIntoEditor(editor, loadHistory(currentCwd), sessionTexts);
			return editor;
		});

		const installed = ctx.ui.getEditorComponent();
		if (installed) (installed as any)[WRAPPED] = true;
		return true;
	}

	pi.on("session_start", (_event, ctx) => {
		currentCwd = ctx.cwd;
		sessionTexts = collectSessionTexts((ctx as any).sessionManager);

		// wrap once synchronously; if another extension (e.g. prompt-editor) overwrites the factory afterwards,
		// the macrotask below wraps once more after every session_start handler has run.
		installEditorWrapper(ctx);
		setTimeout(() => {
			try {
				installEditorWrapper(ctx);
			} catch {
				// the ctx may already be dead from a reload / session swap
			}
		}, 0);
	});

	// persistence only: pi itself addToHistory's on submit — do not add twice
	pi.on("input", (event, _ctx) => {
		const text = event.text?.trim();
		if (!text || !currentCwd) return;

		appendHistory(currentCwd, text);
		return { action: "continue" as const };
	});
}
