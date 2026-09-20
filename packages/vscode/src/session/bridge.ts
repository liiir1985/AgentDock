/**
 * The host side of the Core's entry points (`docs/03-core-design.md` §2/§5): the adapter's events in,
 * the ledger's state out.
 *
 * The turn rule is the whole reason this is a class rather than a switch:
 *  - `turn-start` ends the previous turn **before** opening the new one (M9), because the agent's own
 *    `agent_start` can arrive while the previous turn is still open (a steer or a follow-up continues
 *    the same turn, but a queued message starts a new one);
 *  - `turn-end` deliberately does **not** close the turn (M9). The user's next keystroke is still an
 *    edit to this turn's hunks, and the model has no cross-turn reconcile.
 */

import * as vscode from 'vscode';

import { type AdapterCapabilities, type AdapterEvent, type UsageReport, snapshotPolicy } from '@agentdock/core';

import type { SidecarNotification, UiRequest } from '../sidecar/protocol';
import { ReviewStore } from './store';

export interface BridgeHost {
	log(message: string): void;
	onDelta(text: string): void;
	onMessage(role: 'user' | 'assistant', text: string): void;
	onToolActivity(summary: string): void;
	/** The review surface changed: re-render, re-publish the Changes view, refresh the context key. */
	onChanged(): void;
	/** Send an answer back to a dialog the sidecar is waiting on. */
	answerUi(requestId: string, value: string | boolean | null): void;
}

export class SessionBridge {
	readonly store: ReviewStore;
	/** Phase 4 renders it; Phase 1 only has to keep it truthful. */
	private lastUsage: UsageReport | null = null;

	constructor(
		private readonly host: BridgeHost,
		sessionId: string,
		capabilities: AdapterCapabilities,
	) {
		this.store = new ReviewStore(sessionId, snapshotPolicy(capabilities.write.intercept));
	}

	get usage(): UsageReport | null {
		return this.lastUsage;
	}

	handleNotification(message: SidecarNotification): void {
		switch (message.type) {
			case 'event':
				this.handleEvent(message.event);
				return;
			case 'delta':
				this.host.onDelta(message.text);
				return;
			case 'ui-request':
				void this.answer(message);
				return;
			case 'log':
				this.host.log(`[${message.level}] ${message.message}`);
				return;
			default:
				// `ready` and `response` belong to the client that owns the connection.
				return;
		}
	}

	handleEvent(event: AdapterEvent): void {
		switch (event.type) {
			case 'turn-start':
				this.store.openTurn();
				this.host.onChanged();
				return;
			case 'file-write':
				this.store.record(event.write);
				this.host.onChanged();
				return;
			case 'turn-end':
				this.store.closeTurn();
				this.host.onChanged();
				return;
			case 'message':
				this.host.onMessage(event.role, event.text);
				return;
			case 'tool-activity':
				this.host.onToolActivity(event.summary);
				return;
			case 'usage':
				this.lastUsage = event.report;
				return;
			case 'permission-request':
				// This adapter routes approvals through the UI context instead (D37/D44), so a
				// permission event here means the harness grew a second gate we do not serve yet.
				this.host.log('[warning] harness raised a permission request this build does not bridge');
				return;
		}
	}

	/**
	 * A dialog the harness is waiting on. Cancelling has to send *something* (`null`): an unanswered
	 * request leaves the turn pending with nothing on screen saying why (D44).
	 */
	private async answer(request: UiRequest): Promise<void> {
		let value: string | boolean | null = null;
		try {
			if (request.kind === 'select') {
				const picked = await vscode.window.showQuickPick(request.options ?? [], {
					title: request.title,
					placeHolder: request.message,
					ignoreFocusOut: true,
				});
				value = picked ?? null;
			} else if (request.kind === 'confirm') {
				const answer = await vscode.window.showInformationMessage(
					request.title,
					{ modal: true, detail: request.message },
					'确认',
					'取消',
				);
				value = answer === '确认';
			} else {
				const typed = await vscode.window.showInputBox({
					title: request.title,
					prompt: request.message,
					ignoreFocusOut: true,
				});
				value = typed ?? null;
			}
		} catch (error) {
			this.host.log(`[error] dialog failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.host.answerUi(request.requestId, value);
	}
}
