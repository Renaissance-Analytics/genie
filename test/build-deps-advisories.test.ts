import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A KNOWN-VULNERABLE PACKAGE STAYS OUT OF THE LOCKFILE (Dependabot alert #75, GHSA-hp3w-g68c-fv3c: sprintf-js ≤ 1.1.3,
 * denial of service through unbounded precision specifiers; no patched release exists).
 *
 * It came in at BUILD time only: electron-builder → app-builder-lib → @electron/get@3 → global-agent@3 → roarr@2 →
 * sprintf-js. app-builder-lib (electron-builder 26.15.3, the latest) still pins @electron/get ^3; @electron/get@5 (what
 * electron itself uses) dropped global-agent, and global-agent@4 dropped roarr. So the override is global-agent ^4.1.3 —
 * CommonJS, still exporting the `bootstrap` @electron/get@3 requires (and only when ELECTRON_GET_USE_PROXY is set, inside
 * a try). Counted against the lockfile, so a reinstall that drifts back is red here, not a fresh alert weeks later.
 */
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, { version?: string }> };
const installed = (name: string): Array<{ at: string; version: string }> =>
    Object.entries(lock.packages)
        .filter(([at]) => at === `node_modules/${name}` || at.endsWith(`/node_modules/${name}`))
        .map(([at, p]) => ({ at, version: p.version ?? '' }));

describe('the lockfile', () => {
    it('carries no sprintf-js and no roarr (the chain that brought it)', () => {
        expect(installed('sprintf-js')).toEqual([]);
        expect(installed('roarr')).toEqual([]);
    });

    it('global-agent is 4.x wherever it is installed — and it IS installed (the override is what is under test)', () => {
        const ga = installed('global-agent');
        expect(ga.length).toBeGreaterThan(0);
        expect(ga.filter((g) => !g.version.startsWith('4.'))).toEqual([]);
    });

    it('the override is declared in package.json, so a fresh install resolves the same', () => {
        const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { overrides?: Record<string, unknown> };
        expect(pkg.overrides?.['global-agent']).toBe('^4.1.3');
    });
});
