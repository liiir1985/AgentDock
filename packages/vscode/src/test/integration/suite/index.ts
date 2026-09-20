/**
 * Integration entry point: `@vscode/test-electron` requires this module inside the extension host and
 * awaits `run()`. Deliberately dependency-free (no mocha) — the suite is one async sequence, so a
 * failure is this promise rejecting and the runner reporting the extension host did not finish.
 */

import { runReviewSuite } from './review';

export async function run(): Promise<void> {
	await runReviewSuite();
}
