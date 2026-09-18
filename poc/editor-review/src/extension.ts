/**
 * Extension wiring (plan step 4). Everything that touches the `vscode` API for
 * the review lifecycle lives here; the model stays pure.
 *
 * Two invariants drive the shape of this file:
 *
 * 1. Our own edits must never look like user edits. `pendingSelfEdits` records
 *    the exact `WorkspaceEdit` we are about to apply; the change event is
 *    absorbed only when it matches that record *exactly* (same ranges, same
 *    text), so a user edit that merely looks similar still falls through to the
 *    reconcile path.
 * 2. Line coordinates after our own reject edits are recomputed from the reject
 *    plan (`changeFromRejectEdit`), never from the change event: a change event
 *    reports VS Code's normalised span, which is off by one line for a
 *    whole-line replacement.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { HunkStatus, RejectEdit, TurnChangeSet, changeFromText } from './model/changeSet';
import { loadFixture } from './model/fixture';
import { changeFromRejectEdit, reconcile, rejectEdit, staleDiagnostic } from './model/reconcile';
import { HunkCodeLensProvider } from './render/actions';
import { CommentsRenderer } from './render/comments';
import { DecorationRenderer } from './render/decorations';
import { InsetsRenderer } from './render/insets';
import { ProbeRenderer } from './render/probe';

interface SelfEdit {
	uri: vscode.Uri;
	range: vscode.Range;
	text: string;
}

let fixtureDir: vscode.Uri;
let fixtureUri: vscode.Uri;
let output: vscode.OutputChannel;
let decorations: DecorationRenderer;
let comments: CommentsRenderer;
let insets: InsetsRenderer;
let probe: ProbeRenderer;
let codeLenses: HunkCodeLensProvider;
let changeSet: TurnChangeSet | undefined;
const pendingSelfEdits: SelfEdit[] = [];
let commandQueue: Promise<unknown> = Promise.resolve();

function isFixture(document: vscode.TextDocument): boolean {
	return document.uri.toString() === fixtureUri.toString();
}

function renderMode(): 'decorations' | 'comments' | 'insets' {
	return vscode.workspace
		.getConfiguration('agentReview')
		.get<'decorations' | 'comments' | 'insets'>('renderMode', 'decorations');
}

function fullRange(document: vscode.TextDocument): vscode.Range {
	const last = document.lineCount - 1;
	return new vscode.Range(0, 0, last, document.lineAt(last).text.length);
}

function eolOf(document: vscode.TextDocument): string {
	return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

function hunkById(id: string) {
	return changeSet?.hunks.find((hunk) => hunk.id === id);
}

/** Commands that mutate the document are serialised: two concurrent whole-file
 *  replaces would produce a change event matching neither's expectations. */
function serialise<T>(task: () => Promise<T>): Promise<T> {
	const run = commandQueue.then(task, task);
	commandQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** An editor created before the window finished restoring may not be in
 *  `visibleTextEditors` yet, and no later event would re-render it. */
const RENDER_RETRY_LIMIT = 5;
const RENDER_RETRY_DELAY = 200;
let renderRetries = 0;

/**
 * Accept / Reject must produce exactly ONE visual transition: the deleted rows (insets),
 * the new-side highlight (decorations) and the CodeLens action row all land together, or
 * the document jumps twice. VS Code rebuilds the CodeLens row only when it queries the
 * provider (~400ms after the state change, measured in RESULTS.md R6) and there is no
 * "row updated" callback, so `provideCodeLenses` *is* the synchronisation point: the
 * visuals are committed inside that query. Text-driven updates (typing, patch apply) stay
 * immediate — deferring those would leave the highlight trailing the cursor.
 */
const VISUAL_FALLBACK_MS = 1000;
let visualDirty = false;
let visualFallback: NodeJS.Timeout | undefined;

function flushVisual(): void {
	if (visualFallback) {
		clearTimeout(visualFallback);
		visualFallback = undefined;
	}
	if (!visualDirty) {
		return;
	}
	visualDirty = false;
	commitVisual();
}

/** Commit everything in the same tick as the CodeLens rebuild (the provider calls back). */
function refreshSynced(): void {
	visualDirty = true;
	codeLenses.refresh();
	if (!visualFallback) {
		// Safety net: if the row is never queried (fixture not rendered), don't stay stale.
		visualFallback = setTimeout(flushVisual, VISUAL_FALLBACK_MS);
	}
}

function render(editor?: vscode.TextEditor): void {
	commitVisual(editor);
	codeLenses.refresh();
}

function commitVisual(editor?: vscode.TextEditor): void {
	const target =
		editor && isFixture(editor.document)
			? editor
			: vscode.window.visibleTextEditors.find((candidate) => isFixture(candidate.document));
	if (target) {
		renderRetries = 0;
		const mode = renderMode();
		if (mode === 'insets') {
			comments.render(target.document, undefined);
			insets.render(target, changeSet);
			// old side comes from the insets, the new-side highlight still comes from decorations
			decorations.render(target, changeSet, false);
		} else if (mode === 'comments') {
			decorations.render(target, undefined);
			insets.render(target, undefined);
			comments.render(target.document, changeSet);
		} else {
			comments.render(target.document, undefined);
			insets.render(target, undefined);
			decorations.render(target, changeSet);
		}
	} else if (changeSet && renderRetries < RENDER_RETRY_LIMIT) {
		renderRetries++;
		setTimeout(() => commitVisual(), RENDER_RETRY_DELAY);
	}
}

async function applyDocumentEdits(edits: SelfEdit[]): Promise<boolean> {
	if (edits.length === 0) {
		return true;
	}
	const workspaceEdit = new vscode.WorkspaceEdit();
	for (const edit of edits) {
		workspaceEdit.replace(edit.uri, edit.range, edit.text);
	}
	pendingSelfEdits.push(...edits);
	let applied = false;
	try {
		applied = await vscode.workspace.applyEdit(workspaceEdit);
		// One macrotask of slack so a change event delivered after the applyEdit
		// reply still finds its expectation record.
		const slack = Promise.withResolvers<void>();
		setTimeout(slack.resolve, 0);
		await slack.promise;
	} finally {
		for (const edit of edits) {
			const index = pendingSelfEdits.indexOf(edit);
			if (index >= 0) {
				pendingSelfEdits.splice(index, 1);
			}
		}
	}
	return applied;
}

/**
 * True only when this change event is byte-for-byte the edit we just issued.
 * A partial match is a user edit and must not be swallowed.
 */
function isOwnEdit(event: vscode.TextDocumentChangeEvent): boolean {
	const expected = pendingSelfEdits.filter((edit) => edit.uri.toString() === event.document.uri.toString());
	if (expected.length === 0 || expected.length !== event.contentChanges.length) {
		return false;
	}
	const changes = event.contentChanges.slice();
	for (const edit of expected) {
		const index = changes.findIndex((change) => change.range.isEqual(edit.range) && change.text === edit.text);
		if (index < 0) {
			return false;
		}
		changes.splice(index, 1);
	}
	return true;
}

function rejectRange(plan: RejectEdit, document: vscode.TextDocument): vscode.Range {
	const last = document.lineCount - 1;
	if (plan.endLineExclusive <= last) {
		return new vscode.Range(plan.startLine, 0, plan.endLineExclusive, 0);
	}
	// The plan reaches past the final line (document without trailing EOL).
	return new vscode.Range(plan.startLine, 0, last, document.lineAt(last).text.length);
}

function rejectText(plan: RejectEdit, document: vscode.TextDocument): string {
	if (plan.insertedLines.length === 0) {
		return '';
	}
	const eol = eolOf(document);
	const trailing = plan.endLineExclusive <= document.lineCount - 1 ? eol : '';
	return plan.insertedLines.join(eol) + trailing;
}

async function applyFakePatch(): Promise<void> {
	const fixture = loadFixture(fixtureDir.fsPath);
	const document = await vscode.workspace.openTextDocument(fixtureUri);
	if (document.getText() !== fixture.targetText) {
		await applyDocumentEdits([{ uri: fixtureUri, range: fullRange(document), text: fixture.targetText }]);
	}
	changeSet = { file: fixtureUri.fsPath, hunks: fixture.hunks };
	output.appendLine(`[applyFakePatch] ${fixture.hunks.length} hunks, ${fixture.targetLines.length} lines`);
	for (const hunk of fixture.hunks) {
		output.appendLine(
			`  ${hunk.id}: baseline ${hunk.baselineLines.length} line(s) -> target [${hunk.targetRange.start}, ${hunk.targetRange.end}] anchor ${hunk.anchorLine} ${hunk.attachSide}`,
		);
	}
	const editor = await vscode.window.showTextDocument(document, { preview: false });
	render(editor);
}

async function resetFixture(): Promise<void> {
	const document = await vscode.workspace.openTextDocument(fixtureUri);
	const diskText = fs.readFileSync(fixtureUri.fsPath, 'utf8');
	if (document.getText() !== diskText) {
		await applyDocumentEdits([{ uri: fixtureUri, range: fullRange(document), text: diskText }]);
	}
	changeSet = undefined;
	output.appendLine('[resetFixture] baseline restored, change set dropped');
	const editor = await vscode.window.showTextDocument(document, { preview: false });
	render(editor);
}

function acceptHunkIds(ids: string[]): void {
	let count = 0;
	for (const id of ids) {
		const hunk = hunkById(id);
		if (!hunk || !hunk.tracked || hunk.status !== 'pending') {
			continue;
		}
		hunk.status = 'accepted';
		hunk.tracked = false;
		count++;
	}
	output.appendLine(`[accept] ${count} hunk(s): ${ids.join(', ')}`);
	refreshSynced();
}

async function rejectHunkIds(ids: string[]): Promise<void> {
	if (!changeSet) {
		return;
	}
	const document = await vscode.workspace.openTextDocument(fixtureUri);
	const plans: Array<{ id: string; plan: RejectEdit; previousStatus: HunkStatus; previousTracked: boolean }> = [];
	for (const id of ids) {
		const hunk = hunkById(id);
		if (!hunk) {
			continue;
		}
		const plan = rejectEdit(hunk);
		if (!plan) {
			output.appendLine(`[reject ${id}] 跳过：${staleDiagnostic()}`);
			continue;
		}
		plans.push({ id, plan, previousStatus: hunk.status, previousTracked: hunk.tracked });
	}
	const edits: SelfEdit[] = plans
		.filter(({ plan }) => !(plan.startLine === plan.endLineExclusive && plan.insertedLines.length === 0))
		.map(({ plan }) => ({
			uri: fixtureUri,
			range: rejectRange(plan, document),
			text: rejectText(plan, document),
		}));

	// Freeze before applying: the reconcile pass below must not treat the rejected
	// hunks' own ranges as user edits.
	for (const { id } of plans) {
		const hunk = hunkById(id);
		if (hunk) {
			hunk.status = 'rejected';
			hunk.tracked = false;
		}
	}
	const applied = await applyDocumentEdits(edits);
	if (!applied) {
		for (const { id, previousStatus, previousTracked } of plans) {
			const hunk = hunkById(id);
			if (hunk) {
				hunk.status = previousStatus;
				hunk.tracked = previousTracked;
			}
		}
		output.appendLine('[error] WorkspaceEdit 被拒绝，状态已回滚');
		refreshSynced();
		return;
	}
	for (const { plan } of plans) {
		changeSet = { ...changeSet, hunks: reconcile(changeSet.hunks, changeFromRejectEdit(plan)) };
	}
	output.appendLine(`[reject] ${plans.length} hunk(s): ${plans.map(({ id }) => id).join(', ')}`);
	refreshSynced();
}

function pendingIds(): string[] {
	return (changeSet?.hunks ?? []).filter((hunk) => hunk.tracked && hunk.status === 'pending').map((hunk) => hunk.id);
}

function handleChange(event: vscode.TextDocumentChangeEvent): void {
	if (!isFixture(event.document)) {
		return;
	}
	if (isOwnEdit(event)) {
		output.appendLine(`[change] absorbed own edit (${event.contentChanges.length} change(s))`);
		render();
		return;
	}
	if (changeSet) {
		for (const change of event.contentChanges) {
			const hunkChange = changeFromText(change.range.start.line, change.range.end.line, change.text);
			changeSet = { ...changeSet, hunks: reconcile(changeSet.hunks, hunkChange) };
			output.appendLine(
				`[change] user edit lines [${hunkChange.cs}, ${hunkChange.ce}] d=${hunkChange.d} -> stale=[${changeSet.hunks
					.filter((hunk) => hunk.status === 'stale')
					.map((hunk) => hunk.id)
					.join(',')}]`,
			);
		}
	}
	render();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	fixtureDir = vscode.Uri.joinPath(context.extensionUri, 'fixtures');
	fixtureUri = vscode.Uri.joinPath(fixtureDir, 'sample.ts');
	output = vscode.window.createOutputChannel('Agent Review');
	decorations = new DecorationRenderer();
	comments = new CommentsRenderer();
	insets = new InsetsRenderer();
	probe = new ProbeRenderer();
	codeLenses = new HunkCodeLensProvider(
		() => changeSet,
		(document) => isFixture(document),
		() => renderMode() === 'decorations',
		() => flushVisual(),
	);

	context.subscriptions.push(
		output,
		decorations,
		comments,
		insets,
		probe,
		codeLenses,
		vscode.commands.registerCommand('agentReview.applyFakePatch', () => serialise(applyFakePatch)),
		vscode.commands.registerCommand('agentReview.resetFixture', () => serialise(resetFixture)),
		vscode.commands.registerCommand('agentReview.acceptHunk', (id: string) => acceptHunkIds([id])),
		vscode.commands.registerCommand('agentReview.rejectHunk', (id: string) => serialise(() => rejectHunkIds([id]))),
		vscode.commands.registerCommand('agentReview.acceptFile', () => acceptHunkIds(pendingIds())),
		vscode.commands.registerCommand('agentReview.rejectFile', () => serialise(() => rejectHunkIds(pendingIds()))),
		vscode.commands.registerCommand('agentReview.acceptHunkFromThread', (thread: vscode.CommentThread) => {
			const id = comments.hunkIdOfThread(thread);
			if (id) {
				acceptHunkIds([id]);
			}
		}),
		vscode.commands.registerCommand('agentReview.rejectHunkFromThread', (thread: vscode.CommentThread) =>
			serialise(async () => {
				const id = comments.hunkIdOfThread(thread);
				if (id) {
					await rejectHunkIds([id]);
				}
			}),
		),
		vscode.commands.registerCommand('agentReview.setRenderMode', async (mode?: string) => {
			const chosen =
				mode ??
				(await vscode.window.showQuickPick(['decorations', 'comments', 'insets'], {
					title: 'Agent Review render mode',
				}));
			if (chosen !== 'decorations' && chosen !== 'comments' && chosen !== 'insets') {
				return;
			}
			await vscode.workspace
				.getConfiguration('agentReview')
				.update('renderMode', chosen, vscode.ConfigurationTarget.Global);
			output.appendLine(`[setRenderMode] ${chosen}`);
			render();
		}),
		vscode.commands.registerCommand('agentReview.probeRendering', () => {
			const editor = vscode.window.visibleTextEditors.find((candidate) => isFixture(candidate.document));
			if (!editor) {
				void vscode.window.showWarningMessage('Agent Review: 打开 fixtures/sample.ts 后再运行探针。');
				return;
			}
			probe.run(editor, output);
		}),
		vscode.commands.registerCommand('agentReview.showDeletedLines', async (id: string) => {
			const hunk = hunkById(id);
			if (!hunk || hunk.baselineLines.length === 0) {
				return;
			}
			const document = await vscode.workspace.openTextDocument(fixtureUri);
			const editor = await vscode.window.showTextDocument(document, { preview: false });
			const line = Math.max(0, Math.min(hunk.anchorLine, document.lineCount - 1));
			// Land the cursor on the attachment itself: `after` sits at the end of the line,
			// `before` at column 0.
			const column = hunk.attachSide === 'after' ? document.lineAt(line).text.length : 0;
			const position = new vscode.Position(line, column);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position));
			// The old-side row carries the deleted lines as its hover message, so showing
			// the hover at that position reproduces exactly the same popup.
			await vscode.commands.executeCommand('editor.action.showHover');
		}),
		vscode.commands.registerCommand('agentReview.showHunkDetails', () => {
			output.appendLine('---------------------------------------------------------------');
			for (const hunk of changeSet?.hunks ?? []) {
				output.appendLine(
					`${hunk.id}: ${hunk.status}${hunk.userEdited ? ' (user edited)' : ''} tracked=${hunk.tracked} target=[${hunk.targetRange.start}, ${hunk.targetRange.end}] anchor=${hunk.anchorLine} ${hunk.attachSide}`,
				);
				for (const line of hunk.baselineLines) {
					output.appendLine(`  - ${line}`);
				}
			}
			if ((changeSet?.hunks.length ?? 0) === 0) {
				output.appendLine('no active change set');
			}
			output.show(true);
		}),
		vscode.commands.registerCommand('agentReview.getState', () =>
			JSON.stringify({
				file: fixtureUri.fsPath,
				renderMode: renderMode(),
				hunks: (changeSet?.hunks ?? []).map((hunk) => ({
					id: hunk.id,
					status: hunk.status,
					userEdited: hunk.userEdited,
					tracked: hunk.tracked,
					targetRange: hunk.targetRange,
					anchorLine: hunk.anchorLine,
					attachSide: hunk.attachSide,
					baselineLines: hunk.baselineLines,
				})),
			}),
		),
		vscode.commands.registerCommand('agentReview.validateFixture', () => {
			try {
				const fixture = loadFixture(fixtureDir.fsPath);
				output.appendLine(`[validateFixture] ok: ${fixture.hunks.length} hunks`);
				return 'ok';
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				output.appendLine(`[validateFixture] error: ${message}`);
				void vscode.window.showErrorMessage(`Agent Review: fixture invalid — ${message}`);
				return `error: ${message}`;
			}
		}),
		vscode.languages.registerCodeLensProvider({ language: 'typescript' }, codeLenses),
		vscode.workspace.onDidChangeTextDocument(handleChange),
		vscode.window.onDidChangeVisibleTextEditors(() => render()),
		vscode.window.onDidChangeActiveTextEditor(() => render()),
		vscode.workspace.onDidOpenTextDocument((document) => {
			if (isFixture(document) && vscode.workspace.getConfiguration('agentReview').get<boolean>('autoApply', true)) {
				void serialise(applyFakePatch);
			}
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('agentReview.renderMode')) {
				render();
			}
		}),
	);

	const autoApply = vscode.workspace.getConfiguration('agentReview').get<boolean>('autoApply', true);
	if (autoApply && vscode.workspace.textDocuments.some(isFixture)) {
		await serialise(applyFakePatch);
	}
	render();
}

export function deactivate(): void {
	// Disposables are owned by `context.subscriptions`.
}
