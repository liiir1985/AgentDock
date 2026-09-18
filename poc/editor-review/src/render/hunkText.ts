/** Text helpers shared by both rendering schemes. */

import * as vscode from 'vscode';
import { Hunk } from '../model/changeSet';

/** Current document text of the hunk's new side ([] for a pure deletion). */
export function newSideLines(hunk: Hunk, document: vscode.TextDocument): string[] {
	const start = hunk.targetRange.start;
	const end = Math.min(hunk.targetRange.end, document.lineCount - 1);
	const lines: string[] = [];
	for (let line = start; line <= end; line++) {
		lines.push(document.lineAt(line).text);
	}
	return lines;
}

/**
 * Hover for the old-side row: the deleted lines only. The new side is normal,
 * complete document text, so it never needs a hover of its own.
 */
export function deletedLinesMarkdown(hunk: Hunk): vscode.MarkdownString {
	const count = hunk.baselineLines.length;
	const markdown = new vscode.MarkdownString();
	markdown.appendMarkdown(
		`**Hunk ${hunk.id}** · ${count} line${count === 1 ? '' : 's'} deleted${hunk.userEdited ? ' · 已手动编辑 new 侧' : ''}\n\n`,
	);
	markdown.appendCodeblock(
		hunk.baselineLines.map((line) => `- ${line}`).join('\n'),
		'diff',
	);
	return markdown;
}

/**
 * Both sides, for the widget in scheme B — there the diff is the whole content of
 * the comment, so it carries the new side as well.
 */
export function hunkDiffMarkdown(hunk: Hunk, document: vscode.TextDocument): vscode.MarkdownString {
	const newLines = newSideLines(hunk, document);
	const markdown = new vscode.MarkdownString();
	const summary = [`${hunk.baselineLines.length} line${hunk.baselineLines.length === 1 ? '' : 's'} deleted`];
	if (newLines.length > 0) {
		summary.push(`${newLines.length} line${newLines.length === 1 ? '' : 's'} in the document`);
	}
	if (hunk.userEdited) {
		summary.push('已手动编辑 new 侧');
	}
	markdown.appendMarkdown(`**Hunk ${hunk.id}** · ${summary.join(' · ')}\n\n`);
	markdown.appendCodeblock(
		hunk.baselineLines
			.map((line) => `- ${line}`)
			.concat(newLines.map((line) => `+ ${line}`))
			.join('\n'),
		'diff',
	);
	return markdown;
}
