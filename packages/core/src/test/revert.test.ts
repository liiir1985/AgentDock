/**
 * The revert executor (D33, file side).
 *
 * "Undo down to turn N" is correct only because of the order of the ops: turns descending, files
 * inside a turn descending, no dedup. A script where the same paths recur is therefore the only
 * useful test — a create that is modified twice and later renamed (so undoing turn N has to write
 * the new path, move it back, and write the OLD path again), plus a delete of an unrelated file hit
 * by the same turn.
 *
 * Each assertion is a whole-fs snapshot rather than a per-path check: a missing file is as much a
 * failure as a wrong one, and a wrong loop order shows up precisely as "the path is still there".
 * The wrong orders this catches: undoing turns forward (turn 3's move would run before turn 4's
 * write, leaving the post-turn-4 content behind), writing the rename's restore to the new path
 * (nothing would be left at the old one), and undoing a create with a write (the file would survive
 * `revertTo(session, 1)`).
 */

import test from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';

import { deriveFileChanges } from '../derive';
import { splitLines } from '../lines';
import { FileOp, ObservedWrite, Session, Turn } from '../model';
import { applyOps, attribution, fsSnapshot, memoryFs } from './support';
import { revertTo } from '../revert';

const ATTR = attribution();

const A = 'proj/a.txt';
const B = 'proj/b.txt';
const C = 'proj/c.txt';

const A1 = 'alpha\n';
const A2 = 'alpha\nbeta\n';
const B3 = 'alpha\nbeta\ngamma\n';
const B4 = 'alpha\nbeta\ngamma\ndelta\n';
const C0 = 'unrelated\nfile\n';

const CREATE_A: ObservedWrite = { path: A, kind: 'create', before: null, after: splitLines(A1), attribution: ATTR };
const MODIFY_A: ObservedWrite = { path: A, kind: 'modify', before: splitLines(A1), after: splitLines(A2), attribution: ATTR };
const RENAME_A_B: ObservedWrite = { path: B, fromPath: A, kind: 'rename', before: splitLines(A2), after: splitLines(B3), attribution: ATTR };
const RENAME_A_B_SAME: ObservedWrite = { path: B, fromPath: A, kind: 'rename', before: splitLines(A2), after: splitLines(A2), attribution: ATTR };
const MODIFY_B: ObservedWrite = { path: B, kind: 'modify', before: splitLines(B3), after: splitLines(B4), attribution: ATTR };
const DELETE_C: ObservedWrite = { path: C, kind: 'delete', before: splitLines(C0), after: null, attribution: ATTR };

/** Turn 4 touches two files, so the within-turn reversal is exercised as well as the turn one. */
const SESSION: Session = {
	id: 'session-1',
	turns: [
		{ index: 1, changeSet: { turn: 1, files: deriveFileChanges([CREATE_A]) } },
		{ index: 2, changeSet: { turn: 2, files: deriveFileChanges([MODIFY_A]) } },
		{ index: 3, changeSet: { turn: 3, files: deriveFileChanges([RENAME_A_B]) } },
		{ index: 4, changeSet: { turn: 4, files: deriveFileChanges([MODIFY_B, DELETE_C]) } },
	],
};

/** What the disc held just before each turn started. */
const BEFORE_TURN: Record<number, Record<string, string>> = {
	1: { [C]: C0 },
	2: { [A]: A1, [C]: C0 },
	3: { [A]: A2, [C]: C0 },
	4: { [B]: B3, [C]: C0 },
};

/** …and what it holds now, after turn 4. */
const NOW: Record<string, string> = { [B]: B4 };

for (const n of [4, 3, 2, 1]) {
	test(`undoing down to turn ${n} leaves the workspace as it stood before turn ${n}`, () => {
		deepStrictEqual(fsSnapshot(applyOps(memoryFs(NOW), revertTo(SESSION, n))), BEFORE_TURN[n]);
	});
}

test('the ops walk turns and files backwards, and a path touched twice is written twice', () => {
	deepStrictEqual(revertTo(SESSION, 1), [
		{ kind: 'write', path: C, text: splitLines(C0) }, // turn 4, second file
		{ kind: 'write', path: B, text: splitLines(B3) }, // turn 4, first file
		{ kind: 'rename', from: B, to: A }, //               turn 3: the move back
		{ kind: 'write', path: A, text: splitLines(A2) }, // turn 3: content it changed too, at the OLD path
		{ kind: 'write', path: A, text: splitLines(A1) }, // turn 2: a second write to A — not deduplicated
		{ kind: 'delete', path: A }, //                      turn 1: a create is undone by deleting
	] as FileOp[]);
});

test('a rename that also changed content moves the file back first, then writes the old path', () => {
	const ops = revertTo(SESSION, 3);

	strictEqual(ops.length, 4);
	strictEqual(ops[2].kind, 'rename', 'the move back must precede the write it enables');
	deepStrictEqual(ops[2], { kind: 'rename', from: B, to: A });
	deepStrictEqual(ops[3], { kind: 'write', path: A, text: splitLines(A2) });
});

test('a rename that changed nothing is only a move — there is no text to restore', () => {
	const session: Session = {
		id: 'rename-only',
		turns: [{ index: 1, changeSet: { turn: 1, files: deriveFileChanges([RENAME_A_B_SAME]) } }],
	};
	strictEqual(session.turns[0].changeSet?.files[0].hunks.length, 0, 'identical bytes ⇒ no hunk');

	deepStrictEqual(revertTo(session, 1), [{ kind: 'rename', from: B, to: A }]);
});

test('a turn that changed nothing contributes no ops', () => {
	const turns: Turn[] = [
		{ index: 1, changeSet: { turn: 1, files: deriveFileChanges([MODIFY_A]) } },
		{ index: 2, changeSet: null },
	];

	deepStrictEqual(revertTo({ id: 'quiet-turn', turns }, 2), [], 'undoing the turn that changed nothing is a no-op');
	deepStrictEqual(revertTo({ id: 'quiet-turn', turns }, 1), [{ kind: 'write', path: A, text: splitLines(A1) }]);
});

test('turn indices outside the session are refused', () => {
	throws(() => revertTo(SESSION, 0), RangeError);
	throws(() => revertTo(SESSION, SESSION.turns.length + 1), RangeError);
	throws(() => revertTo(SESSION, 2.5), RangeError);
	throws(() => revertTo({ id: 'empty', turns: [] }, 1), RangeError);
});
