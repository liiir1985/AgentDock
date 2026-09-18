/**
 * cmd.exe intent (T2, D41 / D43).
 *
 * cmd binds no parameters: the operands are the files and an option is simply a
 * token that starts with `/`. Command names are case-insensitive. Two cmd-only
 * hazards never reach this file — `%VAR%` and `!VAR!` expansion rewrite the line
 * before a parser could see what it says — so the shared vetoes refuse them first.
 */

import type { CommandIntent } from './intent';
import { collectIntent, isVetoed, scanLine, UNRELIABLE_RESULT } from './common';

/** Commands whose operands name what the line writes. */
const WRITERS: Record<string, true> = {
	del: true,
	erase: true,
	move: true,
	ren: true,
	rename: true,
	copy: true,
};

/**
 * Commands that only read. Usable only with a write redirection, and then their
 * operands are inputs: `type src\in.txt > src\out.txt` writes exactly one file.
 */
const EMITTERS: Record<string, true> = { echo: true, type: true };

/**
 * Directory commands. `md src\newdir` creates no *file* change, so answering with a
 * path would have Reject write back a baseline that was never a file — and `rd` is
 * the mirror image, deleting a path that a reviewer never sees as a file.
 */
const DIRECTORY_COMMANDS: Record<string, true> = { md: true, mkdir: true, rd: true, rmdir: true };

/**
 * The switches `del`/`erase` define, spelled as cmd spells them (`/-y` is the
 * documented negation of `/y`). No other writer has a switch we know, so any `/x`
 * operand makes it unreliable.
 */
const DEL_SWITCHES: Record<string, true> = {
	'/f': true,
	'/q': true,
	'/s': true,
	'/p': true,
	'/a': true,
	'/y': true,
	'/-y': true,
};
const NO_SWITCHES: Record<string, true> = {};

/**
 * Splits a writer's arguments into operands, or `null` when a `/`-prefixed token is
 * not one of the listed switches.
 *
 * A leading `/` marks a switch only when the token matches `/[A-Za-z?]+`; anything
 * else (`/s\q`, `/a:b`, `/-y` in a command that does not define it) is a rooted path
 * or an option we cannot read, and both leave the target unknown. Guessing the other
 * way is worse: treating `/y` as a name would put a file called `y` in the ChangeSet.
 */
function operandsOnly(args: readonly string[], switches: Record<string, true>): string[] | null {
	const operands: string[] = [];
	for (const arg of args) {
		if (arg.startsWith('/')) {
			if (switches[arg.toLowerCase()] !== true) return null;
			continue;
		}
		operands.push(arg);
	}
	return operands;
}

/** The paths one writer touches, or `null` when its operands cannot be trusted. */
function writerTargets(name: string, args: readonly string[], switches: Record<string, true>): string[] | null {
	const operands = operandsOnly(args, switches);
	if (operands === null || operands.length === 0) return null;
	switch (name) {
		case 'del':
		case 'erase':
		case 'move':
		case 'ren':
		case 'rename':
			// Every operand changes: `move`/`ren` remove the source as much as they
			// create the destination, and a rejected delete has to come back.
			return operands;
		case 'copy':
			// Only the destination is written; the source is read.
			return [operands[operands.length - 1]];
	}
	return null;
}

export function parse(command: string): CommandIntent {
	const scanned = scanLine(command);
	if (scanned === null) return UNRELIABLE_RESULT;
	if (isVetoed(command, 'cmd', scanned.words)) return UNRELIABLE_RESULT;
	if (scanned.words.length === 0) return UNRELIABLE_RESULT;
	// cmd command names are case-insensitive.
	const name = scanned.words[0].toLowerCase();
	if (DIRECTORY_COMMANDS[name] === true) return UNRELIABLE_RESULT;
	if (EMITTERS[name] === true) {
		return scanned.hasWriteRedirect ? collectIntent(scanned.writes, 'cmd') : UNRELIABLE_RESULT;
	}
	if (WRITERS[name] !== true) return UNRELIABLE_RESULT;
	const switches = name === 'del' || name === 'erase' ? DEL_SWITCHES : NO_SWITCHES;
	const targets = writerTargets(name, scanned.words.slice(1), switches);
	if (targets === null) return UNRELIABLE_RESULT;
	return collectIntent(targets.concat(scanned.writes), 'cmd');
}
