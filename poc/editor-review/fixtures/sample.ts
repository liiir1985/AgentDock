// Fixture for the AgentDock Editor Review PoC.
// Baseline revision: the text as it exists on disk before the agent runs.

export interface Task {
	id: string;
	title: string;
	done: boolean;
}

const SEPARATOR = ' :: ';

export function formatTask(task: Task): string {
	const parts: string[] = [task.id];

	if (task.title.length > 0) {
		parts.push(task.title);
	}

	return parts.join(SEPARATOR);
}

// The next block is kept for compatibility with older callers.
// It is scheduled for removal in the next cleanup pass.
export function countDone(tasks: Task[]): number {
	let count = 0;

	for (const task of tasks) {
		if (task.done) {
			count += 1;
		}
	}

	return count;
}

export function summarise(tasks: Task[]): string {
	return `${countDone(tasks)}/${tasks.length}`;
}
