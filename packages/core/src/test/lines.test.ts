/**
 * Byte-exact line geometry.
 *
 * Everything the core claims about "after Reject the document is the baseline again" rests on
 * these functions, and none of their failure modes looks wrong from the outside:
 *
 * - a normalising `splitLines`/`joinLines` rewrites every CRLF or CR-only file while still
 *   producing plausible text, so every round trip is asserted byte for byte — including mixed
 *   terminators in one document, a last line with no terminator, and a document that is nothing
 *   but terminators;
 * - a `''` terminator means "end of file" and is only valid on the last line: `replaceRange`
 *   that leaves one in the middle merges two lines into one, and one that appends a terminator
 *   to the file's unterminated tail rewrites a byte nobody asked it to touch;
 * - `sliceLines`/`replaceRange` mutating the document they were handed would corrupt the
 *   ledger's `lastKnown` copy on the next reconcile, which nothing else in the suite would
 *   notice, so the input is snapshotted before the call it must survive.
 */

import test from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';

import { TextLines, dominantEol, insertLines, joinLines, replaceRange, sliceLines, splitLines, terminatedLines } from '../lines';
import { mulberry32, pick, randomText, rngInt } from './support';

test('split and join are the identity on every terminator mix a real file can carry', () => {
	const cases: [string, string, string[], string[]][] = [
		['pure LF', 'a\nb\nc\n', ['a', 'b', 'c'], ['\n', '\n', '\n']],
		['pure CRLF', 'a\r\nb\r\nc\r\n', ['a', 'b', 'c'], ['\r\n', '\r\n', '\r\n']],
		['pure CR', 'a\rb\rc\r', ['a', 'b', 'c'], ['\r', '\r', '\r']],
		['mixed terminators', 'a\nb\r\nc\rd', ['a', 'b', 'c', 'd'], ['\n', '\r\n', '\r', '']],
		['no final terminator', 'a\nb', ['a', 'b'], ['\n', '']],
		['empty document', '', [], []],
		['only terminators', '\n\r\n\r', ['', '', ''], ['\n', '\r\n', '\r']],
	];

	for (const [name, text, lines, eols] of cases) {
		const t = splitLines(text);
		// `lines` alone would pass a splitter that dropped terminators; `eols` alone would pass one
		// that invented a phantom empty line after a trailing terminator.
		deepStrictEqual(t.lines, lines, `lines of ${name}`);
		deepStrictEqual(t.eols, eols, `eols of ${name}`);
		strictEqual(joinLines(t), text, `round trip of ${name}`);
		deepStrictEqual(splitLines(joinLines(t)), t, `re-split of ${name}`);
		// The rows the diff sees have to reassemble the same bytes, or a change that only touched a
		// line ending could not be reverted.
		strictEqual(terminatedLines(t).join(''), text, `diff rows of ${name}`);
	}
});

test('seeded random documents survive the round trip byte for byte', () => {
	const rng = mulberry32(0x1eaf_5eed);

	// Whole documents, terminators included, from the shared generator.
	for (let i = 0; i < 400; i++) {
		const t = randomText(rng, { minLines: 0, maxLines: 12 });
		deepStrictEqual(splitLines(joinLines(t)), t, `document ${i}`);
	}

	// Raw strings, so the splitter also meets terminator soup no well-formed document contains
	// (consecutive terminators, a lone CR before a CRLF, an unterminated empty last line).
	const pieces = ['a', 'bb', '', '\n', '\r\n', '\r', 'x'] as const;
	for (let i = 0; i < 300; i++) {
		let text = '';
		const count = rngInt(rng, 0, 24);
		for (let j = 0; j < count; j++) text += pick(rng, pieces);
		strictEqual(joinLines(splitLines(text)), text, `raw text ${i}: ${JSON.stringify(text)}`);
	}
});

test('sliceLines keeps the terminators of the lines it keeps and nothing of an empty range', () => {
	const t = splitLines('a\r\nb\nc\rd');

	deepStrictEqual(sliceLines(t, { start: 2, end: 1 }), { lines: [], eols: [] }, 'empty range');
	deepStrictEqual(sliceLines(t, { start: 4, end: 3 }), { lines: [], eols: [] }, 'empty range at EOF');
	deepStrictEqual(sliceLines(t, { start: 1, end: 1 }), { lines: ['b'], eols: ['\n'] }, 'single line');
	deepStrictEqual(
		sliceLines(t, { start: 1, end: 3 }),
		{ lines: ['b', 'c', 'd'], eols: ['\n', '\r', ''] },
		'to the last line',
	);
	// The unterminated last line has to arrive with its `''`, otherwise a caller that re-inserts
	// the slice would add a final terminator the file never had.
	deepStrictEqual(sliceLines(t, { start: 3, end: 3 }), { lines: ['d'], eols: [''] }, 'unterminated tail');
});

test('replaceRange replaces a range verbatim, and an inverted range is a pure insertion', () => {
	const t = splitLines('a\r\nb\r\nc\r\n');

	deepStrictEqual(replaceRange(t, { start: 1, end: 1 }, splitLines('X\r\n')), splitLines('a\r\nX\r\nc\r\n'));
	deepStrictEqual(
		replaceRange(t, { start: 1, end: 0 }, splitLines('X\r\nY\r\n')),
		splitLines('a\r\nX\r\nY\r\nb\r\nc\r\n'),
		'pure insertion',
	);
	deepStrictEqual(replaceRange(t, { start: 1, end: 2 }, splitLines('')), splitLines('a\r\n'), 'pure deletion');
	deepStrictEqual(replaceRange(t, { start: 1, end: 2 }, splitLines('X\r\n')), splitLines('a\r\nX\r\n'), 'tail');
	deepStrictEqual(replaceRange(t, { start: 0, end: 2 }, splitLines('')), { lines: [], eols: [] }, 'everything');
	deepStrictEqual(
		replaceRange(t, { start: 3, end: 2 }, splitLines('X\r\n')),
		splitLines('a\r\nb\r\nc\r\nX\r\n'),
		'append',
	);
});

test('an inserted block that ends without a terminator does not weld the next line onto it', () => {
	// A block sliced from the end of another document carries `''` as its last terminator. Landing
	// it mid-document without correction yields 'a\r\nXb\r\n' — one line where the document has
	// two — so the terminator has to become the dominant one instead.
	const t = splitLines('a\r\nb\r\nc\r\n');
	const out = replaceRange(t, { start: 1, end: 0 }, splitLines('X'));

	deepStrictEqual(out, splitLines('a\r\nX\r\nb\r\nc\r\n'));
	strictEqual(joinLines(out), 'a\r\nX\r\nb\r\nc\r\n');
	// A hardcoded '\n' would leave a CRLF document half-converted.
	deepStrictEqual(
		replaceRange(splitLines('a\nb\r\nc\r\n'), { start: 1, end: 0 }, splitLines('X')),
		splitLines('a\nX\r\nb\r\nc\r\n'),
		'CRLF majority',
	);
	deepStrictEqual(
		replaceRange(splitLines('a\rb\rc\r'), { start: 1, end: 0 }, splitLines('X')),
		splitLines('a\rX\rb\rc\r'),
		'CR majority',
	);
	// One of each is a tie, and a tie means LF.
	deepStrictEqual(
		replaceRange(splitLines('a\nb\r\nc\rd'), { start: 1, end: 0 }, splitLines('X')),
		splitLines('a\nX\nb\r\nc\rd'),
		'no majority',
	);
});

test('replaceRange never mutates its input and never moves the file tail', () => {
	const t = splitLines('a\nb\r\nc');
	const snapshot: TextLines = { lines: t.lines.slice(), eols: t.eols.slice() };
	const text = joinLines(t);

	// Replacing a range that is not the tail: the unterminated last line stays unterminated.
	deepStrictEqual(replaceRange(t, { start: 0, end: 0 }, splitLines('X\n')), splitLines('X\nb\r\nc'));
	// Appending after a terminated last line keeps the appended line's `''`.
	deepStrictEqual(replaceRange(splitLines('a\nb\n'), { start: 2, end: 1 }, splitLines('X')), splitLines('a\nb\nX'));

	strictEqual(joinLines(t), text, 'the input text is not mutated');
	deepStrictEqual(t, snapshot, 'the input document is not mutated');
});

test('insertLines splices lines terminated with the requested eol', () => {
	const t = splitLines('a\nb\n');

	deepStrictEqual(insertLines(t, 0, ['x', 'y'], '\n'), splitLines('x\ny\na\nb\n'), 'at the start');
	deepStrictEqual(insertLines(t, 1, ['x'], '\r\n'), splitLines('a\nx\r\nb\n'), 'in the middle');
	// `at === lines.length` is the append position, not an out-of-range index.
	deepStrictEqual(insertLines(t, t.lines.length, ['x'], '\n'), splitLines('a\nb\nx\n'), 'at the end');
	deepStrictEqual(insertLines(t, 1, [], '\n'), t, 'nothing to insert');
});

test('dominantEol is the majority terminator, and LF when there is no majority', () => {
	strictEqual(dominantEol(splitLines('a\nb\nc\r\n')), '\n', 'LF majority');
	strictEqual(dominantEol(splitLines('a\r\nb\r\nc\n')), '\r\n', 'CRLF majority');
	strictEqual(dominantEol(splitLines('a\rb\rc\n')), '\r', 'CR majority');
	strictEqual(dominantEol(splitLines('a\nb\r\nc\r')), '\n', 'one of each');
	strictEqual(dominantEol(splitLines('a')), '\n', 'nothing terminated');
	strictEqual(dominantEol(splitLines('')), '\n', 'empty document');
});
