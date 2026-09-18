/**
 * Decision-table tests. Fully self-contained: a synthetic 11-line baseline with
 * all five hunk shapes (pure insert / pure delete / in-place replace / delete at
 * line 0 / append at EOF), hand-written oracles, no I/O.
 */

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hunk, RejectEdit, applyRejectEdit, computeAnchor } from '../../model/changeSet';
import { FixtureHunkSpec, applyHunks } from '../../model/fixture';
import { changeFromRejectEdit, reconcile, rejectEdit } from '../../model/reconcile';

const BASELINE_LINES = [
	'const alpha = 1;',
	'',
	'function beta() {',
	'  return alpha;',
	'}',
	'',
	'// legacy one',
	'// legacy two',
	'function gamma() {',
	'  return 2;',
	'}',
];

const SPECS: FixtureHunkSpec[] = [
	{ id: 'h1', baselineStart: 3, baselineCount: 0, insert: ['  // h1 new A', '  // h1 new B'] },
	{ id: 'h2', baselineStart: 6, baselineCount: 2, insert: [] },
	{ id: 'h3', baselineStart: 9, baselineCount: 1, insert: ['  return 22;'] },
	{ id: 'h4', baselineStart: 0, baselineCount: 1, insert: [] },
	{ id: 'h5', baselineStart: 11, baselineCount: 0, insert: ['// h5 appended line 1', '// h5 appended line 2'] },
];

const EXPECTED_LINES = [
	'',
	'function beta() {',
	'  // h1 new A',
	'  // h1 new B',
	'  return alpha;',
	'}',
	'',
	'function gamma() {',
	'  return 22;',
	'}',
	'// h5 appended line 1',
	'// h5 appended line 2',
];

/** `EXPECTED_LINES` with h2's two deleted baseline lines put back at its empty target position. */
const WITH_H2_REVERTED = [
	'',
	'function beta() {',
	'  // h1 new A',
	'  // h1 new B',
	'  return alpha;',
	'}',
	'',
	'// legacy one',
	'// legacy two',
	'function gamma() {',
	'  return 22;',
	'}',
	'// h5 appended line 1',
	'// h5 appended line 2',
];

function buildHunks(): Hunk[] {
	const applied = applyHunks(BASELINE_LINES, SPECS);
	return SPECS.map((spec, index) => {
		const hunk: Hunk = {
			id: spec.id,
			baselineLines: BASELINE_LINES.slice(spec.baselineStart, spec.baselineStart + spec.baselineCount),
			targetRange: { ...applied.targetRanges[index] },
			anchorLine: 0,
			attachSide: 'after',
			status: 'pending',
			userEdited: false,
			tracked: true,
		};
		computeAnchor(hunk);
		return hunk;
	});
}

function hunkOf(hunks: Hunk[], id: string): Hunk {
	const found = hunks.find((hunk) => hunk.id === id);
	assert.ok(found, `hunk ${id} missing`);
	return found;
}

/** Plans are computed against one frame, so they must be applied back-to-front. */
function rejectAll(lines: string[], plans: RejectEdit[]): string[] {
	let result = lines;
	for (const plan of [...plans].sort((a, b) => b.startLine - a.startLine)) {
		result = applyRejectEdit(result, plan);
	}
	return result;
}

test('applyHunks reproduces the expected new side and per-hunk ranges', () => {
	const applied = applyHunks(BASELINE_LINES, SPECS);
	assert.deepEqual(applied.targetLines, EXPECTED_LINES);
	assert.deepEqual(applied.targetRanges, [
		{ start: 2, end: 3 },
		{ start: 7, end: 6 },
		{ start: 8, end: 8 },
		{ start: 0, end: -1 },
		{ start: 10, end: 11 },
	]);
	const hunks = buildHunks();
	assert.deepEqual(
		hunks.map((hunk) => [hunk.anchorLine, hunk.attachSide]),
		[
			[3, 'after'],
			[6, 'after'],
			[8, 'after'],
			[-1, 'before'],
			[11, 'after'],
		],
	);
});

test('rejecting a pure deletion splices the baseline lines back and leaves neighbours alone', () => {
	const plan = rejectEdit(hunkOf(buildHunks(), 'h2'));
	assert.ok(plan);
	assert.deepEqual(applyRejectEdit(EXPECTED_LINES, plan), WITH_H2_REVERTED);
});

test('an accepted hunk is frozen: text unchanged, later reconcile and reject are no-ops', () => {
	const hunks = buildHunks();
	const h1 = hunkOf(hunks, 'h1');
	h1.status = 'accepted';
	h1.tracked = false;
	assert.equal(rejectEdit(h1), null);
	assert.equal(reconcile(hunks, { cs: 0, ce: 0, d: 5 }).find((hunk) => hunk.id === 'h1'), h1);
});

test('a change above a hunk shifts it and everything below, leaving hunks above untouched', () => {
	const hunks = buildHunks();
	const h3 = hunkOf(hunks, 'h3');
	// Two lines above h3: line 7 is h2's empty target position, and an insertion
	// exactly there belongs to h2 by design (boundary rule), so use line 6.
	const change = { cs: h3.targetRange.start - 2, ce: h3.targetRange.start - 2, d: 3 };
	const next = reconcile(hunks, change);
	assert.deepEqual(
		next.map((hunk) => hunk.targetRange),
		[
			{ start: 2, end: 3 },
			{ start: 10, end: 9 },
			{ start: 11, end: 11 },
			{ start: 0, end: -1 },
			{ start: 13, end: 14 },
		],
	);
	assert.deepEqual(
		[next[1], next[2], next[4]].map((hunk) => hunk.anchorLine),
		[9, 11, 14],
	);
	assert.deepEqual(next.map((hunk) => hunk.userEdited), [false, false, false, false, false]);
	const shifted = [...EXPECTED_LINES];
	shifted.splice(h3.targetRange.start - 2, 0, '// user A', '// user B', '// user C');
	const plan = rejectEdit(hunkOf(next, 'h3'));
	assert.ok(plan);
	const rejected = applyRejectEdit(shifted, plan);
	assert.equal(rejected.length, shifted.length);
	assert.equal(rejected[h3.targetRange.start + 3], '  return 2;');
	assert.equal(rejected[h3.targetRange.start + 2], 'function gamma() {');
	assert.equal(rejected[0], '');
});

test('editing the new side marks the hunk as user edited and reject discards it', () => {
	const hunks = buildHunks();
	const h3 = hunkOf(hunks, 'h3');
	const next = reconcile(hunks, { cs: h3.targetRange.start, ce: h3.targetRange.start, d: 0 });
	const edited = hunkOf(next, 'h3');
	assert.equal(edited.userEdited, true);
	assert.deepEqual(edited.targetRange, { start: 8, end: 8 });
	const rewritten = [...EXPECTED_LINES];
	rewritten[8] = '  return 222;';
	const plan = rejectEdit(edited);
	assert.ok(plan);
	// Reject restores the baseline line and discards the manual rewrite.
	const reverted = [...EXPECTED_LINES];
	reverted[8] = '  return 2;';
	assert.deepEqual(applyRejectEdit(rewritten, plan), reverted);
});

test('a change crossing a hunk boundary marks both hunks stale and disables their actions', () => {
	const hunks = buildHunks();
	const next = reconcile(hunks, { cs: 7, ce: 8, d: -2 });
	assert.deepEqual(
		next.map((hunk) => [hunk.id, hunk.status, hunk.tracked]),
		[
			['h1', 'pending', true],
			['h2', 'stale', false],
			['h3', 'stale', false],
			['h4', 'pending', true],
			['h5', 'pending', true],
		],
	);
	assert.equal(rejectEdit(hunkOf(next, 'h2')), null);
	assert.equal(rejectEdit(hunkOf(next, 'h3')), null);
});

test('rejecting every hunk restores the baseline byte for byte', () => {
	const hunks = buildHunks();
	const plans: RejectEdit[] = [];
	for (const hunk of hunks) {
		const plan = rejectEdit(hunk);
		assert.ok(plan);
		plans.push(plan);
	}
	assert.deepEqual(rejectAll(EXPECTED_LINES, plans), BASELINE_LINES);
	assert.deepEqual(
		plans.map((plan) => plan.startLine),
		[2, 7, 8, 0, 10],
	);
});

test('a line inserted into the empty new side belongs to the hunk and is rolled back by reject', () => {
	const hunks = buildHunks();
	const h2 = hunkOf(hunks, 'h2');
	const next = reconcile(hunks, { cs: h2.targetRange.start, ce: h2.targetRange.start, d: 1 });
	const grown = hunkOf(next, 'h2');
	assert.equal(grown.userEdited, true);
	assert.deepEqual(grown.targetRange, { start: 7, end: 7 });
	const withUserLine = [...EXPECTED_LINES];
	withUserLine.splice(7, 0, '// user inserted line');
	const plan = rejectEdit(grown);
	assert.ok(plan);
	assert.deepEqual(applyRejectEdit(withUserLine, plan), WITH_H2_REVERTED);
});

test('changeFromRejectEdit reports the net line delta of every hunk shape', () => {
	const hunks = buildHunks();
	assert.deepEqual(
		hunks.map((hunk) => changeFromRejectEdit(rejectEdit(hunk)!)),
		[
			{ cs: 2, ce: 3, d: -2 },
			{ cs: 7, ce: 7, d: 2 },
			{ cs: 8, ce: 8, d: 0 },
			{ cs: 0, ce: 0, d: 1 },
			{ cs: 10, ce: 11, d: -2 },
		],
	);
});
