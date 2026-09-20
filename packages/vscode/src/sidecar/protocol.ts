/**
 * The extension's view of the wire protocol.
 *
 * **Authoritative definition**: `packages/sidecar/src/protocol.ts`. It is mirrored rather than
 * imported because the sidecar is a Bun-only package that Node cannot `require` and whose `.ts`
 * sources sit outside this package's `rootDir`; a build step to publish one type file across the
 * boundary would cost more than the duplication.
 *
 * The mirror is kept honest by `packages/vscode/src/model/protocol-mirror.test.ts`, which asserts
 * that the method names and message kinds here are exactly the ones in the sidecar's source.
 */

import type { AdapterCapabilities, AdapterEvent, UsageReport } from '@agentdock/core';

export type SidecarErrorCode = 'bun-version' | 'sdk-version' | 'tool-coverage' | 'session' | 'internal';

export interface SidecarError {
	code: SidecarErrorCode;
	message: string;
}

export interface SessionInfo {
	sessionId: string;
	sdkVersion: string;
	bunVersion: string;
	capabilities: AdapterCapabilities;
	fileTools: string[];
}

export type UiRequestKind = 'select' | 'confirm' | 'input';
export type LogLevel = 'info' | 'warning' | 'error';

export interface UiRequest {
	requestId: string;
	kind: UiRequestKind;
	title: string;
	message?: string;
	options?: string[];
}

/** Everything the sidecar can send us that is not a response. */
export type SidecarNotification =
	| ({ type: 'ready' } & SessionInfo)
	| { type: 'response'; id: number; ok: true; result: unknown }
	| { type: 'response'; id: number; ok: false; error: SidecarError }
	| { type: 'event'; event: AdapterEvent }
	| { type: 'delta'; text: string }
	| ({ type: 'ui-request' } & UiRequest)
	| { type: 'log'; level: LogLevel; message: string };

/** Request shapes, keyed by method: exactly the sidecar's `ParamByMethod`/`ResultByMethod` pair. */
export interface RequestByMethod {
	start: { params: { workspaceRoot: string }; result: SessionInfo };
	prompt: { params: { text: string }; result: Record<string, never> };
	steer: { params: { text: string }; result: { supported: true } };
	followUp: { params: { text: string }; result: { supported: true } };
	abort: { params: Record<string, never>; result: Record<string, never> };
	usage: { params: Record<string, never>; result: UsageReport | null };
	compact: { params: Record<string, never>; result: Record<string, never> };
	uiResponse: { params: { requestId: string; value: string | boolean | null }; result: Record<string, never> };
	setActiveTools: { params: { names: string[] }; result: Record<string, never> };
	shutdown: { params: Record<string, never>; result: Record<string, never> };
}

export type RequestMethod = keyof RequestByMethod;

export interface SidecarRequest<M extends RequestMethod = RequestMethod> {
	id: number;
	method: M;
	params: RequestByMethod[M]['params'];
}

export interface DecodedFrames {
	messages: SidecarNotification[];
	/** Lines that were not JSON. Reported, never dropped silently — see `DecoderOptions` in the sidecar. */
	badFrames: string[];
}

/**
 * Same framing as the sidecar's `createDecoder`, with the one difference this side needs: a stray line
 * (a library printing to the sidecar's stdout) is *reported* instead of throwing, because tearing down
 * a working session over one noisy line is worse than skipping it. Every bad frame is logged.
 */
export function decodeFrames(state: { buffer: string }, chunk: string): DecodedFrames {
	state.buffer += chunk;
	const messages: SidecarNotification[] = [];
	const badFrames: string[] = [];
	let index = state.buffer.indexOf('\n');
	while (index >= 0) {
		const line = state.buffer.slice(0, index).replace(/\r$/, '');
		state.buffer = state.buffer.slice(index + 1);
		if (line.trim().length > 0) {
			try {
				messages.push(JSON.parse(line) as SidecarNotification);
			} catch {
				badFrames.push(line);
			}
		}
		index = state.buffer.indexOf('\n');
	}
	return { messages, badFrames };
}

export function encodeRequest(request: SidecarRequest): string {
	return `${JSON.stringify(request)}\n`;
}
