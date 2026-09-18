/**
 * T2 command-line intent (D41 / D43).
 *
 * The annotation sets are the contract: every row is a command the adapter will
 * really see, paired with the paths Reject would restore if that change were
 * rejected. Both failure directions are pinned here — a command called reliable but
 * mis-read (Reject then writes back a file the agent never touched) and an unknown
 * command answered "reliable, no paths", which the caller reads as "changes
 * nothing". The dialect is part of every assertion, because the same text means
 * different things in different shells and the parser is never allowed to guess it.
 */

import test from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCommandIntent, ShellDialect } from '../shell/intent';

interface FixtureRow {
	command: string;
	reliable: boolean;
	paths: string[];
}

const DIALECTS: readonly ShellDialect[] = ['bash', 'powershell', 'cmd'];

/**
 * `tsc` emits no `.json` beside its output, so the source tree is the fixture home.
 * The `__dirname` lookup stays first in case a copy step is ever added.
 */
const FIXTURE_DIRS: readonly string[] = [
	join(__dirname, 'fixtures', 'shell'),
	join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'shell'),
];

function loadFixtures(dialect: ShellDialect): FixtureRow[] {
	for (const dir of FIXTURE_DIRS) {
		const file = join(dir, `${dialect}.json`);
		if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as FixtureRow[];
	}
	throw new Error(`no annotation set for dialect '${dialect}'`);
}

for (const dialect of DIALECTS) {
	test(`${dialect}: every annotated command answers exactly as annotated`, () => {
		for (const row of loadFixtures(dialect)) {
			deepStrictEqual(parseCommandIntent(row.command, dialect), { paths: row.paths, reliable: row.reliable }, row.command);
		}
	});

	test(`${dialect}: an unreliable answer never carries paths`, () => {
		for (const row of loadFixtures(dialect)) {
			if (row.reliable) continue;
			strictEqual(row.paths.length, 0, `annotation for '${row.command}'`);
			const answer = parseCommandIntent(row.command, dialect);
			strictEqual(answer.reliable, false, row.command);
			deepStrictEqual(answer.paths, [], row.command);
		}
	});
}

test('a write set that is only a device target is unreliable, not empty-and-fine', () => {
	// The device is dropped because no file changes, but the answer cannot be
	// "reliable with no paths": that reads as "this command changes nothing", and the
	// caller would then let an unattributed write through. `cmd: del nul` in the
	// annotation set pins the same rule from the other direction.
	deepStrictEqual(parseCommandIntent('echo hi > /dev/null', 'bash'), { paths: [], reliable: false });
	deepStrictEqual(parseCommandIntent('echo hi > nul', 'cmd'), { paths: [], reliable: false });
	// Only the device is dropped; the real file next to it still counts.
	deepStrictEqual(parseCommandIntent('del nul build\\out.js', 'cmd'), { paths: ['build/out.js'], reliable: true });
});

test('an unknown command is unreliable, never a reliable command with no paths', () => {
	// `frobnicate` is not a writer in any dialect, and the target after the
	// redirection is a perfectly good path in each of them: the refusal has to come
	// from the name, otherwise the caller sees "this line changes nothing".
	deepStrictEqual(parseCommandIntent('frobnicate > build/out.js', 'bash'), { paths: [], reliable: false });
	deepStrictEqual(parseCommandIntent('frobnicate > build/out.js', 'powershell'), { paths: [], reliable: false });
	deepStrictEqual(parseCommandIntent('frobnicate > build\\out.js', 'cmd'), { paths: [], reliable: false });
});

test('a read-only emitter needs the redirection that makes it a writer', () => {
	deepStrictEqual(parseCommandIntent('cat header.txt > build/bundle.ts', 'bash'), { paths: ['build/bundle.ts'], reliable: true });
	deepStrictEqual(parseCommandIntent('cat header.txt', 'bash'), { paths: [], reliable: false });
});

test('the dialect is required and never guessed from the command text', () => {
	// D43: the adapter knows which shell it is about to run, so the same line is read
	// in that shell's terms only — bash sees a write where cmd sees a name it does not
	// know, and the other way round.
	deepStrictEqual(parseCommandIntent('rm -rf build/out.js', 'bash'), { paths: ['build/out.js'], reliable: true });
	deepStrictEqual(parseCommandIntent('rm -rf build/out.js', 'cmd'), { paths: [], reliable: false });
	deepStrictEqual(parseCommandIntent('del /q build\\out.js', 'cmd'), { paths: ['build/out.js'], reliable: true });
	deepStrictEqual(parseCommandIntent('del /q build\\out.js', 'bash'), { paths: [], reliable: false });
});
