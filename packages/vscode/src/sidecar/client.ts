/**
 * The sidecar process: one per window, started lazily, shut down on deactivate (M4).
 *
 * Requests carry an id and are answered by the sidecar; everything else it sends is a notification and
 * is forwarded as-is. `abort` and `uiResponse` are deliberately *not* queued behind a running prompt —
 * a client that serialised every request would make the stop button unusable, which is the whole
 * reason those two exist.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

import {
	type RequestByMethod,
	type RequestMethod,
	type SessionInfo,
	type SidecarNotification,
	type SidecarRequest,
	decodeFrames,
	encodeRequest,
} from './protocol';

export interface SidecarClientOptions {
	/** Resolved by `locateBun()`. */
	bunCommand: string;
	/** The sidecar entry file, run directly by Bun (development: its TypeScript source). */
	entry: string;
	workspaceRoot: string;
	/** Every notification the protocol does not consume internally. */
	onNotification(message: SidecarNotification): void;
	/** stderr, verbatim: the sidecar's own logging. */
	onStderr(line: string): void;
	/** The process died. `expected` is true for a shutdown we asked for. */
	onExit(code: number | null, expected: boolean): void;
	/** A response that never came because the process went away. */
	onFatal(message: string): void;
}

export class SidecarClient {
	private child: ChildProcessWithoutNullStreams | undefined;
	private readonly decoderState = { buffer: '' };
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private serial = 0;
	private shuttingDown = false;
	private info: SessionInfo | undefined;

	constructor(private readonly options: SidecarClientOptions) {}

	get running(): boolean {
		return this.child !== undefined;
	}

	/** The `ready` payload of the running session, once it has arrived. */
	get sessionInfo(): SessionInfo | undefined {
		return this.info;
	}

	start(): void {
		if (this.child !== undefined) return;
		this.shuttingDown = false;
		const child = spawn(
			this.options.bunCommand,
			[this.options.entry, '--workspace-root', this.options.workspaceRoot],
			{ cwd: this.options.workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'] },
		);
		this.child = child;

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => this.receive(chunk));
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => this.options.onStderr(chunk));
		child.on('error', (error: Error) => {
			this.failAll(`sidecar 无法启动：${error.message}`);
			this.child = undefined;
			this.options.onExit(null, false);
		});
		child.on('exit', (code) => {
			const expected = this.shuttingDown;
			this.child = undefined;
			this.failAll(`sidecar 已退出（code ${code ?? 'null'}）`);
			this.options.onExit(code, expected);
		});
	}

	async request<M extends RequestMethod>(
		method: M,
		params: RequestByMethod[M]['params'],
	): Promise<RequestByMethod[M]['result']> {
		const child = this.child;
		if (child === undefined) throw new Error(`sidecar 未运行：无法发送 ${method}`);
		const id = ++this.serial;
		const request: SidecarRequest<M> = { id, method, params };
		return await new Promise<RequestByMethod[M]['result']>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			child.stdin.write(encodeRequest(request as SidecarRequest));
		});
	}

	/** Polite shutdown: ask, then close the pipe so a hung session cannot keep us alive. */
	async dispose(): Promise<void> {
		const child = this.child;
		if (child === undefined) return;
		this.shuttingDown = true;
		try {
			await this.request('shutdown', {});
		} catch {
			// A sidecar that cannot answer is about to be killed anyway.
		}
		child.stdin.end();
		const exited = await waitForExit(child, 2000);
		if (!exited) child.kill();
		this.child = undefined;
	}

	private receive(chunk: string): void {
		const { messages, badFrames } = decodeFrames(this.decoderState, chunk);
		for (const line of badFrames) {
			// A stray print from the harness must not kill a working session, but it must be visible:
			// anything unparsable here means the stream is not purely ours.
			this.options.onStderr(`[non-protocol output] ${line}\n`);
		}
		for (const message of messages) {
			if (message.type === 'response') {
				const waiter = this.pending.get(message.id);
				if (waiter === undefined) continue;
				this.pending.delete(message.id);
				if (message.ok) waiter.resolve(message.result);
				else waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
				continue;
			}
			if (message.type === 'ready') this.info = message;
			this.options.onNotification(message);
		}
	}

	private failAll(reason: string): void {
		for (const waiter of this.pending.values()) waiter.reject(new Error(reason));
		this.pending.clear();
		this.options.onFatal(reason);
	}
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		child.once('exit', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}
