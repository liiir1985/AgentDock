/**
 * Snapshots and the writes derived from them (D42 T1/T2).
 *
 * The whole point of snapshotting at `tool_call` time is that the bytes are still the *old* ones. The
 * pair (`before`, `after`) is what the Core turns into hunks, so this module's only job is to produce
 * that pair honestly:
 *  - a path that did not exist before is `null`, not an empty text (Core reads `null` as create/delete);
 *  - two identical texts are dropped: the Core would derive nothing from them anyway (D41 step 3), and
 *    emitting a `file-write` for them would make the UI show a change that is not one;
 *  - a path we never snapshotted is *not* attributed. The caller logs it and the UI has to say the
 *    review is incomplete (D42) rather than pretend the file was untouched.
 */

import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { Attribution, ObservedWrite, TextLines, joinLines, splitLines } from '@agentdock/core';

import type { Diagnostics } from './protocol';

/** `null` ⇔ the path does not exist. */
export type Snapshot = TextLines | null;

export function workspaceRelative(absolute: string, cwd: string): string | null {
	const relative = path.relative(cwd, absolute);
	if (relative.length === 0) return null;
	if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
	return relative.replace(/\\/g, '/');
}

/**
 * Reads one path, or reports that it is not a reviewable text target.
 *
 * A directory is *skipped*, not reported as absent: "does not exist" is a fact about a file, and
 * telling the Core that a directory was deleted would produce a Reject that cannot be applied.
 */
export function readSnapshot(absolute: string, diagnostics?: Diagnostics): Snapshot | 'skip' {
	try {
		if (statSync(absolute).isDirectory()) {
			diagnostics?.info(`skipped directory target ${absolute}`);
			return 'skip';
		}
	} catch (error) {
		if (!isMissing(error)) return 'skip';
		return null;
	}
	try {
		return splitLines(readFileSync(absolute, 'utf8'));
	} catch {
		// A file we cannot read as text is not a file we can review. Unreadable is closer to
		// "no pre-image" than to a textual change, so the path is dropped and logged.
		diagnostics?.warn(`skipped unreadable target ${absolute}`);
		return 'skip';
	}
}

/** Paths are keyed by absolute, resolved form so the two halves of a tool call agree on identity. */
export function snapshot(paths: readonly string[], cwd: string, diagnostics?: Diagnostics): Map<string, Snapshot> {
	const out = new Map<string, Snapshot>();
	for (const candidate of paths) {
		const absolute = resolve(candidate, cwd);
		if (absolute === null) {
			diagnostics?.warn(`skipped unresolvable target ${candidate}`);
			continue;
		}
		if (workspaceRelative(absolute, cwd) === null) {
			diagnostics?.warn(`skipped target outside the workspace: ${candidate}`);
			continue;
		}
		const read = readSnapshot(absolute, diagnostics);
		if (read === 'skip') continue;
		out.set(absolute, read);
	}
	return out;
}

export interface WriteOptions {
	/** Workspace root; every emitted path is relative to it, POSIX (M7). */
	cwd: string;
	diagnostics?: Diagnostics;
	/** Paths the tool's result claims it touched but the snapshot never saw (D42 degradation). */
	resultPaths?: readonly string[];
}

/**
 * The difference between a snapshot and the world right now, as `ObservedWrite`s.
 *
 * A path whose pre-image we never took is skipped with a warning — the caller has already committed
 * to that degradation when it decided what to snapshot, so this is where the user-visible admission
 * is produced.
 */
export function writesFrom(
	paths: readonly string[],
	before: ReadonlyMap<string, Snapshot> | undefined,
	attribution: Attribution,
	options: WriteOptions,
): ObservedWrite[] {
	const { cwd, diagnostics, resultPaths = [] } = options;
	const out: ObservedWrite[] = [];
	const seen = new Set<string>();

	for (const candidate of [...paths, ...resultPaths]) {
		const absolute = resolve(candidate, cwd);
		if (absolute === null) continue;
		if (seen.has(absolute)) continue;
		seen.add(absolute);

		const relative = workspaceRelative(absolute, cwd);
		if (relative === null) {
			diagnostics?.warn(`skipped target outside the workspace: ${candidate}`);
			continue;
		}
		if (before === undefined || !before.has(absolute)) {
			// The tool wrote a path our pre-scan did not name. We cannot restore it, so we must not
			// record it: a Reject built on a missing old side is worse than an unreviewed change.
			diagnostics?.warn(`unattributed path ${relative} (no pre-image)`);
			continue;
		}
		const pre = before.get(absolute) ?? null;
		const read = readSnapshot(absolute, diagnostics);
		if (read === 'skip') continue;
		const post: Snapshot = read;
		if (pre === null && post === null) continue;
		if (pre !== null && post !== null && joinLines(pre) === joinLines(post)) continue;
		out.push({
			path: relative,
			kind: pre === null ? 'create' : post === null ? 'delete' : 'modify',
			before: pre,
			after: post,
			attribution,
		});
	}
	return out;
}

/**
 * The staged-`ast_edit` comparison: a preview named these paths, and the later
 * `write xd://resolve` is what actually moved the bytes.
 *
 * Only paths whose bytes really changed are emitted, which is what makes this immune to OMP
 * consuming the staged layer in an order we did not predict (or not consuming it at all).
 */
export function stagedWrites(
	staged: ReadonlyMap<string, Snapshot>,
	cwd: string,
	attribution: Attribution,
	diagnostics?: Diagnostics,
): ObservedWrite[] {
	const out: ObservedWrite[] = [];
	for (const [absolute, pre] of staged) {
		const relative = workspaceRelative(absolute, cwd);
		if (relative === null) continue;
		const read = readSnapshot(absolute, diagnostics);
		if (read === 'skip') continue;
		const post: Snapshot = read;
		if (pre === null && post === null) continue;
		if (pre !== null && post !== null && joinLines(pre) === joinLines(post)) continue;
		out.push({
			path: relative,
			kind: pre === null ? 'create' : post === null ? 'delete' : 'modify',
			before: pre,
			after: post,
			attribution,
		});
	}
	return out;
}

function resolve(candidate: string, cwd: string): string | null {
	const trimmed = candidate.trim();
	if (trimmed.length === 0) return null;
	try {
		return path.resolve(cwd, trimmed);
	} catch {
		return null;
	}
}

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}
