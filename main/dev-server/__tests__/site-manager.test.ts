import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDevSiteManager } from '../site-manager';
import {
    defaultGenNameFor,
    devSiteIdFor,
    devSiteReconfigureNeedsRestart,
    parseDevSites,
    sanitizeDevSitePatch,
} from '../sites-config';
import { SITE_LABEL, siteContainerNameFor } from '../argv';
import { FRANKENPHP_IMAGE } from '../serve-recipe';
import type { DevSiteConfig, DevSites } from '../sites-config';
import type {
    ContainerRuntime,
    ContainerSpec,
    ContainerSummary,
    ImageBuildSpec,
    PortMapping,
    RuntimeDetection,
} from '../container-runtime';

/**
 * The DEV SITE MANAGER (Tynn #234, P2 items 3 + 4) — the piece that turns "this
 * workspace defines a site" into a container serving it, and into the ONE row
 * the Genie Browser already knows how to route.
 *
 * Two things are being proven here, and the second is the whole phase:
 *
 *   1. A site runs **in the workspace sandbox** — the workspace's network, the
 *      workspace's bind mount, the workspace's labels — with exactly its own
 *      port published to loopback.
 *   2. A running site emits an `EnabledGenSite` whose target is that PUBLISHED
 *      LOOPBACK PORT. That is the salvage seam: `sites/local-sites.ts` already
 *      overlays such rows, `localTargetsBySiteId` already resolves them, and the
 *      local carrier already dials them — so `<name>.gen` serves the container
 *      with no change to any of it, local or remote.
 */

// --- a fake runtime ---------------------------------------------------------

const DOCKER_OK: RuntimeDetection = { kind: 'docker', version: '29.6.1', probes: [] };

interface Fake extends ContainerRuntime {
    readonly ran: ContainerSpec[];
    readonly built: ImageBuildSpec[];
    readonly removed: string[];
    readonly containers: Map<string, ContainerSummary>;
    /** What `portMappings` answers, per container id. */
    readonly ports: Map<string, PortMapping[]>;
}

function fakeRuntime(opts: { detection?: RuntimeDetection; existing?: ContainerSummary[] } = {}): Fake {
    const ran: ContainerSpec[] = [];
    const built: ImageBuildSpec[] = [];
    const removed: string[] = [];
    const containers = new Map<string, ContainerSummary>(
        (opts.existing ?? []).map((c) => [c.name, c]),
    );
    const ports = new Map<string, PortMapping[]>();

    return {
        kind: 'docker',
        ran,
        built,
        removed,
        containers,
        ports,
        async detect() {
            return opts.detection ?? DOCKER_OK;
        },
        async networkEnsure(workspaceId) {
            return { name: `genie-ws-${workspaceId}`, created: false };
        },
        async networkRemove() {},
        async networkEnsureNamed(name) {
            return { name, created: false };
        },
        async networkConnect() {},
        async networkDisconnect() {},
        async volumeRemove() {},
        async imageExists() {
            return true;
        },
        async pullImage(image) {
            return { ok: true, image };
        },
        async buildImage(spec) {
            built.push(spec);
            return { ok: true, image: spec.tag };
        },
        async runContainer(spec) {
            ran.push(spec);
            const id = `id-${spec.name}`;
            containers.set(spec.name, {
                id,
                name: spec.name,
                image: spec.image,
                state: 'running',
                ...(spec.workspaceId === null ? {} : { workspaceId: spec.workspaceId }),
            });
            // The runtime picks an ephemeral host port at CREATE time — which is
            // exactly why a published port cannot be added to a container that
            // is already running, and why a site gets its own container.
            ports.set(
                id,
                (spec.ports ?? []).map((p) => ({
                    container: p.container,
                    protocol: 'tcp' as const,
                    hostIp: p.hostIp ?? '127.0.0.1',
                    hostPort: p.host ?? 49_800,
                })),
            );
            return { id, name: spec.name };
        },
        async start() {},
        async stop() {},
        async remove(id) {
            removed.push(id);
            for (const [name, c] of containers) if (c.id === id) containers.delete(name);
        },
        async exec() {
            return { code: 0, stdout: '', stderr: '' };
        },
        async logs() {
            return 'listening on 0.0.0.0:8000\n';
        },
        followLogs() {
            return { stop() {}, exited: Promise.resolve(0) };
        },
        async psServices() {
            return [];
        },
        async ps(workspaceId) {
            return [...containers.values()].filter((c) => !workspaceId || c.workspaceId === workspaceId);
        },
        async portMappings(id) {
            return ports.get(id) ?? [];
        },
    };
}

// --- fixtures ---------------------------------------------------------------

const WS = { id: 'acme', path: '/work/acme', label: 'acme' };

const SITE: DevSiteConfig = {
    name: 'web',
    genName: 'web.acme.gen',
    repo: 'app',
    runMode: 'recipe',
    stack: 'go',
    server: 'binary',
    build: [{ label: 'Compile', command: ['go', 'build', '-o', '.genie-build/server', '.'] }],
    serve: ['.genie-build/server'],
    port: 8000,
    kind: 'http',
    enabled: true,
};

const SITE_ID = devSiteIdFor('acme', 'web');

/** A FrankenPHP-served PHP site — the one image that bakes in a broken
 *  healthcheck (genie #119, Blocker 5). */
const PHP_SITE: DevSiteConfig = {
    name: 'app',
    genName: 'app.acme.gen',
    repo: 'app',
    runMode: 'recipe',
    stack: 'php',
    server: 'frankenphp',
    image: FRANKENPHP_IMAGE,
    build: [{ label: 'Install PHP dependencies', command: ['composer', 'install', '--no-dev'] }],
    serve: ['frankenphp', 'php-server', '--listen', '0.0.0.0:8080', '--root', 'public/'],
    port: 8080,
    kind: 'http',
    enabled: true,
};

const PHP_SITE_ID = devSiteIdFor('acme', 'app');

function manager(
    runtime: ContainerRuntime,
    sites: DevSites = { [SITE_ID]: SITE },
    extra: Partial<Parameters<typeof createDevSiteManager>[0]> = {},
) {
    return createDevSiteManager({
        resolveRuntime: async () => ({ runtime, detection: await runtime.detect() }),
        listWorkspaces: () => [WS],
        devSitesFor: () => sites,
        platform: 'linux',
        image: 'genie-dev-base:1',
        hostIds: null,
        // Deterministic: the real one opens a socket.
        probeReady: async () => true,
        ...extra,
    });
}

// --- the stored model -------------------------------------------------------

describe('sites-config', () => {
    it('scopes a site id to its workspace, so two workspaces can both have a "web"', () => {
        expect(devSiteIdFor('acme', 'web')).not.toBe(devSiteIdFor('other', 'web'));
        expect(devSiteIdFor('acme', 'web')).toBe(devSiteIdFor('acme', 'web'));
    });

    it('derives a per-workspace `.gen` name so sites cannot collide across workspaces', () => {
        expect(defaultGenNameFor('acme', 'web')).toBe('web.acme.gen');
        expect(defaultGenNameFor('', 'web')).toBe('web.gen');
    });

    it('refuses a name that is not a DNS label — it becomes part of an origin', () => {
        expect(sanitizeDevSitePatch({ name: 'my web!' }).name).toBeUndefined();
        expect(sanitizeDevSitePatch({ name: 'web-2' }).name).toBe('web-2');
    });

    it('refuses a `.gen` name that is not one', () => {
        expect(sanitizeDevSitePatch({ genName: 'web.example.com' }).genName).toBeUndefined();
        expect(sanitizeDevSitePatch({ genName: 'WEB.acme.GEN' }).genName).toBe('web.acme.gen');
    });

    it('keeps a serve command as literal argv and drops anything that is not', () => {
        expect(sanitizeDevSitePatch({ serve: ['gunicorn', 'app:wsgi'] }).serve).toEqual([
            'gunicorn',
            'app:wsgi',
        ]);
        expect(sanitizeDevSitePatch({ serve: 'gunicorn app:wsgi' as never }).serve).toBeUndefined();
        // A NUL cannot be passed to a process at all.
        expect(sanitizeDevSitePatch({ serve: ['a\0b'] }).serve).toBeUndefined();
    });

    it('keeps the BUILD steps, dropping any that carry no runnable argv', () => {
        const build = sanitizeDevSitePatch({
            build: [
                { label: 'Install', command: ['npm', 'ci'] },
                { label: 'Collect', command: ['manage.py'], optional: true },
                { label: 'Bad', command: 'npm ci' as never },
            ],
        }).build;
        expect(build).toEqual([
            { label: 'Install', command: ['npm', 'ci'] },
            { label: 'Collect', command: ['manage.py'], optional: true },
        ]);
    });

    it('REFUSES to store an exposed surface that cannot say why the browser needs it', () => {
        // The exposure boundary, enforced at the point of storage as well as at
        // the point of use: a surface persisted without a reason could be
        // re-applied later with nobody having stated the need.
        const exposed = sanitizeDevSitePatch({
            exposed: [
                { name: 'live', port: 6001, protocol: 'ws', reason: 'the client subscribes' },
                { name: 'db', port: 5432, protocol: 'tcp', reason: '' },
                { name: 'Not A Label', port: 6002, protocol: 'ws', reason: 'x' },
            ] as never,
        }).exposed;
        expect(exposed).toEqual([
            { name: 'live', port: 6001, protocol: 'ws', reason: 'the client subscribes' },
        ]);
    });

    it('clamps the port and refuses junk env names', () => {
        expect(sanitizeDevSitePatch({ port: 0 }).port).toBeUndefined();
        expect(sanitizeDevSitePatch({ port: 70_000 }).port).toBeUndefined();
        expect(sanitizeDevSitePatch({ port: 5173 }).port).toBe(5173);
        expect(sanitizeDevSitePatch({ env: { 'BAD NAME': 'x', GOOD: 'y' } }).env).toEqual({
            GOOD: 'y',
        });
    });

    it('reads a corrupt blob as "no sites" rather than throwing', () => {
        expect(parseDevSites('not json')).toEqual({});
        expect(parseDevSites(null)).toEqual({});
        expect(parseDevSites('[]')).toEqual({});
    });
});

// --- running a site ---------------------------------------------------------

describe('start', () => {
    it('runs the site in the workspace sandbox with ONLY its port published', async () => {
        const runtime = fakeRuntime();
        const status = await manager(runtime).start('acme', SITE_ID);

        expect(status.state).toBe('running');
        // The site container, not the workspace dev container.
        const site = runtime.ran.find((s) => s.name === siteContainerNameFor('acme', 'web'));
        expect(site).toBeTruthy();
        expect(site?.network).toBe('genie-ws-acme');
        expect(site?.workspaceId).toBe('acme');
        expect(site?.labels?.[SITE_LABEL]).toBe(SITE_ID);
        // The workspace directory, mounted at the same place the sandbox uses,
        // with the command running in the repo's subfolder.
        expect(site?.mounts).toEqual([{ source: '/work/acme', target: '/workspace' }]);
        expect(site?.workdir).toBe('/workspace/repos/app');
        // The PRODUCTION server, and only it — the build ran separately, in the
        // sandbox container, before this one was created.
        expect(site?.command).toEqual(['.genie-build/server']);
        // Loopback, ephemeral host port — never the LAN, never a fixed port.
        expect(site?.ports).toEqual([{ container: 8000, hostIp: '127.0.0.1' }]);
    });

    it('reads the PUBLISHED host port back and reports both origins', async () => {
        const runtime = fakeRuntime();
        const status = await manager(runtime).start('acme', SITE_ID);
        expect(status.hostPort).toBe(49_800);
        expect(status.origin).toBe('https://web.acme.gen');
        expect(status.localOrigin).toBe('http://127.0.0.1:49800');
    });

    it('reports a site whose port never opened as running-but-not-ready', async () => {
        // The container being up is not the same as the production server having
        // bound. Conflating them is how an agent reports a site that 502s.
        const runtime = fakeRuntime();
        const status = await manager(runtime, undefined, { probeReady: async () => false }).start(
            'acme',
            SITE_ID,
        );
        expect(status.state).toBe('running');
        expect(status.ready).toBe(false);
    });

    it('replaces a STOPPED site container rather than restarting it', async () => {
        // The published port is fixed at create time, so a config whose port
        // changed can only take effect on a fresh container. The code lives in
        // the bind mount, so nothing is lost by recreating.
        const runtime = fakeRuntime({
            existing: [
                {
                    id: 'id-old',
                    name: siteContainerNameFor('acme', 'web'),
                    image: 'genie-dev-base:1',
                    state: 'exited',
                    workspaceId: 'acme',
                },
            ],
        });
        await manager(runtime).start('acme', SITE_ID);
        expect(runtime.removed).toEqual(['id-old']);
        expect(runtime.ran.filter((s) => s.name.includes('-site-'))).toHaveLength(1);
    });

    it('builds a repo Dockerfile before running it', async () => {
        const runtime = fakeRuntime();
        const sites: DevSites = {
            [SITE_ID]: {
                ...SITE,
                runMode: 'dockerfile',
                build: undefined,
                serve: undefined,
                image: undefined,
            },
        };
        const status = await manager(runtime, sites).start('acme', SITE_ID);

        expect(runtime.built[0]).toMatchObject({ context: path.join('/work/acme', 'repos', 'app') });
        // The built tag is what actually gets run.
        const site = runtime.ran.find((s) => s.name.includes('-site-'));
        expect(site?.image).toBe(runtime.built[0]?.tag);
        expect(status.state).toBe('running');
    });

    it('is a FAILED STATUS, never a throw, when there is no container runtime', async () => {
        const runtime = fakeRuntime({
            detection: {
                kind: 'none',
                reason: 'not-installed',
                installHint: 'Install Docker Desktop …',
                probes: [],
            },
        });
        const status = await createDevSiteManager({
            resolveRuntime: async () => ({ runtime: null, detection: await runtime.detect() }),
            listWorkspaces: () => [WS],
            devSitesFor: () => ({ [SITE_ID]: SITE }),
            platform: 'linux',
        }).start('acme', SITE_ID);

        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/Install Docker Desktop/);
    });

    it('is a failed status for a site with no port', async () => {
        const runtime = fakeRuntime();
        const sites: DevSites = { [SITE_ID]: { ...SITE, port: undefined } };
        const status = await manager(runtime, sites).start('acme', SITE_ID);
        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/port/i);
        expect(runtime.ran).toHaveLength(0);
    });

    it('is a failed status for an unknown site id', async () => {
        const status = await manager(fakeRuntime()).start('acme', 'nope');
        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/not configured/i);
    });
});

// --- THE SALVAGE SEAM -------------------------------------------------------

describe('genSites — the row the Genie Browser already routes', () => {
    it('emits the published loopback port as an EnabledGenSite keyed by siteId', async () => {
        // This one assertion is P2's thesis. `sites/local-sites.ts` overlays
        // these rows, `localTargetsBySiteId` keys the carrier's resolver on
        // `siteId`, and the local carrier dials `loopback:port` — so the whole
        // chain from `https://web.acme.gen` to the container is this object.
        const runtime = fakeRuntime();
        const m = manager(runtime);
        await m.start('acme', SITE_ID);

        expect(m.genSites()).toEqual([
            {
                workspaceId: 'acme',
                genName: 'web.acme.gen',
                siteId: SITE_ID,
                hostname: 'web.acme.gen',
                scheme: 'http',
                port: 49_800,
                loopback: '127.0.0.1',
            },
        ]);
    });

    it('lets a site override the upstream Host for a framework that checks it', async () => {
        // Vite's allowedHosts and Django's ALLOWED_HOSTS both reject a Host they
        // were not told about, so the coherent default needs an escape hatch.
        const runtime = fakeRuntime();
        const sites: DevSites = { [SITE_ID]: { ...SITE, upstreamHost: 'localhost' } };
        const m = manager(runtime, sites);
        await m.start('acme', SITE_ID);
        expect(m.genSites()[0]?.hostname).toBe('localhost');
        // The BROWSER-facing name is unchanged — only what upstream is told.
        expect(m.genSites()[0]?.genName).toBe('web.acme.gen');
    });

    it('advertises NOTHING for a site that is not running', async () => {
        // A dead target would displace a working discovered site in the overlay
        // — strictly worse than not advertising at all.
        const m = manager(fakeRuntime());
        expect(m.genSites()).toEqual([]);
    });

    it('advertises nothing for a non-HTTP surface', async () => {
        const runtime = fakeRuntime();
        const sites: DevSites = { [SITE_ID]: { ...SITE, kind: 'tcp' } };
        const m = manager(runtime, sites);
        const status = await m.start('acme', SITE_ID);
        // It still RUNS and still publishes its port — it just is not a `.gen`.
        expect(status.state).toBe('running');
        expect(status.hostPort).toBe(49_800);
        expect(m.genSites()).toEqual([]);
    });
});

// --- lifecycle --------------------------------------------------------------

describe('stop / list / logs', () => {
    it('stops and removes the site container, and stops advertising it', async () => {
        const runtime = fakeRuntime();
        const m = manager(runtime);
        await m.start('acme', SITE_ID);
        await m.stop(SITE_ID);

        expect(runtime.removed).toEqual([`id-${siteContainerNameFor('acme', 'web')}`]);
        expect(m.genSites()).toEqual([]);
        expect(m.list('acme')[0]?.state).toBe('stopped');
    });

    it('lists every CONFIGURED site, running or not', async () => {
        const rows = manager(fakeRuntime()).list('acme');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            siteId: SITE_ID,
            name: 'web',
            genName: 'web.acme.gen',
            state: 'stopped',
            enabled: true,
        });
    });

    it('remembers WHY a site failed, instead of reporting it as merely off', async () => {
        const runtime = fakeRuntime();
        const sites: DevSites = { [SITE_ID]: { ...SITE, port: undefined } };
        const m = manager(runtime, sites);
        await m.start('acme', SITE_ID);
        expect(m.list('acme')[0]).toMatchObject({ state: 'failed' });
        expect(m.list('acme')[0]?.error).toMatch(/port/i);
    });

    it('returns the container log for a running site', async () => {
        const m = manager(fakeRuntime());
        await m.start('acme', SITE_ID);
        expect(await m.logs(SITE_ID)).toContain('listening on');
    });

    it('says so rather than throwing when logs are asked for a stopped site', async () => {
        expect(await manager(fakeRuntime()).logs(SITE_ID)).toMatch(/not running/i);
    });
});

describe('reconcile', () => {
    it('starts every ENABLED site and leaves disabled ones alone', async () => {
        const runtime = fakeRuntime();
        const other = devSiteIdFor('acme', 'api');
        const sites: DevSites = {
            [SITE_ID]: SITE,
            [other]: { ...SITE, name: 'api', genName: 'api.acme.gen', enabled: false },
        };
        const m = manager(runtime, sites);
        await m.reconcile();
        expect(runtime.ran.filter((s) => s.name.includes('-site-')).map((s) => s.name)).toEqual([
            siteContainerNameFor('acme', 'web'),
        ]);
    });

    it('stops a site that is live but no longer enabled', async () => {
        const runtime = fakeRuntime();
        const sites: DevSites = { [SITE_ID]: { ...SITE } };
        const m = manager(runtime, sites);
        await m.start('acme', SITE_ID);
        sites[SITE_ID] = { ...SITE, enabled: false };
        await m.reconcile();
        expect(m.genSites()).toEqual([]);
    });
});

// --- reconfigure: editing a site after create (Gap 1) -----------------------

describe('devSiteReconfigureNeedsRestart', () => {
    it('is true when a build / serve / port / env / image / routing field changed', () => {
        expect(devSiteReconfigureNeedsRestart(SITE, { ...SITE, port: 9000 })).toBe(true);
        expect(devSiteReconfigureNeedsRestart(SITE, { ...SITE, serve: ['./other'] })).toBe(true);
        expect(devSiteReconfigureNeedsRestart(SITE, { ...SITE, env: { X: '1' } })).toBe(true);
        expect(devSiteReconfigureNeedsRestart(SITE, { ...SITE, image: 'nginx:1' })).toBe(true);
        expect(devSiteReconfigureNeedsRestart(SITE, { ...SITE, genName: 'web.new.gen' })).toBe(true);
        expect(
            devSiteReconfigureNeedsRestart(SITE, {
                ...SITE,
                build: [{ label: 'C', command: ['go', 'build', '.'] }],
            }),
        ).toBe(true);
    });

    it('is false for a cosmetic-only change — nothing the container depends on moved', () => {
        // Toggling `enabled` is not a container change: a stopped site stays
        // stopped, a running one keeps running. Re-saving with no edit is a no-op.
        expect(devSiteReconfigureNeedsRestart(SITE, { ...SITE, enabled: !SITE.enabled })).toBe(false);
        expect(devSiteReconfigureNeedsRestart(SITE, { ...SITE })).toBe(false);
    });
});

describe('reconfigure', () => {
    it('rebuilds and restarts a RUNNING site when a restart-requiring field changed', async () => {
        const runtime = fakeRuntime();
        const sites: DevSites = { [SITE_ID]: { ...SITE } };
        const m = manager(runtime, sites);
        await m.start('acme', SITE_ID);
        const ranBefore = runtime.ran.length;

        sites[SITE_ID] = { ...SITE, port: 9000 };
        const status = await m.reconfigure('acme', SITE_ID, {
            previousSiteId: SITE_ID,
            restart: true,
        });

        expect(status.state).toBe('running');
        // The old container was torn down and a fresh one started (a published
        // port is fixed at create time, so a port change can only take effect
        // on a new container).
        expect(runtime.removed.length).toBeGreaterThan(0);
        expect(runtime.ran.length).toBe(ranBefore + 1);
        expect(runtime.ran.at(-1)?.ports).toEqual([{ container: 9000, hostIp: '127.0.0.1' }]);
    });

    it('leaves a running site EXACTLY as it is when nothing that matters changed', async () => {
        const runtime = fakeRuntime();
        const m = manager(runtime);
        await m.start('acme', SITE_ID);
        const ranBefore = runtime.ran.length;
        const removedBefore = runtime.removed.length;

        const status = await m.reconfigure('acme', SITE_ID, {
            previousSiteId: SITE_ID,
            restart: false,
        });

        expect(status.state).toBe('running');
        expect(runtime.ran.length).toBe(ranBefore); // no new container
        expect(runtime.removed.length).toBe(removedBefore); // nothing torn down
    });

    it('does NOT start a STOPPED site — an edit is not a start', async () => {
        const runtime = fakeRuntime();
        const m = manager(runtime);
        const status = await m.reconfigure('acme', SITE_ID, {
            previousSiteId: SITE_ID,
            restart: false,
        });
        expect(status.state).toBe('stopped');
        expect(runtime.ran).toHaveLength(0);
    });

    it('moves a running site onto its new container + `.gen` when the name changed', async () => {
        const runtime = fakeRuntime();
        const NEW_ID = devSiteIdFor('acme', 'web2');
        const sites: DevSites = { [SITE_ID]: { ...SITE } };
        const m = manager(runtime, sites);
        await m.start('acme', SITE_ID);

        // A rename moves the map key (as setWorkspaceDevSite does on the real path).
        delete sites[SITE_ID];
        sites[NEW_ID] = { ...SITE, name: 'web2', genName: 'web2.acme.gen' };
        const status = await m.reconfigure('acme', NEW_ID, {
            previousSiteId: SITE_ID,
            restart: true,
        });

        expect(status.state).toBe('running');
        expect(status.genName).toBe('web2.acme.gen');
        expect(runtime.removed).toContain(`id-${siteContainerNameFor('acme', 'web')}`);
        expect(runtime.ran.some((s) => s.name === siteContainerNameFor('acme', 'web2'))).toBe(true);
        // The old id is no longer advertised to the Genie Browser.
        expect(m.genSites().map((g) => g.siteId)).toEqual([NEW_ID]);
    });
});

// --- observable startup (Gap 2) ---------------------------------------------

describe('startup progress', () => {
    it('emits pulling → building → starting → ready as a start proceeds', async () => {
        const runtime = fakeRuntime();
        const phases: string[] = [];
        const m = manager(runtime, undefined, {
            onProgress: (p) => phases.push(p.phase),
        });
        await m.start('acme', SITE_ID);
        // SITE carries a build step, so all four phases are visited in order.
        expect(phases[0]).toBe('pulling');
        expect(phases).toContain('building');
        expect(phases).toContain('starting');
        expect(phases.at(-1)).toBe('ready');
        // The order is monotonic — building never comes after starting.
        expect(phases.indexOf('building')).toBeLessThan(phases.indexOf('starting'));
    });

    it('streams the build log through progress, tagged with the site it belongs to', async () => {
        const runtime = fakeRuntime();
        const buildingLogs: string[] = [];
        const m = manager(runtime, undefined, {
            onProgress: (p) => {
                if (p.phase === 'building' && p.log) {
                    expect(p.siteId).toBe(SITE_ID);
                    buildingLogs.push(p.log);
                }
            },
        });
        await m.start('acme', SITE_ID);
        // runSiteBuild echoes each step header ("$ <cmd>   # <label>") to
        // onProgress, and the manager routes that to the building site's card.
        expect(buildingLogs.some((l) => l.includes('# Compile'))).toBe(true);
    });

    it('ends a failed start on a `failed` phase carrying the reason', async () => {
        const runtime = fakeRuntime();
        const events: Array<{ phase: string; error?: string }> = [];
        const sites: DevSites = { [SITE_ID]: { ...SITE, port: undefined } };
        const m = manager(runtime, sites, {
            onProgress: (p) => events.push({ phase: p.phase, error: p.error }),
        });
        await m.start('acme', SITE_ID);
        const last = events.at(-1);
        expect(last?.phase).toBe('failed');
        expect(last?.error).toMatch(/port/i);
    });

    it('surfaces the in-flight phase + log on `list` for a panel opened mid-start', async () => {
        // A card that mounts while a build is running must be able to read the
        // current phase from a plain `list`, not only from the push stream.
        const runtime = fakeRuntime();
        let phaseFromList: string | undefined;
        const m = manager(runtime, undefined, {
            onProgress: (p) => {
                if (p.phase === 'building' && phaseFromList === undefined) {
                    phaseFromList = m.list('acme')[0]?.phase;
                }
            },
        });
        await m.start('acme', SITE_ID);
        expect(phaseFromList).toBe('building');
    });
});

// --- production build auth (genie #119) -------------------------------------

describe('production build auth', () => {
    /** Capture the env each build step is `exec`ed with. */
    function captureBuildEnv(runtime: Fake): Array<Record<string, string> | undefined> {
        const seen: Array<Record<string, string> | undefined> = [];
        runtime.exec = async (_id, _argv, opts) => {
            seen.push(opts?.env);
            return { code: 0, stdout: '', stderr: '' };
        };
        return seen;
    }

    it('ALWAYS injects git safe.directory into the build, so composer does not die on dubious ownership', async () => {
        const runtime = fakeRuntime();
        const seen = captureBuildEnv(runtime);
        await manager(runtime).start('acme', SITE_ID);
        expect(seen[0]?.GIT_CONFIG_KEY_0).toBe('safe.directory');
        expect(seen[0]?.GIT_CONFIG_VALUE_0).toBe('*');
    });

    it('injects the managed GitHub token as COMPOSER_AUTH + GITHUB_TOKEN when the host holds one', async () => {
        const runtime = fakeRuntime();
        const seen = captureBuildEnv(runtime);
        await manager(runtime, undefined, { githubToken: () => 'ghs_HOSTTOKEN' }).start('acme', SITE_ID);
        expect(seen[0]?.GITHUB_TOKEN).toBe('ghs_HOSTTOKEN');
        expect(JSON.parse(seen[0]!.COMPOSER_AUTH!)).toEqual({
            'github-oauth': { 'github.com': 'ghs_HOSTTOKEN' },
        });
    });

    it('omits the token vars when the host holds none — a public-only build still runs', async () => {
        const runtime = fakeRuntime();
        const seen = captureBuildEnv(runtime);
        await manager(runtime, undefined, { githubToken: () => null }).start('acme', SITE_ID);
        expect(seen[0]?.COMPOSER_AUTH).toBeUndefined();
        expect(seen[0]?.GITHUB_TOKEN).toBeUndefined();
        // …but safe.directory is unconditional.
        expect(seen[0]?.GIT_CONFIG_VALUE_0).toBe('*');
    });

    it('NEVER leaks the token or the git-safety vars into the SERVING container', async () => {
        // Auth is a BUILD concern. The serve container's env is inspectable
        // (docker inspect), so the token must not be persisted there.
        const runtime = fakeRuntime();
        await manager(runtime, undefined, { githubToken: () => 'ghs_HOSTTOKEN' }).start('acme', SITE_ID);
        const site = runtime.ran.find((s) => s.name.includes('-site-'));
        expect(site?.env?.GITHUB_TOKEN).toBeUndefined();
        expect(site?.env?.COMPOSER_AUTH).toBeUndefined();
        expect(site?.env?.GIT_CONFIG_VALUE_0).toBeUndefined();
    });

    it('lets a user-pinned site env override the auth defaults — the defaults sit UNDER it', async () => {
        const runtime = fakeRuntime();
        const seen = captureBuildEnv(runtime);
        await manager(
            runtime,
            { [SITE_ID]: { ...SITE, env: { GIT_CONFIG_VALUE_0: '/workspace/repos/app' } } },
            { githubToken: () => 'ghs_HOSTTOKEN' },
        ).start('acme', SITE_ID);
        expect(seen[0]?.GIT_CONFIG_VALUE_0).toBe('/workspace/repos/app');
    });
});

// --- P3: the services a site connects to ------------------------------------

describe('service env injection (#234 P3)', () => {
    it('injects the workspace’s service env into the SITE container', async () => {
        const runtime = fakeRuntime();
        await manager(runtime, undefined, {
            serviceEnvFor: async () => ({ DATABASE_URL: 'postgresql://ws:pw@genie-svc-postgres-16:5432/ws' }),
        }).start('acme', SITE_ID);

        const site = runtime.ran.find((s) => s.name.includes('-site-'));
        expect(site?.env?.DATABASE_URL).toBe('postgresql://ws:pw@genie-svc-postgres-16:5432/ws');
    });

    it('lets the workspace SERVICE env win over a colliding site env — the real engine address is authoritative', async () => {
        // The container can only reach the engine at its service name on the
        // workspace network. A repo whose committed `.env` pins
        // `DB_HOST=127.0.0.1` (carried into config.env) must NOT beat the
        // managed `genie-svc-postgres-17`, or the app dials nothing. Service
        // connection env is injected LAST and wins outright.
        const runtime = fakeRuntime();
        await manager(
            runtime,
            { [SITE_ID]: { ...SITE, env: { DB_HOST: '127.0.0.1' } } },
            { serviceEnvFor: async () => ({ DB_HOST: 'genie-svc-postgres-17' }) },
        ).start('acme', SITE_ID);

        const site = runtime.ran.find((s) => s.name.includes('-site-'));
        expect(site?.env?.DB_HOST).toBe('genie-svc-postgres-17');
    });

    it('starts the site anyway when the services cannot be brought up', async () => {
        // A site whose database failed to start should come up and SAY the
        // database is missing, not refuse to run at all — the dev server is
        // often exactly where that error is diagnosed.
        const runtime = fakeRuntime();
        const status = await manager(runtime, undefined, {
            serviceEnvFor: async () => {
                throw new Error('engine exploded');
            },
        }).start('acme', SITE_ID);
        expect(status.state).toBe('running');
    });

    it('is absent by default — P2 behaviour, verbatim', async () => {
        const runtime = fakeRuntime();
        await manager(runtime).start('acme', SITE_ID);
        const site = runtime.ran.find((s) => s.name.includes('-site-'));
        expect(site?.env).toBeUndefined();
    });
});

// --- the site healthcheck (genie #119, Blocker 5) ---------------------------

describe('site healthcheck', () => {
    it('OVERRIDES the FrankenPHP image’s broken :2019 admin check with one on the REAL serve port', async () => {
        // The `dunglas/frankenphp` image bakes a HEALTHCHECK that curls its Caddy
        // admin endpoint on :2019, which `php-server` mode disables — so the site
        // is `(unhealthy)` forever while it serves fine. We point it at the port
        // the recipe actually serves on, so a serving site reads healthy.
        const runtime = fakeRuntime();
        await manager(runtime, { [PHP_SITE_ID]: PHP_SITE }).start('acme', PHP_SITE_ID);
        const site = runtime.ran.find((s) => s.name.includes('-site-'));
        expect(site?.healthcheck?.cmd).toContain('http://127.0.0.1:8080/');
        expect(site?.healthcheck?.cmd).not.toContain('2019');
        expect(site?.healthcheck?.cmd).not.toContain('/metrics');
    });

    it('leaves every OTHER image to inherit — only FrankenPHP bakes a broken check', async () => {
        // The Go site runs on the dev-base image, which carries no HEALTHCHECK, so
        // Genie must not invent one (curl/nc are not guaranteed in every image).
        const runtime = fakeRuntime();
        await manager(runtime).start('acme', SITE_ID);
        const site = runtime.ran.find((s) => s.name.includes('-site-'));
        expect(site?.healthcheck).toBeUndefined();
    });
});
