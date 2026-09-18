import { runApplySuite } from './apply';

/**
 * Entry point required by `@vscode/test-electron`: it is `require`d inside the
 * extension host and awaited. Deliberately dependency-free (no mocha): the suite
 * is a plain async sequence, so a failure surfaces as this promise rejecting.
 */
export async function run(): Promise<void> {
	await runApplySuite();
}
