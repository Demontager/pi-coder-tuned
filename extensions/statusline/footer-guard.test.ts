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
 * 仿 pi-tui 的 `Container`：`clear()` 会**换掉**整个 children 数组
 * （`this.children = []`），所以守卫必须每次重读该字段而不是缓存它。
 */
class FakeContainer implements RenderableContainer {
	children: unknown[] = [];
	/** 原 render 被调用的次数（断言「默认 footer 一帧都没出」用）。 */
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

/** 仿叶子组件：行里带上自己的名字和宽度，方便看出行是谁、按哪个宽度渲染的。 */
interface Leaf {
	render(width: number): string[];
}

function leaf(name: string, lines = 1): Leaf {
	return { render: (width: number) => Array.from({ length: lines }, () => `${name}#${width}`) };
}

/** 仿 `tui`：只有 children，没有 render（findRenderContainer 只认 children）。 */
function tuiRoot(...children: unknown[]): { children: unknown[] } {
	return { children };
}

test("findRenderContainer 按对象身份认出直接持有它的容器", () => {
	const ours = leaf("statusline");
	const inner = new FakeContainer();
	inner.addChild(ours);
	const outer = new FakeContainer();
	outer.addChild(inner);
	const root = tuiRoot(new FakeContainer(), outer);

	assert.equal(findRenderContainer(root, ours), inner);
});

test("findRenderContainer 找不到就返回 undefined，不猜位置", () => {
	const inner = new FakeContainer();
	inner.addChild(leaf("other"));
	const root = tuiRoot(inner);

	assert.equal(findRenderContainer(root, leaf("missing")), undefined);
	assert.equal(findRenderContainer(root, undefined), undefined);
	assert.equal(findRenderContainer(undefined, leaf("x")), undefined);
	assert.equal(findRenderContainer({ notAContainer: true }, leaf("x")), undefined);
});

test("findRenderContainer 容忍环状引用与只读 children", () => {
	const a = new FakeContainer();
	const b = new FakeContainer();
	a.addChild(b);
	b.addChild(a);

	assert.equal(findRenderContainer(a, leaf("nope")), undefined);

	const frozenRoot = tuiRoot({ children: Object.freeze([leaf("x")]) as unknown[] });
	assert.equal(findRenderContainer(frozenRoot, leaf("y")), undefined);
});

test("我们的组件在位时原样透传，被换成内置 footer 时出重放行", () => {
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

	// 正常会话：真实渲染照旧。
	assert.deepEqual(container.render(80), ["statusline#80"]);
	assert.equal(container.originalRenders, 1);

	// 换会话窗口：pi 已经 clear() 并挂上内置 footer。
	container.clear();
	container.addChild(builtIn);
	assert.deepEqual(container.render(80), ["frozen#80"]);
	assert.deepEqual(container.render(40), ["frozen#40"]);
	// 内置 footer 一次都没被渲染 → 屏幕上不会出现默认 footer。
	assert.equal(container.originalRenders, 1);
});

test("重放行按当前宽度重新截断", () => {
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

test("解除接管后恢复原渲染，且不留 own render 属性与接管记录", () => {
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

	// 幂等：重复解除不再改动任何东西。
	release();
	assert.equal(Object.prototype.hasOwnProperty.call(container, "render"), false);
});

test("对同一容器重复接管会先交还上一次，不叠两层", () => {
	const first = leaf("first");
	const second = leaf("second");
	const container = new FakeContainer();
	container.addChild(first);
	container.addChild(second);

	freezeFooterContainer({ container, ownComponent: first, frozenRender: () => ["frozen-first"] });
	freezeFooterContainer({ container, ownComponent: second, frozenRender: () => ["frozen-second"] });

	// first 在位、second 不在位：若两层的 wrapper 还叠着，这里会出 frozen-first；
	// 只保留最后一次接管 → 判定 second 不在位 → 出 frozen-second。
	container.clear();
	container.addChild(first);
	assert.deepEqual(container.render(7), ["frozen-second"]);

	// second 回到位 → 透传。
	container.addChild(second);
	assert.deepEqual(container.render(7), ["first#7", "second#7"]);
});

test("超时后自愈：组件在位与否都交还原渲染", () => {
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

	// 组件仍在新位置（正常交接后的样子）+ 已超时 → 透传并交还。
	clock = 1600;
	assert.deepEqual(container.render(9), ["statusline#9"]);
	assert.equal(Object.prototype.hasOwnProperty.call(container, "render"), false);

	// 另一侧：新 footer 一直没来（换会话失败）→ 超时后回到 pi 默认行为。
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

test("未超时期间无论多少帧都只出重放行", () => {
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

test("容器形状不对时什么都不做（非 tui 模式 / pi 改了结构）", () => {
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

test("接管过程中容器不可写时不抛错", () => {
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

test("releaseFooterGuard 能解除别人（别的扩展实例）留下的接管", () => {
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
