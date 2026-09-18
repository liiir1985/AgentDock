/**
 * Line diff, then hunk derivation.
 *
 * The PoC hand-wrote its hunks in `sample.patch.json`; the product has to derive
 * them from `baseline + current text` (facts §7 recorded the gap). Sequence:
 * trim the common prefix and suffix — a typical agent edit leaves a tiny middle
 * — run Myers O(ND) on the middle, then group change runs into hunks, merging
 * runs separated by at most `maxGap` equal lines.
 *
 * Two guards keep the pathological case honest instead of expensive:
 *  - `maxEditDistance` caps D, so a whole-file rewrite of a large file stops
 *    being a diff problem;
 *  - the trace costs O(D · (N+M)) ints, so the cap is additionally lowered to
 *    fit `TRACE_BUDGET_BYTES`.
 * Past either cap we emit one whole-middle hunk: a coarser review unit, never a
 * wrong one.
 */

import { LineRange, TextLines, sliceLines, terminatedLines } from './lines';

export type DiffOpKind = 'equal' | 'delete' | 'insert';

export interface DiffOp {
	kind: DiffOpKind;
	/** Where the run starts in the baseline (`equal`/`delete`) or where it is inserted (`insert`). */
	aStart: number;
	/** Where the run starts in the target (`equal`/`insert`) or where it is removed (`delete`). */
	bStart: number;
	count: number;
}

/** Longest run of equal lines that still merges two changes into one hunk. */
export const DEFAULT_MAX_GAP = 3;
export const DEFAULT_MAX_EDIT_DISTANCE = 4096;

const TRACE_BUDGET_BYTES = 32 * 1024 * 1024;
const BYTES_PER_INT = 4;

interface Step {
	kind: DiffOpKind;
	x: number;
	y: number;
}

export function diffLines(a: string[], b: string[], maxEditDistance = DEFAULT_MAX_EDIT_DISTANCE): DiffOp[] {
	if (a.length === 0 && b.length === 0) return [];

	const ops: DiffOp[] = [];
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

	if (prefix > 0) ops.push({ kind: 'equal', aStart: 0, bStart: 0, count: prefix });

	const aMid = a.slice(prefix, a.length - suffix);
	const bMid = b.slice(prefix, b.length - suffix);
	const middle = diffMiddle(aMid, bMid, maxEditDistance);
	if (middle === null) {
		if (aMid.length > 0) ops.push({ kind: 'delete', aStart: prefix, bStart: prefix, count: aMid.length });
		if (bMid.length > 0) ops.push({ kind: 'insert', aStart: prefix + aMid.length, bStart: prefix, count: bMid.length });
	} else {
		for (const op of middle) {
			op.aStart += prefix;
			op.bStart += prefix;
			ops.push(op);
		}
	}

	if (suffix > 0) ops.push({ kind: 'equal', aStart: a.length - suffix, bStart: b.length - suffix, count: suffix });
	return ops;
}

/** `null` means "beyond the cap" — the caller falls back to one coarse replacement. */
function diffMiddle(a: string[], b: string[], maxEditDistance: number): DiffOp[] | null {
	if (a.length === 0 || b.length === 0) {
		const ops: DiffOp[] = [];
		if (a.length > 0) ops.push({ kind: 'delete', aStart: 0, bStart: 0, count: a.length });
		if (b.length > 0) ops.push({ kind: 'insert', aStart: a.length, bStart: 0, count: b.length });
		return ops;
	}
	return myers(a, b, editDistanceCap(a.length + b.length, maxEditDistance));
}

function editDistanceCap(middleLength: number, maxEditDistance: number): number {
	const width = 2 * middleLength + 1;
	const budgetCap = Math.max(1, Math.floor(TRACE_BUDGET_BYTES / (BYTES_PER_INT * width)));
	return Math.min(maxEditDistance, budgetCap);
}

function myers(a: string[], b: string[], dCap: number): DiffOp[] | null {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	const offset = max;
	const v = new Int32Array(2 * max + 1);
	const trace: Int32Array[] = [];

	for (let d = 0; d <= max; d++) {
		if (d > dCap) return null;
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
			else x = v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) return coalesce(backtrack(trace, a, b, d, offset));
		}
	}
	return null;
}

/**
 * `trace[d]` holds the frontier as it stood *before* depth `d` was processed,
 * which is exactly the frontier the step at depth `d` came from.
 */
function backtrack(trace: Int32Array[], a: string[], b: string[], d: number, offset: number): Step[] {
	const reversed: Step[] = [];
	let x = a.length;
	let y = b.length;

	for (let depth = d; depth > 0; depth--) {
		const v = trace[depth];
		const k = x - y;
		const prevK = k === -depth || (k !== depth && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
		const prevX = v[offset + prevK];
		const prevY = prevX - prevK;

		while (x > prevX && y > prevY) {
			reversed.push({ kind: 'equal', x: x - 1, y: y - 1 });
			x--;
			y--;
		}
		if (x === prevX) {
			reversed.push({ kind: 'insert', x, y: y - 1 });
			y--;
		} else {
			reversed.push({ kind: 'delete', x: x - 1, y });
			x--;
		}
	}
	while (x > 0 && y > 0) {
		reversed.push({ kind: 'equal', x: x - 1, y: y - 1 });
		x--;
		y--;
	}
	reversed.reverse();
	return reversed;
}

function coalesce(steps: Step[]): DiffOp[] {
	const ops: DiffOp[] = [];
	for (const step of steps) {
		const last = ops[ops.length - 1];
		if (last && last.kind === step.kind) {
			last.count++;
			continue;
		}
		ops.push({ kind: step.kind, aStart: step.x, bStart: step.y, count: 1 });
	}
	return ops;
}

/** One review unit: an old side, where it came from, and where the new side now is. */
export interface HunkSpec {
	baseline: TextLines;
	baselineRange: LineRange;
	targetRange: LineRange;
}

export function deriveHunks(baseline: TextLines, target: TextLines, maxGap = DEFAULT_MAX_GAP): HunkSpec[] {
	// Rows carry their terminator: a change of line endings is a real change of the file, and a hunk
	// whose region covers those rows is the only thing that can put them back.
	const ops = diffLines(terminatedLines(baseline), terminatedLines(target));
	const specs: HunkSpec[] = [];

	// Open change run, in both coordinate systems, end-exclusive.
	let open = false;
	let aStart = 0;
	let bStart = 0;
	let aEnd = 0;
	let bEnd = 0;

	const flush = () => {
		if (!open) return;
		const baselineRange: LineRange =
			aEnd > aStart ? { start: aStart, end: aEnd - 1 } : { start: aStart, end: aStart - 1 };
		const targetRange: LineRange =
			bEnd > bStart ? { start: bStart, end: bEnd - 1 } : { start: bStart, end: bStart - 1 };
		specs.push({
			baseline: sliceLines(baseline, baselineRange),
			baselineRange,
			targetRange,
		});
		open = false;
	};

	let aIndex = 0;
	let bIndex = 0;
	// Equal rows are held back until another change turns up: `maxGap` merges two changes that are
	// close together, it does not let a hunk swallow the quiet rows *after* its last change. A hunk
	// that claimed unchanged rows would show them as changed and would count a user edit there as an
	// edit to the agent's text.
	let gap = 0;
	for (const op of ops) {
		if (op.kind === 'equal') {
			if (open) {
				if (op.count > maxGap) flush();
				else gap += op.count;
			}
			aIndex += op.count;
			bIndex += op.count;
			continue;
		}
		if (gap > 0) {
			aEnd += gap;
			bEnd += gap;
			gap = 0;
		}
		if (op.kind === 'delete') {
			if (!open) {
				open = true;
				aStart = aIndex;
				bStart = bIndex;
				aEnd = aIndex;
				bEnd = bIndex;
			}
			aIndex += op.count;
			aEnd = aIndex;
			continue;
		}
		if (!open) {
			open = true;
			aStart = aIndex;
			bStart = bIndex;
			aEnd = aIndex;
			bEnd = bIndex;
		}
		bIndex += op.count;
		bEnd = bIndex;
	}
	flush();
	return specs;
}
