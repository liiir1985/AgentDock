/**
 * Pure data model for the Editor Review PoC. No `vscode` import, no I/O:
 * every type here is unit-testable from plain Node.
 *
 * Line convention: 0-based, inclusive. `end < start` encodes an empty range
 * whose position is `start` (used for pure deletions: nothing on the new side).
 */

export type HunkStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

export type AttachSide = 'after' | 'before';

export interface LineRange {
	start: number;
	end: number;
}

export interface Hunk {
	/** 'h1' | 'h2' | ... */
	id: string;
	/** old side, verbatim, without EOL; immutable after creation */
	baselineLines: string[];
	/** new side position inside the current document (0-based, inclusive) */
	targetRange: LineRange;
	/** the line the old-side row borrows, or -1 to prefix line 0; see `computeAnchor` */
	anchorLine: number;
	attachSide: AttachSide;
	status: HunkStatus;
	/** true once the user touched the new side of this hunk */
	userEdited: boolean;
	/** false => frozen: neither reconciled nor rendered anymore */
	tracked: boolean;
}

/** One content change, expressed in 0-based inclusive lines of the document it was applied to. */
export interface HunkChange {
	/** range start line */
	cs: number;
	/** range end line */
	ce: number;
	/** net line delta of this change */
	d: number;
}

export interface TurnChangeSet {
	file: string;
	hunks: Hunk[];
}

/**
 * A whole-line reject plan. Applying it means: replace lines
 * [startLine, endLineExclusive) with `insertedLines`.
 * `endLineExclusive === startLine` is a pure insertion at `startLine`.
 *
 * Whole-line semantics (range starts and ends at column 0) are what makes the
 * plan byte-exact for every hunk shape: re-inserted baseline lines supply their
 * own EOL, so no orphan newline survives at EOF and no blank line appears where
 * an inserted block used to be. A per-line range (start col 0 -> end col of the
 * last line) cannot do this: rejecting a 3-line insertion would leave two blank
 * lines behind.
 */
export interface RejectEdit {
	startLine: number;
	endLineExclusive: number;
	insertedLines: string[];
}

/** Normalises a VS Code content change (or an equivalent line span) into a `HunkChange`. */
export function changeFromText(cs: number, ce: number, text: string): HunkChange {
	let newlines = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			newlines++;
		}
	}
	return { cs, ce, d: newlines - (ce - cs) };
}

/**
 * Anchor rule — where the old side borrows a row, which is all a decoration can do
 * (it cannot create row space, see RESULTS.md P1-P4).
 *
 * - hunk has a new side: borrow the hunk's OWN last line, appending the deleted text
 *   after it (`- old` next to the `+ new` that replaced it). Borrowing the line
 *   above instead glues the deleted block onto unrelated preceding code.
 * - pure deletion (empty new side): borrow the line above the hunk, which is the
 *   closest surviving line to where the deletion happened; at line 0 there is no
 *   line above, so use the `before` side of line 0.
 *
 * MUST be re-run after every `targetRange` mutation.
 */
export function computeAnchor(hunk: Hunk): void {
	if (hunk.targetRange.end >= hunk.targetRange.start) {
		hunk.anchorLine = hunk.targetRange.end;
		hunk.attachSide = 'after';
	} else if (hunk.targetRange.start === 0) {
		hunk.anchorLine = -1;
		hunk.attachSide = 'before';
	} else {
		hunk.anchorLine = hunk.targetRange.start - 1;
		hunk.attachSide = 'after';
	}
}

/** Document-free application of a reject plan; shared by unit tests and by the extension's line math. */
export function applyRejectEdit(lines: string[], edit: RejectEdit): string[] {
	return lines.slice(0, edit.startLine).concat(edit.insertedLines, lines.slice(edit.endLineExclusive));
}
