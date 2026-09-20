/**
 * The sidecar entry point: NDJSON over stdio, one session, no terminal.
 *
 * Started by the extension as `bun packages/sidecar/src/main.ts --workspace-root <path>`. The window's
 * extension host cannot load the SDK (Bun-only sources), so this process is where OMP actually lives.
 *
 * Two stream-hygiene measures are worth knowing about:
 *  - the protocol owns stdout, so `process.stdout.write` is rebound to stderr. That covers libraries
 *    that print; Bun's `console.log` does *not* go through the rebound method, which is why the
 *    extension's decoder also tolerates a stray line instead of tearing the connection down;
 *  - a bad frame coming *from the extension* is still fatal (`createDecoder` throws by default): that
 *    is our own code, and a malformed request means the two halves disagree.
 *
 * Requests are dispatched concurrently, not queued: `abort` and `uiResponse` have to reach the sidecar
 * while a prompt is still running, which is the whole point of having them.
 */

import { VERSION } from '@oh-my-pi/pi-coding-agent';

import { OmpSdkAdapter } from './adapter';
import {
	type Diagnostics,
	type SessionInfo,
	type SidecarMessage,
	type SidecarRequest,
	SidecarRequestError,
	createDecoder,
	encode,
	toSidecarError,
} from './protocol';
import type { OmpAdapterSession } from './session';

/** The protocol's channel. Bound before anything else can write to stdout. */
const wire = process.stdout.write.bind(process.stdout);

// Anything the SDK prints through `process.stdout.write` would be a protocol corruption; send it to
// stderr, where the extension shows it in the "AgentDock Sidecar" output channel.
process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
	(process.stderr.write as (...args: unknown[]) => boolean)(chunk, ...rest);
	return true;
}) as typeof process.stdout.write;

function send(message: SidecarMessage): void {
	wire(encode(message));
}

const diagnostics: Diagnostics = {
	info: (message) => send({ type: 'log', level: 'info', message }),
	warn: (message) => send({ type: 'log', level: 'warning', message }),
	error: (message) => send({ type: 'log', level: 'error', message }),
};

const workspaceRoot = readWorkspaceRoot(process.argv.slice(2)) ?? process.cwd();
const adapter = new OmpSdkAdapter(diagnostics);
let session: OmpAdapterSession | null = null;

function readWorkspaceRoot(args: readonly string[]): string | undefined {
	const index = args.findIndex((arg) => arg === '--workspace-root');
	if (index < 0) return undefined;
	return args[index + 1];
}

function requireSession(method: string): OmpAdapterSession {
	if (session === null) {
		throw new SidecarRequestError('session', `${method} needs a session: send 'start' first`);
	}
	return session;
}

async function start(): Promise<SessionInfo> {
	if (session !== null) {
		// `start` is idempotent: a reloaded webview asking again must not create a second harness
		// session behind the first one's back (M4: one window, one session).
		return infoFor(session);
	}
	const started = await adapter.startSession({ workspaceRoot, harnessConfig: {} });
	started.subscribe((event) => send({ type: 'event', event }));
	started.subscribeDelta((text) => send({ type: 'delta', text }));
	started.subscribeUiRequests((request) => send({ type: 'ui-request', ...request }));
	session = started;
	return infoFor(started);
}

function infoFor(current: OmpAdapterSession): SessionInfo {
	return {
		sessionId: current.sessionId,
		sdkVersion: VERSION,
		bunVersion: Bun.version,
		capabilities: current.capabilities,
		fileTools: [...adapter.fileTools],
	};
}

async function handle(request: SidecarRequest): Promise<unknown> {
	switch (request.method) {
		case 'start': {
			const info = await start();
			send({ type: 'ready', ...info });
			return info;
		}
		case 'prompt':
			await requireSession(request.method).prompt(request.params.text);
			return {};
		case 'steer':
			await requireSession(request.method).steer(request.params.text);
			return { supported: true };
		case 'followUp':
			await requireSession(request.method).followUp(request.params.text);
			return { supported: true };
		case 'abort':
			await requireSession(request.method).abort();
			return {};
		case 'usage':
			return await requireSession(request.method).usage();
		case 'compact':
			await requireSession(request.method).compact();
			return {};
		case 'uiResponse':
			requireSession(request.method).answerUi(request.params.requestId, request.params.value);
			return {};
		case 'setActiveTools':
			await requireSession(request.method).setActiveTools(request.params.names);
			return {};
		case 'shutdown':
			if (session !== null) await session.dispose();
			return {};
		default: {
			// Exhaustive by construction; an unknown method means a version skew across the boundary.
			const unknown: never = request;
			throw new SidecarRequestError('internal', `unknown request ${JSON.stringify(unknown)}`);
		}
	}
}

async function dispatch(request: SidecarRequest): Promise<void> {
	try {
		const result = await handle(request);
		send({ type: 'response', id: request.id, ok: true, result });
	} catch (error) {
		const sidecarError = toSidecarError(error, 'internal');
		diagnostics.error(`${request.method} failed: ${sidecarError.message}`);
		send({ type: 'response', id: request.id, ok: false, error: sidecarError });
	}
	if (request.method === 'shutdown') process.exit(0);
}

const decoder = createDecoder<SidecarRequest>();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
	for (const request of decoder.push(chunk)) void dispatch(request);
});
process.stdin.on('end', () => {
	// The window is gone; a session with no UI has nobody to answer its approvals.
	void (session?.dispose() ?? Promise.resolve()).finally(() => process.exit(0));
});

// A crash has to be visible as an error, not as a silently dead review surface.
process.on('uncaughtException', (error: Error) => {
	diagnostics.error(`sidecar crashed: ${error.stack ?? error.message}`);
	process.exit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
	diagnostics.error(`sidecar rejected: ${reason instanceof Error ? reason.message : String(reason)}`);
	process.exit(1);
});
