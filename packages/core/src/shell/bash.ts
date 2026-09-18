/**
 * bash / POSIX-shell intent (T2, D41).
 *
 * Only writers whose operand list *is* the write set are parsed: for `rm`, `mv`,
 * `cp`, `touch`, `tee` and `sed -i` the file the command touches is an operand, so a
 * literal operand list is enough. Everything else — the shell language itself,
 * `find -exec`, a script, a compiler — can write files that never appear in the line
 * and is refused by the shared vetoes.
 */

import type { CommandIntent } from './intent';
import { collectIntent, isVetoed, scanLine, UNRELIABLE_RESULT } from './common';

/** Commands whose operands name what the line writes. */
const WRITERS: Record<string, true> = {
	rm: true,
	mv: true,
	cp: true,
	touch: true,
	tee: true,
	sed: true,
};

/**
 * Commands that only read. They are parsable only when the line redirects output,
 * which is exactly the case where `cat a > b` becomes a write — and their operands
 * are then inputs, never paths: `cat header.txt > src/bundle.ts` writes one file.
 */
const EMITTERS: Record<string, true> = { cat: true, echo: true, printf: true };

/**
 * Short flags per command, one letter each. A combined group must be listed letter
 * by letter (`rm -rf`), and a flag outside the list is refused rather than ignored:
 * `cp -t dir` turns its first operand into a destination, and `rm -d` refuses to
 * remove a non-empty directory — guessing past them would attribute the wrong file.
 */
const RM_FLAGS = 'rRfivd';
const TEE_FLAGS = 'aip';
/** `-i` is deliberately absent: it settles whether `sed` writes at all, and may carry a suffix. */
const SED_FLAGS = 'nErsuz';
/** `mv`, `cp` and `touch` have no switch we know, so any `-x` operand makes them unreliable. */
const NO_FLAGS = '';

/** Collects the operands of a command whose switches are plain short flags. */
function flagOperands(args: readonly string[], allowedFlags: string): string[] | null {
	const operands: string[] = [];
	for (const arg of args) {
		if (arg.startsWith('-')) {
			if (arg.length < 2) return null;
			for (const flag of arg.slice(1)) {
				if (!allowedFlags.includes(flag)) return null;
			}
			continue;
		}
		operands.push(arg);
	}
	return operands.length > 0 ? operands : null;
}

/** Classifies one `sed` switch; `unknown` covers an explicit refusal (`-f`) and a typo alike. */
function sedSwitch(arg: string): 'flag' | 'in-place' | 'script-option' | 'unknown' {
	const body = arg.slice(1);
	if (body.length === 0) return 'unknown';
	// `-i`, `-i.bak`: everything after a leading `-i` is the backup suffix, so a
	// combined `-ni.bak` is refused rather than guessed at.
	if (body[0] === 'i') return 'in-place';
	let scriptOption = false;
	for (const flag of body) {
		if (flag === 'e') scriptOption = true;
		else if (!SED_FLAGS.includes(flag)) return 'unknown';
	}
	return scriptOption ? 'script-option' : 'flag';
}

/**
 * `sed` writes only with `-i` (optionally `-i<suffix>`); without it the script text
 * goes to stdout and no file changes. The script is never a path, so it is dropped —
 * treating `s/a/b/` as a target would put a file that does not exist into the
 * ChangeSet.
 */
function sedTargets(args: readonly string[]): string[] | null {
	let inPlace = false;
	let scriptGiven = false;
	let scriptPending = false;
	const operands: string[] = [];
	for (const arg of args) {
		if (scriptPending) {
			scriptPending = false;
			continue;
		}
		if (arg.startsWith('-')) {
			const kind = sedSwitch(arg);
			if (kind === 'unknown') return null;
			if (kind === 'in-place') inPlace = true;
			if (kind === 'script-option') {
				scriptGiven = true;
				scriptPending = true;
			}
			continue;
		}
		operands.push(arg);
	}
	if (!inPlace || scriptPending) return null;
	// Without `-e` the first operand is the script and only the rest are files.
	const files = scriptGiven ? operands : operands.slice(1);
	return files.length > 0 ? files : null;
}

/** The paths one writer touches, or `null` when its operand list cannot be trusted. */
function writerTargets(name: string, args: readonly string[]): string[] | null {
	switch (name) {
		case 'rm':
			return flagOperands(args, RM_FLAGS);
		case 'touch':
			return flagOperands(args, NO_FLAGS);
		case 'tee':
			return flagOperands(args, TEE_FLAGS);
		case 'mv': {
			// Both operands change: the source disappears and the destination appears.
			const operands = flagOperands(args, NO_FLAGS);
			return operands !== null && operands.length === 2 ? operands : null;
		}
		case 'cp': {
			const operands = flagOperands(args, NO_FLAGS);
			return operands !== null && operands.length === 2 ? [operands[1]] : null;
		}
		case 'sed':
			return sedTargets(args);
	}
	return null;
}

export function parse(command: string): CommandIntent {
	const scanned = scanLine(command);
	if (scanned === null) return UNRELIABLE_RESULT;
	if (isVetoed(command, 'bash', scanned.words)) return UNRELIABLE_RESULT;
	if (scanned.words.length === 0) return UNRELIABLE_RESULT;
	// bash command names are case-sensitive: `RM` is a different program.
	const name = scanned.words[0];
	if (EMITTERS[name] === true) {
		return scanned.hasWriteRedirect ? collectIntent(scanned.writes, 'bash') : UNRELIABLE_RESULT;
	}
	if (WRITERS[name] !== true) return UNRELIABLE_RESULT;
	const targets = writerTargets(name, scanned.words.slice(1));
	if (targets === null) return UNRELIABLE_RESULT;
	// Redirect targets come last: the operands name what the command writes and the
	// redirection names what the shell writes, and `rm a > log` is both.
	return collectIntent(targets.concat(scanned.writes), 'bash');
}
