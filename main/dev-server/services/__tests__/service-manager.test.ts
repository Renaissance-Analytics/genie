import { describe, expect, it } from 'vitest';
import { SERVICE_LABEL, SHARED_SERVICES_NETWORK, WORKSPACE_LABEL } from '../../argv';
import { createDevServiceManager } from '../service-manager';
import type { DevServiceManagerDeps } from '../service-manager';
import type { DevServices } from '../services-config';
import type {
    ContainerRuntime,
    ContainerSpec,
    ContainerSummary,
    PortMapping,
    RuntimeDetection,
} from '../../container-runtime';

/**
 * The SERVICE MANAGER (Tynn #234, P3) — the owner's decision, executable.
 *
 * The thesis being proven here, in the phrase the owner used, is *"no dozens of
 * pgsql"*: two workspaces asking for Postgres 16 get ONE container between
 * them, each with its own database, role and credentials, and that container
 * goes away only when the LAST of them lets go.
 *
 * Four properties carry it, and each has a test that fails if it breaks:
 *
 *   1. **Deduplication.** The second workspace ADOPTS the first's container.
 *   2. **Reachability without visibility.** The shared engine is attached to
 *      each consuming workspace's own network, so every workspace can reach it
 *      and none can reach another.
 *   3. **Reference counting.** Start on first acquire, stop on last release —
 *      and NOT on the second-to-last.
 *   4. **No workspace label on a shared engine.** `teardownWorkspaceSandbox`
 *      sweeps by that label; a shared Postgres carrying one would be destroyed
 *      with the first workspace that removed itself.
 */

const DOCKER_OK: RuntimeDetection = { kind: 'docker', version: '29.6.1', probes: [] };

interface Fake extends ContainerRuntime {
    readonly ran: ContainerSpec[];
    readonly started: string[];
    readonly stopped: string[];
    readonly removed: string[];
    readonly removedVolumes: string[];
    readonly connected: { network: string; id: string }[];
    readonly disconnected: { network: string; id: string }[];
    readonly execs: { id: string; argv: string[] }[];
    readonly containers: Map<string, ContainerSummary>;
}

function fakeRuntime(opts: { detection?: RuntimeDetection; execFails?: string } = {}): Fake {
    const ran: ContainerSpec[] = [];
    const started: string[] = [];
    const stopped: string[] = [];
    const removed: string[] = [];
    const removedVolumes: string[] = [];
    const connected: { network: string; id: string }[] = [];
    const disconnected: { network: string; id: string }[] = [];
    const execs: { id: string; argv: string[] }[] = [];
    const containers = new Map<string, ContainerSummary>();
    const ports = new Map<string, PortMapping[]>();
    let nextHostPort = 49_800;

    return {
        kind: 'docker',
        ran,
        started,
        stopped,
        removed,
        removedVolumes,
        connected,
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
        async networkRemove() {},
        async networkConnect(network, id) {
            connected.push({ network, id });
        },
        async networkDisconnect(network, id) {
            disconnected.push({ network, id });
        },
        async volumeRemove(name) {
            removedVolumes.push(name);
        },
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
                ...(spec.workspaceId === null ? {} : { workspaceId: spec.workspaceId }),
            });
            ports.set(
                id,
                (spec.ports ?? []).map((p) => ({
                    container: p.container,
                    protocol: 'tcp' as const,
                    hostIp: p.hostIp ?? '127.0.0.1',
                    hostPort: (nextHostPort += 1),
                })),
            );
            return { id, name: spec.name };
        },
        async start(id) {
            started.push(id);
            for (const c of containers.values()) if (c.id === id) c.state = 'running';
        },
        async stop(id) {
            stopped.push(id);
            for (const c of containers.values()) if (c.id === id) c.state = 'exited';
        },
        async remove(id) {
            removed.push(id);
            for (const [name, c] of containers) if (c.id === id) containers.delete(name);
        },
        async exec(id, argv) {
            execs.push({ id, argv });
            if (opts.execFails && argv.join(' ').includes(opts.execFails)) {
                return { code: 1, stdout: '', stderr: 'engine said no' };
            }
            return { code: 0, stdout: '', stderr: '' };
        },
        async logs() {
            return 'ready to accept connections\n';
        },
        followLogs() {
            return { stop() {}, exited: Promise.resolve(0) };
        },
        async ps(workspaceId) {
            return [...containers.values()].filter(
                (c) => !workspaceId || c.workspaceId === workspaceId,
            );
        },
        async psServices() {
            // The fake stands in for the `genie.service` label filter: every
            // container this manager creates is a service engine.
            return [...containers.values()];
        },
        async portMappings(id) {
            return ports.get(id) ?? [];
        },
    };
}

// --- the workspaces + their configured services ------------------------------

const PG16 = {
    engine: 'postgres' as const,
    version: '16',
    dedicated: false,
    password: 'workspace_pw_0123456789',
    enabled: true,
};

function deps(
    runtime: Fake,
    services: Record<string, DevServices>,
    over: Partial<DevServiceManagerDeps> = {},
): DevServiceManagerDeps {
    return {
        resolveRuntime: async () => ({ runtime, detection: DOCKER_OK }),
        listWorkspaces: () =>
            Object.keys(services).map((id) => ({ id, path: `/work/${id}`, label: id })),
        devServicesFor: (id) => services[id] ?? {},
        engineAdmin: (req) => ({ user: req.adminUser, password: `admin_pw_for_${req.recordKey}` }),
        // Nothing real to probe in a unit test; readiness is proven live.
        probeReady: async () => true,
        readyTimeoutMs: 50,
        ...over,
    };
}

/** Config for one workspace holding a shared PG16. */
const pgFor = (serviceId: string): DevServices => ({ [serviceId]: { ...PG16 } });

describe('one engine, two workspaces', () => {
    it('starts ONE container and the second workspace adopts it', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a'), b: pgFor('svc-b') }),
        );

        const first = await manager.acquire('a', 'svc-a');
        const second = await manager.acquire('b', 'svc-b');

        expect(first.state).toBe('running');
        expect(second.state).toBe('running');
        // THE assertion of the phase.
        expect(runtime.ran.length).toBe(1);
        expect(second.containerId).toBe(first.containerId);
        expect(second.holders).toBe(2);
    });

    it('gives each workspace its OWN database and role on that one engine', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a'), b: pgFor('svc-b') }),
        );

        const first = await manager.acquire('a', 'svc-a');
        const second = await manager.acquire('b', 'svc-b');

        expect(first.namespace?.identifier).not.toBe(second.namespace?.identifier);
        const sql = runtime.execs.map((e) => e.argv.join(' ')).join('\n');
        expect(sql).toContain(`CREATE DATABASE "${first.namespace?.identifier}"`);
        expect(sql).toContain(`CREATE DATABASE "${second.namespace?.identifier}"`);
        // The statement that keeps A's role out of B's database.
        expect(sql).toContain(`REVOKE CONNECT ON DATABASE "${second.namespace?.identifier}" FROM PUBLIC`);
    });

    it('attaches the shared engine to EACH consuming workspace network', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a'), b: pgFor('svc-b') }),
        );
        await manager.acquire('a', 'svc-a');
        await manager.acquire('b', 'svc-b');

        expect(runtime.connected.map((c) => c.network)).toEqual(['genie-ws-a', 'genie-ws-b']);
        // Its HOME is the shared-services network — not whichever workspace
        // happened to be first, which would leave it homeless on that release.
        expect(runtime.ran[0].network).toBe(SHARED_SERVICES_NETWORK);
    });

    it('does NOT label a shared engine with a workspace', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        await manager.acquire('a', 'svc-a');

        const spec = runtime.ran[0];
        expect(spec.workspaceId).toBeNull();
        expect(spec.labels?.[WORKSPACE_LABEL]).toBeUndefined();
        expect(spec.labels?.[SERVICE_LABEL]).toBe('postgres-16');
    });

    it('keeps engine state in a named VOLUME, so replacing the container keeps the data', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        await manager.acquire('a', 'svc-a');
        expect(runtime.ran[0].volumes?.[0]).toMatchObject({
            name: 'genie-svc-postgres-16-data',
            target: '/var/lib/postgresql/data',
        });
        expect(runtime.ran[0].mounts ?? []).toEqual([]);
    });

    it('publishes the engine port to loopback so a person or an agent can connect', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        const status = await manager.acquire('a', 'svc-a');

        expect(runtime.ran[0].ports?.[0]).toMatchObject({ container: 5432, hostIp: '127.0.0.1' });
        const primary = status.endpoints?.find((e) => e.name === 'postgres');
        // Two surfaces, and they are DIFFERENT: containers dial the engine by
        // name on 5432, the desktop dials loopback on the published port.
        expect(primary?.host).toBe('genie-svc-postgres-16');
        expect(primary?.port).toBe(5432);
        expect(primary?.hostPort).toBeGreaterThan(1024);
    });
});

describe('reference counting', () => {
    it('keeps the engine running while ANY workspace still holds it', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a'), b: pgFor('svc-b') }),
        );
        await manager.acquire('a', 'svc-a');
        await manager.acquire('b', 'svc-b');

        await manager.release('a', 'svc-a');
        expect(runtime.stopped).toEqual([]);
        expect(runtime.disconnected.map((d) => d.network)).toEqual(['genie-ws-a']);

        await manager.release('b', 'svc-b');
        expect(runtime.stopped.length).toBe(1);
    });

    it('does not double-count one workspace acquiring twice', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        await manager.acquire('a', 'svc-a');
        const again = await manager.acquire('a', 'svc-a');
        expect(again.holders).toBe(1);
        await manager.release('a', 'svc-a');
        expect(runtime.stopped.length).toBe(1);
    });

    it('restarts a STOPPED engine rather than creating a second one', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        await manager.acquire('a', 'svc-a');
        await manager.release('a', 'svc-a');
        await manager.acquire('a', 'svc-a');

        expect(runtime.ran.length).toBe(1);
        expect(runtime.started.length).toBe(1);
    });

    it('re-provisions on every acquire — Redis ACLs do not survive a restart', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        await manager.acquire('a', 'svc-a');
        const first = runtime.execs.length;
        await manager.release('a', 'svc-a');
        await manager.acquire('a', 'svc-a');
        expect(runtime.execs.length).toBeGreaterThan(first);
    });
});

describe('dedicated (the opt-in escape hatch)', () => {
    it('runs a SEPARATE container, on the workspace network, labelled with the workspace', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, {
                a: pgFor('svc-a'),
                b: { 'svc-b': { ...PG16, dedicated: true } },
            }),
        );
        const shared = await manager.acquire('a', 'svc-a');
        const dedicated = await manager.acquire('b', 'svc-b');

        expect(runtime.ran.length).toBe(2);
        expect(dedicated.containerId).not.toBe(shared.containerId);
        const spec = runtime.ran[1];
        expect(spec.workspaceId).toBe('b');
        expect(spec.network).toBe('genie-ws-b');
        // Already on the workspace's network — nothing to attach.
        expect(runtime.connected.map((c) => c.network)).toEqual(['genie-ws-a']);
        expect(dedicated.dedicated).toBe(true);
    });

    it('gives a dedicated engine its own volume, so it cannot read the shared data', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, { b: { 'svc-b': { ...PG16, dedicated: true } } }),
        );
        await manager.acquire('b', 'svc-b');
        expect(runtime.ran[0].volumes?.[0].name).not.toBe('genie-svc-postgres-16-data');
    });
});

describe('env wiring', () => {
    it('hands a workspace the env its site containers need, and only its own', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a'), b: pgFor('svc-b') }),
        );
        const a = await manager.acquire('a', 'svc-a');
        await manager.acquire('b', 'svc-b');

        const env = manager.envFor('a');
        expect(env.DATABASE_URL).toContain(a.namespace?.identifier ?? '!');
        expect(env.DATABASE_URL).toContain('genie-svc-postgres-16:5432');
        expect(env.DATABASE_URL).not.toContain(manager.envFor('b').PGDATABASE ?? '!');
    });

    it('is empty for a workspace holding nothing', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        expect(manager.envFor('a')).toEqual({});
    });
});

describe('failures are STATUSES', () => {
    it('reports no container runtime with the install hint, and never throws', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a') }, {
                resolveRuntime: async () => ({
                    runtime: null,
                    detection: {
                        kind: 'none',
                        reason: 'not-installed',
                        installHint: 'Install Docker Desktop.',
                        probes: [],
                    },
                }),
            }),
        );
        const status = await manager.acquire('a', 'svc-a');
        expect(status.state).toBe('failed');
        expect(status.error).toContain('Install Docker Desktop.');
    });

    it('reports a provisioning failure against the engine that refused it', async () => {
        const runtime = fakeRuntime({ execFails: 'CREATE DATABASE' });
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        const status = await manager.acquire('a', 'svc-a');
        expect(status.state).toBe('failed');
        expect(status.error).toContain('engine said no');
    });

    it('reports an unknown service id rather than inventing one', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        const status = await manager.acquire('a', 'nope');
        expect(status.state).toBe('failed');
        expect(status.error).toContain('nope');
    });
});

describe('list + reconcile', () => {
    it('lists configured services with their live state', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a'), b: pgFor('svc-b') }),
        );
        expect(manager.list('a')).toHaveLength(1);
        expect(manager.list('a')[0].state).toBe('stopped');
        await manager.acquire('a', 'svc-a');
        expect(manager.list('a')[0].state).toBe('running');
        expect(manager.list()).toHaveLength(2);
    });

    it('acquires every ENABLED service and releases what is no longer wanted', async () => {
        const runtime = fakeRuntime();
        const services: Record<string, DevServices> = { a: pgFor('svc-a') };
        const manager = createDevServiceManager(deps(runtime, services));

        await manager.reconcile();
        expect(runtime.ran.length).toBe(1);

        services.a = { 'svc-a': { ...PG16, enabled: false } };
        await manager.reconcile();
        expect(runtime.stopped.length).toBe(1);
    });
});

describe('remove', () => {
    it('releases first, then drops the container and its volume when nobody holds it', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        await manager.acquire('a', 'svc-a');
        await manager.remove('a', 'svc-a', { purge: true });

        expect(runtime.removed.length).toBe(1);
        expect(runtime.removedVolumes).toContain('genie-svc-postgres-16-data');
    });

    it('refuses to purge an engine another workspace is still holding', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a'), b: pgFor('svc-b') }),
        );
        await manager.acquire('a', 'svc-a');
        await manager.acquire('b', 'svc-b');
        await manager.remove('a', 'svc-a', { purge: true });

        // A's slice is gone, but B is still using the engine — dropping the
        // volume here would destroy B's data.
        expect(runtime.removed).toEqual([]);
        expect(runtime.removedVolumes).toEqual([]);
    });
});
