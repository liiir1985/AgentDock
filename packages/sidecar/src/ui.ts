/**
 * The approval bridge (D35/D37/D44).
 *
 * OMP's approval gate reaches the host through the session's `ExtensionUIContext`: when
 * `tools.approvalMode` is `yolo` — the default — nothing ever asks, but the moment a user turns
 * approval on, an unanswered dialog leaves the turn *silently* pending. That is Copilot's
 * `onPermissionRequest` lesson (D44) and the reason this context is registered unconditionally rather
 * than "when we think we need it".
 *
 * Only four methods can be served from a window with no terminal: `select`, `confirm`, `input` and
 * `notify`. The rest of the interface is deliberately absent — the object is handed over as an
 * `ExtensionUIContext` because the SDK's type demands the full surface, but a call into anything
 * else throws, which is louder than a silent no-op.
 *
 * The complete approval experience (a setting, a first-run warning that the default is yolo, and
 * snapshots before destructive operations) is Phase 3.
 */

import type { ExtensionUIContext } from '@oh-my-pi/pi-coding-agent';

import type { LogLevel, UiRequestKind } from './protocol';

export interface UiRequest {
	requestId: string;
	kind: UiRequestKind;
	title: string;
	message?: string;
	options?: string[];
}

/** A pending dialog. `null` is the one answer for "the user dismissed it". */
export type UiAnswer = string | boolean | null;

export class UiBroker {
	private serial = 0;
	private readonly pending = new Map<string, (answer: UiAnswer) => void>();

	/**
	 * @param send the wire: a dialog request goes out as a `ui-request` and the answer comes back as
	 *  `uiResponse`. A no-op here would leave the harness waiting for a dialog nobody ever sees, which
	 *  is precisely the failure D44 describes.
	 * @param log where `notify` goes: it is fire-and-forget, so it belongs in the extension's output.
	 */
	constructor(
		private readonly send: (request: UiRequest) => void,
		private readonly log: (message: string, level: LogLevel) => void,
	) {}

	request(kind: UiRequestKind, title: string, message?: string, options?: string[]): Promise<UiAnswer> {
		const requestId = `ui-${++this.serial}`;
		const { promise, resolve } = Promise.withResolvers<UiAnswer>();
		this.pending.set(requestId, resolve);
		const request: UiRequest = { requestId, kind, title };
		if (message !== undefined) request.message = message;
		if (options !== undefined) request.options = options;
		this.send(request);
		return promise;
	}

	/** Answer from the extension. An unknown id (a reloaded webview, a stale click) is ignored. */
	resolve(requestId: string, answer: UiAnswer): void {
		const settle = this.pending.get(requestId);
		if (settle === undefined) return;
		this.pending.delete(requestId);
		settle(answer);
	}

	/**
	 * Settle every open dialog as "dismissed". An aborted turn must not leave a promise nothing will
	 * ever resolve, and `null` is the honest answer: nobody decided.
	 */
	cancelAll(): void {
		for (const settle of this.pending.values()) settle(null);
		this.pending.clear();
	}

	/**
	 * `notify` is the SDK's fire-and-forget channel: no answer to wait for, so it maps onto the
	 * extension's output channel instead of a dialog.
	 */
	notify(message: string, level: LogLevel = 'info'): void {
		this.log(message, level);
	}
}

interface SelectItem {
	label: string;
	description?: string;
}

export function createForwardingUIContext(broker: UiBroker): ExtensionUIContext {
	const context = {
		select: async (title: string, options: SelectItem[]): Promise<string | undefined> => {
			const answer = await broker.request(
				'select',
				title,
				undefined,
				options.map((option) => option.label),
			);
			return typeof answer === 'string' ? answer : undefined;
		},
		confirm: async (title: string, message: string): Promise<boolean> => {
			return (await broker.request('confirm', title, message)) === true;
		},
		input: async (title: string, placeholder?: string): Promise<string | undefined> => {
			const answer = await broker.request('input', title, placeholder);
			return typeof answer === 'string' ? answer : undefined;
		},
		notify: (message: string, type?: 'info' | 'warning' | 'error'): void => {
			broker.notify(message, type);
		},
	};
	// The SDK asks for the full interactive surface; a window without a terminal can serve four of
	// its methods. Missing members stay missing on purpose: calling one is a programming error and
	// should throw rather than pretend the user answered.
	return context as unknown as ExtensionUIContext;
}
