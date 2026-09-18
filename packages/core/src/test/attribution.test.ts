/**
 * T1 coverage (D42). The two tool lists have to be *equal*: wrapping fewer file tools than the
 * harness ships leaves changes that no review can attribute or reject, and wrapping more means the
 * declaration went stale — the next harness update then adds an unwrapped tool unnoticed. Both
 * directions therefore have to fail loudly, with the differencing tools named so the fix is a
 * one-line change.
 */

import test from 'node:test';
import { deepStrictEqual, match } from 'node:assert/strict';

import { ToolCoverage, ToolCoverageError, assertToolCoverage, missingTools, unexpectedTools } from '../attribution';

/** `assertToolCoverage` must throw; returns the error so both lists can be inspected. */
function coverageError(coverage: ToolCoverage): ToolCoverageError {
	try {
		assertToolCoverage(coverage);
	} catch (error) {
		if (error instanceof ToolCoverageError) return error;
		throw error;
	}
	throw new Error('expected assertToolCoverage to throw');
}

test('missingTools subtracts the wrapped set, in declaration order and without duplicates', () => {
	deepStrictEqual(missingTools({ declared: [], wrapped: [] }), []);
	deepStrictEqual(missingTools({ declared: ['edit', 'write'], wrapped: ['edit', 'write'] }), []);
	deepStrictEqual(missingTools({ declared: ['write', 'edit', 'write', 'apply'], wrapped: ['edit', 'write'] }), [
		'apply',
	]);
});

test('unexpectedTools subtracts the declared set, so duplicate wrappings are reported once', () => {
	deepStrictEqual(unexpectedTools({ declared: [], wrapped: [] }), []);
	deepStrictEqual(unexpectedTools({ declared: ['edit'], wrapped: ['edit', 'write', 'write', 'bash'] }), [
		'write',
		'bash',
	]);
});

test('equal sets pass, whatever order the adapter and the harness report them in', () => {
	assertToolCoverage({ declared: ['edit', 'write', 'apply'], wrapped: ['apply', 'edit', 'write'] });
});

test('a declared tool the adapter never wrapped is a blind spot and is named', () => {
	const error = coverageError({ declared: ['edit', 'write'], wrapped: ['edit'] });

	deepStrictEqual(error.missing, ['write']);
	deepStrictEqual(error.unexpected, []);
	// The message has to name it: the operator fixes this by wrapping one tool.
	match(error.message, /write/);
});

test('a wrapped tool the harness no longer declares means the declaration is stale, and is named', () => {
	const error = coverageError({ declared: ['edit'], wrapped: ['edit', 'write'] });

	deepStrictEqual(error.missing, []);
	deepStrictEqual(error.unexpected, ['write']);
	match(error.message, /write/, 'the message has to name the tool the harness no longer declares');
});

test('both differences are reported at once instead of one failing at a time', () => {
	const error = coverageError({ declared: ['edit', 'write'], wrapped: ['apply', 'edit'] });

	deepStrictEqual(error.missing, ['write']);
	deepStrictEqual(error.unexpected, ['apply']);
	match(error.message, /write/);
	match(error.message, /apply/);
});
