/**
 * Scheme C: webview editor insets (`editorInsets` proposed API).
 *
 * Each pending hunk with old-side content gets one webview inset placed on the
 * anchor line, i.e. between the line above the hunk and the hunk's own new side.
 * Inside the inset every baseline line is a real, full-height row: strikethrough,
 * removed-line background, monospace metrics taken from the editor font. This is
 * the only one of the three schemes that can render N deleted lines as N rows.
 *
 * Insets carry no actions: `command:` links inside an inset do not fire, not even
 * with `enableCommandUris` whitelisting them (real mouse click on the link, verified
 * in a live window — the href and the frame geometry were both checked). The action
 * row therefore stays a CodeLens row for every mode; in `comments` mode the thread
 * widget's title-bar buttons are the instant alternative.
 *
 * Unlike schemes A and B this needs a proposed API: package.json declares
 * `"enabledApiProposals": ["editorInsets"]` and the host must be started with
 * `--enable-proposed-api agentdock.agentdock-editor-review-poc`. Market-place
 * publishing is therefore not possible; see RESULTS.md §5.
 */

import * as vscode from 'vscode';
import { Hunk, TurnChangeSet } from '../model/changeSet';

/**
 * Row height. Insets must line up with the editor's rhythm, but `TextEditorOptions`
 * no longer exposes `lineHeight` and there is no pixel-geometry API, so derive it:
 * explicit setting > explicit `editor.lineHeight` > font size heuristic.
 * Observed on the default setup (14px Consolas): the editor renders 19px rows and
 * `round(14 * 1.35) === 19`, i.e. the heuristic matches the default theme metrics.
 */
function insetRowHeight(): number {
	const override = vscode.workspace.getConfiguration('agentReview').get<number>('insetRowHeight', 0);
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
 * Left offset of the row text inside the inset. Measured on the live editor: the
 * code column starts at the same x as the inset (0 offset), so any positive value
 * would push the deleted text one character to the right of the code.
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
	private readonly entries = new Map<string, InsetEntry>();

	dispose(): void {
		this.clear();
	}

	/**
	 * Remove an inset. Disposing a webview costs about a second before the zone and its
	 * rows are gone from the editor (observed), which reads as "the click did nothing".
	 * Blanking the HTML first clears the visible rows immediately; the teardown then
	 * happens off-screen instead of in front of the user.
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
		const rows = hunk.baselineLines
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

	render(editor: vscode.TextEditor, changeSet: TurnChangeSet | undefined): void {
		const pending = (changeSet?.hunks ?? []).filter(
			(hunk) => hunk.tracked && hunk.status === 'pending' && hunk.baselineLines.length > 0,
		);
		const live = new Set(pending.map((hunk) => hunk.id));
		for (const [id, entry] of this.entries) {
			if (!live.has(id)) {
				this.drop(entry);
				this.entries.delete(id);
			}
		}
		const rowHeight = insetRowHeight();
		for (const hunk of pending) {
			// Insets DO create row space, so unlike the decoration renderer they can and must
			// place the old rows above the new side (line `start - 1`), where the deletion
			// happened, instead of borrowing the hunk's own last line.
			const line = Math.max(0, Math.min(hunk.targetRange.start - 1, editor.document.lineCount - 1));
			// `height` is a LINE COUNT, not pixels: the zone ends up `height * lineHeight` tall
			// (measured: 19 rows -> 361px at the default 19px line height).
			const rows = hunk.baselineLines.length;
			const existing = this.entries.get(hunk.id);
			if (existing && existing.line === line && existing.rows === rows) {
				continue;
			}
			if (existing) {
				this.drop(existing);
			}
			const inset = vscode.window.createWebviewTextEditorInset(editor, line, rows, { enableScripts: false });
			inset.webview.html = this.html(hunk, rowHeight, editorTabSize());
			this.entries.set(hunk.id, { inset, line, rows });
		}
	}
}
