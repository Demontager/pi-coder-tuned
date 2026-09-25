/** Cache-safe recap policy. Pure functions; no provider calls or session writes. */
export function usesLocalRecap(model: { provider?: string; baseUrl?: string }, mode = process.env.PI_RECAP_MODE): boolean {
	if (mode === "extract") return true;
	if (mode === "model") return false;
	if (model.provider === "llama-local") return true;
	try {
		const url = new URL(model.baseUrl ?? "");
		return ["http:", "https:"].includes(url.protocol) &&
			(url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./.test(url.hostname));
	} catch {
		return false;
	}
}

export function extractLocalRecap(entries: readonly unknown[], maxChars = 120): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as any;
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "user") return "";
		if (message?.role !== "assistant") continue;
		if (["error", "aborted", "toolUse"].includes(message.stopReason)) return "";
		if (Array.isArray(message.content) && message.content.some((block: any) => block?.type === "toolCall")) return "";
		const raw = typeof message.content === "string" ? message.content :
			Array.isArray(message.content) ? message.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("\n") : "";
		if (!raw.trim()) return "";
		let fence: string | undefined;
		const lines: string[] = [];
		for (const line of raw.replace(/<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi, "").split(/\r?\n/)) {
			const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
			if (marker) {
				if (!fence) fence = marker;
				else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
				continue;
			}
			if (fence || /^\s*(?:#{1,6}\s|\||[-*_]{3,}\s*$)/.test(line)) continue;
			const cleaned = line.replace(/^\s*(?:[-*+] |\d+[.)]\s+)/, "")
				.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
				.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").trim();
			if (cleaned) lines.push(cleaned);
		}
		const text = lines.join(" ").replace(/\s+/g, " ").trim() || "Latest response contains code or structured output; see the answer above.";
		const characters = [...text];
		return characters.length <= maxChars ? text : `${characters.slice(0, maxChars - 1).join("").trimEnd()}…`;
	}
	return "";
}
