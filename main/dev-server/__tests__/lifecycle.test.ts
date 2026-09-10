import { describe, expect, it } from 'vitest';
import { createDevSiteManager } from '../site-manager';
import { createDevServiceManager } from '../services/service-manager';
import { createDevServerLifecycle } from '../lifecycle';
import { devContainerNameFor, serviceContainerNameFor } from '../argv';
import { CADDY_HTTPS_PORT } from '../caddyfile';
import type { DevSiteConfig, DevSites } from '../sites-config';
import type { DevServiceConfig, DevServices } from '../services/services-config';
import type {
    ContainerRuntime,
    ContainerSpec,
    ContainerSummary,
    PortMapping,
    RuntimeDetection,
} from '../container-runtime';

/**
 * The DEV SERVER's APP LIFECYCLE (Tynn #234, P4 item A) — the three moments the
 * container backend has to be told about, and the one it deliberately is not.
 *
 * P1–P3 built every verb and wired NONE of them to the app: `teardownWorkspaceSandbox`
 * had no caller, and a Genie restart left running containers with nobody
 * tracking them. The three moments:
 *
 *   1. **Workspace OPEN → warm the sandbox.** Idempotent, and gated on the
 *      workspace ACTUALLY using the dev server: opening a workspace that has
 *      never defined a site must not silently create a container and a network
 *      on the user's Docker.
 *   2. **Workspace REMOVE → release, stop, then sweep.** The order is the whole
 *      test: a shared service engine released AFTER the label sweep leaves this
 *      workspace counted as a holder of a container it no longer uses, so that
 *      engine never stops for anyone.
 *   3. **Boot → ADOPT what is already running.** Never START. A service engine
 *      carries `restart: unless-stopped`, so after a reboot it is up with zero
 *      known holders — the refcount is a lie and `release` from the one
 *      workspace that does re-acquire would stop an engine others still use. A
 *      site container that outlived a Genie restart is worse: it serves, and
 *      `genSites()` does not know, so `<name>.gen` resolves nowhere.
 *
 * And the one that is deliberately absent: **quit stops nothing.** See the
 * `lifecycle.ts` header.
 */

// --- a fake runtime ---------------------------------------------------------

const DOCKER_OK: RuntimeDetection = { kind: 'docker', version: '29.6.1', probes: [] };
const NO_RUNTIME: RuntimeDetection = {
    kind: 'none',
    reason: 'not-installed',
    installHint: 'Install Docker Desktop.',
    probes: [],
};

interface Fake extends ContainerRuntime {
    readonly ran: ContainerSpec[];
    readonly stopped: string[];
    readonly removed: string[];
    readonly removedNetworks: string[];
    readonly disconnected: { network: string; id: string }[];
    readonly execs: { id: string; argv: string[] }[];
    readonly containers: Map<string, ContainerSummary>;
}

function fakeRuntime(opts: { detection?: RuntimeDetection; existing?: ContainerSummary[] } = {}): Fake {
    const ran: ContainerSpec[] = [];
    const stopped: string[] = [];
    const removed: string[] = [];
    const removedNetworks: string[] = [];
    const disconnected: { network: string; id: string }[] = [];
    const execs: { id: string; argv: string[] }[] = [];
    const containers = new Map<string, ContainerSummary>(
        (opts.existing ?? []).map((c) => [c.name, c]),
    );
    const ports = new Map<string, PortMapping[]>();
    for (const c of opts.existing ?? []) {
        // A published ENGINE exposes its own port on loopback (postgres 5432) — a
        // real adopted engine has this, and adoption must find it or it would
        // (correctly) treat the container as unpublished and re-create it. A
        // SANDBOX publishes its Caddy https port; that is the one door adopt reads
        // back to route every `.gen` through.
        const isEngine = c.name.startsWith('genie-svc-');
        ports.set(c.id, [
            isEngine
                ? { container: 5432, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 49_910 }
                : { container: CADDY_HTTPS_PORT, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 49_900 },
        ]);
    }

    return {
        kind: 'docker',
        ran,
        stopped,
        removed,
        removedNetworks,
        disconnected,
        execs,
        containers,
        async detect() {
            return opts.detection ?? DOCKER_OK;
        },
        async networkEnsure(workspaceId) {
            return { name: `genie-ws-${workspaceId}`, created: false };
        },
        async networkEnsureNamed(name) {
            return { name, created: false };
        },
        async networkRemove(workspaceId) {
            removedNetworks.push(workspaceId);
        },
        async networkConnect() {},
        async networkDisconnect(network, id) {
            disconnected.push({ network, id });
        },
        async volumeRemove() {},
        async imageExists() {
            return true;
        },
        async pullImage(image) {
            return { ok: true, image };
        },
        async buildImage(spec) {
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
                ...(spec.workspaceId === null || spec.workspaceId === undefined
                    ? {}
                    : { workspaceId: spec.workspaceId }),
            });
            ports.set(
                id,
                (spec.ports ?? []).map((p) => ({
                    container: p.container,
                    protocol: 'tcp' as const,
                    hostIp: p.hostIp ?? '127.0.0.1',
                    hostPort: 49_800,
                })),
            );
            return { id, name: spec.name };
        },
        async start() {},
        async stop(id) {
            stopped.push(id);
        },
        async remove(id) {
            removed.push(id);
            for (const [name, c] of containers) if (c.id === id) containers.delete(name);
        },
        async exec(id, argv) {
            execs.push({ id, argv });
            return { code: 0, stdout: '', stderr: '' };
        },
        async logs() {
            return '';
        },
        followLogs() {
            return { stop() {}, exited: Promise.resolve(0) };
        },
        async psServices(engineKey) {
            return [...containers.values()].filter(
                (c) => c.name.startsWith('genie-svc-') && (!engineKey || c.name.includes(engineKey)),
            );
        },
        async ps(workspaceId) {
            return [...containers.values()].filter(
                (c) => !workspaceId || c.workspaceId === workspaceId,
            );
        },
        async portMappings(id) {
            return ports.get(id) ?? [];
        },
    };
}

// --- fixtures ---------------------------------------------------------------

const WS = { id: 'acme', path: '/work/acme', label: 'acme' };
const OTHER = { id: 'beta', path: '/work/beta', label: 'beta' };

const SITE: DevSiteConfig = {
    name: 'web',
    genName: 'web.acme.gen',
    repo: '',
    runMode: 'recipe',
    build: [{ label: 'Compile', command: ['go', 'build', '-o', '.genie-build/server', '.'] }],
    serve: ['.genie-build/server'],
    port: 8000,
    kind: 'http',
    enabled: true,
};

const PG: DevServiceConfig = {
    engine: 'postgres',
    version: '16',
    dedicated: false,
    password: 'ws-secret',
    enabled: true,
};

/** The HOST-NATIVE engine: a bundled Sockudo running as a child of Genie, with
 *  no container anywhere — so nothing survives a Genie restart to be adopted. */
const WEBSOCKETS: DevServiceConfig = {
    engine: 'websockets',
    version: '1',
    dedicated: false,
    password: 'workspace_websocket_password_0123456789',
    enabled: true,
};

/** The bundled Host WebSocket service, recording what was asked of it. */
function fakeHostWebSockets() {
    const acquired: string[] = [];
    const released: string[] = [];
    const stops: number[] = [];
    return {
        acquired,
        released,
        stops,
        service: {
            acquire: async (app: { id: string; key: string; secret: string }) => {
                acquired.push(app.id);
                return { processId: 'sockudo-1', port: 49_123, ready: true };
            },
            release: async (appId: string) => {
                released.push(appId);
            },
            logs: () => 'Sockudo ready',
            stop: async () => {
                stops.push(Date.now());
            },
        },
    };
}

function siteManager(
    runtime: Fake,
    sites: Record<string, DevSites>,
    workspaces = [WS],
    extra: Partial<Parameters<typeof createDevSiteManager>[0]> = {},
) {
    return createDevSiteManager({
        resolveRuntime: async () => ({ runtime, detection: await runtime.detect() }),
        listWorkspaces: () => workspaces,
        devSitesFor: (id) => sites[id] ?? {},
        // `linux`, because a POSIX fixture path is not bind-mountable from a
        // Windows host and the sandbox correctly refuses it.
        platform: 'linux',
        probeReady: async () => true,
        hostIds: null,
        ...extra,
    });
}

/** A host-native spawn binding whose runs did NOT survive the restart, recording
 *  every start so a test can assert what boot brought back. */
function deadHostSpawn() {
    const started: string[] = [];
    return {
        started,
        binding: {
            start: async (i: { siteId: string }) => {
                started.push(i.siteId);
                return { ok: true as const, pid: 4242 };
            },
            stop: async () => {},
            alive: async () => false,
            readLog: async () => '',
            running: async () => [],
        },
    };
}

const HOST_SITE: DevSiteConfig = {
    name: 'web',
    genName: 'web.acme.gen',
    repo: '',
    runMode: 'host',
    command: ['php', 'artisan', 'serve'],
    port: 8001,
    kind: 'http',
    enabled: true,
};

function serviceManager(
    runtime: Fake,
    services: Record<string, DevServices>,
    workspaces = [WS],
    extra: Partial<Parameters<typeof createDevServiceManager>[0]> = {},
) {
    return createDevServiceManager({
        resolveRuntime: async () => ({ runtime, detection: await runtime.detect() }),
        listWorkspaces: () => workspaces,
        devServicesFor: (id) => services[id] ?? {},
        engineAdmin: (req) => ({ user: req.adminUser, password: `admin-${req.recordKey}` }),
        ...extra,
    });
}

// --- boot adoption ----------------------------------------------------------

describe('adopting what is already running', () => {
    it('adopts a SITE whose process outlived a Genie restart, so `.gen` routes to it again', async () => {
        // The SANDBOX is up — Genie restarted, Docker did not — and the site's
        // detached process is still alive inside it. Nothing in the manager knows,
        // so `genSites()` is empty and the Testing Browser resolves `web.acme.gen`
        // to nothing while the server serves.
        const runtime = fakeRuntime({
            existing: [
                {
                    id: 'id-sandbox',
                    name: devContainerNameFor(WS.id),
                    image: 'genie-dev',
                    state: 'running',
                    workspaceId: WS.id,
                },
            ],
        });
        const siteId = 'site-1';
        const manager = siteManager(runtime, { [WS.id]: { [siteId]: SITE } });

        expect(manager.genSites()).toEqual([]);

        await manager.adopt();

        expect(runtime.ran).toEqual([]); // adoption CREATES nothing
        expect(manager.genSites()).toEqual([
            {
                workspaceId: WS.id,
                genName: 'web.acme.gen',
                siteId,
                // Routed through the sandbox's shared Caddy port over https,
                // distinguished by SNI = the `.gen` name.
                hostname: 'web.acme.gen',
                scheme: 'https',
                port: 49_900,
                loopback: '127.0.0.1',
            },
        ]);
    });

    it('does NOT start a site that is not already running', async () => {
        const runtime = fakeRuntime();
        const manager = siteManager(runtime, { [WS.id]: { 'site-1': SITE } });

        await manager.adopt();

        expect(runtime.ran).toEqual([]);
        expect(manager.list(WS.id)[0]?.state).toBe('stopped');
    });

    it('adopts a running ENGINE and re-registers this workspace as a holder', async () => {
        // `restart: unless-stopped` means the engine is back after a reboot. If
        // nobody re-registers, `holders` reads 0 while it serves — and the first
        // workspace that DOES acquire then holds it alone and can stop it out
        // from under everyone else.
        const name = serviceContainerNameFor('postgres-16');
        const runtime = fakeRuntime({
            existing: [{ id: 'id-pg', name, image: 'postgres:16-alpine', state: 'running' }],
        });
        const manager = serviceManager(runtime, { [WS.id]: { 'svc-1': PG } });

        await manager.adopt();

        expect(runtime.ran).toEqual([]); // adopted, not created
        const row = manager.list(WS.id)[0];
        expect(row?.state).toBe('running');
        expect(row?.holders).toBe(1);
        // Re-provisioned on adopt: a Redis ACL user lives in memory and is gone
        // after a restart, so adoption that skipped provisioning would report a
        // healthy service whose credentials no longer exist.
        expect(runtime.execs.length).toBeGreaterThan(0);
    });

    it('does NOT start an engine that is not already running', async () => {
        const runtime = fakeRuntime();
        const manager = serviceManager(runtime, { [WS.id]: { 'svc-1': PG } });

        await manager.adopt();

        expect(runtime.ran).toEqual([]);
        expect(manager.list(WS.id)[0]?.state).toBe('stopped');
    });

    it('skips a DISABLED service even when its engine happens to be running', async () => {
        const runtime = fakeRuntime({
            existing: [
                {
                    id: 'id-pg',
                    name: serviceContainerNameFor('postgres-16'),
                    image: 'postgres:16-alpine',
                    state: 'running',
                },
            ],
        });
        const manager = serviceManager(runtime, {
            [WS.id]: { 'svc-1': { ...PG, enabled: false } },
        });

        await manager.adopt();

        expect(manager.list(WS.id)[0]?.state).toBe('stopped');
        expect(manager.list(WS.id)[0]?.holders).toBeUndefined();
    });
});

// --- boot: host-native sites come back --------------------------------------

/**
 * "Every time I update, all of our sites go down and I have to manually restart
 * most of them" (genie#190).
 *
 * ADOPT is the whole answer for a CONTAINER site: the container carries
 * `restart: unless-stopped`, so it is still up after the update and adoption
 * re-learns it. A HOST-NATIVE site has no container to survive — Genie quits to
 * install the update and its dev servers go with it — so adoption finds nothing
 * and the site stays dark until a human restarts it by hand, once per site.
 *
 * `enabled: true` IS the user asking for the site to be served, so boot resumes
 * exactly those. That does not reopen the policy adopt states: a site nobody
 * enabled still does not begin serving because the app launched.
 */
describe('boot resumes host-native sites the update took down', () => {
    function bootLifecycle(sites: ReturnType<typeof siteManager>) {
        return createDevServerLifecycle({
            resolveRuntime: async () => ({ runtime: null, detection: NO_RUNTIME }),
            workspaceFor: () => WS,
            devSitesFor: () => ({}),
            devServicesFor: () => ({}),
            sites: () => sites,
            services: () => null,
            platform: 'linux',
            hostIds: null,
        });
    }

    it('restarts an ENABLED host-native site whose dev server did not survive', async () => {
        const spawn = deadHostSpawn();
        const manager = siteManager(
            fakeRuntime({ detection: NO_RUNTIME }),
            { [WS.id]: { 'site-1': HOST_SITE } },
            [WS],
            { hostSpawn: spawn.binding, allocateFreePort: async () => 5321 },
        );

        await bootLifecycle(manager).onBoot();

        expect(spawn.started).toEqual(['site-1']);
        expect(manager.list(WS.id)[0]?.state).toBe('running');
    });

    it('does NOT restart a host-native site the user has disabled', async () => {
        const spawn = deadHostSpawn();
        const manager = siteManager(
            fakeRuntime({ detection: NO_RUNTIME }),
            { [WS.id]: { 'site-1': { ...HOST_SITE, enabled: false } } },
            [WS],
            { hostSpawn: spawn.binding, allocateFreePort: async () => 5321 },
        );

        await bootLifecycle(manager).onBoot();

        expect(spawn.started).toEqual([]);
        expect(manager.list(WS.id)[0]?.state).toBe('stopped');
    });

    it('does NOT respawn one that adopt already re-attached — no second dev server on a second port', async () => {
        const started: string[] = [];
        const hostSpawn = {
            start: async (i: { siteId: string }) => {
                started.push(i.siteId);
                return { ok: true as const, pid: 1 };
            },
            stop: async () => {},
            alive: async () => true,
            readLog: async () => '',
            // It survived — adopt re-attaches it on the port it is really serving.
            running: async () => [{ siteId: 'site-1', port: 4444 }],
        };
        const manager = siteManager(
            fakeRuntime({ detection: NO_RUNTIME }),
            { [WS.id]: { 'site-1': HOST_SITE } },
            [WS],
            { hostSpawn, allocateFreePort: async () => 5321 },
        );

        await bootLifecycle(manager).onBoot();

        expect(started).toEqual([]);
        expect(manager.genSites()[0]?.port).toBe(4444);
    });

    it('still starts NO site the user has not enabled — that policy is unchanged', async () => {
        const runtime = fakeRuntime();
        const manager = siteManager(runtime, { [WS.id]: { 'site-1': { ...SITE, enabled: false } } });

        await bootLifecycle(manager).onBoot();

        expect(runtime.ran).toEqual([]);
        expect(manager.list(WS.id)[0]?.state).toBe('stopped');
    });

    // A CONTAINER site normally needs none of this — its sandbox carries
    // `restart: unless-stopped`, so it is up before Genie and adoption re-learns
    // it. But a Docker/host REBOOT restarts the sandbox and the site processes
    // exec'd into it do not come back, so an enabled site is just as dark, for the
    // same reason and with the same manual fix.
    it('restarts an ENABLED container site whose process is gone from a restarted sandbox', async () => {
        const runtime = fakeRuntime();
        const manager = siteManager(runtime, { [WS.id]: { 'site-1': SITE } });

        await bootLifecycle(manager).onBoot();

        expect(manager.list(WS.id)[0]?.state).toBe('running');
        expect(runtime.ran.map((s) => s.name)).toEqual([devContainerNameFor(WS.id)]);
    });

    // Docker Desktop routinely finishes starting AFTER Genie does. Trying anyway
    // would stamp every container site with a "no container runtime" failure on
    // every launch — a worse lie than "stopped", and one the user then has to
    // clear by hand. Host-native sites need no runtime and are unaffected.
    it('leaves container sites alone when no container runtime is up yet — no boot-time failures', async () => {
        const runtime = fakeRuntime({ detection: NO_RUNTIME });
        const manager = siteManager(runtime, { [WS.id]: { 'site-1': SITE } }, [WS], {
            resolveRuntime: async () => ({ runtime: null, detection: NO_RUNTIME }),
        });

        await bootLifecycle(manager).onBoot();

        expect(runtime.ran).toEqual([]);
        const row = manager.list(WS.id)[0];
        expect(row?.state).toBe('stopped');
        expect(row?.error).toBeUndefined();
    });

    it('still resumes a HOST-NATIVE site when there is no container runtime — it needs none', async () => {
        const spawn = deadHostSpawn();
        const manager = siteManager(
            fakeRuntime({ detection: NO_RUNTIME }),
            { [WS.id]: { 'site-1': HOST_SITE } },
            [WS],
            {
                resolveRuntime: async () => ({ runtime: null, detection: NO_RUNTIME }),
                hostSpawn: spawn.binding,
                allocateFreePort: async () => 5321,
            },
        );

        await bootLifecycle(manager).onBoot();

        expect(spawn.started).toEqual(['site-1']);
    });
});

// --- workspace open ---------------------------------------------------------

describe('workspace open', () => {
    it('warms the sandbox of a workspace that uses the dev server', async () => {
        const runtime = fakeRuntime();
        const lifecycle = createDevServerLifecycle({
            resolveRuntime: async () => ({ runtime, detection: await runtime.detect() }),
            workspaceFor: () => WS,
            devSitesFor: () => ({ 'site-1': SITE }),
            devServicesFor: () => ({}),
            sites: () => null,
            services: () => null,
            platform: 'linux',
            hostIds: null,
        });

        const result = await lifecycle.onWorkspaceOpen(WS.id);

        expect(result.ensured).toBe(true);
        expect(runtime.ran.map((s) => s.name)).toEqual([devContainerNameFor(WS.id)]);
    });

    it('creates NOTHING for a workspace that has never defined a site or a service', async () => {
        // The judgment call, made explicit: a user with Docker installed and
        // twenty workspaces must not accumulate twenty idle containers and
        // twenty networks for a feature they have not used.
        const runtime = fakeRuntime();
        const lifecycle = createDevServerLifecycle({
            resolveRuntime: async () => ({ runtime, detection: await runtime.detect() }),
            workspaceFor: () => WS,
            devSitesFor: () => ({}),
            devServicesFor: () => ({}),
            sites: () => null,
            services: () => null,
            platform: 'linux',
            hostIds: null,
        });

        const result = await lifecycle.onWorkspaceOpen(WS.id);

        expect(result.ensured).toBe(false);
        expect(result.reason).toBe('not-used-here');
        expect(runtime.ran).toEqual([]);
    });

    it('is silent when there is no container runtime — opening a workspace must not complain', async () => {
        const runtime = fakeRuntime({ detection: NO_RUNTIME });
        const lifecycle = createDevServerLifecycle({
            resolveRuntime: async () => ({ runtime: null, detection: NO_RUNTIME }),
            workspaceFor: () => WS,
            devSitesFor: () => ({ 'site-1': SITE }),
            devServicesFor: () => ({}),
            sites: () => null,
            services: () => null,
            platform: 'linux',
            hostIds: null,
        });

        const result = await lifecycle.onWorkspaceOpen(WS.id);

        expect(result.ensured).toBe(false);
        expect(result.reason).toBe('no-runtime');
        expect(runtime.ran).toEqual([]);
    });

    it('takes the adoption pass a Docker-less boot could not (genie#559)', async () => {
        // The ordering that matters for the reported symptom. Genie booted while
        // Docker Desktop was still starting, so boot adoption acquired nothing and
        // `live` stayed empty; a pty's environment is fixed at spawn, so the
        // repair has to land BEFORE the terminal is opened. Opening the workspace
        // is that moment — the user is on their way to the terminal, the runtime
        // is being resolved here anyway, and nothing has to poll for it.
        let dockerUp = false;
        const runtime = fakeRuntime({
            existing: [
                {
                    id: 'id-pg',
                    name: serviceContainerNameFor('postgres-16'),
                    image: 'postgres:16-alpine',
                    state: 'running',
                },
            ],
        });
        const resolveRuntime = async () =>
            dockerUp
                ? { runtime, detection: DOCKER_OK }
                : { runtime: null, detection: NO_RUNTIME };
        const services = createDevServiceManager({
            resolveRuntime,
            listWorkspaces: () => [WS],
            devServicesFor: () => ({ 'svc-a': PG }),
            engineAdmin: (req) => ({ user: req.adminUser, password: `admin-${req.recordKey}` }),
        });
        const lifecycle = createDevServerLifecycle({
            resolveRuntime,
            workspaceFor: () => WS,
            devSitesFor: () => ({}),
            devServicesFor: () => ({ 'svc-a': PG }),
            sites: () => null,
            services: () => services,
            platform: 'linux',
            hostIds: null,
        });

        await lifecycle.onBoot();
        expect(services.hostEnvFor(WS.id)).toEqual({});

        dockerUp = true;
        await lifecycle.onWorkspaceOpen(WS.id);

        expect(services.hostEnvFor(WS.id)).toMatchObject({ PGHOST: '127.0.0.1' });
    });
});

// --- workspace open: the HOST-NATIVE services (genie#573) --------------------

/**
 * A HOST-NATIVE service has nothing to adopt.
 *
 * `adopt()` fills `live` at boot by finding the CONTAINER that Docker kept
 * running — which is the whole answer for an engine carrying
 * `restart: unless-stopped`, and no answer at all for the bundled Sockudo, which
 * is a child of Genie's own process and dies with it. Boot adoption therefore
 * looked for `genie-svc-websockets-1`, found nothing, and moved on; worse, it
 * returned before even looking on a machine with no container runtime, so a
 * service that needs no Docker whatsoever was skipped for the absence of
 * something it does not use.
 *
 * The cost was not "not adopted": it was a workspace whose WebSockets stayed
 * dark after every Genie restart, so terminals spawned there composed no
 * `REVERB_*` at all — repaired only incidentally, when something else (a site
 * start, whose `serviceEnvFor` acquires every enabled service) happened to
 * spawn it.
 *
 * So OPEN acquires them, alongside genie#559's deferred adoption pass. Open is a
 * different moment from boot with a different contract: it already ensures a
 * whole container sandbox, gated on the workspace actually using the dev server.
 * That gate is what is kept — a workspace nobody opened still starts nothing —
 * and `adopt()`'s "never start one" contract is left exactly as it was.
 */
describe('workspace open acquires host-native services', () => {
    function openLifecycle(
        services: ReturnType<typeof serviceManager>,
        opts: { runtime: Fake | null; workspaces?: typeof WS[] } = { runtime: null },
    ) {
        const workspaces = opts.workspaces ?? [WS];
        return createDevServerLifecycle({
            resolveRuntime: async () =>
                opts.runtime
                    ? { runtime: opts.runtime, detection: DOCKER_OK }
                    : { runtime: null, detection: NO_RUNTIME },
            workspaceFor: (id) => workspaces.find((w) => w.id === id) ?? null,
            devSitesFor: () => ({}),
            devServicesFor: (id): DevServices =>
                id === OTHER.id ? { 'ws-b': WEBSOCKETS } : { 'ws-a': WEBSOCKETS },
            sites: () => null,
            services: () => services,
            platform: 'linux',
            hostIds: null,
        });
    }

    it('starts the workspace’s WebSockets on open, so its terminals get REVERB_*', async () => {
        const host = fakeHostWebSockets();
        const runtime = fakeRuntime();
        const services = serviceManager(runtime, { [WS.id]: { 'ws-a': WEBSOCKETS } }, [WS], {
            hostWebSockets: host.service,
        });
        const lifecycle = openLifecycle(services, { runtime });

        // Boot adopts what survived, and NOTHING did: the Sockudo was a child of
        // the Genie that just exited. This is the state a restart leaves behind.
        await lifecycle.onBoot();
        expect(host.acquired).toEqual([]);
        expect(services.hostEnvFor(WS.id)).toEqual({});

        await lifecycle.onWorkspaceOpen(WS.id);

        expect(host.acquired).toEqual(['ws_acme']);
        expect(services.hostEnvFor(WS.id)).toMatchObject({
            REVERB_HOST: '127.0.0.1',
            REVERB_PORT: '49123',
        });
        expect(services.list(WS.id)[0]?.state).toBe('running');
    });

    it('starts it on a machine with NO container runtime — it needs none', async () => {
        // The sharpest half of the bug. `adopt()` resolves the container runtime
        // FIRST and returns when there is none, so on a Docker-less machine the
        // one service that requires no Docker was the one guaranteed never to
        // come up. Open still reports `no-runtime` (no sandbox was warmed) — and
        // the WebSockets is live anyway.
        const host = fakeHostWebSockets();
        const services = serviceManager(
            fakeRuntime({ detection: NO_RUNTIME }),
            { [WS.id]: { 'ws-a': WEBSOCKETS } },
            [WS],
            {
                resolveRuntime: async () => ({ runtime: null, detection: NO_RUNTIME }),
                hostWebSockets: host.service,
            },
        );
        const lifecycle = openLifecycle(services, { runtime: null });

        const result = await lifecycle.onWorkspaceOpen(WS.id);

        expect(result).toEqual({ ensured: false, reason: 'no-runtime' });
        expect(host.acquired).toEqual(['ws_acme']);
        expect(services.hostEnvFor(WS.id)).toMatchObject({ REVERB_PORT: '49123' });
    });

    it('starts NOTHING for a workspace nobody opened — the gate boot has is kept', async () => {
        // The reason this is not simply done at boot. One Reverb per workspace
        // with `websockets` enabled, opened or not, is the accumulation
        // `adopt()`'s contract exists to prevent, in a different shape.
        const host = fakeHostWebSockets();
        const runtime = fakeRuntime();
        const services = serviceManager(runtime, { [WS.id]: { 'ws-a': WEBSOCKETS } }, [WS], {
            hostWebSockets: host.service,
        });

        await openLifecycle(services, { runtime }).onBoot();

        expect(host.acquired).toEqual([]);
        expect(services.list(WS.id)[0]?.state).toBe('stopped');
    });

    it('is IDEMPOTENT — opening the same workspace twice acquires once', async () => {
        const host = fakeHostWebSockets();
        const runtime = fakeRuntime();
        const services = serviceManager(runtime, { [WS.id]: { 'ws-a': WEBSOCKETS } }, [WS], {
            hostWebSockets: host.service,
        });
        const lifecycle = openLifecycle(services, { runtime });

        await lifecycle.onWorkspaceOpen(WS.id);
        await lifecycle.onWorkspaceOpen(WS.id);

        expect(host.acquired).toEqual(['ws_acme']);
        expect(services.list(WS.id)[0]?.holders).toBe(1);
    });

    it('does NOT start a service the user has disabled', async () => {
        const host = fakeHostWebSockets();
        const runtime = fakeRuntime();
        const services = serviceManager(
            runtime,
            { [WS.id]: { 'ws-a': { ...WEBSOCKETS, enabled: false } } },
            [WS],
            { hostWebSockets: host.service },
        );
        const lifecycle = createDevServerLifecycle({
            resolveRuntime: async () => ({ runtime, detection: DOCKER_OK }),
            workspaceFor: () => WS,
            devSitesFor: () => ({}),
            devServicesFor: () => ({ 'ws-a': { ...WEBSOCKETS, enabled: false } }),
            sites: () => null,
            services: () => services,
            platform: 'linux',
            hostIds: null,
        });

        await lifecycle.onWorkspaceOpen(WS.id);

        expect(host.acquired).toEqual([]);
        expect(services.list(WS.id)[0]?.state).toBe('stopped');
    });

    it('counts BOTH workspaces as holders, so one closing does not take the other’s Sockudo down', async () => {
        // One Sockudo process serves every workspace, each as its own app. The
        // refcount is the only thing standing between "beta released" and "acme's
        // WebSockets went dark", and an open that acquired without registering a
        // holder would produce exactly that on the next release.
        const host = fakeHostWebSockets();
        const runtime = fakeRuntime();
        const services = serviceManager(
            runtime,
            { [WS.id]: { 'ws-a': WEBSOCKETS }, [OTHER.id]: { 'ws-b': WEBSOCKETS } },
            [WS, OTHER],
            { hostWebSockets: host.service },
        );
        const lifecycle = openLifecycle(services, { runtime, workspaces: [WS, OTHER] });

        await lifecycle.onWorkspaceOpen(WS.id);
        await lifecycle.onWorkspaceOpen(OTHER.id);

        expect(host.acquired).toEqual(['ws_acme', 'ws_beta']);
        expect(services.list(WS.id)[0]?.holders).toBe(2);

        await services.release(OTHER.id, 'ws-b');

        expect(services.list(WS.id)[0]?.holders).toBe(1);
        expect(host.stops).toEqual([]); // still held by acme
        expect(services.hostEnvFor(WS.id)).toMatchObject({ REVERB_PORT: '49123' });
    });

    it('does not disturb a CONTAINER service — those are adoption’s job, not open’s', async () => {
        // Open must not become a back door into starting databases. A Postgres
        // that is not running stays stopped; only the host-native engines, which
        // have nothing to adopt, are acquired here.
        const host = fakeHostWebSockets();
        const runtime = fakeRuntime();
        const services = serviceManager(
            runtime,
            { [WS.id]: { 'ws-a': WEBSOCKETS, 'svc-a': PG } },
            [WS],
            { hostWebSockets: host.service },
        );
        const lifecycle = createDevServerLifecycle({
            resolveRuntime: async () => ({ runtime, detection: DOCKER_OK }),
            workspaceFor: () => WS,
            devSitesFor: () => ({}),
            devServicesFor: () => ({ 'ws-a': WEBSOCKETS, 'svc-a': PG }),
            sites: () => null,
            services: () => services,
            platform: 'linux',
            hostIds: null,
        });

        await lifecycle.onWorkspaceOpen(WS.id);

        expect(host.acquired).toEqual(['ws_acme']);
        expect(runtime.ran.map((s) => s.name)).not.toContain(serviceContainerNameFor('postgres-16'));
        expect(services.list(WS.id).find((r) => r.serviceId === 'svc-a')?.state).toBe('stopped');
    });

    it('still warms the sandbox when the host service cannot start', async () => {
        // A build without the bundled Sockudo, or one whose binary is missing.
        // The service records its own failure (which `list` then explains); what
        // must NOT happen is the rest of the open being lost with it — the
        // sandbox is the thing every site in this workspace needs.
        const runtime = fakeRuntime();
        const services = serviceManager(runtime, { [WS.id]: { 'ws-a': WEBSOCKETS } }, [WS], {
            hostWebSockets: {
                acquire: async () => {
                    throw new Error('Sockudo runtime is missing.');
                },
                release: async () => {},
                logs: () => '',
                stop: async () => {},
            },
        });
        const lifecycle = openLifecycle(services, { runtime });

        const result = await lifecycle.onWorkspaceOpen(WS.id);

        expect(result.ensured).toBe(true);
        expect(runtime.ran.map((s) => s.name)).toEqual([devContainerNameFor(WS.id)]);
        expect(services.list(WS.id)[0]).toMatchObject({
            state: 'failed',
            error: 'Sockudo runtime is missing.',
        });
    });
});

// --- workspace remove -------------------------------------------------------

describe('workspace remove', () => {
    it('RELEASES the workspace’s services before sweeping, so the refcount stays honest', async () => {
        // Two workspaces on one shared Postgres. `beta` is removed. If the sweep
        // ran without the release, `acme` would keep working (the engine carries
        // no workspace label, so it survives) but the manager would still count
        // `beta` as a holder forever — and the engine could never stop.
        const runtime = fakeRuntime();
        const services = serviceManager(
            runtime,
            { [WS.id]: { 'svc-a': PG }, [OTHER.id]: { 'svc-b': PG } },
            [WS, OTHER],
        );
        await services.acquire(WS.id, 'svc-a');
        await services.acquire(OTHER.id, 'svc-b');
        expect(services.list(WS.id)[0]?.holders).toBe(2);

        const lifecycle = createDevServerLifecycle({
            resolveRuntime: async () => ({ runtime, detection: await runtime.detect() }),
            workspaceFor: (id) => (id === OTHER.id ? OTHER : WS),
            devSitesFor: () => ({}),
            devServicesFor: (id): DevServices =>
                id === OTHER.id ? { 'svc-b': PG } : { 'svc-a': PG },
            sites: () => null,
            services: () => services,
            platform: 'linux',
            hostIds: null,
        });

        await lifecycle.onWorkspaceRemove(OTHER.id);

        expect(services.list(WS.id)[0]?.holders).toBe(1);
        // The engine keeps serving `acme` — it is NOT stopped, and it is NOT
        // swept, because it carries `genie.service`, never `genie.workspace`.
        const engineId = runtime.containers.get(serviceContainerNameFor('postgres-16'))?.id;
        expect(engineId).toBeTruthy();
        expect(runtime.stopped).not.toContain(engineId);
    });

    it('stops the workspace’s sites so `.gen` stops advertising a dead target', async () => {
        const runtime = fakeRuntime();
        const sites = siteManager(runtime, { [WS.id]: { 'site-1': SITE } });
        await sites.start(WS.id, 'site-1');
        expect(sites.genSites()).toHaveLength(1);

        const lifecycle = createDevServerLifecycle({
            resolveRuntime: async () => ({ runtime, detection: await runtime.detect() }),
            workspaceFor: () => WS,
            devSitesFor: () => ({ 'site-1': SITE }),
            devServicesFor: () => ({}),
            sites: () => sites,
            services: () => null,
            platform: 'linux',
            hostIds: null,
        });

        await lifecycle.onWorkspaceRemove(WS.id);

        expect(sites.genSites()).toEqual([]);
    });

    it('sweeps the sandbox — the containers labelled with the workspace, and its network', async () => {
        const runtime = fakeRuntime({
            existing: [
                {
                    id: 'id-dev',
                    name: devContainerNameFor(WS.id),
                    image: 'genie-dev',
                    state: 'running',
                    workspaceId: WS.id,
                },
            ],
        });
        const lifecycle = createDevServerLifecycle({
            resolveRuntime: async () => ({ runtime, detection: await runtime.detect() }),
            workspaceFor: () => WS,
            devSitesFor: () => ({}),
            devServicesFor: () => ({}),
            sites: () => null,
            services: () => null,
            platform: 'linux',
            hostIds: null,
        });

        const result = await lifecycle.onWorkspaceRemove(WS.id);

        expect(runtime.removed).toContain('id-dev');
        expect(runtime.removedNetworks).toContain(WS.id);
        expect(result.removedContainers).toBe(1);
        expect(result.removedNetwork).toBe(true);
    });

    it('completes on a machine that never had Docker', async () => {
        const lifecycle = createDevServerLifecycle({
            resolveRuntime: async () => ({ runtime: null, detection: NO_RUNTIME }),
            workspaceFor: () => WS,
            devSitesFor: () => ({}),
            devServicesFor: () => ({}),
            sites: () => null,
            services: () => null,
            platform: 'linux',
            hostIds: null,
        });

        await expect(lifecycle.onWorkspaceRemove(WS.id)).resolves.toEqual({
            removedContainers: 0,
            removedNetwork: false,
            errors: [],
        });
    });
});
