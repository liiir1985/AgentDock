/**
 * The T1 classification table (D42): complete against the SDK's own tool list, and loud about a tool
 * it has never seen.
 */

import { describe, expect, test } from 'bun:test';

import {
	BUILTIN_TOOL_NAMES,
	HIDDEN_TOOL_NAMES,
} from '@oh-my-pi/pi-coding-agent/tools/builtin-names';

import {
	T1_EXACT_TOOLS,
	ToolCoverageError,
	assertToolTableComplete,
	builtinToolNames,
	checkSessionToolCoverage,
	classifyTool,
} from './toolClasses';

describe('the table covers what the SDK ships', () => {
	test('every built-in and hidden tool has a class', () => {
		expect(() => assertToolTableComplete(builtinToolNames())).not.toThrow();
		const unclassified = builtinToolNames().filter((name) => classifyTool(name) === undefined);
		expect(unclassified).toEqual([]);
	});

	test('a tool the table has never seen is reported, not defaulted', () => {
		// `apply_patch` is the concrete regression the plan names: a future SDK that promotes it to a
		// built-in must fail this check rather than write files nobody reviews.
		expect(() => assertToolTableComplete([...builtinToolNames(), 'apply_patch'])).toThrow(ToolCoverageError);
		try {
			assertToolTableComplete(['apply_patch']);
		} catch (error) {
			expect((error as ToolCoverageError).unclassified).toEqual(['apply_patch']);
		}
	});

	test('the T1 set is exactly the three file tools, and all three are built-ins', () => {
		expect([...T1_EXACT_TOOLS]).toEqual(['write', 'edit', 'ast_edit']);
		for (const tool of T1_EXACT_TOOLS) expect(BUILTIN_TOOL_NAMES).toContain(tool);
	});

	test('classes match the plan\u2019s table for the load-bearing entries', () => {
		expect(classifyTool('write')).toBe('T1_EXACT');
		expect(classifyTool('edit')).toBe('T1_EXACT');
		expect(classifyTool('ast_edit')).toBe('T1_EXACT');
		expect(classifyTool('bash')).toBe('T2_BEST_EFFORT');
		expect(classifyTool('lsp')).toBe('T3_NONE');
		expect(classifyTool('eval')).toBe('T3_NONE');
		expect(classifyTool('read')).toBe('READ_ONLY');
		expect(classifyTool('todo')).toBe('READ_ONLY');
		expect(HIDDEN_TOOL_NAMES.every((name) => classifyTool(name) === 'HIDDEN')).toBe(true);
	});

	test('legacy aliases normalize before lookup', () => {
		expect(classifyTool('search')).toBe('READ_ONLY');
		expect(classifyTool('find')).toBe('READ_ONLY');
	});
});

describe('the startup self-check over the session\u2019s own inventory', () => {
	test('a foreign tool is T3 and is named once', () => {
		const coverage = checkSessionToolCoverage([
			{ name: 'write', sourceInfo: { source: 'builtin' } },
			{ name: 'mcp__linear_create_issue', sourceInfo: { source: 'mcp' } },
		]);
		expect(coverage.classes.get('write')).toBe('T1_EXACT');
		expect(coverage.classes.get('mcp__linear_create_issue')).toBe('T3_NONE');
		expect(coverage.foreign).toEqual(['mcp__linear_create_issue']);
	});

	test('a built-in with no class fails the start and lists it', () => {
		expect(() => checkSessionToolCoverage([{ name: 'apply_patch', sourceInfo: { source: 'builtin' } }])).toThrow(
			/tool coverage incomplete: \[apply_patch\]/,
		);
	});

	test('the name list is a second opinion when source info is missing', () => {
		expect(() => checkSessionToolCoverage([{ name: 'ast_edit' }, { name: 'write' }])).not.toThrow();
	});
});
