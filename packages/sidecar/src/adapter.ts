/**
 * The harness adapter declaration (D27/D32/D39/D42).
 *
 * Every capability here is the honest Phase 1 answer, and the `false` groups are deliberate:
 *  - the four `session` verbs and `config.options` are Phase 4/3 work. Declaring them `true` would
 *    make the UI offer actions that cannot run (D27: never pretend a capability);
 *  - `permission.request` is `false` because the gate is unreachable from an embedded session, which is
 *    a measured fact rather than a missing feature (see the note on the declaration below);
 *  - `capability.transport: 'none'` because the capability layer is Phase 6, and `mcp.injection: false`
 *    is the only value consistent with it (`assertCapabilities` enforces exactly that pair).
 *
 * `write.intercept: 'own'` matches the Core's OMP reference value: the hooks run before the native
 * implementation, so the pre-image is exact (`snapshotPolicy('own') === 'exact-before'`).
 *
 * The T1 set is *not* a list of wrapped tools here — hooks observe every tool. Coverage is enforced by
 * the classification table at startup (see `toolClasses.ts`), and `assertToolCoverage` keeps the
 * declaration consistent with itself.
 */

import {
	type AdapterCapabilities,
	BaseHarnessAdapter,
	type StartSessionOptions,
	assertCapabilities,
} from '@agentdock/core';

import type { Diagnostics } from './protocol';
import { type OmpAdapterSession, startOmpSession } from './session';
import { T1_EXACT_TOOLS } from './toolClasses';

export const OMP_SDK_ADAPTER_ID = 'omp-sdk';

export const OMP_SDK_CAPABILITIES: AdapterCapabilities = {
	session: { resume: false, list: false, branch: false, revert: false },
	// `false` is the empirical answer, not a phase plan. OMP's approval gate refuses an embedded session
	// before it ever prompts: `ExtensionToolWrapper` consults `runner.hasUI()`, and the runner's UI context
	// is installed only by `ExtensionRunner.initialize()`, which `createAgentSession()` never calls - the
	// one UI seam the SDK exposes (`setToolUIContext`) feeds the tool context store, not the runner. With
	// `tools.approvalMode: always-ask` a real session therefore answered `Tool "edit" requires approval but
	// no interactive UI available.` and the write never landed, so there is no gate for this build to
	// serve and the UI must not claim one (D35). Stage 3 flips this once OMP exposes a runner UI seam.
	permission: { request: false },
	diff: { declared: true },
	write: { intercept: 'own' },
	config: { options: false },
	mcp: { injection: false },
	capability: { transport: 'none' },
	steer: true,
	followUp: true,
	usage: { detail: 'full' },
	compact: true,
	runtime: { requirements: [`bun>=${'1.3.14'}`] },
};

export class OmpSdkAdapter extends BaseHarnessAdapter {
	readonly id = OMP_SDK_ADAPTER_ID;
	readonly fileTools = T1_EXACT_TOOLS;
	readonly capabilities = OMP_SDK_CAPABILITIES;

	constructor(private readonly diagnostics: Diagnostics) {
		super();
		// Two invariants are worth failing at construction for: a harness that cannot intercept writes
		// must not advertise an attributable diff, and MCP injection only exists on an MCP transport.
		assertCapabilities(this.capabilities);
	}

	async startSession(options: StartSessionOptions): Promise<OmpAdapterSession> {
		this.assertToolCoverage(this.fileTools);
		return startOmpSession({
			workspaceRoot: options.workspaceRoot,
			capabilities: this.capabilities,
			diagnostics: this.diagnostics,
		});
	}
}
