import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDevSiteManager } from '../site-manager';
import { defaultGenNameFor, devSiteIdFor, parseDevSites, sanitizeDevSitePatch } from '../sites-config';
import { SITE_LABEL, siteContainerNameFor } from '../argv';
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
    runMode: 'detected',
    command: ['python3', '-m', 'http.server', '8000'],
    port: 8000,
    kind: 'http',
    enabled: true,
};

const SITE_ID = devSiteIdFor('acme', 'web');

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

    it('keeps a command as literal argv and drops anything that is not', () => {
        expect(sanitizeDevSitePatch({ command: ['npm', 'run', 'dev'] }).command).toEqual([
            'npm',
            'run',
            'dev',
        ]);
        expect(sanitizeDevSitePatch({ command: 'npm run dev' as never }).command).toBeUndefined();
        // A NUL cannot be passed to a process at all.
        expect(sanitizeDevSitePatch({ command: ['a\0b'] }).command).toBeUndefined();
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
        expect(site?.command).toEqual(['python3', '-m', 'http.server', '8000']);
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
        // The container being up is not the same as the dev server having bound.
        // Conflating them is how an agent reports a working site that 502s.
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
            [SITE_ID]: { ...SITE, runMode: 'dockerfile', command: undefined, image: undefined },
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

    it('lets the site’s OWN env win — a pinned value is the user’s decision', async () => {
        const runtime = fakeRuntime();
        await manager(
            runtime,
            { [SITE_ID]: { ...SITE, env: { DATABASE_URL: 'postgresql://mine' } } },
            { serviceEnvFor: async () => ({ DATABASE_URL: 'postgresql://managed' }) },
        ).start('acme', SITE_ID);

        const site = runtime.ran.find((s) => s.name.includes('-site-'));
        expect(site?.env?.DATABASE_URL).toBe('postgresql://mine');
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
