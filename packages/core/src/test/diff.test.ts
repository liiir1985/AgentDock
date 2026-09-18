/**
 * Line diff, then hunk derivation.
 *
 * The PoC hand-wrote its hunks in `sample.patch.json`; here they are computed, so a wrong script
 * or a wrong range arrives in the review UI looking perfectly plausible. The failures worth
 * pinning are:
 *
 * - a script that is valid but not minimal, or whose runs do not line up between the two
 *   coordinate systems, makes a one-line edit look like a rewrite (checked against a naive LCS
 *   oracle written here, never in `src/`);
 * - gap merging off by one turns "one review unit" into two, or silently folds an unrelated
 *   change into a hunk the user then rejects;
 * - past the edit-distance cap the honest answer is a coarse hunk covering the whole changed
 *   middle, never a half-diffed one, so the capped paths are asserted by coverage.
 */

import test from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import { DiffOp, deriveHunks, diffLines, DEFAULT_MAX_GAP } from '../diff';
import { LineRange, TextLines, splitLines } from '../lines';
import { mulberry32, mutateLines, randomText, rngInt } from './support';

/** Few enough symbols that equal runs have to be found, not assumed. */
const TINY = ['a', 'b', 'c', 'a', 'b'] as const;

/** Longest common subsequence of two line arrays — the minimal-edit oracle. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
	let previous = new Array<number>(b.length + 1).fill(0);
	for (let i = 1; i <= a.length; i++) {
		const current = new Array<number>(b.length + 1).fill(0);
		for (let j = 1; j <= b.length; j++) {
			current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
		}
		previous = current;
	}
	return previous[b.length];
}

/**
 * Applies a script the way a consumer would, asserting the coordinates stay consistent, and
 * returns what it produced together with the number of changed lines (which minimality pins).
 *
 * The target is the `equal` runs plus the `insert` runs; a `delete` run is dropped from the old
 * side and contributes nothing, which is the whole difference between a script and a patch.
 */
function applyScript(a: readonly string[], b: readonly string[], ops: readonly DiffOp[]): { produced: string[]; edited: number } {
	const produced: string[] = [];
	let ai = 0;
	let bi = 0;
	let edited = 0;

	for (const op of ops) {
		ok(op.count > 0, `an empty ${op.kind} run carries no information`);
		strictEqual(op.aStart, ai, `the ${op.kind} run starts where the old side left off`);
		strictEqual(op.bStart, bi, `the ${op.kind} run starts where the new side left off`);
		if (op.kind === 'equal') {
			deepStrictEqual(a.slice(ai, ai + op.count), b.slice(bi, bi + op.count), 'an equal run is the same on both sides');
			produced.push(...a.slice(ai, ai + op.count));
			ai += op.count;
			bi += op.count;
			continue;
		}
		if (op.kind === 'delete') {
			ai += op.count;
		} else {
			produced.push(...b.slice(bi, bi + op.count));
			bi += op.count;
		}
		edited += op.count;
	}

	strictEqual(ai, a.length, 'the script consumes the whole old side');
	strictEqual(bi, b.length, 'the script consumes the whole new side');
	return { produced, edited };
}

/** The indices of the lines a script reports as changed, in both coordinate systems. */
function changedLines(ops: readonly DiffOp[]): { old: number[]; target: number[] } {
	const old: number[] = [];
	const target: number[] = [];
	let ai = 0;
	let bi = 0;
	for (const op of ops) {
		if (op.kind === 'equal') {
			ai += op.count;
			bi += op.count;
		} else if (op.kind === 'delete') {
			for (let i = 0; i < op.count; i++) old.push(ai + i);
			ai += op.count;
		} else {
			for (let i = 0; i < op.count; i++) target.push(bi + i);
			bi += op.count;
		}
	}
	return { old, target };
}

/** Whether the ranges leave any line of `[start, end]` unreviewed. */
function coversMiddle(ranges: readonly LineRange[], start: number, end: number): boolean {
	const covered = new Set<number>();
	for (const range of ranges) for (let i = range.start; i <= range.end; i++) covered.add(i);
	for (let i = start; i <= end; i++) if (!covered.has(i)) return false;
	return true;
}

/** `l0\nl1\n…` — unique lines, so an equal run is never ambiguous. */
function numberedLines(count: number): string {
	let text = '';
	for (let i = 0; i < count; i++) text += `l${i}\n`;
	return text;
}

test('the script rebuilds the target and changes the fewest possible lines', () => {
	const rng = mulberry32(0xd1ff_0001);

	for (let i = 0; i < 250; i++) {
		const source = randomText(rng, { minLines: 0, maxLines: 9, alphabet: TINY, eols: ['\n', '\r\n'] });
		const a = source.lines;
		// Half of the pairs are near-copies: "delete everything, insert everything" is a valid
		// script, so only the minimality check catches it.
		const b =
			i % 2 === 0
				? randomText(rng, { minLines: 0, maxLines: 9, alphabet: TINY, eols: ['\n', '\r\n'] }).lines
				: mutateLines(rng, source, rngInt(rng, 1, 3)).lines;

		const ops = diffLines(a, b);
		const { produced, edited } = applyScript(a, b, ops);
		deepStrictEqual(produced, b, `iteration ${i}: the script rebuilds the target`);
		strictEqual(
			edited,
			a.length + b.length - 2 * lcsLength(a, b),
			`iteration ${i}: ${JSON.stringify(a)} => ${JSON.stringify(b)} is diffed minimally`,
		);
	}
});

test('each shape of change is one hunk with the exact old and new ranges', () => {
	const BASELINE = 'a\r\nb\nc\rd\ne\r\nf\ng\nh\n';
	const baseline = splitLines(BASELINE);

	const shapes: [string, string, LineRange, LineRange, string[], string[]][] = [
		[
			'pure insertion',
			'a\r\nX\nY\nb\nc\rd\ne\r\nf\ng\nh\n',
			{ start: 1, end: 0 },
			{ start: 1, end: 2 },
			[],
			[],
		],
		['pure deletion', 'a\r\nd\ne\r\nf\ng\nh\n', { start: 1, end: 2 }, { start: 1, end: 0 }, ['b', 'c'], ['\n', '\r']],
		['in-place single line replace', 'a\r\nX\nc\rd\ne\r\nf\ng\nh\n', { start: 1, end: 1 }, { start: 1, end: 1 }, ['b'], ['\n']],
		[
			'multi line replace',
			'a\r\nX\nY\ne\r\nf\ng\nh\n',
			{ start: 1, end: 3 },
			{ start: 1, end: 2 },
			['b', 'c', 'd'],
			['\n', '\r', '\n'],
		],
		['deletion at line 0', 'b\nc\rd\ne\r\nf\ng\nh\n', { start: 0, end: 0 }, { start: 0, end: -1 }, ['a'], ['\r\n']],
		['append at EOF', `${BASELINE}X\nY\n`, { start: 8, end: 7 }, { start: 8, end: 9 }, [], []],
	];

	for (const [name, target, baselineRange, targetRange, lines, eols] of shapes) {
		const hunks = deriveHunks(baseline, splitLines(target));
		strictEqual(hunks.length, 1, `${name}: one review unit`);
		deepStrictEqual(hunks[0].baselineRange, baselineRange, `${name}: old side`);
		deepStrictEqual(hunks[0].targetRange, targetRange, `${name}: new side`);
		// The baseline is carried with the terminators of the document it was sliced from: a
		// `baseline` whose eols were normalised cannot be written back byte for byte.
		deepStrictEqual(hunks[0].baseline.lines, lines, `${name}: baseline lines`);
		deepStrictEqual(hunks[0].baseline.eols, eols, `${name}: baseline eols`);
	}
});

test('two changes are one review unit up to DEFAULT_MAX_GAP equal lines apart', () => {
	const baseline = splitLines(numberedLines(24));
	const twoEdits = (gap: number): TextLines => {
		const lines = baseline.lines.slice();
		lines[2] = 'X';
		lines[2 + gap + 1] = 'Y';
		return { lines, eols: lines.map(() => '\n') };
	};

	for (const gap of [0, DEFAULT_MAX_GAP - 1, DEFAULT_MAX_GAP]) {
		const hunks = deriveHunks(baseline, twoEdits(gap));
		strictEqual(hunks.length, 1, `gap ${gap}: still one unit`);
		deepStrictEqual(hunks[0].baselineRange, { start: 2, end: gap + 3 }, `gap ${gap}: old side`);
		deepStrictEqual(hunks[0].targetRange, { start: 2, end: gap + 3 }, `gap ${gap}: new side`);
		deepStrictEqual(hunks[0].baseline.lines, baseline.lines.slice(2, gap + 4), `gap ${gap}: baseline content`);
	}

	for (const gap of [DEFAULT_MAX_GAP + 1, DEFAULT_MAX_GAP + 2]) {
		const hunks = deriveHunks(baseline, twoEdits(gap));
		strictEqual(hunks.length, 2, `gap ${gap}: split`);
		deepStrictEqual(
			hunks.map(hunk => hunk.baselineRange),
			[
				{ start: 2, end: 2 },
				{ start: gap + 3, end: gap + 3 },
			],
			`gap ${gap}: old sides`,
		);
		deepStrictEqual(
			hunks.map(hunk => hunk.targetRange),
			[
				{ start: 2, end: 2 },
				{ start: gap + 3, end: gap + 3 },
			],
			`gap ${gap}: new sides`,
		);
	}
});

test('a document that did not change produces no hunks', () => {
	const t = splitLines('a\r\nb\nc');

	deepStrictEqual(deriveHunks(t, t), []);
	deepStrictEqual(diffLines([], []), []);
	// Only `equal` runs, so an unchanged write cannot enter a ChangeSet as a whole-file rewrite.
	ok(diffLines(t.lines, t.lines).every(op => op.kind === 'equal'));
});

test('deleting the whole document is one hunk whose new side is empty at line 0', () => {
	const hunks = deriveHunks(splitLines('a\nb\n'), splitLines(''));

	strictEqual(hunks.length, 1);
	deepStrictEqual(hunks[0].baselineRange, { start: 0, end: 1 });
	deepStrictEqual(hunks[0].targetRange, { start: 0, end: -1 });
	deepStrictEqual(hunks[0].baseline.lines, ['a', 'b']);
	deepStrictEqual(hunks[0].baseline.eols, ['\n', '\n']);
});

test('a change of line endings alone is still a change a hunk can undo', () => {
	// Rows are diffed with their terminators, so a line-ending rewrite is a real change of the
	// file and a hunk over that line is the only thing that can put the old bytes back. Diffing
	// bare content would report nothing to review and Reject would leave the rewrite in place.
	const baseline = splitLines('a\r\nb\nc\nd\ne\nf\n');
	const target = splitLines('a\nb\nc\nd\ne\nf\r\n');

	const hunks = deriveHunks(baseline, target);
	strictEqual(hunks.length, 2, 'one hunk per rewritten line ending');
	deepStrictEqual(hunks[0].baselineRange, { start: 0, end: 0 });
	deepStrictEqual(hunks[0].targetRange, { start: 0, end: 0 });
	deepStrictEqual(hunks[0].baseline.eols, ['\r\n'], 'the old terminator travels with the old side');
	deepStrictEqual(hunks[1].baselineRange, { start: 5, end: 5 });
	deepStrictEqual(hunks[1].targetRange, { start: 5, end: 5 });
	deepStrictEqual(hunks[1].baseline.eols, ['\n']);
});

test('repeated calls agree, and a consumed result does not leak into the next call', () => {
	const rng = mulberry32(0x5eed_0002);

	for (let i = 0; i < 25; i++) {
		const source = randomText(rng, { minLines: 0, maxLines: 12, alphabet: TINY, eols: ['\n', '\r\n', '\r'] });
		const a = source.lines;
		const b =
			i % 2 === 0
				? mutateLines(rng, source, 2).lines
				: randomText(rng, { minLines: 0, maxLines: 12, alphabet: TINY, eols: ['\n'] }).lines;
		const oldSide = a.slice();
		const newSide = b.slice();

		const first = diffLines(a, b);
		deepStrictEqual(diffLines(a, b), first, `iteration ${i}: same input, same script`);
		const snapshot = structuredClone(first);
		first.length = 0;
		deepStrictEqual(diffLines(a, b), snapshot, `iteration ${i}: no state hides behind the script`);
		deepStrictEqual(a, oldSide, `iteration ${i}: the old side is not mutated`);
		deepStrictEqual(b, newSide, `iteration ${i}: the new side is not mutated`);

		const baseline: TextLines = { lines: a, eols: a.map(() => '\n') };
		const target: TextLines = { lines: b, eols: b.map(() => '\n') };
		deepStrictEqual(deriveHunks(baseline, target), deriveHunks(baseline, target), `iteration ${i}: same hunks`);
	}
});

test('past the edit-distance cap the script stays valid, just coarser', () => {
	// 'b' and 'c' swap places across the middle of the document, so the real distance is 2 while
	// the cap allows 1. The cap has to degrade to one whole-middle replacement, not to a half
	// diffed script.
	const a = ['a', 'b', 'c', 'd'];
	const b = ['a', 'c', 'b', 'd'];
	const ops = diffLines(a, b, 1);
	const { produced, edited } = applyScript(a, b, ops);

	deepStrictEqual(produced, b);
	strictEqual(edited, 4, 'the middle is replaced wholesale instead of minimally');
	ok(edited > a.length + b.length - 2 * lcsLength(a, b), 'the cap is what made it coarser');
	const changed = changedLines(ops);
	deepStrictEqual(changed.old, [1, 2], 'every old line of the middle is in the change run');
	deepStrictEqual(changed.target, [1, 2], 'every new line of the middle is in the change run');
});

/**
 * Two rewrites with an untouched block in between: diffed exactly, the block is context and stays
 * outside every hunk; diffed coarsely, it is swallowed by the single whole-middle hunk.
 */
function rewritesAroundABlock(size: number, shared: number): { baseline: TextLines; target: TextLines } {
	const oldLines: string[] = [];
	const newLines: string[] = [];
	for (let i = 0; i < size; i++) {
		oldLines.push(`A${i}`);
		newLines.push(`B${i}`);
	}
	for (let i = 0; i < shared; i++) {
		oldLines.push(`S${i}`);
		newLines.push(`S${i}`);
	}
	for (let i = 0; i < size; i++) {
		oldLines.push(`C${i}`);
		newLines.push(`D${i}`);
	}
	return {
		baseline: { lines: oldLines, eols: oldLines.map(() => '\n') },
		target: { lines: newLines, eols: newLines.map(() => '\n') },
	};
}

test('past the trace budget the hunks still cover every line of the changed middle', () => {
	// 1500 rewritten lines per side need an edit distance (~2800) far beyond what the 32 MiB
	// trace budget allows (~1400), so `deriveHunks` has to fall back to the coarse whole-middle
	// hunk. Nothing between the two rewrites may be left unclaimed.
	const big = rewritesAroundABlock(700, 100);
	const hunks = deriveHunks(big.baseline, big.target);
	ok(
		coversMiddle(hunks.map(hunk => hunk.baselineRange), 0, big.baseline.lines.length - 1),
		'every old line is inside a hunk',
	);
	ok(
		coversMiddle(hunks.map(hunk => hunk.targetRange), 0, big.target.lines.length - 1),
		'every new line is inside a hunk',
	);

	// The same shape below the cap is diffed exactly, and there the untouched block is left out —
	// which is precisely what the assertions above would see if the cap stopped applying.
	const small = rewritesAroundABlock(4, 100);
	ok(
		!coversMiddle(
			deriveHunks(small.baseline, small.target).map(hunk => hunk.baselineRange),
			0,
			small.baseline.lines.length - 1,
		),
		'an exact diff leaves the context block between two changes outside every hunk',
	);
});
