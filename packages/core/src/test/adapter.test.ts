/**
 * Adapter capability declaration (D27 / D32 / D39 / D42).
 *
 * Capabilities are what the Core degrades from, so the two relationships enforced here are the ones
 * whose violation produces a UI that lies instead of a UI that is merely limited: MCP injection on
 * a transport that cannot carry it, and an "attributable" diff from a harness whose writes we never
 * see. `assertCapabilities` must reject exactly those two and stay out of everything else — the
 * remaining values are honest declarations the Core does not judge.
 *
 * The concrete OMP values are pinned because they are the declaration Phase 1 ships.
 */

import test from 'node:test';
import { throws } from 'node:assert/strict';

import { AdapterCapabilities, AdapterSession, BaseHarnessAdapter, assertCapabilities } from '../adapter';

/** The Phase 1 OMP declaration, verbatim from the adapter header. */
const OMP: AdapterCapabilities = {
	session: { resume: true, list: true, branch: true, revert: true },
	permission: { request: true },
	diff: { declared: true },
	write: { intercept: 'own' },
	config: { options: true },
	mcp: { injection: false },
	capability: { transport: 'custom-tools' },
	steer: true,
	followUp: true,
	usage: { detail: 'full' },
	compact: true,
	runtime: { requirements: ['bun>=1.3.14'] },
};

test('the OMP declaration passes every enforced invariant', () => {
	assertCapabilities(OMP);
});

test('MCP injection on a non-MCP transport is rejected', () => {
	throws(() => assertCapabilities({ ...OMP, mcp: { injection: true } }), {
		name: 'CapabilityError',
		message: /mcp\.injection/,
	});
});

test('an MCP transport that declares no injection is rejected', () => {
	throws(() => assertCapabilities({ ...OMP, capability: { transport: 'mcp' } }), {
		name: 'CapabilityError',
		message: /mcp\.injection/,
	});
});

test('a harness we cannot intercept must not advertise an attributable diff', () => {
	throws(() => assertCapabilities({ ...OMP, write: { intercept: 'none' } }), {
		name: 'CapabilityError',
		message: /diff\.declared/,
	});
});

test('the two invariants are relations, not blanket bans', () => {
	// A consistent MCP declaration is fine, and an uninterceptable harness is fine as long as it
	// does not claim a diff — anything stricter here would forbid a legal declaration.
	assertCapabilities({ ...OMP, mcp: { injection: true }, capability: { transport: 'mcp' } });
	assertCapabilities({ ...OMP, write: { intercept: 'none' }, diff: { declared: false } });
});

/** Minimal concrete adapter: the test double only needs the coverage entry point. */
class CoverageAdapter extends BaseHarnessAdapter {
	readonly id = 'coverage-test';
	readonly capabilities = OMP;
	readonly fileTools = ['edit', 'write'];

	async startSession(): Promise<AdapterSession> {
		throw new Error('this double exists for the coverage check only');
	}
}

test('BaseHarnessAdapter hands the coverage check the harness tool list', () => {
	const adapter = new CoverageAdapter();

	adapter.assertToolCoverage(['write', 'edit']);
	throws(() => adapter.assertToolCoverage(['edit']), {
		name: 'ToolCoverageError',
		message: /unwrapped=\[write\]/,
	});
});
