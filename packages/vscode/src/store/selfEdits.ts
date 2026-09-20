/**
 * Our own edits, told apart from the user's.
 *
 * A `WorkspaceEdit` we issue comes back as a `TextDocumentChangeEvent`, and treating it as a user edit
 * would reconcile the model against its own revert — the hunk would look as if the user had rewritten
 * it. The PoC's answer is the one that survives review: record the exact edit we are about to apply and
 * absorb only a change event that matches it *completely* (same ranges, same text, same count), so a
 * user edit that merely looks similar still falls through to the reconcile path.
 *
 * Line coordinates after our own edits are never taken from the change event: VS Code reports a
 * normalised span, which is off by one line for a whole-line replacement. The verdict path recomputes
 * from the reject plan and the document text instead.
 */

import * as vscode from 'vscode';

export interface SelfEdit {
	uri: string;
	range: vscode.Range;
	text: string;
}

export class SelfEditRegistry {
	private readonly pending: SelfEdit[] = [];

	/** Called *before* `applyEdit`, so an event delivered first still finds its expectation. */
	expect(edits: readonly SelfEdit[]): void {
		this.pending.push(...edits);
	}

	/** Called once the apply has settled, in a `finally`. */
	settle(edits: readonly SelfEdit[]): void {
		for (const edit of edits) {
			const index = this.pending.indexOf(edit);
			if (index >= 0) this.pending.splice(index, 1);
		}
	}

	/** True only when this change event is byte-for-byte the edit we just issued. */
	isOwn(event: vscode.TextDocumentChangeEvent): boolean {
		const expected = this.pending.filter((edit) => edit.uri === event.document.uri.toString());
		if (expected.length === 0 || expected.length !== event.contentChanges.length) return false;
		const changes = event.contentChanges.slice();
		for (const edit of expected) {
			const index = changes.findIndex((change) => change.range.isEqual(edit.range) && change.text === edit.text);
			if (index < 0) return false;
			changes.splice(index, 1);
		}
		return true;
	}
}
