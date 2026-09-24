/**
 * 持久白名单的 IO 层 —— 「这个目录确认过一次安全，以后就别再问了」的落盘处。
 *
 * ## 为什么单独一个文件
 *
 * `sandbox.ts` 是纯逻辑（无 IO、无 pi 依赖），所以它能被 `node --test` 直接跑。
 * 白名单要读写 `~/.pi/agent/sandbox-allowlist.json`，是 IO；而它又必须被**两个**扩展
 * 共用（bash 沙箱那条路线与 `apply_patch` 那条），否则两边各记各的、口径会漂移。
 * 于是单独一层，且**不 import pi**：agent 目录由调用方解析后传进来
 * （`bash-command-collapse.ts` 与 `sandbox-boundary/index.ts` 都已经在 import pi，
 * 由它们调 `getAgentDir()`），这样本模块也能被 `node --test` 直接跑。
 *
 * ## 存哪、存什么
 *
 * `~/.pi/agent/sandbox-allowlist.json`：
 *
 * ```json
 * { "version": 1, "entries": [{ "path": "/Users/x/Downloads", "addedAt": "…", "source": "confirm" }] }
 * ```
 *
 * 这是**机器本地状态**，与 `sessions/`、`auth.json` 同类，刻意不进 `clients/pi/` 快照。
 * `PI_SANDBOX_ALLOWLIST=<path>` 可以改位置 —— 既是用户旋钮，也是测试隔离的必需项
 * （否则测试会读到用户真实的白名单，结果不确定）。
 *
 * 白名单是**全局**的：在项目 A 授权的目录，在项目 B 同样生效。这是用户定的口径
 * （「记录到了 pi 的全局配置中」），不是疏漏。
 *
 * ## 三道防线
 *
 * 1. **写入前过滤**：`remember()` 只接受过 `isSafeAllowlistRoot` 的范围，危险路径
 *    （`/`、`$HOME`、`~/.ssh`、含 `.git` 的路径…）永远落不了盘。
 * 2. **加载时再过滤**：手改或损坏的 JSON 塞不进 `/`。
 * 3. **原子写**：临时文件 + rename，写一半崩了不会留下截断的 JSON。
 *
 * 损坏 / 读不到 / 版本不认识 → 一律降级为空白名单，**不抛**。这道闸的职责是少弹框，
 * 不是多一个让 pi 起不来的失败点；降级为空的后果只是「多问一次」，方向是安全的。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { isSafeAllowlistRoot, type PathEnv } from "./sandbox.ts";

/** 白名单文件名（在 agent 目录下）。 */
export const ALLOWLIST_FILENAME = "sandbox-allowlist.json";

/** 当前 schema 版本。读到的版本不等于它就整体丢弃（宁可可空也不猜旧格式）。 */
export const ALLOWLIST_VERSION = 1;

/** 条目是怎么进来的：弹框里选了 `Allow for this session（并记住该目录）`，还是 `/sandbox-boundary allow` 手动加的。 */
export type AllowlistSource = "confirm" | "command";

export interface AllowlistEntry {
	/** 已解析的绝对路径，去尾斜杠。 */
	readonly path: string;
	/** ISO 时间戳，只为在 `/sandbox-boundary` 里给人看。 */
	readonly addedAt: string;
	readonly source: AllowlistSource;
}

interface AllowlistFile {
	version: number;
	entries: Array<{ path?: unknown; addedAt?: unknown; source?: unknown }>;
}

export interface AllowlistStore {
	/** 实际读写的文件路径（`/sandbox-boundary` 要显示它）。 */
	readonly filePath: string;
	/** 全部条目的路径，已过滤掉不安全的根。profile 注入与边界判定都用这个。 */
	roots(): string[];
	/** 全部条目（含时间与来源），给 `/sandbox-boundary` 列表用。 */
	entries(): AllowlistEntry[];
	/**
	 * 记住这些范围，返回**实际写入**的那些（被安全闸挡掉的不在里面）。
	 * 已经在名单里的不重复写，也不刷新时间戳。
	 */
	remember(paths: readonly string[], source: AllowlistSource, env: PathEnv): string[];
	/** 移除一条（按解析后的路径精确匹配）。返回是否真的移除了。 */
	forget(path: string): boolean;
	/** 清空。返回清掉的条数。 */
	clear(): number;
	/** 丢掉内存缓存，下次读盘。文件被外部改动后用。 */
	reload(): void;
}

/** agent 目录下的默认白名单路径。 */
export function defaultAllowlistPath(agentDir: string): string {
	return join(agentDir, ALLOWLIST_FILENAME);
}

/**
 * 进程内单例：按**解析后的文件路径**缓存 store。
 *
 * 挂在 `globalThis` 上而不是模块级变量，是因为两个扩展各自 import 本模块，
 * 加载器不保证给它们同一个模块实例 —— 挂在 globalThis 上则无论实例是否相同，
 * 两边看到的一定是同一份内存状态（一边记住、另一边立刻生效）。
 */
const STORE_CACHE_KEY = "__piSandboxAllowlistStores__";

function storeCache(): Map<string, AllowlistStore> {
	const host = globalThis as unknown as Record<string, Map<string, AllowlistStore> | undefined>;
	const existing = host[STORE_CACHE_KEY];
	if (existing) return existing;
	const created = new Map<string, AllowlistStore>();
	host[STORE_CACHE_KEY] = created;
	return created;
}

/**
 * 取（或建）一个 store。同一个 `filePath` 永远返回同一个实例。
 *
 * `env` 用于加载时的安全过滤，只在**首次创建**时用到；后续调用返回缓存实例。
 */
export function getAllowlistStore(filePath: string, env: PathEnv): AllowlistStore {
	const resolved = resolvePath(filePath);
	const cache = storeCache();
	const cached = cache.get(resolved);
	if (cached) return cached;
	const store = createAllowlistStore(resolved, env);
	cache.set(resolved, store);
	return store;
}

/** 测试用：清掉单例缓存，让下一次 `getAllowlistStore` 重新读盘。 */
export function resetAllowlistStoreCache(): void {
	storeCache().clear();
}

/** 建一个 store（不走单例缓存）。测试与 `getAllowlistStore` 都用它。 */
export function createAllowlistStore(filePath: string, env: PathEnv): AllowlistStore {
	const resolvedFile = resolvePath(filePath);
	let cache: AllowlistEntry[] | undefined;

	const read = (): AllowlistEntry[] => {
		if (cache) return cache;
		cache = parseFile(resolvedFile, env);
		return cache;
	};

	const write = (entries: readonly AllowlistEntry[]): void => {
		const payload: AllowlistFile = { version: ALLOWLIST_VERSION, entries: [...entries] };
		mkdirSync(dirname(resolvedFile), { recursive: true });
		// 原子写：先写同目录下的临时文件，再 rename 覆盖。
		// 临时文件名带 pid + 时间戳，避免两个 pi 进程同时写时互相踩。
		const tmp = `${resolvedFile}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		try {
			renameSync(tmp, resolvedFile);
		} catch (err) {
			// rename 失败就把临时文件收掉，别在 agent 目录里留垃圾；然后照原样抛，
			// 让调用方知道这次没记住（下次还会问，方向是安全的）。
			try {
				unlinkSync(tmp);
			} catch {
				// 收不掉就算了：一个 .tmp 文件不值得再抛一次盖住真正的错误
			}
			throw err;
		}
		cache = [...entries];
	};

	return {
		filePath: resolvedFile,
		roots: () => read().map((e) => e.path),
		entries: () => [...read()],
		remember(paths, source, rememberEnv) {
			const current = read();
			const existing = new Set(current.map((e) => e.path));
			const added: AllowlistEntry[] = [];
			for (const raw of paths) {
				const resolved = stripTrailingSlash(resolvePath(raw));
				if (existing.has(resolved)) continue;
				// 写入前过滤：危险路径永远落不了盘，哪怕调用方算错了范围。
				if (!isSafeAllowlistRoot(resolved, rememberEnv)) continue;
				existing.add(resolved);
				added.push({ path: resolved, addedAt: new Date().toISOString(), source });
			}
			if (added.length === 0) return [];
			write([...current, ...added]);
			return added.map((e) => e.path);
		},
		forget(path) {
			const resolved = stripTrailingSlash(resolvePath(path));
			const current = read();
			const next = current.filter((e) => e.path !== resolved);
			if (next.length === current.length) return false;
			write(next);
			return true;
		},
		clear() {
			const count = read().length;
			if (count === 0) return 0;
			write([]);
			return count;
		},
		reload() {
			cache = undefined;
		},
	};
}

/** 读盘 + 校验 + 安全过滤。任何异常都降级为空数组。 */
function parseFile(filePath: string, env: PathEnv): AllowlistEntry[] {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return []; // 文件不存在（首次使用）或读不到：空白名单，多问一次而已
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return []; // 损坏的 JSON：不猜、不抛，当作空
	}

	if (!parsed || typeof parsed !== "object") return [];
	const file = parsed as Partial<AllowlistFile>;
	if (file.version !== ALLOWLIST_VERSION) return []; // 不认识的版本：整体丢弃
	if (!Array.isArray(file.entries)) return [];

	const out: AllowlistEntry[] = [];
	const seen = new Set<string>();
	for (const item of file.entries) {
		if (!item || typeof item !== "object") continue;
		if (typeof item.path !== "string" || !item.path) continue;
		const resolved = stripTrailingSlash(resolvePath(item.path));
		if (seen.has(resolved)) continue;
		// 加载时也过滤：手改的 JSON 塞不进 `/` 或 `~/.ssh`
		if (!isSafeAllowlistRoot(resolved, env)) continue;
		seen.add(resolved);
		out.push({
			path: resolved,
			addedAt: typeof item.addedAt === "string" ? item.addedAt : "",
			source: item.source === "command" ? "command" : "confirm",
		});
	}
	return out;
}

function stripTrailingSlash(p: string): string {
	return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * 会话级豁免（危险目录的 `Allow for this session`）与单次豁免（`Allow once`）。
 *
 * 与持久白名单分开，因为它们的寿命不同：会话级重启 pi 就没了，单次只活到这条命令跑完。
 * 同样挂 `globalThis`，理由与 store 缓存一致。
 */
const SESSION_KEY = "__piSandboxSessionScopes__";

export interface SessionScopes {
	/** 本会话已豁免的目录（危险目录选了 `Allow for this session`）。 */
	roots(): string[];
	add(paths: readonly string[]): void;
	clear(): void;
}

export function getSessionScopes(): SessionScopes {
	const host = globalThis as unknown as Record<string, Set<string> | undefined>;
	const existing = host[SESSION_KEY];
	const set = existing ?? new Set<string>();
	host[SESSION_KEY] = set;
	return {
		roots: () => [...set],
		add: (paths) => {
			for (const p of paths) set.add(stripTrailingSlash(resolvePath(p)));
		},
		clear: () => set.clear(),
	};
}
