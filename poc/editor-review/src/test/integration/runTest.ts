import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Launches a real VS Code instance with this extension and runs the suite in
 * `suite/index.ts` inside its extension host.
 *
 * `VSCODE_EXECUTABLE` overrides the discovered binary; the default is the
 * installation this PoC was developed against.
 */
async function main(): Promise<void> {
	const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
	const extensionTestsPath = path.resolve(__dirname, 'suite/index');
	const vscodeExecutablePath =
		process.env.VSCODE_EXECUTABLE ?? 'C:\\Users\\Admin\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
	try {
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				'--disable-extensions',
				'--disable-gpu',
				'--enable-proposed-api=agentdock.agentdock-editor-review-poc',
				path.resolve(extensionDevelopmentPath, 'fixtures'),
			],
		});
		console.log('integration suite passed');
	} catch (error) {
		console.error('integration suite failed');
		console.error(error);
		process.exit(1);
	}
}

void main();
