/**
 * The message layer is the only part of the extension whose behaviour can be pinned without an
 * extension host, so it is pinned here: escaping, the two document skeletons, and the invariants a
 * webview would otherwise only reveal visually (the CSP nonce, the capped popup, the empty state).
 *
 * The documents are asserted as text. Nothing in this file loads a webview.
 */

import test from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import type { ChangesPayload, FileEntry, HunkPreview } from './webviewMessages';
import { changesHtml, chatHtml, escapeHtml } from './webviewMessages';

const NONCE = 'b1f0c2d4-0000-4000-8000-000000000000';
const CSP_SOURCE = 'vscode-webview://agentdock';

function hunk(overrides: Partial<HunkPreview> = {}): HunkPreview {
	return { id: 'h1', status: 'pending', conflict: false, userEdited: false, old: [], add: [], ...overrides };
}

function entry(overrides: Partial<FileEntry> = {}): FileEntry {
	return {
		path: 'src/a.ts',
		stats: '+2 -1',
		pending: 1,
		hunks: [hunk({ old: ['const a = 1;'], add: ['const a = 2;'] })],
		...overrides,
	};
}

function payload(files: FileEntry[]): ChangesPayload {
	return { files, totals: { files: files.length, pending: 1, added: 2, removed: 1 } };
}

test('escapeHtml escapes the four markup characters and leaves ordinary text alone', () => {
	strictEqual(
		escapeHtml('<script>alert("x") & \'y\'</script>'),
		'&lt;script&gt;alert(&quot;x&quot;) &amp; \'y\'&lt;/script&gt;',
	);
	strictEqual(escapeHtml('src/a.ts +2 -1'), 'src/a.ts +2 -1');
});

test('both documents are complete pages with the nonce in their policy', () => {
	for (const html of [changesHtml(payload([entry()]), NONCE, CSP_SOURCE), chatHtml(NONCE, CSP_SOURCE)]) {
		ok(html.startsWith('<!DOCTYPE html>'), 'a webview document must open with the doctype');
		ok(html.includes('<meta charset="utf-8">'), 'the page must declare utf-8');
		ok(html.includes(`script-src 'nonce-${NONCE}'`), 'the inline script must be nonce-gated');
		ok(html.includes(CSP_SOURCE), 'the style source must be the webview origin');
		// The inline script is the only script tag: a payload must never be able to open another.
		strictEqual(html.split('</script>').length - 1, 1);
	}
});

test('changesHtml escapes hostile payload text instead of emitting markup', () => {
	const html = changesHtml(
		payload([
			entry({
				path: '<script>bad</script>',
				hunks: [hunk({ old: ['it\'s "fine"'], add: ['x = "<b>";'] })],
			}),
		]),
		NONCE,
		CSP_SOURCE,
	);
	ok(!html.includes('<script>'), 'no unescaped script tag may reach the document');
	ok(!html.includes('"fine"'), 'the popup must not carry raw quotes from a hunk line');
	ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'), 'the path must be escaped');
	ok(html.includes('it\'s &quot;fine&quot;'), 'the old line must be escaped');
	ok(html.includes('x = &quot;&lt;b&gt;&quot;;'), 'the add line must be escaped');
});

test('changesHtml renders one row per file with its stats, hover diff and verdict buttons', () => {
	const html = changesHtml(payload([entry({ path: 'src/a.ts', stats: '+2 -1' })]), NONCE, CSP_SOURCE);
	ok(html.includes('data-path="src/a.ts"'), 'each row is addressable by its workspace-relative path');
	ok(html.includes('<span class="stats">+2 -1</span>'), 'the row carries the +N -M summary');
	ok(html.includes('class="diff"'), 'the row carries a hover diff');
	ok(html.includes('- const a = 1;'), 'the removed side is drawn');
	ok(html.includes('+ const a = 2;'), 'the added side is drawn');
	ok(html.includes('Accept All') && html.includes('Reject All'), 'the turn-level pair is always present');
	ok(html.includes("type: 'acceptFile'") && html.includes("type: 'rejectFile'"), 'rows post file verdicts');
	ok(html.includes("type: 'open'"), 'a row body opens the change');
});

test('changesHtml caps each hunk side and marks the truncation', () => {
	const long = Array.from({ length: 45 }, (_, i) => `line ${i}`);
	const html = changesHtml(payload([entry({ hunks: [hunk({ old: long, add: long })] })]), NONCE, CSP_SOURCE);
	ok(html.includes('- line 39') && html.includes('+ line 39'), 'the first 40 lines are drawn');
	ok(!html.includes('- line 40') && !html.includes('+ line 40'), 'the 41st line is dropped');
	ok(html.includes('class="more">…</div>'), 'the truncation is marked');
});

test('changesHtml shows the placeholder and no rows when the review surface is empty', () => {
	const html = changesHtml({ files: [], totals: { files: 0, pending: 0, added: 0, removed: 0 } }, NONCE, CSP_SOURCE);
	ok(html.includes('没有待裁决的改动'), 'the empty state is explained');
	strictEqual(html.split('data-path="').length - 1, 0, 'no file row may be rendered');
	ok(!html.includes('class="line'), 'no diff line may be rendered');
});

test('chatHtml wires the prompt input, the stop button and the ready handshake', () => {
	const html = chatHtml(NONCE, CSP_SOURCE);
	ok(html.includes('id="stream"') && html.includes('id="input"'), 'the panel has a stream and an input');
	ok(html.includes("type: 'prompt'"), 'sending posts a prompt');
	ok(html.includes("type: 'abort'"), 'the stop button posts an abort');
	ok(html.includes("type: 'ready'"), 'the page announces itself');
	ok(html.includes(`nonce="${NONCE}"`), 'the script tag carries the nonce');
	ok(html.includes("message.type === 'delta'"), 'streaming deltas are handled');
	ok(html.includes("'▸ '"), 'tool activity is prefixed with a marker');
});

interface FakeNode {
	className: string;
	value: string;
	scrollTop: number;
	scrollHeight: number;
	children: FakeNode[];
	textContent: string;
	appendChild(child: FakeNode): FakeNode;
	addEventListener(type: string, handler: (event: unknown) => void): void;
}

/** Just enough DOM for the chat script: elements that keep children and can read their text back. */
function fakeNode(): FakeNode {
	const children: FakeNode[] = [];
	let own: string | undefined;
	const node = {
		className: '',
		value: '',
		scrollTop: 0,
		scrollHeight: 0,
		children,
		appendChild(child: FakeNode): FakeNode {
			children.push(child);
			return child;
		},
		addEventListener(): void {
			// The panel's own listeners are not what these tests exercise.
		},
	} as unknown as FakeNode;
	Object.defineProperty(node, 'textContent', {
		get: () => (own !== undefined ? own : children.map((child) => child.textContent).join('')),
		set: (value: string) => {
			own = value;
			children.length = 0;
		},
	});
	return node;
}

function textNode(text: string): FakeNode {
	return { textContent: text, children: [] } as unknown as FakeNode;
}

/** Runs the real chat script against the fake DOM and hands back the stream plus a delivery function. */
function openChatPanel(): { stream: FakeNode; deliver: (message: unknown) => void } {
	const stream = fakeNode();
	const byId = new Map<string, FakeNode>([
		['stream', stream],
		['input', fakeNode()],
		['send', fakeNode()],
		['stop', fakeNode()],
	]);
	const handlers: ((event: { data: unknown }) => void)[] = [];
	const document = {
		getElementById: (id: string) => byId.get(id) ?? null,
		createElement: () => fakeNode(),
		createTextNode: (text: string) => textNode(text),
	};
	const window = {
		addEventListener: (type: string, handler: (event: { data: unknown }) => void) => {
			if (type === 'message') handlers.push(handler);
		},
	};
	const acquireVsCodeApi = () => ({ postMessage: () => undefined });
	const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(chatHtml(NONCE, CSP_SOURCE));
	if (script === null) throw new Error('the chat document carries no script');
	new Function('document', 'window', 'acquireVsCodeApi', script[1])(document, window, acquireVsCodeApi);
	return {
		stream,
		deliver: (message: unknown) => {
			for (const handler of handlers) handler({ data: message });
		},
	};
}

test('the completed answer does not repeat the text the deltas already streamed', () => {
	const { stream, deliver } = openChatPanel();
	deliver({ type: 'delta', text: 'Done. ' });
	deliver({ type: 'delta', text: '26 bytes written.' });
	deliver({ type: 'message', kind: 'assistant', text: 'Done. 26 bytes written.' });
	strictEqual(stream.children.length, 1, 'one answer, one bubble');
	strictEqual(stream.children[0].textContent, 'Done. 26 bytes written.');
});

test('a second answer in the same turn starts a new bubble instead of extending the first', () => {
	const { stream, deliver } = openChatPanel();
	deliver({ type: 'delta', text: 'first' });
	deliver({ type: 'message', kind: 'assistant', text: 'first' });
	deliver({ type: 'delta', text: 'second' });
	deliver({ type: 'message', kind: 'assistant', text: 'second' });
	strictEqual(stream.children.length, 2);
	strictEqual(stream.children[0].textContent, 'first');
	strictEqual(stream.children[1].textContent, 'second');
});

test('a completed message that says more than the deltas is kept', () => {
	const { stream, deliver } = openChatPanel();
	deliver({ type: 'delta', text: 'partial' });
	deliver({ type: 'message', kind: 'assistant', text: 'the full answer' });
	strictEqual(stream.children.length, 2);
	strictEqual(stream.children[1].textContent, 'the full answer');
});

test('user prompts and tool rows still get their own rows', () => {
	const { stream, deliver } = openChatPanel();
	deliver({ type: 'message', kind: 'user', text: 'do it' });
	deliver({ type: 'message', kind: 'tool', text: 'edit src/a.ts' });
	deliver({ type: 'message', kind: 'assistant', text: 'ok' });
	strictEqual(stream.children.length, 3);
	strictEqual(stream.children[1].className, 'tool');
	strictEqual(stream.children[1].textContent, '▸ edit src/a.ts');
	strictEqual(stream.children[2].className, 'bubble assistant');
});
