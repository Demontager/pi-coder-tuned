/**
 * explored-group / registry — shared state for "the read-only group currently being collected" + group-break rules.
 *
 * ## One uninterrupted read-only sequence = one group (never split by category, nor by message)
 *
 * In the user's target shape (2026-10-06), `Search` lines and `Read` lines live in the same tree,
 * so "consecutive read-only" is the sufficient condition for grouping — category and tool name only
 * affect the **line format** (consecutive reads merge into one line, split by source within the
 * line, see `render.ts`), not the group boundary.
 *
 * Second round, 2026-10-06 (after the user's live testing): **merge across messages too**. The old
 * implementation treated "different family" and "a new assistant message" as break conditions,
 * which left the screen full of single-line `Explored` blocks. Only the user's four conditions
 * remain: narration, Thinking, non-foldable tools, user messages.
 *
 * ## Why a `globalThis` singleton
 *
 * Three extension files read the same state: `bash-command-collapse.ts` (bash blocks),
 * `read-path-collapse.ts` (read blocks), and this directory's `index.ts` (native grep/find/ls
 * blocks + event wiring). pi's loader does **not** guarantee them the same module instance (each
 * extension imports on its own), so the state hangs off `globalThis` — the same trick as
 * `sandbox-mode.ts` / `allowlist.ts`; it survives `/reload` as the same object.
 *
 * ## Timing: why "render-driven registration + event-driven group breaking"
 *
 * Measured (`ToolExecutionComponent.updateArgs` → `updateDisplay` → `renderCall`): **`renderCall`
 * is invoked during streaming, before `tool_call` / `tool_execution_start`**. So:
 *
 *   - **Registration** lives in `renderCall` (`ensureRegistered`): the block settles its group at
 *     first render — leader draws the tree, members render 0 lines — never "one ordinary frame,
 *     then jump to group".
 *   - **Group breaking** lives in events (`replayMessage` / `noteToolCall`): thinking, narration,
 *     user messages, and non-foldable tools must break, and only events can see them.
 *
 * Both paths call `register()`, which is **idempotent** (an id already in `byId` returns the same
 * group), so whichever runs first gives the same result; registration order == content order (both
 * paths walk the content array in order), so line order is stable.
 *
 * ## Break rules (user's decision, 2026-10-06)
 *
 * One group = **the longest consecutive read-only sequence without interruption** (may span
 * assistant messages). Any of the following seals the group:
 *
 *   - a `thinking` block
 *   - the assistant's **non-empty** `text` (narration)
 *   - a `user` message
 *   - any **non-foldable** tool call (write / execute / other tools)
 *
 * **Anything not on the list never breaks** — different category, different tool name, or a new
 * assistant message do not break.
 *
 * ## Idempotent replay: keyed by **content fingerprint**, not message object
 *
 * `message_update` fires **repeatedly** as streaming progresses, and the content array **appends**.
 * If every update replayed from the start, a message of `[thinking, toolCallA, toolCallB]` would
 * break on the thinking again at the third update, splitting A and B into two groups — wrong.
 * **pi sends `{...partialMessage}` on every update (a fresh object)**, so the message object
 * cannot be the key (tried; it never matched — that's the "adjacent Explored blocks" the user
 * saw). The cursor now advances by **content fingerprint** (`content.length` + the last block's
 * id); see `replayMessage`.
 *
 * ## Why the armed gate
 *
 * Grouping works by "rendering layer looks up the table by toolCallId → hit renders 0 lines",
 * and that table is a `globalThis` singleton that **outlives sessions**. Without a guard, any code
 * that repeatedly renders components with a fixed id (other extensions' rendering tests do exactly
 * this) would, on hitting a previously registered id, silently turn that block into 0 lines. Real
 * sessions never collide because ids are unique there — but that is luck, not design. Hence the
 * gate: "enable only after seeing session events" (`arm` / `isArmed`).
 */

import { classifyToolCall, isPendingArgs, type FoldKind } from "./classify.ts";

/** One line of a group (one member). */
export interface GroupMember {
	/** toolCallId. */
	id: string;
	/** Fold category (`read` / `search` / `list` / `git`) — affects only the **line format** (see `render.ts`), not the group boundary. */
	kind: FoldKind;
	/** Tool name. Distinguishes `read` from bash-derived Reads: decides whether the line is bold (see `render.ts`). */
	toolName: string;
	args: unknown;
	/** This member's current status (used to draw the status dot). */
	status: "running" | "ok" | "error";
	/**
	 * Whether the arguments have finished streaming (it can enter the tree). Members that are
	 * **not ready draw no line at all**.
	 *
	 * User's decision, 2026-10-07: "once the bash command finishes streaming (enters execution),
	 * output directly as the collapsed Search". Without the guard, the in-line text would grow
	 * token by token with the model (`└ bash` → `Search "auth"` → `Search "authorization" in
	 * proxy/`) — still "streaming text first", just inside the tree. See `markMessageReady` for
	 * when this gets set.
	 */
	ready: boolean;
}

export interface Group {
	/** The leader block's toolCallId. */
	leaderId: string;
	members: GroupMember[];
}

interface RegistryState {
	/** The currently open group; `null` = the next read-only block starts a new group. */
	open: Group | null;
	/** id → owning group, O(1) lookup for the rendering layer. */
	byId: Map<string, Group>;
	/** leader id → function that re-renders it (registered at `renderCall`, invoked after adding members). */
	leaderInvalidate: Map<string, () => void>;
	/**
	 * toolCallIds whose arguments have "finished streaming" (see `markMemberReady`).
	 *
	 * Why this set is needed instead of just the member's `ready`: the ready signal arrives on the
	 * **event side** (`message_end`), while registration can come earlier (live stream:
	 * `message_update` first) or later (`/resume`: `hydrateFromHistory` runs before components
	 * are built). Late-registering members pick up the ready bit from this set inside `register()`.
	 */
	readyIds: Set<string>;

	/**
	 * The assistant message currently being tracked: see the comment in `replayMessage`.
	 *
	 * - `contentKey`: the **content fingerprint** of the processed prefix (length + last block's id)
	 * - `done`: how many blocks have been processed
	 * - `lastKey`: the identity of **block number `done`**, used to tell "an append to the same
	 *   message" from "a new message"
	 *
	 * The message object cannot be the key — pi sends a fresh object every time
	 * (`{...partialMessage}`).
	 */
	cursor: { contentKey: string; done: number; lastKey: string } | null;
	/**
	 * Whether this extension has taken over (has seen session events).
	 *
	 * **Before takeover, no grouping whatsoever** — see "Why the armed gate" in the file header —
	 * otherwise any code that directly constructs a `ToolExecutionComponent` (e.g. other
	 * extensions' rendering tests) would, on a toolCallId colliding with a previously registered
	 * one, silently render 0 lines.
	 */
	armed: boolean;
}

const STATE_KEY = "pi-explored-group-state";

function getState(): RegistryState {
	const host = globalThis as unknown as Record<string, RegistryState | undefined>;
	let state = host[STATE_KEY];
	if (!state) {
		state = { open: null, byId: new Map(), leaderInvalidate: new Map(), armed: false, cursor: null, readyIds: new Set() };
		host[STATE_KEY] = state;
	}
	return state;
}

/**
 * Mark this extension as taken over (called when the first session event arrives).
 *
 * Why this gate is needed: grouping is implemented as "rendering layer looks up by id", and
 * `byId` is **process-level** (a `globalThis` singleton that survives `/reload` and sessions).
 * Without the guard, any code that repeatedly renders a component with one fixed toolCallId
 * (other extensions' rendering tests do exactly this) would hit a previously registered id and
 * silently turn that block into 0 lines — real sessions never collide because ids are unique,
 * but that is luck, not design.
 *
 * The gate is "has seen a session event": a real run always receives `session_start` or
 * `message_*`, while merely loading the extension or hand-constructing components does not.
 */
export function arm(): void {
	getState().armed = true;
}

/** Whether this extension has taken over (the rendering layer decides grouping on this). */
export function isArmed(): boolean {
	return getState().armed;
}

/** Shallow-compare args (streaming hands `updateArgs` a fresh object every time, but the contents often match). */
function sameArgs(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	const ka = Object.keys(a as object);
	const kb = Object.keys(b as object);
	if (ka.length !== kb.length) return false;
	for (const k of ka) {
		if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
	}
	return true;
}

/** For tests: full reset (including the armed flag). */
export function resetForTesting(): void {
	const host = globalThis as unknown as Record<string, unknown>;
	delete host[STATE_KEY];
}

/**
 * Seal: the current group ends here; the next read-only block opens a new one.
 *
 * Issued from events like `tool_call` — after adding a member the leader must be woken to
 * re-render, but **sealing itself needs no re-render** (lines already drawn are unaffected).
 */
export function beginBreak(): void {
	const state = getState();
	state.open = null;
}

/**
 * Register a foldable member (**idempotent**).
 *
 * - Already registered → **refresh args**, then return its existing group (see below)
 * - No group currently open → open a new one (this block is the leader)
 * - Otherwise → join the current group
 *
 * **Why refresh args for an already-registered member**: `renderCall` runs while tool arguments
 * are **still streaming**, so the first registration often sees **empty args**. If we settled on
 * that, the real `path` / `command` would never arrive — the phrase cannot be computed
 * (`phraseForToolCall` returns null) and it falls back to the tool name, producing the likes of
 * `└ Read read` on screen. That was the visual bug seen in practice (user report, 2026-10-06).
 *
 * The refresh writes only when **actually different**; otherwise every `renderCall` would replace
 * the object and invalidate downstream caches for nothing.
 */
export function register(id: string, toolName: string, args: unknown): Group | null {
	const state = getState();
	const existing = state.byId.get(id);
	if (existing) {
		const member = existing.members.find((m) => m.id === id);
		if (member && args !== undefined && !sameArgs(member.args, args)) member.args = args;
		return existing;
	}

	const verdict = classifyToolCall(toolName, args);
	if (verdict.pending || !verdict.kind) return null;

	// Category and tool name both do **not** split groups: native `read` and bash-derived Reads
	// now share a group; the "bold = native tool" semantics is preserved by splitting each line
	// by source (see `buildEntries` in `render.ts`).
	if (!state.open) {
		state.open = { leaderId: id, members: [] };
	}
	state.open.members.push({
		id,
		kind: verdict.kind,
		toolName,
		args,
		status: "running",
		// Late registrations pick up the ready bit from the set (registration and ready signal
		// can arrive in either order, see `readyIds`).
		ready: state.readyIds.has(id),
	});
	state.byId.set(id, state.open);
	return state.open;
}

/**
 * Rendering-layer entry: make sure this block is registered, and report which group it is in.
 *
 * Called first thing from the three renderers' `renderCall` — the return value decides
 * "draw the tree / render 0 lines / fall through to the original logic". **Returns null unless
 * armed** (fall through to the original rendering); see `arm`.
 *
 * Also returns `null` while arguments are still incomplete (this frame renders as an ordinary
 * block) — `renderCall` comes again next frame with full args and it joins normally. The cost is
 * a possible one-frame flash of the ordinary shape, but that is safer than wrongly splitting a group.
 */
export function ensureRegistered(id: string, toolName: string, args: unknown): Group | null {
	if (!isArmed()) return null;
	const verdict = classifyToolCall(toolName, args);
	if (verdict.pending || !verdict.kind) return null;
	return register(id, toolName, args);
}

/**
 * While arguments are still incomplete, this block should **draw no line at all** (rather than
 * fall back to the built-in rendering).
 *
 * ## Why a separate verdict
 *
 * `ensureRegistered` returning `null` has two very different meanings, and the renderer must
 * handle them separately:
 *
 *   1. **Arguments still streaming** (`pending`) — this is **temporary**; the next frame joins
 *      the group. If we fell back to the built-in renderer now, the screen would first draw a
 *      native block (`grep // in .` / `• Read ...`) and then jump to `• Explored` once args are
 *      complete. The user's 2026-10-06 report, "a stretch of grey text streams out, then
 *      immediately folds into an Explored line", was exactly this (measured four frames: grep /
 *      find / ls / read, all affected).
 *   2. **Genuinely non-foldable** (e.g. reading `SKILL.md`) — here we **should** fall back to the
 *      built-in renderer (its `[skill]` compact shape is the correct look), and this verdict
 *      will not change again.
 *
 * So only case 1 suppresses output. The check uses `isPendingArgs` (are the required arguments
 * in?) and **not** `argsComplete`: the latter is only set in the live stream and never during
 * `/resume` history rebuild (see `classify.ts`). Returns `false` unless armed — if this extension
 * has not taken over, nothing should be hidden.
 *
 * **`isPartial` must also be included**: a block interrupted by Esc never gets complete args,
 * and looking at pending alone would make it permanently invisible (even its error would vanish).
 * See the comment inside the function.
 */
export function shouldHideWhilePending(toolName: string, args: unknown, isPartial: boolean): boolean {
	// **Both conditions must hold**:
	//   - `isPendingArgs`: required arguments have not arrived (once they have, `Explored` is drawn
	//     directly and nothing is hidden anymore)
	//   - `isPartial`: the result has not come back. On message_end (aborted / error), pi calls
	//     `updateResult({...}, false)` for each unfinished block, **setting neither argsComplete
	//     nor filling in args** — with pending alone, an Esc-interrupted block would be permanently
	//     invisible, even hiding its error line. The bash side has used this convention from the
	//     start (`!streaming && !argsComplete && isPartial`, with the comment "seeing what
	//     command was interrupted is more useful than a lone error line"); this matches it.
	return isArmed() && isPartial && isPendingArgs(toolName, args);
}

/** Which group this block belongs to (unregistered → `undefined`). */
export function groupOf(id: string): Group | undefined {
	return getState().byId.get(id);
}

/** Is this block the leader? The leader draws the whole `Explored` tree; the other members render 0 lines. */
export function isLeader(id: string): boolean {
	const group = getState().byId.get(id);
	return group !== undefined && group.leaderId === id;
}

/**
 * The leader registers a "re-render myself" callback.
 *
 * New members must show up on screen immediately — but re-rendering can only be driven by pi's
 * render loop; the extension cannot call `render()` itself. The `context.invalidate()` handed to
 * `renderCall` is exactly that entry point (internally it does `this.invalidate();
 * this.ui.requestRender()`).
 */
export function setLeaderInvalidate(id: string, fn: () => void): void {
	getState().leaderInvalidate.set(id, fn);
}

/** After adding a member, wake the leader to re-render (the callback does not exist if the leader has not rendered yet — that render will naturally carry the latest list). */
export function notifyLeader(group: Group): void {
	getState().leaderInvalidate.get(group.leaderId)?.();
}

/**
 * Mark a member's arguments as finished streaming (it can enter the tree). Wakes the leader
 * **only on the first transition**.
 *
 * The user's factual requirement, 2026-10-07: a command that has not finished streaming must not
 * appear in the tree — otherwise the in-line text grows token by token (`└ bash` →
 * `Search "auth"` → …), visually the same family of problem as the earlier "native frame flash".
 *
 * Who calls it: `index.ts`'s `message_end` handler (via `markMessageReady`). **Deliberately not a
 * `renderCall`-time `argsComplete` check**: that would tie readiness to "how many times this
 * block itself rendered", while the tree is drawn by the **leader** — the two are not necessarily
 * in sync; a member that never rendered itself would never become ready. On `/resume` history
 * rebuild `message_end` is not re-sent, but `hydrateFromHistory` replays through the same path,
 * so the ready bit is set as usual.
 */
export function markMemberReady(id: string): void {
	const state = getState();
	// Record the intent first, then the registered member — order is independent of registration
	// timing (see `readyIds`).
	state.readyIds.add(id);
	const group = state.byId.get(id);
	if (!group) return;
	const member = group.members.find((m) => m.id === id);
	if (!member || member.ready) return;
	member.ready = true;
	notifyLeader(group);
}

/**
 * An assistant message **finished streaming** → all tool calls inside it have complete arguments;
 * let them all into the tree.
 *
 * This is the primary signal: what the user wanted on 2026-10-07 is exactly "output directly as
 * the collapsed Search once the command finishes streaming". pi's ordering is "message finishes
 * streaming → then tools execute", so `message_end` is the moment "the command finished
 * streaming". Using the event side rather than a `renderCall`-time `argsComplete` check: the
 * latter ties readiness to "how many times this block itself rendered", while the tree is drawn
 * by the **leader** — the two are not necessarily in sync.
 */
export function markMessageReady(message: unknown): void {
	const msg = message as { role?: string; content?: unknown } | null | undefined;
	if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return;
	const state = getState();
	state.readyIds = state.readyIds ?? new Set();
	for (const block of msg.content) {
		const b = block as { type?: string; id?: string } | null;
		if (b?.type === "toolCall" && typeof b.id === "string") markMemberReady(b.id);
	}
}

/** Whether this member's arguments have finished streaming (unregistered → treat as ready; callers are unaffected). */
export function isMemberReady(id: string): boolean {
	return getState().byId.get(id)?.members.find((m) => m.id === id)?.ready ?? true;
}

/**
 * Render-time fallback for opening the gate: pi always hands the renderer the **result** or a
 * **terminal state**, at which point the arguments are necessarily final.
 *
 * The primary signal is `message_end` (see `markMessageReady`), but two measured paths never get it:
 *   - Esc interrupt / model error: `message_end` arrives, but arguments may stay truncated forever
 *     with no further events;
 *   - paths with only `tool_execution_end` and no `message_end`.
 * Without opening the gate in both cases, that block would stay **permanently invisible** (even
 * its error would be hidden). The criterion `isPartial !== true` shares its origin with the
 * second condition of the bash-side hiding logic — once the result is back, "still streaming"
 * is off the table.
 */
export function markReadyIfSettled(id: string, argsComplete: boolean, isPartial: boolean): void {
	if (argsComplete || !isPartial) markMemberReady(id);
}

/** Update a member's status (set ok/error at `tool_execution_end`). Re-renders only when it changed. */
export function setMemberStatus(id: string, status: GroupMember["status"]): void {
	const state = getState();
	const group = state.byId.get(id);
	if (!group) return;
	const member = group.members.find((m) => m.id === id);
	if (!member || member.status === status) return;
	member.status = status;
	notifyLeader(group);
}

/**
 * Registration + group-break entry for an incoming toolCall (event side, `tool_call`).
 *
 * Returns `true` = foldable (managed by a group); `false` = non-foldable, and the group has
 * **already** been sealed as a side effect. While arguments are still incomplete it returns
 * `false` **without breaking the group** (see `pending` in `classify`).
 */
export function noteToolCall(id: string, toolName: string, args: unknown): boolean {
	const verdict = classifyToolCall(toolName, args);
	if (verdict.pending) return false;
	if (!verdict.kind) {
		beginBreak();
		return false;
	}
	const group = register(id, toolName, args);
	if (group) notifyLeader(group);
	return true;
}

/**
 * Replay the **not yet processed** blocks of an assistant message in **content order** —
 * the authoritative source for group breaks and registration.
 *
 * Per-block semantics:
 *
 * | Block | Action |
 * |---|---|
 * | `thinking` | `beginBreak()` |
 * | non-empty `text` | `beginBreak()` |
 * | foldable `toolCall` | `register()` + wake the leader |
 * | non-foldable `toolCall` | `beginBreak()` |
 *
 * ## Why deduplication cannot rely on message-object bookkeeping (a pitfall already stepped in)
 *
 * pi sends `{...partialMessage}` on every `message_update` — **a fresh object each time** (that
 * spread in the streaming loop of `dist/bundle`). So a `WeakMap` keyed on the message object
 * never hits: the second update is treated as a brand-new message and replays from `content[0]`.
 * Every assistant message starts with a `thinking` block, so **every token update breaks the
 * group again** — on screen, "every tool block is its own Explored" (the user's second and third
 * problem reported on 2026-10-06 were exactly this).
 *
 * So the dedup key is a **content fingerprint**, not object identity:
 * `content.length + the last block's id`. Subsequent updates of the same message only **append**
 * blocks, so the fingerprint advances monotonically; a new message (different `last id`) starts
 * over. An identical fingerprint means "this prefix was already processed" — return immediately.
 *
 * This design also preserves another property: **registration order == content order** (the
 * `renderCall` path and the event path walk the same order), so line order is stable.
 */
/** Content fingerprint: length + the last block's id (tool blocks) or its type (thinking / text). */
function contentKey(content: unknown[]): string {
	return `${content.length}:${blockKey(content[content.length - 1])}`;
}

/** A single block's identity: tool blocks use their id; the rest use their type. */
function blockKey(block: unknown): string {
	const b = block as { id?: string; type?: string } | undefined;
	return b?.id ?? b?.type ?? "";
}

export function replayMessage(message: unknown): number {
	const msg = message as { role?: string; content?: unknown } | null | undefined;
	if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return 0;
	arm();
	const state = getState();
	const key = contentKey(msg.content);
	// Identical fingerprint = this prefix of this message was already processed
	if (state.cursor && state.cursor.contentKey === key) return 0;
	// Tell "an append to the same message" from "a new message".
	// The fingerprint already differs, so the only way to recognize it is by **the prefix already
	// processed**: compare the block at the previous cursor position; a match means the same
	// message grew; a mismatch (or the message got shorter) means a new message.
	// Comparing only `length >= done` is not enough — a new message longer than the previous one
	// would be mistaken for an append.
	const prev = state.cursor;
	const sameMessage =
		prev !== null &&
		prev.done <= msg.content.length &&
		blockKey(msg.content[prev.done - 1]) === prev.lastKey;
	let index = sameMessage ? prev!.done : 0;
	const from = index;
	// A new assistant message does **not** break the group: per the user's decision of 2026-10-06,
	// consecutive lookups merge across messages ("as long as no narration, non-foldable tool, or
	// Thinking cuts in, Explored blocks all merge together").
	// `sameMessage` still matters — it governs "streaming re-updates must not re-break the group",
	// which is unrelated to group boundaries.
	for (; index < msg.content.length; index++) {
		const block = msg.content[index] as { type?: string; name?: string; id?: string; arguments?: unknown; text?: string } | null;
		if (!block) continue;
		if (block.type === "thinking") {
			beginBreak();
			continue;
		}
		if (block.type === "text") {
			if (typeof block.text === "string" && block.text.trim() !== "") beginBreak();
			continue;
		}
		if (block.type === "toolCall" && typeof block.name === "string" && typeof block.id === "string") {
			const verdict = classifyToolCall(block.name, block.arguments);
			// Arguments still incomplete: **do nothing** — no break, no registration; wait for the
			// next update (args will be complete then). Treating it as "non-foldable" and breaking
			// here would recreate the "consecutive calls did not merge" the user saw.
			if (verdict.pending) continue;
			if (!verdict.kind) {
				beginBreak();
				continue;
			}
			const group = register(block.id, block.name, block.arguments);
			if (group) notifyLeader(group);
		}
	}
	state.cursor = { contentKey: key, done: index, lastKey: blockKey(msg.content[index - 1]) };
	return index - from;
}

/** A `user` message also breaks the group (exploration after a new question should not merge with the previous round's). */
export function noteUserMessage(): void {
	arm();
	beginBreak();
}
