/**
 * THE PHP VERSIONS GENIE WILL NOT RUN QUIETLY (the owner, 2026-10-22: "there is a big security issue with php. we need
 * to make sure we not supporting the bad versions").
 *
 * PHP2Shell — CVE-2026-109618 and CVE-2026-109619, remote code execution in PHP core, CVSS 9.2, patched 2026-10-21 with
 * the details leaked a day early and exploit attempts seen before disclosure. Every PHP from 5.4 through 8.5.11 is
 * affected; 8.2.35, 8.3.36, 8.4.27 and 8.5.12 are the first fixed releases of their lines, and nothing below 8.2 gets a
 * fix (CISA, https://www.cisa.gov/news-events/alerts/2026/10/21/critical-vulnerabilities-php-require-immediate-patching).
 *
 * This table is a FLOOR, and it only rises: php.net's current release of a line normally sits above it, and the floor
 * says which versions below that are not merely old but unsafe. Genie reads it in three places — the installer (never
 * install or offer a version under the floor), the toolchain probe (an installed PHP under the floor is a security
 * update, not an "update available"), and the PHP versions list (each managed or PATH version says so beside its
 * number). A line not in the table is unsupported: no fix exists for it, so the only answer is a supported line.
 */

export interface PhpAdvisory {
    readonly id: string;
    readonly cves: readonly string[];
    readonly url: string;
    /** `major.minor` → the first release of that line with the fix. A line absent here has no fix. */
    readonly fixedIn: Readonly<Record<string, string>>;
}

export const PHP_ADVISORIES: readonly PhpAdvisory[] = [
    {
        id: 'PHP2Shell',
        cves: ['CVE-2026-109618', 'CVE-2026-109619'],
        url: 'https://www.cisa.gov/news-events/alerts/2026/10/21/critical-vulnerabilities-php-require-immediate-patching',
        fixedIn: { '8.2': '8.2.35', '8.3': '8.3.36', '8.4': '8.4.27', '8.5': '8.5.12' },
    },
];

export type PhpVersionRisk =
    | { readonly risk: 'safe' }
    | { readonly risk: 'vulnerable'; readonly fixedIn: string; readonly cves: readonly string[]; readonly url: string }
    | { readonly risk: 'unsupported'; readonly cves: readonly string[]; readonly url: string; readonly supported: readonly string[] };

/** Numeric per segment, so 8.4.9 sits below 8.4.27 (a string compare puts it above). */
function below(a: string, b: string): boolean {
    const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d < 0;
    }
    return false;
}

/**
 * What a PHP version is, against every advisory: safe, vulnerable (and the first fixed release of its line), or on a
 * line no advisory has a fix for. A version that is not `major.minor.patch` is judged on the segments it has: `8.4` is
 * `8.4.0`, which is under every floor — a bare line is never called safe.
 */
export function phpVersionRisk(version: string): PhpVersionRisk {
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
    if (!m) return { risk: 'safe' };
    const line = `${m[1]}.${m[2]}`;
    const full = `${m[1]}.${m[2]}.${m[3] ?? '0'}`;
    for (const advisory of PHP_ADVISORIES) {
        const fixed = advisory.fixedIn[line];
        if (fixed === undefined) {
            return { risk: 'unsupported', cves: advisory.cves, url: advisory.url, supported: Object.values(advisory.fixedIn) };
        }
        if (below(full, fixed)) return { risk: 'vulnerable', fixedIn: fixed, cves: advisory.cves, url: advisory.url };
    }
    return { risk: 'safe' };
}

/** The words a person reads beside the version, or `null` for a safe one. Names the CVEs and what to do. */
export function phpAdvisoryText(version: string): string | null {
    const r = phpVersionRisk(version);
    if (r.risk === 'safe') return null;
    if (r.risk === 'vulnerable') return `PHP ${version} is vulnerable to ${r.cves.join(' / ')} (remote code execution); update to ${r.fixedIn}`;
    return `PHP ${version} is vulnerable to ${r.cves.join(' / ')} (remote code execution) and its line gets no fix; move to ${r.supported.join(', ')}`;
}
