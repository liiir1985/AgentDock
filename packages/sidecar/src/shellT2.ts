/**
 * Shell attribution (T2, D42/D43).
 *
 * The dialect is decided **once, at startup**, and never sniffed from the command text: `rm -rf x` is
 * a write in bash and a foreign name in cmd, so a parser that guessed would answer confidently about
 * a shell the command will never run in. When we cannot name the shell, T2 is off — a skipped change
 * costs coverage, a wrong one costs a Reject that restores bytes nobody asked to restore.
 */

import { parseCommandIntent, type ShellDialect } from '@agentdock/core';

import type { Diagnostics } from './protocol';

/**
 * OMP's `bash` tool runs a shell of its own choosing; `Bun.which('bash')` is the same probe the
 * harness's environment makes available to us, and on Windows the fallback is `cmd` (the platform
 * shell, and the only dialect we can name without evidence).
 */
export function detectShellDialect(diagnostics: Diagnostics): ShellDialect | null {
	const bash = which('bash');
	if (bash !== null) {
		diagnostics.info(`T2 dialect: bash (${bash})`);
		return 'bash';
	}
	if (process.platform === 'win32') {
		diagnostics.info('T2 dialect: cmd (no bash on PATH, Windows platform shell)');
		return 'cmd';
	}
	diagnostics.warn('T2 disabled: no bash on PATH and no dialect this platform can name (D43)');
	return null;
}

function which(command: string): string | null {
	try {
		return Bun.which(command);
	} catch {
		return null;
	}
}

/**
 * The paths a `bash` call will change, or `null` for "skip this command entirely".
 *
 * `null` covers both refusal cases the Core's parser can produce — an unreliable reading, and a
 * reliable one that names nothing — and it is the only safe answer for either: attributing a command
 * we could not reduce to literal paths would let Reject hand back files the command never touched.
 */
export function bashTargets(
	command: string,
	dialect: ShellDialect | null,
	diagnostics: Diagnostics,
): { paths: string[] } | null {
	if (dialect === null) return null;
	const intent = parseCommandIntent(command, dialect);
	if (!intent.reliable) {
		diagnostics.info(`T2 skipped (unreliable in ${dialect}): ${oneLine(command)}`);
		return null;
	}
	if (intent.paths.length === 0) return null;
	return { paths: intent.paths };
}

function oneLine(text: string): string {
	const flattened = text.replace(/\s+/g, ' ').trim();
	return flattened.length > 120 ? `${flattened.slice(0, 117)}...` : flattened;
}
