/**
 * Reconcile: keep every hunk's geometry truthful while the document changes under it.
 *
 * `Hunk.targetRange` addresses the *current* document, so any edit invalidates it. This module
 * decides, per hunk and in a fixed order, whether the edit shifted the hunk, changed its new side,
 * or crossed its boundary (in which case the hunk is found again by its own surrounding context).
 *
 * `stale` does not exist (D19): a hunk whose content can no longer be located either merges into
 * one bigger review unit (an agent edit — the agent owns the text it just rewrote) or is discarded
 * as `rejected(conflict)` (a user edit — we must not write over what the user typed). Discarding
 * never touches the document.
 *
 * Three invariants shape the code:
 *  - hunks are ordered by position and no two of them claim the same row. Reject restores each
 *    hunk's old side into its own region, so overlapping hunks would overwrite each other and the
 *    byte-for-byte guarantee would be gone;
 *  - a discarded hunk stops claiming rows. Its new side no longer exists in the document, so its
 *    range collapses to a zero-width marker — the honest value for "the new side's position";
 *  - coverage belongs to the origin. The *agent's* edits must all end up inside a hunk, or those
 *    baseline rows are unreachable and Reject can no longer restore the file byte for byte: an agent
 *    edit nobody covers materialises a new hunk, and an agent edit crossing a boundary merges rather
 *    than relocates (relocation finds the surviving part of the hunk and would let the edited part
 *    escape every hunk). The *user's* text outside every hunk must stay outside, because a Reject
 *    that claimed it would delete work nobody asked to delete (D3) — which is why relocation, not
 *    materialisation, is the user-side answer to a boundary crossing.
 */

import { diffLines } from './diff';
import { LineRange, TextLines, replaceRange, sliceLines, terminatedLines } from './lines';
import { DocEdit, EditOrigin, FileChange, Hunk, computeAnchor } from './model';

/** How many equal lines on each side are used to find a hunk again after an edit crossed it. */
export const RELOCATE_CONTEXT = 3;

/** Net line delta of one edit. */
export function editDelta(edit: DocEdit): number {
	const replaced = edit.ce < edit.cs ? 0 : edit.ce - edit.cs + 1;
	return edit.inserted.lines.length - replaced;
}

/**
 * The whole-document diff as edits, ascending by `cs`. Consecutive delete/insert runs collapse into
 * one edit: they are one replacement decision, and splitting them would make a hunk see a deletion
 * and an insertion as two independent boundary crossings.
 *
 * Rows carry their terminators (see `terminatedLines`), so a line-ending change is an edit too, and
 * each edit's `cs`/`ce` address the document *as it stands when that edit is applied* — the caller
 * applies the batch in order.
 */
export function diffToEdits(before: TextLines, after: TextLines): DocEdit[] {
	// Terminator-carrying rows, for the same reason `deriveHunks` uses them: an edit that only changed
	// line endings still changed the bytes, and it has to become an edit here or Reject would leave it
	// behind.
	const ops = diffLines(terminatedLines(before), terminatedLines(after));
	const edits: DocEdit[] = [];
	let aIndex = 0;
	let bIndex = 0;
	// Every emitted edit drifts the rows below it, so a later edit's lines are no longer its own
	// original ones. `cs`/`ce` have to address the document as it stands when that edit is applied —
	// that is what makes applying a batch in order valid, and what makes a position recorded from an
	// edit (`materialize`) meaningful.
	let drift = 0;
	let i = 0;
	while (i < ops.length) {
		const op = ops[i];
		if (op.kind === 'equal') {
			aIndex += op.count;
			bIndex += op.count;
			i++;
			continue;
		}
		const cs = aIndex;
		const bStart = bIndex;
		while (i < ops.length && ops[i].kind !== 'equal') {
			if (ops[i].kind === 'delete') aIndex += ops[i].count;
			else bIndex += ops[i].count;
			i++;
		}
		const inserted = sliceLines(after, { start: bStart, end: bIndex - 1 });
		edits.push({ cs: cs + drift, ce: aIndex - 1 + drift, inserted });
		drift += inserted.lines.length - (aIndex - cs);
	}
	return edits;
}

/**
 * Applies a batch of edits to one file's hunks. `before` is the document as of the previous
 * reconcile; the returned `after` is the document the returned file's ranges address.
 */
export function applyEdits(
	file: FileChange,
	before: TextLines,
	edits: DocEdit[],
	origin: EditOrigin,
): { file: FileChange; after: TextLines } {
	let doc = before;
	let hunks = file.hunks.map((hunk) => ({ ...hunk }));
	for (const edit of edits) {
		const docNext = replaceRange(doc, { start: edit.cs, end: edit.ce }, edit.inserted);
		hunks = applyOneEdit(file, hunks, edit, editDelta(edit), origin, doc, docNext);
		doc = docNext;
	}
	const next: FileChange = { ...file, hunks };
	assertHunksDisjoint(next);
	return { file: next, after: doc };
}

/** Whole-document entry point (D19 reopen path): derives the edits, then reconciles them. */
export function reconcileDocument(
	file: FileChange,
	before: TextLines,
	after: TextLines,
	origin: EditOrigin,
): FileChange {
	return applyEdits(file, before, diffToEdits(before, after), origin).file;
}

/** Invariant guard: hunks are ordered by position and no two of them claim the same row. */
export function assertHunksDisjoint(file: FileChange): void {
	for (let i = 1; i < file.hunks.length; i++) {
		const prev = file.hunks[i - 1];
		const next = file.hunks[i];
		const where = `${file.path}: ${prev.id} ${format(prev.targetRange)} vs ${next.id} ${format(next.targetRange)}`;
		if (next.targetRange.start < prev.targetRange.start) {
			throw new Error(`hunks are not ordered by position (${where})`);
		}
		// A zero-width range sits *before* the row it names, so it claims no rows and can share a start
		// with the hunk below it. Anything else has to end before the next one begins.
		if (prev.targetRange.end < prev.targetRange.start) continue;
		const nextIsMarker = next.targetRange.end < next.targetRange.start;
		const markerAtOurStart = nextIsMarker && next.targetRange.start === prev.targetRange.start;
		if (!(prev.targetRange.end < next.targetRange.start || markerAtOurStart)) {
			throw new Error(`hunks overlap (${where})`);
		}
	}
}

function format(range: LineRange): string {
	return `[${range.start}, ${range.end}]`;
}

type Decision =
	/** The hunk still describes real text; `targetRange` is its position in the post-edit document. */
	| { kind: 'range'; targetRange: LineRange; userEdited: boolean }
	/** The new side is gone and the hunk is discarded; only a marker position survives. */
	| { kind: 'discard'; marker: number }
	/** The hunk cannot be located at all, so it has to merge with everything it now touches. */
	| { kind: 'merge'; union: LineRange };

function applyOneEdit(
	file: FileChange,
	hunks: Hunk[],
	edit: DocEdit,
	d: number,
	origin: EditOrigin,
	doc: TextLines,
	docNext: TextLines,
): Hunk[] {
	// A pure insertion at a position several hunks share cannot belong to all of them, and one row
	// claimed twice is a row Reject would put back twice. Exactly one of them owns it.
	const claimant = insertionClaimant(edit, hunks);
	const decisions = hunks.map((hunk, index) =>
		decide(
			hunk,
			edit,
			d,
			origin,
			doc,
			docNext,
			index === claimant,
			hunks.filter((_, other) => other !== index).map((other) => other.targetRange),
		),
	);

	// Merge groups are collected before anything is rewritten: a merge absorbs every live hunk whose
	// new side touches the edit's union, and the members must vanish together.
	interface Group {
		members: number[];
		union: LineRange;
	}
	const groups = new Map<number, Group>();
	const consumed = new Set<number>();
	for (let i = 0; i < decisions.length; i++) {
		const decision = decisions[i];
		if (decision.kind !== 'merge' || consumed.has(i)) continue;
		const members = [i];
		for (let j = 0; j < hunks.length; j++) {
			if (j === i || consumed.has(j)) continue;
			if (intersects(hunks[j].targetRange, decision.union)) members.push(j);
		}
		// The merged hunk replaces every member, so its range has to be their hull: a member that
		// sticks out past the union would otherwise lose rows it still owns, and Reject could no
		// longer put that text back.
		const union: LineRange = { start: decision.union.start, end: decision.union.end };
		for (const j of members) {
			const range = hunks[j].targetRange;
			union.start = Math.min(union.start, range.start);
			union.end = Math.max(union.end, Math.max(range.start, range.end));
		}
		for (const j of members) consumed.add(j);
		groups.set(Math.min(...members), { members, union });
	}

	const out: Hunk[] = [];
	for (let i = 0; i < hunks.length; i++) {
		const group = groups.get(i);
		if (group) {
			out.push(buildMerged(file, hunks, group.members, group.union, d));
			continue;
		}
		if (consumed.has(i)) continue;
		const decision = decisions[i];
		// A merge decision is always absorbed by its own group above; anything else is standalone.
		if (decision.kind === 'merge') continue;
		out.push(applyDecision(hunks[i], decision));
	}
	// An agent edit that no hunk is even near is a change of its own — the agent's new text — and a
	// change nothing covers is a change Reject cannot undo. A user edit in the same position is
	// theirs to keep, so only the agent materialises one (see the coverage note at the top).
	if (origin === 'agent' && !hunks.some((hunk) => isTouched(hunk, edit))) {
		out.push(materialize(file, hunks, edit));
	}
	// Ordering is part of the model's contract (the renderer walks the list, the guard checks
	// neighbours), and a relocation can place two hunks in either order, so normalise it here. Hunks
	// that share a position are ordered by where their old sides sit in the baseline, which is the
	// order the script put them in.
	out.sort(byPosition);
	return out;
}

function byPosition(a: Hunk, b: Hunk): number {
	return (
		a.targetRange.start - b.targetRange.start ||
		a.baselineRange.start - b.baselineRange.start ||
		a.targetRange.end - b.targetRange.end
	);
}

/**
 * Whether the edit lands on the hunk at all: exactly the negation of rules 1 and 2 ("entirely above"
 * and "entirely below"). A pure insertion at the hunk's first new-side line counts as landing on it,
 * which is how the empty new side of a pure deletion stays consistent with a non-empty one.
 */
function isTouched(hunk: Hunk, edit: DocEdit): boolean {
	const { start: S, end: E } = hunk.targetRange;
	const pureInsertionAtStart = edit.cs === S && edit.ce < edit.cs;
	if (edit.ce < S && !pureInsertionAtStart) return false;
	return !(edit.cs > Math.max(S, E));
}

/**
 * A hunk for text the agent changed and no existing hunk describes. Its old side is the baseline the
 * edited rows came from, so Reject puts back exactly what the edit removed.
 */
function materialize(file: FileChange, hunks: readonly Hunk[], edit: DocEdit): Hunk {
	const baselineRange: LineRange =
		file.baseline === null ? { start: 0, end: -1 } : baselineImage(hunks, edit.cs, edit.ce);
	const made: Hunk = {
		id: nextHunkId(hunks),
		baseline: file.baseline === null ? { lines: [], eols: [] } : sliceLines(file.baseline, baselineRange),
		baselineRange,
		targetRange: { start: edit.cs, end: edit.cs + edit.inserted.lines.length - 1 },
		anchor: { line: 0, side: 'after' },
		status: 'pending',
		userEdited: false,
	};
	made.anchor = computeAnchor(made);
	return made;
}

function nextHunkId(hunks: readonly Hunk[]): string {
	let highest = 0;
	for (const hunk of hunks) {
		const serial = Number.parseInt(hunk.id.slice(1), 10);
		if (Number.isFinite(serial) && serial > highest) highest = serial;
	}
	return `h${highest + 1}`;
}

/**
 * The decision table, first match wins. `S`/`E` are the hunk's new side in the pre-edit document
 * (empty when `E < S`), `d` is the edit's net line delta, and `mayClaimStart` is false when another
 * hunk already claims an insertion at this hunk's first new-side line.
 */
function decide(
	hunk: Hunk,
	edit: DocEdit,
	d: number,
	origin: EditOrigin,
	doc: TextLines,
	docNext: TextLines,
	mayClaimStart: boolean,
	siblings: readonly LineRange[],
): Decision {
	const S = hunk.targetRange.start;
	const E = hunk.targetRange.end;
	// A pure insertion *at* the hunk's first new-side line belongs to the hunk. For a non-empty new
	// side rule 3 already covers it; spelling it out keeps the empty new side (a pure deletion, where
	// `S = E + 1`) on the same side of the boundary instead of being treated as "above" — but only for
	// the one hunk that owns the insertion (see `insertionClaimant`).
	const claimsStart = edit.cs === S && edit.ce < edit.cs && mayClaimStart;
	// A sibling owns the insertion: the deletion point stays where it is, *before* the inserted rows,
	// which is also where its own Reject puts its old side back.
	if (E < S && edit.cs === S && edit.ce < edit.cs && !claimsStart) {
		return { kind: 'range', targetRange: { start: S, end: E }, userEdited: hunk.userEdited };
	}

	// 1. Entirely above the hunk => the hunk moved down by the edit's delta.
	if (edit.ce < S && !claimsStart) {
		return { kind: 'range', targetRange: { start: S + d, end: E + d }, userEdited: hunk.userEdited };
	}
	// 2. Entirely below the hunk => nothing moved.
	if (edit.cs > Math.max(S, E)) {
		return { kind: 'range', targetRange: { start: S, end: E }, userEdited: hunk.userEdited };
	}
	// 3. Inside the new side => the new side grew or shrank by the delta.
	if ((edit.cs >= S && edit.ce <= E) || (E < S && claimsStart)) {
		return { kind: 'range', targetRange: { start: S, end: E + d }, userEdited: hunk.userEdited || origin === 'user' };
	}
	// 4. Crossing a boundary. The agent's own edit has to end up *inside* a hunk (otherwise its
	//    deleted rows are unreachable and Reject cannot be byte-exact), and relocating the hunk would
	//    find only the part that survived — so an agent edit merges. A user edit does get relocated:
	//    their text outside the hunk must stay outside it.
	if (origin === 'user') {
		const moved = relocate(hunk, doc, docNext);
		// A repeated document gives the context more than one home, and one of those homes can be
		// inside another unit. Taking it would make two hunks claim the same rows, so this counts as
		// not having found it at all.
		if (moved && !siblings.some((sibling) => collides(moved, sibling, edit, d))) {
			return { kind: 'range', targetRange: moved, userEdited: true };
		}
		// 5. Not locatable, and the user's edit wins: the hunk is discarded, document untouched.
		if (hunk.status === 'pending') {
			return { kind: 'discard', marker: edit.cs + edit.inserted.lines.length };
		}
	}
	return { kind: 'merge', union: { start: Math.min(S, edit.cs), end: Math.max(E, edit.ce) } };
}

/**
 * Which hunk owns a pure insertion, or `-1` when no hunk is involved at all.
 *
 * A hunk with rows at that position owns it outright. When several *empty* new sides share the
 * position (two deletions at the same point), the last one owns it: Reject applies the replacements
 * first and then inserts the zero-width ones, each landing *before* what the previous one wrote, so
 * the last one in script order has to be the one whose rows end up last.
 */
function insertionClaimant(edit: DocEdit, hunks: readonly Hunk[]): number {
	if (!(edit.ce < edit.cs)) return -1;
	let last = -1;
	for (let index = 0; index < hunks.length; index++) {
		const { start, end } = hunks[index].targetRange;
		if (start > edit.cs || Math.max(start, end) < edit.cs) continue;
		if (end >= start) return index;
		last = index;
	}
	return last;
}

/** Whether a relocated range would land on a sibling, which the edit itself has already moved. */
function collides(moved: LineRange, sibling: LineRange, edit: DocEdit, d: number): boolean {
	const shifted: LineRange =
		edit.ce < sibling.start ? { start: sibling.start + d, end: sibling.end + d } : sibling;
	if (shifted.end < shifted.start) return shifted.start >= moved.start && shifted.start <= moved.end;
	if (moved.end < moved.start) return moved.start >= shifted.start && moved.start <= shifted.end;
	return moved.start <= shifted.end && shifted.start <= moved.end;
}

/**
 * Finds the hunk again in `afterNext` using `RELOCATE_CONTEXT` lines of its own surroundings, taken
 * from `before`. Exactly one candidate must survive — two plausible homes mean we cannot tell where
 * the hunk went, and a wrong guess would make Reject restore text into the wrong place.
 */
function relocate(hunk: Hunk, before: TextLines, afterNext: TextLines): LineRange | null {
	const S = hunk.targetRange.start;
	const E = hunk.targetRange.end;
	const prefix = before.lines.slice(Math.max(0, S - RELOCATE_CONTEXT), S);
	// A pure deletion has nothing on the new side, so its suffix starts at the deletion point itself.
	const suffix = before.lines.slice(E + 1, E + 1 + RELOCATE_CONTEXT);

	const candidates: { p: number; j: number }[] = [];
	for (const start of matchStarts(afterNext.lines, prefix)) {
		const p = start + prefix.length;
		const j = firstMatchAtOrAfter(afterNext.lines, suffix, p);
		if (j === null) continue;
		if (candidates.some((c) => c.p === p && c.j === j)) continue;
		candidates.push({ p, j });
		if (candidates.length > 1) return null;
	}
	if (candidates.length !== 1) return null;

	const { p, j } = candidates[0];
	const own = sliceLines(before, hunk.targetRange);
	// The new side itself is still there => the edit only crossed the boundary, so take it verbatim.
	// Otherwise the user rewrote the new side, and the whole context-between-the-edges region is the
	// hunk (D3: Reject then discards whatever the user put inside a hunk they rejected).
	if (sameLines(afterNext.lines, p, own.lines)) {
		return { start: p, end: p + own.lines.length - 1 };
	}
	return { start: p, end: j - 1 };
}

/** Candidate offsets of `needle` in `lines`; an empty needle matches only at the start. */
function matchStarts(lines: readonly string[], needle: readonly string[]): number[] {
	if (needle.length === 0) return [0];
	const starts: number[] = [];
	for (let i = 0; i + needle.length <= lines.length; i++) {
		if (sameLines(lines, i, needle)) starts.push(i);
	}
	return starts;
}

/** First offset `>= from` where `needle` sits; an empty needle sits at the end of the document. */
function firstMatchAtOrAfter(lines: readonly string[], needle: readonly string[], from: number): number | null {
	if (needle.length === 0) return lines.length;
	for (let i = from; i + needle.length <= lines.length; i++) {
		if (sameLines(lines, i, needle)) return i;
	}
	return null;
}

function sameLines(lines: readonly string[], offset: number, needle: readonly string[]): boolean {
	if (offset < 0 || offset + needle.length > lines.length) return false;
	for (let i = 0; i < needle.length; i++) if (lines[offset + i] !== needle[i]) return false;
	return true;
}

/** Inclusive intersection. An empty range is the point it sits at, so it can touch a neighbour. */
function intersects(a: LineRange, b: LineRange): boolean {
	if (a.end < a.start && b.end < b.start) return a.start === b.start;
	if (a.end < a.start) return b.start <= a.start && a.start <= b.end;
	if (b.end < b.start) return a.start <= b.start && b.start <= a.end;
	return a.start <= b.end && b.start <= a.end;
}

function applyDecision(hunk: Hunk, decision: Exclude<Decision, { kind: 'merge' }>): Hunk {
	if (decision.kind === 'range') {
		const next: Hunk = { ...hunk, targetRange: decision.targetRange, userEdited: decision.userEdited };
		next.anchor = computeAnchor(next);
		return next;
	}
	const marker = decision.marker;
	const next: Hunk = {
		...hunk,
		targetRange: { start: marker, end: marker - 1 },
		status: 'rejected',
		rejectReason: 'conflict',
	};
	next.anchor = computeAnchor(next);
	return next;
}

function buildMerged(
	file: FileChange,
	hunks: Hunk[],
	members: number[],
	union: LineRange,
	d: number,
): Hunk {
	let userEdited = false;
	let first = members[0];
	for (const j of members) {
		const member = hunks[j];
		userEdited = userEdited || member.userEdited;
		if (isEarlier(member.targetRange, hunks[first].targetRange)) first = j;
	}
	// The merged hunk restores the whole union, so its old side has to be *both* the baseline the
	// union's surviving rows came from and the old sides its members already held: a member can have
	// deleted rows that no longer map into the union, and rows inside the union can come from baseline
	// rows outside every member. Either one alone leaves text behind that no hunk can put back.
	// A `create` has no baseline at all: Reject for it is the file-level `delete` op.
	const baselineRange: LineRange =
		file.baseline === null ? { start: 0, end: -1 } : baselineHull(hunks, members, union);
	const merged: Hunk = {
		id: hunks[first].id,
		baseline: file.baseline === null ? { lines: [], eols: [] } : sliceLines(file.baseline, baselineRange),
		baselineRange,
		targetRange: { start: union.start, end: union.end + d },
		anchor: { line: 0, side: 'after' },
		// Reopened on purpose: the user decided on text the agent has since rewritten, so the unit has
		// to be reviewed again. Leaving it terminal would keep a verdict about text that is gone.
		status: 'pending',
		userEdited,
	};
	merged.anchor = computeAnchor(merged);
	return merged;
}

function rangeSize(range: LineRange): number {
	return range.end < range.start ? 0 : range.end - range.start + 1;
}

/**
 * Where a row of the pre-edit document came from in the baseline.
 *
 * Hunks are the only places where the two documents disagree, so summing their size differences
 * above `offset` is exact; everywhere else the documents hold the same rows.
 */
function baselineOffset(hunks: readonly Hunk[], offset: number): number {
	let shift = 0;
	for (const hunk of hunks) {
		if (hunk.targetRange.end >= offset) continue;
		shift += rangeSize(hunk.baselineRange) - rangeSize(hunk.targetRange);
	}
	return offset + shift;
}

/** The baseline rows an (possibly empty) pre-edit region corresponds to. */
function baselineSpan(hunks: readonly Hunk[], start: number, end: number): LineRange {
	const from = baselineOffset(hunks, start);
	return { start: from, end: Math.max(from - 1, baselineOffset(hunks, end + 1) - 1) };
}

/**
 * The baseline rows a region of the document came from, row by row.
 *
 * Deliberately not a span: a hunk sitting at the region's edge can own baseline rows that fall
 * "inside" the span without belonging to the region at all. Claiming them here would restore them
 * twice — once by this hunk and once by the hunk that already holds them.
 */
function baselineImage(hunks: readonly Hunk[], start: number, end: number): LineRange {
	const from = baselineOffset(hunks, start);
	if (end < start) return { start: from, end: from - 1 };
	return { start: from, end: baselineOffset(hunks, end) };
}

/**
 * The baseline a merged unit has to restore: the span its region came from, widened to take in every
 * member's own old side. A member's old side can sit *outside* that span (it deleted rows the region
 * no longer maps onto), and an empty member range contributes no rows at all.
 */
function baselineHull(hunks: readonly Hunk[], members: readonly number[], union: LineRange): LineRange {
	const span = baselineSpan(hunks, union.start, union.end);
	for (const index of members) {
		const old = hunks[index].baselineRange;
		span.start = Math.min(span.start, old.start);
		span.end = Math.max(span.end, old.end);
	}
	return span;
}

function isEarlier(a: LineRange, b: LineRange): boolean {
	return a.start < b.start || (a.start === b.start && a.end < b.end);
}
