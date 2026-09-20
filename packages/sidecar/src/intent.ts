/**
 * Which files a tool call is about to touch — *before* it touches them.
 *
 * This has to run at `tool_call` time. Once the write has landed, reading the file gives us the
 * "after" text and nothing else, and a Reject without an exact "before" is a lie (D26). So the answer
 * here is a best-effort list of candidates, and the caller decides whether it is trustworthy enough
 * to snapshot.
 *
 * Two filters are not optional:
 *  - internal URLs (`xd://resolve`, `conflict://1`, …) are not files. `write xd://resolve` applies a
 *    staged `ast_edit`; snapshotting it as a path would produce a change for a directory that cannot
 *    exist.
 *  - archive / image / sqlite targets are not text. Reading one as UTF-8 produces mojibake that a
 *    diff would present as a change, and Reject would then write that mojibake back.
 */

import * as nodePath from 'node:path';

import type { Diagnostics } from './protocol';

/** `xd://`, `conflict://`, `local://`, `artifact://`, … — a scheme, never a path. */
export const INTERNAL_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Targets we cannot review as text; hit ⇒ skip the path (and say so). */
export const NON_TEXT_TARGET =
	/\.(zip|jar|tar|gz|tgz|xz|zst|7z|rar|sqlite|sqlite3|db|db3|png|jpe?g|gif|webp|mp3|wav|mp4|pdf)$/i;

/**
 * `edit`'s patch mode carries its targets inside the patch text
 * (`src/edit/index.ts` PATCH_EXAMPLES is the authoritative sample):
 *
 *   *** Update File: src/app.py
 *   *** Move to: src/main.py
 *   *** Add File: hello.txt
 *   *** Delete File: obsolete.txt
 *
 * One alternating pattern rather than two passes, because the list has to come out in document order:
 * `*** Move to:` arrives *after* the `*** Update File:` it belongs to, and two separate scans would
 * report every file header before every destination.
 */
const APPLY_PATCH_HEADER_RE = /^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+)$/gm;

/**
 * `edit`'s hashline mode names each target in a `[path#tag]` header — the same shape the SDK matches
 * for `write` (`LOOSE_HASHLINE_HEADER_RE`, `tools/write.ts`).
 */
const HASHLINE_HEADER_RE = /^\s*\[([^#\r\n]+)#[^ \t\r\n]*\]\s*$/gm;

export const SLOPPY_EXTRACTION_NOTE = 'sloppy 编辑模式无法归因：输入里没有可解析的目标路径';

/**
 * Target paths a tool call will touch, as written in its input (absolute, cwd-relative and `~`-style
 * forms all pass through; the caller resolves them). Order of appearance, de-duplicated.
 *
 * - `write`: `path` (with `file_path` as the SDK's own legacy alias).
 * - `edit` path mode (`{path, edits: [...]}`): `path`, plus every `edits[].rename` — a rename writes
 *   the destination too.
 * - `edit` input mode: the patch headers, the `*** Move to:` destination, or the hashline headers.
 *   Anything else in an `input` string is the sloppy mode, which we deliberately do not parse: a
 *   guess here would attribute somebody else's bytes to the agent (D42: a missed change is safer than
 *   a wrong one).
 * - `ast_edit`: nothing. Its preview names files only in its *result*, so it is handled by the staged
 *   path in `intercept.ts` instead.
 * - `bash`: not here — T2 goes through the Core's command-line parser, which needs the dialect.
 */
export function extractPaths(
	tool: string,
	input: Record<string, unknown>,
	diagnostics?: Diagnostics,
	cwd?: string,
): string[] {
	switch (tool) {
		case 'write':
			return filter([stringValue(input.path) ?? stringValue(input.file_path)], diagnostics, cwd);
		case 'edit':
			return filter(editsTargets(input, diagnostics), diagnostics, cwd);
		default:
			return [];
	}
}

function editsTargets(input: Record<string, unknown>, diagnostics?: Diagnostics): (string | undefined)[] {
	const declared = stringValue(input.path);
	if (declared !== undefined) {
		const edits = Array.isArray(input.edits) ? input.edits : [];
		return [declared, ...edits.map((entry) => renameOf(entry))];
	}
	const text = stringValue(input.input);
	if (text === undefined) return [];
	const patched = matches(APPLY_PATCH_HEADER_RE, text);
	if (patched.length > 0) return patched;
	const hashed = matches(HASHLINE_HEADER_RE, text);
	if (hashed.length > 0) return hashed;
	diagnostics?.warn(SLOPPY_EXTRACTION_NOTE);
	return [];
}

function renameOf(entry: unknown): string | undefined {
	if (typeof entry !== 'object' || entry === null) return undefined;
	return stringValue((entry as Record<string, unknown>).rename);
}

/**
 * Paths a tool *actually* changed, read off its result details.
 *
 * The input-side extraction is a prediction; this is the record. A path here that we never
 * snapshotted (sloppy mode, a tool that widened its own target) is exactly the case D42 requires the
 * UI to own up to, so the caller logs it instead of inventing a change.
 */
export function pathsFromResult(details: unknown): string[] {
	if (typeof details !== 'object' || details === null) return [];
	const record = details as Record<string, unknown>;
	const out: string[] = [];
	for (const key of ['files', 'paths']) pushPathValues(out, record[key]);
	pushPathValues(out, record.fileChanges);
	pushPathValues(out, record.perFileResults);
	for (const key of ['path', 'move', 'resolvedPath', 'sourcePath']) {
		const value = stringValue(record[key]);
		if (value !== undefined) out.push(value);
	}
	return out;
}

/**
 * `files`/`perFileResults` are either strings or `{ path, sourcePath }` objects depending on the tool
 * (and on the mode within one tool), so both shapes are read rather than assumed.
 */
function pushPathValues(out: string[], value: unknown): void {
	if (!Array.isArray(value)) return;
	for (const entry of value) {
		if (typeof entry === 'string') {
			out.push(entry);
			continue;
		}
		if (typeof entry !== 'object' || entry === null) continue;
		const record = entry as Record<string, unknown>;
		for (const key of ['path', 'sourcePath', 'move']) {
			const path = stringValue(record[key]);
			if (path !== undefined) out.push(path);
		}
	}
}

function filter(candidates: (string | undefined)[], diagnostics?: Diagnostics, cwd?: string): string[] {
	const out: string[] = [];
	for (const candidate of candidates) {
		if (candidate === undefined) continue;
		const trimmed = candidate.trim();
		if (trimmed.length === 0) continue;
		if (INTERNAL_URL_RE.test(trimmed)) {
			diagnostics?.info(`skipped internal URL target ${trimmed}`);
			continue;
		}
		if (NON_TEXT_TARGET.test(trimmed)) {
			diagnostics?.warn(`skipped non-text target ${trimmed}`);
			continue;
		}
		if (cwd !== undefined && escapes(cwd, trimmed)) {
			diagnostics?.warn(`skipped target outside the workspace: ${trimmed}`);
			continue;
		}
		out.push(trimmed);
	}
	return [...new Set(out)];
}

/**
 * `..`-style escapes are dropped rather than resolved: the review surface is workspace-relative
 * (M7), and a path we cannot name relative to the workspace cannot be rendered or rejected sanely.
 */
function escapes(cwd: string, candidate: string): boolean {
	const resolved = resolvePath(cwd, candidate);
	if (resolved === null) return true;
	const relative = relativePath(cwd, resolved);
	return relative === null || relative.startsWith('..');
}

function resolvePath(cwd: string, candidate: string): string | null {
	try {
		return nodePath.resolve(cwd, candidate);
	} catch {
		return null;
	}
}

function relativePath(cwd: string, target: string): string | null {
	try {
		return nodePath.relative(cwd, target);
	} catch {
		return null;
	}
}

function matches(re: RegExp, text: string): string[] {
	const out: string[] = [];
	re.lastIndex = 0;
	let match = re.exec(text);
	while (match !== null) {
		if (match[1] !== undefined) out.push(match[1]);
		match = re.exec(text);
	}
	return out;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}
