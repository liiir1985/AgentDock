/**
 * Byte-exact line geometry.
 *
 * Round-tripping is a hard requirement: the core may only claim "after
 * `reject(all)` the text equals the baseline byte for byte" if split/join
 * preserves mixed line terminators and a missing final terminator. A single
 * normalised `eol` (what the PoC carried in `fixture.ts`) silently rewrites
 * every CRLF file, so each line keeps its own terminator here.
 *
 * Line convention across the core: 0-based, inclusive. `end < start` encodes an
 * empty range positioned at `start` — that is how a pure insertion (nothing on
 * the old side) or a pure deletion (nothing on the new side) is spelled.
 */

export interface LineRange {
	start: number;
	end: number;
}

export interface TextLines {
	/** Line content, verbatim, without its terminator. */
	lines: string[];
	/** `eols[i]` terminates `lines[i]`; `''` for a final line with no terminator. */
	eols: string[];
}

const LF = 0x0a;
const CR = 0x0d;

export function splitLines(text: string): TextLines {
	const lines: string[] = [];
	const eols: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch === LF) {
			lines.push(text.slice(start, i));
			eols.push('\n');
			start = i + 1;
		} else if (ch === CR) {
			if (text.charCodeAt(i + 1) === LF) {
				lines.push(text.slice(start, i));
				eols.push('\r\n');
				i++;
			} else {
				lines.push(text.slice(start, i));
				eols.push('\r');
			}
			start = i + 1;
		}
	}
	if (start < text.length) {
		lines.push(text.slice(start));
		eols.push('');
	}
	return { lines, eols };
}

export function joinLines(t: TextLines): string {
	let out = '';
	for (let i = 0; i < t.lines.length; i++) out += t.lines[i] + (t.eols[i] ?? '');
	return out;
}

/**
 * The terminator the IDE uses when it has to synthesise a line (reject
 * re-insertion, revert). Majority vote, LF on a tie or an empty document: a
 * file with mixed terminators has no single right answer, and LF is the one
 * that does not change meaning for any consumer.
 */
export function dominantEol(t: TextLines): string {
	let lf = 0;
	let crlf = 0;
	let cr = 0;
	for (const eol of t.eols) {
		if (eol === '\n') lf++;
		else if (eol === '\r\n') crlf++;
		else if (eol === '\r') cr++;
	}
	if (crlf > lf && crlf >= cr) return '\r\n';
	if (cr > lf && cr > crlf) return '\r';
	return '\n';
}

/** `[start, end]` inclusive; an empty range yields zero lines. */
export function sliceLines(t: TextLines, range: LineRange): TextLines {
	if (range.end < range.start) return { lines: [], eols: [] };
	const lines = t.lines.slice(range.start, range.end + 1);
	const eols = t.eols.slice(range.start, range.end + 1);
	return { lines, eols };
}

/**
 * Replaces `[range.start, range.end]` with `inserted`, verbatim.
 *
 * One correction is unavoidable: a `''` terminator only means "end of file". Anywhere
 * but the last line of the result it would concatenate two lines, so the dominant
 * terminator of the document being edited is substituted instead.
 */
export function replaceRange(t: TextLines, range: LineRange, inserted: TextLines): TextLines {
	const head = t.lines.slice(0, range.start);
	const headEols = t.eols.slice(0, range.start);
	const tailStart = range.end < range.start ? range.start : range.end + 1;
	const tail = t.lines.slice(tailStart);
	const tailEols = t.eols.slice(tailStart);
	const lines = head.concat(inserted.lines, tail);
	const eols = headEols.concat(inserted.eols, tailEols);
	for (let i = 0; i < eols.length - 1; i++) {
		if (eols[i] === '') eols[i] = dominantEol(t);
	}
	return { lines, eols };
}

/** Insert `lines` at `at`, terminated with `eol`. Used to synthesise new content. */
export function insertLines(t: TextLines, at: number, content: string[], eol: string): TextLines {
	return {
		lines: t.lines.slice(0, at).concat(content, t.lines.slice(at)),
		eols: t.eols.slice(0, at).concat(content.map(() => eol), t.eols.slice(at)),
	};
}

/**
 * Rows as a diff should see them: content plus its own terminator.
 *
 * A diff over bare content cannot see a line-ending change, and Reject restores *bytes*, so an
 * invisible change would survive every Reject — the file would silently never come back to its
 * baseline even though the review said it did.
 */
export function terminatedLines(t: TextLines): string[] {
	return t.lines.map((line, index) => line + (t.eols[index] ?? ''));
}
