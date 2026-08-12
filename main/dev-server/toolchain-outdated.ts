/**
 * PURE. Parse a package manager's "what's out of date" output into
 * `{ package-identifier → latest version }`.
 *
 * This is the honest half of #242 P1: the real "latest available" a tool's
 * update badge needs comes from the manager that owns it — `npm outdated`,
 * `brew outdated`, `apt list --upgradable`, `winget upgrade`. RUNNING those is
 * the injected seam (the LatestFor factory, wired next); TURNING their output
 * into versions is pure and lives here, one parser per documented format.
 *
 * Every parser NEVER throws: malformed or empty input yields `{}` ("nothing
 * known to be out of date"), matching detection's never-crash contract. A parser
 * that misjudges a line drops it rather than guess — a missed update badge is
 * recoverable; a crashed panel is not.
 */

/** Only report a version that looks like one — never a pointer like npm's
 *  `linked`/`git`, which would read as a bogus "update available". */
function isVersionish(v: unknown): v is string {
    return typeof v === 'string' && /\d+\.\d/.test(v);
}

/**
 * `npm outdated -g --json` → `{ "<pkg>": { current, wanted, latest, … } }`.
 * We take `latest`; entries whose latest isn't a real version (a linked/git
 * dependency) are dropped.
 */
export function parseNpmOutdated(jsonText: string): Record<string, string> {
    const out: Record<string, string> = {};
    let data: unknown;
    try {
        data = JSON.parse(jsonText);
    } catch {
        return out;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
    for (const [pkg, info] of Object.entries(data as Record<string, unknown>)) {
        const latest = (info as { latest?: unknown })?.latest;
        if (isVersionish(latest)) out[pkg] = latest;
    }
    return out;
}

/**
 * `brew outdated --json=v2` → `{ formulae: [{name, current_version, …}], casks: [...] }`.
 * `current_version` IS the newest brew knows about; both lists share the map.
 */
export function parseBrewOutdated(jsonText: string): Record<string, string> {
    const out: Record<string, string> = {};
    let data: unknown;
    try {
        data = JSON.parse(jsonText);
    } catch {
        return out;
    }
    if (!data || typeof data !== 'object') return out;
    for (const list of ['formulae', 'casks'] as const) {
        const rows = (data as Record<string, unknown>)[list];
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
            const name = (row as { name?: unknown })?.name;
            const version = (row as { current_version?: unknown })?.current_version;
            if (typeof name === 'string' && isVersionish(version)) out[name] = version;
        }
    }
    return out;
}

/**
 * `apt list --upgradable` → lines `pkg/suites <newversion> <arch> [upgradable from: <old>]`.
 * The `Listing…` header and blank lines are skipped; the package is the segment
 * before the first `/`, the upgradable-to version the second field.
 */
export function parseAptUpgradable(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
        const match = line.match(/^(\S+?)\/\S+\s+(\S+)\s+\S+\s+\[upgradable\b/);
        if (match) out[match[1]] = match[2];
    }
    return out;
}

/**
 * `winget upgrade` → a column table `Name  Id  Version  Available  Source`.
 *
 * Parsed conservatively by splitting on runs of 2+ spaces (columns are always
 * separated by several; a name's internal single spaces stay intact): a row is
 * taken only when it has ≥4 fields AND the Id column (field 1) looks like a
 * winget id (contains a dot) AND the Available column (field 3) starts with a
 * digit. That drops the header (`Id` has no dot), the `---` separator (one
 * field) and the trailing `N upgrades available.` summary, without a brittle
 * fixed-column parse.
 */
export function parseWingetUpgrade(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
        const fields = line.trim().split(/\s{2,}/);
        if (fields.length < 4) continue;
        const [, id, , available] = fields;
        if (id?.includes('.') && /^\d/.test(available ?? '')) out[id] = available;
    }
    return out;
}
