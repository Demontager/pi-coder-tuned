/**
 * headers-command.ts — 动态请求头：跑一条命令、把它的输出解析成 HTTP 头。
 *
 * 这是 OAuth 的"便宜档"（对标 Claude Code 的 `headersHelper`、Codex 的 `http_headers_helper`）：
 * 很多 SaaS MCP 既支持 OAuth，也支持静态 token 走 header（GitHub PAT、Context7 的 `CONTEXT7_API_KEY`、
 * Sentry / Figma 的 token）。与其为一个 header 实现整套 OAuth 2.1 + 发现 + DCR + 回调，
 * 不如让用户写一条命令把 token 取出来 —— 命令自己去读钥匙串、跑 `opencode auth`、解密文件都行。
 *
 * 设计边界：
 *   - **不 import pi**（与 config/protocol/tools/client 一致），所以能直接 `node --test`。
 *   - **绝不记录头的值**：诊断只输出头的名字（见 `describeHeaderNames`）。命令的输出可能整段都是密钥，
 *     解析失败时也不回显原文 —— 只报"解析失败 + 前 N 字节的形状提示"，避免把 token 写进日志。
 *   - 失败**不致命**：命令挂了就退回静态 headers 继续连，把失败记进诊断；真被 401 时错误信息里会带上
 *     这条失败原因，用户才知道该去修命令，而不是以为 token 不对。
 */

import { exec } from "node:child_process";

/** 头命令默认超时：只是取个 token，不该像工具调用那样等两分钟。 */
export const DEFAULT_HEADERS_COMMAND_TIMEOUT_MS = 10_000;

/** 命令输出的采集上限：正常就几十字节，超过这个量级说明命令写错了。 */
const MAX_OUTPUT_BYTES = 64 * 1024;

/** HTTP 头名允许的字符（RFC 7230 token）。 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface HeadersCommandSpec {
	command: string;
	timeoutMs?: number;
	/** 覆盖工作目录（默认继承当前进程）。 */
	cwd?: string;
	env?: Record<string, string>;
}

export interface ResolvedHeaders {
	/** 解析出来的动态头（可能为空 —— 命令成功但没输出头）。 */
	headers: Record<string, string>;
	/** 命令原始输出里出现过的头名，用于诊断（不含值）。 */
	names: string[];
	/** 非致命问题（被丢掉的头、格式提示等）。 */
	warnings: string[];
}

/**
 * 运行头命令并解析结果。失败（超时/非零退出/输出不可解析）时抛错，由调用方决定降级策略。
 */
export async function resolveCommandHeaders(
	spec: HeadersCommandSpec,
	options: { signal?: AbortSignal } = {},
): Promise<ResolvedHeaders> {
	const stdout = await runCommand(spec, options.signal);
	const parsed = parseHeadersOutput(stdout);
	return { headers: parsed.headers, names: Object.keys(parsed.headers), warnings: parsed.warnings };
}

function runCommand(spec: HeadersCommandSpec, signal?: AbortSignal): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		// 刻意**不** unref：这条命令是我们正在等的结果，子进程必须把事件循环钉住直到它结束
		// （unref 会让 `pi -p` / probe 这类短命进程先退出，promise 永远不 resolve —— 单测当场拦到过）。
		// 挂死风险由 exec 的 timeout 堵住。
		exec(
			spec.command,
			{
				timeout: spec.timeoutMs ?? DEFAULT_HEADERS_COMMAND_TIMEOUT_MS,
				maxBuffer: MAX_OUTPUT_BYTES,
				cwd: spec.cwd,
				env: spec.env ? { ...process.env, ...spec.env } : process.env,
				signal,
			},
			(error, stdout, stderr) => {
				if (error) {
					const timedOut = (error as { killed?: boolean }).killed === true;
					const detail = stderr.trim() ? `：${firstLine(stderr.trim())}` : "";
					reject(
						new Error(
							timedOut
								? `头命令超时（${spec.timeoutMs ?? DEFAULT_HEADERS_COMMAND_TIMEOUT_MS}ms）`
								: `头命令退出码非 0${detail}`,
						),
					);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

/**
 * 解析命令输出。
 *
 * 接受三种形状（前两种是各家客户端的契约，第三种是最省事的手写形式）：
 *   1. 扁平 JSON 对象：`{"Authorization": "Bearer x"}`
 *   2. 带 `headers` 包装的 JSON：`{"headers": {"Authorization": "Bearer x"}}`
 *   3. `Name: Value` 行（每行一个头）
 *
 * 非字符串值、空值、非法头名一律丢弃并记 warning —— 丢弃比报错好，因为命令可能同时输出
 * 一堆无关字段（比如 `{...token, "expires_in": 3600}`），为此整条命令失败太苛刻。
 */
export function parseHeadersOutput(raw: string): { headers: Record<string, string>; warnings: string[] } {
	const warnings: string[] = [];
	const text = raw.trim();
	if (!text) return { headers: {}, warnings };

	const fromJson = tryParseJsonHeaders(text, warnings);
	if (fromJson) return { headers: fromJson, warnings };

	const fromLines = tryParseHeaderLines(text, warnings);
	if (fromLines) return { headers: fromLines, warnings };

	throw new Error(
		`头命令输出无法解析为请求头（${Buffer.byteLength(text, "utf8")} 字节；内容已省略以免泄露密钥）`,
	);
}

function tryParseJsonHeaders(text: string, warnings: string[]): Record<string, string> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

	const record = parsed as Record<string, unknown>;
	const nested = record.headers;
	const source =
		typeof nested === "object" && nested !== null && !Array.isArray(nested)
			? (nested as Record<string, unknown>)
			: record;

	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (typeof value !== "string") {
			// 数字/bool（如 expires_in）很常见，静默丢弃；对象/数组说明写错了，提一句。
			if (typeof value === "object" && value !== null) warnings.push(`头 ${name} 的值不是字符串，已丢弃`);
			continue;
		}
		if (value.trim() === "") {
			warnings.push(`头 ${name} 的值为空，已丢弃`);
			continue;
		}
		if (!HEADER_NAME_PATTERN.test(name)) {
			warnings.push(`头名 ${name} 含非法字符，已丢弃`);
			continue;
		}
		headers[name] = value;
	}
	return headers;
}

function tryParseHeaderLines(text: string, warnings: string[]): Record<string, string> | undefined {
	const headers: Record<string, string> = {};
	let matched = 0;
	for (const line of text.split("\n")) {
		const trimmedLine = line.trim();
		if (!trimmedLine) continue;
		const colon = trimmedLine.indexOf(":");
		if (colon <= 0) return undefined;
		const name = trimmedLine.slice(0, colon).trim();
		const value = trimmedLine.slice(colon + 1).trim();
		if (!HEADER_NAME_PATTERN.test(name)) return undefined;
		matched += 1;
		if (!value) {
			warnings.push(`头 ${name} 的值为空，已丢弃`);
			continue;
		}
		headers[name] = value;
	}
	return matched > 0 ? headers : undefined;
}

/** 合并静态与动态头：动态（命令取来的）覆盖静态，因为它是更新鲜的凭据。 */
export function mergeHeaders(
	base: Record<string, string>,
	dynamic: Record<string, string>,
): Record<string, string> {
	return { ...base, ...dynamic };
}

/**
 * 头名的可读列表（**永远不要把值放进来**）。
 *
 * Authorization 这类头只暴露名字，诊断输出才能安全地贴到 `/mcp <server>` 或日志里。
 */
export function describeHeaderNames(headers: Record<string, string>): string {
	const names = Object.keys(headers);
	return names.length > 0 ? names.join(", ") : "(无)";
}

/** 用于判断"重跑命令后头有没有变化"：只有变了才值得重试一次请求。 */
export function headersSignature(headers: Record<string, string>): string {
	return Object.keys(headers)
		.sort()
		.map((name) => `${name}:${headers[name]}`)
		.join("\n");
}

function firstLine(text: string): string {
	const index = text.indexOf("\n");
	return index === -1 ? text : text.slice(0, index);
}
