import assert from "node:assert/strict";
import { test } from "node:test";
import {
	FOOTER_GUARD_KEY,
	findRenderContainer,
	freezeFooterContainer,
	releaseFooterGuard,
	type RenderableContainer,
} from "./footer-guard.ts";

/**
 * A fake pi-tui `Container`: `clear()` **replaces** the whole children array
 * (`this.children = []`), so the guard must re-read the field every time rather than
 * cache it.
 */
class FakeContainer implements RenderableContainer {
	children: unknown[] = [];
	/** How many times the original render ran (for asserting "the default footer drew zero frames"). */
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
	const ours = leaf("statusline");
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

test("passes through while our component is mounted; replays the frozen rows once swapped to the built-in footer", () => {
	const ours = leaf("statusline");
	const builtIn = leaf("pi-default");
	const container = new FakeContainer();
	container.addChild(ours);

	const release = freezeFooterContainer({
		container,
		ownComponent: ours,
		frozenRender: (width) => [`frozen#${width}`],
	});
	assert.equal(typeof release, "function");

	// a normal session: real rendering passes through.
	assert.deepEqual(container.render(80), ["statusline#80"]);
	assert.equal(container.originalRenders, 1);

	// the session-swap window: pi has already clear()ed and mounted the built-in footer.
	container.clear();
	container.addChild(builtIn);
	assert.deepEqual(container.render(80), ["frozen#80"]);
	assert.deepEqual(container.render(40), ["frozen#40"]);
	// the built-in footer rendered zero times → the default footer never reaches the screen.
	assert.equal(container.originalRenders, 1);
});

test("the replayed rows re-truncate at the current width", () => {
	const ours = leaf("statusline");
	const container = new FakeContainer();
	container.addChild(ours);
	const wide = " ".repeat(30);
	freezeFooterContainer({
		container,
		ownComponent: ours,
		frozenRender: (width) => [wide.slice(0, width)],
	});

	container.clear();
	container.addChild(leaf("pi-default"));
	assert.deepEqual(container.render(10), [wide.slice(0, 10)]);
});

test("releasing restores the original render — no own render property or takeover record left", () => {
	const ours = leaf("statusline");
	const builtIn = leaf("pi-default");
	const container = new FakeContainer();
	container.addChild(ours);

	const release = freezeFooterContainer({
		container,
		ownComponent: ours,
		frozenRender: () => ["frozen"],
	})!;
	container.clear();
	container.addChild(builtIn);
	assert.deepEqual(container.render(10), ["frozen"]);

	release();
	assert.equal(Object.prototype.hasOwnProperty.call(container, "render"), false);
	assert.equal((container as { [FOOTER_GUARD_KEY]?: unknown })[FOOTER_GUARD_KEY], undefined);
	assert.deepEqual(container.render(10), ["pi-default#10"]);

	// idempotent: a repeat release changes nothing.
	release();
	assert.equal(Object.prototype.hasOwnProperty.call(container, "render"), false);
});

test("a repeat takeover of one container first releases the previous — no stacked wrappers", () => {
	const first = leaf("first");
	const second = leaf("second");
	const container = new FakeContainer();
	container.addChild(first);
	container.addChild(second);

	freezeFooterContainer({ container, ownComponent: first, frozenRender: () => ["frozen-first"] });
	freezeFooterContainer({ container, ownComponent: second, frozenRender: () => ["frozen-second"] });

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
	const ours = leaf("statusline");
	const builtIn = leaf("pi-default");
	const container = new FakeContainer();
	container.addChild(ours);
	let clock = 1000;
	const release = freezeFooterContainer({
		container,
		ownComponent: ours,
		frozenRender: () => ["frozen"],
		maxAgeMs: 500,
		now: () => clock,
	})!;

	// the component is still in its new spot (a completed handover's look) + past the timeout → pass through and release.
	clock = 1600;
	assert.deepEqual(container.render(9), ["statusline#9"]);
	assert.equal(Object.prototype.hasOwnProperty.call(container, "render"), false);

	// the other side: the new footer never arrived (a failed swap) → after the timeout, back to pi's default behavior.
	const ours2 = leaf("statusline2");
	const container2 = new FakeContainer();
	container2.addChild(ours2);
	let clock2 = 0;
	freezeFooterContainer({
		container: container2,
		ownComponent: ours2,
		frozenRender: () => ["frozen"],
		maxAgeMs: 500,
		now: () => clock2,
	});
	container2.clear();
	container2.addChild(builtIn);
	clock2 = 501;
	assert.deepEqual(container2.render(9), ["pi-default#9"]);
	release();
});

test("before the timeout, every frame emits only the replayed rows", () => {
	const ours = leaf("statusline");
	const container = new FakeContainer();
	container.addChild(ours);
	freezeFooterContainer({
		container,
		ownComponent: ours,
		frozenRender: (width) => [`frozen#${width}`, `frozen#${width}`],
	});
	container.clear();
	container.addChild(leaf("pi-default"));

	for (let frame = 0; frame < 5; frame += 1) {
		assert.deepEqual(container.render(80), ["frozen#80", "frozen#80"]);
	}
});

test("a wrong container shape → nothing happens (non-tui mode / pi changed internals)", () => {
	const noop = () => ["frozen"];
	assert.equal(freezeFooterContainer({ container: undefined, ownComponent: {}, frozenRender: noop }), undefined);
	assert.equal(freezeFooterContainer({ container: {}, ownComponent: {}, frozenRender: noop }), undefined);
	assert.equal(
		freezeFooterContainer({ container: { children: [] }, ownComponent: {}, frozenRender: noop }),
		undefined,
	);
	assert.equal(
		freezeFooterContainer({
			container: { children: "not-an-array", render: noop } as unknown as RenderableContainer,
			ownComponent: {},
			frozenRender: noop,
		}),
		undefined,
	);
	assert.equal(freezeFooterContainer({ container: new FakeContainer(), ownComponent: undefined, frozenRender: noop }), undefined);
});

test("an unwritable container mid-takeover does not throw", () => {
	const container = new FakeContainer();
	const ours = leaf("statusline");
	container.addChild(ours);
	Object.defineProperty(container, "render", {
		configurable: false,
		writable: false,
		value: (width: number) => [`locked#${width}`],
	});

	assert.equal(
		freezeFooterContainer({ container, ownComponent: ours, frozenRender: () => ["frozen"] }),
		undefined,
	);
	assert.deepEqual(container.render(4), ["locked#4"]);
});

test("releaseFooterGuard releases a takeover another extension instance left behind", () => {
	const ours = leaf("statusline");
	const builtIn = leaf("pi-default");
	const container = new FakeContainer();
	container.addChild(ours);
	freezeFooterContainer({ container, ownComponent: ours, frozenRender: () => ["frozen"] });

	assert.equal(releaseFooterGuard(container), true);
	assert.equal(releaseFooterGuard(container), false);
	container.clear();
	container.addChild(builtIn);
	assert.deepEqual(container.render(3), ["pi-default#3"]);
});
