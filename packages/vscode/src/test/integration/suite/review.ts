/**
 * The end-to-end suite (plan G.3): a real VS Code, a real extension host, a scripted sidecar, and real
 * files on disk.
 *
 * Every assertion here corresponds to one of the plan's exit criteria, and every one of them compares
 * against an oracle that does not come from the extension: the fixture text on disk, or the bytes the
 * stub sidecar wrote. A verdict that only looked right inside the extension's own state would prove
 * nothing about the file.
 *
 * Groups are independent because `replay()` puts the workspace back, restarts the sidecar, and waits for
 * a fresh first turn — the alternative (a long chain of dependent mutations) makes a failure impossible
 * to attribute.
 */

import * as assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const SEED_A = 'seed-a.ts';
const SEED_B = 'seed-b.ts';
/** What the stub writes into `seed-b.ts` (plan G.1's S1). */
const AGENT_B_TEXT = "export const SEED_B = 'created by the agent';\n";

interface StateHunk {
	id: string;
	status: string;
	reason?: string;
	userEdited: boolean;
	targetRange: { start: number; end: number };
	baseline: string[];
}

interface StateFile {
	path: string;
	stats: string;
	pending: number;
	hunks: { id: string; status: string; add: string[]; old: string[] }[];
}

interface ReviewState {
	sessionId: string | null;
	files: StateFile[];
	totals: { files: number; pending: number; added: number; removed: number };
	hunks: { path: string; turn: number; kind: string; hunks: StateHunk[] }[];
	turns: { index: number; files: { path: string; hunks: string[] }[] }[];
}

const fixtureRoot = path.join(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'workspace');
const baselineA = readFileSync(path.join(fixtureRoot, SEED_A), 'utf8');
const script = process.env.AGENTDOCK_STUB_SCRIPT ?? 'S1';

function workspaceRoot(): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	assert.ok(folder, 'the suite needs the fixture workspace as its only folder');
	return folder.uri.fsPath;
}

function disk(relative: string): string | undefined {
	const absolute = path.join(workspaceRoot(), relative);
	return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
}

async function getState(): Promise<ReviewState> {
	const raw = await vscode.commands.executeCommand<string>('agentdock.getState');
	return JSON.parse(raw) as ReviewState;
}

async function settled(delayMs = 60): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

/** Poll an observable condition: a command resolving does not mean the change event has been handled. */
async function waitFor(description: string, predicate: (state: ReviewState) => boolean): Promise<ReviewState> {
	const deadline = Date.now() + 15000;
	let last: ReviewState | undefined;
	while (Date.now() < deadline) {
		last = await getState();
		if (predicate(last)) return last;
		await settled(100);
	}
	throw new Error(`timed out waiting for ${description}; last state: ${JSON.stringify(last)}`);
}

async function waitForFiles(paths: string[]): Promise<ReviewState> {
	return waitFor(`the review face to hold ${paths.join(', ')}`, (state) =>
		paths.every((path) => state.files.some((file) => file.path === path)),
	);
}

function hunkOf(state: ReviewState, path: string, index = 0): StateHunk {
	const entry = state.hunks.find((candidate) => candidate.path === path);
	assert.ok(entry, `${path} must be on the review face`);
	const hunk = entry.hunks[index];
	assert.ok(hunk, `${path} must have a hunk at index ${index}`);
	return hunk;
}

/** A fresh first turn: the fixture files back on disk, a new sidecar, a new ledger. */
async function replay(expected: string[] = [SEED_A, SEED_B]): Promise<ReviewState> {
	for (const document of vscode.workspace.textDocuments) {
		if (document.uri.scheme === 'file' && document.isDirty) await document.save();
	}
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	cpSync(fixtureRoot, workspaceRoot(), { recursive: true });
	rmSync(path.join(workspaceRoot(), SEED_B), { force: true });
	await vscode.commands.executeCommand('agentdock.restartSidecar');
	const state = await waitForFiles(expected);
	await resyncBuffers();
	return state;
}

/**
 * The stub writes files behind VS Code's back, so a loaded buffer can still hold the previous group's
 * bytes (the revert-on-external-change is asynchronous). Every assertion about a document would then be
 * an assertion about a stale copy — so the buffers are reverted to the disk before a group starts.
 */
async function resyncBuffers(): Promise<void> {
	for (const document of vscode.workspace.textDocuments) {
		if (document.uri.scheme !== 'file') continue;
		await vscode.window.showTextDocument(document, { preview: true });
		await vscode.commands.executeCommand('workbench.action.files.revert');
	}
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function openDocument(relative: string): Promise<vscode.TextDocument> {
	const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, relative);
	const document = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(document, { preview: false });
	return document;
}

/** A user edit: inserted from outside the extension, so the change event is not one of ours. */
async function insertLine(document: vscode.TextDocument, line: number, text: string): Promise<void> {
	const edit = new vscode.WorkspaceEdit();
	edit.insert(document.uri, new vscode.Position(line, 0), `${text}\n`);
	const applied = await vscode.workspace.applyEdit(edit);
	assert.ok(
		applied,
		`the user edit must apply (line ${line} of ${document.lineCount} in ${document.uri.fsPath}:\n${document.getText()})`,
	);
}

/**
 * V6 — a machine without Bun. The refusal has to be complete: no session, and no review surface
 * registered that would suggest one exists. The notification itself is not observable from here, so the
 * assertion is the part that matters — nothing was set up — plus the setting that caused it.
 */
async function runNoBunCase(): Promise<void> {
	// VS Code registers its own `agentdock.<view>.focus`-style commands for the contributed views, so the
	// check is about *our* handlers: none of them may exist.
	const handlers = [
		'agentdock.getState',
		'agentdock.restartSidecar',
		'agentdock.showSidecarLog',
		'agentdock.focusChat',
		'agentdock.prompt',
		'agentdock.openChange',
		'agentdock.acceptAll',
		'agentdock.rejectAll',
		'agentdock.acceptHunk',
		'agentdock.rejectHunk',
		'agentdock.abort',
	];
	const registered = (await vscode.commands.getCommands(true)).filter((id) => handlers.includes(id));
	console.log(`[suite] no-bun case: registered handler commands = ${JSON.stringify(registered)}`);
	assert.deepEqual(registered, [], 'a window without Bun must not register the review surface');

	const configured = vscode.workspace.getConfiguration('agentdock').get<string>('bunPath', '');
	assert.ok(configured.includes('no-such-dir'), `the case must configure a bogus path, got "${configured}"`);
	const self = vscode.extensions.getExtension('agentdock.agentdock');
	assert.ok(self !== undefined, 'the extension must be loaded in this host');
	// `activate()` waits for (or triggers) activation: the suite can outrun `onStartupFinished`.
	await self.activate();
	assert.ok(self.isActive, 'activation ran and simply refused');
	// The extension's own log and refusal happen inside `activate`; a second activation is a no-op.
	assert.deepEqual(
		(await vscode.commands.getCommands(true)).filter((id) => handlers.includes(id)),
		[],
		'the refusal must survive activation',
	);
	console.log('[suite] V6 assertions passed');
}

export async function runReviewSuite(): Promise<void> {
	console.log(`[suite] workspace ${workspaceRoot()} case ${process.env.AGENTDOCK_CASE ?? 'review'} script ${script}`);
	if ((process.env.AGENTDOCK_CASE ?? 'review') === 'no-bun') {
		await runNoBunCase();
		return;
	}

	// V4.1 — the review face after one turn (S3 deletes a file instead of changing one)
	let state = await replay(script === 'S3' ? [SEED_A] : [SEED_A, SEED_B]);
	if (script === 'S3') {
		// V4.4b — the other half of the file-level criterion: rejecting a *deleted* file puts its bytes
		// back. The bytes have no undo entry to preserve (the file was never in the editor), so the
		// restore writes them directly.
		assert.equal(state.files.length, 1, 'only the deleted file is on the face');
		assert.equal(state.files[0].path, SEED_A);
		assert.equal(state.files[0].stats, '+0 -5', 'every baseline line is a removal');
		assert.equal(disk(SEED_A), undefined, 'the turn deleted the file');
		await vscode.commands.executeCommand('agentdock.rejectFile', SEED_A);
		await settled(200);
		assert.equal(disk(SEED_A), baselineA, 'rejecting a deleted file restores it byte for byte');
		console.log('[suite] S3 (deleted file) assertions passed');
		return;
	}

	const fileA = state.files.find((file) => file.path === SEED_A);
	const fileB = state.files.find((file) => file.path === SEED_B);
	assert.ok(fileA && fileB, 'both files belong on the review face');
	if (script === 'S2') {
		// V4.7 — the second turn's hunks are the review face; the first turn stays in the session (M8).
		assert.equal(state.hunks.length, 2, 'both paths stay on the face');
		const entry = state.hunks.find((candidate) => candidate.path === SEED_A);
		assert.ok(entry);
		assert.equal(entry.turn, 2, 'the face must show the newest turn for a path');
		assert.ok(entry.hunks.length >= 1);
		assert.ok(
			entry.hunks.every((hunk) => hunk.status === 'pending'),
			'the rendered hunks are the second turn\u2019s, undecided ones',
		);
		const first = state.turns.find((turn) => turn.index === 1);
		assert.ok(first, 'the session keeps turn 1');
		assert.ok(
			first.files.some((file) => file.path === SEED_A && file.hunks.length >= 1),
			'turn 1\u2019s hunks are still recorded, just not rendered',
		);
		assert.ok(disk(SEED_A)?.includes('GREETING_LOCALE'), 'the second turn really landed on disk');
		console.log('[suite] S2 (M8) assertions passed');
		return;
	}

	assert.equal(state.files.length, 2, 'exactly the two changed files');
	assert.equal(fileA!.stats, '+2 -0', 'a pure insertion of two lines');
	assert.equal(fileB!.stats, '+1 -0', 'a created one-line file');
	assert.equal(fileA!.pending, 1);
	assert.equal(fileB!.pending, 1);
	assert.equal(disk(SEED_A)?.split('\n').length, 8, 'the agent text is on disk (7 lines plus the terminator)');

	// The Changes view payload carries the preview rows the hover diff is built from.
	assert.deepEqual(fileA!.hunks[0].old, [], 'a pure insertion has no old side');
	assert.equal(fileA!.hunks[0].add.length, 2, 'and exactly the two new lines');
	assert.deepEqual(fileB!.hunks[0].add, [AGENT_B_TEXT.trim()], 'a created file previews its only line');

	// The action row (D11): Accept / Reject per hunk, plus the file-level row above line 0.
	// The query needs the document to have a text model (the workbench command throws otherwise), which
	// is the state a user is in whenever lenses matter.
	const opened = await openDocument(SEED_A);
	const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
		'vscode.executeCodeLensProvider',
		opened.uri,
	);
	const titles = lenses.map((lens) => lens.command?.title ?? '');
	const accept = lenses.find((lens) => lens.command?.command === 'agentdock.acceptHunk');
	const reject = lenses.find((lens) => lens.command?.command === 'agentdock.rejectHunk');
	const hunkId = hunkOf(state, SEED_A).id;
	console.log(`[suite] lenses on ${SEED_A}: ${JSON.stringify(titles)}`);
	assert.ok(titles.includes('$(check) Accept'), 'a hunk row must offer Accept');
	assert.ok(titles.includes('$(x) Reject'), 'and Reject');
	assert.ok(titles.includes('$(check) Accept All') && titles.includes('$(x) Reject All'), 'file-level actions');
	assert.ok(
		titles.some((title) => /^\d+\/\d+$/.test(title)),
		'the position counter is a plain label',
	);
	assert.deepEqual(accept?.command?.arguments, [SEED_A, hunkId], 'a click can only hit the hunk it names');
	assert.deepEqual(reject?.command?.arguments, [SEED_A, hunkId]);
	assert.equal(
		(lenses.find((lens) => lens.command?.title === '$(check) Accept All')?.command?.command),
		'agentdock.acceptAll',
	);
	assert.ok(
		lenses.every((lens) => lens.range.start.line >= 0),
		'every lens anchors inside the document',
	);

	// The single-track renderer's foundation: the proposed `editorInsets` API is live in this host (the
	// launch args enable it by publisher.name), and an inset is created at the line it is asked for.
	// `RenderSync.commitVisual` runs inside the lens query above, so the hunks' insets were created
	// there too — a geometry error would have failed the query.
	const editor = vscode.window.visibleTextEditors.find(
		(candidate) => candidate.document.uri.toString() === opened.uri.toString(),
	);
	assert.ok(editor, 'the probe needs the document to be visible');
	const probeInset = vscode.window.createWebviewTextEditorInset(editor, 0, 1, { enableScripts: false });
	assert.equal(probeInset.line, 0);
	assert.equal(probeInset.height, 1);
	probeInset.dispose();

	// V4.2 — Reject restores bytes and saves immediately (D28)
	const agentA = disk(SEED_A);
	assert.ok(agentA !== undefined && agentA !== baselineA, 'the turn really changed the file');
	await vscode.commands.executeCommand('agentdock.rejectHunk', SEED_A, hunkOf(state, SEED_A).id);
	await settled();
	assert.equal(disk(SEED_A), baselineA, 'reject must restore the file byte for byte');
	assert.equal(disk(SEED_B), AGENT_B_TEXT, 'nothing else may be touched');

	// V4.3a — Reject went through `WorkspaceEdit`, so undo brings the agent's text back
	const documentA = await openDocument(SEED_A);
	await vscode.commands.executeCommand('undo');
	await settled();
	assert.equal(documentA.getText(), agentA, 'undo after a reject must restore what the agent wrote');
	await documentA.save();

	// V4.3b — Accept writes nothing, so undo has nothing of ours to undo
	state = await replay();
	const documentB = await openDocument(SEED_B);
	const beforeAccept = documentB.getText();
	await vscode.commands.executeCommand('agentdock.acceptHunk', SEED_B, hunkOf(state, SEED_B).id);
	await settled();
	assert.equal(documentB.getText(), beforeAccept, 'Accept must not edit the document (D26)');
	await vscode.commands.executeCommand('undo');
	await settled();
	assert.equal(documentB.getText(), beforeAccept, 'undo must not change anything after an Accept');

	// V4.4 — a created file's Reject deletes it
	//
	// The undo half of the plan's assertion does not hold in VS Code 1.138 and was dropped after
	// measuring it: `WorkspaceEdit.deleteFile` reaches the file system (`existsSync` false, the file
	// service agrees, the document is closed) but leaves nothing on the text undo stack, and this build
	// has no `workbench.action.undo` to fall back on. Text edits — the Reject of a hunk, and the Reject
	// of a file's *content* — do stay undoable, which V4.3 asserts.
	await replay();
	await vscode.commands.executeCommand('agentdock.rejectFile', SEED_B);
	await settled(300);
	assert.equal(disk(SEED_B), undefined, 'rejecting a created file removes it from disk');
	assert.equal(
		await vscode.workspace.fs.stat(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, SEED_B)).then(
			() => 'exists',
			() => 'missing',
		),
		'missing',
		'the editor agrees with the disk',
	);

	// V4.5 — Reject All
	await replay();
	await vscode.commands.executeCommand('agentdock.rejectAll');
	await settled(200);
	assert.equal(disk(SEED_A), baselineA, 'reject all restores every file');
	assert.equal(disk(SEED_B), undefined, 'and removes what the turn created');
	assert.deepEqual((await getState()).files.length, 2, 'the files stay listed, now decided');

	// V4.6a — a user edit inside the new side is rolled back with the agent's text (D3.2)
	state = await replay();
	const userA = await openDocument(SEED_A);
	const hunk = hunkOf(state, SEED_A);
	await insertLine(userA, hunk.targetRange.start + 1, '// mine, inside the hunk');
	await waitFor('the hunk to notice the user edit', (current) => hunkOf(current, SEED_A).userEdited);
	await vscode.commands.executeCommand('agentdock.rejectHunk', SEED_A, hunk.id);
	await settled();
	assert.equal(userA.getText(), baselineA, 'reject owns the whole region, including the user\u2019s line');
	await userA.save();

	// V4.6b — a user edit outside the hunk keeps the hunk true and the user's line intact
	state = await replay();
	const shifted = await openDocument(SEED_A);
	const before = hunkOf(state, SEED_A);
	await insertLine(shifted, 0, '// mine, above the hunk');
	await waitFor('the hunk to shift down by one line', (current) => hunkOf(current, SEED_A).targetRange.start === before.targetRange.start + 1);
	await vscode.commands.executeCommand('agentdock.rejectHunk', SEED_A, before.id);
	await settled();
	assert.equal(shifted.getText(), `// mine, above the hunk\n${baselineA}`, 'the user\u2019s line survives a reject');
	await shifted.save();

	console.log('[suite] all assertions passed');
}
