/**
 * types.ts — simple-task 的状态模型与纯函数工具。
 *
 * 刻意只做最小集：三种状态、无区块、无依赖图、无 note、无 agent 指标。
 * 参照 @thunstack/pi-task-list 的"会话级、agent 自己管理"的功能定位，
 * 但砍掉它那些为 plan-mode / 子 agent 协作服务的复杂度。
 */

export type TaskStatus = "pending" | "in_progress" | "done";

export interface Task {
	id: number;
	text: string;
	status: TaskStatus;
}

export interface State {
	/** 列表是否存在。空列表不算存在 —— widget 与状态栏都不显示。 */
	active: boolean;
	tasks: Task[];
	/** 下一个分配的 id。单调递增且永不复用，避免历史引用错乱。 */
	nextId: number;
}

export function emptyState(): State {
	return { active: false, tasks: [], nextId: 1 };
}

/** 深拷贝一层 tasks。状态会被写进会话日志并在多处快照引用，不能共享可变对象。 */
export function cloneState(state: State): State {
	return { ...state, tasks: state.tasks.map((task) => ({ ...task })) };
}

export function isComplete(state: State): boolean {
	return state.tasks.length > 0 && state.tasks.every((task) => task.status === "done");
}

export function countByStatus(state: State): { done: number; inProgress: number; pending: number } {
	let done = 0;
	let inProgress = 0;
	let pending = 0;
	for (const task of state.tasks) {
		if (task.status === "done") done += 1;
		else if (task.status === "in_progress") inProgress += 1;
		else pending += 1;
	}
	return { done, inProgress, pending };
}

/** 渲染用的纯文本列表（不含 ANSI），给命令与调试用。 */
export function describeTasks(state: State): string[] {
	return state.tasks.map((task) => `${task.status === "done" ? "[x]" : task.status === "in_progress" ? "[~]" : "[ ]"} #${task.id} ${task.text}`);
}
