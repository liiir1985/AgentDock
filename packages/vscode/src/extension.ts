/**
 * Extension wiring: the window's half of the review loop.
 *
 * Everything that touches the `vscode` API for the review lifecycle lives here or in the modules it
 * owns. The order of `activate` is deliberate:
 *
 *  1. **find Bun** (D36). Failure is a clear notification and nothing else: no sidecar, no session, no
 *     half-registered review surface (the exit criterion for "pull Bun out"). The sidecar itself is
 *     started lazily on the first prompt (M4), so a window that never prompts pays nothing;
 *  2. register the surfaces (render, views, commands) — they all work against a possibly absent
 *     session and simply have nothing to show until one exists;
 *  3. create the session on the first prompt, or on an explicit restart.
 *
 * `agentdock.getState` is not part of the user-facing surface: it is the seam the integration suite
 * reads (and the one a bug report can paste), so it reports exactly what the Changes view is given.
 */

import * as vscode from 'vscode';

import type { Hunk } from '@agentdock/core';

import type { ChangesPayload } from './model/webviewMessages';
import { HunkCodeLensProvider } from './render/actions';
import { DecorationRenderer } from './render/decorations';
import { InsetsRenderer } from './render/insets';
import { RenderSync } from './render/sync';
import { BunNotFoundError, locateBun } from './sidecar/bunPath';
import { SidecarClient } from './sidecar/client';
import {
	type RequestByMethod,
	type RequestMethod,
	type SessionInfo,
	type SidecarNotification,
} from './sidecar/protocol';
import { SessionBridge } from './session/bridge';
import type { ReviewStore } from './session/store';
import { registerDocumentSync, relativePath } from './store/documentSync';
import { SelfEditRegistry } from './store/selfEdits';
import { Verdicts } from './verdict/apply';
import { ChangesViewProvider } from './views/changesView';
import { ChatViewProvider } from './views/chatView';

const CHANGES_VIEW = 'agentdock.changes';
const CHAT_VIEW = 'agentdock.chat';
const PENDING_CONTEXT = 'agentdock.hasPendingHunks';
/** What the Changes view shows before a session exists. Fresh each call: a shared object is a trap. */
function emptyPayload(): ChangesPayload {
	return { files: [], totals: { files: 0, pending: 0, added: 0, removed: 0 } };
}

let output: vscode.OutputChannel;
let client: SidecarClient | undefined;
let bridge: SessionBridge | undefined;
let verdicts: Verdicts | undefined;
let changesView: ChangesViewProvider | undefined;
let chatView: ChatViewProvider | undefined;
let renderer: RenderSync | undefined;
/** One registry: the verdict path's expectations and the document sync's absorption must be the same list. */
const selfEdits = new SelfEditRegistry();

function store(): ReviewStore | undefined {
	return bridge?.store;
}

function log(message: string): void {
	output.appendLine(message);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	output = vscode.window.createOutputChannel('AgentDock Sidecar');
	context.subscriptions.push(output);

	let bunCommand: string;
	try {
		const bun = locateBun();
		bunCommand = bun.command;
		log(`[start] bun: ${bun.command} (${bun.source}${bun.version === undefined ? '' : `, ${bun.version}`})`);
	} catch (error) {
		const message = error instanceof BunNotFoundError ? error.message : String(error);
		// Nothing else is registered: a window without Bun must not look like a working review surface.
		void vscode.window.showErrorMessage(message);
		log(`[fatal] ${message}`);
		return;
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder === undefined) {
		void vscode.window.showWarningMessage('AgentDock 需要一个打开的文件夹作为 workspace root。');
		return;
	}
	const workspaceRoot = folder.uri.fsPath;

	const insets = new InsetsRenderer();
	const decorations = new DecorationRenderer();
	const codeLenses = new HunkCodeLensProvider({
		hunksFor: (document) => hunksOf(document.uri),
		onQuery: () => sync.commitVisual(),
	});
	const sync = new RenderSync({
		insets,
		decorations,
		codeLenses,
		hunksFor: (editor) => hunksOf(editor.document.uri),
	});
	renderer = sync;

	changesView = new ChangesViewProvider(context.extensionUri, {
		payload: () => store()?.changesPayload() ?? emptyPayload(),
		openChange: (path, hunkId) => openChange(path, hunkId),
		acceptFile: async (path) => verdicts?.acceptFile(path),
		rejectFile: async (path) => verdicts?.rejectFile(path),
		acceptAll: async () => verdicts?.acceptAll(),
		rejectAll: async () => verdicts?.rejectAll(),
	});
	chatView = new ChatViewProvider(context.extensionUri, {
		submitPrompt: async (text) => {
			await ensureSession();
			await request('prompt', { text });
		},
		abort: async () => {
			if (client?.running === true) await request('abort', {});
		},
	});

	client = new SidecarClient({
		bunCommand,
		entry: sidecarEntry(context),
		workspaceRoot,
		onNotification: (message) => handleNotification(message),
		onStderr: (chunk) => output.append(chunk),
		onExit: (code, expected) => {
			bridge = undefined;
			verdicts = undefined;
			refreshSurfaces();
			log(`[sidecar] exited (${code ?? 'null'})`);
			if (!expected) {
				void vscode.window.showErrorMessage(
					`AgentDock sidecar 已退出（code ${code ?? 'null'}），详见输出面板`,
				);
			}
		},
		onFatal: (message) => {
			log(`[fatal] ${message}`);
			void vscode.window.showErrorMessage(`AgentDock: ${message}`);
		},
	});

	context.subscriptions.push(
		insets,
		decorations,
		codeLenses,
		sync,
		vscode.window.registerWebviewViewProvider(CHANGES_VIEW, changesView),
		vscode.window.registerWebviewViewProvider(CHAT_VIEW, chatView),
		vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLenses),
		vscode.window.onDidChangeVisibleTextEditors(() => sync.render()),
		vscode.window.onDidChangeActiveTextEditor(() => sync.render()),
		registerDocumentSync({ store, selfEdits, onChanged: () => refreshSurfaces(), log }),
		registerCommands(),
	);

	await vscode.commands.executeCommand('setContext', PENDING_CONTEXT, false);
	log(`[start] workspace root: ${workspaceRoot}`);
}

export function deactivate(): void {
	void client?.dispose();
	client = undefined;
}

/** Every review surface follows the same signal: the model changed. */
function refreshSurfaces(): void {
	void vscode.commands.executeCommand('setContext', PENDING_CONTEXT, store()?.hasPendingHunks() ?? false);
	changesView?.refresh();
	renderer?.refreshSynced();
}

function hunksOf(uri: vscode.Uri): Hunk[] {
	const path = relativePath(uri);
	return path === undefined ? [] : (store()?.hunksOf(path) ?? []);
}

/** `AGENTDOCK_SIDECAR_ENTRY` overrides the entry (the integration suite points it at a stub). */
function sidecarEntry(context: vscode.ExtensionContext): string {
	const override = process.env.AGENTDOCK_SIDECAR_ENTRY;
	if (override !== undefined && override.length > 0) return override;
	// Development runs Bun straight on the TypeScript source; the sidecar has no build step.
	return vscode.Uri.joinPath(context.extensionUri, '..', 'sidecar', 'src', 'main.ts').fsPath;
}

function handleNotification(message: SidecarNotification): void {
	if (message.type === 'ready') {
		attachSession(message);
		return;
	}
	if (message.type === 'response') return; // the client resolves the matching request
	bridge?.handleNotification(message);
}

/** A session exists: the ledger is created from the capabilities the adapter declares (M2). */
function attachSession(info: SessionInfo): void {
	bridge = new SessionBridge(
		{
			log,
			onDelta: (text) => chatView?.post({ type: 'delta', text }),
			onMessage: (role, text) => chatView?.post({ type: 'message', kind: role, text }),
			onToolActivity: (summary) => chatView?.post({ type: 'message', kind: 'tool', text: summary }),
			onChanged: () => refreshSurfaces(),
			answerUi: (requestId, value) => {
				void request('uiResponse', { requestId, value });
			},
		},
		info.sessionId,
		info.capabilities,
	);
	verdicts = new Verdicts({ store: bridge.store, selfEdits, log, onChanged: () => refreshSurfaces() });
	log(
		`[session] ${info.sessionId} sdk ${info.sdkVersion} bun ${info.bunVersion} intercept ${info.capabilities.write.intercept}`,
	);
	refreshSurfaces();
}

async function ensureSession(): Promise<void> {
	if (client === undefined) throw new Error('sidecar client is not initialised');
	if (!client.running) client.start();
	await request('start', { workspaceRoot: workspaceRootPath() });
	if (bridge === undefined) {
		throw new Error('sidecar did not report a session (see the AgentDock Sidecar output)');
	}
}

function workspaceRootPath(): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder === undefined) throw new Error('AgentDock 需要一个打开的文件夹');
	return folder.uri.fsPath;
}

async function request<M extends RequestMethod>(
	method: M,
	params: RequestByMethod[M]['params'],
): Promise<RequestByMethod[M]['result']> {
	if (client === undefined) throw new Error('sidecar client is not initialised');
	try {
		return await client.request(method, params);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(`[error] ${method}: ${message}`);
		void vscode.window.showErrorMessage(`AgentDock: ${message}`);
		throw error;
	}
}

async function openChange(path: string, hunkId?: string): Promise<void> {
	const uri = await documentUri(path);
	if (uri === undefined) return;
	const document = await vscode.workspace.openTextDocument(uri);
	const editor = await vscode.window.showTextDocument(document, { preview: false });
	const hunk = hunkId === undefined ? undefined : store()?.hunkOf(path, hunkId);
	if (hunk === undefined) {
		editor.revealRange(new vscode.Range(0, 0, 0, 0));
		return;
	}
	reveal(editor, clampLine(hunk, document));
}

async function navigateHunk(direction: 1 | -1): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (editor === undefined) return;
	const path = relativePath(editor.document.uri);
	if (path === undefined) return;
	const hunks = store()?.hunksOf(path) ?? [];
	if (hunks.length === 0) return;
	const lines = hunks.map((hunk) => clampLine(hunk, editor.document)).sort((left, right) => left - right);
	const current = editor.selection.active.line;
	const target =
		direction === 1
			? (lines.find((line) => line > current) ?? lines[0])
			: ([...lines].reverse().find((line) => line < current) ?? lines[lines.length - 1]);
	reveal(editor, target);
}

function reveal(editor: vscode.TextEditor, line: number): void {
	const position = new vscode.Position(line, 0);
	editor.selection = new vscode.Selection(position, position);
	editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

/** The CodeLens anchor rule (`actions.ts`): one line past the hunk's own content, clamped. */
function clampLine(hunk: Hunk, document: vscode.TextDocument): number {
	const { start, end } = hunk.targetRange;
	const line = end >= start ? end + 1 : Math.max(0, hunk.anchor.line) + 1;
	return Math.max(0, Math.min(line, document.lineCount - 1));
}

async function documentUri(path: string): Promise<vscode.Uri | undefined> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder === undefined) return undefined;
	return vscode.Uri.joinPath(folder.uri, ...path.split('/'));
}

function registerCommands(): vscode.Disposable {
	return vscode.Disposable.from(
		vscode.commands.registerCommand('agentdock.focusChat', () =>
			vscode.commands.executeCommand(`${CHAT_VIEW}.focus`),
		),
		vscode.commands.registerCommand('agentdock.abort', async () => {
			if (client?.running === true) await request('abort', {});
		}),
		vscode.commands.registerCommand('agentdock.showSidecarLog', () => output.show()),
		vscode.commands.registerCommand('agentdock.restartSidecar', async () => {
			// Eager start, exposed so a dead sidecar can be revived without typing a prompt (and so the
			// integration suite can drive the protocol without a model in the loop).
			await client?.dispose();
			bridge = undefined;
			verdicts = undefined;
			client?.start();
			await request('start', { workspaceRoot: workspaceRootPath() });
		}),
		vscode.commands.registerCommand('agentdock.prompt', async (text: string) => {
			await ensureSession();
			await request('prompt', { text });
		}),
		vscode.commands.registerCommand('agentdock.prevHunk', async () => navigateHunk(-1)),
		vscode.commands.registerCommand('agentdock.prevHunkIcon', async () => navigateHunk(-1)),
		vscode.commands.registerCommand('agentdock.nextHunk', async () => navigateHunk(1)),
		vscode.commands.registerCommand('agentdock.nextHunkIcon', async () => navigateHunk(1)),
		vscode.commands.registerCommand('agentdock.openChange', async (path: string, hunkId?: string) =>
			openChange(path, hunkId),
		),
		vscode.commands.registerCommand('agentdock.acceptHunk', (path: string, hunkId: string) =>
			verdicts?.acceptHunk(path, hunkId),
		),
		vscode.commands.registerCommand('agentdock.rejectHunk', async (path: string, hunkId: string) => {
			await verdicts?.rejectHunk(path, hunkId);
		}),
		vscode.commands.registerCommand('agentdock.acceptFile', (path: string) => verdicts?.acceptFile(path)),
		vscode.commands.registerCommand('agentdock.rejectFile', async (path: string) => {
			await verdicts?.rejectFile(path);
		}),
		vscode.commands.registerCommand('agentdock.acceptAll', () => verdicts?.acceptAll()),
		vscode.commands.registerCommand('agentdock.rejectAll', async () => {
			await verdicts?.rejectAll();
		}),
		vscode.commands.registerCommand('agentdock.getState', () => JSON.stringify(stateReport())),
	);
}

/**
 * What the review surface currently believes: the Changes view's payload plus each hunk's geometry, so
 * an integration test can address a hunk without guessing where it is.
 */
function stateReport(): unknown {
	const review = store();
	const payload = review?.changesPayload() ?? emptyPayload();
	return {
		sessionId: client?.sessionInfo?.sessionId ?? null,
		files: payload.files,
		totals: payload.totals,
		hunks: (review?.reviewEntries() ?? []).map((entry) => ({
			path: entry.path,
			turn: entry.turn,
			kind: entry.file.kind,
			hunks: entry.file.hunks.map((hunk) => ({
				id: hunk.id,
				status: hunk.status,
				reason: hunk.rejectReason,
				userEdited: hunk.userEdited,
				targetRange: hunk.targetRange,
				baselineRange: hunk.baselineRange,
				baseline: hunk.baseline.lines,
			})),
		})),
		/** The session's own record, turns included: the review face is a projection of it (M8). */
		turns: (review?.session().turns ?? []).map((turn) => ({
			index: turn.index,
			files: (turn.changeSet?.files ?? []).map((file) => ({
				path: file.path,
				hunks: file.hunks.map((hunk) => `${hunk.id}:${hunk.status}`),
			})),
		})),
		usage: bridge?.usage ?? null,
	};
}
