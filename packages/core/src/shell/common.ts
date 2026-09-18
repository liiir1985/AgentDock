/**
 * Primitives shared by the three dialect parsers (T2, D41 / D43).
 *
 * The T2 answer decides whether a shell command gets a ChangeSet entry at all, and
 * a wrong entry is worse than a missing one: Reject restores the *baseline* stored
 * for every path it was told about, so a path we invented means writing back a file
 * the agent never touched. Everything here therefore fails closed — an unrecognised
 * construct answers `UNRELIABLE`, never a best guess.
 */

import type { CommandIntent, ShellDialect } from './intent';
import { isDeviceTarget } from './devices';

/**
 * The shared empty path list, frozen on its own because `Object.freeze` is shallow —
 * freezing only the answer below would leave `paths` pushable.
 */
const NO_PATHS: string[] = [];
Object.freeze(NO_PATHS);

/**
 * The one "cannot attribute" answer, defined here so the dialect parsers can return
 * it without importing `intent.ts` (that import would be a runtime cycle).
 *
 * Frozen on purpose: it is handed out to every caller, and a caller that pushed
 * onto `paths` would silently corrupt every later answer in the process.
 */
export const UNRELIABLE_RESULT: CommandIntent = Object.freeze({ paths: NO_PATHS, reliable: false });

/**
 * Text that vetoes the whole line. Checked against the raw command before it is
 * tokenised, so no quoting style can hide it — `rm a "&&" rm b` still runs two
 * commands, and a quoted `*` is still a glob the moment it leaves our hands.
 */
const VETO_TEXT: readonly string[] = [
	// A second command, a pipeline or a background job: we only see the first one.
	'\n', '\r', '&', '|', ';',
	// A subshell or a command group, whose contents we would have to parse as a shell.
	'(', ')', '{', '}',
	// Expansions: what the shell substitutes is not in the text we were handed.
	// `$` counts in bash too — `sed -i "$F" x.ts` writes a path only known at run
	// time — which also refuses a literal `$` such as a sed end-of-line anchor. A
	// command we skip costs coverage; a command we mis-read costs correctness.
	'`', '$',
	// A heredoc/herestring body is a second input we never see.
	'<<',
	// Switches, long options and assignments all change what the neighbouring token means.
	'~', '--', '=',
	// Globs: the target is decided by the directory listing, not by the text.
	'*', '?', '[',
];

/**
 * cmd only: `%VAR%` is expanded while the line is parsed and `!VAR!` when delayed
 * expansion runs, so the literal path is not what the caller wrote.
 */
const CMD_VETO_TEXT: readonly string[] = ['%', '!'];

/**
 * Names that mean "something else decides what is written": shell keywords
 * (`for`, `if`), nested interpreters (`bash`, `node`, `python`) and build or VCS
 * entry points (`make`, `npm`, `git`) can each write files nothing in this line
 * names.
 *
 * Matched per token, never as a substring: `patches/` contains `patch` and a file
 * called `Dockerfile` contains `do`. bash matches case-sensitively, PowerShell and
 * cmd case-insensitively (see the lookup in `isVetoed`).
 */
const VETO_NAMES: Record<string, true> = {
	for: true,
	if: true,
	foreach: true,
	while: true,
	do: true,
	call: true,
	start: true,
	'invoke-expression': true,
	iex: true,
	bash: true,
	sh: true,
	zsh: true,
	powershell: true,
	pwsh: true,
	cmd: true,
	wsl: true,
	node: true,
	python: true,
	bun: true,
	deno: true,
	dotnet: true,
	msbuild: true,
	cmake: true,
	make: true,
	npm: true,
	pnpm: true,
	yarn: true,
	git: true,
	patch: true,
};

/** `true` when the line contains any construct we cannot reduce to literal paths. */
export function isVetoed(command: string, dialect: ShellDialect, words: readonly string[]): boolean {
	for (const text of VETO_TEXT) {
		if (command.includes(text)) return true;
	}
	if (dialect === 'cmd') {
		for (const text of CMD_VETO_TEXT) {
			if (command.includes(text)) return true;
		}
	}
	for (const word of words) {
		if (VETO_NAMES[dialect === 'bash' ? word : word.toLowerCase()] === true) return true;
	}
	return false;
}

/** A line reduced to what the parsers need: its words and its output redirections. */
export interface ScannedLine {
	/** Word tokens with their quotes removed; operators and their targets are not here. */
	words: string[];
	/** Literal targets of `>` / `>>` and their fd-prefixed forms, in order of appearance. */
	writes: string[];
	/** Redirecting output is what licenses a read-only emitter such as `cat`. */
	hasWriteRedirect: boolean;
}

/**
 * Reads the whitespace-delimited word starting at `start`, honouring quotes, and
 * reports where it stopped. `null` for an empty word or an unterminated quote —
 * both mean we cannot say what the target is.
 */
function readWord(command: string, start: number): { text: string; next: number } | null {
	let text = '';
	let i = start;
	while (i < command.length && (command[i] === ' ' || command[i] === '\t')) i++;
	while (i < command.length) {
		const char = command[i];
		if (char === ' ' || char === '\t') break;
		if (char === "'" || char === '"') {
			const end = command.indexOf(char, i + 1);
			if (end === -1) return null;
			text += command.slice(i + 1, end);
			i = end + 1;
			continue;
		}
		text += char;
		i++;
	}
	return text === '' ? null : { text, next: i };
}

/**
 * Splits a command into words plus the targets of its output redirections.
 *
 * Redirections are extracted before the command name is decided (D41): `cat a > b`
 * writes even though `cat` cannot, and `> b cat a` is caught because `>` is then
 * the first token and no whitelisted name precedes it.
 *
 * `null` means the line cannot be tokenised at all — an unterminated quote, or a
 * redirection with no target — which is `UNRELIABLE` like any other unknown.
 */
export function scanLine(command: string): ScannedLine | null {
	const words: string[] = [];
	const writes: string[] = [];
	let hasWriteRedirect = false;
	let word = '';
	let i = 0;
	while (i < command.length) {
		const char = command[i];
		if (char === ' ' || char === '\t') {
			if (word !== '') words.push(word);
			word = '';
			i++;
			continue;
		}
		if (char === "'" || char === '"') {
			const end = command.indexOf(char, i + 1);
			if (end === -1) return null;
			word += command.slice(i + 1, end);
			i = end + 1;
			continue;
		}
		if (char === '>' || char === '<') {
			const write = char === '>';
			// `1>`, `2>>`, `2<`: a lone file-descriptor digit directly before the
			// operator is part of it, not an operand — but a file genuinely named
			// `2` is still a word, which is why only `0`..`2` are consumed.
			if (word !== '' && !/^[0-2]$/.test(word)) words.push(word);
			word = '';
			i++;
			if (write && command[i] === '>') i++;
			const target = readWord(command, i);
			if (target === null) return null;
			if (write) {
				writes.push(target.text);
				hasWriteRedirect = true;
			}
			// `<` and `2<` name an input: it is never a path this command writes, so
			// the target is dropped along with the operator.
			i = target.next;
			continue;
		}
		word += char;
		i++;
	}
	if (word !== '') words.push(word);
	return { words, writes, hasWriteRedirect };
}

/**
 * A candidate token as a workspace-relative POSIX path, or `null` when the line
 * cannot be attributed from it.
 *
 * Every rejection protects the same thing — Reject writes `paths` back to their
 * baselines — so a target that may point outside the workspace (`/etc/x`, `C:\x`,
 * `../x`) must never reach the caller. bash is stricter still: there a `\` is an
 * escape, so `a\ b` is one file called `a b` and we cannot know its name.
 */
export function targetPath(token: string, dialect: ShellDialect): string | null {
	// bash reads `\` as an escape, so the token is not a literal name at all.
	if (dialect === 'bash' && token.includes('\\')) return null;
	const path = dialect === 'bash' ? token : token.replaceAll('\\', '/');
	if (path.length === 0) return null;
	// A target that still holds an operator is two tokens we failed to split.
	if (path.includes('>') || path.includes('<')) return null;
	if (path.startsWith('/')) return null;
	if (/^[A-Za-z]:/.test(path)) return null;
	for (const segment of path.split('/')) {
		if (segment === '..') return null;
	}
	return path;
}

/**
 * Validates the candidate targets and builds the answer.
 *
 * A device target is dropped silently — a write to `nul` is not a file change — but
 * a write set that is empty *because* every candidate was a device is `UNRELIABLE`.
 * Answering "reliable, no paths" there would tell the caller the command is harmless
 * when what actually happened is that we could not name what it touches.
 *
 * Duplicates are removed in order of appearance: `mv a a` names one file, and a
 * ChangeSet is keyed by path.
 */
export function collectIntent(candidates: readonly string[], dialect: ShellDialect): CommandIntent {
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (isDeviceTarget(candidate)) continue;
		const path = targetPath(candidate, dialect);
		if (path === null) return UNRELIABLE_RESULT;
		if (seen.has(path)) continue;
		seen.add(path);
		paths.push(path);
	}
	if (paths.length === 0) return UNRELIABLE_RESULT;
	return { paths, reliable: true };
}
