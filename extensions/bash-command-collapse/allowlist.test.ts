/**
 * Tests for allowlist.ts —— 持久白名单的 IO 层。纯 node，不需要 pi。
 *
 * Run with:  node --test clients/pi/extensions/bash-command-collapse/allowlist.test.ts
 *
 * 断言口径：
 *   - 读写往返：remember → roots()/entries() 一致，落盘的是合法 JSON 且带 version；
 *   - 原子写：不留 .tmp 垃圾；
 *   - 损坏 / 不存在 / 版本不认识 → 降级为空，不抛；
 *   - 危险 scope 永远落不了盘（写入前过滤），手改的危险条目加载时也被过滤；
 *   - forget / clear / reload 语义；
 *   - 单例：同一个 filePath 拿到同一个实例，一边 remember 另一边立刻看见；
 *   - 会话 scope 集合独立于持久白名单，clear 只清会话。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	ALLOWLIST_VERSION,
	createAllowlistStore,
	defaultAllowlistPath,
	getAllowlistStore,
	getSessionScopes,
	resetAllowlistStoreCache,
} from "./allowlist.ts";
import type { PathEnv } from "./sandbox.ts";

const HOME = os.homedir();
const env: PathEnv = { home: HOME };

function tmpFile(): { file: string; dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-allowlist-"));
	return {
		file: path.join(dir, "sandbox-allowlist.json"),
		dir,
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

test("defaultAllowlistPath 在 agent 目录下", () => {
	assert.equal(defaultAllowlistPath("/Users/x/.pi/agent"), "/Users/x/.pi/agent/sandbox-allowlist.json");
});

test("读写往返：remember 后 roots/entries 一致，落盘是带 version 的合法 JSON", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		const written = store.remember([`${HOME}/Downloads`], "confirm", env);
		assert.deepEqual(written, [`${HOME}/Downloads`]);
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`]);

		const entries = store.entries();
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.path, `${HOME}/Downloads`);
		assert.equal(entries[0]!.source, "confirm");
		assert.ok(entries[0]!.addedAt, "要带时间戳");

		const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(onDisk.version, ALLOWLIST_VERSION);
		assert.equal(onDisk.entries.length, 1);
		assert.equal(onDisk.entries[0].path, `${HOME}/Downloads`);
	} finally {
		cleanup();
	}
});

test("原子写：不留 .tmp 垃圾", () => {
	const { file, dir, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		store.remember([`${HOME}/Downloads`], "confirm", env);
		const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp"));
		assert.deepEqual(leftovers, [], `不该留下临时文件：${leftovers.join("、")}`);
	} finally {
		cleanup();
	}
});

test("重复 remember 不写第二条、不刷新时间戳", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		store.remember([`${HOME}/Downloads`], "confirm", env);
		const first = store.entries()[0]!.addedAt;
		assert.deepEqual(store.remember([`${HOME}/Downloads`], "confirm", env), [], "已存在 → 没有新写入");
		assert.equal(store.entries().length, 1);
		assert.equal(store.entries()[0]!.addedAt, first);
	} finally {
		cleanup();
	}
});

test("尾斜杠与相对形态归一：同一个目录不会记两条", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		store.remember([`${HOME}/Downloads/`], "confirm", env);
		assert.deepEqual(store.remember([`${HOME}/Downloads`], "confirm", env), []);
		assert.equal(store.entries().length, 1);
	} finally {
		cleanup();
	}
});

test("文件不存在 → 空白名单，不抛", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		assert.deepEqual(store.roots(), []);
		assert.deepEqual(store.entries(), []);
	} finally {
		cleanup();
	}
});

test("损坏的 JSON → 降级为空，不抛", () => {
	const { file, cleanup } = tmpFile();
	try {
		fs.writeFileSync(file, "{ 这不是 JSON", "utf8");
		const store = createAllowlistStore(file, env);
		assert.deepEqual(store.roots(), []);
		// 降级之后仍能正常写入（覆盖掉损坏的文件）
		store.remember([`${HOME}/Downloads`], "confirm", env);
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`]);
	} finally {
		cleanup();
	}
});

test("版本不认识 → 整体丢弃", () => {
	const { file, cleanup } = tmpFile();
	try {
		fs.writeFileSync(
			file,
			JSON.stringify({ version: 99, entries: [{ path: `${HOME}/Downloads`, addedAt: "x", source: "confirm" }] }),
			"utf8",
		);
		const store = createAllowlistStore(file, env);
		assert.deepEqual(store.roots(), [], "不认识的版本不猜旧格式");
	} finally {
		cleanup();
	}
});

test("非对象 / entries 不是数组 → 降级为空", () => {
	const { file, cleanup } = tmpFile();
	try {
		fs.writeFileSync(file, JSON.stringify([1, 2, 3]), "utf8");
		assert.deepEqual(createAllowlistStore(file, env).roots(), []);
		fs.writeFileSync(file, JSON.stringify({ version: ALLOWLIST_VERSION, entries: "nope" }), "utf8");
		assert.deepEqual(createAllowlistStore(file, env).roots(), []);
	} finally {
		cleanup();
	}
});

test("写入前过滤：危险 scope 永远落不了盘", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		const written = store.remember(
			["/", HOME, `${HOME}/.ssh`, `${HOME}/.config`, "/usr/local", `${HOME}/projects/x/.git`, `${HOME}/Downloads`],
			"confirm",
			env,
		);
		assert.deepEqual(written, [`${HOME}/Downloads`], "只有普通目录能落盘");
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`]);
	} finally {
		cleanup();
	}
});

test("加载时过滤：手改塞进来的危险条目被丢掉", () => {
	const { file, cleanup } = tmpFile();
	try {
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: ALLOWLIST_VERSION,
				entries: [
					{ path: "/", addedAt: "x", source: "confirm" },
					{ path: HOME, addedAt: "x", source: "confirm" },
					{ path: `${HOME}/.ssh`, addedAt: "x", source: "confirm" },
					{ path: `${HOME}/Downloads`, addedAt: "x", source: "confirm" },
				],
			}),
			"utf8",
		);
		const store = createAllowlistStore(file, env);
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`], "危险条目加载时就被过滤");
	} finally {
		cleanup();
	}
});

test("加载时丢掉畸形条目与重复条目", () => {
	const { file, cleanup } = tmpFile();
	try {
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: ALLOWLIST_VERSION,
				entries: [
					null,
					{ addedAt: "x" }, // 没有 path
					{ path: "", addedAt: "x" },
					{ path: `${HOME}/Downloads`, addedAt: "x", source: "confirm" },
					{ path: `${HOME}/Downloads/`, addedAt: "y", source: "command" }, // 归一后重复
				],
			}),
			"utf8",
		);
		const store = createAllowlistStore(file, env);
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`]);
		assert.equal(store.entries()[0]!.source, "confirm", "保留第一条");
	} finally {
		cleanup();
	}
});

test("source 不认识时归为 confirm", () => {
	const { file, cleanup } = tmpFile();
	try {
		fs.writeFileSync(
			file,
			JSON.stringify({ version: ALLOWLIST_VERSION, entries: [{ path: `${HOME}/Downloads`, addedAt: "x", source: "weird" }] }),
			"utf8",
		);
		assert.equal(createAllowlistStore(file, env).entries()[0]!.source, "confirm");
	} finally {
		cleanup();
	}
});

test("forget：按解析后的路径精确匹配，返回是否真的移除了", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		store.remember([`${HOME}/Downloads`, `${HOME}/projects`], "confirm", env);
		assert.equal(store.forget(`${HOME}/Downloads/`), true, "尾斜杠归一后能匹配");
		assert.deepEqual(store.roots(), [`${HOME}/projects`]);
		assert.equal(store.forget(`${HOME}/nope`), false, "不在名单里");
		assert.deepEqual(store.roots(), [`${HOME}/projects`], "没匹配上就不动文件");
	} finally {
		cleanup();
	}
});

test("clear：返回清掉的条数，空名单时不写盘", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		assert.equal(store.clear(), 0, "本来就是空的");
		assert.equal(fs.existsSync(file), false, "空名单不该凭空造出文件");
		store.remember([`${HOME}/Downloads`, `${HOME}/projects`], "confirm", env);
		assert.equal(store.clear(), 2);
		assert.deepEqual(store.roots(), []);
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).entries, [], "落盘也清空了");
	} finally {
		cleanup();
	}
});

test("reload：丢掉内存缓存，重新读盘（看见外部改动）", () => {
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		store.remember([`${HOME}/Downloads`], "confirm", env);
		// 模拟另一个进程 / 手改：直接往文件里加一条
		const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
		onDisk.entries.push({ path: `${HOME}/projects`, addedAt: "x", source: "command" });
		fs.writeFileSync(file, JSON.stringify(onDisk), "utf8");
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`], "没 reload 前还是内存里那份");
		store.reload();
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`, `${HOME}/projects`]);
	} finally {
		cleanup();
	}
});

test("单例：同一个 filePath 拿到同一个实例，一边写另一边立刻看见", () => {
	const { file, cleanup } = tmpFile();
	resetAllowlistStoreCache();
	try {
		const a = getAllowlistStore(file, env);
		const b = getAllowlistStore(file, env);
		assert.equal(a, b, "同一个路径必须是同一个实例");
		a.remember([`${HOME}/Downloads`], "confirm", env);
		assert.deepEqual(b.roots(), [`${HOME}/Downloads`], "bash 侧记住，apply_patch 侧立刻生效");
	} finally {
		resetAllowlistStoreCache();
		cleanup();
	}
});

test("单例按解析后的路径去重：尾斜杠与 `.` 段拿到同一个实例", () => {
	const { file, cleanup } = tmpFile();
	resetAllowlistStoreCache();
	try {
		const a = getAllowlistStore(file, env);
		const b = getAllowlistStore(`${file}/`, env);
		const c = getAllowlistStore(path.join(path.dirname(file), ".", path.basename(file)), env);
		assert.equal(a, b, "尾斜杠归一后是同一个实例");
		assert.equal(a, c, "`.` 段归一后是同一个实例");
	} finally {
		resetAllowlistStoreCache();
		cleanup();
	}
});

test("单例键是词法的：/var 与 /private/var 两种拼写拿到两个实例（可接受的取舍）", () => {
	// 这不是缺陷而是取舍：缓存键用 resolvePath（词法），不跳符号链接。
	// macOS 上 os.tmpdir() 就是 /var/folders/…，而它的 realpath 是 /private/var/folders/…，
	// 所以这两种拼写确实会拿到两个实例。但两个扩展算路径的代码完全相同
	// （PI_SANDBOX_ALLOWLIST 或 join(getAgentDir(), …)），getAgentDir() 又是确定性的，
	// 同一进程里两边拿到的字符串必然一致 —— 不存在“一边记住另一边看不见”的实际路径。
	// 这里把边界钉住：将来若改成允许两侧用不同拼写，这条测试会提醒需要改成 realpath 键。
	resetAllowlistStoreCache();
	const { dir, cleanup } = tmpFile();
	try {
		assert.ok(dir.startsWith("/var/") || dir.startsWith("/private/var/"), `本用例依赖 macOS 的 /var 链接：${dir}`);
		const varForm = dir.replace(/^\/private/, "");
		const privateForm = varForm.startsWith("/private") ? varForm : `/private${varForm}`;
		const a = getAllowlistStore(path.join(varForm, "x.json"), env);
		const b = getAllowlistStore(path.join(privateForm, "x.json"), env);
		assert.notEqual(a, b, "词法键：两种拼写是两个实例（两边代码相同时不会发生）");
	} finally {
		resetAllowlistStoreCache();
		cleanup();
	}
});

test("会话 scope 集合：add / roots / clear，与持久白名单互不影响", () => {
	const scopes = getSessionScopes();
	scopes.clear();
	const { file, cleanup } = tmpFile();
	try {
		const store = createAllowlistStore(file, env);
		store.remember([`${HOME}/Downloads`], "confirm", env);

		scopes.add([`${HOME}/.config/foo`, `${HOME}/.config/foo/`]);
		assert.deepEqual(scopes.roots(), [`${HOME}/.config/foo`], "去重 + 去尾斜杠");
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`], "会话豁免不落盘");

		scopes.clear();
		assert.deepEqual(scopes.roots(), []);
		assert.deepEqual(store.roots(), [`${HOME}/Downloads`], "清会话不动持久白名单");
	} finally {
		scopes.clear();
		cleanup();
	}
});

test("会话 scope 集合是 globalThis 单例：两次 get 拿到同一份状态", () => {
	const a = getSessionScopes();
	const b = getSessionScopes();
	a.clear();
	a.add([`${HOME}/.config/foo`]);
	assert.deepEqual(b.roots(), [`${HOME}/.config/foo`]);
	a.clear();
});
