/**
 * Fixture invariants: the shipped fixture must satisfy
 * `applyHunks(baseline) === expected`, and the loader must reject a fixture that
 * does not. The real fixture is loaded from disk here (and by
 * `Agent Review: Validate Fixture`); the negative cases use a temp directory.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { applyHunks, loadFixture } from '../../model/fixture';

const FIXTURE_DIR = path.resolve(__dirname, '../../../fixtures');

/** Temp fixtures are removed when the suite ends, otherwise every run leaks a directory. */
const tempDirs: string[] = [];
after(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

interface TempFixture {
	baseline: string[];
	expected: string[];
	specs: Array<{ id: string; baselineStart: number; baselineCount: number; insert: string[] }>;
}

function writeTempFixture(fixture: TempFixture): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-fixture-'));
	tempDirs.push(dir);
	fs.writeFileSync(path.join(dir, 'sample.ts'), fixture.baseline.join('\n') + '\n', 'utf8');
	fs.writeFileSync(path.join(dir, 'sample.expected.ts'), fixture.expected.join('\n') + '\n', 'utf8');
	fs.writeFileSync(
		path.join(dir, 'sample.patch.json'),
		JSON.stringify({ baselineFile: 'sample.ts', expectedFile: 'sample.expected.ts', hunks: fixture.specs }),
		'utf8',
	);
	return dir;
}

const TEMP_BASELINE = ['A', 'B', 'C'];

test('the shipped fixture is self-consistent and yields the documented hunks', () => {
	const fixture = loadFixture(FIXTURE_DIR);
	assert.deepEqual(
		fixture.hunks.map((hunk) => hunk.id),
		['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
	);
	assert.deepEqual(fixture.targetRanges, [
		{ start: 12, end: 14 },
		{ start: 23, end: 22 },
		{ start: 34, end: 34 },
		{ start: 0, end: -1 },
		{ start: 36, end: 37 },
		{ start: 27, end: 27 },
	]);
	assert.deepEqual(
		fixture.hunks.map((hunk) => [hunk.anchorLine, hunk.attachSide, hunk.status, hunk.tracked]),
		[
			[14, 'after', 'pending', true],
			[22, 'after', 'pending', true],
			[34, 'after', 'pending', true],
			[-1, 'before', 'pending', true],
			[37, 'after', 'pending', true],
			[27, 'after', 'pending', true],
		],
	);
	assert.equal(fixture.baselineLines.length, 38);
	assert.equal(fixture.targetLines.length, 38);
	assert.equal(fixture.eol, '\n');
	assert.deepEqual(
		fixture.hunks.map((hunk) => hunk.baselineLines.length),
		[0, 2, 1, 1, 0, 3],
	);
});

test('a fixture whose expected file disagrees with the patch is rejected', () => {
	const dir = writeTempFixture({
		baseline: TEMP_BASELINE,
		expected: ['A', 'B', 'C'],
		specs: [{ id: 'h1', baselineStart: 1, baselineCount: 0, insert: ['X'] }],
	});
	assert.throws(() => loadFixture(dir), /fixture patch\/expected mismatch/);
});

test('overlapping baseline ranges are rejected before the expected file is compared', () => {
	const dir = writeTempFixture({
		baseline: TEMP_BASELINE,
		expected: ['A', 'B', 'C'],
		specs: [
			{ id: 'h1', baselineStart: 0, baselineCount: 2, insert: ['X'] },
			{ id: 'h2', baselineStart: 1, baselineCount: 2, insert: ['Y'] },
		],
	});
	assert.throws(() => loadFixture(dir), /overlap/);
});

test('target ranges track the accumulated offset of the hunks above', () => {
	assert.deepEqual(
		applyHunks(TEMP_BASELINE, [
			{ id: 'h1', baselineStart: 0, baselineCount: 1, insert: [] },
			{ id: 'h2', baselineStart: 1, baselineCount: 0, insert: ['X', 'Y'] },
			{ id: 'h3', baselineStart: 2, baselineCount: 1, insert: ['Z'] },
		]).targetRanges,
		[
			{ start: 0, end: -1 },
			{ start: 0, end: 1 },
			{ start: 3, end: 3 },
		],
	);
});
