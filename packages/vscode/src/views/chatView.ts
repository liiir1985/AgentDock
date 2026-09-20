/**
 * The chat side panel (M10): message stream plus prompt input. The panel is the only place a user
 * can start a turn, so the provider must keep working when it has never been opened — hence the
 * buffer: the sidecar streams assistant text into a view that may not exist yet, and those items
 * are replayed in order once the page signals `ready`.
 *
 * The buffer is bounded because a long-running session appends without limit; losing the oldest
 * transcript lines is better than growing without bound, and the authoritative history lives in the
 * session, not here.
 */

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ChatInbound, ChatOutbound } from '../model/webviewMessages';
import { chatHtml } from '../model/webviewMessages';

export interface ChatHost {
	submitPrompt(text: string): Promise<void>;
	abort(): Promise<void>;
}

const MAX_BUFFERED = 500;

function report(error: unknown): void {
	void vscode.window.showErrorMessage(`AgentDock: ${error instanceof Error ? error.message : String(error)}`);
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	/** Set by the page's first message; until then every item is buffered instead of posted. */
	private ready = false;
	private readonly buffered: ChatOutbound[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly host: ChatHost,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		this.ready = false;
		view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		view.webview.html = chatHtml(randomUUID(), view.webview.cspSource);
		view.webview.onDidReceiveMessage((message: ChatInbound) => this.receive(message));
		view.onDidDispose(() => {
			if (this.view !== view) return;
			this.view = undefined;
			this.ready = false;
		});
	}

	/** Forward one conversation item to the panel (fire-and-forget; buffered until the view resolves). */
	post(message: ChatOutbound): void {
		const view = this.view;
		if (view === undefined || !this.ready) {
			this.buffered.push(message);
			if (this.buffered.length > MAX_BUFFERED) this.buffered.splice(0, this.buffered.length - MAX_BUFFERED);
			return;
		}
		void view.webview.postMessage(message);
	}

	private receive(message: ChatInbound): void {
		switch (message.type) {
			case 'ready': {
				this.ready = true;
				const view = this.view;
				if (view === undefined) return;
				for (const item of this.buffered.splice(0, this.buffered.length)) void view.webview.postMessage(item);
				return;
			}
			case 'prompt':
				this.guard(this.host.submitPrompt(message.text));
				return;
			case 'abort':
				this.guard(this.host.abort());
				return;
		}
	}

	private guard(action: Promise<void>): void {
		void action.catch(report);
	}
}
