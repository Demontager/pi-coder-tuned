/**
 * fenceless-code-block — drop the fences around Markdown code blocks (no
 * background)
 *
 * This file only wires things up: pi-tui's measure / wrap functions are handed
 * to `render.ts`'s pure logic. The prototype patch itself is in
 * `installFencelessCodeBlocks` — why a prototype patch is required, and why it
 * lands (bundle-inlined vs the loader's virtualModules), are in `render.ts`'s
 * file header.
 *
 * Only the fences: the code body keeps pi's own `mdCodeBlock` foreground — no
 * background, no touching the quote block's gutter, no changing the trailing
 * padding (that is `Markdown.render()`'s own business). So no `ctx` is needed
 * and no events are registered — the patch is installed at module-eval time.
 *
 * `PI_FENCELESS_CODE=off` disables it (same convention as `PI_LOGO=off`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { installFencelessCodeBlocks } from "./render.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_FENCELESS_CODE === "off") return;

	installFencelessCodeBlocks({
		Markdown,
		measure: visibleWidth,
		wrap: wrapTextWithAnsi,
	});
}
