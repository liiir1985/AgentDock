/**
 * The host-agnostic gate for the message layer.
 *
 * `src/model/**` is the part of the extension that must stay loadable in plain Node: payload shapes,
 * HTML builders and the tests over them. The package's `tsconfig.json` lists both `node` and
 * `vscode` in `types`, so a stray editor-host import there would compile; the boundary therefore has
 * to be asserted on the source text. Doing it here rather than by folder convention means the next
 * file added under `src/model` is covered without anyone remembering to extend a list.
 */

import test from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const FORBIDDEN = /\bfrom\s+['"]vscode['"]|\brequire\(\s*['"]vscode['"]\s*\)|import\(\s*['"]vscode['"]\s*\)/;

/** This test is compiled into `out/model/`, so the sources sit two levels up. */
const SOURCE_DIR = resolve(__dirname, '..', '..', 'src', 'model');

function sourcesUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...sourcesUnder(path));
			continue;
		}
		if (entry.name.endsWith('.ts')) found.push(path);
	}
	return found;
}

test('the message layer never reaches for the editor host', () => {
	const sources = sourcesUnder(SOURCE_DIR);
	// A scan over an empty tree would pass for the wrong reason, so the set must be non-trivial.
	ok(sources.length >= 2, `expected the message layer to hold at least 2 sources under ${SOURCE_DIR}`);

	const offenders = sources.filter((path) => FORBIDDEN.test(readFileSync(path, 'utf8')));
	strictEqual(offenders.map((path) => relative(SOURCE_DIR, path)).join(', '), '', 'these files pull in the editor host');
});
