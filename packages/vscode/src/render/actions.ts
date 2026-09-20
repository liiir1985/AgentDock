/**
 * The action layer: one CodeLens row per hunk, plus the top row with the file-level actions (D11).
 *
 * A CodeLens row is the only stable inline affordance for Accept / Reject: insets cannot host
 * buttons (`command:` links inside an inset never fire — verified in a live window, see
 * `insets.ts`) and decorations have no interaction at all.
 *
 * `provideCodeLenses` doubles as the render synchronisation point. VS Code rebuilds the row only
 * when it queries the provider (~400ms after the state change, measured in the PoC's R6) and there
 * is no "the row was rebuilt" callback, so the insets and the new-side decorations are committed
 * inside that very query: Accept / Reject then produce ONE visual transition instead of a document
 * that jumps twice. Text-driven updates stay immediate for the same reason in reverse — see
 * `sync.ts`. Every query therefore ends with `onQuery()`, including the one that returns no lenses:
 * a document with nothing to draw still has to release the pending commit.
 *
 * Informational lenses (the `k/n` counter, a hunk's status) carry `command: ''`. The workbench
 * renders a lens title *through* its command (a lens without one draws nothing at all), and it
 * renders a clickable link only when `command.id` is truthy — an empty id gives an inert span with
 * the title. That is the only way to show a label through the stable API without offering an action.
 */

import * as vscode from 'vscode';
import type { Hunk } from '@agentdock/core';

export interface HunkLensContext {
	/** Every hunk of the file this document belongs to (all statuses), or [] when the document is untracked. */
	hunksFor(document: vscode.TextDocument): Hunk[];
	/** Called at the very end of every `provideCodeLenses` query — the visual commit is synchronised to it. */
	onQuery(): void;
}

const PENDING_LENS = '$(info) Agent change · pending';
const USER_EDITED_LENS = '$(edit) 已手动编辑 new 侧（Accept 采纳当前文本，Reject 回滚为原文）';
/**
 * A hunk the user's own edit landed inside cannot be located any more, so the model drops it instead
 * of rewriting it (D19). It disappears from the document (there is nothing left to reject) but has to
 * stay visible here, otherwise the review would silently lose a change the agent made.
 */
const CONFLICT_LENS = '$(warning) 冲突丢弃 · 未写盘';

/**
 * A CodeLens renders ABOVE its anchor line, so anchor one line past the hunk's own content:
 * directly below the new side when the hunk has one, directly below the old-side rows otherwise.
 * Anchoring at the hunk's first line puts the row above the change and, for a pure deletion, leaves
 * real code text between the two.
 */
function anchorRange(hunk: Hunk, document: vscode.TextDocument): vscode.Range {
	const line =
		hunk.targetRange.end >= hunk.targetRange.start
			? hunk.targetRange.end + 1
			: Math.max(0, hunk.anchor.line) + 1;
	const clamped = Math.max(0, Math.min(line, document.lineCount - 1));
	return new vscode.Range(clamped, 0, clamped, 0);
}

/**
 * The `k` of the `k/n` counter: 1-based position, by line and across all statuses, of the first hunk
 * whose new side is inside one of the visible editor's ranges. Falling back to 1 keeps the counter
 * meaningful while the document is not on screen (the Changes view can open one without focusing it).
 */
function firstVisibleHunk(document: vscode.TextDocument, hunks: Hunk[]): number {
	const editor = vscode.window.visibleTextEditors.find(
		(candidate) => candidate.document.uri.toString() === document.uri.toString(),
	);
	if (!editor) {
		return 1;
	}
	const byPosition = hunks.slice().sort((a, b) => a.targetRange.start - b.targetRange.start);
	for (let index = 0; index < byPosition.length; index++) {
		const { start, end } = byPosition[index].targetRange;
		// An empty range (`end < start`) still points at one line: `start` itself.
		const first = start;
		const last = end >= start ? end : start;
		if (editor.visibleRanges.some((range) => first <= range.end.line && last >= range.start.line)) {
			return index + 1;
		}
	}
	return 1;
}

export class HunkCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.emitter.event;

	constructor(private readonly context: HunkLensContext) {}

	dispose(): void {
		this.emitter.dispose();
	}

	refresh(): void {
		this.emitter.fire();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const hunks = this.context.hunksFor(document);
		if (hunks.length === 0) {
			this.context.onQuery();
			return [];
		}
		// Command arguments travel by path + hunk id, never by a captured hunk object: a click can
		// then never hit the wrong hunk (or a stale copy of one).
		const path = vscode.workspace.asRelativePath(document.uri, false);
		const lenses: vscode.CodeLens[] = [];
		if (hunks.some((hunk) => hunk.status === 'pending')) {
			// M11: the `editor/title` menu cannot carry a dynamic label, so the actions that apply to
			// the whole file live on one row above line 0 instead, together with the position counter.
			const top = new vscode.Range(0, 0, 0, 0);
			lenses.push(
				new vscode.CodeLens(top, {
					title: '$(check) Accept All',
					command: 'agentdock.acceptAll',
					arguments: [],
				}),
				new vscode.CodeLens(top, { title: '$(x) Reject All', command: 'agentdock.rejectAll', arguments: [] }),
				new vscode.CodeLens(top, { title: '$(chevron-left)', command: 'agentdock.prevHunk', arguments: [] }),
				new vscode.CodeLens(top, {
					title: `${firstVisibleHunk(document, hunks)}/${hunks.length}`,
					command: '',
					arguments: [],
				}),
				new vscode.CodeLens(top, { title: '$(chevron-right)', command: 'agentdock.nextHunk', arguments: [] }),
			);
		}
		for (const hunk of hunks) {
			const range = anchorRange(hunk, document);
			if (hunk.status === 'pending') {
				lenses.push(
					new vscode.CodeLens(range, {
						title: '$(check) Accept',
						command: 'agentdock.acceptHunk',
						arguments: [path, hunk.id],
					}),
					new vscode.CodeLens(range, {
						title: '$(x) Reject',
						command: 'agentdock.rejectHunk',
						arguments: [path, hunk.id],
					}),
					// Rejecting a hunk the user has edited since restores the old side over the user's
					// text too, so the row has to say it before the click rather than after (D3).
					new vscode.CodeLens(range, {
						title: hunk.userEdited ? USER_EDITED_LENS : PENDING_LENS,
						command: '',
						arguments: [],
					}),
				);
				continue;
			}
			if (hunk.status === 'rejected' && hunk.rejectReason === 'conflict') {
				lenses.push(new vscode.CodeLens(range, { title: CONFLICT_LENS, command: '', arguments: [] }));
			}
			// `accepted` renders nothing: D26 makes Accept a no-op on the document, so there is
			// nothing left to do or to warn about. A plain `rejected` hunk is gone from the document
			// and was already accounted for by the click that rejected it.
		}
		this.context.onQuery();
		return lenses;
	}
}
