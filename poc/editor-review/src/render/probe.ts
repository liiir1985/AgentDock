/**
 * Rendering probe (plan step 6). Draws synthetic attachments on dedicated lines
 * of the fixture document and prints the observation checklist, so the §12
 * unknown ("can multi-line old text be embedded in a normal text editor?") is
 * answered by direct observation instead of assumption.
 *
 * Line numbers below are 1-based in the checklist and 0-based in the code; the
 * fixture document is 40 lines long, so P1-P4 are visible without scrolling.
 *
 * P1  line  7 : real newline inside `contentText`      -> is it honoured?
 * P2  line 17 : three types at ONE anchor              -> how many render?
 * P2b lines 20/21/22: three types at THREE anchors     -> control: proves the types themselves are fine
 * P3  line 24 : three types at ONE anchor, width:100%  -> do they become rows of their own?
 * P4  line  1 : `before` attachment on line 0          -> S === 0 path
 * P5  line 34 : ClosedClosed attachment                -> does it stay put when neighbours change?
 * P6          : one CodeLens row per pending hunk      -> same row, correct hunk on click
 */

import * as vscode from 'vscode';

export class ProbeRenderer implements vscode.Disposable {
	private readonly types: vscode.TextEditorDecorationType[] = [];

	dispose(): void {
		for (const type of this.types) {
			type.dispose();
		}
		this.types.length = 0;
	}

	private attach(
		side: 'after' | 'before',
		contentText: string,
		row: vscode.ThemableDecorationAttachmentRenderOptions = {},
	): vscode.TextEditorDecorationType {
		const type = vscode.window.createTextEditorDecorationType({
			[side]: { contentText, ...row },
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		});
		this.types.push(type);
		return type;
	}

	clear(editors: readonly vscode.TextEditor[]): void {
		for (const editor of editors) {
			for (const type of this.types) {
				editor.setDecorations(type, []);
			}
		}
	}

	run(editor: vscode.TextEditor, output: vscode.OutputChannel): void {
		this.clear([editor]);
		const document = editor.document;
		const at = (line: number, column = 0): vscode.Range => {
			const clamped = Math.max(0, Math.min(line, document.lineCount - 1));
			return new vscode.Range(clamped, column, clamped, column);
		};
		const endOf = (line: number): vscode.Range => {
			const clamped = Math.max(0, Math.min(line, document.lineCount - 1));
			return at(clamped, document.lineAt(clamped).text.length);
		};
		const muted = { color: new vscode.ThemeColor('descriptionForeground'), border: '1px solid' };

		// P1 — is a real \n honoured inside contentText?
		const p1 = this.attach('after', 'P1-first\nP1-second', muted);
		editor.setDecorations(p1, [{ range: endOf(6) }]);

		// P2 — three distinct types stacked on the SAME anchor, plain rows.
		['P2-OLD-1', 'P2-OLD-2', 'P2-OLD-3'].forEach((text) => {
			editor.setDecorations(this.attach('after', text, muted), [{ range: endOf(16) }]);
		});

		// P2b — the same three types, but one anchor each (control group).
		['P2B-1', 'P2B-2', 'P2B-3'].forEach((text, index) => {
			editor.setDecorations(this.attach('after', text, muted), [{ range: endOf(19 + index) }]);
		});

		// P3 — same-anchor stacking with the full-width / struck-through styling.
		['P3-OLD-1', 'P3-OLD-2', 'P3-OLD-3'].forEach((text) => {
			editor.setDecorations(
				this.attach('after', text, {
					color: new vscode.ThemeColor('descriptionForeground'),
					backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
					textDecoration: 'line-through',
					border: '1px solid',
					borderColor: new vscode.ThemeColor('diffEditor.removedTextBorder'),
					margin: '0 0 0 12px',
					width: '100%',
				}),
				[{ range: endOf(23) }],
			);
		});

		// P4 — 'before' attachment on the very first line (S === 0 path).
		const p4 = this.attach('before', 'P4-BEFORE-LINE-0', {
			...muted,
			backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
			textDecoration: 'line-through',
			width: '100%',
		});
		editor.setDecorations(p4, [{ range: at(0) }]);

		// P5 — ClosedClosed stability under neighbouring edits.
		const p5 = this.attach('after', 'P5-ClosedClosed', muted);
		editor.setDecorations(p5, [{ range: endOf(33) }]);

		// P7 — raw CSS injection through `textDecoration` (proposed trick): does a single
		// attachment become an N-row block, and does it take N rows of layout?
		const p7Text = 'P7-OLD-1\nP7-OLD-2\nP7-OLD-3';
		const p7 = this.attach('after', '', {
			textDecoration: `none; content: "${p7Text.replace(/\n/g, '\\A ')}"; white-space: pre; display: block; background-color: var(--vscode-diffEditor-removedLineBackground); color: var(--vscode-descriptionForeground); width: 100%; box-sizing: border-box;`,
		});
		editor.setDecorations(p7, [{ range: endOf(10) }]);

		// P7b — same trick with hard-coded colours, to see whether both survive.
		const p7b = this.attach('after', '', {
			textDecoration: `none; content: "P7B-OLD-1\\A P7B-OLD-2\\A P7B-OLD-3"; white-space: pre; display: block; background-color: rgba(255, 107, 107, 0.15); color: #ff6b6b; width: 100%; box-sizing: border-box;`,
		});
		editor.setDecorations(p7b, [{ range: endOf(28) }]);

		// P6 — nothing to draw: the CodeLens provider already emits one row per pending hunk.
		output.appendLine('---------------------------------------------------------------');
		output.appendLine(`Rendering probe on ${document.fileName} (${document.lineCount} lines)`);
		output.appendLine('P1 (line 7)     : contentText 内含真实换行 —— 观察：换行是否生效、换行后的文本是否出现。');
		output.appendLine('P2 (line 17)    : 同一锚点 3 个不同类型 after 附件 —— 观察：几个可见。');
		output.appendLine('P2b (line 20/21/22): 同 3 个类型，但各挂一行（对照组）—— 观察：是否 3 个都可见。');
		output.appendLine('P3 (line 24)    : 同一锚点 3 个附件 + width:100% + line-through —— 观察：是否各占一行。');
		output.appendLine('P4 (line 1)     : before 附件挂第 0 行 —— 观察：是否渲染在第 1 行行首（S === 0 路径）。注意：h4 自己的 old 行也挂在同一 offset，若两者只有一行可见即为同位置冲突。');
		output.appendLine('P5 (line 34)    : ClosedClosed 附件 —— 观察：在其上下插入/删除文本后是否停在原行。');
		output.appendLine('P7 (line 11)    : 通过 textDecoration 注入 content/display:block 的 3 行块（主题色变量）—— 观察：CSS 是否生效、是否占 3 行、是否压住下方代码。');
		output.appendLine('P7b (line 29)   : 同上但用硬编码颜色 —— 观察：与 P7 的差异。');
		output.appendLine('P6              : 每个 pending hunk 锚点处应有 3 个 CodeLens（Accept / Reject / 状态）；点击 Accept 只应命中该 hunk。');
		output.appendLine('---------------------------------------------------------------');
		output.show(true);
	}
}
