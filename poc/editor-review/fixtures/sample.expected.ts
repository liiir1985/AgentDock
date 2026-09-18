// Baseline revision: the text as it exists on disk before the agent runs.

export interface Task {
	id: string;
	title: string;
	done: boolean;
}

const SEPARATOR = ' :: ';

export function formatTask(task: Task): string {
	const parts: string[] = [task.id];
	// h1: the agent normalised the title before formatting.
	const trimmed = task.title.trim();
	task = { ...task, title: trimmed };

	if (task.title.length > 0) {
		parts.push(task.title);
	}

	return parts.join(SEPARATOR);
}

export function countDone(tasks: Task[]): number {
	let count = 0;

	for (const task of tasks) {
		count += task.done ? 1 : 0;
	}

	return count;
}

export function summarise(tasks: Task[]): string {
	return `${countDone(tasks)} / ${tasks.length}`;
}
// h5: the agent appended a module-level convenience export.
export const TASK_SEPARATOR = SEPARATOR;
