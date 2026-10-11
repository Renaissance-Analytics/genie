import { compareVersions } from './toolchain.js';

/**
 * WHERE "LATEST" COMES FROM — pure parsers over what each source actually returns.
 *
 * The honest `unknown` tone is earned here: a source that cannot be read yields `null`, never a
 * guessed version. Sources: nodejs.org's `index.json` (LTS by default — a workstation should not be
 * told to install a current release), php.net's releases JSON, `winget upgrade`'s table,
 * `brew outdated --json`, `npm outdated -g --json`.
 */

export interface Latest {
    readonly version: string;
    readonly source: string;
}

interface NodeIndexEntry {
    version?: unknown;
    lts?: unknown;
}

export function latestFromNodeIndex(index: unknown, options: { major?: number } = {}): Latest | null {
    if (!Array.isArray(index)) return null;
    const candidates = (index as NodeIndexEntry[])
        .filter((e) => typeof e.version === 'string' && typeof e.lts === 'string' && e.lts.length > 0)
        .map((e) => (e.version as string).replace(/^v/, ''))
        .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
        .filter((v) => options.major === undefined || Number(v.split('.')[0]) === options.major)
        .sort((a, b) => compareVersions(b, a));
    return candidates.length > 0 ? { version: candidates[0]!, source: 'nodejs.org index (LTS)' } : null;
}

export function phpLatestFromReleases(releases: unknown, options: { major?: number; minor?: number } = {}): Latest | null {
    if (typeof releases !== 'object' || releases === null) return null;
    const versions = Object.values(releases as Record<string, { version?: unknown }>)
        .map((r) => (typeof r?.version === 'string' ? r.version : null))
        .filter((v): v is string => v !== null && /^\d+\.\d+\.\d+$/.test(v))
        .filter((v) => {
            const [maj, min] = v.split('.').map(Number);
            if (options.major !== undefined && maj !== options.major) return false;
            if (options.minor !== undefined && min !== options.minor) return false;
            return true;
        })
        .sort((a, b) => compareVersions(b, a));
    return versions.length > 0 ? { version: versions[0]!, source: 'php.net releases' } : null;
}

/** `winget upgrade` prints a fixed-width table; the id and the Available column are what we read. */
export function latestFromWingetUpgrade(output: string, packageId: string): Latest | null {
    for (const line of output.split(/\r?\n/)) {
        const cols = line.trim().split(/\s{2,}/);
        const idx = cols.indexOf(packageId);
        if (idx < 0) continue;
        const available = cols[idx + 2];
        if (available && /^\d+(\.\d+)+/.test(available)) return { version: available, source: 'winget upgrade' };
    }
    return null;
}

export function latestFromBrewOutdated(json: string, formula: string): Latest | null {
    try {
        const parsed = JSON.parse(json) as { formulae?: Array<{ name?: string; current_version?: string }>; casks?: Array<{ name?: string; current_version?: string }> };
        const hit = [...(parsed.formulae ?? []), ...(parsed.casks ?? [])].find((f) => f.name === formula);
        return hit?.current_version ? { version: hit.current_version, source: 'brew outdated' } : null;
    } catch {
        return null;
    }
}

export function latestFromNpmOutdated(json: string, pkg: string): Latest | null {
    if (json.trim().length === 0) return null;
    try {
        const parsed = JSON.parse(json) as Record<string, { latest?: string }>;
        const hit = parsed[pkg];
        return hit?.latest ? { version: hit.latest, source: 'npm registry' } : null;
    } catch {
        return null;
    }
}
