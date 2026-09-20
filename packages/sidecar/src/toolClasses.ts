/**
 * The T1 classification table (D42).
 *
 * T1 is a hard contract: every built-in tool that can change a file has to be accounted for, because
 * an unaccounted one produces changes nobody can review and Reject cannot put back. The plan's M1
 * decision makes this a *table* rather than a set of wrapped tools — hooks see every tool, so the
 * question is no longer "did we wrap it" but "do we know what it does".
 *
 * Two checks enforce it:
 *  - `assertToolTableComplete` over the SDK's own `BUILTIN_TOOL_NAMES` + `HIDDEN_TOOL_NAMES`, run from
 *    the unit tests, catches a table that drifted behind the SDK;
 *  - `checkSessionToolCoverage` over `session.getAllToolInfos()` at startup, which catches a built-in
 *    tool that exists in this session but has no table entry. That is the "missing one is a failure"
 *    clause, mechanically.
 *
 * A tool the SDK does not ship (MCP server, extension, custom tool) is T3 by default and is logged
 * once by the caller: we cannot know what a foreign tool writes, and D42 forbids pretending.
 */

import {
	BUILTIN_TOOL_NAMES,
	HIDDEN_TOOL_NAMES,
	normalizeToolName,
} from '@oh-my-pi/pi-coding-agent/tools/builtin-names';

export type ToolClass =
	/** Snapshot before, compare after: exact attribution (D42 T1). */
	| 'T1_EXACT'
	/** Shell: the command line is parsed before execution and the answer may be "cannot tell". */
	| 'T2_BEST_EFFORT'
	/** Known not to be attributable (script/program products, or writes with no pre-image). */
	| 'T3_NONE'
	/** Cannot change a file. */
	| 'READ_ONLY'
	/** Never visible to the model as a tool call. */
	| 'HIDDEN';

/**
 * The T1 set — one constant, exported to the adapter, so the declaration and the interception can
 * never drift apart.
 *
 * `ast_edit` is T1 even though it never writes during its own call: it stages a preview that the
 * later `write xd://resolve` applies, and both halves are observed (see `intercept.ts`).
 */
export const T1_EXACT_TOOLS = ['write', 'edit', 'ast_edit'] as const;

const TABLE: Readonly<Record<string, ToolClass>> = {
	write: 'T1_EXACT',
	edit: 'T1_EXACT',
	ast_edit: 'T1_EXACT',
	bash: 'T2_BEST_EFFORT',

	read: 'READ_ONLY',
	ast_grep: 'READ_ONLY',
	ask: 'READ_ONLY',
	debug: 'READ_ONLY',
	github: 'READ_ONLY',
	glob: 'READ_ONLY',
	grep: 'READ_ONLY',
	security_scan: 'READ_ONLY',
	todo: 'READ_ONLY',
	web_search: 'READ_ONLY',

	// Not attributable: each one can write files (eval runs code, task spawns an agent, lsp renames
	// symbols, memory tools rewrite notes) but none of them hands us a target path before it runs, so
	// there is no pre-image to snapshot. `lsp` is the one we warn about at call time.
	eval: 'T3_NONE',
	task: 'T3_NONE',
	lsp: 'T3_NONE',
	checkpoint: 'T3_NONE',
	rewind: 'T3_NONE',
	context_notes: 'T3_NONE',
	new_context: 'T3_NONE',
	learn: 'T3_NONE',
	manage_skill: 'T3_NONE',
	memory_edit: 'T3_NONE',
	retain: 'T3_NONE',
	recall: 'T3_NONE',
	reflect: 'T3_NONE',
	hub: 'T3_NONE',

	yield: 'HIDDEN',
	goal: 'HIDDEN',
	think: 'HIDDEN',
};

export class ToolCoverageError extends Error {
	constructor(readonly unclassified: readonly string[]) {
		super(
			`tool coverage incomplete: [${unclassified.join(', ')}] — a built-in tool with no class may write files ` +
				'no review can attribute or reject (D42)',
		);
		this.name = 'ToolCoverageError';
	}
}

/** `undefined` means the name is not one we know: foreign tools land here, by design. */
export function classifyTool(name: string): ToolClass | undefined {
	return TABLE[normalizeToolName(name)];
}

/** Every name the SDK ships as a model-visible or hidden built-in tool. */
export function builtinToolNames(): string[] {
	return [...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES];
}

/** Throws when any of `names` has no class. Used by the tests and by the startup self-check. */
export function assertToolTableComplete(names: readonly string[]): void {
	const unclassified = [...new Set(names.map(normalizeToolName))].filter((name) => classifyTool(name) === undefined);
	if (unclassified.length > 0) throw new ToolCoverageError(unclassified);
}

/** The slice of a session `ToolInfo` this module needs. */
export interface ToolInfoLike {
	name: string;
	sourceInfo?: { source?: string };
}

export interface SessionToolCoverage {
	/** Every tool of this session, with the class we act on. */
	classes: Map<string, ToolClass>;
	/** Names the SDK does not ship: MCP servers, extensions, custom tools. All T3, logged once. */
	foreign: string[];
}

/**
 * The startup self-check: a built-in tool without a class fails the start.
 *
 * `sourceInfo.source === 'builtin'` is the authoritative signal (the SDK stamps `<builtin:name>`);
 * membership in the imported name list is the belt to that suspenders, so a session that reports a
 * name without source info still gets checked.
 */
export function checkSessionToolCoverage(infos: readonly ToolInfoLike[]): SessionToolCoverage {
	const classes = new Map<string, ToolClass>();
	const foreign: string[] = [];
	const unclassified: string[] = [];
	const builtin = new Set(builtinToolNames());

	for (const info of infos) {
		const name = normalizeToolName(info.name);
		const known = classifyTool(name);
		if (known !== undefined) {
			classes.set(name, known);
			continue;
		}
		if (builtin.has(name) || info.sourceInfo?.source === 'builtin') {
			unclassified.push(name);
			continue;
		}
		classes.set(name, 'T3_NONE');
		foreign.push(name);
	}

	if (unclassified.length > 0) throw new ToolCoverageError([...new Set(unclassified)]);
	return { classes, foreign };
}
