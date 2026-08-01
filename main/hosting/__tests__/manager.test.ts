import { describe, expect, it, vi } from 'vitest';
import { createHostingManager } from '../manager';
import type { HostingManagerDeps } from '../manager';
import type { HostedSites } from '../sites-config';
import type { HostedSite, HostedStatus, SiteRuntime } from '../types';

/**
 * The hosting MANAGER — the piece that turns "this workspace has a site enabled"
 * into a running server.
 *
 * Its whole job is orchestration, and the orchestration is where the owner's
 * decisions live:
 *   - a PHP site fetches the FrankenPHP runtime on FIRST USE,
 *   - a STATIC site never does, and builds itself instead,
 *   - a site that is not RUNNING must not be advertised to the Testing Browser,
 *     because a hosted entry SHADOWS the discovered one for that hostname.
 *
 * Every dependency is injected, so nothing here downloads, builds or binds.
 */

// --- fakes -----------------------------------------------------------------

function fakeRuntime(backend: 'frankenphp' | 'static'): SiteRuntime & { started: HostedSite[] } {
    const entries = new Map<string, HostedStatus>();
    const started: HostedSite[] = [];
    return {
        backend,
        started,
        async start(site) {
            started.push(site);
            const status: HostedStatus = {
                siteId: site.id,
                state: 'running',
                backend,
                target: {
                    scheme: 'https',
                    hostname: site.hostname,
                    port: 20_000 + started.length,
                    loopback: '127.0.0.1',
                },
                origin: `https://${site.hostname}:${20_000 + started.length}`,
            };
            entries.set(site.id, status);
            return status;
        },
        async stop(siteId) {
            entries.delete(siteId);
        },
        status: (siteId) =>
            entries.get(siteId) ?? {
                siteId,
                state: 'stopped',
                backend,
                target: null,
                origin: null,
            },
        list: () => [...entries.values()],
        async stopAll() {
            entries.clear();
        },
    };
}

interface Harness {
    deps: HostingManagerDeps;
    php: ReturnType<typeof fakeRuntime>;
    stat: ReturnType<typeof fakeRuntime>;
    ensureRuntime: ReturnType<typeof vi.fn>;
    ensureBuilt: ReturnType<typeof vi.fn>;
}

const LARAVEL: HostedSites = {
    // keyed by hostedSiteIdFor('tynn.test') — the manager re-derives it, so the
    // literal key here only has to be stable, not correct.
    a: { enabled: true, hostname: 'tynn.test', kind: 'php', docroot: 'public' },
};

const FRONTEND: HostedSites = {
    b: { enabled: true, hostname: 'fancy.test', kind: 'static', docroot: 'dist' },
};

function harness(sites: Record<string, HostedSites> = { ws1: LARAVEL }): Harness {
    const php = fakeRuntime('frankenphp');
    const stat = fakeRuntime('static');
    const ensureRuntime = vi.fn(async () => ({
        version: 'v1.12.6',
        installDir: 'C:/ud/hosting/frankenphp/v1.12.6',
        binaryPath: 'C:/ud/hosting/frankenphp/v1.12.6/frankenphp.exe',
        extensionDir: 'C:/ud/hosting/frankenphp/v1.12.6/ext',
        downloaded: true,
    }));
    const ensureBuilt = vi.fn(async () => ({ built: true }));
    return {
        php,
        stat,
        ensureRuntime,
        ensureBuilt,
        deps: {
            baseDir: 'C:/ud',
            listWorkspaces: () =>
                Object.keys(sites).map((id) => ({ id, path: `C:/repos/${id}` })),
            hostedSitesFor: (id) => sites[id] ?? {},
            ensureRuntime,
            ensureBuilt,
            createFrankenPhp: () => php,
            createStatic: () => stat,
        },
    };
}

// --- starting --------------------------------------------------------------

describe('hosting manager', () => {
    it('fetches the PHP runtime on first use and serves the site', async () => {
        const h = harness();
        const m = createHostingManager(h.deps);
        const status = await m.start('ws1', 'tynn.test');

        expect(h.ensureRuntime).toHaveBeenCalledTimes(1);
        expect(status.state).toBe('running');
        expect(h.php.started[0]?.root.replace(/\\/g, '/')).toBe('C:/repos/ws1/public');
        expect(h.php.started[0]?.hostname).toBe('tynn.test');
    });

    it('never fetches a PHP runtime for a STATIC site', async () => {
        // The owner's decision in one assertion: most previews cost nothing.
        const h = harness({ ws1: FRONTEND });
        const m = createHostingManager(h.deps);
        const status = await m.start('ws1', 'fancy.test');
        expect(status.state).toBe('running');
        expect(h.ensureRuntime).not.toHaveBeenCalled();
        expect(h.stat.started).toHaveLength(1);
    });

    it('builds a static site before serving it, and never builds a PHP one', async () => {
        const front = harness({ ws1: FRONTEND });
        await createHostingManager(front.deps).start('ws1', 'fancy.test');
        expect(front.ensureBuilt).toHaveBeenCalledTimes(1);
        expect(front.ensureBuilt.mock.calls[0]?.[0]).toMatchObject({
            repoDir: 'C:/repos/ws1',
        });

        const php = harness();
        await createHostingManager(php.deps).start('ws1', 'tynn.test');
        // A Laravel app has no `dist/` to produce — its `public/` is checked in.
        expect(php.ensureBuilt).not.toHaveBeenCalled();
    });

    it('downloads the runtime ONCE across several PHP sites', async () => {
        const sites: HostedSites = {
            ...LARAVEL,
            c: { enabled: true, hostname: 'other.test', kind: 'php', docroot: 'public' },
        };
        const h = harness({ ws1: sites });
        const m = createHostingManager(h.deps);
        await m.start('ws1', 'tynn.test');
        await m.start('ws1', 'other.test');
        expect(h.ensureRuntime).toHaveBeenCalledTimes(1);
        expect(h.php.started).toHaveLength(2);
    });

    it('does not fetch twice when two starts race', async () => {
        // Two windows opening the Testing Browser at once must not start two
        // 277 MB downloads into the same staging area.
        const h = harness();
        const m = createHostingManager(h.deps);
        const [a, b] = await Promise.all([m.start('ws1', 'tynn.test'), m.start('ws1', 'tynn.test')]);
        expect(h.ensureRuntime).toHaveBeenCalledTimes(1);
        expect(h.php.started).toHaveLength(1);
        expect(a.state).toBe('running');
        expect(b).toEqual(a);
    });

    it('reports a failure as a failed STATUS, not a thrown error', async () => {
        // `reconcile()` starts every enabled site on boot; one site whose build
        // is broken must not abort the others or crash the app.
        const h = harness({ ws1: FRONTEND });
        h.ensureBuilt.mockRejectedValueOnce(new Error('vite: Cannot find name "oops"'));
        const m = createHostingManager(h.deps);
        const status = await m.start('ws1', 'fancy.test');
        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/oops/);
        expect(h.stat.started).toEqual([]);
    });

    it('refuses a site that is not configured, without touching a runtime', async () => {
        const h = harness();
        const m = createHostingManager(h.deps);
        const status = await m.start('ws1', 'nope.test');
        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/not configured|unknown/i);
        expect(h.ensureRuntime).not.toHaveBeenCalled();
    });
});

// --- reconcile -------------------------------------------------------------

describe('reconcile', () => {
    it('starts every ENABLED site and leaves disabled ones alone', async () => {
        const h = harness({
            ws1: {
                ...LARAVEL,
                off: { enabled: false, hostname: 'off.test', kind: 'static', docroot: 'dist' },
            },
            ws2: FRONTEND,
        });
        const m = createHostingManager(h.deps);
        await m.reconcile();
        expect(h.php.started.map((s) => s.hostname)).toEqual(['tynn.test']);
        expect(h.stat.started.map((s) => s.hostname)).toEqual(['fancy.test']);
    });

    it('stops a site that has since been disabled', async () => {
        const sites: HostedSites = { ...LARAVEL };
        const h = harness({ ws1: sites });
        const m = createHostingManager(h.deps);
        await m.reconcile();
        expect(h.php.list()).toHaveLength(1);

        sites.a = { ...sites.a!, enabled: false };
        await m.reconcile();
        expect(h.php.list()).toEqual([]);
    });
});

// --- what the Testing Browser sees -----------------------------------------

describe('genSites', () => {
    it('emits a RUNNING site as an EnabledGenSite the local carrier can dial', async () => {
        const h = harness();
        const m = createHostingManager(h.deps);
        const status = await m.start('ws1', 'tynn.test');
        expect(m.genSites()).toEqual([
            {
                workspaceId: 'ws1',
                genName: 'tynn.gen',
                siteId: status.siteId,
                hostname: 'tynn.test',
                scheme: 'https',
                port: status.target?.port,
                loopback: '127.0.0.1',
            },
        ]);
    });

    it('emits NOTHING for a site that is not running', async () => {
        // A hosted entry SHADOWS the hosts-file-discovered one for that
        // hostname. Advertising a site that failed to start would therefore
        // replace a working Herd target with a dead port — strictly worse than
        // not hosting at all.
        const h = harness({ ws1: FRONTEND });
        h.ensureBuilt.mockRejectedValueOnce(new Error('build broke'));
        const m = createHostingManager(h.deps);
        await m.start('ws1', 'fancy.test');
        expect(m.genSites()).toEqual([]);
    });

    it('emits nothing before anything has been started', () => {
        expect(createHostingManager(harness().deps).genSites()).toEqual([]);
    });
});

// --- listing for the Site Manager ------------------------------------------

describe('list', () => {
    it('reports every CONFIGURED site with its live state', async () => {
        const h = harness({
            ws1: {
                ...LARAVEL,
                off: { enabled: false, hostname: 'off.test', kind: 'static', docroot: 'dist' },
            },
        });
        const m = createHostingManager(h.deps);
        await m.start('ws1', 'tynn.test');
        const rows = m.list('ws1');
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.hostname === 'tynn.test')).toMatchObject({
            state: 'running',
            enabled: true,
            kind: 'php',
            genName: 'tynn.gen',
        });
        // A configured-but-off site is still listed — that is what the Site
        // Manager toggles.
        expect(rows.find((r) => r.hostname === 'off.test')).toMatchObject({
            state: 'stopped',
            enabled: false,
        });
    });

    it('REMEMBERS why a site failed to start', async () => {
        // A failed site never enters the live set, so reading state only from
        // the runtimes reports it as a plain `stopped` with no error — the user
        // is shown a site that simply "isn't on" when in fact its build is
        // broken, and the compiler output that says so is discarded.
        // Mutation-checked: this is the only test that fails without the
        // remembered status.
        const h = harness({ ws1: FRONTEND });
        h.ensureBuilt.mockRejectedValueOnce(new Error('vite: Cannot find name "oops"'));
        const m = createHostingManager(h.deps);
        await m.start('ws1', 'fancy.test');
        expect(m.list('ws1')[0]).toMatchObject({
            state: 'failed',
            error: expect.stringContaining('oops'),
        });
    });

    it('forgets a stale failure once the site comes up', async () => {
        const h = harness({ ws1: FRONTEND });
        h.ensureBuilt.mockRejectedValueOnce(new Error('build broke'));
        const m = createHostingManager(h.deps);
        await m.start('ws1', 'fancy.test');
        await m.start('ws1', 'fancy.test');
        expect(m.list('ws1')[0]).toMatchObject({ state: 'running' });
        expect(m.list('ws1')[0]?.error).toBeUndefined();
    });

    it('forgets a failure when the site is stopped', async () => {
        const h = harness({ ws1: FRONTEND });
        h.ensureBuilt.mockRejectedValueOnce(new Error('build broke'));
        const m = createHostingManager(h.deps);
        const status = await m.start('ws1', 'fancy.test');
        await m.stop(status.siteId);
        expect(m.list('ws1')[0]).toMatchObject({ state: 'stopped' });
        expect(m.list('ws1')[0]?.error).toBeUndefined();
    });
});

// --- teardown --------------------------------------------------------------

describe('stopAll', () => {
    it('stops both backends', async () => {
        const h = harness({ ws1: LARAVEL, ws2: FRONTEND });
        const m = createHostingManager(h.deps);
        await m.reconcile();
        await m.stopAll();
        expect(h.php.list()).toEqual([]);
        expect(h.stat.list()).toEqual([]);
        expect(m.genSites()).toEqual([]);
    });
});
