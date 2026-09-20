/**
 * The extension ↔ sidecar wire (M3).
 *
 * This is *our* protocol, not OMP's CLI contract (D36). The window's Node extension host cannot
 * import the SDK — its sources are Bun-only TypeScript — so the boundary is an NDJSON stream over
 * stdio: one JSON object per line, `\n`-terminated.
 *
 * Everything on this wire is plain data on purpose. `ObservedWrite`/`TextLines`/`AdapterCapabilities`
 * cross it unmodified, so both sides speak the Core's vocabulary and neither one invents a second
 * model of a change.
 *
 * Two message families travel in each direction:
 *  - requests (`{ id, method, params }`) and their responses (`{ id, ok, result | error }`);
 *  - unsolicited notifications (events, stream deltas, UI requests, logs).
 *
 * The framing is duplicated in `packages/vscode/src/sidecar/client.ts`: the extension cannot import
 * a `.ts`-only Bun package, and 20 lines of line-splitting do not justify a build step.
 */

import type { AdapterCapabilities, AdapterEvent, UsageReport } from '@agentdock/core';

/**
 * `bun-version` / `sdk-version` are the version gates (D37: refuse to run rather than half-work);
 * `tool-coverage` is the T1 self-check (D42: one unclassified built-in write tool and the review
 * surface lies); `session` is a harness failure; `internal` is everything we did not foresee.
 */
export type SidecarErrorCode = 'bun-version' | 'sdk-version' | 'tool-coverage' | 'session' | 'internal';

export interface SidecarError {
	code: SidecarErrorCode;
	message: string;
}

/** An error the protocol layer can carry verbatim to the extension as a `response`. */
export class SidecarRequestError extends Error {
	constructor(
		readonly code: SidecarErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'SidecarRequestError';
	}
}

/** What a started session looks like on the wire; also the `ready` payload. */
export interface SessionInfo {
	sessionId: string;
	sdkVersion: string;
	bunVersion: string;
	capabilities: AdapterCapabilities;
	/** The T1 set the adapter declares and covers (D42) — the same constant the adapter exports. */
	fileTools: string[];
}

/** Per-method request parameters. `Record<string, never>` is the honest type for "no arguments". */
export interface ParamByMethod {
	start: { workspaceRoot: string };
	prompt: { text: string };
	steer: { text: string };
	followUp: { text: string };
	abort: Record<string, never>;
	usage: Record<string, never>;
	compact: Record<string, never>;
	uiResponse: { requestId: string; value: string | boolean | null };
	setActiveTools: { names: string[] };
	shutdown: Record<string, never>;
}

/** Per-method success results. */
export interface ResultByMethod {
	start: SessionInfo;
	prompt: Record<string, never>;
	steer: { supported: true };
	followUp: { supported: true };
	abort: Record<string, never>;
	usage: UsageReport | null;
	compact: Record<string, never>;
	uiResponse: Record<string, never>;
	setActiveTools: Record<string, never>;
	shutdown: Record<string, never>;
}

export type RequestMethod = keyof ParamByMethod;

export type SidecarRequest = {
	[M in RequestMethod]: { id: number; method: M; params: ParamByMethod[M] };
}[RequestMethod];

export type UiRequestKind = 'select' | 'confirm' | 'input';

export type LogLevel = 'info' | 'warning' | 'error';

export type SidecarMessage =
	/**
	 * The sidecar can serve this session. Sent right after a successful `start` and before any event
	 * or delta of that session; a version gate that fails answers the `start` request with
	 * `error.code` instead, so `ready` never precedes a refusal (D37).
	 */
	| ({ type: 'ready' } & SessionInfo)
	| { type: 'response'; id: number; ok: true; result: unknown }
	| { type: 'response'; id: number; ok: false; error: SidecarError }
	/** Verbatim Core `AdapterEvent` (D15: the conversation copy is read-only, the ledger is ours). */
	| { type: 'event'; event: AdapterEvent }
	/** Assistant streaming text. Not a Core concept: the panel needs the deltas, the model does not. */
	| { type: 'delta'; text: string }
	| {
			type: 'ui-request';
			requestId: string;
			kind: UiRequestKind;
			title: string;
			message?: string;
			options?: string[];
	  }
	| { type: 'log'; level: LogLevel; message: string };

/** Where the sidecar's own diagnostics go: one `log` message each. */
export interface Diagnostics {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export function encode(message: SidecarMessage | SidecarRequest): string {
	return `${JSON.stringify(message)}\n`;
}

export interface Decoder<T> {
	/** Feed one chunk; returns every complete message it completed, in order. */
	push(chunk: string): T[];
}

export interface DecoderOptions {
	/**
	 * Report a non-JSON line instead of throwing.
	 *
	 * The sidecar uses the default (throw): a malformed request is our own code disagreeing with
	 * itself. The extension passes a logger, because the process it reads from may print a stray line
	 * that no framing change can prevent — and one stray line must not tear down a working session.
	 * Either way the line is *reported*; nothing is dropped silently.
	 */
	onBadFrame?: (line: string) => void;
}

/**
 * Line-splitting decoder. A frame that is not JSON is a protocol bug on the other side, not
 * something to skip quietly: the default is to fail loudly (the caller exits), and `onBadFrame` is the
 * one documented way to degrade that to a report.
 */
export function createDecoder<T = unknown>(options: DecoderOptions = {}): Decoder<T> {
	let buffer = '';
	return {
		push(chunk: string): T[] {
			buffer += chunk;
			const messages: T[] = [];
			let index = buffer.indexOf('\n');
			while (index >= 0) {
				const line = buffer.slice(0, index).replace(/\r$/, '');
				buffer = buffer.slice(index + 1);
				if (line.trim().length > 0) {
					try {
						messages.push(JSON.parse(line) as T);
					} catch {
						if (options.onBadFrame === undefined) throw new Error(`bad frame: ${line}`);
						options.onBadFrame(line);
					}
				}
				index = buffer.indexOf('\n');
			}
			return messages;
		},
	};
}

export function toSidecarError(error: unknown, fallback: SidecarErrorCode): SidecarError {
	if (error instanceof SidecarRequestError) return { code: error.code, message: error.message };
	const message = error instanceof Error ? error.message : String(error);
	return { code: fallback, message };
}
