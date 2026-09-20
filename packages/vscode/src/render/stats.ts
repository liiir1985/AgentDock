/**
 * The `+N -M` label of a file's row in the Changes view (D24).
 *
 * The counts come from the hunk ranges the model already carries, never from re-diffing the
 * baseline against the document: the number then cannot disagree with what `verdict.ts` will
 * accept or restore, and a hunk the user has edited since still shows the size of the change
 * that was proposed.
 *
 * Both sides are `LineRange`s, where `end < start` spells an empty range (a pure insertion or a
 * pure deletion), so a side with no lines contributes 0 instead of a negative count.
 *
 * Host-agnostic on purpose: no `vscode` import, so the arithmetic is unit-testable from plain
 * Node and the boundary test over `src/model/**` stays meaningful.
 */

import type { FileChange } from '@agentdock/core';

export interface FileStats {
	added: number;
	removed: number;
}

export function fileStats(file: FileChange): FileStats {
	let added = 0;
	let removed = 0;
	for (const hunk of file.hunks) {
		added += Math.max(0, hunk.targetRange.end - hunk.targetRange.start + 1);
		removed += Math.max(0, hunk.baselineRange.end - hunk.baselineRange.start + 1);
	}
	return { added, removed };
}

/** `+2 -0`, the shape the Changes view column and the side-by-side labels both use. */
export function formatStats(stats: FileStats): string {
	return `+${stats.added} -${stats.removed}`;
}
