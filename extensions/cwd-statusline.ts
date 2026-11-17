/**
 * cwd-statusline — show the current working directory (the full absolute path)
 * on its own row at the bottom of the statusline
 *
 * It emits an extension status via ctx.ui.setStatus(), rendered by the local
 * statusline extension (`extensions/statusline/`) on the second row below the
 * main row: that path goes through no path-compression rule, so the full pwd
 * is visible. Overflow only truncates to the terminal width with an ellipsis —
 * never wraps.
 *
 * History note: this row used to be rendered by the third-party
 * `npm:@narumitw/pi-statusline`. It trimmed the status text first, then split
 * off an icon by emoji — the `extensionStatusIcons.cwd = " 📁"` config was the
 * only way to control the leading indent; the current statusline extension
 * renders the status text verbatim (trimmed once, uniformly indented one
 * space) — so PI_CWD_ICON has the say.
 *
 * Tunable env vars:
 *   PI_CWD_STATUSLINE  set to off to disable this extension
 *   PI_CWD_ICON        the icon, default 📁
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "cwd";
const ICON = process.env.PI_CWD_ICON ?? " 📁";
const DISABLED = (process.env.PI_CWD_STATUSLINE ?? "").toLowerCase() === "off";

export default function (pi: ExtensionAPI) {
	if (DISABLED) return;

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		// the statusline extension renders the status text verbatim (trimmed once, indented one space),
		// so only "icon + space + absolute path" is sent here.
		ctx.ui.setStatus(STATUS_KEY, `${ICON} ${ctx.cwd}`);
	};

	// session_start: startup / new / resume / fork all trigger it — where the initial value is set
	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	// session_info_changed: a fallback refresh when the session's meta info changes
	pi.on("session_info_changed", async (_event, ctx) => refresh(ctx));
	// turn_start: refresh once per turn — the directory info always stays current
	pi.on("turn_start", async (_event, ctx) => refresh(ctx));
}
