/**
 * Command-line intent (T2, D41 / D43): which workspace files a shell command will
 * write, and whether we are sure enough to act on that answer.
 *
 * The dialect is a required parameter rather than something sniffed from the text
 * (D43). `rm -rf build/out.js` is a write in bash and a foreign name in cmd, so a
 * parser that guessed would answer confidently about a shell the command will never
 * run in; only the adapter knows which shell it is about to invoke.
 */

import { parse as parseBash } from './bash';
import { parse as parseCmd } from './cmd';
import { parse as parsePowerShell } from './powershell';
import { UNRELIABLE_RESULT } from './common';

export type ShellDialect = 'bash' | 'powershell' | 'cmd';

/** What one command line will change, as far as a purely textual read can tell. */
export interface CommandIntent {
	/** Workspace-relative POSIX paths this command writes, in order of appearance. */
	paths: string[];
	/**
	 * `false` means the command can write something we cannot name: the caller must
	 * record nothing for it and let the file fall back to T1 attribution.
	 *
	 * An unreliable answer never carries paths — a half-trusted one would let Reject
	 * restore a file the command may never have touched, which is the one failure this
	 * module exists to prevent.
	 */
	reliable: boolean;
}

/**
 * The single answer for a command we could not reduce to literal paths. It is defined
 * next to the dialect parsers (`common.ts`) so they can return it without importing
 * this module, which would be a runtime cycle; it is frozen there, because a shared
 * mutable `paths` array would corrupt every later answer in the process.
 */
export const UNRELIABLE: CommandIntent = UNRELIABLE_RESULT;

/** Static dispatch: `Record<ShellDialect, …>` is what keeps the table exhaustive. */
const PARSERS: Record<ShellDialect, (command: string) => CommandIntent> = {
	bash: parseBash,
	powershell: parsePowerShell,
	cmd: parseCmd,
};

export function parseCommandIntent(command: string, dialect: ShellDialect): CommandIntent {
	return PARSERS[dialect](command);
}
