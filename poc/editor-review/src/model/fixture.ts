/**
 * Fixture loading and the fixture-side patch application.
 *
 * The fixture is a fixed, hand-written fake agent patch: `sample.ts` (baseline /
 * document on disk), `sample.expected.ts` (baseline + patch), `sample.patch.json`
 * (hunk specs). `applyHunks(baseline) === expected` is asserted at load time —
 * without that invariant every downstream test is meaningless.
 *
 * This module is the only model module that touches the filesystem, so the pure
 * logic (`changeSet.ts`, `reconcile.ts`) stays importable from plain Node.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Hunk, LineRange, computeAnchor } from './changeSet';

export { computeAnchor };

export interface FixtureHunkSpec {
	id: string;
	/** 0-based baseline line index where the old side starts */
	baselineStart: number;
	/** number of baseline lines the patch replaces (0 = pure insertion) */
	baselineCount: number;
	/** new side lines ([] = pure deletion) */
	insert: string[];
}

export interface Fixture {
	baselineLines: string[];
	targetLines: string[];
	expectedLines: string[];
	/** aligned with `specs` (source order), not with baseline order */
	targetRanges: LineRange[];
	specs: FixtureHunkSpec[];
	hunks: Hunk[];
	eol: string;
	baselineText: string;
	targetText: string;
}

export function splitLines(text: string): { lines: string[]; eol: string } {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(/\r?\n/);
	if (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return { lines, eol };
}

/**
 * Applies the hunk specs to the baseline, computing each hunk's new-side range
 * with the accumulated offset of the hunks above it.
 */
export function applyHunks(
	baselineLines: string[],
	specs: FixtureHunkSpec[],
): { targetLines: string[]; targetRanges: LineRange[] } {
	const ordered = specs
		.map((spec, index) => ({ spec, index }))
		.sort((a, b) => a.spec.baselineStart - b.spec.baselineStart);
	const targetRanges: LineRange[] = new Array(specs.length);
	const targetLines: string[] = [];
	let offset = 0;
	let cursor = 0;
	let prevEnd = 0;
	let prevId = '';
	for (const { spec, index } of ordered) {
		if (spec.baselineStart < 0 || spec.baselineCount < 0) {
			throw new Error(`hunk ${spec.id}: negative baselineStart/baselineCount`);
		}
		if (spec.baselineStart + spec.baselineCount > baselineLines.length) {
			throw new Error(`hunk ${spec.id}: baseline range out of bounds`);
		}
		if (spec.baselineStart < prevEnd) {
			throw new Error(`hunks ${prevId} and ${spec.id} overlap on the baseline`);
		}
		const targetStart = spec.baselineStart + offset;
		targetLines.push(...baselineLines.slice(cursor, spec.baselineStart), ...spec.insert);
		targetRanges[index] = { start: targetStart, end: targetStart + spec.insert.length - 1 };
		cursor = spec.baselineStart + spec.baselineCount;
		offset += spec.insert.length - spec.baselineCount;
		prevEnd = spec.baselineStart + spec.baselineCount;
		prevId = spec.id;
	}
	targetLines.push(...baselineLines.slice(cursor));
	return { targetLines, targetRanges };
}

export function loadFixture(fixtureDir: string): Fixture {
	const baselineText = fs.readFileSync(path.join(fixtureDir, 'sample.ts'), 'utf8');
	const expectedText = fs.readFileSync(path.join(fixtureDir, 'sample.expected.ts'), 'utf8');
	const patch = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'sample.patch.json'), 'utf8')) as {
		baselineFile: string;
		expectedFile: string;
		hunks: FixtureHunkSpec[];
	};
	const baseline = splitLines(baselineText);
	const expected = splitLines(expectedText);
	const applied = applyHunks(baseline.lines, patch.hunks);
	if (applied.targetLines.join('\n') !== expected.lines.join('\n')) {
		throw new Error(
			'fixture patch/expected mismatch\n--- patched ---\n' +
				applied.targetLines.join('\n') +
				'\n--- expected ---\n' +
				expected.lines.join('\n'),
		);
	}
	const hunks: Hunk[] = patch.hunks.map((spec, index) => {
		const hunk: Hunk = {
			id: spec.id,
			baselineLines: baseline.lines.slice(spec.baselineStart, spec.baselineStart + spec.baselineCount),
			targetRange: { ...applied.targetRanges[index] },
			anchorLine: 0,
			attachSide: 'after',
			status: 'pending',
			userEdited: false,
			tracked: true,
		};
		computeAnchor(hunk);
		return hunk;
	});
	return {
		baselineLines: baseline.lines,
		targetLines: applied.targetLines,
		expectedLines: expected.lines,
		targetRanges: applied.targetRanges,
		specs: patch.hunks,
		hunks,
		eol: baseline.eol,
		baselineText,
		targetText: applied.targetLines.join(baseline.eol) + baseline.eol,
	};
}
