/**
 * Keeping the model true while the document moves (D19 / D3).
 *
 * Only the change event carries the *timing* we need: an edit lands, the document text is already the
 * post-edit text, and the model has to be reconciled against it in the same tick. Saves and
 * configuration changes only affect the picture, so they ask for a re-render and nothing more.
 *
 * Our own edits are absorbed first (see `selfEdits.ts`); the verdict path reconciles those itself,
 * from the texts it knows, because a change event's span is off by one line for a whole-line
 * replacement.
 */

import * as vscode from 'vscode';

import { splitLines } from '@agentdock/core';

import type { ReviewStore } from '../session/store';
import type { SelfEditRegistry } from './selfEdits';

export interface DocumentSyncOptions {
	/** The store, when a session has one: the sidecar starts lazily, so this may be absent. */
	store(): ReviewStore | undefined;
	selfEdits: SelfEditRegistry;
	/** Re-render the review surface (insets, decorations, lenses, Changes view). */
	onChanged(): void;
	log(message: string): void;
}

export function registerDocumentSync(options: DocumentSyncOptions): vscode.Disposable {
	const { selfEdits } = options;

	const onDocumentChange = vscode.workspace.onDidChangeTextDocument((event) => {
		const store = options.store();
		if (store === undefined) return;
		const path = relativePath(event.document.uri);
		if (path === undefined || store.fileOf(path) === undefined) return;
		if (selfEdits.isOwn(event)) {
			options.log(`[change] absorbed own edit (${event.contentChanges.length} change(s)) in ${path}`);
			options.onChanged();
			return;
		}
		// The whole text, not the reported spans: the model reconciles documents, and a span VS Code
		// normalised (or a change event that arrived in two parts) would leave the ranges short.
		store.reconcile(path, splitLines(event.document.getText()));
		options.onChanged();
	});

	const onDocumentSave = vscode.workspace.onDidSaveTextDocument(() => options.onChanged());
	const onConfiguration = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration('agentdock') || event.affectsConfiguration('editor')) options.onChanged();
	});
	const onEditorChange = vscode.window.onDidChangeActiveTextEditor(() => options.onChanged());

	return vscode.Disposable.from(onDocumentChange, onDocumentSave, onConfiguration, onEditorChange);
}

/** Workspace-relative POSIX path — the model's only path form (M7). */
export function relativePath(uri: vscode.Uri): string | undefined {
	const relative = vscode.workspace.asRelativePath(uri, false);
	if (relative.length === 0 || /^[a-z][a-z0-9+.-]*:/i.test(relative)) return undefined;
	return relative.replace(/\\/g, '/');
}
