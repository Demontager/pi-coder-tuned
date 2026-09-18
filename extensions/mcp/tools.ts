/**
 * tools.ts — MCP 工具 → pi 工具的纯映射层：命名、schema、结果内容、截断。
 *
 * 纯逻辑，不 import pi / 不 spawn 进程，所以 `node --test` 直接跑。pi 的注册动作全在 index.ts，
 * 这里只回答「这个名字怎么拼」「这段内容怎么给模型」。
 *
 * 命名采用 Claude Code 的 `mcp__<server>__<tool>`：用户的 skill 与权限规则都是按这个形状写的，
 * 换一套前缀只会让两边对不上。（pi-mcp-adapter 默认是 `<server>_<tool>`，我们在 `mcp__` 上
 * 更贴 Claude Code 的习惯。）
 *
 * 结果映射的两个必须遵守的约束：
 *   - pi 的 tool content 只认 `{type:"text"}` 与 `{type:"image", data, mimeType}`；
 *     MCP 的 `resource` / `resource_link` / `audio` 都得降级成文本说明，不能原样塞进去。
 *   - 工具输出必须截断：MCP 服务端（尤其是把整个 JSON 一次吐出来的实现）很容易给出
 *     超过上下文的体积。截断上限沿用 pi 内建工具的 50KB / 2000 行。
 */

/** MCP 的 image 内容块 → pi 的 ImageContent 形状。 */
export interface PiTextContent {
	type: "text";
	text: string;
}

export interface PiImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export type PiToolContent = PiTextContent | PiImageContent;

/** 工具名上限：Anthropic / OpenAI 的 tool 名都是 64 字符。 */
export const MAX_TOOL_NAME_LENGTH = 64;

/** 与 pi 内建工具一致的截断上限。 */
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2000;

export const MCP_TOOL_PREFIX = "mcp__";
export const TOOL_PREFIX_SEPARATOR = "__";

export interface McpToolDescriptor {
	name: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: Record<string, unknown>;
}

/**
 * `mcp__<server>__<tool>`，非法字符替换成 `_`。
 *
 * 超过 64 字符时截断工具名并接一个 6 位哈希后缀：名字要能被模型原样回传，截断后的
 * 冲突（两个长工具名截到同一段）靠哈希区分。哈希是 FNV-1a，只为消歧，不做安全用途。
 */
export function piToolName(serverName: string, toolName: string): string {
	const server = sanitizeSegment(serverName);
	const tool = sanitizeSegment(toolName);
	const full = `${MCP_TOOL_PREFIX}${server}${TOOL_PREFIX_SEPARATOR}${tool}`;
	if (full.length <= MAX_TOOL_NAME_LENGTH) return full;

	const hash = fnv1a(`${serverName}\u0000${toolName}`);
	const budget = MAX_TOOL_NAME_LENGTH - MCP_TOOL_PREFIX.length - server.length - TOOL_PREFIX_SEPARATOR.length - hash.length - 1;
	const head = tool.slice(0, Math.max(budget, 8));
	return `${MCP_TOOL_PREFIX}${server}${TOOL_PREFIX_SEPARATOR}${head}_${hash}`;
}

function sanitizeSegment(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_");
	return sanitized === "" ? "_" : sanitized;
}

function fnv1a(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0").slice(0, 6);
}

/**
 * 归一化 MCP 的 inputSchema，保证是一个合法的 `type: "object"` JSON Schema。
 *
 * 现实里的服务端会给出各种形状：缺 schema、`{}`、`{"properties": ...}` 没写 type、
 * 甚至直接是 `null`。pi 用这个 schema 校验参数，形状不对会让整次调用在下发前就失败 ——
 * 兜底成「无参数对象」最坏只是模型看不到参数提示，比调用被拒好。
 */
export function normalizeInputSchema(schema: unknown): Record<string, unknown> {
	const empty: Record<string, unknown> = { type: "object", properties: {} };
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return empty;
	const record = schema as Record<string, unknown>;
	const type = record.type;
	if (type !== undefined && type !== "object") return empty;
	return {
		type: "object",
		properties:
			typeof record.properties === "object" && record.properties !== null && !Array.isArray(record.properties)
				? record.properties
				: {},
		...(Array.isArray(record.required) ? { required: record.required } : {}),
		// 其余 JSON Schema 关键字（$defs / additionalProperties / oneOf ...）原样保留。
		...Object.fromEntries(
			Object.entries(record).filter(([key]) => !["type", "properties", "required"].includes(key)),
		),
	};
}

/** 给模型的工具描述：原文 + 注解提示（只读/破坏性）。 */
export function toolDescription(serverName: string, tool: McpToolDescriptor): string {
	const parts: string[] = [];
	if (tool.description?.trim()) parts.push(tool.description.trim());
	const hints = annotationHints(tool.annotations);
	const header = `MCP 工具（server: ${serverName}）${hints ? ` ${hints}` : ""}`;
	parts.push(header);
	return parts.join("\n\n");
}

function annotationHints(annotations: Record<string, unknown> | undefined): string {
	if (!annotations) return "";
	const hints: string[] = [];
	if (annotations.readOnlyHint === true) hints.push("只读");
	if (annotations.destructiveHint === true) hints.push("可能破坏数据");
	if (annotations.idempotentHint === true) hints.push("幂等");
	if (annotations.openWorldHint === true) hints.push("访问外部世界");
	return hints.length > 0 ? `[${hints.join(" / ")}]` : "";
}

/** 系统提示里的一行摘要（pi 的 `Available tools` 段）。 */
export function toolPromptSnippet(description: string | undefined): string | undefined {
	if (!description?.trim()) return undefined;
	const flat = description.replace(/\s+/g, " ").trim();
	return flat.length <= 100 ? flat : `${truncateAtWord(flat, 100)}…`;
}

function truncateAtWord(value: string, max: number): string {
	if (value.length <= max) return value;
	const slice = value.slice(0, max);
	const space = slice.lastIndexOf(" ");
	// CJK 里没有空格：切不到词就硬切，别把整段都丢掉。
	return space > max * 0.6 ? slice.slice(0, space) : slice;
}

export interface ContentMappingResult {
	content: PiToolContent[];
	/** 给 LLM 看的纯文本（文本块拼接；含图片时的占位说明）。 */
	text: string;
	/** 无法直传、被降级成文本说明的内容块（音频、二进制 resource 等）。 */
	notes: string[];
}

/**
 * MCP `tools/call` 的 content 数组 → pi 的 content 数组。
 *
 * 认得的形状：text / image / resource / resource_link。
 * 认不得的一律降级成一行文本说明 —— 宁可让模型看到「这里有个不支持的 X」，
 * 也不要静默丢掉内容（模型会以为自己没看到东西）。
 */
export function mcpContentToPiContent(content: unknown[]): ContentMappingResult {
	const blocks: PiToolContent[] = [];
	const notes: string[] = [];
	const texts: string[] = [];

	for (const raw of content) {
		if (typeof raw !== "object" || raw === null) {
			if (raw !== undefined && raw !== null) {
				const text = stringifyUnknown(raw);
				texts.push(text);
				blocks.push({ type: "text", text });
			}
			continue;
		}
		const block = raw as Record<string, unknown>;
		switch (block.type) {
			case "text": {
				const text = typeof block.text === "string" ? block.text : stringifyUnknown(block);
				texts.push(text);
				blocks.push({ type: "text", text });
				break;
			}
			case "image": {
				const image = toImageBlock(block);
				if (image) {
					blocks.push(image);
					texts.push(`[图片 ${image.mimeType}]`);
				} else {
					const note = "[图片缺少 data/mimeType，无法传给模型]";
					notes.push(note);
					texts.push(note);
					blocks.push({ type: "text", text: note });
				}
				break;
			}
			case "audio": {
				const note = `[音频内容（${typeof block.mimeType === "string" ? block.mimeType : "未知类型"}）无法直接传给模型]`;
				notes.push(note);
				texts.push(note);
				blocks.push({ type: "text", text: note });
				break;
			}
			case "resource": {
				const mapped = resourceToContent(block.resource);
				notes.push(...mapped.notes);
				texts.push(mapped.text);
				blocks.push(...mapped.content);
				break;
			}
			case "resource_link": {
				const uri = typeof block.uri === "string" ? block.uri : "(无 uri)";
				const name = typeof block.name === "string" ? block.name : undefined;
				const note = `[资源链接${name ? ` ${name}` : ""}: ${uri}]`;
				notes.push(note);
				texts.push(note);
				blocks.push({ type: "text", text: note });
				break;
			}
			default: {
				const note = `[不支持的 MCP 内容块 ${String(block.type)}: ${stringifyUnknown(block).slice(0, 200)}]`;
				notes.push(note);
				texts.push(note);
				blocks.push({ type: "text", text: note });
				break;
			}
		}
	}

	return { content: blocks, text: texts.join("\n"), notes };
}

function resourceToContent(rawResource: unknown): { content: PiToolContent[]; text: string; notes: string[] } {
	if (typeof rawResource !== "object" || rawResource === null) {
		const note = "[无效的 MCP resource 内容块]";
		return { content: [{ type: "text", text: note }], text: note, notes: [note] };
	}
	const resource = rawResource as Record<string, unknown>;
	const uri = typeof resource.uri === "string" ? resource.uri : "(无 uri)";
	const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : undefined;

	if (typeof resource.text === "string") {
		return {
			content: [{ type: "text", text: resource.text }],
			text: resource.text,
			notes: [],
		};
	}
	if (typeof resource.blob === "string") {
		const image = mimeType?.startsWith("image/")
			? toImageBlock({ data: resource.blob, mimeType })
			: undefined;
		if (image) {
			return { content: [image], text: `[图片 ${mimeType}]`, notes: [] };
		}
		const note = `[二进制资源 ${uri}（${mimeType ?? "未知类型"}，${formatBytes(Math.floor((resource.blob.length * 3) / 4))}）未传给模型]`;
		return { content: [{ type: "text", text: note }], text: note, notes: [note] };
	}
	const note = `[资源 ${uri} 没有 text/blob 内容]`;
	return { content: [{ type: "text", text: note }], text: note, notes: [note] };
}

function toImageBlock(block: Record<string, unknown>): PiImageContent | undefined {
	const data = typeof block.data === "string" ? block.data : undefined;
	const mimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
	if (!data || !mimeType) return undefined;
	return { type: "image", data, mimeType };
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		const json = JSON.stringify(value);
		return json === undefined ? String(value) : json;
	} catch {
		return String(value);
	}
}

export interface TruncateOptions {
	maxBytes?: number;
	maxLines?: number;
}

export interface TruncateResult {
	text: string;
	truncated: boolean;
	totalBytes: number;
	totalLines: number;
}

/**
 * 头截断：保留前 N 行 / 前 N 字节。
 *
 * 头截断而不是尾截断：MCP 工具返回的常见形态是一段 JSON 或一段列表，开头大概率是元信息
 * （消息数、分页游标、schema 名），比结尾更有价值。
 */
export function truncateText(text: string, options: TruncateOptions = {}): TruncateResult {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const totalBytes = Buffer.byteLength(text, "utf8");
	const totalLines = countLines(text);

	if (totalBytes <= maxBytes && totalLines <= maxLines) {
		return { text, truncated: false, totalBytes, totalLines };
	}

	let head = text;
	if (totalLines > maxLines) {
		const lines = text.split("\n", maxLines);
		head = lines.join("\n");
	}
	if (Buffer.byteLength(head, "utf8") > maxBytes) {
		head = Buffer.from(head, "utf8").subarray(0, maxBytes).toString("utf8");
		// 截在多字节字符中间时尾部会留一个替换字符，去掉它。
		if (head.endsWith("\uFFFD")) head = head.slice(0, -1);
	}

	const keptBytes = Buffer.byteLength(head, "utf8");
	return {
		text:
			`${head}\n\n[输出已截断：保留 ${formatBytes(keptBytes)} / ${totalBytes} 字节，` +
			`${countLines(head)} / ${totalLines} 行。需要完整内容请缩小查询范围（时间区间 / limit / 关键词）后重试。]`,
		truncated: true,
		totalBytes,
		totalLines,
	};
}

function countLines(text: string): number {
	if (text === "") return 0;
	let lines = 1;
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) === 10) lines += 1;
	}
	return lines;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
