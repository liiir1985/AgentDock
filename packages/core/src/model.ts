/**
 * The change model: `Session → Turn → ChangeSet → FileChange → Hunk`.
 *
 * Host-agnostic by construction — no `vscode`, no I/O (D22). Everything the
 * editor, the ledger and the revert executor need is expressed here so the same
 * objects can be unit-tested from plain Node.
 *
 * Two deliberate differences from the PoC:
 *  - `Hunk.baseline` is `TextLines`, not `string[]` — Reject must restore bytes,
 *    not just text (see `lines.ts`).
 *  - `stale` is gone (D19). A hunk the user edits across is either re-applied or
 *    ends as `rejected` with `reason: 'conflict'`, so the state machine stays a
 *    two-outcome one: `pending → accepted | rejected`.
 */

import { LineRange, TextLines } from './lines';

/**
 * How early and how certainly we learn about a write (D37). Ordering is
 * meaningful: `own` and `blocking-hook` both snapshot *before* the bytes land
 * and therefore yield an exact baseline; everything below them does not.
 *
 * Whether a hook can also *rewrite* the tool input is deliberately not part of
 * the level — the IDE only needs a snapshot, never a rewrite (D44).
 */
export type InterceptLevel = 'own' | 'blocking-hook' | 'async-signal' | 'post-hoc' | 'none';

/**
 * Attribution tiers (D42). T1 is a hard adapter contract; T2 is best effort and
 * may skip a command entirely; T3 is never recorded, so it never reaches a
 * ChangeSet.
 */
export type AttributionTier = 'T1' | 'T2';

export interface Attribution {
	tier: AttributionTier;
	/** Tool name (T1) or the command line (T2) the change was attributed to. */
	source: string;
	level: InterceptLevel;
}

/**
 * `pending` is undecided; `accepted` and `rejected` are terminal (D26: Accept writes nothing, so
 * only Reject has anything left to do).
 *
 * "Kept, but the text is the user's rather than the agent's" is deliberately *not* a fourth value —
 * it is `accepted` together with `Hunk.userEdited`, and `hunkKeepsUserText` names that combination so
 * that no consumer has to remember it. The distinction has to survive an Accept: D3 requires the
 * agent to be told, next turn, which of its changes the human rewrote, and a plain `accepted` hunk
 * is not worth telling anyone about.
 */
export type HunkStatus = 'pending' | 'accepted' | 'rejected';

/** Only meaningful when `status === 'rejected'`. */
export type RejectReason = 'user' | 'conflict';

export interface Hunk {
	/** Stable within a turn: `h1`, `h2`, ... Reconcile shifts hunks, it never renumbers. */
	id: string;
	/** The old side, verbatim including terminators — what Reject restores. */
	baseline: TextLines;
	/** Where the old side came from in the baseline (empty when this is a pure insertion). */
	baselineRange: LineRange;
	/** The new side's position in the *current* document (empty when this is a pure deletion). */
	targetRange: LineRange;
	/** Which row the old side hangs off (D11: the anchor is model data, not a renderer detail). */
	anchor: HunkAnchor;
	status: HunkStatus;
	rejectReason?: RejectReason;
	/**
	 * An edit that was not the agent's landed inside the new side.
	 *
	 * What that means depends on the status. While `pending`: rejecting the hunk restores the old side
	 * over the user's text too, so the user has to be warned (D3). Once `accepted`: the decision kept a
	 * new side that the user had rewritten, which is the outcome the feedback loop reports.
	 *
	 * It stays true for the rest of the turn, and it is as precise as the model can be: whether those
	 * bytes are still there is answered by comparing the region's current text with what the agent
	 * wrote, which is exactly what the feedback payload does.
	 */
	userEdited: boolean;
}

/** Whether an edit was made by the agent (inside its own turn) or by the human/external tools. */
export type EditOrigin = 'agent' | 'user';

/** One document mutation, in the coordinate system of the document *before* it. */
export interface DocEdit {
	/** First replaced line. */
	cs: number;
	/** Last replaced line, inclusive; `ce < cs` is a pure insertion at `cs`. */
	ce: number;
	/** Replacement content, verbatim (terminators included). */
	inserted: TextLines;
}

/** Where the old side is drawn in the *current* document (D11). */
export interface HunkAnchor {
	/** Line the old-side row borrows; `-1` attaches to the `before` side of line 0. */
	line: number;
	side: 'before' | 'after';
}

/** A file-level operation the host must perform (Reject of create/delete/rename, or `revertTo`). */
export type FileOp =
	| { kind: 'write'; path: string; text: TextLines }
	| { kind: 'delete'; path: string }
	| { kind: 'rename'; from: string; to: string };

/**
 * One write the host observed (T1 tool interception, or T2 shell best effort), with the texts it
 * captured. This is the input to the change model: everything else is derived from it.
 */
export interface ObservedWrite {
	/** Workspace-relative, POSIX separators; for a rename this is the NEW path. */
	path: string;
	/** Rename only — a real rename, not delete + add. */
	fromPath?: string;
	kind: FileChangeKind;
	/** `null` ⇔ create. */
	before: TextLines | null;
	/** `null` ⇔ delete. */
	after: TextLines | null;
	attribution: Attribution;
}

/**
 * Anchor rule (PoC `changeSet.ts:92-102`) — where the old side borrows a row, which is all a
 * decoration can do.
 *
 * - hunk has a new side: borrow the hunk's OWN last line, appending the deleted text after it.
 *   Borrowing the line above instead glues the deleted block onto unrelated preceding code.
 * - pure deletion: borrow the line above, the closest surviving line to the deletion; at line 0
 *   there is no line above, so use the `before` side of line 0.
 *
 * MUST be re-run (and the result stored on `hunk.anchor`) after every `targetRange` mutation.
 */
export function computeAnchor(hunk: Hunk): HunkAnchor {
	const { start, end } = hunk.targetRange;
	if (end >= start) return { line: end, side: 'after' };
	if (start === 0) return { line: -1, side: 'before' };
	return { line: start - 1, side: 'after' };
}

/**
 * `rename` is a first-class kind rather than delete+add (D6): the review UI and
 * the revert executor both have to move one file, not two.
 */
export type FileChangeKind = 'create' | 'modify' | 'delete' | 'rename';

export interface FileChange {
	kind: FileChangeKind;
	/** Workspace-relative, POSIX separators. For `rename` this is the new path. */
	path: string;
	/** The previous path; only set for `rename`. */
	fromPath?: string;
	/** `null` for `create` (there was no baseline). */
	baseline: TextLines | null;
	hunks: Hunk[];
	attribution: Attribution;
}

/** Everything one agent turn changed. Files are ordered as they were first touched. */
export interface ChangeSet {
	turn: number;
	files: FileChange[];
}

export interface Turn {
	/** 1-based; also the `revertTo` coordinate. */
	index: number;
	/** `null` until the turn produces a change (a pure question changes nothing). */
	changeSet: ChangeSet | null;
}

/** The IDE-side ledger (D2/D15). The adapter owns the conversation; we own this. */
export interface Session {
	id: string;
	turns: Turn[];
}

export function hunkIsActionable(hunk: Hunk): boolean {
	return hunk.status === 'pending';
}

/**
 * The decision kept a new side the user had rewritten, so the text in the document is theirs and not
 * the agent's (D3.3). This is the one terminal outcome the agent has to hear about, and it is the
 * reason `userEdited` outlives the Accept that ends the hunk's life as a review unit.
 */
export function hunkKeepsUserText(hunk: Hunk): boolean {
	return hunk.status === 'accepted' && hunk.userEdited;
}

export function findHunk(files: FileChange[], hunkId: string): Hunk | undefined {
	for (const file of files) {
		for (const hunk of file.hunks) if (hunk.id === hunkId) return hunk;
	}
	return undefined;
}
