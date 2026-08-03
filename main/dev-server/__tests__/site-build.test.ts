import { describe, expect, it, vi } from 'vitest';
import { BUILD_STEP_TIMEOUT_MS, runSiteBuild } from '../site-build';
import type { CommandResult, ExecOptions } from '../container-runtime';
import type { SiteBuildDeps } from '../site-build';

/**
 * THE PRODUCTION BUILD — the stage the Hosting Manager added.
 *
 * A hosted site is an ARTIFACT plus a production server, so something has to
 * make the artifact. It runs by `exec`ing into the workspace's long-lived
 * sandbox container, which is the only place that has the toolchain: the site's
 * own container may be FrankenPHP or nginx, which can serve a build but cannot
 * produce one.
 *
 * Three properties are asserted, and each of them is a way this could quietly
 * host the wrong thing:
 *
 *   - **Order, and stopping.** Steps run in sequence, and a REQUIRED step that
 *     fails stops the build — a `composer install` that failed followed by a
 *     server that starts anyway is a site serving yesterday's vendor directory.
 *   - **Optional steps do not stop it.** `collectstatic` on a project with no
 *     STATIC_ROOT is a normal, harmless failure.
 *   - **The output is kept.** A failed build whose log was discarded is
 *     unactionable, and this is driven by agents that get nothing else.
 */

const okResult = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const failResult = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr });

type ExecFn = SiteBuildDeps['exec'];

const deps = (exec: ExecFn) => ({
    exec,
    containerId: 'sandbox-1',
    workdir: '/workspace/repos/api',
});

describe('runSiteBuild', () => {
    it('runs every step in order, in the site’s workdir, with the site’s env', async () => {
        const seen: Array<{ argv: string[]; opts?: ExecOptions }> = [];
        const exec: ExecFn = async (_id, argv, opts) => {
            seen.push({ argv, ...(opts ? { opts } : {}) });
            return okResult('done');
        };
        const result = await runSiteBuild(
            [
                { label: 'Install', command: ['npm', 'ci'] },
                { label: 'Build', command: ['npm', 'run', 'build'] },
            ],
            { ...deps(exec), env: { DATABASE_URL: 'postgresql://x' } },
        );
        expect(result.ok).toBe(true);
        expect(seen.map((c) => c.argv.join(' '))).toEqual(['npm ci', 'npm run build']);
        expect(seen[0]?.opts?.workdir).toBe('/workspace/repos/api');
        // The build gets the same environment the server will — a build that
        // reads DATABASE_URL (a migration, a static-site data fetch) must see
        // the same database the running app will.
        expect((seen[0]?.opts?.env as Record<string, string>).DATABASE_URL).toBe('postgresql://x');
        expect(seen[0]?.opts?.timeoutMs).toBe(BUILD_STEP_TIMEOUT_MS);
    });

    it('STOPS at the first required failure and never runs what follows', async () => {
        const exec = vi
            .fn()
            .mockResolvedValueOnce(failResult('Your requirements could not be resolved'))
            .mockResolvedValue(okResult());
        const result = await runSiteBuild(
            [
                { label: 'Install PHP dependencies', command: ['composer', 'install'] },
                { label: 'Build assets', command: ['npm', 'run', 'build'] },
            ],
            deps(exec),
        );
        expect(result.ok).toBe(false);
        expect(exec).toHaveBeenCalledTimes(1);
        // The failure names the STEP, not just the exit code — "the build failed"
        // is not something an agent can act on.
        expect(result.error).toContain('Install PHP dependencies');
        expect(result.error).toContain('could not be resolved');
    });

    it('carries on past an OPTIONAL failure, and says it happened', async () => {
        const exec = vi
            .fn()
            .mockResolvedValueOnce(okResult())
            .mockResolvedValueOnce(failResult('You have not set STATIC_ROOT'))
            .mockResolvedValue(okResult());
        const result = await runSiteBuild(
            [
                { label: 'Install', command: ['uv', 'sync'] },
                { label: 'Collect static', command: ['python', 'manage.py'], optional: true },
                { label: 'Compile', command: ['go', 'build'] },
            ],
            deps(exec),
        );
        expect(result.ok).toBe(true);
        expect(exec).toHaveBeenCalledTimes(3);
        expect(result.steps[1]).toMatchObject({ label: 'Collect static', ok: false, skipped: true });
        expect(result.log).toContain('STATIC_ROOT');
    });

    it('keeps the output of every step, so a green build is still readable', async () => {
        const exec = vi.fn(async () => okResult('added 402 packages'));
        const result = await runSiteBuild([{ label: 'Install', command: ['npm', 'ci'] }], deps(exec));
        expect(result.log).toContain('Install');
        expect(result.log).toContain('added 402 packages');
    });

    it('an empty build is a success that ran nothing', async () => {
        const exec = vi.fn(async () => okResult());
        const result = await runSiteBuild([], deps(exec));
        expect(result.ok).toBe(true);
        expect(exec).not.toHaveBeenCalled();
    });

    it('treats a thrown exec as a failed step, not a crashed lifecycle', async () => {
        // The site manager's house rule: failures are STATUSES. An exception
        // escaping here becomes an MCP tool error with no build log attached.
        const exec = vi.fn(async () => {
            throw new Error('docker daemon went away');
        });
        const result = await runSiteBuild([{ label: 'Install', command: ['npm', 'ci'] }], deps(exec));
        expect(result.ok).toBe(false);
        expect(result.error).toContain('docker daemon went away');
    });

    // --- secret scrubbing (genie #119) --------------------------------------
    //
    // The build injects a managed GitHub token (COMPOSER_AUTH / GITHUB_TOKEN) so
    // composer and npm can fetch private/rate-limited github.com deps. That token
    // must NEVER reach the surfaced build log — which the UI shows verbatim.

    it('SCRUBS injected secrets out of the surfaced build log', async () => {
        const token = 'ghs_SUPERSECRET';
        const exec: ExecFn = async () => okResult(`composer using github-oauth ${token} for github.com`);
        const result = await runSiteBuild(
            [{ label: 'Install PHP dependencies', command: ['composer', 'install'] }],
            { ...deps(exec), secrets: [token] },
        );
        expect(result.ok).toBe(true);
        expect(result.log).not.toContain(token);
        expect(result.log).toContain('***');
    });

    it('scrubs secrets out of a FAILED step error, where a leaked token would be most visible', async () => {
        const token = 'ghs_SUPERSECRET';
        const exec: ExecFn = async () => failResult(`auth against github.com failed with token ${token}`);
        const result = await runSiteBuild(
            [{ label: 'Install PHP dependencies', command: ['composer', 'install'] }],
            { ...deps(exec), secrets: [token] },
        );
        expect(result.ok).toBe(false);
        expect(result.error).not.toContain(token);
        expect(result.log).not.toContain(token);
    });

    it('scrubs secrets from live progress output too', async () => {
        const token = 'ghs_SUPERSECRET';
        const chunks: string[] = [];
        const exec: ExecFn = async () => okResult(`downloading from https://x-access-token:${token}@github.com`);
        await runSiteBuild(
            [{ label: 'Install', command: ['npm', 'ci'] }],
            { ...deps(exec), secrets: [token], onProgress: (c) => chunks.push(c) },
        );
        expect(chunks.join('')).not.toContain(token);
    });
});
