/**
 * A scripted sidecar, for the integration suite only (plan G.1).
 *
 * It speaks the same NDJSON protocol as `packages/sidecar/src/main.ts` and performs *real* file writes,
 * so the extension side is exercised end to end — protocol, ledger, reconcile, WorkspaceEdit, save —
 * with no model and no SDK in the loop. The `file-write` events it sends are byte-exact: the `before`
 * text is whatever the file held when the script started, read the same way the real sidecar reads it
 * (`splitLines`, terminators and all).
 *
 * Run by Bun, not compiled: `bun test/fixtures/stub-sidecar.ts --workspace-root <dir>`, with
 * `AGENTDOCK_STUB_SCRIPT` selecting the scenario (S1 / S2).
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { type TextLines, splitLines } from '@agentdock/core';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--workspace-root');
const workspaceRoot = rootIndex >= 0 ? (args[rootIndex + 1] ?? process.cwd()) : process.cwd();
const script = process.env.AGENTDOCK_STUB_SCRIPT ?? 'S1';

/** The adapter's own declaration (`packages/sidecar/src/adapter.ts`), which the extension reads. */
const CAPABILITIES = {
	session: { resume: false, list: false, branch: false, revert: false },
	permission: { request: true },
	diff: { declared: true },
	write: { intercept: 'own' },
	config: { options: false },
	mcp: { injection: false },
	capability: { transport: 'none' },
	steer: true,
	followUp: true,
	usage: { detail: 'full' },
	compact: true,
	runtime: { requirements: ['bun>=1.3.14'] },
} as const;

function send(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function event(event: unknown): void {
	send({ type: 'event', event });
}

function write(relativePath: string, text: string, source: string): void {
	const absolute = path.join(workspaceRoot, relativePath);
	const before: TextLines | null = existsSync(absolute) ? splitLines(readFileSync(absolute, 'utf8')) : null;
	writeFileSync(absolute, text, 'utf8');
	send({
		type: 'event',
		event: {
			type: 'file-write',
			write: {
				path: relativePath,
				kind: before === null ? 'create' : 'modify',
				before,
				after: splitLines(text),
				attribution: { tier: 'T1', source, level: 'own' },
			},
		},
	});
}

/** Turn 1 of S1: two lines inserted into `seed-a.ts`, and `seed-b.ts` created. */
function firstTurn(): void {
	event({ type: 'turn-start' });
	const absolute = path.join(workspaceRoot, 'seed-a.ts');
	const before = splitLines(readFileSync(absolute, 'utf8'));
	const inserted = [
		...before.lines.slice(0, 2),
		'	const normalised = trimmed.toLowerCase();',
		'	const greeting = `hello, ${normalised}`;',
		...before.lines.slice(2),
	];
	// A pure insertion of two lines: `+2 -0`, one hunk, no baseline rows.
	write('seed-a.ts', joinWith(before, inserted), 'write');
	write('seed-b.ts', "export const SEED_B = 'created by the agent';\n", 'write');
	event({ type: 'turn-end', isTerminal: true });
	event({ type: 'usage', report: { used: 1234, size: 200000, cost: 0.01 } });
}

/** Turn 2 of S2: the same file again, so only the newer hunks belong on the review face (M8). */
function secondTurn(): void {
	event({ type: 'turn-start' });
	const absolute = path.join(workspaceRoot, 'seed-a.ts');
	const before = splitLines(readFileSync(absolute, 'utf8'));
	const appended = [...before.lines, '', 'export const GREETING_LOCALE = "en";'];
	write('seed-a.ts', joinWith(before, appended), 'edit');
	event({ type: 'turn-end', isTerminal: true });
}

/** The inserted lines keep the document's own terminators, so the diff sees only the new rows. */
function joinWith(before: TextLines, lines: string[]): string {
	const eol = before.eols[0] ?? '\n';
	return lines
		.map((line, index) => line + (index === lines.length - 1 ? (before.eols[before.eols.length - 1] ?? '') : eol))
		.join('');
}

/** S3: the agent deletes the seed file, so the file-level Reject has to put it back. */
function deleteTurn(): void {
	event({ type: 'turn-start' });
	const absolute = path.join(workspaceRoot, 'seed-a.ts');
	const before = splitLines(readFileSync(absolute, 'utf8'));
	rmSync(absolute, { force: true });
	send({
		type: 'event',
		event: {
			type: 'file-write',
			write: {
				path: 'seed-a.ts',
				kind: 'delete',
				before,
				after: null,
				attribution: { tier: 'T1', source: 'write', level: 'own' },
			},
		},
	});
	event({ type: 'turn-end', isTerminal: true });
}

function runScript(): void {
	if (script === 'S2') {
		firstTurn();
		secondTurn();
		return;
	}
	if (script === 'S3') {
		deleteTurn();
		return;
	}
	firstTurn();
}

function handle(message: { id: number; method: string; params?: Record<string, unknown> }): void {
	switch (message.method) {
		case 'start': {
			// `ready` first: the extension attaches its ledger from this payload, so the events below must
			// not arrive before it.
			send({
				type: 'ready',
				sessionId: 'stub-session',
				sdkVersion: '18.2.5',
				bunVersion: Bun.version,
				capabilities: CAPABILITIES,
				fileTools: ['write', 'edit', 'ast_edit'],
			});
			send({ type: 'response', id: message.id, ok: true, result: { sessionId: 'stub-session' } });
			runScript();
			return;
		}
		case 'shutdown':
			send({ type: 'response', id: message.id, ok: true, result: {} });
			process.exit(0);
			return;
		case 'usage':
			send({ type: 'response', id: message.id, ok: true, result: { used: 1234, size: 200000, cost: 0.01 } });
			return;
		case 'steer':
		case 'followUp':
			send({ type: 'response', id: message.id, ok: true, result: { supported: true } });
			return;
		default:
			send({ type: 'response', id: message.id, ok: true, result: {} });
			return;
	}
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
	buffer += chunk;
	let index = buffer.indexOf('\n');
	while (index >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line.trim().length > 0) handle(JSON.parse(line) as { id: number; method: string });
		index = buffer.indexOf('\n');
	}
});
process.stdin.on('end', () => process.exit(0));
