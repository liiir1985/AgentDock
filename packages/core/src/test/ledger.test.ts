/**
 * The turn ledger: three-step `record`, hunk identity across writes in one turn, and the net-shape
 * rebuilds. The interesting cases are all about a *second* write to a path we already track.
 */

import test from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';

import { TurnLedger } from '../ledger';
import { joinLines, splitLines } from '../lines';
import { FileChange, ObservedWrite, Turn, hunkKeepsUserText } from '../model';
import { assertHunksDisjoint, reconcileDocument } from '../reconcile';
import { acceptFile, acceptHunk, rejectFile, rejectHunk, rejectTurn } from '../verdict';
import { applyPlans, attribution } from './support';

const PATH = 'src/x.ts';

function modify(before: string, after: string, path = PATH): ObservedWrite {
	return { path, kind: 'modify', before: splitLines(before), after: splitLines(after), attribution: attribution() };
}

function filesOf(turn: Turn): FileChange[] {
	const files = turn.changeSet?.files ?? [];
	return files;
}

function fileAt(turn: Turn, path = PATH): FileChange {
	const file = filesOf(turn).find((candidate) => candidate.path === path);
	ok(file, `turn must track ${path}`);
	return file;
}

test('a turn records a write, remembers the text, and captures the pre-image', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	strictEqual(ledger.beginTurn(), 1);
	const turn = ledger.record(modify('a\nb\nc\n', 'a\nB\nc\n'));

	deepStrictEqual(turn.changeSet?.turn, 1);
	deepStrictEqual(fileAt(turn).hunks.map((hunk) => [hunk.id, hunk.status]), [['h1', 'pending']]);
	strictEqual(joinLines(ledger.lastKnown(PATH) as never), 'a\nB\nc\n');
	strictEqual(joinLines(ledger.baseline(PATH) as never), 'a\nb\nc\n');
	strictEqual(ledger.endTurn(), turn);
	throws(() => ledger.record(modify('a\nB\nc\n', 'a\nC\nc\n')), /beginTurn/);
});

test('a second write in the same turn keeps the hunk it does not touch', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	ledger.record(modify('a\nb\nc\nd\ne\nf\n', 'a\nB\nc\nd\ne\nf\n'));

	// The agent then edits further down, which leaves the first unit's identity alone.
	const turn = ledger.record(modify('a\nB\nc\nd\ne\nf\n', 'a\nB\nc\nd\ne\nX\n'));
	deepStrictEqual(
		fileAt(turn).hunks.map((hunk) => hunk.id),
		['h1', 'h2'],
	);
	deepStrictEqual(fileAt(turn).hunks[1].baselineRange, { start: 5, end: 5 });
	strictEqual(joinLines(ledger.lastKnown(PATH) as never), 'a\nB\nc\nd\ne\nX\n');
	strictEqual(joinLines(ledger.baseline(PATH) as never), 'a\nb\nc\nd\ne\nf\n', 'the baseline stays at the first touch');
});

test('an unrecorded change before a write is attributed to the user first', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	ledger.record(modify('a\nb\nc\nd\ne\n', 'a\nB\nc\nd\ne\n'));

	// Someone rewrote the hunk's new side without going through us: the next write reports it as its
	// own `before`, and that difference is the user's, not the agent's.
	const turn = ledger.record(modify('a\nZ\nc\nd\ne\n', 'a\nZ2\nc\nd\ne\n'));
	const file = fileAt(turn);
	deepStrictEqual(file.hunks.map((hunk) => [hunk.id, hunk.userEdited]), [['h1', true]]);
	deepStrictEqual(file.hunks[0].targetRange, { start: 1, end: 1 });

	// Reject then discards the whole new side — including what the user typed there (D3).
	const outcome = rejectFile(file);
	strictEqual(joinLines(applyPlans(splitLines('a\nZ2\nc\nd\ne\n'), outcome.plans)), 'a\nb\nc\nd\ne\n');
});

test('a user edit outside every hunk is not claimed by one', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	ledger.record(modify('a\nb\nc\nd\ne\nf\ng\n', 'a\nB\nc\nd\ne\nf\ng\n'));

	const turn = ledger.recordUserEdit(PATH, splitLines('a\nB\nc\nd\nUSER\ne\nf\ng\n'));
	deepStrictEqual(fileAt(turn).hunks.map((hunk) => [hunk.id, hunk.targetRange.start]), [['h1', 1]]);
	deepStrictEqual(
		fileAt(turn).hunks.map((hunk) => hunk.userEdited),
		[false],
		'the user typed outside the unit, so the unit is not user edited',
	);
	strictEqual(joinLines(ledger.lastKnown(PATH) as never), 'a\nB\nc\nd\nUSER\ne\nf\ng\n');
});

test('a user rewrite that is later accepted is reported as the user\'s text', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	ledger.record(modify('a\nb\nc\n', 'a\nB\nc\n', 'src/one.ts'));
	ledger.record(modify('x\ny\n', 'x\nY\n', 'src/two.ts'));
	// The user rewrites the first file's new side before deciding anything.
	ledger.recordUserEdit('src/one.ts', splitLines('a\nMINE\nc\n'));

	const turn = ledger.endTurn();
	const accepted = (turn.changeSet?.files ?? []).map(acceptFile);
	deepStrictEqual(
		accepted.map((file) => file.hunks.map(hunkKeepsUserText).join(',')),
		['true', 'false'],
		'Accept all keeps both files, and still says which one holds the user\'s text',
	);
	deepStrictEqual(
		accepted.map((file) => file.hunks.map((hunk) => hunk.status).join(',')),
		['accepted', 'accepted'],
	);
});

test('modify then delete in one turn rebuilds the hunks as one deletion', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	const first = ledger.record(modify('a\nb\nc\nd\ne\n', 'a\nB\nc\nd\ne\n'));
	const accepted = { ...first.changeSet?.files[0] } as FileChange;
	accepted.hunks = accepted.hunks.map((hunk) => ({ ...hunk, status: 'accepted' as const }));

	// The accepted verdict cannot survive: the file it described is gone.
	const turn = ledger.record({
		path: PATH,
		kind: 'delete',
		before: splitLines('a\nB\nc\nd\ne\n'),
		after: null,
		attribution: attribution(),
	});
	const file = fileAt(turn);
	strictEqual(file.kind, 'delete');
	strictEqual(file.hunks.length, 1);
	deepStrictEqual(file.hunks[0].baselineRange, { start: 0, end: 4 });
	deepStrictEqual(file.hunks[0].targetRange, { start: 0, end: -1 });
	strictEqual(file.hunks[0].status, 'pending');
	strictEqual(joinLines(file.baseline as never), 'a\nb\nc\nd\ne\n', 'the baseline is still the turn baseline');
	strictEqual(joinLines(ledger.lastKnown(PATH) as never), '');
});

test('a file deleted and written again in one turn nets out as a modification', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	ledger.record(modify('a\nb\nc\n', 'a\nB\nc\n'));
	ledger.record({ path: PATH, kind: 'delete', before: splitLines('a\nB\nc\n'), after: null, attribution: attribution() });
	const turn = ledger.record({
		path: PATH,
		kind: 'create',
		before: null,
		after: splitLines('a\nB\nc\nd\n'),
		attribution: attribution(),
	});

	const file = fileAt(turn);
	strictEqual(file.kind, 'modify', 'the intermediate delete leaves no trace in the net shape');
	deepStrictEqual(
		file.hunks.map((hunk) => hunk.baselineRange),
		[{ start: 1, end: 2 }],
		'b -> B and the appended d are within maxGap rows of each other, so they are one unit',
	);
	strictEqual(joinLines(file.baseline as never), 'a\nb\nc\n');
});

test('a path created and deleted in the same turn leaves no file entry at all', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	ledger.record({ path: PATH, kind: 'create', before: null, after: splitLines('a\n'), attribution: attribution() });
	const turn = ledger.record({
		path: PATH,
		kind: 'delete',
		before: splitLines('a\n'),
		after: null,
		attribution: attribution(),
	});
	deepStrictEqual(filesOf(turn), []);
	strictEqual(turn.changeSet, null, 'nothing changed, so there is nothing to review');
});

test('a rename moves the tracked path and drops the old one', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	ledger.record(modify('a\nb\nc\n', 'a\nB\nc\n'));
	const turn = ledger.record({
		path: 'src/y.ts',
		fromPath: PATH,
		kind: 'rename',
		before: splitLines('a\nB\nc\n'),
		after: splitLines('a\nB\nc\n'),
		attribution: attribution(),
	});

	const renamed = fileAt(turn, 'src/y.ts');
	strictEqual(renamed.kind, 'rename');
	strictEqual(renamed.fromPath, PATH);
	strictEqual(filesOf(turn).length, 1, 'the old path is the same file, not a second entry');
	strictEqual(ledger.lastKnown(PATH), undefined);
	strictEqual(joinLines(ledger.lastKnown('src/y.ts') as never), 'a\nB\nc\n');
	deepStrictEqual(renamed.hunks.map((hunk) => hunk.baselineRange), [{ start: 1, end: 1 }], 'the content change is still there');
});

test('an unattributed path is remembered without inventing a change model', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	ledger.reconcileOpen('src/other.ts', splitLines('one\ntwo\n'));
	strictEqual(joinLines(ledger.lastKnown('src/other.ts') as never), 'one\ntwo\n');
	deepStrictEqual(filesOf(ledger.current()), []);
});

test('rejecting a whole turn undoes a create and restores a modification', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	ledger.record(modify('a\nb\nc\n', 'a\nB\nc\n', 'src/mod.ts'));
	ledger.record({ path: 'src/new.ts', kind: 'create', before: null, after: splitLines('fresh\n'), attribution: attribution() });
	const outcome = rejectTurn(ledger.endTurn());

	deepStrictEqual(outcome.fileOps, [{ kind: 'delete', path: 'src/new.ts' }]);
	strictEqual(joinLines(applyPlans(splitLines('a\nB\nc\n'), outcome.plans)), 'a\nb\nc\n');
});

test('the baseline cache is per turn, so the next turn snapshots again', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	ledger.record(modify('a\nb\n', 'a\nB\n'));
	strictEqual(joinLines(ledger.baseline(PATH) as never), 'a\nb\n');

	ledger.beginTurn();
	ledger.record(modify('a\nB\n', 'a\nBB\n'));
	strictEqual(joinLines(ledger.baseline(PATH) as never), 'a\nB\n', 'the second turn needs its own pre-image');
});

test('a write the policy cannot snapshot still records, with no baseline to claim', () => {
	const ledger = new TurnLedger('s1', 'declared-only');
	ledger.beginTurn();
	const turn = ledger.record(modify('a\nb\n', 'a\nB\n'));
	strictEqual(ledger.baseline(PATH), undefined);
	deepStrictEqual(fileAt(turn).hunks.length, 1, 'the change is still reviewable, just not promised');
});

test('recording without a turn open is a programming error, not a silent no-op', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	throws(() => ledger.record(modify('a\n', 'b\n')), /beginTurn/);
	throws(() => ledger.recordUserEdit(PATH, splitLines('a\n')), /beginTurn/);
});

test('hunks stay disjoint and ordered across a mixed sequence', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	ledger.record(modify('a\nb\nc\nd\ne\nf\ng\n', 'a\nB\nc\nd\ne\nf\nX\n'));
	ledger.recordUserEdit(PATH, splitLines('a\nB\nc\nUSER\nd\ne\nf\nX\n'));
	ledger.record(modify('a\nB\nc\nUSER\nd\ne\nf\nX\n', 'a\nB\nc\nUSER\nd\ne\nf\nXX\n'));
	for (const file of filesOf(ledger.endTurn())) assertHunksDisjoint(file);
});

test('a verdict applied mid-turn survives the next write to the same path', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	ledger.record(modify('a\nb\nc\n', 'a\nB\nc\n'));
	// The host accepts the hunk while the turn is still open, then hands the model back.
	ledger.replaceFile(acceptHunk(fileAt(ledger.current()), 'h1'));

	// A later write in the same turn must not re-open what the user already decided: reconciling the
	// pre-verdict file is exactly what would flip `accepted` back to `pending`.
	const turn = ledger.record(modify('a\nB\nc\n', 'a\nB\nc\nd\n'));
	deepStrictEqual(
		fileAt(turn).hunks.map((hunk) => [hunk.id, hunk.status]),
		[
			['h1', 'accepted'],
			['h2', 'pending'],
		],
	);
});

test('a rejected hunk is written back with its text, so the next write is not read as a user edit', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	ledger.record(modify('a\nb\nc\n', 'a\nB\nc\n'));

	const agentText = splitLines('a\nB\nc\n');
	const outcome = rejectHunk(fileAt(ledger.current()), 'h1');
	const restored = splitLines('a\nb\nc\n');
	// Reject writes bytes (D26), so the host reconciles the model against the document it just wrote
	// and hands both back through the seam.
	ledger.replaceFile(reconcileDocument(outcome.file, agentText, restored, 'user'), restored);
	strictEqual(joinLines(ledger.lastKnown(PATH) as never), 'a\nb\nc\n');

	const turn = ledger.record(modify('a\nb\nc\n', 'a\nb\nC\n'));
	deepStrictEqual(
		fileAt(turn).hunks.map((hunk) => [hunk.id, hunk.status, hunk.rejectReason]),
		[
			['h1', 'rejected', 'user'],
			['h2', 'pending', undefined],
		],
	);
});

test('replaceFile is a no-op for a path the turn never recorded', () => {
	const ledger = new TurnLedger('s1', 'exact-before');
	ledger.beginTurn();
	ledger.record(modify('a\nb\n', 'a\nB\n'));
	const orphan = acceptHunk(
		{ ...fileAt(ledger.current()), path: 'src/elsewhere.ts' },
		'h1',
	);
	const turn = ledger.replaceFile(orphan);
	deepStrictEqual(
		filesOf(turn).map((file) => file.path),
		[PATH],
	);
	throws(() => new TurnLedger('s2', 'exact-before').replaceFile(orphan), /beginTurn/);
});
