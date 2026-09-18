/**
 * Tests for subagents.ts — the "is a subagent still running?" probe.
 *
 * Run with:  node --test clients/pi/extensions/recap/subagents.test.ts
 *
 * The module never imports pi (the event bus is injected as a minimal interface), so a
 * fake bus that answers `subagents:rpc:v1:request` from a table is enough to cover the
 * probe: the well-formed-reply path, the unknown-shape paths, and every fail-open exit
 * (no responder, wrong request id, throwing emit).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	hasActiveSubagentWork,
	isSubagentWorkActive,
	nextSubagentRequestId,
	SUBAGENT_RPC_REPLY_PREFIX,
	SUBAGENT_RPC_REQUEST,
	SUBAGENT_RPC_VERSION,
	type SubagentEventBus,
} from "./subagents.ts";

/** A fleet-status reply as pi-subagents' RPC `status` method returns it. */
function fleetReply(totalActive: number, extra: Record<string, unknown> = {}): unknown {
	return {
		version: 1,
		requestId: "x",
		method: "status",
		success: true,
		data: { text: "…", fleet: { version: 1, entries: [], totalActive, omitted: 0 }, ...extra },
	};
}

interface FakeBus {
	bus: SubagentEventBus;
	requests: Array<Record<string, unknown>>;
	handlerCount(channel: string): number;
}

/**
 * Fake bus. The responder is called synchronously on emit of the request channel and
 * its return value (if any) is delivered on `subagents:rpc:v1:reply:<requestId>`.
 */
function fakeBus(responder?: (request: Record<string, unknown>) => unknown): FakeBus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const requests: Array<Record<string, unknown>> = [];
	const bus: SubagentEventBus = {
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set<(data: unknown) => void>();
			handlers.set(channel, set);
			set.add(handler);
			return () => {
				set.delete(handler);
			};
		},
		emit(channel, data) {
			if (channel !== SUBAGENT_RPC_REQUEST) return;
			const request = data as Record<string, unknown>;
			requests.push(request);
			const replyChannel = `${SUBAGENT_RPC_REPLY_PREFIX}${String(request.requestId)}`;
			const reply = responder?.(request);
			if (reply !== undefined) for (const handler of handlers.get(replyChannel) ?? []) handler(reply);
		},
	};
	return { bus, requests, handlerCount: (channel) => handlers.get(channel)?.size ?? 0 };
}

describe("isSubagentWorkActive", () => {
	it("rejects non-records and failed replies", () => {
		assert.equal(isSubagentWorkActive(undefined), false);
		assert.equal(isSubagentWorkActive("running"), false);
		assert.equal(isSubagentWorkActive([]), false);
		assert.equal(isSubagentWorkActive({ success: false, error: { code: "no_active_session" } }), false);
	});

	it("reads the fleet status DTO's totalActive", () => {
		assert.equal(isSubagentWorkActive(fleetReply(0)), false);
		assert.equal(isSubagentWorkActive(fleetReply(2)), true);
		assert.equal(isSubagentWorkActive(fleetReply(1, { fleet: { version: 1, totalActive: "1" } })), false);
	});

	it("falls back to the async snapshot when the fleet DTO is absent", () => {
		const snapshot = (state: string) => ({
			success: true,
			data: { asyncSnapshot: { runs: [{ id: "run-1", state }] } },
		});
		assert.equal(isSubagentWorkActive(snapshot("running")), true);
		assert.equal(isSubagentWorkActive(snapshot("queued")), true);
		assert.equal(isSubagentWorkActive(snapshot("paused")), false);
		assert.equal(isSubagentWorkActive({ success: true, data: {} }), false);
		assert.equal(isSubagentWorkActive({ success: true, data: { asyncSnapshot: {} } }), false);
	});
});

describe("hasActiveSubagentWork", () => {
	it("sends a well-formed status request and reads the reply", async () => {
		const { bus, requests, handlerCount } = fakeBus(() => fleetReply(2));

		assert.equal(await hasActiveSubagentWork(bus), true);
		assert.equal(requests.length, 1);
		const request = requests[0];
		assert.equal(request.version, SUBAGENT_RPC_VERSION);
		assert.equal(request.method, "status");
		assert.deepEqual(request.params, {});
		assert.equal(typeof request.requestId, "string");
		assert.notEqual(String(request.requestId).length, 0);
		// The reply subscription is unique per request and removed once the promise settles.
		assert.equal(handlerCount(`${SUBAGENT_RPC_REPLY_PREFIX}${String(request.requestId)}`), 0);
	});

	it("is false for an idle fleet", async () => {
		const { bus } = fakeBus(() => fleetReply(0));
		assert.equal(await hasActiveSubagentWork(bus), false);
	});

	it("fails open when nothing answers (timeout)", async () => {
		const { bus, handlerCount } = fakeBus();
		const requestId = nextSubagentRequestId();
		assert.equal(await hasActiveSubagentWork(bus, { timeoutMs: 10, requestId }), false);
		assert.equal(handlerCount(`${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`), 0);
	});

	it("ignores replies for other requests", async () => {
		const { bus } = fakeBus((request) => ({ version: 1, requestId: `${String(request.requestId)}-other`, success: true, data: {} }));
		assert.equal(await hasActiveSubagentWork(bus, { timeoutMs: 10 }), false);
	});

	it("fails open when emit throws", async () => {
		const bus: SubagentEventBus = {
			on: () => () => {},
			emit: () => {
				throw new Error("no bus");
			},
		};
		assert.equal(await hasActiveSubagentWork(bus), false);
	});

	it("generates unique request ids", () => {
		const ids = new Set([nextSubagentRequestId(), nextSubagentRequestId(), nextSubagentRequestId()]);
		assert.equal(ids.size, 3);
	});
});
