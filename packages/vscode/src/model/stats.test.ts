/**
 * The `+N -M` counts behind a file's row in the Changes view (D24).
 *
 * The arithmetic is pure, so this is where its boundaries belong: a `LineRange` with `end < start`
 * spells an empty side (pure insertion on the new side, pure deletion on the old side) and has to
 * count 0 rather than a negative number, and a `create` — whose baseline range is `{start: 0,
 * end: -1}` by construction (`derive.ts`) — has to count only its new side.
 */

import test from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';

import type { FileChange, Hunk, LineRange, TextLines } from '@agentdock/core';
import { fileStats, formatStats } from '../render/stats';

const EMPTY: TextLines = { lines: [], eols: [] };

/** Only the two ranges matter to `fileStats`; the rest is filled with what `deriveFileChanges` would. */
function hunk(id: string, baselineRange: LineRange, targetRange: LineRange): Hunk {
	return {
		id,
		baseline: EMPTY,
		baselineRange,
		targetRange,
		anchor: { line: 0, side: 'after' },
		status: 'pending',
		userEdited: false,
	};
}

function file(kind: FileChange['kind'], hunks: Hunk[]): FileChange {
	return {
		kind,
		path: 'seed-a.ts',
		baseline: kind === 'create' ? null : EMPTY,
		hunks,
		attribution: { tier: 'T1', source: 'write', level: 'own' },
	};
}

test('a pure insertion counts only the lines it added', () => {
	const stats = fileStats(file('modify', [hunk('h1', { start: 0, end: -1 }, { start: 4, end: 5 })]));

	deepEqual(stats, { added: 2, removed: 0 });
	equal(formatStats(stats), '+2 -0');
});

test('a pure deletion counts only the lines it removed', () => {
	deepEqual(fileStats(file('modify', [hunk('h1', { start: 1, end: 3 }, { start: 2, end: 1 })])), {
		added: 0,
		removed: 3,
	});
});

test('a replacement counts both sides', () => {
	deepEqual(fileStats(file('modify', [hunk('h1', { start: 0, end: 1 }, { start: 0, end: 2 })])), {
		added: 3,
		removed: 2,
	});
});

test('a created file counts every line of its new side', () => {
	const stats = fileStats(file('create', [hunk('h1', { start: 0, end: -1 }, { start: 0, end: 2 })]));

	deepEqual(stats, { added: 3, removed: 0 });
});

test('a deleted file counts every line of its old side', () => {
	deepEqual(fileStats(file('delete', [hunk('h1', { start: 0, end: 3 }, { start: 0, end: -1 })])), {
		added: 0,
		removed: 4,
	});
});

test('the counts of a file add up across its hunks', () => {
	const stats = fileStats(
		file('modify', [
			hunk('h1', { start: 0, end: -1 }, { start: 1, end: 2 }),
			hunk('h2', { start: 5, end: 7 }, { start: 8, end: 7 }),
			hunk('h3', { start: 9, end: 9 }, { start: 10, end: 12 }),
		]),
	);

	deepEqual(stats, { added: 5, removed: 4 });
	equal(formatStats(stats), '+5 -4');
});

test('a file with nothing counted still formats both signs', () => {
	equal(formatStats(fileStats(file('modify', []))), '+0 -0');
});
