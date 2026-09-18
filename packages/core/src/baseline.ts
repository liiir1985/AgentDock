/**
 * Baseline snapshots (D37 / D39).
 *
 * How much we can promise about a file's "before" text follows from how early we learn about the
 * write — not from anything the adapter claims on its own. `own`/`blocking-hook` run before the
 * bytes land and can therefore hand us the exact pre-image; `async-signal` races the write and can
 * only try; `post-hoc` has nothing but what the harness declares; `none` cannot be reviewed at all.
 *
 * The ledger below is the "first touch wins" cache: within one turn the second write to a path must
 * not move the baseline to a post-write text, or Reject would restore the wrong thing.
 */

import { InterceptLevel } from './model';
import { TextLines } from './lines';

export type SnapshotPolicy = 'exact-before' | 'best-effort-before' | 'declared-only' | 'none';

export function snapshotPolicy(level: InterceptLevel): SnapshotPolicy {
	switch (level) {
		case 'own':
		case 'blocking-hook':
			return 'exact-before';
		case 'async-signal':
			return 'best-effort-before';
		case 'post-hoc':
			return 'declared-only';
		case 'none':
			return 'none';
	}
}

export class BaselineLedger {
	private readonly captured = new Map<string, TextLines>();

	constructor(readonly policy: SnapshotPolicy) {}

	/** First touch wins. `false` means "no baseline" — either too late to take one, or already held. */
	capture(path: string, text: TextLines): boolean {
		if (this.policy === 'declared-only' || this.policy === 'none') return false;
		if (this.captured.has(path)) return false;
		this.captured.set(path, text);
		return true;
	}

	get(path: string): TextLines | undefined {
		return this.captured.get(path);
	}

	/** Capture order — the order Reject has to plan in when several hunks share a file. */
	get paths(): string[] {
		return [...this.captured.keys()];
	}

	clear(): void {
		this.captured.clear();
	}
}
