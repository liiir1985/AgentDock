/**
 * The adapter declaration: the capability matrix has to survive `assertCapabilities`, the T1 set has to
 * be the same constant the interception uses, and the version gates have to refuse instead of warn.
 */

import { describe, expect, test } from 'bun:test';

import { assertCapabilities } from '@agentdock/core';

import { OMP_SDK_ADAPTER_ID, OmpSdkAdapter } from './adapter';
import { SidecarRequestError, type Diagnostics } from './protocol';
import { LOCKED_SDK_VERSION, MIN_BUN_VERSION, checkRuntime } from './session';
import { T1_EXACT_TOOLS } from './toolClasses';

const silent: Diagnostics = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('the declaration', () => {
	test('the capability matrix is internally consistent', () => {
		const adapter = new OmpSdkAdapter(silent);
		expect(() => assertCapabilities(adapter.capabilities)).not.toThrow();
		expect(adapter.id).toBe(OMP_SDK_ADAPTER_ID);
	});

	test('the declared T1 set is the one the interception covers', () => {
		const adapter = new OmpSdkAdapter(silent);
		expect([...adapter.fileTools]).toEqual([...T1_EXACT_TOOLS]);
		expect(() => adapter.assertToolCoverage(adapter.fileTools)).not.toThrow();
	});

	test('coverage of a different set is still an error, so the check has teeth', () => {
		const adapter = new OmpSdkAdapter(silent);
		expect(() => adapter.assertToolCoverage(['write', 'edit'])).toThrow(/coverage mismatch/);
	});

	test('the honest answers are the ones this phase can keep', () => {
		const adapter = new OmpSdkAdapter(silent);
		const { capabilities } = adapter;
		expect(capabilities.write.intercept).toBe('own');
		expect(capabilities.diff.declared).toBe(true);
		// Measured, not assumed: an embedded session with `always-ask` answers "requires approval but no
		// interactive UI available" and the write never lands, because the gate reads the runner's UI
		// context and the SDK never installs one.
		expect(capabilities.permission.request).toBe(false);
		expect(capabilities.steer).toBe(true);
		expect(capabilities.followUp).toBe(true);
		expect(capabilities.compact).toBe(true);
		expect(capabilities.usage.detail).toBe('full');
		expect(capabilities.session).toEqual({ resume: false, list: false, branch: false, revert: false });
		expect(capabilities.config.options).toBe(false);
		expect(capabilities.capability.transport).toBe('none');
		expect(capabilities.mcp.injection).toBe(false);
		expect(capabilities.runtime.requirements).toEqual([`bun>=${MIN_BUN_VERSION}`]);
	});
});

describe('the version gates', () => {
	test('the versions this build runs on pass', () => {
		expect(() => checkRuntime(MIN_BUN_VERSION, LOCKED_SDK_VERSION)).not.toThrow();
		expect(() => checkRuntime('1.4.2', LOCKED_SDK_VERSION)).not.toThrow();
	});

	test('an older Bun is a refusal with a code the UI can act on', () => {
		try {
			checkRuntime('1.3.13', LOCKED_SDK_VERSION);
			throw new Error('expected the gate to refuse');
		} catch (error) {
			expect(error).toBeInstanceOf(SidecarRequestError);
			expect((error as SidecarRequestError).code).toBe('bun-version');
			expect((error as Error).message).toContain('Bun ≥ 1.3.14');
		}
	});

	test('a different SDK is a refusal too: hook behaviour is version-specific', () => {
		try {
			checkRuntime('1.4.2', '18.1.0');
			throw new Error('expected the gate to refuse');
		} catch (error) {
			expect((error as SidecarRequestError).code).toBe('sdk-version');
		}
	});
});
