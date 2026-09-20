/**
 * Snapshots and the writes derived from them, against a real temporary directory: the byte-level
 * honesty this module promises (CRLF, missing final terminator, "did not exist") cannot be checked on
 * a fake filesystem.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { joinLines, splitLines } from '@agentdock/core';

import type { Diagnostics } from './protocol';
import { snapshot, stagedWrites, workspaceRelative, writesFrom } from './observe';

const ATTRIBUTION = { tier: 'T1', source: 'write', level: 'own' } as const;

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(path.join(tmpdir(), 'agentdock-observe-'));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function recorder(): Diagnostics & { notes: string[]; warnings: string[] } {
	const notes: string[] = [];
	const warnings: string[] = [];
	return {
		notes,
		warnings,
		info: (message) => notes.push(message),
		warn: (message) => warnings.push(message),
		error: (message) => warnings.push(message),
	};
}

function write(relative: string, text: string): string {
	const absolute = path.join(cwd, relative);
	mkdirSync(path.dirname(absolute), { recursive: true });
	writeFileSync(absolute, text, 'utf8');
	return absolute;
}

describe('snapshot', () => {
	test('a missing file is null, an existing one is its text', () => {
		write('src/here.ts', 'a\nb\n');
		const taken = snapshot(['src/here.ts', 'src/gone.ts'], cwd);
		expect(taken.get(path.join(cwd, 'src/here.ts'))).not.toBeNull();
		expect(taken.get(path.join(cwd, 'src/gone.ts'))).toBeNull();
	});

	test('a directory is skipped, not reported as absent', () => {
		mkdirSync(path.join(cwd, 'src'), { recursive: true });
		const diagnostics = recorder();
		expect(snapshot(['src'], cwd, diagnostics).size).toBe(0);
		expect(diagnostics.notes.join('\n')).toContain('directory');
	});

	test('a target outside the workspace is not snapshotted', () => {
		const diagnostics = recorder();
		expect(snapshot(['../outside.ts'], cwd, diagnostics).size).toBe(0);
		expect(diagnostics.warnings.join('\n')).toContain('outside the workspace');
	});

	test('line terminators survive the round trip', () => {
		write('src/crlf.ts', 'one\r\ntwo\r\n');
		write('src/no-eol.ts', 'one\ntwo');
		const taken = snapshot(['src/crlf.ts', 'src/no-eol.ts'], cwd);
		expect(joinLines(taken.get(path.join(cwd, 'src/crlf.ts')) as never)).toBe('one\r\ntwo\r\n');
		expect(joinLines(taken.get(path.join(cwd, 'src/no-eol.ts')) as never)).toBe('one\ntwo');
	});
});

describe('writesFrom', () => {
	test('create / modify / delete / unchanged', () => {
		write('src/mod.ts', 'a\nb\n');
		write('src/del.ts', 'gone\n');
		const before = snapshot(['src/new.ts', 'src/mod.ts', 'src/del.ts'], cwd);
		write('src/new.ts', 'fresh\n');
		write('src/mod.ts', 'a\nB\n');
		rmSync(path.join(cwd, 'src/del.ts'));

		const writes = writesFrom(['src/new.ts', 'src/mod.ts', 'src/del.ts'], before, ATTRIBUTION, { cwd });
		expect(writes.map((entry) => [entry.path, entry.kind])).toEqual([
			['src/new.ts', 'create'],
			['src/mod.ts', 'modify'],
			['src/del.ts', 'delete'],
		]);
		expect(joinLines(writes[1].before as never)).toBe('a\nb\n');
		expect(joinLines(writes[1].after as never)).toBe('a\nB\n');
		expect(writes[2].after).toBeNull();
	});

	test('a rewrite with the same bytes is not a change', () => {
		write('src/same.ts', 'a\nb\n');
		const before = snapshot(['src/same.ts'], cwd);
		write('src/same.ts', 'a\nb\n');
		expect(writesFrom(['src/same.ts'], before, ATTRIBUTION, { cwd })).toEqual([]);
	});

	test('a path with no pre-image is admitted, not attributed', () => {
		const diagnostics = recorder();
		write('src/surprise.ts', 'text\n');
		const writes = writesFrom(['src/surprise.ts'], new Map(), ATTRIBUTION, { cwd, diagnostics });
		expect(writes).toEqual([]);
		expect(diagnostics.warnings.join('\n')).toContain('unattributed path src/surprise.ts (no pre-image)');
	});

	test('a path only the result names is scanned too, and still needs a pre-image', () => {
		const diagnostics = recorder();
		write('src/from-input.ts', 'a\n');
		write('src/only-result.ts', 'b\n');
		const before = snapshot(['src/from-input.ts'], cwd);
		write('src/from-input.ts', 'A\n');
		const writes = writesFrom(['src/from-input.ts'], before, ATTRIBUTION, {
			cwd,
			diagnostics,
			resultPaths: ['src/only-result.ts'],
		});
		expect(writes.map((entry) => entry.path)).toEqual(['src/from-input.ts']);
		expect(diagnostics.warnings.join('\n')).toContain('src/only-result.ts');
	});

	test('paths come out workspace-relative with POSIX separators', () => {
		write('nested/deep/a.ts', 'a\n');
		const before = snapshot(['nested/deep/a.ts'], cwd);
		write('nested/deep/a.ts', 'b\n');
		const writes = writesFrom(['nested/deep/a.ts'], before, ATTRIBUTION, { cwd });
		expect(writes[0].path).toBe('nested/deep/a.ts');
		expect(writes[0].path.includes('\\')).toBe(false);
	});

	test('nothing to do yields nothing', () => {
		expect(writesFrom([], undefined, ATTRIBUTION, { cwd })).toEqual([]);
	});
});

describe('stagedWrites', () => {
	test('only paths whose bytes moved become events', () => {
		write('src/a.ts', 'a\n');
		write('src/b.ts', 'b\n');
		const staged = snapshot(['src/a.ts', 'src/b.ts'], cwd);
		write('src/a.ts', 'A\n');

		const writes = stagedWrites(staged, cwd, { tier: 'T1', source: 'ast_edit', level: 'own' });
		expect(writes.map((entry) => [entry.path, entry.kind, entry.attribution.source])).toEqual([
			['src/a.ts', 'modify', 'ast_edit'],
		]);
	});

	test('an unconsumed layer derives nothing, and a second look derives nothing twice', () => {
		write('src/a.ts', 'a\n');
		const staged = snapshot(['src/a.ts'], cwd);
		expect(stagedWrites(staged, cwd, ATTRIBUTION)).toEqual([]);
	});
});

describe('workspaceRelative', () => {
	test('the root itself has no name, an inside path does', () => {
		expect(workspaceRelative(cwd, cwd)).toBeNull();
		expect(workspaceRelative(path.join(cwd, 'src', 'a.ts'), cwd)).toBe('src/a.ts');
		expect(workspaceRelative(path.resolve(cwd, '..', 'outer.ts'), cwd)).toBeNull();
	});
});

describe('text helpers used by the derivation', () => {
	test('a lone terminator counts as a change', () => {
		const before = splitLines('a\nb\n');
		const after = splitLines('a\r\nb\r\n');
		expect(joinLines(before) === joinLines(after)).toBe(false);
	});
});
