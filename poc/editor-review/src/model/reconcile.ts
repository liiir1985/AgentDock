/**
 * Reconciliation decision table for pending hunks.
 *
 * `S = targetRange.start`, `E = targetRange.end` (0-based inclusive; empty new side => `E = S - 1`).
 * Rules are evaluated in order and the first match wins.
 */

import { Hunk, HunkChange, RejectEdit, computeAnchor } from './changeSet';

function isInsideNewSide(change: HunkChange, S: number, E: number): boolean {
	if (E >= S) {
		return change.cs >= S && change.ce <= E;
	}
	// Empty new side: only a pure insertion exactly at S belongs to the hunk.
	return change.cs === S && change.ce === S;
}

/**
 * Returns a new array; never mutates `hunks` or the hunks it contains.
 * Only `status === 'pending' && tracked` hunks are reconciled, everything else passes through.
 */
export function reconcile(hunks: Hunk[], change: HunkChange): Hunk[] {
	return hunks.map((hunk) => {
		if (!hunk.tracked || hunk.status !== 'pending') {
			return hunk;
		}
		const S = hunk.targetRange.start;
		const E = hunk.targetRange.end;

		// 1. change is entirely above the hunk => shift.
		if (change.ce < S) {
			const next: Hunk = { ...hunk, targetRange: { start: S + change.d, end: E + change.d } };
			computeAnchor(next);
			return next;
		}

		// 2. change lives inside the new side => user edited this hunk.
		if (isInsideNewSide(change, S, E)) {
			const next: Hunk = { ...hunk, userEdited: true, targetRange: { start: S, end: E + change.d } };
			computeAnchor(next);
			return next;
		}

		// 3. change is entirely below the hunk => no effect.
		if (change.cs > Math.max(S, E)) {
			return hunk;
		}

		// 4. otherwise the change crosses a hunk boundary: the hunk can no longer be located.
		return { ...hunk, status: 'stale' as const, tracked: false };
	});
}

/**
 * Reject semantics: the whole new side of the hunk becomes the old (baseline) text again,
 * discarding any manual user edit inside that hunk. `null` means "frozen, do nothing".
 *
 * Always a whole-line plan: `[startLine, endLineExclusive)` -> `insertedLines`.
 */
export function rejectEdit(hunk: Hunk): RejectEdit | null {
	if (!hunk.tracked || hunk.status !== 'pending') {
		return null;
	}
	const S = hunk.targetRange.start;
	const E = hunk.targetRange.end;
	return {
		startLine: S,
		endLineExclusive: E < S ? S : E + 1,
		insertedLines: hunk.baselineLines.slice(),
	};
}

/**
 * Expresses a reject plan as a `HunkChange` so the *other* hunks can be shifted
 * after the edit lands. Whole-line plans span `endLineExclusive - startLine` lines
 * but one more newline than a plain content change would, hence the explicit
 * `d` (deriving it from the inserted text would be off by one for every
 * non-empty span).
 */
export function changeFromRejectEdit(plan: RejectEdit): HunkChange {
	const replaced = plan.endLineExclusive - plan.startLine;
	return {
		cs: plan.startLine,
		ce: plan.startLine + Math.max(replaced - 1, 0),
		d: plan.insertedLines.length - replaced,
	};
}

export function staleDiagnostic(): string {
	return '已手动编辑跨越该 hunk 边界，动作已停用（可用 Agent Review: Reset Fixture 重置）';
}
