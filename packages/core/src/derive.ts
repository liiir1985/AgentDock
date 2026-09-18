/**
 * From an observed write to a reviewable `FileChange`.
 *
 * The harness tells us what it wrote (`before`/`after` texts, `write`/`delete`/`rename`); this
 * module turns that into hunks and refuses the shapes that would make Reject a lie. In particular a
 * destructive write without an old side is an error, not a degraded record: D26 requires a snapshot
 * before the bytes land, and a baseline we never captured cannot be restored.
 */

import { HunkSpec, deriveHunks } from './diff';
import { TextLines, joinLines } from './lines';
import { FileChange, Hunk, ObservedWrite, computeAnchor } from './model';

const EMPTY: TextLines = { lines: [], eols: [] };

export function validateObservedWrite(write: ObservedWrite): void {
	if (write.path === '') throw new Error('observed write has an empty path');
	const { kind, before, after, fromPath } = write;
	const where = `${kind} ${write.path}`;

	if (kind === 'rename') {
		if (before === null || after === null) {
			throw new Error(`${where}: a rename needs both sides — the old path must be restored, so its text is required (D26)`);
		}
		if (fromPath === undefined || fromPath === '') throw new Error(`${where}: a rename needs fromPath`);
		if (fromPath === write.path) throw new Error(`${where}: fromPath equals path`);
		return;
	}
	if (fromPath !== undefined) throw new Error(`${where}: only a rename may carry fromPath`);

	if (kind === 'create' && before !== null) throw new Error(`${where}: a create has no old side`);
	if (kind === 'create' && after === null) throw new Error(`${where}: a create must have new text`);
	if (kind === 'delete' && after !== null) throw new Error(`${where}: a delete has no new side`);
	if (kind === 'delete' && before === null) {
		throw new Error(`${where}: a destructive write must be snapshotted before it lands (D26)`);
	}
	if (kind === 'modify' && (before === null || after === null)) {
		throw new Error(`${where}: a modify changes one existing text into another`);
	}
}

/** One `FileChange` per write, in order. Byte-identical rewrites are dropped (D41 step 3). */
export function deriveFileChanges(writes: ObservedWrite[]): FileChange[] {
	const files: FileChange[] = [];
	for (const write of writes) {
		validateObservedWrite(write);
		const file = toFileChange(write);
		if (file) files.push(file);
	}
	return files;
}

function toFileChange(write: ObservedWrite): FileChange | null {
	const { kind, before, after } = write;
	// A rename always counts: the path is the change even when the bytes are identical. Everything
	// else that rewrote the bytes with the same bytes is not a change worth reviewing.
	if (kind !== 'rename' && before !== null && after !== null && joinLines(before) === joinLines(after)) return null;
	return {
		kind,
		path: write.path,
		fromPath: write.fromPath,
		baseline: before,
		hunks: hunksFor(write),
		attribution: write.attribution,
	};
}

function hunksFor(write: ObservedWrite): Hunk[] {
	const { kind, before, after } = write;
	if (kind === 'create') {
		return [hunk('h1', EMPTY, { start: 0, end: -1 }, { start: 0, end: (after as TextLines).lines.length - 1 })];
	}
	if (kind === 'delete') {
		const old = before as TextLines;
		return [hunk('h1', old, { start: 0, end: old.lines.length - 1 }, { start: 0, end: -1 })];
	}
	return deriveHunks(before as TextLines, after as TextLines).map((spec, index) =>
		fromSpec(`h${index + 1}`, spec),
	);
}

function hunk(
	id: string,
	baseline: TextLines,
	baselineRange: { start: number; end: number },
	targetRange: { start: number; end: number },
): Hunk {
	const made: Hunk = { id, baseline, baselineRange, targetRange, anchor: { line: 0, side: 'after' }, status: 'pending', userEdited: false };
	made.anchor = computeAnchor(made);
	return made;
}

function fromSpec(id: string, spec: HunkSpec): Hunk {
	return hunk(id, spec.baseline, spec.baselineRange, spec.targetRange);
}
