/**
 * The adapter boundary (D27 / D32 / D39 / D42).
 *
 * Everything a harness can do differently is declared here as a capability, and the Core degrades
 * from the declaration instead of probing. Two invariants are worth enforcing mechanically, because
 * getting them wrong produces a UI that lies rather than a UI that is limited:
 *  - MCP injection only exists where the capability transport *is* MCP;
 *  - a harness that cannot intercept writes cannot claim a declared diff either — an unattributable
 *    change must never be presented as if it were reviewed.
 *
 * Phase 0 ships the types and the two checks; the OMP adapter implements the verbs in Phase 1.
 * OMP values, as a reference: transport `custom-tools`, `mcp.injection: false`,
 * `write.intercept: 'own'`, `diff.declared: true`, `permission.request: true`, `steer: true`,
 * `followUp: true`, `runtime.requirements: ['bun>=1.3.14']`, all four `session` verbs true.
 */

import { assertToolCoverage } from './attribution';
import { LineRange } from './lines';
import { InterceptLevel, ObservedWrite } from './model';

export type CapabilityTransport = 'mcp' | 'host-tools' | 'custom-tools' | 'none';

export type UsageDetail = 'full' | 'per-turn' | 'none';

export interface AdapterCapabilities {
	/** `revert` is the harness's own session-side rollback; the file side is always ours (D33). */
	session: { resume: boolean; list: boolean; branch: boolean; revert: boolean };
	permission: { request: boolean };
	diff: { declared: boolean };
	write: { intercept: InterceptLevel };
	config: { options: boolean };
	mcp: { injection: boolean };
	capability: { transport: CapabilityTransport };
	steer: boolean;
	followUp: boolean;
	usage: { detail: UsageDetail };
	compact: boolean;
	/** e.g. `['bun>=1.3.14']` — the adapter refuses to run when the host cannot satisfy these. */
	runtime: { requirements: string[] };
}

export class CapabilityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CapabilityError';
	}
}

export function assertCapabilities(capabilities: AdapterCapabilities): void {
	if (capabilities.mcp.injection !== (capabilities.capability.transport === 'mcp')) {
		throw new CapabilityError(
			`mcp.injection is ${capabilities.mcp.injection} but capability.transport is '${capabilities.capability.transport}': MCP injection is only meaningful on an MCP transport`,
		);
	}
	if (capabilities.write.intercept === 'none' && capabilities.diff.declared) {
		throw new CapabilityError(
			"write.intercept is 'none' but diff.declared is true: a harness we cannot intercept must not advertise an attributable diff",
		);
	}
}

export interface PillRef {
	kind: 'document' | 'selection' | 'terminal' | 'log';
	uri: string;
	range?: LineRange;
}

export interface ConfigOption {
	id: string;
	name: string;
	currentValue: string;
	options: { id: string; name: string }[];
}

export interface UsageReport {
	used: number;
	size: number;
	cost?: number;
	tokensByCategory?: Record<string, number>;
}

export interface PermissionRequest {
	tool: string;
	summary: string;
	options: { id: string; label: string }[];
}

export type AdapterEvent =
	| { type: 'turn-start' }
	/** D2: OMP's `agent_end.isTerminal !== false` is what makes a turn final. */
	| { type: 'turn-end'; isTerminal: boolean }
	/** The T1/T2 attribution input. */
	| { type: 'file-write'; write: ObservedWrite }
	| { type: 'tool-activity'; tool: string; summary: string }
	| { type: 'permission-request'; id: string; request: PermissionRequest }
	| { type: 'usage'; report: UsageReport | null }
	/** D15: a read-only copy of the conversation, never a second source of truth. */
	| { type: 'message'; role: 'user' | 'assistant'; text: string };

export interface StartSessionOptions {
	workspaceRoot: string;
	harnessConfig: Record<string, string>;
}

export interface AdapterSession {
	readonly sessionId: string;
	readonly capabilities: AdapterCapabilities;
	subscribe(listener: (event: AdapterEvent) => void): () => void;
	/** D17: pills travel as references; the document text stays with us. */
	prompt(text: string, pills: PillRef[]): Promise<void>;
	/** `false` means the harness has no steering (D25); the UI turns the control off. */
	steer(text: string): Promise<boolean>;
	followUp(text: string): Promise<boolean>;
	abort(): Promise<void>;
	listConfigOptions(): Promise<ConfigOption[]>;
	setConfigOption(id: string, value: string): Promise<void>;
	usage(): Promise<UsageReport | null>;
	/** Rejects when the harness cannot compact. */
	compact(): Promise<void>;
	/** Returns a NEW session id; `null` when branching is unsupported (D33). */
	branch(atEntryId: string): Promise<string | null>;
	resume(sessionId: string): Promise<void>;
}

export interface HarnessAdapter {
	readonly id: string;
	readonly capabilities: AdapterCapabilities;
	/** The harness's own file-changing tools — the T1 list the adapter has to cover (D42). */
	readonly fileTools: readonly string[];
	/** Called before shadowing takes effect; throws when the sets differ (see `assertToolCoverage`). */
	assertToolCoverage(wrapped: readonly string[]): void;
	startSession(options: StartSessionOptions): Promise<AdapterSession>;
}

/**
 * Convenience base a concrete adapter can extend; the coverage check is the same for every harness
 * and getting it wrong is exactly what D42 forbids.
 */
export abstract class BaseHarnessAdapter implements HarnessAdapter {
	abstract readonly id: string;
	abstract readonly capabilities: AdapterCapabilities;
	abstract readonly fileTools: readonly string[];

	assertToolCoverage(wrapped: readonly string[]): void {
		assertToolCoverage({ declared: this.fileTools, wrapped });
	}

	abstract startSession(options: StartSessionOptions): Promise<AdapterSession>;
}
