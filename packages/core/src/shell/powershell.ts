/**
 * PowerShell intent (T2, D41 / D43).
 *
 * PowerShell names the target with a *parameter* (`-Path`, `-Destination`,
 * `-FilePath`) rather than by position, so the parser reads parameters and only
 * falls back to operand positions where the parameters are irrelevant. Command and
 * parameter names are case-insensitive here, unlike bash.
 */

import type { CommandIntent } from './intent';
import { collectIntent, isVetoed, scanLine, UNRELIABLE_RESULT } from './common';

/** Parameters whose value names the file the command writes. */
const PATH_PARAMS: Record<string, true> = {
	'-path': true,
	'-literalpath': true,
	'-filepath': true,
};

/** Parameters whose value is content we never have to read. */
const IGNORED_VALUE_PARAMS: Record<string, true> = {
	'-value': true,
	'-inputobject': true,
	'-encoding': true,
};

/** Parameters that take a value, whichever of the tables they come from. */
const VALUE_PARAMS: Record<string, true> = {
	...PATH_PARAMS,
	...IGNORED_VALUE_PARAMS,
	'-destination': true,
	'-itemtype': true,
	'-name': true,
};

/**
 * Switches: present or absent, they are never followed by their value, so treating
 * one as value-taking would swallow the real target.
 */
const SWITCH_PARAMS: Record<string, true> = {
	'-force': true,
	'-recurse': true,
	'-whatif': true,
	'-nonewline': true,
	'-append': true,
	'-confirm': true,
};

const DESTINATION = '-destination';
const ITEM_TYPE = '-itemtype';
const NAME = '-name';

/** `Set-Content` / `Add-Content` / `Out-File` / `Tee-Object`. */
const CONTENT_PARAMS: Record<string, true> = {
	...PATH_PARAMS,
	...IGNORED_VALUE_PARAMS,
	'-force': true,
	'-nonewline': true,
	'-append': true,
	'-whatif': true,
	'-confirm': true,
};

/** `Remove-Item`. */
const REMOVE_PARAMS: Record<string, true> = {
	'-path': true,
	'-literalpath': true,
	'-recurse': true,
	'-force': true,
	'-whatif': true,
	'-confirm': true,
};

/** `Move-Item`. */
const MOVE_PARAMS: Record<string, true> = {
	'-path': true,
	'-literalpath': true,
	'-destination': true,
	'-force': true,
	'-whatif': true,
	'-confirm': true,
};

/** `Copy-Item`, which also recurses. */
const COPY_PARAMS: Record<string, true> = { ...MOVE_PARAMS, '-recurse': true };

/** `New-Item`. */
const NEW_PARAMS: Record<string, true> = {
	'-path': true,
	'-itemtype': true,
	'-name': true,
	'-value': true,
	'-force': true,
	'-whatif': true,
	'-confirm': true,
};

/**
 * One entry per writer, and the table doubles as the whitelist: a command that is
 * not a key cannot be attributed at all, and a parameter that is not a key of its
 * command's table is refused rather than skipped — `-Filter`, `-Credential` or a
 * splatted variable changes what the operands mean, and a parameter we guessed past
 * is a target we invented.
 */
const WRITERS: Record<string, Record<string, true>> = {
	'set-content': CONTENT_PARAMS,
	'add-content': CONTENT_PARAMS,
	'out-file': CONTENT_PARAMS,
	'tee-object': CONTENT_PARAMS,
	'remove-item': REMOVE_PARAMS,
	'move-item': MOVE_PARAMS,
	'copy-item': COPY_PARAMS,
	'new-item': NEW_PARAMS,
};

/** Read-only emitters. `>` is a shorthand for `Out-File`, so a redirection makes them writers. */
const EMITTERS: Record<string, true> = { 'get-content': true, 'write-output': true };

interface PowerShellArguments {
	/** Values of the path-naming parameters, in order of appearance. */
	paths: string[];
	/** The `-Destination` value, if the line carried one. */
	destination: string | null;
	/** The `-ItemType` value, if the line carried one. */
	itemType: string | null;
	/** The `-Name` value, if the line carried one. */
	name: string | null;
	/** Operands with no parameter attached, in order. */
	positional: string[];
}

/**
 * Splits arguments into parameter values and positional operands, or `null` when a
 * parameter is unknown or its value is missing.
 */
function splitArguments(args: readonly string[], allowed: Record<string, true>): PowerShellArguments | null {
	const result: PowerShellArguments = { paths: [], destination: null, itemType: null, name: null, positional: [] };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.length < 2 || !arg.startsWith('-')) {
			result.positional.push(arg);
			continue;
		}
		// `-Path:src/x.txt` binds its value with a colon; only the space-separated
		// form is read here, so the colon form is refused instead of mis-split.
		if (arg.includes(':')) return null;
		const param = arg.toLowerCase();
		if (allowed[param] !== true) return null;
		if (SWITCH_PARAMS[param] === true) continue;
		if (VALUE_PARAMS[param] !== true) return null;
		const value = i + 1 < args.length ? args[i + 1] : null;
		if (value === null) return null;
		i++;
		if (PATH_PARAMS[param] === true) result.paths.push(value);
		else if (param === DESTINATION) result.destination = value;
		else if (param === ITEM_TYPE) result.itemType = value;
		else if (param === NAME) result.name = value;
		// Any other value parameter is content, never a target.
	}
	return result;
}

/** `-Name` is relative to `-Path`, so the two are one target: `-Path src -Name x.txt`. */
function joinTarget(path: string, name: string): string {
	return path.endsWith('/') || path.endsWith('\\') ? path + name : `${path}/${name}`;
}

/** The paths one writer touches, or `null` when its parameters cannot be trusted. */
function writerTargets(name: string, args: PowerShellArguments): string[] | null {
	switch (name) {
		case 'set-content':
		case 'add-content':
		case 'out-file':
		case 'tee-object': {
			// With a path parameter that value is the target: `-Value` was consumed by
			// its own parameter, so a leftover operand can only be the path.
			if (args.paths.length > 0) return args.paths;
			return args.positional.length > 0 ? [args.positional[0]] : null;
		}
		case 'remove-item': {
			// Remove-Item takes paths both ways, and each one is a separate file.
			const targets = args.paths.concat(args.positional);
			return targets.length > 0 ? targets : null;
		}
		case 'move-item': {
			const source = args.paths.length > 0 ? args.paths[0] : (args.positional.length > 0 ? args.positional[0] : null);
			return source !== null && args.destination !== null ? [source, args.destination] : null;
		}
		case 'copy-item': {
			// Only the destination changes; the source is read.
			if (args.destination !== null) return [args.destination];
			return args.positional.length >= 2 ? [args.positional[1]] : null;
		}
		case 'new-item': {
			// Without `-ItemType File` this may create a directory, a registry key or a
			// symbolic link — none of which is a file change a reviewer can act on.
			if (args.itemType === null || args.itemType.toLowerCase() !== 'file') return null;
			const path = args.paths.length > 0 ? args.paths[0] : null;
			if (path !== null && args.name !== null) return [joinTarget(path, args.name)];
			if (path !== null) return [path];
			if (args.name !== null) return [args.name];
			return null;
		}
	}
	return null;
}

export function parse(command: string): CommandIntent {
	const scanned = scanLine(command);
	if (scanned === null) return UNRELIABLE_RESULT;
	if (isVetoed(command, 'powershell', scanned.words)) return UNRELIABLE_RESULT;
	if (scanned.words.length === 0) return UNRELIABLE_RESULT;
	// PowerShell command names are case-insensitive, so `set-content` and
	// `Set-Content` are the same cmdlet.
	const name = scanned.words[0].toLowerCase();
	if (EMITTERS[name] === true) {
		return scanned.hasWriteRedirect ? collectIntent(scanned.writes, 'powershell') : UNRELIABLE_RESULT;
	}
	const allowed = Object.hasOwn(WRITERS, name) ? WRITERS[name] : null;
	if (allowed === null) return UNRELIABLE_RESULT;
	const args = splitArguments(scanned.words.slice(1), allowed);
	if (args === null) return UNRELIABLE_RESULT;
	const targets = writerTargets(name, args);
	if (targets === null) return UNRELIABLE_RESULT;
	return collectIntent(targets.concat(scanned.writes), 'powershell');
}
