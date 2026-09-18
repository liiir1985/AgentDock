/**
 * Shared test-only helpers. Deliberately not a `.test.ts` file, so `node --test` never
 * collects it (and so the property tests can seed every generator from one place).
 *
 * Nothing here is part of the package's public surface.
 */

import { TextLines, joinLines, replaceRange, splitLines } from '../lines';
import { Attribution, FileOp, InterceptLevel, ObservedWrite } from '../model';
import { RejectPlan } from '../verdict';

/** Deterministic PRNG. Same seed ⇒ same stream, on every platform. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Inclusive on both ends. */
export function rngInt(rng: () => number, min: number, max: number): number {
	if (max < min) return min;
	return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
	return items[rngInt(rng, 0, items.length - 1)];
}

export interface TextOptions {
	minLines?: number;
	maxLines?: number;
	/** Line contents to draw from; duplicates are what makes a diff ambiguous. */
	alphabet?: readonly string[];
	/** Terminators to draw from; a final `''` means "no terminator at EOF". */
	eols?: readonly string[];
	finalEol?: 'any' | 'present' | 'absent';
}

const ALPHABET = ['a', 'b', 'c', 'd', 'a', 'b', '{}', 'return;', ''] as const;
const EOLS = ['\n', '\r\n', '\r', '\n', '\n'] as const;

/**
 * Always built by splitting a string, so the result is a well-formed `TextLines`
 * (only the last element may carry a `''` terminator) — the same invariant the real
 * producers hold.
 */
export function randomText(rng: () => number, options: TextOptions = {}): TextLines {
	const min = options.minLines ?? 0;
	const max = options.maxLines ?? 10;
	const alphabet = options.alphabet ?? ALPHABET;
	const eols = options.eols ?? EOLS;
	const finalEol = options.finalEol ?? 'any';
	const count = rngInt(rng, min, max);
	let text = '';
	for (let i = 0; i < count; i++) {
		text += pick(rng, alphabet);
		if (i < count - 1) {
			text += pick(rng, eols);
			continue;
		}
		if (finalEol === 'present') text += pick(rng, eols);
		else if (finalEol === 'absent') text += '';
		else text += pick(rng, eols.concat(['']));
	}
	return splitLines(text);
}

/** A small random number of edits, so the result still resembles `before`. */
export function mutateLines(rng: () => number, before: TextLines, editCount = 2): TextLines {
	let out = before;
	for (let i = 0; i < editCount; i++) {
		const n = out.lines.length;
		const cs = rngInt(rng, 0, n);
		const deleted = rngInt(rng, 0, Math.min(n - cs, 3));
		const insertedCount = rngInt(rng, 0, 3);
		const inserted = randomText(rng, {
			minLines: insertedCount,
			maxLines: insertedCount,
			finalEol: 'present',
		});
		out = replaceRange(out, { start: cs, end: cs + deleted - 1 }, inserted);
	}
	return out;
}

export function attribution(
	level: InterceptLevel = 'own',
	tier: 'T1' | 'T2' = 'T1',
	source = 'write',
): Attribution {
	return { tier, source, level };
}

export interface WriteOptions {
	base?: TextLines | null;
	kinds?: readonly ('create' | 'modify' | 'delete' | 'rename')[];
	level?: InterceptLevel;
}

/** `write.before` is whatever the harness claims it saw; it need not equal `options.base`. */
export function randomWrite(rng: () => number, path: string, options: WriteOptions = {}): ObservedWrite {
	const base = options.base ?? null;
	const kinds = options.kinds ?? (base === null ? (['create'] as const) : (['modify', 'delete', 'rename', 'create'] as const));
	const kind = pick(rng, kinds);
	const level = options.level ?? 'own';
	const from = `${path}.from`;

	if (kind === 'create') {
		return {
			path,
			kind,
			before: null,
			after: randomText(rng, { minLines: 0, maxLines: 6 }),
			attribution: attribution(level),
		};
	}
	const before = base ?? randomText(rng, { minLines: 1, maxLines: 6 });
	if (kind === 'delete') {
		return { path, kind, before, after: null, attribution: attribution(level) };
	}
	const after = mutateLines(rng, before, rngInt(rng, 1, 3));
	if (kind === 'rename') {
		return { path, kind, fromPath: from, before, after, attribution: attribution(level) };
	}
	return { path, kind: 'modify', before, after, attribution: attribution(level) };
}

/** `Map`-backed stand-in for the workspace. Paths are POSIX, workspace-relative. */
export type MemFs = Map<string, string>;

export function memoryFs(entries: Record<string, string> = {}): MemFs {
	return new Map(Object.entries(entries));
}

/**
 * Executes `FileOp`s in order. `rename` of a missing `from` is a no-op, which is how a
 * real host would see a double rename-back.
 */
export function applyOps(fs: MemFs, ops: readonly FileOp[]): MemFs {
	for (const op of ops) {
		if (op.kind === 'write') fs.set(op.path, joinLines(op.text));
		else if (op.kind === 'delete') fs.delete(op.path);
		else {
			const text = fs.get(op.from);
			fs.delete(op.from);
			if (text !== undefined) fs.set(op.to, text);
		}
	}
	return fs;
}

export function fsSnapshot(fs: MemFs): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of [...fs.keys()].sort()) out[key] = fs.get(key) as string;
	return out;
}

/** Plans are addressed in one coordinate frame, so they arrive back-to-front. */
export function applyPlans(doc: TextLines, plans: readonly RejectPlan[]): TextLines {
	let out = doc;
	for (const plan of plans) {
		out = replaceRange(out, { start: plan.startLine, end: plan.endLineExclusive - 1 }, plan.text);
	}
	return out;
}
