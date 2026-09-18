/**
 * Scheme A: decorations only.
 *
 * - new side (real document text): whole-line background + hover diff.
 * - old side (no longer in the document): ONE attachment decoration per hunk. The
 *   first baseline line is shown verbatim; when more lines were deleted the row
 *   ends with a `deleted N more line(s)...` marker. Every deleted line in full is
 *   in the hover (see `hunkText.ts`) — the hover is the only surface a decoration
 *   has for text beyond one row.
 *
 * Why one row and not one row per baseline line (verified against a live 1.138.0
 * workbench, see RESULTS.md P1-P4):
 * - `contentText` ignores `\n` (microsoft/vscode#63600), so a single decoration can
 *   never render several rows;
 * - several attachments at the same anchor position are all painted on that one
 *   row, laid out horizontally;
 * - `width: '100%'` does not create a row of its own either: it expands the
 *   attachment inside the anchor row and pushes the next one out of the viewport;
 * - line boxes are a fixed height, so decorations cannot create row space.
 * One `TextEditorDecorationType` per distinct row text is still mandatory:
 * instance-level `renderOptions.after.contentText` has an open rendering bug
 * (microsoft/vscode#242764).
 */

import * as vscode from 'vscode';
import { Hunk, TurnChangeSet } from '../model/changeSet';
import { deletedLinesMarkdown } from './hunkText';

export class DecorationRenderer implements vscode.Disposable {
	private readonly addedLines: vscode.TextEditorDecorationType;
	private readonly removedAfter = new Map<string, vscode.TextEditorDecorationType>();
	private readonly removedBefore = new Map<string, vscode.TextEditorDecorationType>();
	private readonly owned: vscode.TextEditorDecorationType[] = [];

	constructor() {
		this.addedLines = this.track(
			vscode.window.createTextEditorDecorationType({
				isWholeLine: true,
				backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
				overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
				overviewRulerLane: vscode.OverviewRulerLane.Left,
				rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			}),
		);
	}

	dispose(): void {
		for (const type of this.owned) {
			type.dispose();
		}
		this.owned.length = 0;
	}

	private track(type: vscode.TextEditorDecorationType): vscode.TextEditorDecorationType {
		this.owned.push(type);
		return type;
	}

	private removedRowType(text: string, side: 'after' | 'before'): vscode.TextEditorDecorationType {
		const cache = side === 'after' ? this.removedAfter : this.removedBefore;
		const existing = cache.get(text);
		if (existing) {
			return existing;
		}
		const row: vscode.ThemableDecorationAttachmentRenderOptions = {
			// contentText must not be empty: use a single space for blank lines.
			contentText: text.length > 0 ? text : ' ',
			textDecoration: 'line-through',
			color: new vscode.ThemeColor('descriptionForeground'),
			backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
			borderColor: new vscode.ThemeColor('diffEditor.removedTextBorder'),
			border: '1px solid',
			margin: '0 0 0 12px',
		};
		const created = this.track(
			vscode.window.createTextEditorDecorationType({
				[side]: row,
				overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
				overviewRulerLane: vscode.OverviewRulerLane.Left,
				rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			}),
		);
		cache.set(text, created);
		return created;
	}

	/**
	 * @param includeOldRows `false` draws only the new-side highlight, for scheme C
	 *  where the old side is rendered by webview insets instead.
	 *
	 * The old side gets exactly ONE row (the first deleted line, in removed-line
	 * styling): that is all a decoration can render, so the count of the remaining
	 * lines is a clickable CodeLens item and the full text is in the hover.
	 */
	render(editor: vscode.TextEditor, changeSet: TurnChangeSet | undefined, includeOldRows = true): void {
		const pending = (changeSet?.hunks ?? []).filter((hunk) => hunk.tracked && hunk.status === 'pending');
		const added: vscode.DecorationOptions[] = [];
		const rows = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();

		for (const hunk of pending) {
			const oldHover = hunk.baselineLines.length > 0 ? deletedLinesMarkdown(hunk) : undefined;
			const lastLine = Math.min(hunk.targetRange.end, editor.document.lineCount - 1);
			for (let line = hunk.targetRange.start; line <= lastLine; line++) {
				// No hover on the new side: that text is complete and editable already.
				added.push({ range: new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length) });
			}
			if (!includeOldRows || hunk.baselineLines.length === 0) {
				continue;
			}
			const type = this.removedRowType(hunk.baselineLines[0], hunk.attachSide);
			const line = hunk.anchorLine < 0 ? 0 : hunk.anchorLine;
			const column = hunk.attachSide === 'after' ? editor.document.lineAt(line).text.length : 0;
			const target = rows.get(type) ?? [];
			target.push({ range: new vscode.Range(line, column, line, column), hoverMessage: oldHover });
			rows.set(type, target);
		}

		editor.setDecorations(this.addedLines, added);
		for (const type of this.owned) {
			const options = rows.get(type);
			if (options) {
				editor.setDecorations(type, options);
			} else if (type !== this.addedLines) {
				// Stale row types must be cleared explicitly, otherwise the previous
				// render's rows stay on screen forever.
				editor.setDecorations(type, []);
			}
		}
	}
}
