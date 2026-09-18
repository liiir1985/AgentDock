/**
 * From an observed write to a reviewable `FileChange` (D26 / D41).
 *
 * Two failures matter here and both are silent in production:
 *
 * - a destructive write recorded without an old side — Reject would then have nothing to restore,
 *   so `validateObservedWrite` has to throw instead of accepting a half-truth, and a `rename` must
 *   not degrade into delete + add (the review UI and the revert executor move one file, not two);
 * - a hunk that leaves derivation without an anchor, or with an anchor pointing at the wrong row:
 *   the old side would be drawn against unrelated code.
 *
 * Hunks are asserted value by value because a shape that is merely "non-empty" hides exactly these
 * mistakes (wrong range, whole-file baseline, ids restarting per file).
 */

import test from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';

import { deriveFileChanges, validateObservedWrite } from '../derive';
import { LineRange, sliceLines, splitLines } from '../lines';
import { FileChangeKind, HunkAnchor, ObservedWrite } from '../model';
import { attribution } from './support';

const ATTR = attribution();

function write(
	kind: FileChangeKind,
	path: string,
	before: string | null,
	after: string | null,
	fromPath?: string,
): ObservedWrite {
	const observed: ObservedWrite = {
		path,
		kind,
		before: before === null ? null : splitLines(before),
		after: after === null ? null : splitLines(after),
		attribution: ATTR,
	};
	if (fromPath !== undefined) observed.fromPath = fromPath;
	return observed;
}

test('a write we could not restore is refused, never recorded as something weaker', () => {
	const refused: [string, ObservedWrite, RegExp][] = [
		['create with an old side', write('create', 'src/x.ts', 'a\n', 'b\n'), /a create has no old side/],
		['create without new text', write('create', 'src/x.ts', null, null), /a create must have new text/],
		[
			'delete without a snapshot (D26)',
			write('delete', 'src/x.ts', null, null),
			/must be snapshotted before it lands/,
		],
		['delete with a new side', write('delete', 'src/x.ts', 'a\n', 'b\n'), /a delete has no new side/],
		[
			'modify without an old side',
			write('modify', 'src/x.ts', null, 'b\n'),
			/a modify changes one existing text into another/,
		],
		[
			'modify without a new side',
			write('modify', 'src/x.ts', 'a\n', null),
			/a modify changes one existing text into another/,
		],
		['rename without fromPath', write('rename', 'src/x.ts', 'a\n', 'b\n'), /a rename needs fromPath/],
		['rename with an empty fromPath', write('rename', 'src/x.ts', 'a\n', 'b\n', ''), /a rename needs fromPath/],
		[
			'rename onto itself',
			write('rename', 'src/x.ts', 'a\n', 'b\n', 'src/x.ts'),
			/fromPath equals path/,
		],
		[
			'rename without an old side',
			write('rename', 'src/x.ts', null, 'b\n', 'src/old.ts'),
			/a rename needs both sides/,
		],
		[
			'rename without a new side',
			write('rename', 'src/x.ts', 'a\n', null, 'src/old.ts'),
			/a rename needs both sides/,
		],
		['fromPath on a create', write('create', 'src/x.ts', null, 'b\n', 'src/old.ts'), /only a rename may carry fromPath/],
		['fromPath on a modify', write('modify', 'src/x.ts', 'a\n', 'b\n', 'src/old.ts'), /only a rename may carry fromPath/],
		['fromPath on a delete', write('delete', 'src/x.ts', 'a\n', null, 'src/old.ts'), /only a rename may carry fromPath/],
		['empty path', write('modify', '', 'a\n', 'b\n'), /empty path/],
	];

	for (const [label, observed, pattern] of refused) {
		throws(() => validateObservedWrite(observed), pattern, label);
	}
});

test('derivation runs that same check, so a bad write never reaches a ChangeSet', () => {
	throws(
		() => deriveFileChanges([write('delete', 'src/x.ts', null, null)]),
		/must be snapshotted before it lands/,
	);
});

test('every well-formed shape is accepted and keeps its kind, path and previous path', () => {
	const accepted: [ObservedWrite, FileChangeKind, string, string | undefined][] = [
		[write('create', 'src/a.ts', null, 'a\n'), 'create', 'src/a.ts', undefined],
		[write('modify', 'src/b.ts', 'a\n', 'b\n'), 'modify', 'src/b.ts', undefined],
		[write('delete', 'src/c.ts', 'a\n', null), 'delete', 'src/c.ts', undefined],
		[write('rename', 'src/e.ts', 'a\n', 'b\n', 'src/d.ts'), 'rename', 'src/e.ts', 'src/d.ts'],
	];

	for (const [observed, kind, path, fromPath] of accepted) {
		const files = deriveFileChanges([observed]);
		strictEqual(files.length, 1, `${kind} produces exactly one FileChange`);
		strictEqual(files[0].kind, kind);
		strictEqual(files[0].path, path);
		strictEqual(files[0].fromPath, fromPath, `${kind} fromPath`);
	}
});

test('create: one hunk with an empty old side covering the whole new file', () => {
	const files = deriveFileChanges([write('create', 'src/new.ts', null, 'one\ntwo\n')]);

	strictEqual(files[0].baseline, null, 'a create has no pre-image, so the file op is its undo');
	deepStrictEqual(files[0].hunks, [
		{
			id: 'h1',
			baseline: { lines: [], eols: [] },
			baselineRange: { start: 0, end: -1 },
			targetRange: { start: 0, end: 1 },
			anchor: { line: 1, side: 'after' },
			status: 'pending',
			userEdited: false,
		},
	]);
});

test('delete: one hunk whose new side is empty and whose old side is the entire lost text', () => {
	const files = deriveFileChanges([write('delete', 'src/gone.ts', 'one\ntwo\nthree\n', null)]);

	deepStrictEqual(files[0].baseline, splitLines('one\ntwo\nthree\n'));
	deepStrictEqual(files[0].hunks, [
		{
			id: 'h1',
			baseline: splitLines('one\ntwo\nthree\n'),
			baselineRange: { start: 0, end: 2 },
			targetRange: { start: 0, end: -1 },
			anchor: { line: -1, side: 'before' },
			status: 'pending',
			userEdited: false,
		},
	]);
});

test('modify: one hunk per change run, ids in document order, each holding its own baseline slice', () => {
	const before = 'r0\nr1\nr2\nr3\nr4\nr5\nr6\nr7\nr8\nr9\nr10\nr11\n';
	// Two edits separated by nine untouched lines: further apart than DEFAULT_MAX_GAP, so they are
	// two review units rather than one. They must not share an id and must not share a baseline. The
	// second one touches the last line, so no trailing context is folded into it (a short trailing
	// run of equal lines belongs to the hunk — that is `maxGap`, pinned in `diff.test.ts`).
	const after = 'r0\nx1\nr2\nr3\nr4\nr5\nr6\nr7\nr8\nr9\nr10\nx11\n';
	const files = deriveFileChanges([write('modify', 'src/x.ts', before, after)]);

	deepStrictEqual(files[0].hunks, [
		{
			id: 'h1',
			baseline: splitLines('r1\n'),
			baselineRange: { start: 1, end: 1 },
			targetRange: { start: 1, end: 1 },
			anchor: { line: 1, side: 'after' },
			status: 'pending',
			userEdited: false,
		},
		{
			id: 'h2',
			baseline: splitLines('r11\n'),
			baselineRange: { start: 11, end: 11 },
			targetRange: { start: 11, end: 11 },
			anchor: { line: 11, side: 'after' },
			status: 'pending',
			userEdited: false,
		},
	]);

	// The old side is the text at `baselineRange` — Reject writes these bytes back, so a hunk whose
	// baseline came from anywhere else restores content the file never held.
	const old = splitLines(before);
	for (const hunk of files[0].hunks) {
		deepStrictEqual(hunk.baseline, sliceLines(old, hunk.baselineRange), `baseline of ${hunk.id}`);
	}
});

test('FileChange.baseline is the pre-write text, and null only where there was no old side', () => {
	const cases: [ObservedWrite, string | null][] = [
		[write('create', 'src/a.ts', null, 'new\n'), null],
		[write('modify', 'src/b.ts', 'old\nsecond\n', 'new\n'), 'old\nsecond\n'],
		[write('delete', 'src/c.ts', 'old\nsecond\n', null), 'old\nsecond\n'],
		[write('rename', 'src/e.ts', 'old\nsecond\n', 'new\n', 'src/d.ts'), 'old\nsecond\n'],
	];

	for (const [observed, expected] of cases) {
		const files = deriveFileChanges([observed]);
		if (expected === null) strictEqual(files[0].baseline, null, `${observed.kind} baseline`);
		else deepStrictEqual(files[0].baseline, splitLines(expected), `${observed.kind} baseline`);
	}
});

test('rewriting the same bytes is not a change, but moving them to a new path is', () => {
	deepStrictEqual(
		deriveFileChanges([write('modify', 'src/x.ts', 'same\ntext\n', 'same\ntext\n')]),
		[],
		'a modify that changed nothing must not reach the ChangeSet (D41 step 3)',
	);

	const files = deriveFileChanges([write('rename', 'src/new.ts', 'same\ntext\n', 'same\ntext\n', 'src/old.ts')]);
	strictEqual(files.length, 1, 'the path is the change even when the bytes are not');
	strictEqual(files[0].kind, 'rename');
	strictEqual(files[0].fromPath, 'src/old.ts');
	deepStrictEqual(files[0].hunks, [], 'and there is no line-level change to review');
});

test('every hunk leaves derivation anchored where computeAnchor would put it', () => {
	// The anchor is the row the old side borrows; a hunk that keeps a default anchor draws itself
	// against line 0 of the file no matter where the edit is.
	const cases: [ObservedWrite, LineRange, HunkAnchor][] = [
		[
			// new side present: borrow the hunk's own last line
			write('modify', 'src/a.ts', 'a\nb\n', 'a\nB\n'),
			{ start: 1, end: 1 },
			{ line: 1, side: 'after' },
		],
		[
			// a pure insertion has no old side at all, and still anchors on the row it added.
			// The unchanged 'b' after it stays out of the unit: maxGap merges changes that are close
			// together, it never lets a hunk swallow the quiet rows after its last change.
			write('modify', 'src/d.ts', 'a\nb\n', 'a\ninserted\nb\n'),
			{ start: 1, end: 1 },
			{ line: 1, side: 'after' },
		],
		[
			// pure deletion at line 0: there is no row above, so hang off the before side of line 0
			write('modify', 'src/b.ts', 'a\n', ''),
			{ start: 0, end: -1 },
			{ line: -1, side: 'before' },
		],
		[
			// pure deletion below the top: borrow the nearest surviving line
			write('modify', 'src/c.ts', 'a\nb\nc\n', 'a\n'),
			{ start: 1, end: 0 },
			{ line: 0, side: 'after' },
		],
	];

	for (const [observed, targetRange, anchor] of cases) {
		const files = deriveFileChanges([observed]);
		deepStrictEqual(files[0].hunks.map((hunk) => [hunk.targetRange, hunk.anchor]), [[targetRange, anchor]]);
	}
});
