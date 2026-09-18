/**
 * Write targets that are not workspace files.
 *
 * `echo x > nul` changes nothing a reviewer can see, so recording it would put a
 * path in the ChangeSet whose "baseline" was never a file — and a later Reject
 * would then write that text to disk. The table exists so those targets are
 * dropped *before* anything is attributed to them, not filtered afterwards.
 *
 * A `Record<string, true>` literal rather than a `Set`: the vocabulary is static,
 * and a fresh `Set` per candidate token would allocate for no reason.
 */
export const DEVICE_TARGETS: Record<string, true> = {
	// Windows device names, with and without a path prefix.
	nul: true,
	con: true,
	prn: true,
	aux: true,
	com1: true,
	com2: true,
	com3: true,
	com4: true,
	com5: true,
	com6: true,
	com7: true,
	com8: true,
	com9: true,
	lpt1: true,
	lpt2: true,
	lpt3: true,
	lpt4: true,
	lpt5: true,
	lpt6: true,
	lpt7: true,
	lpt8: true,
	lpt9: true,
	// POSIX catch-all devices: writing to them is not a file change either.
	'/dev/null': true,
	'/dev/zero': true,
	'/dev/full': true,
	'/dev/stdout': true,
	'/dev/stderr': true,
	'/dev/random': true,
	'/dev/urandom': true,
	// PowerShell's null sink.
	'$null': true,
};

/**
 * Case-insensitive: `NUL`, `Nul` and `nul` all name the same sink on Windows.
 * The surrounding quotes are stripped here too — callers hand over tokenised
 * words in practice, but the check has to stay correct for a raw token as well.
 */
export function isDeviceTarget(token: string): boolean {
	const quote = token[0];
	const bare = (quote === '"' || quote === "'") && token.length > 1 && token[token.length - 1] === quote
		? token.slice(1, -1)
		: token;
	return DEVICE_TARGETS[bare.toLowerCase()] === true;
}
