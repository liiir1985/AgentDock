/**
 * Finding Bun (D36) — the editor side of `model/bunResolve.ts`, which owns the decision.
 *
 * The extension is only a client; the harness runs in a Bun process. Which Bun that is has to be known
 * before anything else, and "not found" has to be a clear refusal with an install hint: the exit
 * criterion is that pulling Bun out produces an error, not a half-started review surface.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { type BunLocation, resolveBun } from '../model/bunResolve';

export { BunNotFoundError } from '../model/bunResolve';

const CONFIG_SECTION = 'agentdock';
const BUN_PATH_KEY = 'bunPath';

export function locateBun(): BunLocation {
	return resolveBun({
		configured: vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(BUN_PATH_KEY, ''),
		exists: (candidate) => fs.existsSync(candidate),
		version: versionOf,
		homeCandidates: defaultBunPaths,
	});
}

/** `~/.bun/bin/bun` (the installer's location), with the `.exe` suffix on Windows. */
export function defaultBunPaths(): string[] {
	return [
		path.join(os.homedir(), '.bun', 'bin', 'bun.exe'),
		path.join(os.homedir(), '.bun', 'bin', 'bun'),
	];
}

/** `undefined` when the command cannot be run at all. */
export function versionOf(command: string): string | undefined {
	const result = spawnSync(command, ['--version'], { encoding: 'utf8', shell: false });
	if (result.error !== undefined) return undefined;
	if (result.status !== 0) return undefined;
	const version = (result.stdout ?? '').trim();
	return version.length > 0 ? version : undefined;
}
