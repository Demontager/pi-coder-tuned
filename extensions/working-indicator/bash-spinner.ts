/**
 * bash-spinner.ts — working 行尾「bash 执行中 `●`」的纯逻辑：形态、门槛、并发登记簿。
 *
 * 抽出来的理由与 `working-summary.ts` 相同：形态（`" ●"` 与等宽空格占位）、色槽、门槛与节拍
 * 常量，以及「多个 bash 并发时谁把标记撑住」这条状态机全是纯判定，不该活在 `index.ts` 的
 * 定时器与 `ctx.ui` 之间。本模块**不 import pi / pi-tui**，`node --test` 直接跑满每个分支
 * （用例见 `bash-spinner.test.ts`）；定时器那半边（什么时候闪、什么时候重绘）在扩展里。
 *
 * ## 需求
 *
 * 原文：把 `●` 挂在 `⠼ Tools Calling (13m 59s)` **后面**，bash 执行时长超过 1 秒后出现、
 * 执行结束后消失；多个 bash 同时在执行时，任意一个超过 1s 就闪，**所有** bash 都结束后才消失。
 * 于是：
 *   - 门槛与节拍沿用退役的 bash 首行 spinner（门槛 1s、亮 / 灭各 500ms），`●` 不再出现在
 *     bash 命令块里（那个首行 `$ ` → `● ` 的替换按需求撤销了）；
 *   - 「撑住」是**粘性**的（见 `BashRunTracker.markCrossed`）：只要有一个执行真的跨过门槛，
 *     标记就保持到**最后一个**执行结束 —— 否则「长命令结束、同批另一个还在跑」时标记会灭一下
 *     再亮，看着像闪断，也不符合「所有 bash 结束后才消失」。
 *
 * ## 形态恒 2 列
 *
 * 亮相位 `" ●"`（前导空格 + 标记）、灭相位两格空格：**恒 2 列、恒 2 字符、绝不返回空串**。
 * 灭相位要是空串，标记每 500ms 亮灭时行尾会少两列，`layoutPromptSummary` 算出的 gap 跟着
 * 变、右对齐的提示词摘要会左右蹦 —— 这就是 `tool-diff` 标题行 `●` 记下的那条教训。同理，
 * 标记段整段参与 `leftWidth`（在 `index.ts` 里拼进左段再交给布局），所以摘要位置不随亮灭移动。
 */

/** 出现门槛（毫秒）：执行时长达到它才开始闪 `●`。 */
export const BASH_SPINNER_DELAY_MS = 1000;
/** 亮 / 灭各占的毫秒数（与 tool-diff 的 `edit` / `write` 同节拍）。 */
export const BASH_SPINNER_BLINK_MS = 500;
/** 标记字符。1 列宽（`visibleWidth("●") === 1`，与 statusline / tool-diff 同源，已核对）。 */
export const BASH_SPINNER_MARKER = "●";
/** 标记段的可见宽度（= 字符数）：前导空格 1 列 + 标记 1 列。 */
export const BASH_SPINNER_WIDTH = 2;
/**
 * 主题色槽。用 `dim`（退役的 bash 首行 spinner 同一个槽位）：它比 working 行默认的 `muted`
 * 更沉，落在统计段之后是个「次要但可见」的活跃点，不跟正文抢注意力。
 */
export const BASH_SPINNER_COLOR = "dim";

/**
 * 标记段文本（**未上色**，上色在扩展里按 `BASH_SPINNER_COLOR` 做）。
 * `on` = 亮相位 → `" ●"`；灭相位 → 两格空格。两态等宽等字符数（见文件头）。
 */
export function bashSpinnerSuffix(on: boolean): string {
	return on ? ` ${BASH_SPINNER_MARKER}` : " ".repeat(BASH_SPINNER_WIDTH);
}

/**
 * 并发 bash 执行的登记簿：`toolCallId → 起始时刻`（`tool_execution_start` / `_end` 落账）。
 *
 * 三个入口各管一件事：`start` / `end` 记账、`markCrossed(now)` 观察门槛（并立起粘性标志）、
 * `armDelay(now)` 给「还没到门槛」那段时间算一次性定时器该等多久（让 `●` **准时**在门槛上
 * 出现，而不是等下一次别的重绘 —— 非流式命令执行期间可能一个上游事件都没有）。
 */
export class BashRunTracker {
	private readonly startedAt = new Map<string, number>();
	/** 本批执行里是否已经有谁跨过门槛（粘性，见文件头；登记簿清空时复位）。 */
	private crossed = false;

	/** 登记一个开始执行的 bash。 */
	start(toolCallId: string, now: number): void {
		this.startedAt.set(toolCallId, now);
	}

	/**
	 * 注销一个结束的 bash。**最后一个结束**时连同粘性标志一起复位 —— 标记要等所有执行都
	 * 结束才消失，且下一批 bash 得重新自己跨门槛，不继承上一批的。
	 */
	end(toolCallId: string): void {
		this.startedAt.delete(toolCallId);
		if (this.startedAt.size === 0) this.crossed = false;
	}

	/** 换回合 / 会话替换 / 旧 ctx：整本账清掉，标记立刻消失。 */
	clear(): void {
		this.startedAt.clear();
		this.crossed = false;
	}

	/** 当前有几个 bash 在执行。 */
	get size(): number {
		return this.startedAt.size;
	}

	/** 标记是否该显示（已跨过门槛 **且** 还有执行在跑）。 */
	get shown(): boolean {
		return this.crossed && this.startedAt.size > 0;
	}

	/**
	 * 按当前时刻观察一次：有执行跨过门槛就把粘性标志立起来，返回标记是否该显示。
	 * 每个渲染时机（事件 / 读秒 tick / 节拍 tick）都调它。
	 */
	markCrossed(now: number): boolean {
		for (const startedAt of this.startedAt.values()) {
			if (now - startedAt >= BASH_SPINNER_DELAY_MS) this.crossed = true;
		}
		return this.shown;
	}

	/**
	 * 最早那个执行跨过门槛还要等多少毫秒（≥ 0）；没有执行 / 已经跨过（粘性标志已立）时返回
	 * `null` = 不需要排程。最新一个执行的截止时刻永远不早于已有执行，所以一个在途的排程不用
	 * 因为后来的 `start` 重排。
	 */
	armDelay(now: number): number | null {
		if (this.crossed || this.startedAt.size === 0) return null;
		let earliest = Number.POSITIVE_INFINITY;
		for (const startedAt of this.startedAt.values()) earliest = Math.min(earliest, startedAt);
		return Math.max(0, earliest + BASH_SPINNER_DELAY_MS - now);
	}
}
