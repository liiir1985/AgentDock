/**
 * Which Bun to run (D36), decided without touching the editor or the file system.
 *
 * The search order is the whole content of this module: the explicit setting first (a user who names a
 * path wants *that* path, and silently falling back would hide a typo behind a run against a different
 * Bun), then `PATH`, then the installer's default location. Keeping the decision pure is what lets the
 * "pull Bun out" case be tested at all — the interesting part is not the spawn, it is the refusal.
 */

export const BUN_REQUIREMENT = 'AgentDock 需要 Bun ≥ 1.3.14';
export const BUN_INSTALL_HINT = 'https://bun.sh/install';

export const BUN_MISSING_MESSAGE =
	`${BUN_REQUIREMENT}；未找到 bun。安装：${BUN_INSTALL_HINT} （或在设置 agentdock.bunPath 指定路径）`;

export type BunSource = 'setting' | 'path' | 'home';

export interface BunLocation {
	/** What to spawn. `'bun'` means "resolve through PATH at spawn time". */
	command: string;
	source: BunSource;
	version?: string;
}

export class BunNotFoundError extends Error {
	constructor(
		message: string,
		/** The path the user configured, when that is what failed. */
		readonly configuredPath?: string,
	) {
		super(message);
		this.name = 'BunNotFoundError';
	}
}

/** Everything the decision needs to know about the machine. */
export interface BunProbe {
	/** The configured path, or `''`. */
	configured: string;
	exists(candidate: string): boolean;
	/** `undefined` when the command cannot be run at all. */
	version(command: string): string | undefined;
	/** The installer's default locations, in the order they should be tried. */
	homeCandidates(): string[];
}

export function resolveBun(probe: BunProbe): BunLocation {
	const configured = probe.configured.trim();
	if (configured.length > 0) {
		if (!probe.exists(configured)) {
			throw new BunNotFoundError(
				`${BUN_REQUIREMENT}；agentdock.bunPath 指向的文件不存在：${configured}`,
				configured,
			);
		}
		return withVersion({ command: configured, source: 'setting' }, probe.version(configured));
	}

	const onPath = probe.version('bun');
	if (onPath !== undefined) return { command: 'bun', source: 'path', version: onPath };

	for (const candidate of probe.homeCandidates()) {
		if (!probe.exists(candidate)) continue;
		return withVersion({ command: candidate, source: 'home' }, probe.version(candidate));
	}

	throw new BunNotFoundError(BUN_MISSING_MESSAGE);
}

function withVersion(location: BunLocation, version: string | undefined): BunLocation {
	return version === undefined ? location : { ...location, version };
}
