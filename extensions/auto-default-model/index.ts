/**
 * auto-default-model — on every model switch, also write it as the "startup
 * default model", saving the extra Ctrl+S.
 *
 * Why it exists: pi's `/model` picker **changes only the current session's**
 * model; making a model stick across restarts takes an extra Ctrl+S
 * (`app.models.save` → `setModel(model, {persist: true})` →
 * `settingsManager.setDefaultModelAndProvider`, writing
 * `~/.pi/agent/settings.json`'s `defaultProvider` / `defaultModel`). This is
 * deliberate upstream behavior (CHANGELOG: "Fixed `/model` and `/thinking`
 * selections being persisted globally unless explicitly saved with Ctrl+S")
 * — but on a single-user machine it is needless ceremony: the Ctrl+S is
 * easily forgotten and the next launch is back on the old model.
 * This extension automates the step — every model switch (the `/model`
 * picker, Ctrl+P cycling, `pi.setModel()` calls like pi-subagents's profile
 * switching) persists immediately.
 *
 * Persistence goes through **pi's own public API** (`SettingsManager`,
 * imported from `@earendil-works/pi-coding-agent` — the loader's alias /
 * virtualModules mapping means an on-demand import here gets pi's own
 * implementation) — the very same path Ctrl+S takes:
 * `FileSettingsStorage` + proper-lockfile locking + a read-modify-write that
 * merges only the changed fields into the latest on-disk content. So ① other
 * settings.json fields (incl. future ones this extension does not know) are
 * never clobbered, and ② it shares one lock with pi's own writes — no lost
 * updates. **Deliberately not `fs.writeFile`-ing ourselves**: that would
 * bypass the lock and lose whatever `/theme` or `/settings` just wrote
 * concurrently.
 *
 * Three deliberate tradeoffs:
 *   - `source === "restore"` **does not persist**. Resuming a session pulls
 *     its model back — "opening an old session", not "I switched models" —
 *     letting it rewrite the global default would be surprising.
 *     (pi 0.85.1 only emits `model_select` from `setModel()` / `cycleModel()`
 *     — restore sets `agent.state.model` directly — so this branch cannot
 *     trigger on the current version; it is written so the semantics stay
 *     explicit once pi wires `restore` up.)
 *   - an unchanged value is never written. `model_select` also fires when
 *     the same model is re-picked, or pi persisted already (Ctrl+S, the
 *     auto-picked provider default after `/login`) — a repeat write only
 *     dirties settings.json for nothing.
 *   - notify only on failure (`ctx.ui.notify`) — never on success: the
 *     current model name already shows on the statusline; a notice on every
 *     switch is noise.
 *
 * Disable: `PI_AUTO_DEFAULT_MODEL=off` (read on every switch, not cached).
 */

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ModelSelectEvent } from "@earendil-works/pi-coding-agent";

type PersistOutcome = "written" | "unchanged" | "failed";
type PersistResult = { outcome: PersistOutcome; detail?: string };

function isDisabled(): boolean {
	return (process.env.PI_AUTO_DEFAULT_MODEL ?? "").trim().toLowerCase() === "off";
}

function modelLabel(event: ModelSelectEvent): string {
	return `${event.model.provider}/${event.model.id}`;
}

function notify(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
}

/**
 * Write `provider/modelId` as the global startup default. "unchanged" means
 * it already is on disk.
 */
async function persistAsStartupDefault(cwd: string, provider: string, modelId: string): Promise<PersistResult> {
	const settings = SettingsManager.create(cwd);
	// compare against the **global** settings, not the merged values: a project-level `.pi/settings.json`'s defaultProvider /
	// defaultModel overrides the global (a startup path this extension cannot control) — comparing merged values would misjudge it as "already written".
	const global = settings.getGlobalSettings();
	if (global.defaultProvider === provider && global.defaultModel === modelId) {
		return { outcome: "unchanged" };
	}
	settings.setDefaultModelAndProvider(provider, modelId);
	await settings.flush();
	// when settings.json fails to parse or write, `save()` **silently skips** (`globalSettingsLoadError`
	// returns early, `enqueueWrite`'s catch only records) and `flush()` never throws — the outcome is only readable in
	// `drainErrors()`, or the extension would fake a successful write. The error text goes out too — a warning without it diagnoses nothing.
	const failure = settings.drainErrors()[0];
	if (failure) return { outcome: "failed", detail: failure.error.message };
	return { outcome: "written" };
}

export default function (pi: ExtensionAPI) {
	pi.on("model_select", async (event, ctx) => {
		if (isDisabled()) return;
		if (event.source === "restore") return;
		try {
			const result = await persistAsStartupDefault(ctx.cwd, event.model.provider, event.model.id);
			if (result.outcome === "failed") {
				notify(ctx, `${modelLabel(event)} could not be saved as the startup default model: ${result.detail ?? "could not read or write settings.json"}`);
			}
		} catch (error) {
			notify(ctx, `Failed to save the startup default model: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
