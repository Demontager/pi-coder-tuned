import assert from "node:assert/strict";
import { test } from "node:test";
import {
	HEADER_GUARD_KEY,
	findRenderContainer,
	freezeHeaderContainer,
	releaseHeaderGuard,
	type RenderableContainer,
} from "./header-guard.ts";

/**
 * A fake pi-tui `Container`: `clear()` **replaces** the whole children array
 * (`this.children = []`), so the guard must re-read the field every time rather than
 * cache it.
 */
class FakeContainer implements RenderableContainer {
	children: unknown[] = [];
	/** How many times the original render ran (for asserting "the built-in header drew zero frames"). */
	originalRenders = 0;

	addChild(component: unknown): void {
		this.children.push(component);
	}

	clear(): void {
		this.children = [];
	}

	render(width: number): string[] {
		this.originalRenders += 1;
		return this.children.flatMap((child) => (child as Leaf).render(width));
	}
}

/** A fake leaf component: its rows carry its name and the width, so it is clear who rendered and at what width. */
interface Leaf {
	render(width: number): string[];
}

function leaf(name: string, lines = 1): Leaf {
	return { render: (width: number) => Array.from({ length: lines }, () => `${name}#${width}`) };
}

/** A fake `tui`: only children, no render (findRenderContainer only looks at children). */
function tuiRoot(...children: unknown[]): { children: unknown[] } {
	return { children };
}

test("findRenderContainer identifies the container directly holding it by object identity", () => {
	const ours = leaf("startup-logo");
	const inner = new FakeContainer();
	inner.addChild(ours);
	const outer = new FakeContainer();
	outer.addChild(inner);
	const root = tuiRoot(new FakeContainer(), outer);

	assert.equal(findRenderContainer(root, ours), inner);
});

test("findRenderContainer returns undefined when not found — never guesses", () => {
	const inner = new FakeContainer();
	inner.addChild(leaf("other"));
	const root = tuiRoot(inner);

	assert.equal(findRenderContainer(root, leaf("missing")), undefined);
	assert.equal(findRenderContainer(root, undefined), undefined);
	assert.equal(findRenderContainer(undefined, leaf("x")), undefined);
	assert.equal(findRenderContainer({ notAContainer: true }, leaf("x")), undefined);
});

test("findRenderContainer tolerates cyclic references and read-only children", () => {
	const a = new FakeContainer();
	const b = new FakeContainer();
	a.addChild(b);
	b.addChild(a);

	assert.equal(findRenderContainer(a, leaf("nope")), undefined);

	const frozenRoot = tuiRoot({ children: Object.freeze([leaf("x")]) as unknown[] });
	assert.equal(findRenderContainer(frozenRoot, leaf("y")), undefined);
});

test("passes through while our component is mounted; replays the frozen rows once swapped to the built-in header", () => {
	const ours = leaf("startup-logo");
	const builtIn = leaf("pi-default-header");
	const container = new FakeContainer();
	container.addChild(ours);

	const release = freezeHeaderContainer({
		container,
		ownComponent: ours,
		frozenRender: (width) => [`frozen#${width}`],
	});
	assert.equal(typeof release, "function");

	// a normal session: real rendering passes through.
	assert.deepEqual(container.render(80), ["startup-logo#80"]);
	assert.equal(container.originalRenders, 1);

	// the session-swap window: pi has already clear()ed and mounted the built-in header.
	container.clear();
	container.addChild(builtIn);
	assert.deepEqual(container.render(80), ["frozen#80"]);
	assert.deepEqual(container.render(40), ["frozen#40"]);
	// the built-in header rendered zero times → it never reaches the screen.
	assert.equal(container.originalRenders, 1);
});

test("the replayed rows re-truncate at the current width", () => {
	const ours = leaf("startup-logo");
	const container = new FakeContainer();
	container.addChild(ours);
	const wide = " ".repeat(30);
	freezeHeaderContainer({
		container,
		ownComponent: ours,
		frozenRender: (width) => [wide.slice(0, width)],
	});

	container.clear();
	container.addChild(leaf("pi-default-header"));
	assert.deepEqual(container.render(10), [wide.slice(0, 10)]);
});

test("releasing restores the original render — no own render property or takeover record left", () => {
	const ours = leaf("startup-logo");
	const builtIn = leaf("pi-default-header");
	const container = new FakeContainer();
	container.addChild(ours);

	const release = freezeHeaderContainer({
		container,
		ownComponent: ours,
		frozenRender: () => ["frozen"],
	})!;
	container.clear();
	container.addChild(builtIn);
	assert.deepEqual(container.render(10), ["frozen"]);

	release();
	assert.equal(Object.prototype.hasOwnProperty.call(container, "render"), false);
	assert.equal((container as { [HEADER_GUARD_KEY]?: unknown })[HEADER_GUARD_KEY], undefined);
	assert.deepEqual(container.render(10), ["pi-default-header#10"]);

	// idempotent: a repeat release changes nothing.
	release();
	assert.equal(Object.prototype.hasOwnProperty.call(container, "render"), false);
});

test("releaseHeaderGuard reports success only when a takeover actually existed", () => {
	const container = new FakeContainer();
	assert.equal(releaseHeaderGuard(container), false);
	assert.equal(releaseHeaderGuard(undefined), false);
	const release = freezeHeaderContainer({ container, ownComponent: {}, frozenRender: () => ["frozen"] });
	assert.equal(releaseHeaderGuard(container), true);
	// already released → a second release reports false.
	release?.();
	assert.equal(releaseHeaderGuard(container), false);
});

test("a repeat takeover of one container first releases the previous — no stacked wrappers", () => {
	const first = leaf("first");
	const second = leaf("second");
	const container = new FakeContainer();
	container.addChild(first);
	container.addChild(second);

	freezeHeaderContainer({ container, ownComponent: first, frozenRender: () => ["frozen-first"] });
	freezeHeaderContainer({ container, ownComponent: second, frozenRender: () => ["frozen-second"] });

	// first mounted, second not: if two wrapper layers were still stacked this would emit frozen-first;
	// only the last takeover remains → second judged absent → frozen-second comes out.
	container.clear();
	container.addChild(first);
	assert.deepEqual(container.render(7), ["frozen-second"]);

	// second back in place → pass through.
	container.addChild(second);
	assert.deepEqual(container.render(7), ["first#7", "second#7"]);
});

test("self-heals past the timeout: releases the original render whether mounted or not", () => {
	const ours = leaf("startup-logo");
	const builtIn = leaf("pi-default-header");
	const container = new FakeContainer();
	container.addChild(ours);
	let clock = 1000;
	const release = freezeHeaderContainer({
		container,
		ownComponent: ours,
		frozenRender: () => ["frozen"],
		maxAgeMs: 500,
		now: () => clock,
	})!;

	// the component is still in its new spot (a completed handover's look) + past the timeout → pass through and release.
	clock = 1600;
	assert.deepEqual(container.render(9), ["startup-logo#9"]);
	assert.equal(Object.prototype.hasOwnProperty.call(container, "render"), false);

	// the other side: the new header never arrived (a failed swap) → after the timeout, back to pi's default behavior.
	const ours2 = leaf("startup-logo2");
	const container2 = new FakeContainer();
	container2.addChild(ours2);
	let clock2 = 0;
	freezeHeaderContainer({
		container: container2,
		ownComponent: ours2,
		frozenRender: () => ["frozen"],
		maxAgeMs: 500,
		now: () => clock2,
	});
	container2.clear();
	container2.addChild(builtIn);
	clock2 = 501;
	assert.deepEqual(container2.render(9), ["pi-default-header#9"]);
	release();
});

test("before the timeout, every frame emits only the replayed rows", () => {
	const ours = leaf("startup-logo");
	const container = new FakeContainer();
	container.addChild(ours);
	freezeHeaderContainer({
		container,
		ownComponent: ours,
		frozenRender: (width) => [`frozen#${width}`, `frozen#${width}`],
	});
	container.clear();
	container.addChild(leaf("pi-default-header"));

	for (let frame = 0; frame < 5; frame += 1) {
		assert.deepEqual(container.render(80), ["frozen#80", "frozen#80"]);
	}
});

test("a wrong container shape → nothing happens (non-tui mode / pi changed internals)", () => {
	const noop = () => ["frozen"];
	assert.equal(freezeHeaderContainer({ container: undefined, ownComponent: {}, frozenRender: noop }), undefined);
	assert.equal(freezeHeaderContainer({ container: {}, ownComponent: {}, frozenRender: noop }), undefined);
	assert.equal(
		freezeHeaderContainer({ container: { children: [] }, ownComponent: {}, frozenRender: noop }),
		undefined,
	);
	assert.equal(
		freezeHeaderContainer({
			container: { children: "not-an-array", render: noop } as unknown as RenderableContainer,
			ownComponent: {},
			frozenRender: noop,
		}),
		undefined,
	);
	// ownComponent undefined (the header not installed yet) → no takeover either.
	assert.equal(
		freezeHeaderContainer({ container: new FakeContainer(), ownComponent: undefined, frozenRender: noop }),
		undefined,
	);
});

test("a throwing frozenRender falls back to the original render — the exception never reaches the host", () => {
	const ours = leaf("startup-logo");
	const container = new FakeContainer();
	container.addChild(ours);
	freezeHeaderContainer({
		container,
		ownComponent: ours,
		frozenRender: () => {
			throw new Error("boom");
		},
	});

	container.clear();
	container.addChild(leaf("pi-default-header"));
	assert.deepEqual(container.render(12), ["pi-default-header#12"]);
});
