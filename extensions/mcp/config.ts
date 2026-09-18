/**
 * config.ts — MCP 服务器配置的发现与归一化。
 *
 * 配置来源两条（决策记录：用户选定「全局 + 项目」）：
 *   1. 全局 `~/.pi/agent/mcp.json`
 *   2. 项目根的 `.mcp.json` —— 从 cwd 往上找到**第一个**就停（模拟 Claude Code 的
 *      project-root 语义）。同名 server 项目覆盖全局。
 *
 * 之所以直接沿用 Claude Code 的 `{"mcpServers": {...}}` 格式：用户的 `.mcp.json` 已经存在，
 * 照抄一份就能用，不需要两套配置语言；`mcpServers` 这个键名也正好和 `~/.claude.json`、
 * opencode 的语义对得上（opencode 只是多了 `type: "local"` 与 `command` 数组的形式）。
 *
 * 格式（两个 JSON 文件都支持这些字段）：
 * ```json
 * {
 *   "mcpServers": {
 *     "wechat-local": { "command": "...", "args": ["--transport","stdio"], "env": {}, "cwd": ".", "timeout": 120000 },
 *     "remote":       { "type": "http", "url": "https://host/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" } },
 *     "remote-saas":  { "url": "https://host/mcp", "headersCommand": "security find-generic-password -s host -w" }
 *   }
 * }
 * ```
 * 字符串字段支持 `${VAR}` 与 `${VAR:-默认值}` 展开（Claude Code 同款语法）。
 *
 * 远程服务器的 `headersCommand` 是动态请求头：跑这条命令、把输出解析成头（详见 headers-command.ts）。
 * `headersHelper`（Claude Code）与 `http_headers_helper`（Codex）是它的别名，从那边拷配置不用改字段名。
 *
 * 刻意不做的事：不读 `~/.claude.json` 的按项目 mcpServers（那是 Claude Code 的私有状态，
 * 不是可维护的配置文件）；不读 opencode 的 `opencode.jsonc`（格式与键名不同，两套语义会打架）。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath, resolve } from "node:path";

import { DEFAULT_HEADERS_COMMAND_TIMEOUT_MS } from "./headers-command.ts";

export type McpTransportKind = "stdio" | "http" | "sse";

/** 工具调用默认超时。wechat_sync 这类重活可以在配置里单独放长。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/** 握手（spawn / initialize / tools/list）默认超时，比工具调用短：启动阶段不该无限等。 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;

/** 项目 `.mcp.json` 向上查找的最大层数，防止在奇怪的文件系统上一直走到根。 */
const MAX_PROJECT_WALK_LEVELS = 32;

export interface McpServerCommon {
	name: string;
	transport: McpTransportKind;
	/** 该 server 来自哪个配置文件（状态展示用）。 */
	source: string;
	/** 工具调用超时（毫秒）。 */
	timeoutMs: number;
	/** 是否启用。`enabled: false` / `disabled: true` 的条目保留下来只为 `/mcp` 能显示出来。 */
	enabled: boolean;
}

export interface McpStdioServer extends McpServerCommon {
	transport: "stdio";
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
}

export interface McpRemoteServer extends McpServerCommon {
	transport: "http" | "sse";
	url: string;
	headers: Record<string, string>;
	/** 动态请求头：跑这条命令、把输出解析成头（Claude Code 的 `headersHelper` / Codex 的 `http_headers_helper`）。 */
	headersCommand?: string;
	/** 头命令超时（毫秒），默认 10s。 */
	headersCommandTimeoutMs?: number;
}

export type McpServerConfig = McpStdioServer | McpRemoteServer;

export interface McpConfigIssue {
	source: string;
	server?: string;
	message: string;
}

export interface McpConfigLoadResult {
	servers: McpServerConfig[];
	/** 实际读到的配置文件（相对路径会被展开成绝对路径，便于状态展示）。 */
	sources: string[];
	issues: McpConfigIssue[];
}

export interface LoadMcpConfigOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** 覆盖家目录（测试用；真实调用不传）。 */
	homeDir?: string;
	/** 覆盖全局配置路径（测试用）。 */
	globalConfigPath?: string;
}

/** 全局配置文件路径（`~/.pi/agent/mcp.json`）。 */
export function globalMcpConfigPath(homeDir: string = homedir()): string {
	return join(homeDir, ".pi", "agent", "mcp.json");
}

/**
 * 从 `startDir` 往上找第一个 `.mcp.json`。
 *
 * 找到就停（近的赢），走到根还在找就返回 undefined。顺带把 `.mcp.json` 放在 home 之外的
 * 场景也覆盖了（比如仓库在 /opt/work/foo）。
 */
export function findProjectMcpConfigPath(
	startDir: string,
	exists: (path: string) => boolean = existsSync,
): string | undefined {
	let dir = resolve(startDir);
	for (let level = 0; level < MAX_PROJECT_WALK_LEVELS; level += 1) {
		const candidate = join(dir, ".mcp.json");
		if (exists(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir || parent === parsePath(dir).root) return undefined;
		dir = parent;
	}
	return undefined;
}

export function loadMcpConfig(options: LoadMcpConfigOptions): McpConfigLoadResult {
	const env = options.env ?? process.env;
	const globalPath = options.globalConfigPath ?? globalMcpConfigPath(options.homeDir);
	const projectPath = findProjectMcpConfigPath(options.cwd);

	const servers = new Map<string, McpServerConfig>();
	const issues: McpConfigIssue[] = [];
	const sources: string[] = [];

	// 先全局后项目：后写入的同名条目覆盖先前的，正好是「项目赢」的语义。
	for (const path of [globalPath, projectPath]) {
		if (!path || !existsSync(path)) continue;
		sources.push(path);
		const parsed = readConfigFile(path, issues);
		if (!parsed) continue;
		for (const [name, entry] of parsed) {
			const normalized = normalizeServerEntry(name, entry, path, env, issues);
			if (normalized) servers.set(name, normalized);
		}
	}

	return { servers: [...servers.values()], sources, issues };
}

/** 读一个配置文件，返回 `[name, rawEntry]` 列表；文件坏了只记 issue 不抛。 */
function readConfigFile(path: string, issues: McpConfigIssue[]): Array<[string, unknown]> | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		issues.push({ source: path, message: `无法读取：${error instanceof Error ? error.message : String(error)}` });
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		issues.push({ source: path, message: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` });
		return undefined;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		issues.push({ source: path, message: "顶层必须是对象" });
		return undefined;
	}

	const servers = (parsed as { mcpServers?: unknown }).mcpServers;
	if (servers === undefined) {
		issues.push({ source: path, message: '缺少 "mcpServers" 字段' });
		return undefined;
	}
	if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
		issues.push({ source: path, message: '"mcpServers" 必须是对象' });
		return undefined;
	}

	// 保留文件里的书写顺序，状态输出才稳定。
	return Object.entries(servers as Record<string, unknown>);
}

/**
 * 把一个原始条目录入归一化成 McpServerConfig。
 *
 * 判别方式：有 `url` 就是远程（streamable HTTP，或 `type: "sse"` 的旧版 SSE），
 * 有 `command` 就是 stdio。两个都有 / 都没有都是配置错误，报 issue 并跳过。
 */
export function normalizeServerEntry(
	name: string,
	raw: unknown,
	source: string,
	env: NodeJS.ProcessEnv,
	issues: McpConfigIssue[] = [],
): McpServerConfig | undefined {
	const fail = (message: string): undefined => {
		issues.push({ source, server: name, message });
		return undefined;
	};

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return fail("server 条目必须是对象");
	}
	const entry = raw as Record<string, unknown>;

	const rawType = typeof entry.type === "string" ? entry.type.toLowerCase() : undefined;
	const enabled = entry.enabled !== false && entry.disabled !== true;
	const timeoutMs = normalizeTimeout(entry.timeout ?? entry.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
	const hasUrl = typeof entry.url === "string" && entry.url.trim() !== "";
	const hasCommand = typeof entry.command === "string" && entry.command.trim() !== "";

	if (rawType === "sse") {
		if (!hasUrl) return fail('type: "sse" 需要 "url"');
		return {
			name,
			transport: "sse",
			url: expandString(entry.url as string, env, { source, server: name }, issues),
			headers: normalizeStringRecord(entry.headers, env, { source, server: name }, issues),
			...normalizeHeadersCommand(entry, env, { source, server: name }, issues),
			timeoutMs,
			enabled,
			source,
		};
	}

	if (hasUrl) {
		return {
			name,
			transport: "http",
			url: expandString(entry.url as string, env, { source, server: name }, issues),
			headers: normalizeStringRecord(entry.headers, env, { source, server: name }, issues),
			...normalizeHeadersCommand(entry, env, { source, server: name }, issues),
			timeoutMs,
			enabled,
			source,
		};
	}

	if (hasCommand) {
		if (hasHeadersCommand(entry)) {
			issues.push({
				source,
				server: name,
				message: "headersCommand/headersHelper 只对 http/sse 服务器有效，stdio 已忽略",
			});
		}
		const args = Array.isArray(entry.args)
			? entry.args.map((value, index) => {
					if (typeof value !== "string") {
						issues.push({ source, server: name, message: `args[${index}] 必须是字符串，已跳过` });
						return undefined;
					}
					return expandString(value, env, { source, server: name }, issues);
				}).filter((value): value is string => value !== undefined)
			: [];
		const cwdRaw = typeof entry.cwd === "string" && entry.cwd.trim() !== "" ? entry.cwd : undefined;
		return {
			name,
			transport: "stdio",
			command: expandString(entry.command as string, env, { source, server: name }, issues),
			args,
			env: normalizeStringRecord(entry.env, env, { source, server: name }, issues),
			cwd: cwdRaw ? expandString(cwdRaw, env, { source, server: name }, issues) : undefined,
			timeoutMs,
			enabled,
			source,
		};
	}

	if (rawType === "stdio" || rawType === "local") return fail('需要 "command"');
	return fail('需要 "command"（stdio）或 "url"（http/sse）');
}

function normalizeTimeout(raw: unknown, fallback: number): number {
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	if (typeof raw === "string" && /^\d+$/.test(raw)) {
		const parsed = Number(raw);
		if (parsed > 0) return parsed;
	}
	return fallback;
}

/**
 * 三个别名都认：`headersCommand`（本扩展自己的名字）、`headersHelper`（Claude Code）、
 * `http_headers_helper`（Codex）。用户从别的客户端拷配置过来时不用改字段名。
 */
function hasHeadersCommand(entry: Record<string, unknown>): boolean {
	return readHeadersCommandRaw(entry) !== undefined;
}

function readHeadersCommandRaw(entry: Record<string, unknown>): unknown {
	for (const key of ["headersCommand", "headersHelper", "http_headers_helper"]) {
		const value = entry[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return undefined;
}

function normalizeHeadersCommand(
	entry: Record<string, unknown>,
	env: NodeJS.ProcessEnv,
	context: { source: string; server: string },
	issues: McpConfigIssue[],
): { headersCommand?: string; headersCommandTimeoutMs: number } {
	const raw = readHeadersCommandRaw(entry);
	return {
		headersCommand:
			typeof raw === "string" ? expandString(raw, env, context, issues) : undefined,
		headersCommandTimeoutMs: normalizeTimeout(entry.headersCommandTimeout, DEFAULT_HEADERS_COMMAND_TIMEOUT_MS),
	};
}

function normalizeStringRecord(
	raw: unknown,
	env: NodeJS.ProcessEnv,
	context: { source: string; server: string },
	issues: McpConfigIssue[],
): Record<string, string> {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) {
		issues.push({ ...context, message: "env/headers 必须是字符串到字符串的对象" });
		return {};
	}
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value !== "string") {
			issues.push({ ...context, message: `${key} 的值必须是字符串，已跳过` });
			continue;
		}
		result[key] = expandString(value, env, context, issues);
	}
	return result;
}

/**
 * 展开 `${VAR}` / `${VAR:-默认值}`。
 *
 * 未定义的变量**原样保留**（`${TOKEN}` 还是 `${TOKEN}`），同时记一条 issue：让它带着原文
 * 去 spawn/请求，错误信息里能看见到底缺哪个变量；静默展开成空串更难查。
 */
export function expandString(
	value: string,
	env: NodeJS.ProcessEnv,
	context: { source: string; server: string },
	issues: McpConfigIssue[] = [],
): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name: string, fallback?: string) => {
		const resolved = env[name];
		if (resolved !== undefined && resolved !== "") return resolved;
		if (fallback !== undefined) return fallback;
		issues.push({ ...context, message: `环境变量 ${name} 未定义（保留 ${match} 原文）` });
		return match;
	});
}
