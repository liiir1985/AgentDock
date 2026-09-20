/**
 * The old side of every hunk: webview editor insets (`editorInsets` proposed API, D11).
 *
 * Each pending hunk with old-side content gets one webview inset placed on the line above its new
 * side, i.e. exactly where the deletion happened. Inside the inset every baseline line is a real,
 * full-height row. That is the whole reason the old side is an inset here and the new side is a
 * plain whole-line decoration (see `decorations.ts`): decorations cannot create row space — a
 * `contentText` attachment ignores `\n` (microsoft/vscode#63600) and line boxes have a fixed
 * height — so N deleted lines can only be drawn as N rows by an inset.
 *
 * Insets carry no actions: `command:` links inside an inset do not fire, not even with
 * `enableCommandUris` whitelisting them (a real mouse click on the link was verified in a live
 * window with the href and the frame geometry both checked). The Accept / Reject row therefore
 * stays a CodeLens row, one per hunk (`actions.ts`).
 *
 * `editorInsets` is a proposed API: package.json declares `enabledApiProposals: ["editorInsets"]`
 * and the host must be started with `--enable-proposed-api=agentdock.agentdock` (D11/D23).
 */

import * as vscode from 'vscode';
import type { Hunk } from '@agentdock/core';

/**
 * Row height. Insets must line up with the editor's rhythm, but `TextEditorOptions` no longer
 * exposes `lineHeight` and there is no pixel-geometry API, so derive it:
 * explicit setting > explicit `editor.lineHeight` > font size heuristic.
 * Observed on the default setup (14px Consolas): the editor renders 19px rows and
 * `round(14 * 1.35) === 19`, i.e. the heuristic matches the default theme metrics.
 */
function insetRowHeight(): number {
	const override = vscode.workspace.getConfiguration('agentdock').get<number>('insetRowHeight', 0);
	if (typeof override === 'number' && override > 0) {
		return override;
	}
	const editorConfig = vscode.workspace.getConfiguration('editor');
	const configured = editorConfig.get<number>('lineHeight', 0);
	if (typeof configured === 'number' && configured > 0) {
		return configured;
	}
	return Math.round(editorConfig.get<number>('fontSize', 14) * 1.35);
}

/**
 * Left offset of the row text inside the inset. Measured on the live editor: the code column
 * starts at the same x as the inset (0 offset), so any positive value would push the deleted
 * text one character to the right of the code.
 */
const ROW_TEXT_INDENT_PX = 0;

/** Editor tab size for the rows, so indented lines keep the code column. */
function editorTabSize(): number {
	const tabSize = vscode.workspace.getConfiguration('editor').get<number | string>('tabSize', 4);
	return typeof tabSize === 'number' && tabSize > 0 ? tabSize : 4;
}

/** Blank page: clears an inset's visible rows before the webview teardown finishes. */
const EMPTY_INSET_HTML = '<!DOCTYPE html><html><body style="background: transparent"></body></html>';

interface InsetEntry {
	inset: vscode.WebviewEditorInset;
	/** The document the inset hangs off; a hunk id is only unique within a turn. */
	uri: string;
	/** geometry is readonly on the inset, so a change means dispose + recreate */
	line: number;
	rows: number;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export class InsetsRenderer implements vscode.Disposable {
	/**
	 * Keyed by document + hunk id, not by hunk id alone: a turn spans several files and renumbers
	 * hunks from `h1` up in every one of them, so a bare id would let one file's cached geometry
	 * answer for another file's hunk.
	 */
	private readonly entries = new Map<string, InsetEntry>();

	dispose(): void {
		this.clear();
	}

	/**
	 * Remove an inset. Disposing a webview costs about a second before the zone and its rows are
	 * gone from the editor (observed), which reads as "the click did nothing". Blanking the HTML
	 * first clears the visible rows immediately; the teardown then happens off-screen instead of
	 * in front of the user.
	 */
	private drop(entry: InsetEntry): void {
		entry.inset.webview.html = EMPTY_INSET_HTML;
		entry.inset.dispose();
	}

	private clear(): void {
		for (const entry of this.entries.values()) {
			this.drop(entry);
		}
		this.entries.clear();
	}

	private html(hunk: Hunk, rowHeight: number, tabSize: number): string {
		const rows = hunk.baseline.lines
			.map((text) => `<div class="row"><span class="text">${escapeHtml(text)}</span></div>`)
			.join('');
		return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
	html, body { margin: 0; padding: 0; overflow: hidden; background: transparent; }
	.row {
		display: flex; align-items: center;
		height: ${rowHeight}px; line-height: ${rowHeight}px;
		font-family: var(--vscode-editor-font-family);
		font-size: var(--vscode-editor-font-size);
		tab-size: ${tabSize};
	}
	.text {
		flex: 1 1 auto; min-width: 0;
		padding-left: ${ROW_TEXT_INDENT_PX}px;
		text-decoration: line-through;
		color: var(--vscode-descriptionForeground);
		background-color: var(--vscode-diffEditor-removedLineBackground, rgba(201, 60, 55, 0.15));
		white-space: pre; overflow: hidden; text-overflow: ellipsis;
	}
</style></head><body>${rows}</body></html>`;
	}

	/**
	 * @param hunks the *pending* hunks of this editor's document, as filtered by the caller
	 *  (`RenderSync.hunksFor`). The filter is repeated here so a stray status cannot leave an inset
	 *  on screen after that hunk was decided.
	 */
	render(editor: vscode.TextEditor, hunks: Hunk[]): void {
		const uri = editor.document.uri.toString();
		const pending = hunks.filter((hunk) => hunk.status === 'pending' && hunk.baseline.lines.length > 0);
		const live = new Set(pending.map((hunk) => `${uri}\u0000${hunk.id}`));
		for (const [key, entry] of this.entries) {
			// Only this document's stale rows may go: the other editors' insets are our only handle
			// on their rows while they are not the target of `RenderSync.commitVisual`.
			if (entry.uri === uri && !live.has(key)) {
				this.drop(entry);
				this.entries.delete(key);
			}
		}
		const rowHeight = insetRowHeight();
		for (const hunk of pending) {
			// Insets DO create row space, so unlike the decoration renderer they can and must place
			// the old rows above the new side (line `start - 1`), where the deletion happened,
			// instead of borrowing the hunk's own last line.
			const line = Math.max(0, Math.min(hunk.targetRange.start - 1, editor.document.lineCount - 1));
			// `height` is a LINE COUNT, not pixels: the zone ends up `height * lineHeight` tall
			// (measured: 19 rows -> 361px at the default 19px line height).
			const rows = hunk.baseline.lines.length;
			const key = `${uri}\u0000${hunk.id}`;
			const existing = this.entries.get(key);
			if (existing && existing.line === line && existing.rows === rows) {
				continue;
			}
			if (existing) {
				this.drop(existing);
			}
			const inset = vscode.window.createWebviewTextEditorInset(editor, line, rows, { enableScripts: false });
			inset.webview.html = this.html(hunk, rowHeight, editorTabSize());
			this.entries.set(key, { inset, uri, line, rows });
		}
	}
}
