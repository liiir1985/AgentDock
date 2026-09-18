/**
 * T1 coverage self-check (D42).
 *
 * T1 attribution is a hard contract: every file-changing tool the harness ships must be wrapped by
 * the adapter, because an unwrapped one produces changes nobody can review or Reject. The two tool
 * lists therefore have to be *equal* — wrapping fewer means a blind spot, wrapping more means the
 * declaration went stale and the next harness update may silently add an unwrapped tool.
 *
 * Phase 1's OMP adapter calls this at startup with the harness's own tool dump; the check itself is
 * pure and lives here so it can be tested without a harness.
 */

export interface ToolCoverage {
	/** Tools the harness declares as file-changing. */
	declared: readonly string[];
	/** Tools the adapter actually wrapped. */
	wrapped: readonly string[];
}

export class ToolCoverageError extends Error {
	constructor(readonly missing: readonly string[], readonly unexpected: readonly string[]) {
		super(
			`file tool coverage mismatch: unwrapped=[${missing.join(', ')}] unexpected=[${unexpected.join(', ')}]` +
				' — an unwrapped file tool writes changes no review can attribute or reject',
		);
		this.name = 'ToolCoverageError';
	}
}

export function missingTools(c: ToolCoverage): string[] {
	const wrapped = new Set(c.wrapped);
	return unique(c.declared).filter((tool) => !wrapped.has(tool));
}

export function unexpectedTools(c: ToolCoverage): string[] {
	const declared = new Set(c.declared);
	return unique(c.wrapped).filter((tool) => !declared.has(tool));
}

export function assertToolCoverage(c: ToolCoverage): void {
	const missing = missingTools(c);
	const unexpected = unexpectedTools(c);
	if (missing.length > 0 || unexpected.length > 0) throw new ToolCoverageError(missing, unexpected);
}

function unique(tools: readonly string[]): string[] {
	return [...new Set(tools)];
}
