import { describe, expect, it } from 'vitest';
import { buildPlanFor, ensureBuilt, isShellSafe, npmExecutable, npxExecutable } from '../build';
import type { BuildSeams } from '../build';

/**
 * Build-on-first-use for STATIC sites.
 *
 * Hosting a frontend means serving what `vite build` produced, not proxying
 * `npm run dev` — that is the whole reason the hosted origin is stable and
 * same-origin. So the runtime has to be able to produce a `dist/` when the user
 * has never run a build, and it has to be honest when it cannot.
 *
 * The decision of WHAT to run is pure and pinned here; the running itself is an
 * injected seam, so nothing in this file spawns npm.
 */

// --- fakes -----------------------------------------------------------------

function seams(
    opts: {
        pkg?: unknown;
        /** Paths that exist before the build. */
        existing?: string[];
        /** Paths the build creates. */
        produces?: string[];
        code?: number;
        output?: string;
    } = {},
): {
    seams: BuildSeams;
    runs: Array<{ command: string; args: string[]; cwd: string; shell: boolean }>;
} {
    const files = new Set((opts.existing ?? []).map((p) => p.replace(/\\/g, '/')));
    const runs: Array<{ command: string; args: string[]; cwd: string; shell: boolean }> = [];
    return {
        runs,
        seams: {
            async readPackageJson() {
                if (opts.pkg === null) return null;
                return (opts.pkg ?? { scripts: { build: 'vite build' } }) as Record<
                    string,
                    unknown
                >;
            },
            async fileExists(p) {
                return files.has(p.replace(/\\/g, '/'));
            },
            async run(command, args, cwd, runOpts) {
                runs.push({ command, args, cwd, shell: runOpts.shell });
                for (const p of opts.produces ?? []) files.add(p.replace(/\\/g, '/'));
                return { code: opts.code ?? 0, output: opts.output ?? '' };
            },
        },
    };
}

const REPO = 'C:/repos/app';
const DOCROOT = 'C:/repos/app/dist';

// --- pure ------------------------------------------------------------------

describe('buildPlanFor', () => {
    it('prefers the package\'s OWN build script', () => {
        // The repo's script is the contract its author wrote — it may set env,
        // chain a type-check, or build something other than vite. Running our
        // own guess instead would produce a different artifact than the one the
        // project's CI ships.
        expect(buildPlanFor({ scripts: { build: 'tsc && vite build' } }, 'linux')).toEqual({
            command: 'npm',
            args: ['run', 'build'],
        });
    });

    it('falls back to `vite build` when vite is a dependency but no script exists', () => {
        expect(buildPlanFor({ devDependencies: { vite: '^7.0.0' } }, 'linux')).toEqual({
            command: 'npx',
            args: ['--no-install', 'vite', 'build'],
        });
        expect(buildPlanFor({ dependencies: { vite: '^7.0.0' } }, 'linux')).toEqual({
            command: 'npx',
            args: ['--no-install', 'vite', 'build'],
        });
    });

    it('returns null when there is nothing to run', () => {
        expect(buildPlanFor({ scripts: { test: 'vitest' } }, 'linux')).toBeNull();
        expect(buildPlanFor(null, 'linux')).toBeNull();
        expect(buildPlanFor({}, 'linux')).toBeNull();
    });

    it('uses the .cmd shims on Windows', () => {
        expect(npmExecutable('win32')).toBe('npm.cmd');
        expect(npxExecutable('win32')).toBe('npx.cmd');
        expect(npmExecutable('darwin')).toBe('npm');
        expect(buildPlanFor({ scripts: { build: 'x' } }, 'win32')?.command).toBe('npm.cmd');
    });
});

describe('isShellSafe', () => {
    it('holds for every plan the planner can actually emit', () => {
        // Windows leaves no choice about using a shell (Node refuses to spawn a
        // `.cmd` without one since the CVE-2024-27980 hardening — the first
        // real run of this failed with EINVAL). So the property that has to
        // hold instead is that the argv is ours alone. This pins that for every
        // plan `buildPlanFor` can produce.
        for (const platform of ['win32', 'linux'] as const) {
            for (const pkg of [
                { scripts: { build: 'vite build' } },
                { devDependencies: { vite: '^7' } },
            ]) {
                const plan = buildPlanFor(pkg, platform)!;
                expect(isShellSafe(plan)).toBe(true);
            }
        }
    });

    it('catches a project-supplied string reaching the command line', () => {
        // The guard exists for the change that has not happened yet: passing a
        // package.json value through as an ARGUMENT. A repo could then name its
        // build `x && curl evil` and Genie would run it.
        expect(isShellSafe({ command: 'npm.cmd', args: ['run', 'build && whoami'] })).toBe(false);
        expect(isShellSafe({ command: 'npm.cmd', args: ['run', '$(id)'] })).toBe(false);
        expect(isShellSafe({ command: 'npm.cmd', args: ['run', 'build\nwhoami'] })).toBe(false);
    });
});

// --- ensureBuilt -----------------------------------------------------------

describe('ensureBuilt', () => {
    it('does nothing when the docroot already holds a built app', async () => {
        const s = seams({ existing: [`${DOCROOT}/index.html`] });
        const result = await ensureBuilt({ repoDir: REPO, docroot: DOCROOT, seams: s.seams });
        expect(result.built).toBe(false);
        expect(s.runs).toEqual([]);
    });

    it('runs the build in the REPO, not the docroot, when nothing is built yet', async () => {
        const s = seams({
            existing: [`${REPO}/node_modules`],
            produces: [`${DOCROOT}/index.html`],
        });
        const result = await ensureBuilt({
            repoDir: REPO,
            docroot: DOCROOT,
            platform: 'linux',
            seams: s.seams,
        });
        expect(result.built).toBe(true);
        expect(s.runs).toEqual([
            { command: 'npm', args: ['run', 'build'], cwd: REPO, shell: false },
        ]);
    });

    it('uses a shell ONLY on Windows, where npm cannot be spawned without one', async () => {
        const s = seams({
            existing: [`${REPO}/node_modules`],
            produces: [`${DOCROOT}/index.html`],
        });
        await ensureBuilt({ repoDir: REPO, docroot: DOCROOT, platform: 'win32', seams: s.seams });
        expect(s.runs[0]).toMatchObject({ command: 'npm.cmd', shell: true });
    });

    it('rebuilds nothing on the second call', async () => {
        const s = seams({
            existing: [`${REPO}/node_modules`],
            produces: [`${DOCROOT}/index.html`],
        });
        await ensureBuilt({ repoDir: REPO, docroot: DOCROOT, platform: 'linux', seams: s.seams });
        await ensureBuilt({ repoDir: REPO, docroot: DOCROOT, platform: 'linux', seams: s.seams });
        expect(s.runs).toHaveLength(1);
    });

    it('says to install dependencies rather than running a build that cannot work', async () => {
        // `npm run build` with no node_modules fails with a message about a
        // missing binary, several frames away from the actual cause.
        const s = seams({ existing: [] });
        await expect(
            ensureBuilt({ repoDir: REPO, docroot: DOCROOT, platform: 'linux', seams: s.seams }),
        ).rejects.toThrow(/npm install/);
        expect(s.runs).toEqual([]);
    });

    it('reports that the project has no build at all', async () => {
        const s = seams({ pkg: { scripts: {} }, existing: [`${REPO}/node_modules`] });
        await expect(
            ensureBuilt({ repoDir: REPO, docroot: DOCROOT, platform: 'linux', seams: s.seams }),
        ).rejects.toThrow(/no build script/i);
    });

    it('surfaces the build OUTPUT when the build fails', async () => {
        // A hosted site that will not start is only actionable if the reason —
        // the compiler's own error — reaches the user.
        const s = seams({
            existing: [`${REPO}/node_modules`],
            code: 1,
            output: 'src/main.ts(3,1): error TS2304: Cannot find name "oops".',
        });
        await expect(
            ensureBuilt({ repoDir: REPO, docroot: DOCROOT, platform: 'linux', seams: s.seams }),
        ).rejects.toThrow(/TS2304/);
    });

    it('fails when a build "succeeds" but produced nothing to serve', async () => {
        // Exit 0 with an empty docroot means the project builds somewhere else.
        // Reporting `running` would give the Testing Browser an origin that 404s
        // on `/`.
        const s = seams({ existing: [`${REPO}/node_modules`], code: 0, produces: [] });
        await expect(
            ensureBuilt({ repoDir: REPO, docroot: DOCROOT, platform: 'linux', seams: s.seams }),
        ).rejects.toThrow(/index\.html/);
    });
});
