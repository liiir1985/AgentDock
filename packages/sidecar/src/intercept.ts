/**
 * T1 interception (M1): in-process extension hooks, never `customTools`.
 *
 * Why hooks instead of re-registering same-named tools:
 *  - `customTools` entries with a built-in name are `set()` into the tool registry *and*
 *    `builtInRegistryToolNames.delete(name)`, and that set is what decides whether the `xd://` device
 *    channel is available. Shadowing `write` would therefore break `ast_edit`'s own apply step
 *    (`write xd://resolve`) — the interception would disable the tool it is supposed to observe;
 *  - a `ToolDefinition` cannot faithfully reproduce `concurrency`, `matcherDigest` or `loadMode`, so
 *    the definition the model sees would drift from the real one.
 *
 * `tool_call` fires before the native implementation runs (the agent loop emits it at arg-prep time;
 * the tool wrapper emits it for dispatches the loop never saw), which is what makes the pre-image
 * exact — the `own` level in Core's vocabulary (`snapshotPolicy('own') === 'exact-before'`).
 *
 * Two shapes need more than a simple before/after:
 *  - `ast_edit` never writes during its own call. It stages a preview (`details.applied === false`)
 *    and a later `write xd://resolve` applies it, so the pre-image is taken at the *preview* result
 *    and compared when the resolve arrives. A staged layer that is never resolved, rejected, or
 *    resolved by a write that failed produces no change event at all — which is correct: no bytes
 *    moved.
 *  - `bash` is T2: the Core's command-line parser decides whether the command line names its targets
 *    reliably, and an unreliable answer skips the command wholesale (D43).
 */

import type {
	AdapterEvent,
	Attribution,
	ObservedWrite,
	ShellDialect,
} from '@agentdock/core';

import type { ExtensionAPI, ExtensionFactory, ToolCallEvent, ToolResultEvent } from '@oh-my-pi/pi-coding-agent';

import { extractPaths, pathsFromResult } from './intent';
import { Snapshot, snapshot, stagedWrites, writesFrom } from './observe';
import type { Diagnostics } from './protocol';
import { bashTargets } from './shellT2';
import { classifyTool } from './toolClasses';

/** The two halves of a tool call we need; structural so the tests can drive them without the SDK. */
export interface ToolCallLike {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

export interface ToolResultLike extends ToolCallLike {
	details?: unknown;
	isError?: boolean;
}

export interface InterceptOptions {
	cwd: string;
	/** Where attributed writes go: the Core's own `file-write` event. */
	sink: (event: AdapterEvent) => void;
	diagnostics: Diagnostics;
	/** `null` disables T2 (see `shellT2.ts`). */
	dialect: ShellDialect | null;
}

interface Pending {
	paths: string[];
	before: Map<string, Snapshot>;
	attribution: Attribution;
}

interface StagedLayer {
	before: Map<string, Snapshot>;
}

/** Beyond this many *unresolved* tool calls we drop the oldest: a leak, not a working set. */
const PENDING_LIMIT = 128;

/**
 * The hook bodies, separated from their registration so the unit tests can drive a scripted
 * call/result sequence with no SDK and no model.
 */
export class InterceptHooks {
	private readonly pending = new Map<string, Pending>();
	/** Previewed `ast_edit`s awaiting their `write xd://resolve`. */
	private readonly staged: StagedLayer[] = [];

	constructor(private readonly options: InterceptOptions) {}

	/** A tool call: take the pre-image now, while the bytes are still the old ones. */
	onToolCall(event: ToolCallLike): void {
		const { diagnostics, cwd } = this.options;
		const input = event.input ?? {};
		const toolClass = classifyTool(event.toolName);

		if (toolClass === 'T1_EXACT') {
			// `ast_edit` writes nothing here; its targets only exist in the preview result.
			if (event.toolName === 'ast_edit') return;
			const paths = extractPaths(event.toolName, input, diagnostics, cwd);
			this.remember(event.toolCallId, paths, { tier: 'T1', source: event.toolName, level: 'own' });
			return;
		}

		if (toolClass === 'T2_BEST_EFFORT') {
			if (event.toolName !== 'bash') return;
			const command = stringValue(input.command);
			if (command === undefined) return;
			const targets = bashTargets(command, this.options.dialect, diagnostics);
			if (targets === null) return;
			this.remember(event.toolCallId, targets.paths, { tier: 'T2', source: command, level: 'async-signal' });
			return;
		}

		if (toolClass === 'T3_NONE' && event.toolName === 'lsp' && lspMayWrite(input)) {
			// A rename or an applied code action does write files, but the target path only exists after
			// the fact — there is no pre-image to take, and D42 prefers an admitted gap to a wrong guess.
			diagnostics.warn('lsp rename/code-action may have written files: no pre-image, change not attributed');
		}
	}

	/** The result: compare, attribute, and emit. */
	onToolResult(event: ToolResultLike): void {
		const input = event.input ?? {};

		if (event.toolName === 'write') {
			const target = stringValue(input.path);
			if (target === 'xd://resolve') {
				this.applyStaged(event);
				return;
			}
			if (target === 'xd://reject') {
				this.discardStaged(event);
				return;
			}
		}

		const toolClass = classifyTool(event.toolName);
		if (toolClass === 'T1_EXACT' && event.toolName === 'ast_edit') {
			this.stage(event);
			return;
		}
		const pending = this.pending.get(event.toolCallId);
		this.pending.delete(event.toolCallId);
		if (pending === undefined) return;
		if (toolClass !== 'T1_EXACT' && toolClass !== 'T2_BEST_EFFORT') return;

		const writes = writesFrom(pending.paths, pending.before, pending.attribution, {
			cwd: this.options.cwd,
			diagnostics: this.options.diagnostics,
			resultPaths: pathsFromResult(event.details),
		});
		this.emit(writes);
	}

	/**
	 * A turn is over: unresolved snapshots belong to calls that never reported back (a blocked tool, a
	 * provider error). Staged previews survive, because the resolve may still arrive.
	 */
	resetPending(): void {
		this.pending.clear();
	}

	private remember(toolCallId: string, paths: readonly string[], attribution: Attribution): void {
		if (paths.length === 0) return;
		const before = snapshot(paths, this.options.cwd, this.options.diagnostics);
		if (before.size === 0) return;
		this.pending.set(toolCallId, { paths: [...paths], before, attribution });
		this.evict();
	}

	private evict(): void {
		while (this.pending.size > PENDING_LIMIT) {
			const oldest = this.pending.keys().next();
			if (oldest.done === true) return;
			this.pending.delete(oldest.value);
		}
	}

	/** `ast_edit` returned a preview: remember the pre-image and wait for the resolve. */
	private stage(event: ToolResultLike): void {
		const details = asRecord(event.details);
		const paths = pathsFromResult(details);
		if (paths.length === 0) return;
		if (details?.applied === true) {
			// The preview was applied in the same call, so the bytes are already gone: we cannot name a
			// pre-image, and saying nothing beats attributing a diff we do not have.
			this.options.diagnostics.warn(
				'ast_edit applied without a staged preview: no pre-image, change not attributed',
			);
			return;
		}
		const before = snapshot(paths, this.options.cwd, this.options.diagnostics);
		if (before.size === 0) return;
		this.staged.push({ before });
	}

	/**
	 * `write xd://resolve` applied the pending preview. Only paths whose bytes actually changed become
	 * events, so a layer consumed in an order we did not predict (or consumed twice) cannot produce a
	 * wrong attribution.
	 */
	private applyStaged(event: ToolResultLike): void {
		if (event.isError === true) {
			// A failed resolve does not consume OMP's staged action, so it must not consume ours either.
			this.options.diagnostics.info('write xd://resolve failed: the staged preview is still pending');
			return;
		}
		const layer = this.staged.pop();
		if (layer === undefined) return;
		const writes = stagedWrites(
			layer.before,
			this.options.cwd,
			{ tier: 'T1', source: 'ast_edit', level: 'own' },
			this.options.diagnostics,
		);
		this.emit(writes);
	}

	private discardStaged(event: ToolResultLike): void {
		if (event.isError === true) return;
		this.staged.pop();
	}

	private emit(writes: readonly ObservedWrite[]): void {
		for (const write of writes) this.options.sink({ type: 'file-write', write });
	}
}

/** The registered extension plus the hook set its owner keeps for per-turn cleanup. */
export interface InterceptedExtension {
	hooks: InterceptHooks;
	factory: ExtensionFactory;
}

/** The SDK's hook registration, with the bodies above. */
export function createInterceptExtension(options: InterceptOptions): InterceptedExtension {
	const hooks = new InterceptHooks(options);
	return {
		hooks,
		factory: (pi: ExtensionAPI) => {
			pi.on('tool_call', (event: ToolCallEvent) => {
				hooks.onToolCall(event as unknown as ToolCallLike);
				// Never block and never rewrite the input: we only need the picture before the write
				// (D44 — the IDE takes a snapshot, it does not take over the tool).
				return undefined;
			});
			pi.on('tool_result', (event: ToolResultEvent) => {
				hooks.onToolResult(event as unknown as ToolResultLike);
				return undefined;
			});
		},
	};
}

const LSP_WRITE_ACTIONS = new Set(['rename', 'code_action', 'apply_code_action', 'fix']);

function lspMayWrite(input: Record<string, unknown>): boolean {
	const action = stringValue(input.action) ?? stringValue(input.op);
	if (action === undefined) return stringValue(input.new_name) !== undefined;
	return LSP_WRITE_ACTIONS.has(action.toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}
