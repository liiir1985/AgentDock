/**
 * Accept / Reject as pure plans (D26).
 *
 * Accept never edits the document: it only flips `pending → accepted`, which is what makes Ctrl+Z
 * after Accept a no-op for the file. Reject is the only path that writes, so it returns the write
 * ops instead of performing them.
 *
 * Rejection is per *region*: only the new side of each pending hunk goes back to its baseline, so
 * text the user typed outside every hunk survives a file-level or turn-level Reject.
 */

import { TextLines } from './lines';
import { FileChange, FileOp, Hunk, Turn, hunkIsActionable } from './model';

/** A whole-line replacement, addressed in the document's current coordinates. */
export interface RejectPlan {
	path: string;
	startLine: number;
	/** `endLineExclusive === startLine` is a pure insertion at `startLine`. */
	endLineExclusive: number;
	/** The old side, verbatim: re-inserted lines bring their own terminators, so this is byte-exact. */
	text: TextLines;
}

/** `fileOps` MUST be applied before `plans`. */
export interface RejectOutcome {
	plans: RejectPlan[];
	fileOps: FileOp[];
}

/**
 * A Reject owns the whole outcome — the updated models included — because the status flip and the
 * write ops have to travel together. `rejectHunk`/`rejectFile` return the file they were handed
 * back, `rejectTurn` the turn.
 */
export interface FileRejectOutcome extends RejectOutcome {
	file: FileChange;
}

export interface TurnRejectOutcome extends RejectOutcome {
	turn: Turn;
}

export function acceptHunk(file: FileChange, hunkId: string): FileChange {
	return {
		...file,
		hunks: file.hunks.map((hunk) =>
			hunk.id === hunkId && hunk.status === 'pending'
				? { ...hunk, status: 'accepted' as const, rejectReason: undefined }
				: hunk,
		),
	};
}

export function acceptFile(file: FileChange): FileChange {
	return {
		...file,
		hunks: file.hunks.map((hunk) =>
			hunk.status === 'pending' ? { ...hunk, status: 'accepted' as const, rejectReason: undefined } : hunk,
		),
	};
}

export function acceptTurn(turn: Turn): Turn {
	if (!turn.changeSet) return turn;
	return { ...turn, changeSet: { ...turn.changeSet, files: turn.changeSet.files.map(acceptFile) } };
}

export function rejectHunk(file: FileChange, hunkId: string): FileRejectOutcome {
	const target = file.hunks.find((hunk) => hunk.id === hunkId);
	const pending = target && hunkIsActionable(target) ? [target] : [];
	const outcome = plansFor(file, pending);
	return { file: markRejected(file, pending), plans: outcome.plans, fileOps: outcome.fileOps };
}

export function rejectFile(file: FileChange): FileRejectOutcome {
	const pending = file.hunks.filter(hunkIsActionable);
	const outcome = plansFor(file, pending);
	return { file: markRejected(file, pending), plans: outcome.plans, fileOps: outcome.fileOps };
}

export function rejectTurn(turn: Turn): TurnRejectOutcome {
	if (!turn.changeSet) return { turn, plans: [], fileOps: [] };
	const files: FileChange[] = [];
	const fileOps: FileOp[] = [];
	const plans: RejectPlan[] = [];
	for (const file of turn.changeSet.files) {
		const outcome = rejectFile(file);
		files.push(outcome.file);
		fileOps.push(...outcome.fileOps);
		plans.push(...outcome.plans);
	}
	return { turn: { ...turn, changeSet: { ...turn.changeSet, files } }, fileOps, plans };
}

/**
 * Terminal hunks stay out of the plans on purpose:
 *  - `rejected(conflict)` text is already gone from the document, so writing it back would destroy
 *    whatever the external edit put there;
 *  - `accepted` hunks were never written by us, so nothing is left to roll back — that is what
 *    `revertTo` is for.
 */
function markRejected(file: FileChange, pending: Hunk[]): FileChange {
	if (pending.length === 0) return file;
	const rejected = new Set(pending.map((hunk) => hunk.id));
	return {
		...file,
		hunks: file.hunks.map((hunk) =>
			rejected.has(hunk.id) ? { ...hunk, status: 'rejected' as const, rejectReason: 'user' as const } : hunk,
		),
	};
}

function plansFor(file: FileChange, pending: Hunk[]): RejectOutcome {
	// A rename has to move back before anything is written: afterwards the content lives at the old
	// path, which is where the plans have to address it.
	if (file.kind === 'rename') {
		const contentPath = file.fromPath as string;
		return {
			fileOps: [{ kind: 'rename', from: file.path, to: contentPath }],
			plans: plansIn(pending, contentPath),
		};
	}
	// Creating a file has no old side at all; removing it is the whole Reject.
	if (file.kind === 'create') return { fileOps: [{ kind: 'delete', path: file.path }], plans: [] };
	// Deleting one does: put the baseline back.
	if (file.kind === 'delete') {
		return { fileOps: [{ kind: 'write', path: file.path, text: file.baseline as TextLines }], plans: [] };
	}
	return { fileOps: [], plans: plansIn(pending, file.path) };
}

/**
 * Descending by position: the caller applies the plans in the order they are returned, so each plan
 * still addresses the coordinates it was computed in — no recomputation, no shifting.
 *
 * Two ties need care. At one position, a plan that replaces rows has to go first, because a
 * zero-width insertion before those rows would move them out from under it. And two zero-width plans
 * at the same position are applied in reverse hunk order, since each insertion lands *before* the
 * text the previous one just put down.
 */
function plansIn(pending: Hunk[], path: string): RejectPlan[] {
	return pending
		.map((hunk) => {
			const { start, end } = hunk.targetRange;
			return {
				path,
				startLine: start,
				endLineExclusive: end < start ? start : end + 1,
				text: hunk.baseline,
			};
		})
		.reverse()
		.sort(
			(a, b) =>
				b.startLine - a.startLine ||
				b.endLineExclusive - b.startLine - (a.endLineExclusive - a.startLine),
		);
}
