/**
 * The turn ledger: the IDE-side state machine (D2 / D15).
 *
 * `record` is the only entry point for agent writes and it is deliberately three steps long:
 *  1. whatever the harness says it saw *before* the write may differ from what we last knew about
 *     that path (a second agent, a tool we do not wrap, a user edit we missed). Those bytes are
 *     attributed to the user first, so the agent's own edit is reconciled on top of the document as
 *     it really is;
 *  2. the agent's edit is reconciled against the hunks we already have, which is what keeps hunk
 *     identity stable across several writes to one file in one turn;
 *  3. when the write changed the path's *net shape* (created, deleted, restored), the hunks are
 *     rebuilt from scratch instead — reconciling a shape change would leave ranges that describe
 *     text nobody has any more.
 *
 * The ledger is a plain in-memory object: no clock, no random ids, no I/O. Replaying the same
 * script into two ledgers has to produce byte-identical sessions (exit criterion).
 */

import { BaselineLedger, SnapshotPolicy } from './baseline';
import { deriveFileChanges, validateObservedWrite } from './derive';
import { TextLines, joinLines } from './lines';
import { ChangeSet, FileChange, FileChangeKind, ObservedWrite, Session, Turn } from './model';
import { applyEdits, diffToEdits } from './reconcile';

interface Entry {
	file: FileChange;
	/** The path the baseline text was captured at; a rename moves `file.path` away from it. */
	baselinePath: string;
	/** What we believe the file contains right now — the base of the next diff. */
	lastKnown: TextLines;
}

const EMPTY: TextLines = { lines: [], eols: [] };

export class TurnLedger {
	private readonly entries: Entry[] = [];
	private readonly known = new Map<string, TextLines>();
	private readonly baselineCache: BaselineLedger;
	private readonly state: Session;
	private open: Turn | null = null;

	constructor(sessionId: string, policy: SnapshotPolicy) {
		this.state = { id: sessionId, turns: [] };
		this.baselineCache = new BaselineLedger(policy);
	}

	/** 1-based turn index; everything recorded until `endTurn` belongs to it. */
	beginTurn(): number {
		this.entries.length = 0;
		// Baselines are per turn: the second write to a path in the *same* turn must not move the
		// baseline past the first one, while the next turn needs its own.
		this.baselineCache.clear();
		const index = this.state.turns.length + 1;
		this.open = { index, changeSet: null };
		this.state.turns.push(this.open);
		return index;
	}

	/** A T1/T2 write: baseline at first touch, reconcile on every later touch. */
	record(write: ObservedWrite): Turn {
		validateObservedWrite(write);
		const turn = this.requireTurn();
		// A rename is the same file under a new name, so it has to find the entry recorded under the
		// old one instead of opening a second entry for a file that no longer exists there.
		const entry = this.entries.find(
			(candidate) => candidate.file.path === write.path || candidate.file.path === write.fromPath,
		);

		if (!entry) {
			// First touch in this turn: there is no geometry to preserve, so the write is derived as-is.
			const file = deriveFileChanges([write])[0];
			if (file) {
				if (write.before !== null) this.baselineCache.capture(write.path, write.before);
				this.entries.push({
					file,
					baselinePath: write.fromPath ?? write.path,
					lastKnown: write.after ?? EMPTY,
				});
			}
			this.remember(write.path, write.fromPath, write.after ?? EMPTY);
			return this.publish(turn);
		}

		// 1. Bytes we did not put there.
		if (write.before !== null && !sameText(entry.lastKnown, write.before)) {
			this.reconcile(entry, write.before, 'user');
		}

		const baseline = entry.file.baseline;
		const movedFrom = write.fromPath ?? entry.file.fromPath;
		// A file that ends the turn under its own original name is not a rename any more, whichever way
		// round it travelled to get back there.
		const kind: FileChangeKind = movedFrom === undefined || write.path === entry.baselinePath ? 'modify' : 'rename';
		const fromPath = kind === 'rename' ? movedFrom : undefined;
		const shape = { path: write.path, fromPath, kind };

		// 2. Created and then removed inside one turn: the path ends where it started, so it does not
		//    belong in the change set at all.
		if (baseline === null && write.after === null) {
			this.entries.splice(this.entries.indexOf(entry), 1);
			this.known.set(write.path, EMPTY);
			return this.publish(turn);
		}

		// 3. Same shape at both ends of the turn: reconcile, so hunk ids and user verdicts survive.
		if (baseline !== null && write.after !== null && write.before !== null) {
			const applied = applyEdits(entry.file, write.before, diffToEdits(write.before, write.after), 'agent');
			entry.file = { ...applied.file, ...shape };
			entry.lastKnown = applied.after;
			this.remember(write.path, write.fromPath, write.after);
			return this.publish(turn);
		}

		// 4. Net shape changed (created, deleted, or the path reappeared), so the hunks are derived
		//    again from the turn's own baseline: only that derivation knows the whole truth. A file
		//    that is gone is recorded against the path the baseline was taken at — that is where a
		//    Reject has to put it back.
		const rebuilt = deriveFileChanges([
			{
				...shape,
				path: baseline === null || write.after !== null ? write.path : entry.baselinePath,
				kind: baseline === null ? 'create' : write.after === null ? 'delete' : kind,
				before: baseline,
				after: write.after,
				attribution: write.attribution,
			},
		])[0];
		if (!rebuilt) this.entries.splice(this.entries.indexOf(entry), 1);
		else entry.file = rebuilt;
		entry.lastKnown = write.after ?? EMPTY;
		this.remember(write.path, write.fromPath, write.after ?? EMPTY);
		return this.publish(turn);
	}

	/** An edit the user (or an external tool) made to a document we already track. */
	recordUserEdit(path: string, after: TextLines): Turn {
		return this.reconcileKnown(path, after);
	}

	/**
	 * The D19 reopen path: a change on a path we track but did not attribute. Identical to
	 * `recordUserEdit` — the model does not care which door the change came through, only that a hunk
	 * which can no longer be located ends as `rejected(conflict)` rather than silently moving.
	 */
	reconcileOpen(path: string, after: TextLines): Turn {
		return this.reconcileKnown(path, after);
	}

	/** The text we believe a tracked path holds; the host renders and diffs against this. */
	lastKnown(path: string): TextLines | undefined {
		return this.known.get(path);
	}

	/** The exact pre-image captured at first touch, when the policy allowed one (D37/D39). */
	baseline(path: string): TextLines | undefined {
		return this.baselineCache.get(path);
	}

	current(): Turn {
		return this.requireTurn();
	}

	endTurn(): Turn {
		const turn = this.requireTurn();
		this.open = null;
		return turn;
	}

	session(): Session {
		return this.state;
	}

	private reconcileKnown(path: string, after: TextLines): Turn {
		const turn = this.requireTurn();
		const entry = this.entries.find((candidate) => candidate.file.path === path);
		if (entry) this.reconcile(entry, after, 'user');
		// A path we have no change model for still has a text, and remembering it is what keeps the
		// next write's diff (and its `before` comparison) honest.
		this.known.set(path, after);
		return this.publish(turn);
	}

	private reconcile(entry: Entry, after: TextLines, origin: 'user' | 'agent'): void {
		const applied = applyEdits(entry.file, entry.lastKnown, diffToEdits(entry.lastKnown, after), origin);
		entry.file = applied.file;
		entry.lastKnown = applied.after;
	}

	private remember(path: string, fromPath: string | undefined, text: TextLines): void {
		if (fromPath !== undefined && fromPath !== path) this.known.delete(fromPath);
		this.known.set(path, text);
	}

	private publish(turn: Turn): Turn {
		const files = this.entries.map((entry) => entry.file);
		const changeSet: ChangeSet | null = files.length > 0 ? { turn: turn.index, files } : null;
		turn.changeSet = changeSet;
		return turn;
	}

	private requireTurn(): Turn {
		if (!this.open) throw new Error('beginTurn() must be called before recording changes');
		return this.open;
	}
}

function sameText(a: TextLines, b: TextLines): boolean {
	return joinLines(a) === joinLines(b);
}
