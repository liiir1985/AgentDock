/**
 * The one-line activity row the chat panel shows per tool call: `write src/a.ts`.
 *
 * Two things make that row unreadable when left alone - the absolute prefix the agent passes, and OMP's
 * `:12-20` line suffix - and one thing makes shortening it dangerous: the `c:` of a Windows drive looks
 * exactly like a suffix. All three are pinned here, plus the deliberate non-goal: a command string is
 * never rewritten.
 */

import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';

import { activitySummary } from './session';

const CWD = path.resolve(path.sep === '\\' ? 'C:\\work\\proj' : '/work/proj');
const inside = (...parts: string[]): string => path.join(CWD, ...parts);

describe('paths are stated relative to the workspace', () => {
	test('an absolute path inside the workspace loses its prefix', () => {
		expect(activitySummary('write', { path: inside('src', 'a.ts') }, CWD)).toBe('write src/a.ts');
	});

	test('the line suffix stays attached to the path it belongs to', () => {
		expect(activitySummary('edit', { path: `${inside('src', 'a.ts')}:12-20` }, CWD)).toBe('edit src/a.ts:12-20');
	});

	test('an open-ended suffix survives too', () => {
		expect(activitySummary('read', { path: `${inside('seed-a.ts')}:-15` }, CWD)).toBe('read seed-a.ts:-15');
	});

	test('a path outside the workspace is shown as it came', () => {
		const outside = path.join(path.dirname(CWD), 'elsewhere', 'b.ts');
		expect(activitySummary('read', { path: outside }, CWD)).toBe(`read ${outside}`);
	});

	test('the workspace root itself is not rewritten into an empty string', () => {
		expect(activitySummary('glob', { path: CWD }, CWD)).toBe(`glob ${CWD}`);
	});
});

describe('everything else is left alone', () => {
	test('a command is never rewritten, even when it names a path in the workspace', () => {
		expect(activitySummary('bash', { command: `rm -rf ${inside('build')}` }, CWD)).toBe(
			`bash rm -rf ${inside('build')}`,
		);
	});

	test('the first line is all a row shows', () => {
		expect(activitySummary('ast_edit', { input: 'rename a to b\nrename c to d' }, CWD)).toBe('ast_edit rename a to b');
	});

	test('a tool with nothing to summarise is just its name', () => {
		expect(activitySummary('todo', {}, CWD)).toBe('todo');
		expect(activitySummary('read', { path: '' }, CWD)).toBe('read');
	});
});

if (process.platform === 'win32') {
	test('a drive colon is not mistaken for a line suffix', () => {
		expect(activitySummary('read', { path: 'C:\\work\\proj\\seed-a.ts' }, 'C:\\work\\proj')).toBe('read seed-a.ts');
		expect(activitySummary('read', { path: 'C:\\work\\proj\\seed-a.ts' }, 'c:/work/proj')).toBe('read seed-a.ts');
	});
}
