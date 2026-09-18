/**
 * Accept / Reject as plans (D26 / D3).
 *
 * The two things worth pinning: Accept must not be able to touch the document (it returns no ops at
 * all), and Reject must be a byte-exact inverse of exactly the regions the agent changed.
 */

import test from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import { deriveFileChanges } from '../derive';
import { joinLines, splitLines } from '../lines';
import { FileChange, Turn, hunkKeepsUserText } from '../model';
import { acceptFile, acceptHunk, acceptTurn, rejectFile, rejectHunk, rejectTurn } from '../verdict';
import { applyOps, applyPlans, attribution, memoryFs } from './support';

const BEFORE = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
const AFTER = 'a\nB\nc\nd\ne\nf\nX\nh\ni\nj\n';

function modify(before = BEFORE, after = AFTER, path = 'src/x.ts'): FileChange {
	const change = deriveFileChanges([
		{ path, kind: 'modify', before: splitLines(before), after: splitLines(after), attribution: attribution() },
	])[0];
	ok(change, 'fixture must produce a change');
	return change;
}

function turnOf(file: FileChange): Turn {
	return { index: 1, changeSet: { turn: 1, files: [file] } };
}

/** The user rewrote this unit's new side; nobody has decided anything about it yet. */
function withUserEdit(file: FileChange, id: string): FileChange {
	return { ...file, hunks: file.hunks.map((hunk) => (hunk.id === id ? { ...hunk, userEdited: true } : hunk)) };
}

const USER_TEXT = 'a\nUSER-TEXT\nc\nd\ne\nf\ng\nh\ni\nj\n';

test('accept is a pure bookkeeping step at every level', () => {
	const file = modify();
	strictEqual(file.hunks.length, 2);

	const one = acceptHunk(file, 'h1');
	strictEqual(one.hunks[0].status, 'accepted');
	strictEqual(one.hunks[1].status, 'pending');
	strictEqual(file.hunks[0].status, 'pending', 'the input is not mutated');

	const all = acceptFile(file);
	deepStrictEqual(all.hunks.map((hunk) => hunk.status), ['accepted', 'accepted']);
	deepStrictEqual(all.hunks.map((hunk) => hunk.rejectReason), [undefined, undefined]);

	const turn = acceptTurn(turnOf(acceptHunk(file, 'h1')));
	deepStrictEqual(turn.changeSet?.files[0].hunks.map((hunk) => hunk.status), ['accepted', 'accepted']);
	stranger(file, 'nope');
});

test('a kept unit records whose text was kept', () => {
	const accepted = acceptFile(withUserEdit(modify(), 'h1'));

	deepStrictEqual(
		accepted.hunks.map((hunk) => hunk.status),
		['accepted', 'accepted'],
		'one terminal value for "keep": the document already holds what was decided',
	);
	deepStrictEqual(
		accepted.hunks.map(hunkKeepsUserText),
		[true, false],
		"but the agent has to be told which unit holds the user's text (D3)",
	);
	strictEqual(
		joinLines(applyPlans(splitLines(USER_TEXT), rejectFile(accepted).plans)),
		USER_TEXT,
		'a kept unit is never written back, so the user\'s text is what survives',
	);
	strictEqual(hunkKeepsUserText(acceptFile(accepted).hunks[0]), true, 'accepting twice changes nothing');
});

test('a pending user edit is a different fact from a kept one', () => {
	const pending = withUserEdit(modify(), 'h1');
	deepStrictEqual(pending.hunks.map(hunkKeepsUserText), [false, false], 'nothing has been kept yet');
	strictEqual(
		joinLines(applyPlans(splitLines(USER_TEXT), rejectFile(pending).plans)),
		BEFORE,
		'while it is pending, rejecting it discards the user\'s text along with the agent\'s',
	);

	// Deciding the *other* unit leaves this one undecided: the distinction is per hunk, not per file.
	const half = acceptHunk(pending, 'h2');
	deepStrictEqual(half.hunks.map(hunkKeepsUserText), [false, false]);
	strictEqual(half.hunks[0].status, 'pending');
});

test('rejectFile restores exactly the pending regions, byte for byte', () => {
	const file = modify();
	const outcome = rejectFile(file);

	deepStrictEqual(outcome.fileOps, []);
	deepStrictEqual(
		outcome.plans.map((plan) => [plan.path, plan.startLine, plan.endLineExclusive, joinLines(plan.text)]),
		[
			['src/x.ts', 6, 7, 'g\n'],
			['src/x.ts', 1, 2, 'b\n'],
		],
		'one plan per pending hunk, furthest first so the coordinates stay valid',
	);
	strictEqual(joinLines(applyPlans(splitLines(AFTER), outcome.plans)), BEFORE);
	deepStrictEqual(outcome.file.hunks.map((hunk) => hunk.status), ['rejected', 'rejected']);
});

test('an accepted hunk is not rolled back by a file-level reject', () => {
	const file = acceptHunk(modify(), 'h1');
	const outcome = rejectFile(file);
	deepStrictEqual(
		outcome.plans.map((plan) => plan.startLine),
		[6],
		'Accept never wrote the document, so Reject must not pretend it can undo it',
	);
	strictEqual(joinLines(applyPlans(splitLines(AFTER), outcome.plans)), 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n');
});

test('rejectHunk plans only the hunk it was asked about', () => {
	const outcome = rejectHunk(modify(), 'h2');
	deepStrictEqual(outcome.plans.map((plan) => plan.startLine), [6]);
	deepStrictEqual(outcome.file.hunks.map((hunk) => hunk.status), ['pending', 'rejected']);
});

test('rejecting a created file deletes it instead of writing', () => {
	const created = deriveFileChanges([
		{ path: 'src/new.ts', kind: 'create', before: null, after: splitLines('one\ntwo\n'), attribution: attribution() },
	])[0];
	const outcome = rejectFile(created);
	deepStrictEqual(outcome.fileOps, [{ kind: 'delete', path: 'src/new.ts' }]);
	deepStrictEqual(outcome.plans, []);
});

test('rejecting a deleted file writes its baseline back', () => {
	const deleted = deriveFileChanges([
		{ path: 'src/gone.ts', kind: 'delete', before: splitLines('one\ntwo\n'), after: null, attribution: attribution() },
	])[0];
	const outcome = rejectFile(deleted);
	deepStrictEqual(outcome.fileOps, [{ kind: 'write', path: 'src/gone.ts', text: splitLines('one\ntwo\n') }]);
	deepStrictEqual(outcome.plans, []);
});

test('rejecting a renamed file moves it back, then writes the old path', () => {
	const renamed = deriveFileChanges([
		{
			path: 'src/new.ts',
			fromPath: 'src/old.ts',
			kind: 'rename',
			before: splitLines(BEFORE),
			after: splitLines(AFTER),
			attribution: attribution(),
		},
	])[0];
	const outcome = rejectFile(renamed);

	deepStrictEqual(outcome.fileOps, [{ kind: 'rename', from: 'src/new.ts', to: 'src/old.ts' }]);
	deepStrictEqual(
		outcome.plans.map((plan) => [plan.path, plan.startLine]),
		[
			['src/old.ts', 6],
			['src/old.ts', 1],
		],
		'the content lives at the old path once the file has moved back',
	);

	const disc = memoryFs({ 'src/new.ts': AFTER });
	applyOps(disc, outcome.fileOps);
	strictEqual(joinLines(applyPlans(splitLines(disc.get('src/old.ts') as string), outcome.plans)), BEFORE);
	strictEqual(disc.has('src/new.ts'), false);
});

test('rejectTurn puts every file op before every plan', () => {
	const created = deriveFileChanges([
		{ path: 'src/new.ts', kind: 'create', before: null, after: splitLines('one\n'), attribution: attribution() },
	])[0];
	const outcome = rejectTurn({ index: 2, changeSet: { turn: 2, files: [created, modify()] } });

	deepStrictEqual(outcome.fileOps, [{ kind: 'delete', path: 'src/new.ts' }]);
	deepStrictEqual(
		outcome.plans.map((plan) => [plan.path, plan.startLine]),
		[
			['src/x.ts', 6],
			['src/x.ts', 1],
		],
		'plans follow the file order they were collected in',
	);
	deepStrictEqual(outcome.turn.changeSet?.files.map((file) => file.kind), ['create', 'modify']);
	strictEqual(joinLines(applyPlans(splitLines(AFTER), outcome.plans)), BEFORE);
});

test('a discarded hunk is terminal: it is never accepted and never planned', () => {
	const discarded: FileChange = {
		...modify(),
		hunks: [{ ...modify().hunks[0], status: 'rejected', rejectReason: 'conflict' }],
	};
	deepStrictEqual(rejectFile(discarded).plans, []);
	deepStrictEqual(rejectFile(discarded).fileOps, []);
	strictEqual(acceptFile(discarded).hunks[0].status, 'rejected', 'a conflict is not silently accepted');
});

test('a turn with no change set rejects to nothing', () => {
	const outcome = rejectTurn({ index: 3, changeSet: null });
	deepStrictEqual(outcome.plans, []);
	deepStrictEqual(outcome.fileOps, []);
});

function stranger(file: FileChange, id: string): void {
	deepStrictEqual(acceptHunk(file, id), file);
	deepStrictEqual(rejectHunk(file, id).plans, []);
}
