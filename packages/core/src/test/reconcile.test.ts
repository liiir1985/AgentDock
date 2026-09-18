/**
 * The reconcile decision table, on a fixture that has every hunk shape at once (pure insert, pure
 * delete, in-place replace, multi-line replace, EOF append) with more than `DEFAULT_MAX_GAP` equal
 * lines between neighbours, so each shape really is its own review unit.
 */

import test from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';

import { deriveFileChanges } from '../derive';
import { splitLines } from '../lines';
import { FileChange, Hunk } from '../model';
import { applyEdits, assertHunksDisjoint, diffToEdits, reconcileDocument } from '../reconcile';
import { acceptHunk, rejectFile } from '../verdict';
import { applyPlans, attribution } from './support';

const BASE = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nt\nu\nv\n';
const TARGET = 'a\nX1\nX2\nb\nc\nd\ne\ng\nh\ni\nj\nK\nl\nm\nn\no\nQR\nr\ns\nt\nu\nv\nZ\n';

function fileFor(before: string, after: string, path = 'src/x.ts'): FileChange {
	const change = deriveFileChanges([
		{ path, kind: 'modify', before: splitLines(before), after: splitLines(after), attribution: attribution() },
	])[0];
	ok(change, 'the fixture must produce a change');
	return change;
}

function targets(file: FileChange): { id: string; start: number; end: number }[] {
	return file.hunks.map((hunk) => ({ id: hunk.id, start: hunk.targetRange.start, end: hunk.targetRange.end }));
}

function hunk(file: FileChange, id: string): Hunk {
	const found = file.hunks.find((candidate) => candidate.id === id);
	ok(found, `fixture must have ${id}`);
	return found;
}

test('the fixture derives one hunk per shape, in order', () => {
	const file = fileFor(BASE, TARGET);
	deepStrictEqual(targets(file), [
		{ id: 'h1', start: 1, end: 2 }, // pure insertion of X1,X2
		{ id: 'h2', start: 7, end: 6 }, // pure deletion of f
		{ id: 'h3', start: 11, end: 11 }, // k -> K
		{ id: 'h4', start: 16, end: 16 }, // p,q -> QR
		{ id: 'h5', start: 22, end: 22 }, // Z appended at EOF
	]);
	deepStrictEqual(hunk(file, 'h1').baseline, { lines: [], eols: [] });
	deepStrictEqual(hunk(file, 'h2').baseline.lines, ['f']);
	deepStrictEqual(hunk(file, 'h4').baseline.lines, ['p', 'q']);
	deepStrictEqual(hunk(file, 'h5').baseline.lines, []);
	deepStrictEqual(hunk(file, 'h3').baselineRange, { start: 10, end: 10 });
});

test('rule 1: an edit above every hunk shifts all of them by its delta', () => {
	const file = fileFor(BASE, TARGET);
	const after = reconcileDocument(file, splitLines(TARGET), splitLines('top1\ntop2\n' + TARGET), 'user');
	deepStrictEqual(targets(after), [
		{ id: 'h1', start: 3, end: 4 },
		{ id: 'h2', start: 9, end: 8 },
		{ id: 'h3', start: 13, end: 13 },
		{ id: 'h4', start: 18, end: 18 },
		{ id: 'h5', start: 24, end: 24 },
	]);
});

test('rule 2: an edit below every hunk moves nothing', () => {
	const file = fileFor(BASE, TARGET);
	const after = reconcileDocument(file, splitLines(TARGET), splitLines(TARGET + 'tail\n'), 'user');
	deepStrictEqual(targets(after), targets(file));
});

test('rule 3: an edit inside the new side grows the hunk and marks it user edited', () => {
	const file = fileFor(BASE, TARGET);
	// A line inserted immediately before K, which is h3's whole new side.
	const edited = TARGET.replace('K\n', 'KX\nK\n');
	const after = reconcileDocument(file, splitLines(TARGET), splitLines(edited), 'user');
	strictEqual(hunk(after, 'h3').userEdited, true);
	deepStrictEqual(hunk(after, 'h3').targetRange, { start: 11, end: 12 });
	deepStrictEqual(targets(after), [
		{ id: 'h1', start: 1, end: 2 },
		{ id: 'h2', start: 7, end: 6 },
		{ id: 'h3', start: 11, end: 12 },
		{ id: 'h4', start: 17, end: 17 },
		{ id: 'h5', start: 23, end: 23 },
	]);
	assertHunksDisjoint(after);
});

test('rule 3 does not claim an agent edit as a user edit', () => {
	const file = fileFor(BASE, TARGET);
	const edited = TARGET.replace('K\n', 'KX\nK\n');
	const after = reconcileDocument(file, splitLines(TARGET), splitLines(edited), 'agent');
	strictEqual(hunk(after, 'h3').userEdited, false);
});

test('rule 4: a user edit across a boundary keeps the hunk, found again by its context', () => {
	const file = fileFor(BASE, TARGET);
	// Rewrite j and insert a line before K: h3's own text is one row further down, not gone.
	const lines = splitLines(TARGET).lines;
	const edited = lines.slice(0, 10).concat(['j', 'j2', 'K'], lines.slice(12)).join('\n') + '\n';
	const after = reconcileDocument(file, splitLines(TARGET), splitLines(edited), 'user');

	// The edit's rows and the hunk are now one region (D3: a Reject of it discards j2 as well).
	deepStrictEqual(hunk(after, 'h3').targetRange, { start: 11, end: 12 });
	strictEqual(hunk(after, 'h3').status, 'pending');
	strictEqual(hunk(after, 'h3').userEdited, true);
	deepStrictEqual(targets(after), [
		{ id: 'h1', start: 1, end: 2 },
		{ id: 'h2', start: 7, end: 6 },
		{ id: 'h3', start: 11, end: 12 },
		{ id: 'h4', start: 17, end: 17 },
		{ id: 'h5', start: 23, end: 23 },
	]);
	assertHunksDisjoint(after);
});

test('rule 5: an ambiguous relocation discards the hunk and writes nothing', () => {
	// Two identical blocks, so the hunk's context has two plausible homes: we must not guess.
	const repeated = fileFor(
		'B\nC\nD\nE\nF\nG\nH\nB\nC\nD\nX\nF\nG\nH\n',
		'B\nC\nD\nX\nF\nG\nH\nB\nC\nD\nX\nF\nG\nH\n',
	);
	deepStrictEqual(hunk(repeated, 'h1').targetRange, { start: 3, end: 3 });

	const before = splitLines('B\nC\nD\nX\nF\nG\nH\nB\nC\nD\nX\nF\nG\nH\n');
	const userLines = 'B\nC\nD\nY\nG\nH\nB\nC\nD\nX\nF\nG\nH\n';
	const { file: next, after: text } = applyEdits(repeated, before, diffToEdits(before, splitLines(userLines)), 'user');

	deepStrictEqual(targets(next), [{ id: 'h1', start: 4, end: 3 }]);
	strictEqual(hunk(next, 'h1').status, 'rejected');
	strictEqual(hunk(next, 'h1').rejectReason, 'conflict');
	deepStrictEqual(hunk(next, 'h1').baseline.lines, ['E'], 'the discarded old side stays visible (D19)');
	strictEqual(text.lines.join('\n'), 'B\nC\nD\nY\nG\nH\nB\nC\nD\nX\nF\nG\nH', 'reconcile never edits the document');

	const outcome = rejectFile(next);
	deepStrictEqual(outcome.plans, [], 'a discarded hunk is never written back');
	deepStrictEqual(outcome.fileOps, []);
});

test('a discarded hunk keeps tracking the document as a zero-width marker', () => {
	const repeated = fileFor(
		'B\nC\nD\nE\nF\nG\nH\nB\nC\nD\nX\nF\nG\nH\n',
		'B\nC\nD\nX\nF\nG\nH\nB\nC\nD\nX\nF\nG\nH\n',
	);
	const userLines = 'B\nC\nD\nY\nG\nH\nB\nC\nD\nX\nF\nG\nH\n';
	const discarded = reconcileDocument(repeated, splitLines('B\nC\nD\nX\nF\nG\nH\nB\nC\nD\nX\nF\nG\nH\n'), splitLines(userLines), 'user');

	// A later edit above it moves the marker with the document instead of leaving it behind.
	const moved = reconcileDocument(discarded, splitLines(userLines), splitLines('top\n' + userLines), 'user');
	deepStrictEqual(hunk(moved, 'h1').targetRange, { start: 5, end: 4 });
	assertHunksDisjoint(moved);
});

test('an agent edit across a boundary merges and reopens a decided hunk', () => {
	const file = acceptHunk(fileFor(BASE, TARGET), 'h1');
	strictEqual(hunk(file, 'h1').status, 'accepted');

	// The agent rewrites X1,X2 and b — straight across h1's boundary.
	const agentLines = 'a\nY\nc\nd\ne\ng\nh\ni\nj\nK\nl\nm\nn\no\nQR\nr\ns\nt\nu\nv\nZ\n';
	const { file: next, after: text } = applyEdits(
		file,
		splitLines(TARGET),
		diffToEdits(splitLines(TARGET), splitLines(agentLines)),
		'agent',
	);

	deepStrictEqual(targets(next), [
		{ id: 'h1', start: 1, end: 1 },
		{ id: 'h2', start: 5, end: 4 },
		{ id: 'h3', start: 9, end: 9 },
		{ id: 'h4', start: 14, end: 14 },
		{ id: 'h5', start: 20, end: 20 },
	]);
	strictEqual(hunk(next, 'h1').status, 'pending', 'the accepted text was rewritten, so it is reviewed again');
	strictEqual(hunk(next, 'h1').rejectReason, undefined);
	deepStrictEqual(
		hunk(next, 'h1').baseline.lines,
		['b'],
		'the union covers X1,X2 — which have no old side at all — and b, the one baseline row in it',
	);
	strictEqual(text.lines.join('\n'), agentLines.replace(/\n$/, ''));

	const outcome = rejectFile(next);
	deepStrictEqual(
		outcome.plans.map((plan) => plan.startLine),
		[20, 14, 9, 5, 1],
		'plans are applied in the order returned, so they come back to front',
	);
	strictEqual(
		applyPlans(text, outcome.plans).lines.join('\n'),
		BASE.replace(/\n$/, ''),
		'reject(all) restores the baseline byte for byte',
	);
});

test('agent changes no hunk covers become hunks of their own', () => {
	const file = fileFor(BASE, TARGET);
	const lines = splitLines(TARGET).lines.slice();
	lines.splice(19, 1); // drop t, which sits between h4 and h5 and belongs to no hunk
	const agentLines = lines.concat(['W']).join('\n') + '\n';
	const { file: next, after: text } = applyEdits(
		file,
		splitLines(TARGET),
		diffToEdits(splitLines(TARGET), splitLines(agentLines)),
		'agent',
	);

	deepStrictEqual(targets(next), [
		{ id: 'h1', start: 1, end: 2 },
		{ id: 'h2', start: 7, end: 6 },
		{ id: 'h3', start: 11, end: 11 },
		{ id: 'h4', start: 16, end: 16 },
		{ id: 'h6', start: 19, end: 18 },
		{ id: 'h5', start: 21, end: 21 },
		{ id: 'h7', start: 22, end: 22 },
	]);
	deepStrictEqual(hunk(next, 'h6').baseline.lines, ['t'], 'the deleted row is recoverable');
	deepStrictEqual(hunk(next, 'h6').baselineRange, { start: 19, end: 19 });
	deepStrictEqual(hunk(next, 'h7').baselineRange, { start: 22, end: 21 });

	const outcome = rejectFile(next);
	strictEqual(
		applyPlans(text, outcome.plans).lines.join('\n'),
		BASE.replace(/\n$/, ''),
		'the agent\'s own new hunks are undone too',
	);
});

test('a later agent edit keeps an unrelated verdict', () => {
	const file = acceptHunk(fileFor(BASE, TARGET), 'h4');
	const lines = splitLines(TARGET).lines.slice();
	lines[2] = 'B2'; // inside h1's new side
	const after = reconcileDocument(file, splitLines(TARGET), splitLines(lines.join('\n') + '\n'), 'agent');

	strictEqual(hunk(after, 'h4').status, 'accepted', 'a verdict survives an edit to another hunk');
	deepStrictEqual(targets(after).map((range) => range.id), ['h1', 'h2', 'h3', 'h4', 'h5']);
	assertHunksDisjoint(after);
});

test('assertHunksDisjoint rejects overlapping hunks', () => {
	const file = fileFor(BASE, TARGET);
	const broken: FileChange = {
		...file,
		hunks: [hunk(file, 'h1'), { ...hunk(file, 'h2'), targetRange: { start: 1, end: 4 } }],
	};
	throws(() => assertHunksDisjoint(broken), /overlap/);
});
