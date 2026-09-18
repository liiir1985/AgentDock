/**
 * Integration suite, executed inside a real VS Code extension host.
 *
 * It drives the extension through the full review lifecycle and checks the
 * document text after every mutation against an oracle built from the *pure*
 * model (`applyRejectEdit`). The unit tests pin that model against hand-written
 * text, so the two levels together prove the document-level edits are byte-exact.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Hunk, applyRejectEdit } from '../../../model/changeSet';
import { loadFixture, splitLines } from '../../../model/fixture';
import { rejectEdit } from '../../../model/reconcile';

interface StateHunk {
	id: string;
	status: string;
	userEdited: boolean;
	tracked: boolean;
	targetRange: { start: number; end: number };
	anchorLine: number;
	attachSide: string;
	baselineLines: string[];
}

interface PocState {
	file: string;
	renderMode: string;
	hunks: StateHunk[];
}

async function settle(): Promise<void> {
	const done = Promise.withResolvers<void>();
	setTimeout(done.resolve, 50);
	await done.promise;
}

async function getState(): Promise<PocState> {
	const raw = await vscode.commands.executeCommand<string>('agentReview.getState');
	return JSON.parse(raw) as PocState;
}

function stateHunk(state: PocState, id: string): StateHunk {
	const found = state.hunks.find((candidate) => candidate.id === id);
	assert.ok(found, `hunk ${id} missing from state`);
	return found;
}

function fixtureHunk(hunks: Hunk[], id: string): Hunk {
	const found = hunks.find((candidate) => candidate.id === id);
	assert.ok(found, `hunk ${id} missing from fixture`);
	return found;
}

export async function runApplySuite(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	assert.ok(folder, 'the integration suite needs the fixtures folder as its workspace');
	const fixtureDir = folder.uri.fsPath;
	const fixtureUri = vscode.Uri.joinPath(folder.uri, 'sample.ts');
	const baselineText = fs.readFileSync(path.join(fixtureDir, 'sample.ts'), 'utf8');
	const expectedText = fs.readFileSync(path.join(fixtureDir, 'sample.expected.ts'), 'utf8');
	const fixture = loadFixture(fixtureDir);
	const expectedLines = splitLines(expectedText).lines;

	const document = await vscode.workspace.openTextDocument(fixtureUri);
	await vscode.window.showTextDocument(document);

	// 1. apply the fake patch
	await vscode.commands.executeCommand('agentReview.applyFakePatch');
	assert.equal(document.getText(), expectedText, 'applyFakePatch must produce the expected document');
	const applied = document.getText();
	for (const oldSideText of [
		'// Fixture for the AgentDock Editor Review PoC.',
		'// The next block is kept for compatibility with older callers.',
		'// It is scheduled for removal in the next cleanup pass.',
		'\t\t\tcount += 1;',
	]) {
		assert.ok(!applied.includes(oldSideText), `deleted baseline text is still in the document: ${oldSideText}`);
	}

	// 2. hunk state right after applying
	let state = await getState();
	assert.equal(state.renderMode, 'decorations');
	assert.equal(state.hunks.length, 6);
	assert.deepEqual(
		state.hunks.map((hunk) => hunk.status),
		['pending', 'pending', 'pending', 'pending', 'pending', 'pending'],
	);
	assert.deepEqual(
		state.hunks.map((hunk) => hunk.targetRange),
		fixture.targetRanges,
	);
	assert.deepEqual(
		state.hunks.map((hunk) => hunk.baselineLines),
		fixture.hunks.map((hunk) => hunk.baselineLines),
	);

	// 3. reject a pure deletion: old lines come back, the hunks below shift down
	const h2Plan = rejectEdit(fixtureHunk(fixture.hunks, 'h2'));
	assert.ok(h2Plan);
	await vscode.commands.executeCommand('agentReview.rejectHunk', 'h2');
	await settle();
	assert.equal(document.getText(), applyRejectEdit(expectedLines, h2Plan).join('\n') + '\n');
	assert.ok(document.getText().includes('// The next block is kept for compatibility with older callers.'));
	state = await getState();
	assert.equal(stateHunk(state, 'h2').status, 'rejected');
	assert.equal(stateHunk(state, 'h2').tracked, false);
	assert.deepEqual(
		['h1', 'h3', 'h4', 'h5'].map((id) => stateHunk(state, id).targetRange.start),
		[12, 36, 0, 38],
	);

	// 4. a user edit above a hunk must be reconciled, not absorbed
	const h3Start = stateHunk(state, 'h3').targetRange.start;
	const h5Start = stateHunk(state, 'h5').targetRange.start;
	const h4Start = stateHunk(state, 'h4').targetRange.start;
	const userEdit = new vscode.WorkspaceEdit();
	userEdit.insert(fixtureUri, new vscode.Position(h3Start - 1, 0), '// user A\n// user B\n// user C\n');
	assert.ok(await vscode.workspace.applyEdit(userEdit), 'the user edit must apply');
	await settle();
	state = await getState();
	assert.equal(stateHunk(state, 'h3').targetRange.start, h3Start + 3);
	assert.equal(stateHunk(state, 'h5').targetRange.start, h5Start + 3);
	assert.equal(stateHunk(state, 'h4').targetRange.start, h4Start);
	assert.equal(stateHunk(state, 'h1').targetRange.start, 12);
	assert.equal(stateHunk(state, 'h3').userEdited, false);
	assert.equal(stateHunk(state, 'h3').status, 'pending');

	// 5. accept file: the buffer text wins, including the manual insert
	const beforeAccept = document.getText();
	assert.ok(beforeAccept.includes('// user C'));
	await vscode.commands.executeCommand('agentReview.acceptFile');
	await settle();
	assert.equal(document.getText(), beforeAccept);
	state = await getState();
	assert.equal(
		state.hunks.filter((hunk) => hunk.status === 'pending').length,
		0,
	);
	assert.equal(
		state.hunks.filter((hunk) => hunk.status === 'accepted').length,
		5,
	);

	// 6. reset drops the change set and restores the baseline
	await vscode.commands.executeCommand('agentReview.resetFixture');
	await settle();
	assert.equal(document.getText(), baselineText);
	state = await getState();
	assert.equal(state.hunks.length, 0);

	// 7. reject file must restore the baseline byte for byte (top-of-file delete + EOF append included)
	await vscode.commands.executeCommand('agentReview.applyFakePatch');
	await settle();
	assert.equal(document.getText(), expectedText);
	await vscode.commands.executeCommand('agentReview.rejectFile');
	await settle();
	assert.equal(document.getText(), baselineText);

	// 8. the shipped fixture validates
	assert.equal(await vscode.commands.executeCommand<string>('agentReview.validateFixture'), 'ok');

	console.log('apply suite: all assertions passed');
}
