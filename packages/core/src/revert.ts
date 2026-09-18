/**
 * The revert executor (D33, file side).
 *
 * "Undo turn N" means the workspace must look exactly like it did just before turn N started, so the
 * ops are produced by walking turns *backwards* and, inside each turn, the files backwards too — the
 * reverse of the order in which they were first touched. That order is the whole algorithm: a file
 * created in turn 3 and deleted in turn 5 is restored by undoing turn 5 (write it back) and then
 * turn 3 (delete it again), and the same path may legitimately appear in both.
 *
 * Pure and I/O-free: the caller owns the disc.
 */

import { TextLines } from './lines';
import { FileOp, Session } from './model';

/** Ops that take the workspace from "now" back to the state just before turn `turnIndex`. */
export function revertTo(session: Session, turnIndex: number): FileOp[] {
	if (!Number.isInteger(turnIndex) || turnIndex < 1 || turnIndex > session.turns.length) {
		throw new RangeError(`turn ${turnIndex} is outside [1, ${session.turns.length}]`);
	}
	const ops: FileOp[] = [];
	for (let n = session.turns.length; n >= turnIndex; n--) {
		const changeSet = session.turns[n - 1].changeSet;
		if (!changeSet) continue;
		for (let i = changeSet.files.length - 1; i >= 0; i--) {
			const file = changeSet.files[i];
			if (file.kind === 'create') {
				ops.push({ kind: 'delete', path: file.path });
				continue;
			}
			const baseline = baselineOf(file.kind, file.baseline);
			if (file.kind !== 'rename') {
				ops.push({ kind: 'write', path: file.path, text: baseline });
				continue;
			}
			const from = file.fromPath as string;
			// Move back first: after the rename the content sits at the old path, which is where the
			// restore has to write. A pure rename has nothing to restore — later turns' ops already
			// put the content back — so the write is only needed when this turn changed it too.
			ops.push({ kind: 'rename', from: file.path, to: from });
			if (file.hunks.length > 0) ops.push({ kind: 'write', path: from, text: baseline });
		}
	}
	return ops;
}

function baselineOf(kind: string, baseline: TextLines | null): TextLines {
	// `create` is handled before we get here; the other kinds cannot exist without one
	// (`validateObservedWrite` refuses them).
	if (baseline === null) throw new Error(`${kind} without a baseline cannot be reverted`);
	return baseline;
}
