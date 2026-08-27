import { describe, expect, it } from 'vitest';
import { validateAppFolder, type FolderProbe } from '../validate';

/**
 * A GApp source folder laid out the way GENIE LAYS ONE OUT must validate.
 *
 * WHY THIS EXISTS, stated accurately: an agent preparing `remotion.gapp` to
 * become a GApp Development Workspace reported that `validateAppManifest`
 * returned ok while `validateAppFolder` then failed —
 *
 *     The front end is served from "dist", but <folder>emotion-dock\dist
 *     does not exist.
 *
 * — every path short of one `repos/` segment. That is real, but it is real on
 * the checkout it was run against (`repos/genie` at 6e7e366, a feature branch),
 * NOT on main. Main resolves this correctly already: `gappSourceLayout` detects
 * an envelope by its `project.json` and `componentSourceDir` then joins
 * `repos/<name>`.
 *
 * So this is a REGRESSION PIN, not a fix. It is worth having because the
 * behaviour has two moving parts that look independent — a marker file decides
 * the layout, and a different module resolves the path — and nothing previously
 * asserted that an envelope-shaped GApp validates end to end. Losing it fails
 * exactly the way the report describes: a manifest that passes, and a folder
 * check that says everything is missing.
 *
 * The `project.json` in each fixture below is load-bearing for that reason: it
 * is what tells Genie to look under `repos/` at all.
 */
const MANIFEST = JSON.stringify({
    id: 'ai.tynn.example',
    slug: 'example',
    name: 'Example',
    version: '0.1.0',
    description: 'An app for the test.',
    frontend: { repo: 'example-dock', serve: { mode: 'static', root: 'dist', spa: true } },
    services: [{ name: 'renderer', repo: 'example-tools', command: ['node', 'src/serve.mjs'], port: 8797 }],
});

/** A probe whose filesystem is exactly the listed set of paths. */
function probeWith(present: string[]): FolderProbe {
    const set = new Set(present.map((p) => p.replace(/\\/g, '/')));
    return {
        readManifest: () => MANIFEST,
        exists: (abs) => set.has(abs.replace(/\\/g, '/')),
        slugTaken: () => false,
    };
}

const ROOT = 'C:/apps/example.gapp';

describe('a GApp source folder using the repos/ layout', () => {
    it('validates when its components live under repos/', () => {
        const probe = probeWith([
            // The envelope MARKER. `gappSourceLayout` keys off `project.json`,
            // which is what tells Genie to look under `repos/` at all.
            `${ROOT}/project.json`,
            `${ROOT}/repos/example-dock`,
            `${ROOT}/repos/example-dock/dist`,
            `${ROOT}/repos/example-tools`,
        ]);

        const report = validateAppFolder(ROOT, probe);

        expect(report.errors).toEqual([]);
        expect(report.ok).toBe(true);
    });

    it('still validates a FLAT folder, which is a legitimate single-repo layout', () => {
        // Positive control for the case above AND a real compatibility promise:
        // fixing the envelope case must not break the layout that already worked.
        const probe = probeWith([
            `${ROOT}/example-dock`,
            `${ROOT}/example-dock/dist`,
            `${ROOT}/example-tools`,
        ]);

        const report = validateAppFolder(ROOT, probe);

        expect(report.errors).toEqual([]);
        expect(report.ok).toBe(true);
    });

    it('still FAILS when the component is in neither place', () => {
        // The negative control. Without it, "repos/ validates" would pass just as
        // happily against a validator that stopped checking the filesystem — which
        // is the failure this check exists to catch: a GApp that installs and then
        // opens on nothing.
        const report = validateAppFolder(ROOT, probeWith([]));

        expect(report.ok).toBe(false);
        expect(report.errors.length).toBeGreaterThan(0);
        expect(report.errors.join(' ')).toContain('example-dock');
    });

    it('fails when the repo is there but the served ROOT inside it is not', () => {
        // A built frontend that was never built. The directory existing is not
        // the same claim as the thing it is supposed to serve existing.
        const probe = probeWith([
            `${ROOT}/project.json`,
            `${ROOT}/repos/example-dock`,
            `${ROOT}/repos/example-tools`,
        ]);

        const report = validateAppFolder(ROOT, probe);

        expect(report.ok).toBe(false);
        expect(report.errors.join(' ')).toContain('dist');
    });
});
