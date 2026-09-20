/**
 * The extension mirrors the sidecar's wire types instead of importing them (see the note at the top of
 * `src/sidecar/protocol.ts`: a Bun-only package Node cannot load). A mirror drifts silently, and a
 * drifted method name fails at runtime as "unknown request" — so the two *sources* are compared here,
 * and any new method or message kind has to be added on both sides.
 *
 * Text comparison rather than an import on purpose: importing the sidecar's source from the compiled
 * extension would drag Bun-only code into the extension host's module graph, which is exactly what the
 * mirror exists to avoid.
 */

import test from 'node:test';
import { deepStrictEqual, ok } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/** Compiled to `out/model/…`, so the workspace's `packages/` directory is three levels up. */
const packagesRoot = path.resolve(__dirname, '..', '..', '..');
const sidecarSource = readFileSync(path.join(packagesRoot, 'sidecar', 'src', 'protocol.ts'), 'utf8');
const mirrorSource = readFileSync(path.join(packagesRoot, 'vscode', 'src', 'sidecar', 'protocol.ts'), 'utf8');

/** The keys of an interface literal, in declaration order. */
function interfaceKeys(source: string, name: string): string[] {
	const start = source.indexOf(`interface ${name} {`);
	ok(start >= 0, `interface ${name} must exist`);
	const end = source.indexOf('\n}', start);
	ok(end > start, `interface ${name} must be closed`);
	return [...source.slice(start, end).matchAll(/^\t([A-Za-z]+)\??:/gm)].map((match) => match[1]);
}

/** The `type: '…'` literals of a message union: from its declaration to the encoder that follows it. */
function messageKinds(source: string, marker: string): string[] {
	const start = source.indexOf(marker);
	ok(start >= 0, `${marker} must exist`);
	const end = source.indexOf('encode', start);
	ok(end > start, `${marker} must be followed by the encoder`);
	const section = source.slice(start, end);
	return [...new Set([...section.matchAll(/type: '([a-z-]+)'/g)].map((match) => match[1]))].sort();
}

/** The literals of the error-code union. */
function errorCodes(source: string): string[] {
	const start = source.indexOf('export type SidecarErrorCode =');
	ok(start >= 0, 'SidecarErrorCode must exist');
	const end = source.indexOf(';', start);
	return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
}

test('the mirrored request methods are exactly the sidecar\u2019s', () => {
	const params = interfaceKeys(sidecarSource, 'ParamByMethod');
	deepStrictEqual(params, interfaceKeys(sidecarSource, 'ResultByMethod'), 'the sidecar\u2019s tables must stay aligned');
	deepStrictEqual(interfaceKeys(mirrorSource, 'RequestByMethod'), params);
	ok(params.length >= 10, 'the method list must not shrink unnoticed');
});

test('the mirrored notification kinds are exactly the sidecar\u2019s', () => {
	const fromSidecar = messageKinds(sidecarSource, 'export type SidecarMessage');
	deepStrictEqual(fromSidecar, ['delta', 'event', 'log', 'ready', 'response', 'ui-request']);
	deepStrictEqual(messageKinds(mirrorSource, 'export type SidecarNotification'), fromSidecar);
});

test('the error codes are the ones the UI reports', () => {
	// The plan's protocol table: two version gates, the coverage self-check, a harness failure, and a
	// catch-all. A code added on one side only would surface as an unhandled branch in the UI.
	const expected = ['bun-version', 'internal', 'sdk-version', 'session', 'tool-coverage'];
	deepStrictEqual(errorCodes(sidecarSource), expected);
	deepStrictEqual(errorCodes(mirrorSource), expected);
});
