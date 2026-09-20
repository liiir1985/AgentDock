/**
 * Which Bun the extension runs, and what happens when there is none.
 *
 * The refusal is the point of this file: the exit criterion for the phase is that a machine without Bun
 * gets a clear error instead of a review surface that half works, and that error has to name the
 * install path (and the setting) so the user can act on it.
 */

import test from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';

import {
	BUN_MISSING_MESSAGE,
	BunNotFoundError,
	type BunProbe,
	resolveBun,
} from './bunResolve';

function probe(overrides: Partial<BunProbe> & { installed?: Record<string, string> } = {}): BunProbe {
	const installed = overrides.installed ?? {};
	return {
		configured: overrides.configured ?? '',
		exists: overrides.exists ?? ((candidate) => candidate in installed),
		version: overrides.version ?? ((command) => installed[command]),
		homeCandidates: overrides.homeCandidates ?? (() => []),
	};
}

test('the setting wins, and a wrong path is an error rather than a silent fallback', () => {
	const found = resolveBun(probe({ configured: 'D:\\tools\\bun.exe', installed: { 'D:\\tools\\bun.exe': '1.4.2' } }));
	deepStrictEqual(found, { command: 'D:\\tools\\bun.exe', source: 'setting', version: '1.4.2' });

	try {
		resolveBun(probe({ configured: 'D:\\tools\\missing.exe', installed: { bun: '1.4.2' } }));
		throw new Error('expected the missing configured path to be an error');
	} catch (error) {
		strictEqual(error instanceof BunNotFoundError, true);
		strictEqual((error as BunNotFoundError).configuredPath, 'D:\\tools\\missing.exe');
		strictEqual((error as Error).message.includes('D:\\tools\\missing.exe'), true);
	}
});

test('PATH is tried before the installer location', () => {
	const found = resolveBun(
		probe({
			installed: { bun: '1.4.2', '/home/u/.bun/bin/bun': '1.3.14' },
			homeCandidates: () => ['/home/u/.bun/bin/bun'],
		}),
	);
	deepStrictEqual(found, { command: 'bun', source: 'path', version: '1.4.2' });
});

test('the installer location is the last resort', () => {
	const found = resolveBun(
		probe({ installed: { '/home/u/.bun/bin/bun': '1.4.2' }, homeCandidates: () => ['/home/u/.bun/bin/bun'] }),
	);
	deepStrictEqual(found, { command: '/home/u/.bun/bin/bun', source: 'home', version: '1.4.2' });
});

test('nothing found is a refusal that names the requirement, the hint and the setting', () => {
	try {
		resolveBun(probe({ homeCandidates: () => ['/home/u/.bun/bin/bun'] }));
		throw new Error('expected the search to fail');
	} catch (error) {
		const message = (error as Error).message;
		strictEqual(message, BUN_MISSING_MESSAGE);
		strictEqual(message.includes('Bun ≥ 1.3.14'), true);
		strictEqual(message.includes('https://bun.sh/install'), true);
		strictEqual(message.includes('agentdock.bunPath'), true);
	}
});

test('a `bun` that cannot report a version is not evidence, so the search continues', () => {
	// `spawnSync` cannot tell "not installed" from "installed but silent", and a candidate we cannot run
	// is not a candidate: falling through to the installer location is the only answer that never
	// reports a command we have not seen work.
	const found = resolveBun(
		probe({
			installed: { '/home/u/.bun/bin/bun': '1.4.2' },
			exists: (candidate) => candidate === 'bun' || candidate === '/home/u/.bun/bin/bun',
			homeCandidates: () => ['/home/u/.bun/bin/bun'],
		}),
	);
	deepStrictEqual(found, { command: '/home/u/.bun/bin/bun', source: 'home', version: '1.4.2' });
});
