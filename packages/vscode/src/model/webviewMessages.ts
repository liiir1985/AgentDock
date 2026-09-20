/**
 * The pure half of the two webview panels: the wire shapes they exchange with the extension, and the
 * full HTML documents handed to `webview.html`.
 *
 * Nothing here imports `vscode` (asserted by `host-agnostic.test.ts`): the markup is testable in
 * plain Node, and the extension only supplies the payload, the nonce and the CSP source. Both
 * documents are complete pages because `webview.html` replaces the whole document; every later
 * state change is applied inside the page by the injected script, so an update never reloads the
 * webview and never costs the list its scroll position.
 */

import type { HunkStatus } from '@agentdock/core';

export interface HunkPreview {
	id: string;
	status: HunkStatus;
	conflict: boolean;
	userEdited: boolean;
	old: string[];
	add: string[];
}

export interface FileEntry {
	path: string;
	stats: string;
	pending: number;
	hunks: HunkPreview[];
}

export interface ChangesPayload {
	files: FileEntry[];
	totals: { files: number; pending: number; added: number; removed: number };
}

// webview -> extension
export type ChangesInbound =
	| { type: 'acceptFile' | 'rejectFile' | 'open'; path: string; hunkId?: string }
	| { type: 'acceptAll' }
	| { type: 'rejectAll' }
	/** The page's first message: before it, a push would race the initial paint. */
	| { type: 'ready' };

export type ChatInbound = { type: 'prompt'; text: string } | { type: 'abort' } | { type: 'ready' };

// extension -> webview
export type ChangesOutbound = { type: 'update'; payload: ChangesPayload };

export type ChatOutbound =
	| { type: 'message'; kind: 'user' | 'assistant' | 'tool' | 'status'; text: string }
	| { type: 'delta'; text: string };

/**
 * The same four replacements the PoC's inset renderer used. Quotes matter as much as angle
 * brackets here because the same text also lands inside attributes (`data-path`).
 */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * One CSP for both pages. `style-src` keeps `'unsafe-inline'` because the documents carry their
 * own `<style>` block; `default-src 'none'` covers the rest (no network, no images).
 */
function csp(nonce: string, cspSource: string): string {
	return `default-src 'none'; style-src ${escapeHtml(cspSource)} 'unsafe-inline'; script-src 'nonce-${escapeHtml(nonce)}';`;
}

/** A 500-line hunk must not push the file list out of the panel, so each side is capped. */
const PREVIEW_CAP = 40;

const NO_CHANGES = '没有待裁决的改动';

function previewLines(lines: string[], className: string, prefix: string): string {
	const shown = lines.length > PREVIEW_CAP ? lines.slice(0, PREVIEW_CAP) : lines;
	let html = '';
	for (const line of shown) html += `<div class="line ${className}">${prefix}${escapeHtml(line)}</div>`;
	if (shown.length < lines.length) html += '<div class="more">…</div>';
	return html;
}

function previewHunk(hunk: HunkPreview): string {
	const body = previewLines(hunk.old, 'old', '- ') + previewLines(hunk.add, 'add', '+ ');
	return body === '' ? '' : `<div class="hunk">${body}</div>`;
}

function fileRow(entry: FileEntry): string {
	return `<div class="row" data-path="${escapeHtml(entry.path)}">` +
		`<span class="path">${escapeHtml(entry.path)}</span>` +
		`<span class="stats">${escapeHtml(entry.stats)}</span>` +
		'<button class="icon accept" type="button" title="Accept 此文件">√</button>' +
		'<button class="icon reject" type="button" title="Reject 此文件">×</button>' +
		`<div class="diff" role="tooltip">${entry.hunks.map(previewHunk).join('')}</div>` +
		'</div>';
}

const CHANGES_STYLE = `
html, body { margin: 0; padding: 0; height: 100%; }
body {
	display: flex; flex-direction: column; height: 100vh; box-sizing: border-box;
	color: var(--vscode-foreground); background: transparent;
	font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
}
#list { flex: 1 1 auto; overflow: auto; padding: 2px 0; }
.row { position: relative; display: flex; align-items: center; gap: 4px; padding: 3px 8px; cursor: pointer; }
.row:hover { background: var(--vscode-list-hoverBackground); }
.path { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stats {
	flex: 0 0 auto; font-family: var(--vscode-editor-font-family);
	font-size: var(--vscode-editor-font-size); color: var(--vscode-descriptionForeground);
}
.icon {
	flex: 0 0 auto; width: 20px; height: 20px; padding: 0; border: none; border-radius: 3px;
	background: transparent; color: var(--vscode-icon-foreground); cursor: pointer;
	font-size: 14px; line-height: 18px;
}
.icon:hover { background: var(--vscode-toolbar-hoverBackground); }
.empty { padding: 10px 8px; color: var(--vscode-descriptionForeground); }
.diff {
	display: none; position: absolute; left: 8px; right: 8px; top: 100%; z-index: 10;
	max-height: 260px; overflow: auto; padding: 4px 0;
	border: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-editorWidget-background);
	font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
}
.row:hover .diff { display: block; }
.diff .line { white-space: pre; padding: 0 8px; }
.diff .old { background: var(--vscode-diffEditor-removedLineBackground); }
.diff .add { background: var(--vscode-diffEditor-insertedLineBackground); }
.diff .hunk + .hunk { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--vscode-editorWidget-border); }
.diff .more { padding: 0 8px; color: var(--vscode-descriptionForeground); }
.footer {
	flex: 0 0 auto; display: flex; gap: 6px; padding: 6px 8px;
	border-top: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-sideBar-background);
}
.footer button {
	flex: 1 1 0; padding: 3px 0; border: none; border-radius: 2px; cursor: pointer;
	color: var(--vscode-button-foreground); background: var(--vscode-button-background);
	font-family: inherit; font-size: inherit;
}
.footer button:hover { background: var(--vscode-button-hoverBackground); }
`;

/**
 * Client side of the Changes panel. The initial rows are rendered on the extension side (first
 * paint without a flash); this script only re-renders on an inbound `update`, and uses event
 * delegation so server- and client-built rows behave identically. All text goes in through
 * `textContent`: the payload carries user file content.
 */
const CHANGES_SCRIPT = `
const vscode = acquireVsCodeApi();
const PREVIEW_CAP = 40;
const PLACEHOLDER = '${NO_CHANGES}';

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function pushLines(parent, lines, className, prefix) {
	const shown = lines.length > PREVIEW_CAP ? lines.slice(0, PREVIEW_CAP) : lines;
	for (const line of shown) parent.appendChild(el('div', 'line ' + className, prefix + line));
	if (shown.length < lines.length) parent.appendChild(el('div', 'more', '…'));
}

function diffFor(entry) {
	const popup = el('div', 'diff');
	for (const hunk of entry.hunks) {
		const block = el('div', 'hunk');
		pushLines(block, hunk.old, 'old', '- ');
		pushLines(block, hunk.add, 'add', '+ ');
		if (block.childElementCount > 0) popup.appendChild(block);
	}
	return popup;
}

function rowFor(entry) {
	const row = el('div', 'row');
	row.setAttribute('data-path', entry.path);
	row.appendChild(el('span', 'path', entry.path));
	row.appendChild(el('span', 'stats', entry.stats));
	const accept = el('button', 'icon accept', '√');
	accept.type = 'button';
	accept.title = 'Accept 此文件';
	const reject = el('button', 'icon reject', '×');
	reject.type = 'button';
	reject.title = 'Reject 此文件';
	row.appendChild(accept);
	row.appendChild(reject);
	row.appendChild(diffFor(entry));
	return row;
}

function renderFiles(payload) {
	const list = document.getElementById('list');
	list.textContent = '';
	if (!payload || !payload.files || payload.files.length === 0) {
		list.appendChild(el('div', 'empty', PLACEHOLDER));
		return;
	}
	for (const entry of payload.files) list.appendChild(rowFor(entry));
}

document.getElementById('list').addEventListener('click', function (event) {
	const target = event.target;
	if (!(target instanceof Element)) return;
	const row = target.closest('.row');
	if (!row) return;
	const path = row.getAttribute('data-path');
	const button = target.closest('button');
	if (button === null) {
		vscode.postMessage({ type: 'open', path: path });
		return;
	}
	if (button.classList.contains('accept')) vscode.postMessage({ type: 'acceptFile', path: path });
	else if (button.classList.contains('reject')) vscode.postMessage({ type: 'rejectFile', path: path });
});

document.getElementById('accept-all').addEventListener('click', function () { vscode.postMessage({ type: 'acceptAll' }); });
document.getElementById('reject-all').addEventListener('click', function () { vscode.postMessage({ type: 'rejectAll' }); });

window.addEventListener('message', function (event) {
	const message = event.data;
	if (message && message.type === 'update') renderFiles(message.payload);
});

vscode.postMessage({ type: 'ready' });
`;

/** The Changes panel: one row per file (D24), a hover diff, and the turn-level verdict pair. */
export function changesHtml(payload: ChangesPayload, nonce: string, cspSource: string): string {
	const files =
		payload.files.length === 0
			? `<div class="empty">${NO_CHANGES}</div>`
			: payload.files.map((entry) => fileRow(entry)).join('\n');
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp(nonce, cspSource)}">
<title>AgentDock · Changes</title>
<style>${CHANGES_STYLE}</style>
</head>
<body>
<div id="list">${files}</div>
<div class="footer">
<button id="accept-all" type="button">Accept All</button>
<button id="reject-all" type="button">Reject All</button>
</div>
<script nonce="${escapeHtml(nonce)}">
${CHANGES_SCRIPT}
</script>
</body>
</html>`;
}

const CHAT_STYLE = `
html, body { margin: 0; padding: 0; height: 100%; }
body {
	display: flex; flex-direction: column; height: 100vh; box-sizing: border-box;
	color: var(--vscode-foreground); background: transparent;
	font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
}
#stream { flex: 1 1 auto; overflow: auto; display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; }
.bubble { padding: 4px 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
.bubble.user { background: var(--vscode-input-background); }
.bubble.assistant { background: var(--vscode-editorWidget-background); }
.tool, .status {
	font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
	color: var(--vscode-descriptionForeground); white-space: pre; overflow: hidden; text-overflow: ellipsis;
}
.status { font-style: italic; }
#composer {
	flex: 0 0 auto; display: flex; gap: 6px; padding: 6px 8px;
	border-top: 1px solid var(--vscode-editorWidget-border);
}
#input {
	flex: 1 1 auto; min-height: 3em; resize: none; box-sizing: border-box; padding: 4px 6px;
	color: var(--vscode-input-foreground); background: var(--vscode-input-background);
	border: 1px solid var(--vscode-input-border, transparent);
	font-family: inherit; font-size: inherit;
}
#input:focus { outline: 1px solid var(--vscode-focusBorder); }
#send, #stop {
	align-self: flex-end; padding: 3px 10px; border: none; border-radius: 2px; cursor: pointer;
	font-family: inherit; font-size: inherit;
}
#send { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
#send:hover { background: var(--vscode-button-hoverBackground); }
#stop { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
#stop:hover { background: var(--vscode-button-secondaryHoverBackground); }
`;

/**
 * Client side of the chat panel. The stream is append-only: streaming text arrives as `delta` and
 * is appended as a text node, so the host never has to escape anything here.
 */
const CHAT_SCRIPT = `
const vscode = acquireVsCodeApi();
const stream = document.getElementById('stream');
const input = document.getElementById('input');

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function appendBubble(kind, text) {
	const node = el('div', kind === 'tool' || kind === 'status' ? kind : 'bubble ' + kind, (kind === 'tool' ? '▸ ' : '') + text);
	stream.appendChild(node);
	stream.scrollTop = stream.scrollHeight;
	return node;
}

function appendDelta(text) {
	let last = stream.lastElementChild;
	if (!last || last.className !== 'bubble assistant') {
		last = el('div', 'bubble assistant');
		stream.appendChild(last);
	}
	last.appendChild(document.createTextNode(text));
	stream.scrollTop = stream.scrollHeight;
}

function send() {
	const text = input.value;
	if (text.trim() === '') return;
	input.value = '';
	vscode.postMessage({ type: 'prompt', text: text });
}

document.getElementById('send').addEventListener('click', send);
document.getElementById('stop').addEventListener('click', function () { vscode.postMessage({ type: 'abort' }); });
input.addEventListener('keydown', function (event) {
	if (event.key !== 'Enter' || event.shiftKey) return;
	event.preventDefault();
	send();
});

window.addEventListener('message', function (event) {
	const message = event.data;
	if (!message) return;
	if (message.type === 'delta') appendDelta(message.text);
	else if (message.type === 'message') appendBubble(message.kind, message.text);
});

vscode.postMessage({ type: 'ready' });
`;

/** The chat panel: message stream plus prompt input and a stop button (M10). */
export function chatHtml(nonce: string, cspSource: string): string {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp(nonce, cspSource)}">
<title>AgentDock</title>
<style>${CHAT_STYLE}</style>
</head>
<body>
<div id="stream"></div>
<div id="composer">
<textarea id="input" rows="3" placeholder="向 agent 描述要做的改动…（Enter 发送，Shift+Enter 换行）"></textarea>
<button id="send" type="button">发送</button>
<button id="stop" type="button">停止</button>
</div>
<script nonce="${escapeHtml(nonce)}">
${CHAT_SCRIPT}
</script>
</body>
</html>`;
}
