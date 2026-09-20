/**
 * Framing: one JSON object per line, split across arbitrary chunk boundaries, and loud about a line
 * that is not JSON (unless the caller asked to be told instead — see `DecoderOptions`).
 */

import { describe, expect, test } from 'bun:test';

import { SidecarRequestError, createDecoder, encode, toSidecarError } from './protocol';

describe('encode', () => {
	test('one line, newline-terminated, JSON payload', () => {
		expect(encode({ type: 'delta', text: 'hi' })).toBe('{"type":"delta","text":"hi"}\n');
	});

	test('a payload with a newline inside stays one frame', () => {
		const frame = encode({ type: 'log', level: 'info', message: 'line one\nline two' });
		expect(frame.endsWith('\n')).toBe(true);
		expect(frame.split('\n').length).toBe(2);
		interface LogFrame {
			type: string;
			level: string;
			message: string;
		}
		expect(createDecoder<LogFrame>().push(frame)).toEqual([
			{ type: 'log', level: 'info', message: 'line one\nline two' },
		]);
	});
});

describe('createDecoder', () => {
	test('round trip, several messages in one chunk', () => {
		const decoder = createDecoder<{ id: number }>();
		const chunk = encode({ id: 1 } as never) + encode({ id: 2 } as never);
		expect(decoder.push(chunk)).toEqual([{ id: 1 }, { id: 2 }]);
	});

	test('a half line waits for the rest of it', () => {
		const decoder = createDecoder<{ id: number }>();
		expect(decoder.push('{"id":')).toEqual([]);
		expect(decoder.push('7}\n')).toEqual([{ id: 7 }]);
	});

	test('an empty line and a CRLF frame are both tolerated', () => {
		const decoder = createDecoder<{ id: number }>();
		expect(decoder.push('\n\r\n{"id":3}\r\n\n')).toEqual([{ id: 3 }]);
	});

	test('a bad frame throws by default', () => {
		const decoder = createDecoder();
		expect(() => decoder.push('not json\n')).toThrow(/bad frame: not json/);
	});

	test('a bad frame can be reported instead, and the good ones still arrive', () => {
		const bad: string[] = [];
		const decoder = createDecoder<{ id: number }>({ onBadFrame: (line) => bad.push(line) });
		expect(decoder.push('oops\n{"id":4}\n')).toEqual([{ id: 4 }]);
		expect(bad).toEqual(['oops']);
	});
});

describe('toSidecarError', () => {
	test('a request error keeps its code', () => {
		expect(toSidecarError(new SidecarRequestError('bun-version', 'too old'), 'internal')).toEqual({
			code: 'bun-version',
			message: 'too old',
		});
	});

	test('anything else takes the fallback code and a readable message', () => {
		expect(toSidecarError(new Error('boom'), 'session')).toEqual({ code: 'session', message: 'boom' });
		expect(toSidecarError('boom', 'internal')).toEqual({ code: 'internal', message: 'boom' });
	});
});
