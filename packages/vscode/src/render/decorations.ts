/**
 * The new side of every hunk: one whole-line background (D11, single track).
 *
 * The document text IS the new side — Accept writes nothing — so this layer never carries content,
 * hovers or attachments; any of those would duplicate text the user can already read and edit. The
 * deleted lines are drawn as real inset rows by `insets.ts`, which is the split this class must not
 * break: there is NO old-side decoration anywhere, because two surfaces for one side of a hunk
 * would drift apart (the inset knows the exact rows; a decoration can render one row at most).
 *
 * One shared decoration type, unlike the PoC: the type carries no per-hunk option, so the whole
 * render is a single `setDecorations` call and there is no stale type to clear.
 */

import * as vscode from 'vscode';
import type { Hunk } from '@agentdock/core';

export class DecorationRenderer implements vscode.Disposable {
	private readonly addedLines: vscode.TextEditorDecorationType;

	constructor() {
		this.addedLines = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
			overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		});
	}

	dispose(): void {
		this.addedLines.dispose();
	}

	/**
	 * @param hunks the *pending* hunks of this editor's document, as filtered by the caller
	 *  (`RenderSync.hunksFor`); the filter is repeated here so a decided hunk cannot keep its
	 *  highlight.
	 */
	render(editor: vscode.TextEditor, hunks: Hunk[]): void {
		const added: vscode.DecorationOptions[] = [];
		for (const hunk of hunks) {
			if (hunk.status !== 'pending') {
				continue;
			}
			// A pure deletion has nothing on the new side; its old rows are all there is to draw.
			if (hunk.targetRange.end < hunk.targetRange.start) {
				continue;
			}
			const last = Math.min(hunk.targetRange.end, editor.document.lineCount - 1);
			for (let line = hunk.targetRange.start; line <= last; line++) {
				// No hover on the new side: that text is complete and editable already.
				added.push({ range: new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length) });
			}
		}
		editor.setDecorations(this.addedLines, added);
	}
}
