/**
 * The review face: everything the window asks the change model, plus the two write-back seams the
 * verdict path needs. Host-agnostic — no `vscode` import — so the interesting logic stays testable
 * from plain Node.
 *
 * Two rules shape it:
 *  - **the review face is the latest turn per path** (M8). Older turns keep their hunks in the
 *    session, but their coordinates cannot be true at the same time as the newer ones, so rendering
 *    them would mean rendering a lie. Phase 2's "look back at turn N" is where they get their turn;
 *  - **a turn stays open past `turn-end`** (M9). The agent finishing does not close it, so a user edit
 *    arriving afterwards still lands on the hunks of the turn that produced them.
 */

import {
	type FileChange,
	type Hunk,
	type ObservedWrite,
	type Session,
	type SnapshotPolicy,
	type TextLines,
	TurnLedger,
	reconcileDocument,
	sliceLines,
} from '@agentdock/core';

import type { ChangesPayload, FileEntry, HunkPreview } from '../model/webviewMessages';
import { fileStats, formatStats } from '../render/stats';

export interface ReviewEntry {
	path: string;
	/** 1-based turn index the file's hunks belong to. */
	turn: number;
	file: FileChange;
}

export class ReviewStore {
	private readonly ledger: TurnLedger;
	/** What we believe each tracked path contains right now — the base of the next diff. */
	private readonly texts = new Map<string, TextLines>();
	private open = false;

	constructor(sessionId: string, policy: SnapshotPolicy) {
		this.ledger = new TurnLedger(sessionId, policy);
	}

	// --- turn bookkeeping (M9) -------------------------------------------------

	/** A new turn begins; the previous one is ended first so nothing lands in a closed turn. */
	openTurn(): number {
		if (this.open) this.ledger.endTurn();
		this.open = true;
		return this.ledger.beginTurn();
	}

	/**
	 * `turn-end` does **not** close the turn (M9): the user's next edit is still an edit to this turn's
	 * hunks, and the model has no cross-turn reconcile.
	 */
	closeTurn(): void {
		// Intentionally empty; `endTurn` exists for the paths that really must close it.
	}

	endTurn(): void {
		if (!this.open) return;
		this.ledger.endTurn();
		this.open = false;
	}

	/** The adapter's `file-write`: baseline on first touch, reconcile on every later one. */
	record(write: ObservedWrite): void {
		if (!this.open) this.openTurn();
		this.ledger.record(write);
		if (write.fromPath !== undefined && write.fromPath !== write.path) this.texts.delete(write.fromPath);
		const known = this.ledger.lastKnown(write.path);
		if (known !== undefined) this.texts.set(write.path, known);
	}

	// --- the review face ------------------------------------------------------

	/** One entry per path, the latest turn's file, ordered by first appearance. */
	reviewEntries(): ReviewEntry[] {
		const byPath = new Map<string, ReviewEntry>();
		for (const turn of this.session().turns) {
			for (const file of turn.changeSet?.files ?? []) {
				byPath.set(file.path, { path: file.path, turn: turn.index, file });
			}
		}
		return [...byPath.values()];
	}

	entryOf(path: string): ReviewEntry | undefined {
		let found: ReviewEntry | undefined;
		for (const turn of this.session().turns) {
			for (const file of turn.changeSet?.files ?? []) {
				if (file.path === path) found = { path, turn: turn.index, file };
			}
		}
		return found;
	}

	fileOf(path: string): FileChange | undefined {
		return this.entryOf(path)?.file;
	}

	hunksOf(path: string): Hunk[] {
		return this.fileOf(path)?.hunks ?? [];
	}

	hunkOf(path: string, hunkId: string): Hunk | undefined {
		return this.hunksOf(path).find((hunk) => hunk.id === hunkId);
	}

	/** The pending hunks of a path, in position order — the renderer's and the verdict's unit. */
	pendingHunks(path: string): Hunk[] {
		return this.hunksOf(path).filter((hunk) => hunk.status === 'pending');
	}

	hasPendingHunks(): boolean {
		return this.reviewEntries().some((entry) => entry.file.hunks.some((hunk) => hunk.status === 'pending'));
	}

	pendingCount(): number {
		return this.reviewEntries().reduce(
			(total, entry) => total + entry.file.hunks.filter((hunk) => hunk.status === 'pending').length,
			0,
		);
	}

	/** The text we believe a tracked path holds; the renderer and the previews read this. */
	textOf(path: string): TextLines | undefined {
		return this.texts.get(path);
	}

	session(): Session {
		return this.ledger.session();
	}

	// --- write-back -----------------------------------------------------------

	/**
	 * Replace a path's model with one the host produced (a verdict, or a reconcile).
	 *
	 * The ledger's `replaceFile` is the right seam only while the entry's turn is the open one; a
	 * verdict on an older turn has to go straight into the session, because the ledger would not find
	 * the entry and the decision would be silently dropped.
	 */
	replaceFile(file: FileChange, text?: TextLines): void {
		const entry = this.entryOf(file.path);
		const openTurn = this.open ? this.ledger.current().index : undefined;
		if (openTurn !== undefined && entry?.turn === openTurn) this.ledger.replaceFile(file, text);
		else this.writeDirect(file);
		if (text !== undefined) this.texts.set(file.path, text);
	}

	/**
	 * The document changed under the model — a user edit, or the user's side of a hunk. The latest
	 * turn's file is reconciled against it (D19: re-apply if the hunk can be found, discard as
	 * `rejected(conflict)` if it cannot; there is no `stale`).
	 */
	reconcile(path: string, after: TextLines): void {
		const entry = this.entryOf(path);
		const before = this.texts.get(path);
		if (entry !== undefined && before !== undefined) {
			this.replaceFile(reconcileDocument(entry.file, before, after, 'user'), after);
			return;
		}
		// A path with no model still has a text, and remembering it is what keeps the next write's
		// `before` comparison honest.
		this.texts.set(path, after);
	}

	/** Drop a path's base (a deleted or moved-away file has no document to diff against). */
	forget(path: string): void {
		this.texts.delete(path);
	}

	// --- the Changes view payload (D24) ---------------------------------------

	/**
	 * The payload the Changes view renders, built here rather than in the view so it can be tested
	 * without a window.
	 *
	 * The old side is `hunk.baseline` verbatim — it is already the slice of the baseline this hunk
	 * owns, terminators and all, so slicing it again by `baselineRange` would re-apply an offset that
	 * was already applied. The new side is sliced out of the current text at the hunk's target range.
	 */
	changesPayload(): ChangesPayload {
		const files: FileEntry[] = [];
		const totals = { files: 0, pending: 0, added: 0, removed: 0 };
		for (const entry of this.reviewEntries()) {
			const stats = fileStats(entry.file);
			const current = this.texts.get(entry.path);
			const pending = entry.file.hunks.filter((hunk) => hunk.status === 'pending').length;
			files.push({
				path: entry.path,
				stats: formatStats(stats),
				pending,
				hunks: entry.file.hunks.map((hunk) => previewOf(hunk, current)),
			});
			totals.files++;
			totals.pending += pending;
			totals.added += stats.added;
			totals.removed += stats.removed;
		}
		return { files, totals };
	}

	// --- internals ------------------------------------------------------------

	private writeDirect(file: FileChange): void {
		for (const turn of this.session().turns) {
			const files = turn.changeSet?.files;
			if (files === undefined) continue;
			const index = files.findIndex(
				(candidate) => candidate.path === file.path || candidate.path === file.fromPath,
			);
			if (index >= 0) {
				files[index] = file;
				return;
			}
		}
	}
}

function previewOf(hunk: Hunk, current: TextLines | undefined): HunkPreview {
	const { start, end } = hunk.targetRange;
	const add = current === undefined || end < start ? [] : sliceLines(current, hunk.targetRange).lines;
	return {
		id: hunk.id,
		status: hunk.status,
		conflict: hunk.rejectReason === 'conflict',
		userEdited: hunk.userEdited,
		old: [...hunk.baseline.lines],
		add,
	};
}
