/**
 * Pure semver comparison (x.y.z[-prerelease]) — Electron-free so it unit-tests
 * directly and is safe to import from Electron-free modules (e.g. the remote
 * link-state machine). Extracted from git-updater.ts, which re-exports `isNewer`
 * for its existing importers.
 */

/**
 * Returns true when `latest` is strictly newer than `current`. Follows
 * semver §11:
 *   - Major, minor, patch compared numerically.
 *   - A version with no pre-release is greater than one with the same
 *     x.y.z and a pre-release.
 *   - Pre-release identifiers are dot-separated; each is compared
 *     numerically if both are numeric, otherwise lexicographically.
 *     Numeric < alphanumeric. Fewer identifiers < more (when prefixes
 *     equal).
 *
 * For unparseable input we conservatively report a mismatch as "newer"
 * — better to surface a maybe-update than swallow it silently.
 */
export function isNewer(latest: string, current: string): boolean {
    const lp = parseSemver(latest);
    const cp = parseSemver(current);
    if (!lp || !cp) return latest !== current;
    for (let i = 0; i < 3; i++) {
        if (lp.parts[i] > cp.parts[i]) return true;
        if (lp.parts[i] < cp.parts[i]) return false;
    }
    // Same x.y.z. Pre-release rules.
    if (lp.pre === null && cp.pre === null) return false;
    if (lp.pre === null && cp.pre !== null) return true; // release > prerelease
    if (lp.pre !== null && cp.pre === null) return false;
    return comparePreRelease(lp.pre as string, cp.pre as string) > 0;
}

function parseSemver(v: string): { parts: [number, number, number]; pre: string | null } | null {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
    if (!m) return null;
    return {
        parts: [Number(m[1]), Number(m[2]), Number(m[3])],
        pre: m[4] ?? null,
    };
}

/**
 * Pre-release identifier comparison per semver §11. Returns 1 if `a` is
 * greater, -1 if smaller, 0 if equal. Dot-split, then per-segment:
 * both numeric → numeric compare; both alphanumeric → string compare;
 * mixed → numeric < alphanumeric. Fewer fields lose ties.
 */
function comparePreRelease(a: string, b: string): number {
    const as = a.split('.');
    const bs = b.split('.');
    const n = Math.max(as.length, bs.length);
    for (let i = 0; i < n; i++) {
        const av = as[i];
        const bv = bs[i];
        if (av === undefined) return -1;
        if (bv === undefined) return 1;
        const aNum = /^\d+$/.test(av);
        const bNum = /^\d+$/.test(bv);
        if (aNum && bNum) {
            const na = Number(av);
            const nb = Number(bv);
            if (na !== nb) return na > nb ? 1 : -1;
            continue;
        }
        if (aNum !== bNum) return aNum ? -1 : 1; // numeric < alphanumeric
        if (av !== bv) return av > bv ? 1 : -1;
    }
    return 0;
}
