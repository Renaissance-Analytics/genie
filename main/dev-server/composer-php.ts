/**
 * PURE. Which PHP a repo asks for, read from its own `composer.json`
 * (genie#668, owner decision).
 *
 * "Projects still get to set what version of php it uses. This should be read
 * directly from composer setting in the repo, so not something an agent has to
 * provide when setting up a site."
 *
 * The rules are COMPOSER'S, not npm's, because the two languages disagree in the
 * exact places that pick a runtime: `~8.3` is `>=8.3 <9.0` to Composer and
 * `>=8.3.0 <8.4.0` to npm, and a bare `8.3` is an exact version to Composer.
 * Using a generic semver library here would quietly choose the wrong PHP.
 *
 * Anything this cannot read allows NOTHING. An unreadable constraint has to fail
 * a start with the constraint named — reading it as "any PHP" is the silent wrong
 * runtime that genie#207 exists to prevent.
 */

export interface ComposerPhp {
    /** A Composer constraint, e.g. `^8.2` or `8.3.*`. */
    constraint: string;
    /** Which key it came from — said back to a person when nothing satisfies it. */
    source: 'config.platform.php' | 'require.php';
}

type Version = [number, number, number];

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The PHP requirement a parsed `composer.json` states, or null when it states none.
 *
 * `config.platform.php` wins: it is the exact platform Composer resolved the lock
 * file against, so the app's dependencies were chosen for that line. It is read
 * as its LINE (`8.3.12` → `8.3.*`) — a patch release of the same line is the same
 * platform to every package. Otherwise `require.php`, as written.
 */
export function composerPhpRequirement(composer: unknown): ComposerPhp | null {
    if (!isRecord(composer)) return null;
    const config = composer.config;
    const platform = isRecord(config) && isRecord(config.platform) ? config.platform.php : undefined;
    if (typeof platform === 'string') {
        const line = /^\s*v?(\d+)\.(\d+)/.exec(platform);
        if (line) return { constraint: `${line[1]}.${line[2]}.*`, source: 'config.platform.php' };
    }
    const require = composer.require;
    const php = isRecord(require) ? require.php : undefined;
    if (typeof php === 'string' && php.trim()) return { constraint: php.trim(), source: 'require.php' };
    return null;
}

function parseVersion(s: string): { v: Version; parts: number } | null {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.\d+)?$/.exec(s);
    if (!m) return null;
    const parts = m[3] !== undefined ? 3 : m[2] !== undefined ? 2 : 1;
    return { v: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], parts };
}

function compare(a: Version, b: Version): number {
    for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return 0;
}

/** One constraint atom as a predicate, or null when it is not one Composer writes. */
function atom(raw: string): ((v: Version) => boolean) | null {
    // A stability flag (`@dev`, `-beta2`) changes which PACKAGE releases qualify,
    // never which PHP does.
    const a = raw.replace(/@[a-z]+$/i, '').replace(/-(dev|alpha|beta|rc|stable|patch)\d*$/i, '');
    if (a === '*') return () => true;

    const wildcard = /^(\d+)(?:\.(\d+))?\.\*$/.exec(a);
    if (wildcard) {
        const major = Number(wildcard[1]);
        const minor = wildcard[2] === undefined ? undefined : Number(wildcard[2]);
        return (v) => v[0] === major && (minor === undefined || v[1] === minor);
    }

    if (a.startsWith('^')) {
        const p = parseVersion(a.slice(1));
        if (!p) return null;
        const [M, m, patch] = p.v;
        const upper: Version = M > 0 ? [M + 1, 0, 0] : m > 0 ? [0, m + 1, 0] : [0, 0, patch + 1];
        return (v) => compare(v, p.v) >= 0 && compare(v, upper) < 0;
    }

    if (a.startsWith('~')) {
        const p = parseVersion(a.slice(1));
        if (!p) return null;
        const [M, m] = p.v;
        // The LAST part given may move: `~8` and `~8.3` stay under the next major,
        // `~8.3.0` under the next minor.
        const upper: Version = p.parts === 3 ? [M, m + 1, 0] : [M + 1, 0, 0];
        return (v) => compare(v, p.v) >= 0 && compare(v, upper) < 0;
    }

    const op = /^(>=|<=|!=|==|>|<|=)?(.+)$/.exec(a);
    if (!op) return null;
    const p = parseVersion(op[2]!);
    if (!p) return null;
    switch (op[1]) {
        case '>=':
            return (v) => compare(v, p.v) >= 0;
        case '<=':
            return (v) => compare(v, p.v) <= 0;
        case '>':
            return (v) => compare(v, p.v) > 0;
        case '<':
            return (v) => compare(v, p.v) < 0;
        case '!=':
            return (v) => compare(v, p.v) !== 0;
        default:
            // A bare version is EXACT to Composer: `8.3` is 8.3.0, not the 8.3 line.
            return (v) => compare(v, p.v) === 0;
    }
}

/** Does a concrete PHP version satisfy a Composer constraint? */
export function composerConstraintAllows(constraint: string, version: string): boolean {
    const target = parseVersion(version.trim());
    if (!target) return false;
    // `>= 8.2` is written with a space; join the operator to its version so the
    // space can mean AND everywhere else.
    const normal = constraint.trim().replace(/(>=|<=|!=|==|>|<|=|\^|~)\s+/g, '$1');
    if (!normal) return false;
    const groups = normal.split(/\s*\|\|?\s*/);
    let anyAllows = false;
    for (const group of groups) {
        const atoms = group.split(/\s*,\s*|\s+/).filter(Boolean);
        if (atoms.length === 0) return false;
        const predicates = atoms.map(atom);
        // One unreadable atom makes the whole constraint unreadable.
        if (predicates.some((p) => p === null)) return false;
        if (predicates.every((p) => p!(target.v))) anyAllows = true;
    }
    return anyAllows;
}

/**
 * Which of the managed PHP versions a repo's constraint lands on.
 *
 * The machine default when the repo allows it — a site should not change runtime
 * just because the repo stated a range the default already sits in. Otherwise the
 * newest allowed. Null when none is, which the caller turns into a failure naming
 * the constraint.
 */
export function pickComposerPhp(
    constraint: string,
    versions: readonly string[],
    defaultVersion?: string,
): string | null {
    if (defaultVersion && versions.includes(defaultVersion) && composerConstraintAllows(constraint, defaultVersion)) {
        return defaultVersion;
    }
    const newestFirst = [...versions].sort((a, b) => {
        const pa = parseVersion(a)?.v;
        const pb = parseVersion(b)?.v;
        return pa && pb ? compare(pb, pa) : 0;
    });
    return newestFirst.find((v) => composerConstraintAllows(constraint, v)) ?? null;
}
