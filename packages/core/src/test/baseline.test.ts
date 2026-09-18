/**
 * Snapshot fidelity (D37 / D39): how much we may promise about a file's pre-image is a function of
 * the intercept level and nothing else. Two failures matter here, and both are silent in production:
 *
 * - a level that promises more than it delivered (`post-hoc` treated as an exact baseline ⇒ Reject
 *   writes back text that was never the file's content);
 * - a second write inside one turn moving the baseline to a post-write text (⇒ Reject restores the
 *   agent's own output instead of the user's file).
 *
 * The ledger is asserted on those two properties, not on its storage.
 */

import test from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';

import { BaselineLedger, SnapshotPolicy, snapshotPolicy } from '../baseline';
import { splitLines } from '../lines';
import { InterceptLevel } from '../model';

/**
 * Every level is listed, and the `Record` is the compile-time guard: dropping a branch from
 * `snapshotPolicy` leaves this table incomplete and the package no longer compiles.
 */
const EXPECTED: Record<InterceptLevel, SnapshotPolicy> = {
	own: 'exact-before',
	'blocking-hook': 'exact-before',
	'async-signal': 'best-effort-before',
	'post-hoc': 'declared-only',
	none: 'none',
};

test('every intercept level maps to the fidelity it can actually deliver', () => {
	for (const level of Object.keys(EXPECTED) as InterceptLevel[]) {
		strictEqual(snapshotPolicy(level), EXPECTED[level], `intercept level '${level}'`);
	}
});

test('the first capture wins; a later capture of the same path does not overwrite it', () => {
	const ledger = new BaselineLedger('exact-before');
	const before = splitLines('a\nb\n');
	const after = splitLines('a\nc\n');

	strictEqual(ledger.capture('src/x.ts', before), true);
	strictEqual(ledger.capture('src/x.ts', after), false, 'the second write in a turn has no baseline of its own');
	deepStrictEqual(ledger.get('src/x.ts'), before);
});

test('paths reports capture order, so Reject can plan several files consistently', () => {
	const ledger = new BaselineLedger('best-effort-before');

	strictEqual(ledger.capture('b.ts', splitLines('b\n')), true);
	strictEqual(ledger.capture('a.ts', splitLines('a\n')), true);
	strictEqual(ledger.capture('c.ts', splitLines('c\n')), true);
	deepStrictEqual(ledger.paths, ['b.ts', 'a.ts', 'c.ts']);
});

test('clear drops the texts and the paths, and the ledger is reusable afterwards', () => {
	const ledger = new BaselineLedger('exact-before');
	ledger.capture('src/x.ts', splitLines('x\n'));

	ledger.clear();
	deepStrictEqual(ledger.paths, []);
	strictEqual(ledger.get('src/x.ts'), undefined);
	strictEqual(ledger.capture('src/x.ts', splitLines('y\n')), true, 'clear means a new turn');
});

test('policies that cannot see the pre-image never hand one out', () => {
	for (const policy of ['declared-only', 'none'] as const) {
		const ledger = new BaselineLedger(policy);

		strictEqual(ledger.capture('src/x.ts', splitLines('x\n')), false, `policy '${policy}'`);
		strictEqual(ledger.get('src/x.ts'), undefined, `policy '${policy}'`);
		deepStrictEqual(ledger.paths, [], `policy '${policy}'`);
	}
});
