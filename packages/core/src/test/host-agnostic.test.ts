/**
 * The host-agnostic gate (D22, and one of the phase's exit criteria).
 *
 * The Core must run in plain Node: no `vscode`, not in the sources and not in the shipped
 * artifacts. The compile-time half of the gate is `tsconfig.json`'s `types: ["node"]` (an
 * `import ... from 'vscode'` fails the build); this is the artifact half, which is the one that
 * still works once Phase 1 adds `@types/vscode` to a sibling package.
 */

import test from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const FORBIDDEN = /\bfrom\s+['"]vscode['"]|\brequire\(\s*['"]vscode['"]\s*\)|import\(\s*['"]vscode['"]\s*\)/;

/** Tests may name `vscode` all they like — they are not shipped; the package's code may not. */
const NOT_SHIPPED = ['test', 'node_modules', 'out'];

function packageRoot(): string {
	let dir = __dirname;
	while (!existsSync(join(dir, 'package.json'))) {
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`no package.json above ${__dirname}`);
		dir = parent;
	}
	return dir;
}

function filesUnder(dir: string, extension: string): string[] {
	if (!existsSync(dir)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (NOT_SHIPPED.includes(entry.name)) continue;
			found.push(...filesUnder(path, extension));
			continue;
		}
		if (entry.name.endsWith(extension)) found.push(path);
	}
	return found;
}

test('no shipped source or artifact reaches for vscode', () => {
	const root = packageRoot();
	const sources = filesUnder(join(root, 'src'), '.ts');
	const artifacts = filesUnder(join(root, 'out'), '.js');

	// The compiled output has to be there: this test is part of `npm run check`, which compiles first,
	// and a scan over an empty tree would pass for the wrong reason.
	ok(existsSync(join(root, 'out', 'index.js')), 'out/index.js is missing — run the compile first');
	ok(sources.length > 0 && artifacts.length > 0, 'the scan found nothing to scan');

	const offenders = [...sources, ...artifacts].filter((path) => FORBIDDEN.test(readFileSync(path, 'utf8')));
	strictEqual(offenders.map((path) => relative(root, path)).join(', '), '', 'these files pull in vscode');
});

test('the built package loads in plain Node and exposes its public surface', () => {
	const root = packageRoot();
	// Loading it here is the point: the barrel resolves, nothing reaches for a host at import time,
	// and a headless host gets the same functions the extension will use.
	const core = require(join(root, 'out', 'index.js')) as Record<string, unknown>;
	for (const name of [
		'applyEdits',
		'reconcileDocument',
		'deriveFileChanges',
		'rejectFile',
		'rejectTurn',
		'revertTo',
		'snapshotPolicy',
		'assertCapabilities',
		'assertToolCoverage',
		'TurnLedger',
		'BaselineLedger',
		'parseCommandIntent',
	]) {
		ok(typeof core[name] === 'function', `the barrel must export ${name}`);
	}
});
