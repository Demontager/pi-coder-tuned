/**
 * plan-mirror.ts — plan-mode 的步骤与 simple-task 清单之间的**唯一契约**。
 *
 * 两个扩展各有一份状态：plan-mode 记 `[DONE:n]` 推进的步骤，simple-task 记 `task_*`
 * 工具维护的清单。2026-09-23 之前它们是两套独立进度表，于是同一屏上出现两份清单、
 * 两个数字，而模型往往只更新其中一份（实测：一轮执行里 `task_update` 调了 17 次、
 * `[DONE:n]` 一次没写，状态行永远停在 `▶ 0/10`）。现在的约定是 **task 清单是执行期
 * 唯一的进度表**：批准计划时 plan-mode 把步骤镜像进 simple-task，plan-mode 不再画
 * 自己的步骤 widget，状态行读的是镜像回来的状态。
 *
 * ## 事件（`pi.events`，跨扩展进程内总线）
 *
 *   plan-mode:sync-tasks → simple-task
 *     载荷：`PlanMirrorSync[]`，**全量**快照；空数组 = 清掉镜像（退出 plan / 放弃计划）。
 *     plan-mode 在「批准计划」「进度变化」「退出 plan」时各发一次。
 *
 *   simple-task:state → plan-mode
 *     载荷：`TaskMirrorState`，也是全量。simple-task 在每次状态写入（工具调用、镜像同步、
 *     会话重建）后发一次。
 *
 * 载荷都是全量而不是增量：两个扩展各自可能重启、重放会话（`/resume`、`/reload`），
 * 增量在丢一条之后就永久错位，全量的代价只是一个几元素数组。
 *
 * ## 为什么镜像任务要带前缀
 *
 * simple-task 的清单是用户可见的（widget + `task_get`），镜像条目必须能一眼区分出
 * 「这是当前计划的第 n 步」，而不是普通任务。前缀同时是 plan-mode 事后认领条目的依据
 * （重启后它只能从文本反推步号），所以 `buildMirrorText` / `parseMirrorStep` 必须成对使用。
 *
 * 本文件不 import pi / pi-tui，也不 import 兄弟扩展 —— 两端都从这里取契约，只为能被
 * `node --test` 直接跑到（`recap/` 那种跨目录 import 是例外，不是惯例）。
 */

import type { Task } from "./types.ts";

/** 镜像条目前缀的固定部分。 */
export const MIRROR_PREFIX = "plan: ";

/** plan-mode 广播的镜像条目（全量快照的一个元素）。 */
export interface PlanMirrorItem {
	/** 步号，同时也是镜像任务的 id。 */
	step: number;
	text: string;
	done: boolean;
}

/** simple-task 广播的状态快照。 */
export interface TaskMirrorState {
	items: Array<{ id: number; text: string; status: "pending" | "in_progress" | "done" }>;
}

export const SYNC_TASKS_EVENT = "plan-mode:sync-tasks";
export const TASK_STATE_EVENT = "simple-task:state";

/** 镜像条目的显示文案（也是 plan-mode 重启后认领条目的依据）。 */
export function buildMirrorText(item: Pick<PlanMirrorItem, "step" | "text">): string {
	return `${MIRROR_PREFIX}${item.step}. ${item.text}`;
}

/** 这条清单文案是不是 plan-mode 的镜像条目。 */
export function isMirrorText(text: string): boolean {
	return text.startsWith(MIRROR_PREFIX);
}

/**
 * 清单里还有没有 plan-mode 的镜像条目。
 *
 * 执行期重推镜像的判据用它，而不是「plan-mode 自己有没有 done 步」：模型违规
 * `task_set`（或用户 `/tasks clear`）会整体冲掉镜像，此时若自己还没有任何 done 步，
 * 旧判据会让镜像永远回不来 —— 状态行冻在 `▶ 0/N`，新条目没有前缀也永远不被认领；
 * 而已有 done 步时旧判据又会把镜像塞回模型的新清单，同屏出现两段清单。
 *
 * 参数宽化成只读 `text`：`Task[]` 与 `TaskMirrorState["items"]` 都能直接传入。
 */
export function hasMirrorItems(tasks: readonly { text: string }[]): boolean {
	return tasks.some((task) => isMirrorText(task.text));
}

/** 从镜像文案里取回步号；不是镜像条目（或步号坏了）返回 undefined。 */
export function parseMirrorStep(text: string): number | undefined {
	if (!isMirrorText(text)) return undefined;
	const match = /^plan: (\d+)\./.exec(text);
	if (!match) return undefined;
	const step = Number(match[1]);
	return Number.isInteger(step) && step > 0 ? step : undefined;
}

/**
 * 用 simple-task 广播回来的状态算「第 n 步完成了没」。
 *
 * 只认镜像条目（`parseMirrorStep` 认得出来的）：普通任务即使 id 与步号撞上也不算，
 * 否则用户手建的 `#3` 会让计划的第 3 步凭空完成。
 */
export function mirroredDoneSteps(state: TaskMirrorState | undefined): Set<number> {
	const done = new Set<number>();
	for (const item of state?.items ?? []) {
		if (item.status !== "done") continue;
		const step = parseMirrorStep(item.text ?? "");
		if (step !== undefined) done.add(step);
	}
	return done;
}

/**
 * 按入参全量快照重建清单：镜像条目 id = 步号、文案带前缀，非镜像条目原样排在后面。
 *
 * 五条容易踩的规则：
 *   - **没标完成的步骤不重置 in_progress**：每次进度变化都会重发全量快照，若把它写回
 *     pending，清单里的 spinner 就会在每个同步点闪一下。
 *   - **手建任务不能被计划步骤冲掉**：它们排在镜像之后。
 *   - **手建任务与步号撞号时必须顺延**：镜像的 id 是给模型的承诺（`plan: n. ` 与
 *     `task_update #n` 都指着它），所以镜像优先占 1..N；撞号的手建任务重编号到
 *     `nextAvailableId` 之上。否则清单里会出现两个 `#1`，`task_update`/`task_get`
 *     按 id 线性查找永远只命中镜像条目，手建任务不可达。
 *   - **只从镜像条目取 previous 状态**：两类任务共用 id 空间，用 id 直接查会把手建
 *     任务的 in_progress 串染到同号的镜像步骤上（实测：手建 `#2` 正在进行时，新计划
 *     的第 2 步凭空出现 spinner）。
 *   - **顺延后的 id 从 max(所有已用 id) + 1 起**：避开后续 `task_set` 分到已在用的号。
 */
export function rebuildTasks(current: readonly Task[], incoming: readonly PlanMirrorItem[]): Task[] {
	const previousMirror = new Map<number, Task>();
	for (const task of current) {
		const step = parseMirrorStep(task.text);
		if (step !== undefined) previousMirror.set(step, task);
	}
	const mirrored: Task[] = [...incoming]
		.sort((a, b) => a.step - b.step)
		.map((item) => {
			const existing = previousMirror.get(item.step);
			const status: Task["status"] = item.done
				? "done"
				: existing?.status === "in_progress"
					? "in_progress"
					: "pending";
			return { id: item.step, text: buildMirrorText(item), status };
		});

	const mirroredIds = new Set(mirrored.map((task) => task.id));
	const others = current.filter((task) => !isMirrorText(task.text));
	/** 顺延指针：从最大已用 id 之后开始，跳过镜像占用的号。 */
	let nextId = Math.max(0, ...current.map((task) => task.id)) + 1;
	const renamed = others.map((task) => {
		if (!mirroredIds.has(task.id)) return task;
		while (mirroredIds.has(nextId)) nextId += 1;
		return { ...task, id: nextId++ };
	});

	return [...mirrored, ...renamed];
}

/** 重建后下一个可用的 id（镜像与非镜像共用）。 */
export function nextAvailableId(tasks: readonly Task[]): number {
	return tasks.reduce((max, task) => (task.id > max ? task.id : max), 0) + 1;
}
