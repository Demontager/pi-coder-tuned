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
 * 仿 pi-tui 的 `Container`：`clear()` 会**换掉**整个 children 数组
 * （`this.children = []`），所以守卫必须每次重读该字段而不是缓存它。
 */
class FakeContainer implements RenderableContainer {
	children: unknown[] = [];
	/** 原 render 被调用的次数（断言「内置 header 一帧都没出」用）。 */
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
	const ours = leaf("startup-logo");
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

test("我们的组件在位时原样透传，被换成内置 header 时出重放行", () => {
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

	// 正常会话：真实渲染照旧。
	assert.deepEqual(container.render(80), ["startup-logo#80"]);
	assert.equal(container.originalRenders, 1);

	// 换会话窗口：pi 已经 clear() 并挂上内置 header。
	container.clear();
	container.addChild(builtIn);
	assert.deepEqual(container.render(80), ["frozen#80"]);
	assert.deepEqual(container.render(40), ["frozen#40"]);
	// 内置 header 一次都没被渲染 → 屏幕上不会出现它。
	assert.equal(container.originalRenders, 1);
});

test("重放行按当前宽度重新截断", () => {
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

test("解除接管后恢复原渲染，且不留 own render 属性与接管记录", () => {
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

	// 幂等：重复解除不再改动任何东西。
	release();
	assert.equal(Object.prototype.hasOwnProperty.call(container, "render"), false);
});

test("releaseHeaderGuard 只在确有接管时报告成功", () => {
	const container = new FakeContainer();
	assert.equal(releaseHeaderGuard(container), false);
	assert.equal(releaseHeaderGuard(undefined), false);
	const release = freezeHeaderContainer({ container, ownComponent: {}, frozenRender: () => ["frozen"] });
	assert.equal(releaseHeaderGuard(container), true);
	// 已被解除 → 再解除报 false。
	release?.();
	assert.equal(releaseHeaderGuard(container), false);
});

test("对同一容器重复接管会先交还上一次，不叠两层", () => {
	const first = leaf("first");
	const second = leaf("second");
	const container = new FakeContainer();
	container.addChild(first);
	container.addChild(second);

	freezeHeaderContainer({ container, ownComponent: first, frozenRender: () => ["frozen-first"] });
	freezeHeaderContainer({ container, ownComponent: second, frozenRender: () => ["frozen-second"] });

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

	// 组件仍在新位置（正常交接后的样子）+ 已超时 → 透传并交还。
	clock = 1600;
	assert.deepEqual(container.render(9), ["startup-logo#9"]);
	assert.equal(Object.prototype.hasOwnProperty.call(container, "render"), false);

	// 另一侧：新 header 一直没来（换会话失败）→ 超时后回到 pi 默认行为。
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

test("未超时期间无论多少帧都只出重放行", () => {
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

test("容器形状不对时什么都不做（非 tui 模式 / pi 改了结构）", () => {
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
	// ownComponent 为 undefined（header 还没装上）也不接管。
	assert.equal(
		freezeHeaderContainer({ container: new FakeContainer(), ownComponent: undefined, frozenRender: noop }),
		undefined,
	);
});

test("frozenRender 抛错时回落到原渲染，不把异常漏给宿主", () => {
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
