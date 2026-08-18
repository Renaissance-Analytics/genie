import { beforeEach, describe, expect, it, vi } from 'vitest';
import { devSiteIdFor, sanitizeDevSitePatch } from '../../dev-server/sites-config';
import type { DevSiteConfig, DevSites } from '../../dev-server/sites-config';
import type { DevSiteRow, DevSiteStatus } from '../../dev-server/site-manager';

/**
 * The HOST half of `manageSite` — `runManageSite`, the one implementation both the
 * MCP tool and the Site Manager UI run.
 *
 * Two failures live at exactly this layer, and both are the same shape: the tool
 * reporting an outcome it has not earned.
 *
 *   - **genie#194** — a start that takes longer than the MCP call is allowed to
 *     take blew the 120s transport cap. The caller got "The operation timed out"
 *     with no handle, while the start carried on unobserved. A long start has to
 *     come back PROMPTLY, saying it is still going and naming what to poll.
 *   - **genie#191** — `runMode:'recipe'` (and the other container run modes) are
 *     accepted, stored, and reported `running` while nothing is built and the
 *     `image` is never used. The sandbox-serve model has no per-site container and
 *     runs no build steps, so the honest answer is to REFUSE the mode.
 */

// --- the seams runManageSite reaches through --------------------------------

const store = vi.hoisted(() => {
    const sites: Record<string, DevSiteConfig> = {};
    return { sites };
});

const db = vi.hoisted(() => ({
    setWorkspaceDevSite: vi.fn(),
    deleteWorkspaceDevSite: vi.fn(),
}));

vi.mock('../../db', () => ({
    getWorkspaceDevSites: () => store.sites,
    setWorkspaceDevSite: db.setWorkspaceDevSite,
    deleteWorkspaceDevSite: db.deleteWorkspaceDevSite,
}));

const manager = vi.hoisted(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    reconfigure: vi.fn(),
    list: vi.fn(),
    logs: vi.fn(),
}));

vi.mock('../../dev-server/site-manager', () => ({ devSiteManager: () => manager }));
vi.mock('../../dev-server', () => ({
    resolveContainerRuntime: async () => ({ detection: { kind: 'docker', version: '29.6.1' } }),
}));
vi.mock('../../workspace/detect', () => ({ detectFolder: () => ({ repos: ['app'] }) }));
vi.mock('../../dev-server/repo-facts', () => ({
    describeRepoRun: () => repoRun.value,
    detectStaticServe: () => null,
}));
vi.mock('../host-tools', () => ({ resolveAgentTarget: async () => ({ decision: { allowed: false } }) }));

/** What `detect` reads off the repo — set per test. */
const repoRun = vi.hoisted(() => ({
    value: { options: [], recommended: null } as {
        options: Array<Record<string, unknown>>;
        recommended: Record<string, unknown> | null;
    },
}));

import { resetDevServerDetectionCache, runManageSite } from '../dev-site-tools';

const WS = { id: 'acme', path: '/work/acme', project_name: 'acme' };
const SITE_ID = devSiteIdFor('acme', 'web');

const SITE: DevSiteConfig = {
    name: 'web',
    genName: 'web.acme.gen',
    repo: 'app',
    runMode: 'host',
    command: ['php', 'artisan', 'serve'],
    kind: 'http',
    enabled: true,
};

const row = (over: Partial<DevSiteRow> = {}): DevSiteRow => ({
    siteId: SITE_ID,
    workspaceId: 'acme',
    name: 'web',
    genName: 'web.acme.gen',
    repo: 'app',
    runMode: 'host',
    kind: 'http',
    enabled: true,
    state: 'running',
    ready: true,
    ...over,
});

const status = (over: Partial<DevSiteStatus> = {}): DevSiteStatus => ({
    siteId: SITE_ID,
    workspaceId: 'acme',
    name: 'web',
    genName: 'web.acme.gen',
    state: 'running',
    ...over,
});

beforeEach(() => {
    resetDevServerDetectionCache();
    for (const key of Object.keys(store.sites)) delete store.sites[key];
    store.sites[SITE_ID] = SITE;
    repoRun.value = { options: [], recommended: null };
    db.setWorkspaceDevSite.mockReset();
    db.setWorkspaceDevSite.mockImplementation((_ws: string, patch: Partial<DevSiteConfig> & { siteId?: string }) => {
        const clean = sanitizeDevSitePatch(patch);
        const name = clean.name ?? (patch.siteId ? store.sites[patch.siteId]?.name : undefined);
        if (!name) return null;
        const id = devSiteIdFor('acme', name);
        store.sites[id] = { ...(store.sites[patch.siteId ?? id] ?? {}), ...clean, name } as DevSiteConfig;
        return id;
    });
    db.deleteWorkspaceDevSite.mockReset();
    for (const fn of Object.values(manager)) fn.mockReset();
    manager.list.mockReturnValue([row()]);
    manager.start.mockResolvedValue(status());
    manager.restart.mockResolvedValue(status());
    manager.reconfigure.mockResolvedValue(status());
    manager.stop.mockResolvedValue(undefined);
    manager.logs.mockResolvedValue('');
});

// --- genie#194: a long start answers, it does not time out -------------------

/** A lifecycle call that never settles — a cold image pull, a slow rebuild. */
const never = <T,>(): Promise<T> => new Promise<T>(() => {});

describe('a start that outlives the call (genie#194)', () => {
    it('returns a PENDING result naming what to poll, instead of blocking to the MCP timeout', async () => {
        manager.start.mockReturnValue(never<DevSiteStatus>());
        manager.list.mockReturnValue([row({ state: 'stopped', ready: undefined, phase: 'pulling' })]);

        const began = Date.now();
        const res = await runManageSite(WS, { action: 'start', id: SITE_ID }, { settleMs: 30 });

        expect(Date.now() - began).toBeLessThan(2_000);
        // Not an error — the start was accepted and IS running. But it has not
        // finished, and the result says so rather than implying a live site.
        expect(res.ok).toBe(true);
        expect(res.pending).toBe(true);
        expect(res.affectedId).toBe(SITE_ID);
        // The handle to poll is named, in the words the caller has to type.
        expect(res.notes?.join(' ')).toMatch(/status/i);
        expect(res.notes?.join(' ')).toContain(SITE_ID);
        // …and the live phase rides along, so the poll is informed.
        expect(res.sites[0]?.phase).toBe('pulling');
    });

    it('an `update` that triggers a restart is the same — it never blocks past the budget', async () => {
        manager.reconfigure.mockReturnValue(never<DevSiteStatus>());
        const res = await runManageSite(
            WS,
            { action: 'update', id: SITE_ID, command: ['npm', 'run', 'dev'] },
            { settleMs: 30 },
        );
        expect(res.ok).toBe(true);
        expect(res.pending).toBe(true);
        expect(res.affectedId).toBeTruthy();
    });

    it('a start that DOES settle in time reports the real outcome, with no pending flag', async () => {
        manager.start.mockResolvedValue(status({ state: 'failed', error: 'no such command' }));
        const res = await runManageSite(WS, { action: 'start', id: SITE_ID }, { settleMs: 5_000 });
        expect(res.pending).toBeUndefined();
        expect(res.ok).toBe(false);
        expect(res.error).toBe('no such command');
    });
});

// --- genie#191: an inert run mode is refused, not reported as running --------

describe('production run modes this build cannot run (genie#191)', () => {
    it('REFUSES `create` with runMode:"recipe" — and stores nothing, starts nothing', async () => {
        const res = await runManageSite(WS, {
            action: 'create',
            name: 'api',
            repo: 'app',
            runMode: 'recipe',
            image: 'dunglas/frankenphp:latest',
            command: ['php', 'artisan', 'serve'],
            port: 8080,
        });

        expect(res.ok).toBe(false);
        // The reason is specific: what it would have been, and what is missing.
        expect(res.error).toMatch(/recipe/i);
        expect(res.error).toMatch(/build/i);
        expect(res.error).toMatch(/image/i);
        // Nothing was recorded and nothing was started — the failure mode was a
        // site that reported `running` while doing none of it.
        expect(db.setWorkspaceDevSite).not.toHaveBeenCalled();
        expect(manager.start).not.toHaveBeenCalled();
    });

    it('REFUSES an `update` that switches a live site to runMode:"recipe"', async () => {
        // The exact report: `update {runMode:'recipe', image:'…'}` came back
        // `state: running` at once, recorded the image, and built nothing.
        const res = await runManageSite(WS, {
            action: 'update',
            id: SITE_ID,
            runMode: 'recipe',
            image: 'dunglas/frankenphp:latest',
        });

        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/recipe/i);
        expect(db.setWorkspaceDevSite).not.toHaveBeenCalled();
        expect(manager.reconfigure).not.toHaveBeenCalled();
    });

    it('refuses the other container modes too, each naming itself', async () => {
        for (const runMode of ['dockerfile', 'compose', 'devcontainer'] as const) {
            const res = await runManageSite(WS, {
                action: 'create',
                name: 'api',
                runMode,
                command: ['./server'],
                port: 8080,
            });
            expect(res.ok, runMode).toBe(false);
            expect(res.error, runMode).toContain(runMode);
        }
    });

    it('still runs the modes it CAN run', async () => {
        const res = await runManageSite(WS, {
            action: 'create',
            name: 'api',
            repo: 'app',
            command: ['npm', 'run', 'dev'],
            port: 5173,
        });
        expect(res.ok).toBe(true);
        expect(db.setWorkspaceDevSite).toHaveBeenCalled();
        expect(manager.start).toHaveBeenCalled();
    });

    it('never SILENTLY lands a bare `create` on a production recipe — it says why and offers the options', async () => {
        // No dev server could be picked for this repo, and the detected recipe is a
        // build+serve this build does not run. Adopting it anyway produced a site
        // that ran the serve argv with its build steps skipped.
        repoRun.value = {
            options: [
                {
                    runMode: 'recipe',
                    stack: 'rust',
                    source: 'Cargo.toml',
                    reason: 'A Rust crate — cargo build, then run the binary.',
                    build: [{ label: 'cargo build', command: ['cargo', 'build', '--release'] }],
                    serve: ['./target/release/app'],
                    port: 8080,
                    confident: false,
                },
            ],
            recommended: {
                runMode: 'recipe',
                stack: 'rust',
                source: 'Cargo.toml',
                reason: 'A Rust crate — cargo build, then run the binary.',
                build: [{ label: 'cargo build', command: ['cargo', 'build', '--release'] }],
                serve: ['./target/release/app'],
                port: 8080,
                confident: false,
            },
        };

        const res = await runManageSite(WS, { action: 'create', name: 'api', repo: 'app' });

        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/build/i);
        // The way forward is attached, not left to be guessed.
        expect(res.options?.length).toBeGreaterThan(0);
        expect(res.error).toMatch(/command|hostServe|hostPort/);
        expect(db.setWorkspaceDevSite).not.toHaveBeenCalled();
    });

    it('marks an unrunnable option in `detect`, so it is never offered as a working answer', async () => {
        repoRun.value = {
            options: [
                {
                    runMode: 'recipe',
                    stack: 'php',
                    source: 'composer.json',
                    reason: 'A PHP app — composer install, then FrankenPHP over public/.',
                    build: [{ label: 'composer', command: ['composer', 'install', '--no-dev'] }],
                    serve: ['frankenphp', 'php-server'],
                    port: 8080,
                    confident: true,
                },
            ],
            recommended: null,
        };
        const res = await runManageSite(WS, { action: 'detect', repo: 'app' });
        expect(res.ok).toBe(true);
        expect(res.options?.[0]?.needs).toMatch(/cannot run|not runnable|does not run/i);
    });
});

/** The sites map a workspace holds, as the mocked db reports it. */
export type { DevSites };
