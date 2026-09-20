/**
 * The interception script: a tool call and its result, driven exactly the way the SDK drives them.
 *
 * The cases that matter are the ones where the naive implementation is wrong: `ast_edit` never writes
 * during its own call, `write xd://resolve` is the write that actually happens, a staged layer can be
 * discarded, and a shell command we cannot read names nothing at all.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { AdapterEvent } from '@agentdock/core';

import { InterceptHooks, createInterceptExtension } from './intercept';
import type { Diagnostics } from './protocol';

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(path.join(tmpdir(), 'agentdock-intercept-'));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

interface Harness {
	hooks: InterceptHooks;
	events: AdapterEvent[];
	warnings: string[];
	notes: string[];
	call(toolName: string, toolCallId: string, input: Record<string, unknown>): void;
	result(toolName: string, toolCallId: string, input: Record<string, unknown>, details?: unknown, isError?: boolean): void;
}

function harness(dialect: 'bash' | 'cmd' | null = 'bash'): Harness {
	const events: AdapterEvent[] = [];
	const warnings: string[] = [];
	const notes: string[] = [];
	const diagnostics: Diagnostics = {
		info: (message) => notes.push(message),
		warn: (message) => warnings.push(message),
		error: (message) => warnings.push(message),
	};
	const hooks = new InterceptHooks({
		cwd,
		dialect,
		diagnostics,
		sink: (event) => events.push(event),
	});
	return {
		hooks,
		events,
		warnings,
		notes,
		call: (toolName, toolCallId, input) => hooks.onToolCall({ toolName, toolCallId, input }),
		result: (toolName, toolCallId, input, details, isError) =>
			hooks.onToolResult({ toolName, toolCallId, input, details, isError }),
	};
}

function write(relative: string, text: string): string {
	const absolute = path.join(cwd, relative);
	mkdirSync(path.dirname(absolute), { recursive: true });
	writeFileSync(absolute, text, 'utf8');
	return absolute;
}

function fileWrites(harnessed: Harness): Extract<AdapterEvent, { type: 'file-write' }>[] {
	return harnessed.events.filter(
		(event): event is Extract<AdapterEvent, { type: 'file-write' }> => event.type === 'file-write',
	);
}

describe('T1: write and edit', () => {
	test('a created file is a create with no old side', () => {
		const h = harness();
		h.call('write', 'c1', { path: 'src/new.ts', content: 'fresh\n' });
		write('src/new.ts', 'fresh\n');
		h.result('write', 'c1', { path: 'src/new.ts', content: 'fresh\n' });

		const writes = fileWrites(h);
		expect(writes.length).toBe(1);
		expect(writes[0].write.path).toBe('src/new.ts');
		expect(writes[0].write.kind).toBe('create');
		expect(writes[0].write.before).toBeNull();
		expect(writes[0].write.attribution).toEqual({ tier: 'T1', source: 'write', level: 'own' });
	});

	test('a rewritten file is a modify carrying both sides', () => {
		write('src/a.ts', 'a\nb\n');
		const h = harness();
		h.call('write', 'c2', { path: 'src/a.ts' });
		write('src/a.ts', 'a\nB\n');
		h.result('write', 'c2', { path: 'src/a.ts' });

		const writes = fileWrites(h);
		expect(writes[0].write.kind).toBe('modify');
		expect(writes[0].write.attribution.source).toBe('write');
	});

	test('an edit is attributed to the edit, not to write', () => {
		write('src/a.ts', 'a\nb\n');
		const h = harness();
		h.call('edit', 'c3', { path: 'src/a.ts', edits: [{ diff: '@@' }] });
		write('src/a.ts', 'a\nB\n');
		h.result('edit', 'c3', { path: 'src/a.ts' }, { diff: '@@' });

		expect(fileWrites(h)[0].write.attribution).toEqual({ tier: 'T1', source: 'edit', level: 'own' });
	});

	test('a device write to xd://reject is not a file change of its own', () => {
		const h = harness();
		h.call('write', 'c4', { path: 'xd://reject', content: 'no' });
		h.result('write', 'c4', { path: 'xd://reject', content: 'no' });
		expect(fileWrites(h)).toEqual([]);
	});

	test('an edit that changed nothing produces no event', () => {
		write('src/a.ts', 'a\nb\n');
		const h = harness();
		h.call('edit', 'c5', { path: 'src/a.ts', edits: [] });
		h.result('edit', 'c5', { path: 'src/a.ts', edits: [] });
		expect(fileWrites(h)).toEqual([]);
	});

	test('a path only the result names is reported as unattributed', () => {
		write('src/input.ts', 'a\n');
		write('src/extra.ts', 'b\n');
		const h = harness();
		h.call('edit', 'c6', { path: 'src/input.ts' });
		write('src/input.ts', 'A\n');
		h.result('edit', 'c6', { path: 'src/input.ts' }, { perFileResults: [{ path: 'src/extra.ts' }] });

		expect(fileWrites(h).map((event) => event.write.path)).toEqual(['src/input.ts']);
		expect(h.warnings.join('\n')).toContain('unattributed path src/extra.ts (no pre-image)');
	});
});

describe('T1: the staged ast_edit path', () => {
	test('the preview takes the pre-image and the resolve produces the change', () => {
		write('src/a.ts', 'const x = 1;\n');
		const h = harness();
		h.call('ast_edit', 'e1', { rewrites: { 'a': 'b' }, paths: ['src/a.ts'] });
		h.result('ast_edit', 'e1', { rewrites: {} }, { applied: false, files: ['src/a.ts'] });

		// Still untouched at this point: the resolve below is what moves the bytes.
		write('src/a.ts', 'const x = 2;\n');
		h.call('write', 'e2', { path: 'xd://resolve', content: 'apply the AST rewrite' });
		h.result('write', 'e2', { path: 'xd://resolve', content: 'apply the AST rewrite' }, { xdev: {} });

		const writes = fileWrites(h);
		expect(writes.length).toBe(1);
		expect(writes[0].write.path).toBe('src/a.ts');
		expect(writes[0].write.attribution).toEqual({ tier: 'T1', source: 'ast_edit', level: 'own' });
	});

	test('a resolve that changed nothing produces nothing (the layer may be consumed our way)', () => {
		write('src/a.ts', 'const x = 1;\n');
		const h = harness();
		h.call('ast_edit', 'e3', {});
		h.result('ast_edit', 'e3', {}, { applied: false, files: ['src/a.ts'] });
		h.call('write', 'e4', { path: 'xd://resolve' });
		h.result('write', 'e4', { path: 'xd://resolve' });
		expect(fileWrites(h)).toEqual([]);
	});

	test('xd://reject discards the layer instead of attributing it', () => {
		write('src/a.ts', 'const x = 1;\n');
		const h = harness();
		h.call('ast_edit', 'e5', {});
		h.result('ast_edit', 'e5', {}, { applied: false, files: ['src/a.ts'] });
		write('src/a.ts', 'const x = 2;\n');
		h.call('write', 'e6', { path: 'xd://reject' });
		h.result('write', 'e6', { path: 'xd://reject' });

		// A later resolve has nothing left to apply, so it must not invent a change either.
		h.call('write', 'e7', { path: 'xd://resolve' });
		h.result('write', 'e7', { path: 'xd://resolve' });
		expect(fileWrites(h)).toEqual([]);
	});

	test('a failed resolve keeps the layer, because OMP still holds the staged action', () => {
		write('src/a.ts', 'const x = 1;\n');
		const h = harness();
		h.call('ast_edit', 'e8', {});
		h.result('ast_edit', 'e8', {}, { applied: false, files: ['src/a.ts'] });
		write('src/a.ts', 'const x = 2;\n');
		h.call('write', 'e9', { path: 'xd://resolve' });
		h.result('write', 'e9', { path: 'xd://resolve' }, undefined, true);
		expect(fileWrites(h)).toEqual([]);

		h.call('write', 'e10', { path: 'xd://resolve' });
		h.result('write', 'e10', { path: 'xd://resolve' });
		expect(fileWrites(h).map((event) => event.write.path)).toEqual(['src/a.ts']);
	});

	test('an ast_edit applied without a preview is admitted, not guessed at', () => {
		write('src/a.ts', 'a\n');
		const h = harness();
		h.call('ast_edit', 'e11', {});
		h.result('ast_edit', 'e11', {}, { applied: true, files: ['src/a.ts'] });
		expect(fileWrites(h)).toEqual([]);
		expect(h.warnings.join('\n')).toContain('no pre-image');
	});
});

describe('T2: shell', () => {
	test('a readable command attributes the path it writes', () => {
		const h = harness('bash');
		h.call('bash', 'b1', { command: 'echo hi > src/gen.ts' });
		write('src/gen.ts', 'hi\n');
		h.result('bash', 'b1', { command: 'echo hi > src/gen.ts' });

		const writes = fileWrites(h);
		expect(writes[0].write.path).toBe('src/gen.ts');
		expect(writes[0].write.kind).toBe('create');
		expect(writes[0].write.attribution).toEqual({
			tier: 'T2',
			source: 'echo hi > src/gen.ts',
			level: 'async-signal',
		});
	});

	test('an unreadable command is skipped whole, and nothing is attributed', () => {
		const h = harness('bash');
		h.call('bash', 'b2', { command: 'npm run build' });
		write('dist/out.js', 'built\n');
		h.result('bash', 'b2', { command: 'npm run build' });

		expect(fileWrites(h)).toEqual([]);
		expect(h.notes.join('\n')).toContain('unreliable');
	});

	test('an unknown dialect disables T2 rather than guessing', () => {
		const h = harness(null);
		h.call('bash', 'b3', { command: 'echo hi > src/gen.ts' });
		write('src/gen.ts', 'hi\n');
		h.result('bash', 'b3', { command: 'echo hi > src/gen.ts' });
		expect(fileWrites(h)).toEqual([]);
	});
});

describe('turns and hooks', () => {
	test('an unmatched result is not a change, and resetPending drops the rest', () => {
		const h = harness();
		h.result('write', 'never-called', { path: 'src/a.ts' });
		expect(fileWrites(h)).toEqual([]);

		write('src/a.ts', 'a\n');
		h.call('write', 'c7', { path: 'src/a.ts' });
		h.hooks.resetPending();
		write('src/a.ts', 'A\n');
		h.result('write', 'c7', { path: 'src/a.ts' });
		expect(fileWrites(h)).toEqual([]);
	});

	test('the factory registers both hooks on the pi object the SDK hands it', () => {
		write('src/a.ts', 'a\n');
		const registered = new Map<string, (payload: unknown) => unknown>();
		const pi = {
			on: (event: string, handler: (payload: unknown) => unknown) => {
				registered.set(event, handler);
			},
		};
		const events: AdapterEvent[] = [];
		const wired = createInterceptExtension({
			cwd,
			dialect: 'bash',
			diagnostics: { info: () => undefined, warn: () => undefined, error: () => undefined },
			sink: (event) => events.push(event),
		});
		(wired.factory as (api: unknown) => void)(pi);
		expect([...registered.keys()].sort()).toEqual(['tool_call', 'tool_result']);

		// Returning `undefined` is the contract: the hooks observe, they never block or rewrite (D44).
		expect(registered.get('tool_call')?.({ toolName: 'write', toolCallId: 'w1', input: { path: 'src/a.ts' } })).toBeUndefined();
		write('src/a.ts', 'A\n');
		expect(registered.get('tool_result')?.({ toolName: 'write', toolCallId: 'w1', input: { path: 'src/a.ts' } })).toBeUndefined();
		expect(events.map((event) => event.type)).toEqual(['file-write']);
	});
});
