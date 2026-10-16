import assert from "node:assert/strict";
import { test } from "node:test";
import {
	FOOTER_SUPPRESS_KEY,
	FOOTER_SUPPRESS_MAX_AGE_MS,
	releaseFooterSuppressor,
	suppressBuiltInFooter,
} from "./footer-suppress.ts";

/** A fake pi `FooterComponent`: render is a prototype method — the instance has no own render. */
class FakeFooter {
	/** How many times the real original ran (for asserting "the real content drew zero frames while suppressed"). */
	originalRenders = 0;

	render(width: number): string[] {
		this.originalRenders += 1;
		return [`pi-default#${width}`, `stats#${width}`];
	}
}

function recordOf(): unknown {
	return (FakeFooter.prototype as { [FOOTER_SUPPRESS_KEY]?: unknown })[FOOTER_SUPPRESS_KEY];
}

test("the built-in footer renders 0 rows while suppressed; releasing restores the original render", () => {
	const footer = new FakeFooter();
	const release = suppressBuiltInFooter(FakeFooter);
	assert.equal(typeof release, "function");

	assert.deepEqual(footer.render(80), []);
	assert.deepEqual(footer.render(40), []);
	// while suppressed the real original ran zero times → the default statusline never reaches the screen.
	assert.equal(footer.originalRenders, 0);

	release();
	assert.deepEqual(footer.render(80), ["pi-default#80", "stats#80"]);
	assert.equal(footer.originalRenders, 1);
});

test("no takeover record left after release — and idempotent", () => {
	const release = suppressBuiltInFooter(FakeFooter)!;
	release();
	assert.equal(recordOf(), undefined);
	assert.equal(releaseFooterSuppressor(FakeFooter), false);

	// a repeat release changes nothing (the prototype method is still the real original).
	const before = FakeFooter.prototype.render;
	release();
	release();
	assert.equal(FakeFooter.prototype.render, before);
	assert.deepEqual(new FakeFooter().render(5), ["pi-default#5", "stats#5"]);
});

test("a repeat takeover releases the previous first — no stacked wrappers", () => {
	const footer = new FakeFooter();
	const releaseFirst = suppressBuiltInFooter(FakeFooter)!;
	assert.deepEqual(footer.render(10), []);

	// simulating `/reload`: the module re-evals → the new instance patches once more.
	const releaseSecond = suppressBuiltInFooter(FakeFooter)!;
	assert.deepEqual(footer.render(10), []);
	assert.equal(footer.originalRenders, 0);

	// releasing only the second: if the first wrapper were still stacked, this would keep emitting empty rows.
	releaseSecond();
	assert.deepEqual(footer.render(10), ["pi-default#10", "stats#10"]);
	assert.equal(footer.originalRenders, 1);

	releaseFirst();
	assert.deepEqual(footer.render(10), ["pi-default#10", "stats#10"]);
});

test("releaseFooterSuppressor releases a takeover another extension instance left behind", () => {
	suppressBuiltInFooter(FakeFooter);
	assert.equal(new FakeFooter().render(7).length, 0);

	assert.equal(releaseFooterSuppressor(FakeFooter), true);
	assert.equal(releaseFooterSuppressor(FakeFooter), false);
	assert.deepEqual(new FakeFooter().render(7), ["pi-default#7", "stats#7"]);
});

test("self-heals past the timeout: releases the original render and clears the takeover record", () => {
	let clock = 1000;
	const footer = new FakeFooter();
	suppressBuiltInFooter(FakeFooter, { maxAgeMs: 500, now: () => clock });
	assert.deepEqual(footer.render(9), []);

	// not yet due: still suppressed.
	clock = 1500;
	assert.deepEqual(footer.render(9), []);

	// past due: auto-released — later frames take the real original.
	clock = 1501;
	assert.deepEqual(footer.render(9), ["pi-default#9", "stats#9"]);
	assert.equal(recordOf(), undefined);
	assert.deepEqual(footer.render(9), ["pi-default#9", "stats#9"]);
});

test("the default max-age covers a slow start (`mcp`'s 20s handshake cap) — and is positive", () => {
	assert.ok(FOOTER_SUPPRESS_MAX_AGE_MS >= 25_000);
});

test("a wrong shape → nothing happens (pi changed internals / wrong thing passed)", () => {
	assert.equal(suppressBuiltInFooter(undefined), undefined);
	assert.equal(suppressBuiltInFooter(null), undefined);
	assert.equal(suppressBuiltInFooter("FooterComponent"), undefined);
	assert.equal(suppressBuiltInFooter({}), undefined);
	assert.equal(suppressBuiltInFooter({ prototype: {} }), undefined);
	assert.equal(suppressBuiltInFooter({ prototype: { render: "not-a-function" } }), undefined);
});

test("passing a render-bearing object directly also works (a class is not required)", () => {
	const component = {
		render(width: number): string[] {
			return [`raw#${width}`];
		},
	};
	const release = suppressBuiltInFooter(component);
	assert.equal(typeof release, "function");
	assert.deepEqual(component.render(3), []);

	release();
	assert.deepEqual(component.render(3), ["raw#3"]);
	assert.equal(Object.prototype.hasOwnProperty.call(component, "render"), true);
});

test("a read-only prototype does not throw — degrades to the original", () => {
	class Locked {
		render(): string[] {
			return ["locked"];
		}
	}
	Object.defineProperty(Locked.prototype, "render", {
		configurable: false,
		writable: false,
		value: () => ["locked"],
	});

	assert.equal(suppressBuiltInFooter(Locked), undefined);
	assert.deepEqual(new Locked().render(), ["locked"]);
});

test("the wrapper's `this` passes through to the real original (instance state reads/writes as usual)", () => {
	const footer = new FakeFooter();
	const release = suppressBuiltInFooter(FakeFooter)!;
	assert.deepEqual(footer.render(80), []);
	release();
	assert.deepEqual(footer.render(80), ["pi-default#80", "stats#80"]);
	assert.equal(footer.originalRenders, 1);
});
