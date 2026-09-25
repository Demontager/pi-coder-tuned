/**
 * mcp — 让 pi 用上本机 / 远程的 MCP 服务器（stdio、streamable HTTP、旧版 SSE）。
 *
 * 设计取舍（对齐用户「最简单够用」的要求）：
 *   - **每个 MCP 工具直接注册成一个 pi 工具**，名字 `mcp__<server>__<tool>`（Claude Code 同款），
 *     不走「一个 mcp 代理工具 + 参数指定 server/tool」那套（pi-mcp-adapter 的做法）——
 *     工具少时直连对模型友好得多，代价只是 system prompt 变长。
 *   - **配置沿用 Claude Code 的 `.mcp.json` 形状**，全局 `~/.pi/agent/mcp.json` + 项目
 *     `.mcp.json`（项目同名覆盖全局）。用户已有的 `.mcp.json` 抄一份即可。
 *   - **会话开始时连接、会话结束断开**。工具表必须先 `tools/list` 才能注册，所以不能等到
 *     首次调用才连；多个 server 并行握手，单个 server 失败只影响它自己。
 *   - 诊断信息（子进程 stderr、协议异常）**只进内存环形缓冲**，不写 stdout/stderr ——
 *     interactive pi 里往 stderr 写会糊在输入框上（见仓库里 subagent-log-guard 的存在理由）。
 *     要看就用 `/mcp` 或 `/mcp <server>`。
 *
 * 命令：
 *   /mcp            当前 server / 工具 / 配置来源一览
 *   /mcp reload     重新读配置、重连、重注册工具（改完 mcp.json 不用重启 pi）
 *   /mcp <server>   单个 server 的详情与最近诊断输出
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { McpClient, type McpToolInfo } from "./client.ts";
import { loadMcpConfig, type McpConfigIssue, type McpServerConfig } from "./config.ts";
import { McpConnectionError, McpError } from "./protocol.ts";
import {
	mcpContentToPiContent,
	normalizeInputSchema,
	piToolName,
	toolDescription,
	toolPromptSnippet,
	truncateText,
	type PiToolContent,
} from "./tools.ts";

/** 每个 server 保留多少行诊断信息（stderr / 协议异常）。 */
const DIAGNOSTIC_KEEP_LINES = 20;

type ServerStatus = "ready" | "disabled" | "error";

interface ServerState {
	config: McpServerConfig;
	status: ServerStatus;
	client?: McpClient;
	tools: McpToolInfo[];
	error?: string;
	diagnostics: string[];
}

interface McpRuntime {
	cwd: string;
	sources: string[];
	issues: McpConfigIssue[];
	servers: ServerState[];
}

let runtime: McpRuntime | undefined;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await stopRuntime();
		runtime = await startRuntime(pi, ctx);
		const failures = runtime.servers.filter((server) => server.status === "error");
		const problems = failures.length + runtime.issues.length;
		if (problems > 0) {
			const ready = runtime.servers.filter((server) => server.status === "ready").length;
			const detail = [
				`MCP：${runtime.servers.length} servers, ${ready} ready`,
				...failures.map((server) => `${server.config.name}: ${server.error ?? "connection failed"}`),
				...runtime.issues.map((issue) => `${issue.server ?? issue.source}: ${issue.message}`),
				"Use /mcp for details",
			].join("\n");
			ctx.ui.notify(detail, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		await stopRuntime();
	});

	pi.registerCommand("mcp", {
		description: "MCP server status; /mcp reload reconnects; /mcp <server> shows server details",
		handler: async (args, ctx) => {
			const argument = args.trim();
			if (argument === "reload") {
				if (runtime) ctx.ui.notify(`Reconnecting ${runtime.servers.length} MCP servers…`, "info");
				await stopRuntime();
				runtime = await startRuntime(pi, ctx);
				ctx.ui.notify(formatStatus(runtime, ctx), runtimeHasProblems(runtime) ? "warning" : "info");
				return;
			}
			if (!runtime) {
				ctx.ui.notify("MCP is not initialized (no usable configuration at session start)", "warning");
				return;
			}
			if (argument) {
				const server = runtime.servers.find((candidate) => candidate.config.name === argument);
				if (!server) {
					ctx.ui.notify(`No MCP server named "${argument}". Use /mcp to list configured servers.`, "warning");
					return;
				}
				ctx.ui.notify(formatServerDetail(server), server.status === "error" ? "error" : "info");
				return;
			}
			ctx.ui.notify(formatStatus(runtime, ctx), runtimeHasProblems(runtime) ? "warning" : "info");
		},
	});
}

async function startRuntime(pi: ExtensionAPI, ctx: ExtensionContext): Promise<McpRuntime> {
	const loaded = loadMcpConfig({ cwd: ctx.cwd });
	const servers: ServerState[] = loaded.servers.map((config) => ({
		config,
		status: config.enabled ? "error" : "disabled",
		tools: [],
		error: config.enabled ? undefined : "Disabled in configuration (enabled: false)",
		diagnostics: [],
	}));

	const enabled = servers.filter((server) => server.config.enabled);
	// connectServer 只写状态、不抛异常：一个 server 挂了不能影响其它 server 和 pi 本体。
	await Promise.all(enabled.map((server) => connectServer(pi, server)));

	return { cwd: ctx.cwd, sources: loaded.sources, issues: loaded.issues, servers };
}

async function connectServer(pi: ExtensionAPI, state: ServerState): Promise<void> {
	const { config } = state;
	try {
		const client = await McpClient.connect(config, {
			onDiagnostic: (line) => {
				state.diagnostics.push(line);
				if (state.diagnostics.length > DIAGNOSTIC_KEEP_LINES) state.diagnostics.shift();
			},
		});
		state.client = client;
		state.tools = await client.listTools();
		state.status = "ready";
		state.error = undefined;
		registerTools(pi, state);
	} catch (error) {
		state.status = "error";
		state.error = describeError(error);
	}
}

/**
 * 把一个 MCP server 的工具全部注册成 pi 工具。
 *
 * 同名覆盖是 pi 的行为（`extension.tools` 是 Map），所以 `/mcp reload` 重复注册不会留下旧定义。
 */
function registerTools(pi: ExtensionAPI, state: ServerState): void {
	const { config } = state;
	for (const tool of state.tools) {
		const name = piToolName(config.name, tool.name);
		pi.registerTool({
			name,
			label: `MCP: ${tool.name}`,
			description: toolDescription(config.name, tool),
			promptSnippet: toolPromptSnippet(tool.description),
			// MCP 给的是标准 JSON Schema；Type.Unsafe 让 pi 原样用它做参数校验。
			parameters: Type.Unsafe(normalizeInputSchema(tool.inputSchema)),
			async execute(_toolCallId, params, signal) {
				const client = state.client;
				if (!client || client.isClosed) {
					throw new Error(
						`MCP server "${config.name}" is not connected${state.error ? `（${state.error}）` : ""}. Run /mcp reload to reconnect.`,
					);
				}
				const started = Date.now();
				const args = (params ?? {}) as Record<string, unknown>;
				const result = await client.callTool(tool.name, args, { signal });
				const mapped = mcpContentToPiContent(result.content);
				const truncated = truncateText(mapped.text);
				const durationMs = Date.now() - started;
				const content = buildToolContent(mapped.content, truncated.text, truncated.truncated);

				if (result.isError) {
					throw new Error(
						`MCP tool ${config.name}/${tool.name} returned an error:
${truncated.text || "(no output)"}`,
					);
				}

				return {
					content,
					details: {
						server: config.name,
						tool: tool.name,
						durationMs,
						truncated: truncated.truncated,
						totalBytes: truncated.totalBytes,
						totalLines: truncated.totalLines,
						notes: mapped.notes,
					},
				};
			},
		});
	}
}

/**
 * 截断只作用于文本：图片块必须原样留下。
 * 未截断时保持 MCP 给的块顺序（文本与图片的相对位置有意义），截断时退化成「一段文本 + 图片」。
 */
function buildToolContent(blocks: PiToolContent[], truncatedText: string, truncated: boolean): PiToolContent[] {
	if (blocks.length === 0) return [{ type: "text", text: "(MCP tool returned empty content)" }];
	if (!truncated) return blocks;
	return [{ type: "text", text: truncatedText }, ...blocks.filter((block) => block.type === "image")];
}

async function stopRuntime(): Promise<void> {
	const current = runtime;
	runtime = undefined;
	if (!current) return;
	await Promise.all(current.servers.map((server) => server.client?.close().catch(() => {})));
}

function runtimeHasProblems(rt: McpRuntime): boolean {
	return rt.issues.length > 0 || rt.servers.some((server) => server.status === "error");
}

function formatStatus(rt: McpRuntime, ctx: ExtensionContext): string {
	const ready = rt.servers.filter((server) => server.status === "ready");
	const toolCount = ready.reduce((total, server) => total + server.tools.length, 0);
	const lines: string[] = [`MCP：${ready.length}/${rt.servers.length} servers ready, ${toolCount} tools total`];
	if (rt.servers.length === 0) {
		lines.push(`(No configuration found. Create ~/.pi/agent/mcp.json or .mcp.json in the project root, then run /mcp reload)`);
	}
	for (const server of rt.servers) {
		const mark = server.status === "ready" ? "●" : server.status === "disabled" ? "○" : "✗";
		const parts: string[] = [];
		if (server.client) {
			parts.push(shortTransport(server.config));
			parts.push(`v${server.client.serverInfo.version ?? "?"}`);
		}
		if (server.status === "ready") parts.push(`${server.tools.length} tools`);
		if (server.config.transport !== "stdio" && server.config.headersCommand) parts.push("headersCommand");
		if (server.status === "error" && server.error) parts.push(firstLine(server.error));
		lines.push(`${mark} ${server.config.name}${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`);
	}
	for (const issue of rt.issues) {
		lines.push(`⚠ ${issue.server ? `${issue.server}: ` : ""}${issue.message}${issue.server ? "" : ` (${issue.source})`}`);
	}
	if (rt.sources.length > 0) lines.push(`Configuration: ${rt.sources.join("  ")}`);
	lines.push(`Working directory: ${rt.cwd}`);
	return lines.join("\n");
}

function formatServerDetail(server: ServerState): string {
	const lines: string[] = [];
	lines.push(`${server.config.name}（${server.config.transport}，${server.status}）`);
	const client = server.client;
	if (client) {
		lines.push(`server: ${client.serverInfo.name ?? "?"} ${client.serverInfo.version ?? ""} · protocol ${client.protocolVersion}`);
		lines.push(`Connection: ${client.transportLabel}`);
		lines.push(`Capabilities: ${Object.keys(client.capabilities).join(", ") || "(none)"}`);
	}
	if (server.error) lines.push(`Error: ${server.error}`);
	if (server.config.transport !== "stdio" && server.config.headersCommand) {
		// 只展示命令本身（用户自己写的配置），头的**值**任何情况下都不打印。
		const command = server.config.headersCommand;
		lines.push(`Header command: ${command.length > 100 ? `${command.slice(0, 100)}…` : command}`);
	}
	if (server.tools.length > 0) {
		lines.push(`Tools (${server.tools.length}）:`);
		for (const tool of server.tools) {
			const short = tool.description?.replace(/\s+/g, " ").slice(0, 60) ?? "";
			lines.push(`  mcp__${server.config.name}__${tool.name}${short ? ` — ${short}` : ""}`);
		}
	}
	if (server.diagnostics.length > 0) {
		lines.push(`Recent diagnostics (${server.diagnostics.length} lines):`);
		for (const line of server.diagnostics.slice(-8)) lines.push(`  ${firstLine(line).slice(0, 160)}`);
	}
	return lines.join("\n");
}

function describeError(error: unknown): string {
	if (error instanceof McpConnectionError) return error.message;
	if (error instanceof McpError) return `${error.message}（code ${error.code}）`;
	if (error instanceof Error) return error.message;
	return String(error);
}

function firstLine(text: string): string {
	const index = text.indexOf("\n");
	return index === -1 ? text : text.slice(0, index);
}

/** 状态行里的短传输标识：stdio 只写 "stdio"，完整命令留给 `/mcp <server>` 与报错信息。 */
function shortTransport(config: McpServerConfig): string {
	return config.transport === "stdio" ? "stdio" : `${config.transport} ${config.url}`;
}
