/**
 * Path extraction: what we believe a tool is about to touch, and — just as important — what we refuse
 * to believe. Every rule here is a literal case from the plan's step 3.3, because a wrong guess at this
 * layer becomes a Reject that restores bytes nobody asked for.
 */

import { describe, expect, test } from 'bun:test';

import { extractPaths, pathsFromResult } from './intent';
import type { Diagnostics } from './protocol';

const CWD = process.platform === 'win32' ? 'C:\\w' : '/w';

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

describe('write', () => {
	test('a filesystem path is a candidate', () => {
		expect(extractPaths('write', { path: 'src/a.ts', content: 'x' })).toEqual(['src/a.ts']);
	});

	test('internal URLs are not paths', () => {
		const diagnostics = recorder();
		expect(extractPaths('write', { path: 'xd://resolve', content: 'reason' }, diagnostics)).toEqual([]);
		expect(extractPaths('write', { path: 'conflict://1', content: 'x' }, diagnostics)).toEqual([]);
		expect(diagnostics.notes.join('\n')).toContain('xd://resolve');
	});

	test('non-text targets are dropped: a diff of mojibake is still mojibake', () => {
		const diagnostics = recorder();
		expect(extractPaths('write', { path: 'assets/logo.png' }, diagnostics)).toEqual([]);
		expect(extractPaths('write', { path: 'state/cache.db' }, diagnostics)).toEqual([]);
		expect(extractPaths('write', { path: 'bundle.tar.gz' }, diagnostics)).toEqual([]);
		expect(diagnostics.warnings.length).toBe(3);
	});

	test('a target outside the workspace is dropped, not resolved', () => {
		const diagnostics = recorder();
		expect(extractPaths('write', { path: '../outside.ts' }, diagnostics, CWD)).toEqual([]);
		expect(extractPaths('write', { path: 'nested/deep.ts' }, diagnostics, CWD)).toEqual(['nested/deep.ts']);
		expect(diagnostics.warnings.join('\n')).toContain('../outside.ts');
	});

	test('duplicates collapse, order is kept', () => {
		expect(extractPaths('write', { path: 'src/a.ts', file_path: 'src/a.ts' })).toEqual(['src/a.ts']);
	});
});

describe('edit', () => {
	test('path mode names the path and every rename destination', () => {
		expect(
			extractPaths('edit', {
				path: 'src/a.ts',
				edits: [{ diff: '@@\n-x\n+y\n' }, { op: 'update', rename: 'src/b.ts' }],
			}),
		).toEqual(['src/a.ts', 'src/b.ts']);
	});

	test('a replace-mode edit names its path', () => {
		expect(extractPaths('edit', { path: 'src/a.ts', old_string: 'a', new_string: 'b' })).toEqual(['src/a.ts']);
	});

	test('apply_patch input names every file header and the move destination', () => {
		const patch = [
			'*** Begin Patch',
			'*** Add File: hello.txt',
			'+Hello world',
			'*** Update File: src/app.py',
			'*** Move to: src/main.py',
			'@@ def greet():',
			'-print("Hi")',
			'+print("Hello, world!")',
			'*** Delete File: obsolete.txt',
			'*** End Patch',
			'',
		].join('\n');
		expect(extractPaths('edit', { input: patch })).toEqual([
			'hello.txt',
			'src/app.py',
			'src/main.py',
			'obsolete.txt',
		]);
	});

	test('hashline input names the bracketed headers', () => {
		const hashlines = ['[src/a.ts#1a2b]', '@@', '-old', '+new', '', '[src/b.ts#3c4d]', '@@', '-x', '+y', ''].join(
			'\n',
		);
		expect(extractPaths('edit', { input: hashlines })).toEqual(['src/a.ts', 'src/b.ts']);
	});

	test('sloppy input is not parsed: a guess would attribute somebody else\u2019s bytes', () => {
		const diagnostics = recorder();
		const sloppy = ['@@ -1,3 +1,3 @@', ' keep', '-old', '+new', ''].join('\n');
		expect(extractPaths('edit', { input: sloppy }, diagnostics)).toEqual([]);
		expect(diagnostics.warnings.join('\n')).toContain('sloppy');
	});

	test('an unknown tool is never guessed at', () => {
		expect(extractPaths('apply_patch', { path: 'src/a.ts' })).toEqual([]);
		expect(extractPaths('ast_edit', { paths: ['src/a.ts'] })).toEqual([]);
	});
});

describe('pathsFromResult', () => {
	test('reads the several shapes tools use for "the files I touched"', () => {
		expect(pathsFromResult({ files: ['src/a.ts'] })).toEqual(['src/a.ts']);
		expect(pathsFromResult({ fileChanges: [{ path: 'src/a.ts' }] })).toEqual(['src/a.ts']);
		expect(pathsFromResult({ perFileResults: [{ path: 'src/b.ts', sourcePath: 'src/a.ts' }] })).toEqual([
			'src/b.ts',
			'src/a.ts',
		]);
		expect(pathsFromResult({ path: 'src/c.ts', move: 'src/d.ts' })).toEqual(['src/c.ts', 'src/d.ts']);
	});

	test('nothing recognizable yields nothing rather than a placeholder', () => {
		expect(pathsFromResult(undefined)).toEqual([]);
		expect(pathsFromResult({ diff: '@@' })).toEqual([]);
	});
});
