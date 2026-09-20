/**
 * The Changes side panel (D24). It is a webview rather than a tree because a hover diff popup is
 * impossible in a tree item, and a webview is the only container that can carry both the per-file
 * verdict buttons and the turn-level pair at the bottom.
 *
 * The provider holds no review state: the host (the store) is the single source of truth, and every
 * message either asks the host for the current payload or hands it a verdict. A view resolved long
 * after the session started still gets the current state, because the payload is pushed on the
 * page's `ready` handshake and not only from `refresh()`.
 */

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ChangesInbound, ChangesOutbound, ChangesPayload } from '../model/webviewMessages';
import { changesHtml } from '../model/webviewMessages';

export interface ChangesHost {
	payload(): ChangesPayload;
	openChange(path: string, hunkId?: string): Promise<void>;
	acceptFile(path: string): Promise<void>;
	rejectFile(path: string): Promise<void>;
	acceptAll(): Promise<void>;
	rejectAll(): Promise<void>;
}

/** A dropped verdict is invisible inside the webview, so it has to surface as a notification. */
function report(error: unknown): void {
	void vscode.window.showErrorMessage(`AgentDock: ${error instanceof Error ? error.message : String(error)}`);
}

export class ChangesViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	/** Set by the page's first message; before that a push would race the initial paint. */
	private ready = false;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly host: ChangesHost,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		this.ready = false;
		view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		view.webview.html = changesHtml(this.host.payload(), randomUUID(), view.webview.cspSource);
		view.webview.onDidReceiveMessage((message: ChangesInbound) => this.receive(message));
		view.onDidDispose(() => {
			if (this.view !== view) return;
			this.view = undefined;
			this.ready = false;
		});
	}

	/** Push the current review state; a view that has never been opened stays silent until it asks. */
	refresh(): void {
		this.push();
	}

	private push(): void {
		if (this.view === undefined || !this.ready) return;
		const update: ChangesOutbound = { type: 'update', payload: this.host.payload() };
		void this.view.webview.postMessage(update);
	}

	private receive(message: ChangesInbound): void {
		switch (message.type) {
			case 'ready':
				this.ready = true;
				this.push();
				return;
			case 'open':
				this.guard(this.host.openChange(message.path, message.hunkId));
				return;
			case 'acceptFile':
				this.guard(this.host.acceptFile(message.path));
				return;
			case 'rejectFile':
				this.guard(this.host.rejectFile(message.path));
				return;
			case 'acceptAll':
				this.guard(this.host.acceptAll());
				return;
			case 'rejectAll':
				this.guard(this.host.rejectAll());
				return;
		}
	}

	private guard(action: Promise<void>): void {
		void action.catch(report);
	}
}
