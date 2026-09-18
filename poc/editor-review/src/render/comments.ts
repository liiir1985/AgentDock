/**
 * Scheme B: Comments API inline block.
 *
 * One comment thread per pending hunk, ranged over the line ABOVE the hunk's content.
 * The widget renders below the last line of the thread range, so the block lands
 * between that surviving line and the new side — where the deleted lines used to be —
 * and it pushes the new side down instead of covering it. It carries the full
 * multi-line diff as Markdown plus the Accept / Reject buttons contributed by
 * package.json (`comments/commentThread/title`).
 */

import * as vscode from 'vscode';
import { Hunk, TurnChangeSet } from '../model/changeSet';
import { hunkDiffMarkdown } from './hunkText';

export const COMMENT_CONTROLLER_ID = 'agentdock.review';
export const THREAD_PENDING = 'agentdockHunkPending';
export const THREAD_STALE = 'agentdockHunkStale';

export class CommentsRenderer implements vscode.Disposable {
	private readonly controller: vscode.CommentController;
	private readonly threads = new Map<string, vscode.CommentThread>();
	private readonly hunkIdByThread = new Map<vscode.CommentThread, string>();

	constructor() {
		this.controller = vscode.comments.createCommentController(COMMENT_CONTROLLER_ID, 'Agent Changes');
		// No commentingRangeProvider on purpose: the "+" affordance must not appear,
		// threads are created only by this extension.
	}

	dispose(): void {
		for (const thread of this.threads.values()) {
			thread.dispose();
		}
		this.threads.clear();
		this.hunkIdByThread.clear();
		this.controller.dispose();
	}

	hunkIdOfThread(thread: vscode.CommentThread): string | undefined {
		return this.hunkIdByThread.get(thread);
	}

	private threadRange(hunk: Hunk, document: vscode.TextDocument): vscode.Range {
		const last = document.lineCount - 1;
		// The widget renders below the LAST line of the thread range, so the range ends on
		// the line right above the hunk's content (`targetRange.start - 1`): the widget then
		// lands between the surviving line above and the new side — the position the deleted
		// lines occupied — instead of below the new text. Pure deletions have `start - 1` as
		// their own anchor line anyway, so this is one rule for both shapes.
		const line = Math.max(0, Math.min(hunk.targetRange.start - 1, last));
		return new vscode.Range(line, 0, line, document.lineAt(line).text.length);
	}

	render(document: vscode.TextDocument, changeSet: TurnChangeSet | undefined): void {
		const pending = (changeSet?.hunks ?? []).filter((hunk) => hunk.tracked && hunk.status === 'pending');
		const live = new Set<string>(pending.map((hunk) => hunk.id));

		for (const [id, thread] of this.threads) {
			if (!live.has(id)) {
				thread.dispose();
				this.threads.delete(id);
				this.hunkIdByThread.delete(thread);
			}
		}

		for (const hunk of pending) {
			const comment: vscode.Comment = {
				body: hunkDiffMarkdown(hunk, document),
				mode: vscode.CommentMode.Preview,
				author: { name: 'Agent' },
				label: hunk.status,
			};
			const existing = this.threads.get(hunk.id);
			const thread = existing ?? this.controller.createCommentThread(document.uri, this.threadRange(hunk, document), [comment]);
			thread.range = this.threadRange(hunk, document);
			thread.comments = [comment];
			thread.canReply = false;
			thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
			thread.label = `Hunk ${hunk.id} · ${hunk.status}`;
			thread.contextValue = hunk.userEdited ? THREAD_STALE : THREAD_PENDING;
			if (!existing) {
				this.threads.set(hunk.id, thread);
				this.hunkIdByThread.set(thread, hunk.id);
			}
		}
	}
}
