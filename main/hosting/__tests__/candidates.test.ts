import { describe, expect, it } from 'vitest';
import {
    BUILD_OUTPUT_DIRS,
    candidateHostname,
    candidatesFrom,
    candidatesForWorkspace,
    scanWorkspaceCandidates,
    siteSlug,
    type CandidateSeams,
    type ProjectScan,
} from '../candidates';

/**
 * Candidate detection (Tynn #232, hosting UX).
 *
 * The Site Manager's job is to answer "what in this workspace COULD Genie
 * serve?" without the user typing a document root. Everything here is the pure
 * half of that: given what exists on disk, which sites are offered, with which
 * backend, from which directory. The fs walk itself is one thin function with
 * injected seams, tested with a fake tree.
 */

const scan = (over: Partial<ProjectScan> = {}): ProjectScan => ({
    dir: 'repos/tynn',
    name: 'tynn',
    publicIndexPhp: false,
    indexPhp: false,
    built: [],
    buildable: false,
    ...over,
});

describe('siteSlug', () => {
    it('lowercases and hyphenates a repo name', () => {
        expect(siteSlug('Tynn')).toBe('tynn');
        expect(siteSlug('my_cool.app')).toBe('my-cool-app');
        expect(siteSlug('  spaced  name ')).toBe('spaced-name');
    });

    it('drops a .agi envelope suffix and collapses junk', () => {
        expect(siteSlug('tynn.agi')).toBe('tynn');
        expect(siteSlug('--weird--')).toBe('weird');
    });

    it('falls back to a usable label when the name slugs to nothing', () => {
        expect(siteSlug('///')).toBe('site');
        expect(siteSlug('')).toBe('site');
    });
});

describe('candidateHostname', () => {
    it('suggests <slug>.test', () => {
        expect(candidateHostname('tynn')).toBe('tynn.test');
    });

    it('qualifies a second site in the same project so the two never collide', () => {
        expect(candidateHostname('tynn', 'dist')).toBe('tynn-dist.test');
    });
});

describe('candidatesFrom — PHP', () => {
    it('offers a php site rooted at public/ when there is a front controller there', () => {
        const [php] = candidatesFrom(scan({ publicIndexPhp: true }));
        expect(php).toMatchObject({
            kind: 'php',
            docroot: 'repos/tynn/public',
            hostname: 'tynn.test',
            needsBuild: false,
        });
        expect(php?.reason).toMatch(/public\/index\.php/);
    });

    it('falls back to the project root when index.php sits there', () => {
        const [php] = candidatesFrom(scan({ indexPhp: true }));
        expect(php).toMatchObject({ kind: 'php', docroot: 'repos/tynn' });
    });

    it('prefers public/ over a root index.php — that is the only safe docroot', () => {
        const found = candidatesFrom(scan({ publicIndexPhp: true, indexPhp: true }));
        expect(found.filter((c) => c.kind === 'php')).toHaveLength(1);
        expect(found[0]?.docroot).toBe('repos/tynn/public');
    });

    it('serves the workspace root itself when the project IS the workspace', () => {
        const [php] = candidatesFrom(scan({ dir: '', name: 'site', publicIndexPhp: true }));
        expect(php?.docroot).toBe('public');
    });
});

describe('candidatesFrom — static', () => {
    it('offers a built output directory as a static site', () => {
        const [site] = candidatesFrom(scan({ built: ['dist'] }));
        expect(site).toMatchObject({
            kind: 'static',
            docroot: 'repos/tynn/dist',
            hostname: 'tynn.test',
            needsBuild: false,
        });
    });

    it('offers an UNBUILT project too, flagged so the UI can say so', () => {
        const [site] = candidatesFrom(scan({ buildable: true }));
        expect(site).toMatchObject({
            kind: 'static',
            docroot: 'repos/tynn/dist',
            needsBuild: true,
        });
        expect(site?.reason).toMatch(/build/i);
    });

    it('prefers what is BUILT over what merely could be', () => {
        const found = candidatesFrom(scan({ built: ['dist'], buildable: true }));
        expect(found).toHaveLength(1);
        expect(found[0]?.needsBuild).toBe(false);
    });

    it('offers every built output dir, in preference order', () => {
        const found = candidatesFrom(scan({ built: ['build', 'dist'] }));
        expect(found.map((c) => c.docroot)).toEqual([
            'repos/tynn/dist',
            'repos/tynn/build',
        ]);
    });

    it('gives the second site in a project its own hostname', () => {
        const found = candidatesFrom(scan({ publicIndexPhp: true, built: ['dist'] }));
        expect(found.map((c) => c.hostname)).toEqual(['tynn.test', 'tynn-dist.test']);
    });

    it('never offers the same docroot twice', () => {
        // A PHP app whose public/ also holds an index.html — one site, not two.
        const found = candidatesFrom(scan({ publicIndexPhp: true, built: ['public'] }));
        expect(found).toHaveLength(1);
        expect(found[0]?.kind).toBe('php');
    });

    it('offers nothing for a project with neither PHP nor a build', () => {
        expect(candidatesFrom(scan())).toEqual([]);
    });
});

describe('candidatesForWorkspace', () => {
    it('keeps every project distinct and never repeats a hostname', () => {
        const found = candidatesForWorkspace([
            scan({ dir: 'repos/tynn', name: 'tynn', publicIndexPhp: true }),
            // Two repos whose names slug identically would otherwise both claim
            // tynn.test — and the second would silently overwrite the first's
            // stored config, since the site id is derived from the hostname.
            scan({ dir: 'repos/Tynn-UI', name: 'tynn_ui', built: ['dist'] }),
            scan({ dir: 'repos/tynn-ui', name: 'tynn.ui', built: ['dist'] }),
        ]);
        const hostnames = found.map((c) => c.hostname);
        expect(new Set(hostnames).size).toBe(hostnames.length);
        expect(hostnames[0]).toBe('tynn.test');
    });

    it('every suggested hostname is a valid vhost', () => {
        const found = candidatesForWorkspace([
            scan({ dir: '', name: 'my project.agi', publicIndexPhp: true }),
        ]);
        expect(found[0]?.hostname).toBe('my-project.test');
    });
});

describe('scanWorkspaceCandidates', () => {
    /** A fake tree: a set of POSIX paths that "exist", plus package.json bodies. */
    const seamsFor = (
        paths: string[],
        pkgs: Record<string, Record<string, unknown>> = {},
        repos: string[] = [],
    ): CandidateSeams => {
        const set = new Set(paths.map((p) => p.replace(/\\/g, '/')));
        return {
            listRepos: () => repos,
            exists: (p) => set.has(p.replace(/\\/g, '/')),
            readPackageJson: (dir) => pkgs[dir.replace(/\\/g, '/')] ?? null,
        };
    };

    it('finds a Laravel app in a repo', () => {
        const found = scanWorkspaceCandidates(
            '/ws/tynn.agi',
            seamsFor(['/ws/tynn.agi/repos/tynn/public/index.php'], {}, ['tynn']),
        );
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
            kind: 'php',
            docroot: 'repos/tynn/public',
            project: 'repos/tynn',
        });
    });

    it('finds a built frontend, and an unbuilt one via its package.json', () => {
        const found = scanWorkspaceCandidates(
            '/ws/app.agi',
            seamsFor(
                [
                    '/ws/app.agi/repos/site/dist/index.html',
                    '/ws/app.agi/repos/ui/package.json',
                ],
                { '/ws/app.agi/repos/ui': { scripts: { build: 'vite build' } } },
                ['site', 'ui'],
            ),
        );
        expect(found.map((c) => [c.project, c.needsBuild])).toEqual([
            ['repos/site', false],
            ['repos/ui', true],
        ]);
    });

    it('scans the workspace root too, for a plain-folder project', () => {
        const found = scanWorkspaceCandidates(
            '/ws/plain',
            seamsFor(['/ws/plain/public/index.php']),
        );
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ project: '', docroot: 'public' });
    });

    it('is empty — never throws — for a workspace with nothing hostable', () => {
        expect(scanWorkspaceCandidates('/ws/empty', seamsFor([]))).toEqual([]);
    });

    it('only treats a build-output dir as built when it holds an index.html', () => {
        const found = scanWorkspaceCandidates(
            '/ws/app',
            // dist/ exists but is empty — that is not a servable site.
            seamsFor(['/ws/app/repos/site/dist'], {}, ['site']),
        );
        expect(found).toEqual([]);
    });

    it('looks at exactly the known build-output directories', () => {
        expect(BUILD_OUTPUT_DIRS).toContain('dist');
        expect(BUILD_OUTPUT_DIRS[0]).toBe('dist');
    });
});
