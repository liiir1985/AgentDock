/**
 * The OMP SDK session (D36/D37): one harness session per window, created lazily by the extension.
 *
 * Two things are decided here and nowhere else:
 *  - the **version gates**. Bun below the SDK's own floor and an SDK that is not the locked one are
 *    refusals, not warnings: everything downstream — hook names, `xd://` resolve, `isTerminal` on
 *    `agent_end` — is version-specific, and a half-working review surface is worse than none (D37);
 *  - **turn boundaries**. `agent_start` opens a turn and `agent_end.isTerminal !== false` says whether
 *    it is final (D2). `turn-end` is published when the prompt call settles, so a turn that threw or
 *    was aborted still closes — the ledger must never be left open on a dead turn.
 *
 * The session's own event stream is the only source of truth for the conversation (D15); the Core
 * `AdapterEvent`s are a projection of it, plus the `file-write` events the interception hooks produce.
 */

import * as path from 'node:path';

import type { AdapterCapabilities, AdapterEvent, ConfigOption, UsageReport } from '@agentdock/core';

import { SessionManager, VERSION, createAgentSession } from '@oh-my-pi/pi-coding-agent';
import type { AgentSession, AgentSessionEvent } from '@oh-my-pi/pi-coding-agent';

import { type InterceptHooks, createInterceptExtension } from './intercept';
import { SidecarRequestError, type Diagnostics } from './protocol';
import { detectShellDialect } from './shellT2';
import { checkSessionToolCoverage } from './toolClasses';
import { UiBroker, createForwardingUIContext, type UiRequest } from './ui';

/** The SDK's own `engines.bun`, and the version this build was written against (D37). */
export const MIN_BUN_VERSION = '1.3.14';
export const LOCKED_SDK_VERSION = '18.2.5';

export interface OmpSessionConfig {
	workspaceRoot: string;
	capabilities: AdapterCapabilities;
	diagnostics: Diagnostics;
}

/**
 * The adapter session, plus the verbs the Core's interface does not cover yet: the dynamic tool
 * channel (Phase 5's `review.lastOutcome` rides it), the UI answers that unblock an approval dialog,
 * and disposal.
 */
export interface OmpAdapterSession {
	readonly sessionId: string;
	readonly capabilities: AdapterCapabilities;
	subscribe(listener: (event: AdapterEvent) => void): () => void;
	/** Assistant streaming text; the panel needs it, the Core model does not. */
	subscribeDelta(listener: (text: string) => void): () => void;
	/** A dialog the harness is waiting on (approvals): the extension has to answer it (D44). */
	subscribeUiRequests(listener: (request: UiRequest) => void): () => void;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<boolean>;
	followUp(text: string): Promise<boolean>;
	abort(): Promise<void>;
	listConfigOptions(): Promise<ConfigOption[]>;
	setConfigOption(id: string, value: string): Promise<void>;
	usage(): Promise<UsageReport | null>;
	compact(): Promise<void>;
	branch(atEntryId: string): Promise<string | null>;
	resume(sessionId: string): Promise<void>;
	/** Phase 5's channel, proven live in Phase 1. */
	setActiveTools(names: string[]): Promise<void>;
	answerUi(requestId: string, value: string | boolean | null): void;
	dispose(): Promise<void>;
}

/**
 * The version gates, as a pure function so they can be exercised without an older Bun or a different
 * SDK on disk (D37: refuse rather than half-work).
 */
export function checkRuntime(bunVersion: string, sdkVersion: string): void {
	if (Bun.semver.order(bunVersion, MIN_BUN_VERSION) < 0) {
		throw new SidecarRequestError(
			'bun-version',
			`AgentDock 需要 Bun ≥ ${MIN_BUN_VERSION}；当前 ${bunVersion}。安装：https://bun.sh/install`,
		);
	}
	if (sdkVersion !== LOCKED_SDK_VERSION) {
		throw new SidecarRequestError(
			'sdk-version',
			`AgentDock 锁定 @oh-my-pi/pi-coding-agent ${LOCKED_SDK_VERSION}，当前 ${sdkVersion}：hook 与设备通道的行为随版本变化，拒绝运行。`,
		);
	}
}

export function assertRuntime(): void {
	checkRuntime(Bun.version, VERSION);
}

/**
 * The hooks are built before the session object exists, and their sink has to reach it. A late-bound
 * holder keeps that dependency one-directional and race-free: it is wired immediately after the
 * constructor, long before any tool call can run.
 */
interface SinkHolder {
	sink(event: AdapterEvent): void;
}

export async function startOmpSession(config: OmpSessionConfig): Promise<OmpAdapterSession> {
	assertRuntime();
	const { workspaceRoot, capabilities, diagnostics } = config;

	// The shell dialect is decided once, from the environment, never guessed from a command line
	// (D43). An unknown dialect turns T2 off instead of making the parser answer for the wrong shell.
	const dialect = detectShellDialect(diagnostics);

	const holder: SinkHolder = { sink: () => undefined };
	// The approval gate reaches us through the tool UI context; a request that never reaches the window
	// would leave the turn pending with nothing on screen explaining why (D44).
	const uiHolder: { send: (request: UiRequest) => void } = { send: () => undefined };
	const intercept = createInterceptExtension({
		cwd: workspaceRoot,
		diagnostics,
		dialect,
		sink: (event) => holder.sink(event),
	});

	const sessionManager = SessionManager.create(workspaceRoot, SessionManager.getDefaultSessionDir(workspaceRoot));
	const created = await createAgentSession({
		cwd: workspaceRoot,
		sessionManager,
		extensions: [intercept.factory],
		// No terminal, but the approval gate still routes through the UI context (D44): an unanswered
		// dialog is a silently hanging turn, so the forwarding context is registered unconditionally.
		hasUI: true,
	});

	const broker = new UiBroker(
		(request) => uiHolder.send(request),
		(message, level) => diagnostics[level === 'warning' ? 'warn' : level === 'error' ? 'error' : 'info'](message),
	);
	created.setToolUIContext(createForwardingUIContext(broker), true);

	// D42's mechanical check: a built-in tool with no class in the table fails the start. Foreign tools
	// (MCP servers, extensions, custom tools) are T3 and are named once in the log.
	for (const name of foreignTools(created.session)) {
		diagnostics.warn(`tool ${name} is not a built-in: treated as T3 (not attributed)`);
	}

	const session = new OmpSdkSession({
		session: created.session,
		capabilities,
		diagnostics,
		hooks: intercept.hooks,
		broker,
		workspaceRoot,
	});
	holder.sink = (event) => session.publishEvent(event);
	uiHolder.send = (request) => session.publishUiRequest(request);
	return session;
}

/**
 * The startup self-check over the session's own tool inventory, returning the foreign tool names.
 *
 * `sourceInfo.source === 'builtin'` is the SDK's own stamp; the imported name list is the second
 * opinion. Either one naming an unclassified tool is a failure (D42).
 */
function foreignTools(session: AgentSession): string[] {
	const infos = session.getAllToolInfos();
	try {
		return checkSessionToolCoverage(infos).foreign;
	} catch (error) {
		throw new SidecarRequestError('tool-coverage', error instanceof Error ? error.message : String(error));
	}
}

interface SessionInternals {
	session: AgentSession;
	capabilities: AdapterCapabilities;
	diagnostics: Diagnostics;
	hooks: InterceptHooks;
	broker: UiBroker;
	/** The workspace root: activity rows and snapshots are stated relative to it (D11). */
	workspaceRoot: string;
}

class OmpSdkSession implements OmpAdapterSession {
	private readonly listeners = new Set<(event: AdapterEvent) => void>();
	private readonly deltaListeners = new Set<(text: string) => void>();
	private readonly uiListeners = new Set<(request: UiRequest) => void>();
	private readonly unsubscribe: () => void;
	private lastIsTerminal = true;
	private disposed = false;

	constructor(private readonly internals: SessionInternals) {
		this.unsubscribe = internals.session.subscribe((event) => this.onSessionEvent(event));
	}

	get sessionId(): string {
		return this.internals.session.sessionManager.getSessionId();
	}

	get capabilities(): AdapterCapabilities {
		return this.internals.capabilities;
	}

	/** The interception hooks' sink: an attributed write becomes a Core `file-write`. */
	publishEvent(event: AdapterEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	subscribe(listener: (event: AdapterEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	subscribeDelta(listener: (text: string) => void): () => void {
		this.deltaListeners.add(listener);
		return () => this.deltaListeners.delete(listener);
	}

	subscribeUiRequests(listener: (request: UiRequest) => void): () => void {
		this.uiListeners.add(listener);
		return () => this.uiListeners.delete(listener);
	}

	/** The broker's outgoing half: a dialog (an approval) that the window has to answer. */
	publishUiRequest(request: UiRequest): void {
		for (const listener of this.uiListeners) listener(request);
	}

	async prompt(text: string): Promise<void> {
		this.lastIsTerminal = true;
		let dispatched: boolean;
		try {
			dispatched = await this.internals.session.prompt(text);
		} catch (error) {
			// A turn that threw still ends: the ledger and the UI must not keep a turn open.
			this.closeTurn(true);
			throw new SidecarRequestError('session', messageOf(error));
		}
		if (!dispatched) {
			// The dispatch bailed before the agent ran (a concurrent abort won the race), so there is no
			// turn to close — closing one would attribute the next prompt's writes to a ghost.
			this.internals.diagnostics.info('prompt was not dispatched (aborted before the agent started)');
			return;
		}
		this.closeTurn(this.lastIsTerminal);
	}

	async steer(text: string): Promise<boolean> {
		await this.internals.session.steer(text);
		return true;
	}

	async followUp(text: string): Promise<boolean> {
		await this.internals.session.followUp(text);
		return true;
	}

	async abort(): Promise<void> {
		// Any dialog the agent is waiting on dies with the turn; `null` says nobody answered.
		this.internals.broker.cancelAll();
		await this.internals.session.abort();
	}

	async listConfigOptions(): Promise<ConfigOption[]> {
		// Declared `config.options: false` (D27): an empty list is the honest answer, not a fake menu.
		return [];
	}

	async setConfigOption(id: string, _value: string): Promise<void> {
		throw new Error(`this adapter declares config.options = false, so '${id}' cannot be set (D27)`);
	}

	async usage(): Promise<UsageReport | null> {
		try {
			const stats = this.internals.session.getSessionStats();
			const context = this.internals.session.getContextUsage();
			return {
				used: context?.tokens ?? stats.tokens.total,
				size: context?.contextWindow ?? 0,
				cost: stats.cost,
				tokensByCategory: {
					input: stats.tokens.input,
					output: stats.tokens.output,
					reasoning: stats.tokens.reasoning,
					cacheRead: stats.tokens.cacheRead,
					cacheWrite: stats.tokens.cacheWrite,
				},
			};
		} catch (error) {
			this.internals.diagnostics.warn(`usage unavailable: ${messageOf(error)}`);
			return null;
		}
	}

	async compact(): Promise<void> {
		await this.internals.session.compact();
	}

	async branch(_atEntryId: string): Promise<string | null> {
		// Declared false in the capability matrix: Phase 4 owns session-side lifecycle (D33).
		return null;
	}

	async resume(_sessionId: string): Promise<void> {
		throw new Error('session resume is not implemented in this phase (capabilities.session.resume = false)');
	}

	async setActiveTools(names: string[]): Promise<void> {
		await this.internals.session.setActiveToolsByName(names);
	}

	answerUi(requestId: string, value: string | boolean | null): void {
		this.internals.broker.resolve(requestId, value);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.internals.broker.cancelAll();
		await this.internals.session.dispose();
	}

	private closeTurn(isTerminal: boolean): void {
		this.internals.hooks.resetPending();
		this.publishEvent({ type: 'turn-end', isTerminal });
		void this.publishUsage();
	}

	private async publishUsage(): Promise<void> {
		this.publishEvent({ type: 'usage', report: await this.usage() });
	}

	private onSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case 'agent_start':
				this.publishEvent({ type: 'turn-start' });
				return;
			case 'agent_end':
				this.lastIsTerminal = event.isTerminal !== false;
				this.internals.hooks.resetPending();
				return;
			case 'message_update': {
				const update = event.assistantMessageEvent;
				if (update.type !== 'text_delta') return;
				for (const listener of this.deltaListeners) listener(update.delta);
				return;
			}
			case 'message_end': {
				const message = event.message;
				if (typeof message !== 'object' || message === null) return;
				if (!('role' in message)) return;
				const role = message.role;
				if (role !== 'user' && role !== 'assistant') return;
				const text = messageText('content' in message ? message.content : undefined);
				if (text.trim().length === 0) return;
				this.publishEvent({ type: 'message', role, text });
				return;
			}
			case 'tool_execution_start':
				this.publishEvent({
					type: 'tool-activity',
					tool: event.toolName,
					summary: activitySummary(event.toolName, event.args, this.internals.workspaceRoot),
				});
				return;
			case 'tool_execution_end':
				this.publishEvent({
					type: 'tool-activity',
					tool: event.toolName,
					summary: `${event.toolName}${event.isError === true ? ' ✗' : ' ✓'}`,
				});
				return;
			default:
				return;
		}
	}
}

/**
 * `write src/a.ts` - the one-line form the chat panel shows for a tool call.
 *
 * A path argument is the one worth shortening: the agent passes it absolute, and a row that opens with
 * `c:/Users/.../Temp/.../seed-a.ts` buries the part a reviewer reads (D11). Commands and queries are left
 * exactly as they came - rewriting paths inside a shell command would be guessing.
 */
export function activitySummary(tool: string, args: unknown, cwd: string): string {
	const target = firstString(args, ['path', 'file_path']);
	if (target !== undefined) return `${tool} ${firstLine(relativeTo(target, cwd))}`;
	const other = firstString(args, ['command', 'input', 'query', 'pattern']);
	return other === undefined ? tool : `${tool} ${firstLine(other)}`;
}

/**
 * OMP decorates a target with a line suffix (`src/a.ts:12-20`, `src/a.ts:-15`): the suffix stays, the
 * workspace prefix goes. Anything outside the workspace is shown as it came, and the `c:` of a Windows
 * drive is not a suffix - the regex only accepts `:` followed by digits.
 */
function relativeTo(value: string, cwd: string): string {
	const match = /^(.+?)(:\d*(?:-\d+)?)?$/.exec(value);
	const relative = path.relative(cwd, match?.[1] ?? value);
	if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) return value;
	return `${relative.replace(/\\/g, '/')}${match?.[2] ?? ''}`;
}

function firstString(value: unknown, keys: readonly string[]): string | undefined {
	const record = asRecord(value);
	if (record === undefined) return undefined;
	for (const key of keys) {
		const field = record[key];
		if (typeof field === 'string' && field.length > 0) return field;
	}
	return undefined;
}

function firstLine(text: string): string {
	const line = text.split(/\r?\n/, 1)[0];
	return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function messageText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === 'string') {
			parts.push(part);
			continue;
		}
		const record = asRecord(part);
		const text = record?.text;
		if (typeof text === 'string') parts.push(text);
	}
	return parts.join('');
}

/**
 * The SDK hands several values to extensions as `unknown` (tool arguments, message content, tool
 * details). Reading one field off them needs a record view; every read is `typeof`-checked before
 * use, so this single cast is the boundary rather than a fabricated shape.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
