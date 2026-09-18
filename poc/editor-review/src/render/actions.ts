/**
 * Scheme A, action layer: one CodeLens row per pending hunk carrying the
 * hunk id as the command argument, so a click can never hit the wrong hunk.
 *
 * This is the action row for `decorations` and `insets` mode. Note that VS Code
 * refreshes the row on a timer: after Accept / Reject the clicked row stays on screen
 * for ~400ms (measured, RESULTS.md R6). Insets cannot host buttons instead (`command:`
 * links inside an inset never fire) and CodeLens is the only stable inline affordance,
 * so the delay stands; `comments` mode is the one with instant buttons.
 */

import * as vscode from 'vscode';
import { Hunk, TurnChangeSet } from '../model/changeSet';

const STATUS_LENS: Record<string, string> = {
	pending: '$(info) Agent change · pending',
	accepted: '$(pass) Agent change · accepted',
	rejected: '$(circle-slash) Agent change · rejected',
	stale: '$(warning) Agent change · stale（边界已被编辑，仅可 Reset Fixture）',
};

/**
 * A CodeLens renders ABOVE its anchor line, so anchor one line past the hunk's own
 * content: directly below the new side when the hunk has one, directly below the
 * old-side rows otherwise. Anchoring at the hunk's first line puts the row above
 * the change and, for a pure deletion, leaves real code text between the two.
 */
function anchorRange(hunk: Hunk, document: vscode.TextDocument): vscode.Range {
	const line =
		hunk.targetRange.end >= hunk.targetRange.start
			? hunk.targetRange.end + 1
			: Math.max(0, hunk.anchorLine) + 1;
	const clamped = Math.max(0, Math.min(line, document.lineCount - 1));
	return new vscode.Range(clamped, 0, clamped, 0);
}

export class HunkCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.emitter.event;

	constructor(
		private readonly getChangeSet: () => TurnChangeSet | undefined,
		private readonly isFixtureDocument: (document: vscode.TextDocument) => boolean,
		/** true only in `decorations` mode, where the old side is collapsed into one row
		 *  and the count of the remaining deleted lines needs that extra affordance:
		 *  `comments` mode shows every line in the widget, `insets` mode as real rows. */
		private readonly isOldSideCollapsed: () => boolean,
		/** Called at the end of every query for the fixture document. VS Code rebuilds the
		 *  CodeLens row right after this call, so it doubles as the "row is about to update"
		 *  callback: the decorations and insets are committed there to keep one transition. */
		private readonly onQuery: () => void,
	) {}

	dispose(): void {
		this.emitter.dispose();
	}

	refresh(): void {
		this.emitter.fire();
	}

	/**
	 * `deleted N more line(s)...` as an item of the hunk's CodeLens row, so everything
	 * about a hunk (count of collapsed lines + Accept / Reject / status) stays on one
	 * line. Clicking it shows the same hover as the old-side row itself.
	 */
	private collapsedLinesLens(hunk: Hunk, range: vscode.Range): vscode.CodeLens[] {
		const remaining = hunk.baselineLines.length - 1;
		if (remaining < 1 || !this.isOldSideCollapsed()) {
			return [];
		}
		return [
			new vscode.CodeLens(range, {
				title: `deleted ${remaining} more line${remaining === 1 ? '' : 's'}...`,
				command: 'agentReview.showDeletedLines',
				arguments: [hunk.id],
			}),
		];
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		if (!this.isFixtureDocument(document)) {
			return [];
		}
		const lenses: vscode.CodeLens[] = [];
		for (const hunk of this.getChangeSet()?.hunks ?? []) {
			const range = anchorRange(hunk, document);
			if (hunk.status === 'stale') {
				// No Accept / Reject while the hunk cannot be located; the only way out is a reset.
				lenses.push(
					new vscode.CodeLens(range, {
						title: STATUS_LENS.stale,
						command: 'agentReview.resetFixture',
					}),
				);
				continue;
			}
			if (!hunk.tracked || hunk.status !== 'pending') {
				continue;
			}
			lenses.push(...this.collapsedLinesLens(hunk, range));
			const statusLens = new vscode.CodeLens(range);
			statusLens.command = {
				title: hunk.userEdited
					? '$(edit) Agent change · 已手动编辑 new 侧（Accept 采纳当前文本，Reject 回滚为原文）'
					: STATUS_LENS.pending,
				command: 'agentReview.showHunkDetails',
			};
			lenses.push(
				new vscode.CodeLens(range, {
					title: '$(check) Accept',
					command: 'agentReview.acceptHunk',
					arguments: [hunk.id],
				}),
				new vscode.CodeLens(range, {
					title: '$(x) Reject',
					command: 'agentReview.rejectHunk',
					arguments: [hunk.id],
				}),
			statusLens,
		);
		}
		this.onQuery();
		return lenses;
	}
}
