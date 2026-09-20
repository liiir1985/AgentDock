/**
 * Accept / Reject, delivered to the editor (D26 / D28 / D3).
 *
 * Accept never touches the document: the agent already wrote it, so the decision only flips a status
 * (`verdict.ts` returns the updated model, this module writes it back). That is what makes Ctrl+Z after
 * Accept a no-op for the file.
 *
 * Reject is the only path that writes, and it writes through `WorkspaceEdit` so the change lands in the
 * native undo stack — `undo` after a Reject has to bring the agent's text back. The core returns
 * `fileOps` first and `plans` in descending order, and applying them in exactly that order is what
 * keeps every plan addressing the coordinates it was computed in: no recomputation, no shifting.
 *
 * Every affected document is saved immediately (D28). The accepted cost is that a user's unrelated
 * unsaved edits to that file are saved along with ours.
 */

import { existsSync } from 'node:fs';

import * as vscode from 'vscode';

import {
	type FileChange,
	type FileOp,
	type FileRejectOutcome,
	type RejectPlan,
	acceptFile,
	acceptHunk,
	joinLines,
	rejectFile,
	rejectHunk,
	splitLines,
} from '@agentdock/core';

import type { ReviewStore } from '../session/store';
import type { SelfEdit, SelfEditRegistry } from '../store/selfEdits';
import { relativePath } from '../store/documentSync';

export interface VerdictOptions {
	store: ReviewStore;
	selfEdits: SelfEditRegistry;
	log(message: string): void;
	/** Re-render the review surface after a decision. */
	onChanged(): void;
}

export class Verdicts {
	/** Two concurrent whole-file replaces would produce change events matching neither's expectation. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly options: VerdictOptions) {}

	acceptHunk(path: string, hunkId: string): void {
		const file = this.options.store.fileOf(path);
		if (file === undefined) return;
		this.options.store.replaceFile(acceptHunk(file, hunkId));
		this.options.log(`[accept] ${path} ${hunkId}`);
		this.options.onChanged();
	}

	acceptFile(path: string): void {
		const file = this.options.store.fileOf(path);
		if (file === undefined) return;
		this.options.store.replaceFile(acceptFile(file));
		this.options.log(`[accept] file ${path}`);
		this.options.onChanged();
	}

	acceptAll(): void {
		for (const entry of this.options.store.reviewEntries()) {
			this.options.store.replaceFile(acceptFile(entry.file));
		}
		this.options.log('[accept] all');
		this.options.onChanged();
	}

	rejectHunk(path: string, hunkId: string): Promise<void> {
		const file = this.options.store.fileOf(path);
		if (file === undefined) return Promise.resolve();
		const outcome = rejectHunk(file, hunkId);
		return this.serialise(() => this.apply(outcome, path, file));
	}

	rejectFile(path: string): Promise<void> {
		const file = this.options.store.fileOf(path);
		if (file === undefined) return Promise.resolve();
		const outcome = rejectFile(file);
		return this.serialise(() => this.apply(outcome, path, file));
	}

	/**
	 * Reject All walks the review face file by file.
	 *
	 * One `rejectTurn` call cannot express this: the review face spans turns (M8), and each file's
	 * hunks have to be planned — and applied — against its own document.
	 */
	async rejectAll(): Promise<void> {
		for (const entry of this.options.store.reviewEntries()) {
			const file = this.options.store.fileOf(entry.path);
			if (file === undefined) continue;
			const outcome = rejectFile(file);
			if (outcome.plans.length === 0 && outcome.fileOps.length === 0) continue;
			await this.serialise(() => this.apply(outcome, entry.path, file));
		}
		this.options.log('[reject] all');
	}

	/** Serialised: the edits this method issues must not interleave with another verdict's. */
	private serialise<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task, task);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async apply(outcome: FileRejectOutcome, path: string, previous: FileChange): Promise<void> {
		const { store, log } = this.options;
		// Statuses first: the reconcile below must see hunks that are already decided, or it would
		// re-locate them as if they were still under review.
		store.replaceFile(outcome.file);

		const edit = new vscode.WorkspaceEdit();
		const selfEdits: SelfEdit[] = [];
		const targets = new Map<string, vscode.Uri>();
		const deleted: string[] = [];
		// `WorkspaceEdit.size` counts *text* edits only — a file-operation-only edit reports 0 — so the
		// question "is there anything to apply" is answered here instead of by asking the edit.
		let hasWork = false;

		for (const op of outcome.fileOps) {
			hasWork = (await this.addFileOp(edit, op, targets, deleted, selfEdits, log)) || hasWork;
		}
		for (const plan of outcome.plans) {
			const uri = await this.documentUri(plan.path);
			if (uri === undefined) {
				log(`[reject] skip ${plan.path}: the document is not available`);
				continue;
			}
			const document = await vscode.workspace.openTextDocument(uri);
			const editText = rejectText(plan, document);
			const range = rejectRange(plan, document);
			edit.replace(uri, range, editText);
			selfEdits.push({ uri: uri.toString(), range, text: editText });
			targets.set(plan.path, uri);
			hasWork = true;
		}

		const applied = await this.commit(edit, selfEdits, hasWork);
		if (!applied) {
			// The window refused the edit; the model must not claim a revert that never happened.
			store.replaceFile(previous);
			log(`[error] WorkspaceEdit rejected for ${path}; the model was restored`);
			this.options.onChanged();
			return;
		}

		for (const [target, uri] of targets) {
			await this.save(uri);
			const document = await vscode.workspace.openTextDocument(uri);
			store.reconcile(target, splitLines(document.getText()));
		}
		for (const target of deleted) store.forget(target);

		// A rename moved the content back to the old path, so the model has to follow it or every later
		// verdict would address a file that is no longer there (D6).
		const rename = outcome.fileOps.find((op) => op.kind === 'rename');
		if (rename !== undefined && rename.kind === 'rename') {
			store.forget(rename.from);
			store.replaceFile({ ...outcome.file, path: rename.to, fromPath: undefined, kind: 'modify' });
			const restored = await this.documentUri(rename.to);
			if (restored !== undefined) {
				const document = await vscode.workspace.openTextDocument(restored);
				store.reconcile(rename.to, splitLines(document.getText()));
			}
		}

		log(`[reject] ${path}: ${outcome.plans.length} plan(s), ${outcome.fileOps.length} file op(s)`);
		this.options.onChanged();
	}

	private async addFileOp(
		edit: vscode.WorkspaceEdit,
		op: FileOp,
		targets: Map<string, vscode.Uri>,
		deleted: string[],
		selfEdits: SelfEdit[],
		log: (message: string) => void,
	): Promise<boolean> {
		if (op.kind === 'rename') {
			const from = await this.documentUri(op.from);
			const to = await this.documentUri(op.to);
			if (from === undefined || to === undefined) {
				log(`[reject] skip rename ${op.from} → ${op.to}`);
				return false;
			}
			edit.renameFile(from, to);
			return true;
		}
		const uri = await this.documentUri(op.path);
		if (uri === undefined) {
			log(`[reject] skip ${op.kind} ${op.path}`);
			return false;
		}
		if (op.kind === 'delete') {
			edit.deleteFile(uri, { ignoreIfNotExists: true });
			deleted.push(op.path);
			return true;
		}
		// `write`: restoring a deleted file, or a whole-file revert with no plans.
		const text = joinLines(op.text);
		if (!existsSync(uri.fsPath)) {
			// A rejected delete: there is no document to edit and no undo entry to preserve — the file
			// did not exist in the editor either — so the bytes go down directly.
			await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
			targets.set(op.path, uri);
			return true;
		}
		const document = await vscode.workspace.openTextDocument(uri);
		const last = document.lineCount - 1;
		const range = new vscode.Range(0, 0, last, document.lineAt(last).text.length);
		edit.replace(uri, range, text);
		selfEdits.push({ uri: uri.toString(), range, text });
		targets.set(op.path, uri);
		return true;
	}

	/** `applyEdit` plus the self-edit bookkeeping that keeps the change event from looking like a user edit. */
	private async commit(edit: vscode.WorkspaceEdit, selfEdits: SelfEdit[], hasWork: boolean): Promise<boolean> {
		if (!hasWork) return true;
		this.options.selfEdits.expect(selfEdits);
		try {
			const applied = await vscode.workspace.applyEdit(edit);
			// One macrotask of slack so a change event delivered after the reply still finds its record.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			return applied;
		} finally {
			this.options.selfEdits.settle(selfEdits);
		}
	}

	private async save(uri: vscode.Uri): Promise<void> {
		const document = await vscode.workspace.openTextDocument(uri);
		if (document.isDirty) await document.save();
	}

	private async documentUri(path: string): Promise<vscode.Uri | undefined> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder === undefined) return undefined;
		return vscode.Uri.joinPath(folder.uri, ...path.split('/'));
	}
}

/**
 * A whole-line replacement, clamped to the document's end.
 *
 * A plan that reaches past the final line (a file without a trailing terminator) has to be clamped to
 * the end of that line, or VS Code rejects the range.
 */
export function rejectRange(plan: RejectPlan, document: vscode.TextDocument): vscode.Range {
	const last = document.lineCount - 1;
	if (plan.endLineExclusive <= last) return new vscode.Range(plan.startLine, 0, plan.endLineExclusive, 0);
	return new vscode.Range(plan.startLine, 0, last, document.lineAt(last).text.length);
}

/**
 * The bytes a plan puts back, with the one correction a line-based edit needs.
 *
 * The old side carries its own terminators, so joining it reproduces the baseline exactly — except
 * where a line has no terminator at all (`''` means "end of file" in the model). Anywhere but the
 * document's final line that would concatenate two lines, so the document's terminator is substituted
 * exactly as the Core's own `replaceRange` does. The count of rows is what the range covers; the text
 * must fill it line for line.
 */
export function rejectText(plan: RejectPlan, document: vscode.TextDocument): string {
	if (plan.text.lines.length === 0) return '';
	const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
	const reachesEof = plan.endLineExclusive > document.lineCount - 1;
	const lines = [...plan.text.lines];
	const eols = plan.text.lines.map((_, index) => plan.text.eols[index] ?? '');
	for (let index = 0; index < eols.length - 1; index++) {
		if (eols[index] === '') eols[index] = eol;
	}
	if (!reachesEof && eols[eols.length - 1] === '') eols[eols.length - 1] = eol;
	return lines.map((line, index) => line + eols[index]).join('');
}

