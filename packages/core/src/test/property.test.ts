/**
 * Seeded properties. These are the phase's exit criteria in executable form: reject(all) restores
 * the baseline byte for byte, a replayed script produces an identical session, and no edit sequence
 * can make two hunks overlap.
 *
 * Every generator is seeded from `mulberry32`, so a failure prints a seed that reproduces it.
 */

import test from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import { TurnLedger } from '../ledger';
import { TextLines, joinLines, replaceRange, splitLines } from '../lines';
import { Session } from '../model';
import { assertHunksDisjoint } from '../reconcile';
import { rejectTurn } from '../verdict';
import {
	applyOps,
	applyPlans,
	attribution,
	fsSnapshot,
	memoryFs,
	mulberry32,
	mutateLines,
	pick,
	randomText,
	rngInt,
} from './support';

const PATH = 'src/f.ts';
const ALPHABET = ['a', 'b', 'c', 'd', 'a', 'b', '', 'return;'];

/** Exactly `count` rows, each terminated, so it can be spliced into a document. */
function rows(rng: () => number, count: number): TextLines {
	return randomText(rng, {
		minLines: count,
		maxLines: count,
		alphabet: ALPHABET,
		eols: ['\n', '\r\n', '\r'],
		finalEol: 'present',
	});
}

function assertInvariant(ledger: TurnLedger): void {
	for (const file of ledger.current().changeSet?.files ?? []) assertHunksDisjoint(file);
}

test('property 1: reject(all) restores the baseline byte for byte after any agent write sequence', () => {
	for (let seed = 0; seed < 200; seed++) {
		const rng = mulberry32(seed);
		const baseline = randomText(rng, { minLines: 1, maxLines: 10, alphabet: ALPHABET });
		const ledger = new TurnLedger(`p1-${seed}`, 'exact-before');
		ledger.beginTurn();

		let doc = baseline;
		const steps = rngInt(rng, 1, 3);
		for (let step = 0; step < steps; step++) {
			const after = mutateLines(rng, doc, rngInt(rng, 1, 2));
			ledger.record({ path: PATH, kind: 'modify', before: doc, after, attribution: attribution() });
			doc = after;
			assertInvariant(ledger);
		}

		const outcome = rejectTurn(ledger.endTurn());
		strictEqual(joinLines(applyPlans(doc, outcome.plans)), joinLines(baseline), `seed ${seed}`);
		deepStrictEqual(outcome.fileOps, [], `seed ${seed}: a rewrite needs no file-level op`);
	}
});

test('property 2: a user edit inside a hunk is discarded and the baseline still comes back exactly', () => {
	for (let seed = 0; seed < 200; seed++) {
		const rng = mulberry32(seed + 1000);
		const baseline = randomText(rng, { minLines: 2, maxLines: 10, alphabet: ALPHABET });
		// Guarantee a new side to edit: a mutation can be pure deletions, and then there is no row
		// inside a unit to rewrite.
		const target = replaceRange(
			mutateLines(rng, baseline, rngInt(rng, 1, 2)),
			{ start: 0, end: -1 },
			rows(rng, 1),
		);

		const ledger = new TurnLedger(`p2-${seed}`, 'exact-before');
		ledger.beginTurn();
		ledger.record({ path: PATH, kind: 'modify', before: baseline, after: target, attribution: attribution() });

		const open = (ledger.current().changeSet?.files[0].hunks ?? []).filter(
			(hunk) => hunk.targetRange.end >= hunk.targetRange.start,
		);
		ok(open.length > 0, `seed ${seed}: the fixture must have a new side to edit`);
		// (the inserted leading row is always one of them)
		const victim = pick(rng, open);
		// Rows nothing else can match, so the diff sees exactly one edit: inside the unit. With
		// duplicate content the alignment is free to split a visual replacement into an in-hunk change
		// plus an insertion just below the unit, and then part of the user's text is legitimately
		// outside the unit (property 3's case, not this one).
		const count = rngInt(rng, 1, 3);
		const replacement = splitLines(
			Array.from({ length: count }, (_, index) => `USER${seed}-${index}`).join('\n') + '\n',
		);
		const doc = replaceRange(target, victim.targetRange, replacement);
		ledger.recordUserEdit(PATH, doc);
		assertInvariant(ledger);

		const outcome = rejectTurn(ledger.endTurn());
		strictEqual(joinLines(applyPlans(doc, outcome.plans)), joinLines(baseline), `seed ${seed}`);
	}
});

test('property 3: a user edit outside every hunk survives, and only shifts the hunks', () => {
	for (let seed = 0; seed < 200; seed++) {
		const rng = mulberry32(seed + 9000);
		const size = 24;
		const lines = Array.from({ length: size }, (_, index) => `row${index}`);
		const changed = [rngInt(rng, 0, 3), rngInt(rng, size - 4, size - 1)].sort((a, b) => a - b);

		const baseline = splitLines(lines.join('\n') + '\n');
		const targetLines = lines.slice();
		targetLines[changed[0]] = `agent${seed}`;
		targetLines[changed[1]] = `agent2${seed}`;
		const target = splitLines(targetLines.join('\n') + '\n');

		const ledger = new TurnLedger(`p3-${seed}`, 'exact-before');
		ledger.beginTurn();
		ledger.record({ path: PATH, kind: 'modify', before: baseline, after: target, attribution: attribution() });

		const hunks = ledger.current().changeSet?.files[0].hunks ?? [];
		deepStrictEqual(hunks.length, 2, `seed ${seed}: the fixture must be two separate units`);
		const [above, below] = hunks;
		const at = above.targetRange.end + 1;
		ok(at < below.targetRange.start, `seed ${seed}: the insertion must land in the gap`);

		const userLine = `user${seed}`;
		const userLines = targetLines.slice();
		userLines.splice(at, 0, userLine);
		ledger.recordUserEdit(PATH, splitLines(userLines.join('\n') + '\n'));
		assertInvariant(ledger);

		const after = ledger.current().changeSet?.files[0].hunks ?? [];
		deepStrictEqual(
			after.map((hunk) => [hunk.id, hunk.targetRange.start, hunk.targetRange.end]),
			[
				[above.id, above.targetRange.start, above.targetRange.end],
				[below.id, below.targetRange.start + 1, below.targetRange.end + 1],
			],
			`seed ${seed}: no hunk claims the user's row, the ones below just move down`,
		);
		deepStrictEqual(
			after.map((hunk) => hunk.userEdited),
			[false, false],
			`seed ${seed}: typing outside a unit is not an edit of it`,
		);

		// Reject restores every hunk region, and the user's row is still there afterwards.
		const outcome = rejectTurn(ledger.endTurn());
		const expected = lines.slice();
		expected.splice(above.baselineRange.end + 1, 0, userLine);
		strictEqual(
			joinLines(applyPlans(splitLines(userLines.join('\n') + '\n'), outcome.plans)),
			expected.join('\n') + '\n',
			`seed ${seed}`,
		);
	}
});

test('property 3b: reject(all) takes a path back to the state the turn found it in', () => {
	for (let seed = 0; seed < 200; seed++) {
		const rng = mulberry32(seed + 5000);
		const existed = rngInt(rng, 0, 1) === 1;
		const initial = existed ? randomText(rng, { minLines: 1, maxLines: 8, alphabet: ALPHABET }) : null;

		const ledger = new TurnLedger(`p3b-${seed}`, 'exact-before');
		ledger.beginTurn();
		let doc = initial;
		const steps = rngInt(rng, 1, 3);
		for (let step = 0; step < steps; step++) {
			if (doc === null) {
				const after = randomText(rng, { minLines: 1, maxLines: 8, alphabet: ALPHABET });
				ledger.record({ path: PATH, kind: 'create', before: null, after, attribution: attribution() });
				doc = after;
			} else if (rngInt(rng, 0, 3) === 0) {
				ledger.record({ path: PATH, kind: 'delete', before: doc, after: null, attribution: attribution() });
				doc = null;
			} else {
				const after = mutateLines(rng, doc, rngInt(rng, 1, 2));
				ledger.record({ path: PATH, kind: 'modify', before: doc, after, attribution: attribution() });
				doc = after;
			}
			assertInvariant(ledger);
		}

		const outcome = rejectTurn(ledger.endTurn());
		const disc = memoryFs(doc === null ? {} : { [PATH]: joinLines(doc) });
		applyOps(disc, outcome.fileOps);
		if (disc.has(PATH) && outcome.plans.length > 0) {
			disc.set(PATH, joinLines(applyPlans(splitLines(disc.get(PATH) as string), outcome.plans)));
		}
		deepStrictEqual(
			fsSnapshot(disc),
			initial === null ? {} : { [PATH]: joinLines(initial) },
			`seed ${seed}: file ops restore existence, plans restore content`,
		);
	}
});

test('property 4: the same script replayed into two ledgers produces identical sessions', () => {
	const script = (): Session => {
		const ledger = new TurnLedger('replay', 'exact-before');
		ledger.beginTurn();
		ledger.record({ path: PATH, kind: 'modify', before: splitLines('a\nb\nc\nd\ne\nf\n'), after: splitLines('a\nB\nc\nd\ne\nf\n'), attribution: attribution() });
		ledger.recordUserEdit(PATH, splitLines('a\nB\nc\nUSER\nd\ne\nf\n'));
		ledger.endTurn();

		ledger.beginTurn();
		ledger.record({ path: 'src/moved.ts', fromPath: PATH, kind: 'rename', before: splitLines('a\nB\nc\nUSER\nd\ne\nf\n'), after: splitLines('a\nB\nc\nUSER\nd\ne\nf\ng\n'), attribution: attribution() });
		ledger.record({ path: 'src/new.ts', kind: 'create', before: null, after: splitLines('fresh\n'), attribution: attribution() });
		ledger.endTurn();

		ledger.beginTurn();
		ledger.record({ path: 'src/new.ts', kind: 'delete', before: splitLines('fresh\n'), after: null, attribution: attribution() });
		ledger.endTurn();
		return ledger.session();
	};

	const first = script();
	const second = script();
	deepStrictEqual(JSON.stringify(second), JSON.stringify(first));
	// Hunk ids come from position in the derivation, never from a clock or a counter that could drift.
	deepStrictEqual(
		first.turns.flatMap((turn) => (turn.changeSet?.files ?? []).flatMap((file) => file.hunks.map((hunk) => hunk.id))),
		['h1', 'h1', 'h1', 'h1'],
	);
	deepStrictEqual(
		first.turns.map((turn) => turn.changeSet?.files.map((file) => file.path) ?? null),
		[[PATH], ['src/moved.ts', 'src/new.ts'], ['src/new.ts']],
	);
});

test('property 5: any mix of agent and user edits keeps the invariant and replays identically', () => {
	for (let seed = 0; seed < 200; seed++) {
		const first = mixedScript(seed);
		const second = mixedScript(seed);
		strictEqual(JSON.stringify(second), JSON.stringify(first), `seed ${seed}: no hidden state`);
	}
});

function mixedScript(seed: number): Session {
	const rng = mulberry32(seed + 20000);
	const ledger = new TurnLedger(`mixed-${seed}`, 'exact-before');
	ledger.beginTurn();
	let doc = randomText(rng, { minLines: 2, maxLines: 8, alphabet: ALPHABET });
	ledger.record({ path: PATH, kind: 'modify', before: doc, after: mutateLines(rng, doc, 1), attribution: attribution() });
	doc = ledger.lastKnown(PATH) ?? doc;
	assertInvariant(ledger);

	const steps = rngInt(rng, 1, 4);
	for (let step = 0; step < steps; step++) {
		const at = rngInt(rng, 0, doc.lines.length);
		const removed = rngInt(rng, 0, Math.min(doc.lines.length - at, 3));
		doc = replaceRange(doc, { start: at, end: at + removed - 1 }, rows(rng, rngInt(rng, 0, 2)));
		ledger.recordUserEdit(PATH, doc);
		assertInvariant(ledger);

		const after = mutateLines(rng, doc, rngInt(rng, 1, 2));
		ledger.record({ path: PATH, kind: 'modify', before: doc, after, attribution: attribution() });
		doc = after;
		assertInvariant(ledger);
	}
	ledger.endTurn();
	return ledger.session();
}
