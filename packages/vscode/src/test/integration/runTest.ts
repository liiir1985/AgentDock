/**
 * Launches a real VS Code with the extension under development and the **stub** sidecar (plan G.2).
 *
 * The workspace is a throwaway copy of `test/fixtures/workspace`: the suite writes real files there, and
 * a test run must not leave the repository dirty. `VSCODE_EXECUTABLE` overrides the binary; the default
 * is the installation this project is developed against.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
	const packageRoot = path.resolve(__dirname, '../../..');
	const extensionTestsPath = path.resolve(__dirname, 'suite/index');
	const vscodeExecutablePath =
		process.env.VSCODE_EXECUTABLE ?? 'C:\\Users\\Admin\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';

	const testCase = process.env.AGENTDOCK_CASE ?? 'review';
	const workspace = mkdtempSync(path.join(tmpdir(), 'agentdock-workspace-'));
	cpSync(path.join(packageRoot, 'test', 'fixtures', 'workspace'), workspace, { recursive: true });

	// The no-Bun case (V6) is a *setting*, not an environment variable: the extension has to reach its
	// own refusal through the same configuration a user would use.
	const bogusBun = path.join(workspace, 'no-such-dir', 'bun.exe');
	if (testCase === 'no-bun') {
		mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
		writeFileSync(
			path.join(workspace, '.vscode', 'settings.json'),
			JSON.stringify({ 'agentdock.bunPath': bogusBun }, null, 2),
			'utf8',
		);
	}

	try {
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath: packageRoot,
			extensionTestsPath,
			extensionTestsEnv: {
				AGENTDOCK_SIDECAR_ENTRY: path.join(packageRoot, 'test', 'fixtures', 'stub-sidecar.ts'),
				AGENTDOCK_STUB_SCRIPT: process.env.AGENTDOCK_STUB_SCRIPT ?? 'S1',
				AGENTDOCK_CASE: testCase,
				AGENTDOCK_BOGUS_BUN: bogusBun,
			},
			launchArgs: [
				'--disable-extensions',
				'--disable-gpu',
				'--enable-proposed-api=agentdock.agentdock',
				workspace,
			],
		});
		console.log('integration suite passed');
	} catch (error) {
		console.error('integration suite failed');
		console.error(error);
		process.exitCode = 1;
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

void main();
