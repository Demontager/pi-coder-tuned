/**
 * types.ts — state model and pure-function helpers for simple-task.
 *
 * Deliberately minimal: three states, no blocks, no dependency graph, no note, no agent metrics.
 * Follows @thunstack/pi-task-list's "session-level, managed by the agent itself" scope,
 * but drops the complexity it carries for plan-mode / sub-agent collaboration.
 */

export type TaskStatus = "pending" | "in_progress" | "done";

export interface Task {
	id: number;
	text: string;
	status: TaskStatus;
}

export interface State {
	/** Whether the list exists. An empty list does not count — neither the widget nor the status bar is shown. */
	active: boolean;
	tasks: Task[];
	/** The next id to assign. Monotonically increasing and never reused, so history references stay correct. */
	nextId: number;
}

export function emptyState(): State {
	return { active: false, tasks: [], nextId: 1 };
}

/** Shallow-copies tasks. The state is written to the session log and referenced by multiple snapshots, so mutable objects must not be shared. */
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

/** Plain-text list for rendering (no ANSI), used by the command and debugging. */
export function describeTasks(state: State): string[] {
	return state.tasks.map((task) => `${task.status === "done" ? "[x]" : task.status === "in_progress" ? "[~]" : "[ ]"} #${task.id} ${task.text}`);
}
