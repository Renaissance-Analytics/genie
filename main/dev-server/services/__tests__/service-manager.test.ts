import { describe, expect, it } from 'vitest';
import { SERVICE_LABEL, SHARED_SERVICES_NETWORK, WORKSPACE_LABEL } from '../../argv';
import { workspaceSqlIdentifier } from '../catalog';
import { createDevServiceManager } from '../service-manager';
import { preferredServicePort } from '../service-ports';
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
    /** Images this runtime was asked to pull (#242 P3, multi-version install). */
    readonly pulled: string[];
    /** The published-port map, so a test can move a port underneath the manager —
     *  which is exactly what a container recreate does in production. */
    readonly ports: Map<string, PortMapping[]>;
}

function fakeRuntime(
    opts: {
        detection?: RuntimeDetection;
        execFails?: string;
        publishNothing?: boolean;
        /** No image is on this machine — the pre-install (#242 P3) case. */
        imageMissing?: boolean;
        /** Pre-seed already-RUNNING containers with NO published ports, to stand in
         *  for a container adopted from an older Genie that never published its
         *  engine port to loopback (moic beta.245 — the adoption gap). */
        seedUnpublished?: Array<{ name: string; id: string }>;
    } = {},
): Fake {
    const ran: ContainerSpec[] = [];
    const started: string[] = [];
    const stopped: string[] = [];
    const removed: string[] = [];
    const removedVolumes: string[] = [];
    const connected: { network: string; id: string }[] = [];
    const disconnected: { network: string; id: string }[] = [];
    const execs: { id: string; argv: string[] }[] = [];
    const pulled: string[] = [];
    const containers = new Map<string, ContainerSummary>();
    const ports = new Map<string, PortMapping[]>();
    let nextHostPort = 49_800;
    for (const seed of opts.seedUnpublished ?? []) {
        // Running, but no `ports.set` — so portMappings returns [] for it, exactly
        // like a container created before loopback publishing existed.
        containers.set(seed.name, { id: seed.id, name: seed.name, image: 'seeded', state: 'running' });
    }

    return {
        kind: 'docker',
        ran,
        started,
        // Exposed so a test can change a published port underneath the manager —
        // which is exactly what a container recreate does in production.
        ports,
        stopped,
        removed,
        removedVolumes,
        connected,
        disconnected,
        execs,
        pulled,
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
            return !opts.imageMissing;
        },
        async pullImage(image) {
            pulled.push(image);
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
            // `publishNothing` stands in for a host whose runtime published (or
            // surfaced) NO loopback port for the engine — the container is up and
            // ready via its own in-container check, but `docker port` returns
            // nothing, so no endpoint carries a hostPort. This is the state that
            // silently strips a host-native site's DB env (moic's beta.245 report).
            ports.set(
                id,
                opts.publishNothing
                    ? []
                    : (spec.ports ?? []).map((p) => ({
                          container: p.container,
                          protocol: 'tcp' as const,
                          hostIp: p.hostIp ?? '127.0.0.1',
                          // A real runtime honours an explicit host port and picks
                          // only when asked to — publishing on a number other than
                          // the one requested is not a thing Docker does.
                          hostPort: p.host ?? (nextHostPort += 1),
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
        // Base64url-shaped, like the real `generateServicePassword` — a DEDICATED
        // engine's recordKey carries an `@`, and `provision.ts` rightly refuses an
        // admin password that is not a generated one.
        engineAdmin: (req) => ({
            user: req.adminUser,
            password: `admin_pw_for_${req.recordKey.replace(/[^A-Za-z0-9_-]/g, '_')}`,
        }),
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

    it('hostEnvFor reaches the engine on 127.0.0.1:<published port>, so a HOST process can hit the DB', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        const status = await manager.acquire('a', 'svc-a');
        const hostPort = status.endpoints?.find((e) => e.name === 'postgres')?.hostPort;
        expect(hostPort).toBeGreaterThan(1024);

        // The SITE-container form dials the engine by container NAME (a sibling
        // container) — a managed process on the HOST cannot resolve that name. So
        // hostEnvFor swaps in the published loopback port, which is what lets a
        // host-run `queue:work` / test / dev server actually reach the DB.
        const containerEnv = manager.envFor('a');
        expect(containerEnv.DB_HOST).toBe('genie-svc-postgres-16');

        const hostEnv = manager.hostEnvFor('a');
        expect(hostEnv.DB_HOST).toBe('127.0.0.1');
        expect(hostEnv.DB_PORT).toBe(String(hostPort));
        expect(hostEnv.DATABASE_URL).toContain(`@127.0.0.1:${hostPort}/`);
    });

    it('hostEnvFor is EMPTY when a live engine has no published loopback port — the silent DB-less trap', async () => {
        // The engine is up and READY (its in-container check passes), but the host
        // published/surfaced no loopback port — so a host-native site gets NOTHING
        // to reach the DB with and falls back to its repo `.env` (moic beta.245).
        const runtime = fakeRuntime({ publishNothing: true });
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        const status = await manager.acquire('a', 'svc-a');

        expect(status.state).toBe('running');
        expect(status.endpoints?.every((e) => e.hostPort === undefined)).toBe(true);
        // The container-form env still works (it dials the engine by NAME), which
        // is why a CONTAINER site is fine while a host-native one is broken.
        expect(manager.envFor('a').DB_HOST).toBe('genie-svc-postgres-16');
        // The trap: silently empty, with no signal that the DB is unreachable.
        expect(manager.hostEnvFor('a')).toEqual({});
    });

    it('RE-CREATES an adopted engine that has NO published loopback port, restoring host env (moic beta.245)', async () => {
        // The adoption gap: a Postgres container already exists (adopted from an
        // older Genie) but was never published to loopback, so a host-native site
        // gets no DB env. A published port is fixed at CREATE — the only fix is to
        // re-create the container WITH the publication; the named volume keeps the
        // data. After acquire, the host env must be populated.
        const runtime = fakeRuntime({
            seedUnpublished: [{ name: 'genie-svc-postgres-16', id: 'old-unpublished-pg' }],
        });
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        const status = await manager.acquire('a', 'svc-a');

        expect(status.state).toBe('running');
        // The unpublished container was removed and a published one created for it.
        expect(runtime.removed).toContain('old-unpublished-pg');
        expect(runtime.ran.some((s) => s.name === 'genie-svc-postgres-16')).toBe(true);
        // The whole point: a HOST process can now reach the DB.
        const hostEnv = manager.hostEnvFor('a');
        expect(hostEnv.DB_HOST).toBe('127.0.0.1');
        expect(Number(hostEnv.DB_PORT)).toBeGreaterThan(1024);
    });

    it('does NOT re-create an adopted engine that is ALREADY published (no needless restart)', async () => {
        // First acquire creates + publishes the shared container; a second acquire
        // (another workspace) adopts it. Since it IS published, adoption must reuse
        // it as-is — never stop/remove a healthy shared engine.
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a'), b: pgFor('svc-b') }),
        );
        await manager.acquire('a', 'svc-a');
        const runsAfterFirst = runtime.ran.length;
        await manager.acquire('b', 'svc-b');

        // No re-creation, no removal — the adopted published container is reused.
        expect(runtime.ran.length).toBe(runsAfterFirst);
        expect(runtime.removed).toEqual([]);
        expect(manager.hostEnvFor('b').DB_HOST).toBe('127.0.0.1');
    });

    it('re-creates a mis-published engine AT MOST ONCE — a runtime that never reports a port cannot loop', async () => {
        // A runtime that keeps publishing nothing (a broken `docker port`, say):
        // the adopted container has no host port, so we re-create it once — but the
        // new one also reports none, and we must NOT stop/remove/recreate forever.
        const runtime = fakeRuntime({
            publishNothing: true,
            seedUnpublished: [{ name: 'genie-svc-postgres-16', id: 'old-unpublished-pg' }],
        });
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        await manager.acquire('a', 'svc-a');
        await manager.acquire('a', 'svc-a'); // a second pass must not re-create again

        // Exactly one re-creation: the seeded container removed once, one create.
        expect(runtime.removed).toEqual(['old-unpublished-pg']);
        expect(runtime.ran.filter((s) => s.name === 'genie-svc-postgres-16')).toHaveLength(1);
    });

    it('hostEnvReportFor says WHY host env is empty — enabled vs live vs host-published', async () => {
        // Healthy: the engine is live AND has a published loopback port.
        const healthy = createDevServiceManager(deps(fakeRuntime(), { a: pgFor('svc-a') }));
        await healthy.acquire('a', 'svc-a');
        const ok = healthy.hostEnvReportFor('a');
        expect(ok).toMatchObject({ enabled: 1, live: 1, withHostPort: 1, gaps: [] });
        expect(ok.env.DB_HOST).toBe('127.0.0.1');

        // Degraded: the engine is live but nothing is published — the report names
        // the engine that has no host port, so the site can log an actionable line
        // instead of serving DB-less in silence.
        const degraded = createDevServiceManager(
            deps(fakeRuntime({ publishNothing: true }), { a: pgFor('svc-a') }),
        );
        await degraded.acquire('a', 'svc-a');
        const bad = degraded.hostEnvReportFor('a');
        expect(bad).toMatchObject({ enabled: 1, live: 1, withHostPort: 0 });
        expect(bad.gaps).toEqual([
            { engine: 'postgres', version: '16', reason: 'no-host-port' },
        ]);
        expect(bad.env).toEqual({});
    });

    it('reports an ENABLED engine that contributed NOTHING even when another one did (genie#204)', async () => {
        // The first-hand failure: postgres was injected (correct DB_PORT) while
        // redis contributed nothing, so the app fell back to redis on 6379 and
        // 500'd every request. The report has to name redis — a healthy postgres
        // must not make the missing one invisible.
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, {
                a: {
                    'svc-pg': { ...PG16 },
                    'svc-redis': {
                        engine: 'redis',
                        version: '7',
                        dedicated: false,
                        password: 'workspace_pw_0123456789',
                        enabled: true,
                    },
                },
            }),
        );
        // Only postgres is acquired — redis is enabled but never came up here.
        await manager.acquire('a', 'svc-pg');

        const report = manager.hostEnvReportFor('a');
        expect(report.env.DB_PORT).toBeTruthy();
        expect(report.env.REDIS_PORT).toBeUndefined();
        expect(report).toMatchObject({ enabled: 2, live: 1, withHostPort: 1 });
        expect(report.gaps).toEqual([{ engine: 'redis', version: '7', reason: 'not-live' }]);
    });

    it('carries the failure it already recorded for a service that could not start', async () => {
        // The manager knows exactly why the engine is not live (`lastFailure`);
        // throwing that away is what forced a human to re-derive it from a 500.
        const runtime = fakeRuntime({ execFails: 'CREATE DATABASE' });
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        const status = await manager.acquire('a', 'svc-a');
        expect(status.state).toBe('failed');

        const report = manager.hostEnvReportFor('a');
        expect(report.gaps).toHaveLength(1);
        expect(report.gaps[0]).toMatchObject({ engine: 'postgres', reason: 'not-live' });
        expect(report.gaps[0].error).toBeTruthy();
    });

    it('does NOT call the inactive version of an engine a gap — it contributes by design', async () => {
        // A workspace can hold postgres 16 AND 17; only the ACTIVE one owns the
        // single-valued DB_* names (#242 P3). Reporting the other as missing env
        // would be a permanent false alarm on every start.
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, {
                a: {
                    'svc-16': { ...PG16, active: true },
                    'svc-17': { ...PG16, version: '17' },
                },
            }),
        );
        await manager.acquire('a', 'svc-16');
        await manager.acquire('a', 'svc-17');

        const report = manager.hostEnvReportFor('a');
        expect(report.gaps).toEqual([]);
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

/**
 * The MACHINE-level surface (the workstation Dev Server page).
 *
 * Because engines are SHARED, their inventory and their start/stop belong to
 * the machine, not to any one workspace — and they have to be driven by the
 * manager that owns the reference count, not beside it. A second code path
 * stopping a container the manager still believes is held would leave every
 * holder pointing at something that is gone, and the next release would then
 * "stop" an already-dead container while the workspaces that were using it
 * silently fail to connect.
 */
describe('the machine-level view', () => {
    it('reports the live reference count, per engine container', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a'), b: pgFor('svc-b') }),
        );
        await manager.acquire('a', 'svc-a');
        await manager.acquire('b', 'svc-b');

        const rows = await manager.inventory();
        const pg16 = rows.find((r) => r.recordKey === 'postgres-16');
        expect(pg16).toMatchObject({ state: 'running', holders: 2, configured: 2 });
        expect(pg16?.workspaces).toEqual(['a', 'b']);
    });

    it('answers with the catalog even when no runtime is available', async () => {
        // Most machines have no Docker the first time this page is opened. "What
        // could I run here" is exactly the question that state has to answer, so
        // an absent runtime is an empty container list — never a throw.
        const manager = createDevServiceManager(
            deps(fakeRuntime(), {}, {
                resolveRuntime: async () => ({
                    runtime: null,
                    detection: { kind: 'none', reason: 'not-installed', probes: [] },
                }),
            }),
        );
        const rows = await manager.inventory();
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.state === 'absent' && !r.installed)).toBe(true);
    });

    it('STOPS a shared engine and drops every hold on it, so the count stays honest', async () => {
        // A machine-level stop is a deliberately blunt instrument: the container
        // is down, so nobody is holding anything, and saying otherwise would
        // make the NEXT release stop an engine that is already stopped while
        // reporting workspaces as connected to it.
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a'), b: pgFor('svc-b') }),
        );
        await manager.acquire('a', 'svc-a');
        await manager.acquire('b', 'svc-b');

        const res = await manager.engineAction({ recordKey: 'postgres-16', action: 'stop' });
        expect(res.ok).toBe(true);
        expect(runtime.stopped.length).toBe(1);

        const rows = await manager.inventory();
        expect(rows.find((r) => r.recordKey === 'postgres-16')).toMatchObject({
            state: 'stopped',
            holders: 0,
        });
        // And the workspaces now report the service as not running, rather than
        // claiming a connection to a container that is down.
        expect(manager.list('a')[0]?.state).not.toBe('running');
    });

    it('STARTS a stopped engine by re-acquiring it for the workspaces that use it', async () => {
        // Not a bare `docker start`: a Redis ACL user lives in memory and is
        // gone after a restart, so a machine-level start has to go back through
        // provisioning or the workspaces come back to an engine that refuses
        // their credentials.
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        await manager.acquire('a', 'svc-a');
        await manager.engineAction({ recordKey: 'postgres-16', action: 'stop' });

        const res = await manager.engineAction({ recordKey: 'postgres-16', action: 'start' });
        expect(res.ok).toBe(true);
        expect(manager.list('a')[0]?.state).toBe('running');
        expect(
            (await manager.inventory()).find((r) => r.recordKey === 'postgres-16'),
        ).toMatchObject({ state: 'running', holders: 1 });
    });

    it('refuses to start an engine no workspace uses, and says why', async () => {
        // There is nothing to start: an engine with no consumer has no
        // credentials to provision and nothing to serve. An error that names the
        // remedy beats a button that appears to do nothing.
        const manager = createDevServiceManager(deps(fakeRuntime(), {}));
        const res = await manager.engineAction({ recordKey: 'postgres-16', action: 'start' });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/no workspace/i);
    });

    it('tails the engine log for a machine-level row', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        await manager.acquire('a', 'svc-a');
        const res = await manager.engineAction({
            recordKey: 'postgres-16',
            action: 'logs',
            tail: 20,
        });
        expect(res.ok).toBe(true);
        expect(res.logs).toContain('ready to accept connections');
    });

    it('reports a missing container as a failure rather than pretending to act', async () => {
        const manager = createDevServiceManager(deps(fakeRuntime(), {}));
        const res = await manager.engineAction({ recordKey: 'postgres-16', action: 'stop' });
        expect(res.ok).toBe(false);
        expect(res.error).toBeTruthy();
    });
});

/**
 * MULTI-VERSION pre-install (#242 P3).
 *
 * Each (engine, version) is its own image, container and VOLUME, so holding
 * postgres 17 ready while 16 serves today is cheap — and it is the one machine
 * action with NO consumer requirement: a version nobody uses yet is exactly what
 * someone wants downloaded before they need it. It PULLS ONLY; a pre-installed
 * image is not a running engine, and starting still needs a workspace.
 */
describe('engineAction — install (multi-version)', () => {
    it('pulls the image for a version no workspace uses yet', async () => {
        const runtime = fakeRuntime({ imageMissing: true });
        const manager = createDevServiceManager(
            deps(runtime, {}, { confirmImagePull: () => true }),
        );

        const res = await manager.engineAction({ recordKey: 'postgres-17', action: 'install' });
        expect(res.ok).toBe(true);
        // The CATALOG's image for that major (pgvector, so extensions work) —
        // derived, never a tag the caller supplied.
        expect(runtime.pulled).toEqual(['pgvector/pgvector:pg17']);
        // A pull is not a start: nothing was run, so no engine came up.
        expect(runtime.ran).toHaveLength(0);
    });

    it('does not download without consent, and says so', async () => {
        // ABSENT MEANS NO PULL — the same default the acquire path uses. A
        // settings page must not be able to start a 400MB download unasked.
        const runtime = fakeRuntime({ imageMissing: true });
        const manager = createDevServiceManager(
            deps(runtime, {}, { confirmImagePull: () => false }),
        );

        const res = await manager.engineAction({ recordKey: 'postgres-17', action: 'install' });
        expect(res.ok).toBe(false);
        expect(runtime.pulled).toEqual([]);
    });

    it('is a no-op success when the image is already on this machine', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, {}, { confirmImagePull: () => true }));

        const res = await manager.engineAction({ recordKey: 'postgres-16', action: 'install' });
        expect(res.ok).toBe(true);
        expect(runtime.pulled).toEqual([]);
    });

    it('refuses a version it has no image pinned for rather than pulling an arbitrary tag', async () => {
        // The recordKey becomes an image TAG, so an unknown one is an arbitrary
        // image to run with a workspace's data in it — the same refusal
        // `resolveEngineVersion` makes.
        const runtime = fakeRuntime({ imageMissing: true });
        const manager = createDevServiceManager(deps(runtime, {}, { confirmImagePull: () => true }));

        const res = await manager.engineAction({ recordKey: 'postgres-99', action: 'install' });
        expect(res.ok).toBe(false);
        expect(runtime.pulled).toEqual([]);
    });
});

/**
 * The reported port must be the port Docker actually publishes (genie#204-adjacent,
 * reported independently by two agents).
 *
 * An engine's published port is EPHEMERAL — `HostPort: ""`, Docker chooses at
 * create — and the manager read it once, at acquire, then served that snapshot
 * from `list` / `status` / `connection` forever. When the container was recreated
 * the record and Docker diverged silently, and because the reported port is
 * injected into host-native sites and terminals as DB_PORT, a wrong record
 * silently overrode a correct `.env`: `php artisan migrate` failed with
 * "connection refused" against a database that was perfectly healthy.
 *
 * Worse, `ready` stayed TRUE throughout, because readiness is asked INSIDE the
 * container. Genie was reporting an address nothing was listening on, and calling
 * it ready.
 */
describe('a published port that changed underneath us', () => {
    it('re-reads the LIVE mapping instead of serving the one from acquire', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));

        const acquired = await manager.acquire('a', 'svc-a');
        const before = acquired.endpoints?.[0]?.hostPort;
        if (before === undefined) throw new Error('the fake published no port');

        // The container is recreated out from under Genie — a Docker restart, a
        // prune, a person. Same container id in this fake; a new published port.
        runtime.ports.set(acquired.containerId ?? '', [
            { container: 5432, hostPort: before + 7000, protocol: 'tcp', hostIp: '127.0.0.1' },
        ]);

        await manager.refresh();
        expect(manager.list('a')[0]?.endpoints?.[0]?.hostPort).toBe(before + 7000);
    });

    it('does not report READY for an address nothing answers on', async () => {
        // `ready: true` has to mean "something answered where I said it was".
        // Asking the engine inside its own container cannot know the published
        // port is wrong — which is exactly how this went unnoticed.
        const runtime = fakeRuntime();
        const reachable = new Set<number>();
        const manager = createDevServiceManager({
            ...deps(runtime, { a: pgFor('svc-a') }),
            probeReady: async ({ port }) => reachable.has(port),
        });

        const acquired = await manager.acquire('a', 'svc-a');
        reachable.add(acquired.endpoints?.[0]?.hostPort ?? 0);
        await manager.refresh();
        expect(manager.list('a')[0]?.ready).toBe(true);

        // Now nothing is listening there any more.
        reachable.clear();
        await manager.refresh();
        expect(manager.list('a')[0]?.ready).toBe(false);
    });

    it('leaves an engine alone when the runtime cannot be read', async () => {
        // A runtime hiccup must not blank out a working record — that would turn
        // a transient failure into a wrong answer, which is the whole complaint.
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        const acquired = await manager.acquire('a', 'svc-a');
        const before = acquired.endpoints?.[0]?.hostPort;

        runtime.portMappings = async () => {
            throw new Error('docker is not answering');
        };

        await expect(manager.refresh()).resolves.toBeUndefined();
        expect(manager.list('a')[0]?.endpoints?.[0]?.hostPort).toBe(before);
    });
});

/**
 * PURGING A SHARED VOLUME (Tynn #250, step 4).
 *
 * A shared engine's data volume is ONE volume for the whole machine —
 * `genie-svc-postgres-16-data` holds every workspace's database on Postgres 16.
 * The original guard asked whether anyone was HOLDING the engine, which counts
 * workspaces live in this process right now. A Genie App whose window is closed
 * holds nothing, and neither does a workspace nobody has opened since Genie
 * started — so a single `manageService remove … purge=true` from the only open
 * workspace deleted their data and reported success.
 *
 * Co-tenancy on a shared volume is a property of who has a SLICE PROVISIONED in
 * it, not of who happens to be connected.
 */
describe('purging a shared volume', () => {
    it('refuses when another workspace has a slice in it, even though that workspace is NOT running', async () => {
        const runtime = fakeRuntime();
        // `b` is configured for the same shared PG16 and is never acquired —
        // a Genie App with its window closed, or a project nobody has opened.
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a'), b: pgFor('svc-b') }),
        );
        await manager.acquire('a', 'svc-a');

        const result = await manager.remove('a', 'svc-a', { purge: true });

        expect(runtime.removedVolumes).toEqual([]);
        expect(runtime.removed).toEqual([]);
        expect(result.purged).toBe(false);
    });

    it('names the slice it protected, and why', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a'), b: pgFor('svc-b') }),
        );
        await manager.acquire('a', 'svc-a');

        const result = await manager.remove('a', 'svc-a', { purge: true });

        expect(result.declined).toBeTruthy();
        // The workspace, and the name its data actually goes by inside the engine.
        expect(result.declined).toContain('b');
        expect(result.declined).toContain(workspaceSqlIdentifier('b'));
        expect(result.tenants).toEqual([expect.objectContaining({ workspaceId: 'b' })]);
    });

    it('still purges when this workspace is the volume’s only tenant', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));
        await manager.acquire('a', 'svc-a');

        const result = await manager.remove('a', 'svc-a', { purge: true });

        expect(result.purged).toBe(true);
        expect(runtime.removedVolumes).toContain('genie-svc-postgres-16-data');
    });

    it('fails CLOSED when a workspace’s stored services cannot be read', async () => {
        const runtime = fakeRuntime();
        const services: Record<string, DevServices> = { a: pgFor('svc-a'), b: pgFor('svc-b') };
        const manager = createDevServiceManager(
            deps(runtime, services, {
                devServicesFor: (id) => {
                    // `b`'s row is unreadable. Its tenancy is UNKNOWN, and an
                    // unknown tenancy is the one case where guessing destroys data.
                    if (id === 'b') throw new Error('services_json is not JSON');
                    return services[id] ?? {};
                },
            }),
        );
        await manager.acquire('a', 'svc-a');

        const result = await manager.remove('a', 'svc-a', { purge: true });

        expect(result.purged).toBe(false);
        expect(runtime.removedVolumes).toEqual([]);
    });

    it('purges a DEDICATED engine, whose volume is this workspace’s alone', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(
            deps(runtime, {
                a: { 'svc-a': { ...PG16, dedicated: true } },
                b: pgFor('svc-b'),
            }),
        );
        await manager.acquire('a', 'svc-a');

        const result = await manager.remove('a', 'svc-a', { purge: true });

        expect(result.purged).toBe(true);
        expect(runtime.removedVolumes).toContain('genie-svc-postgres-16-a-data');
    });
});

/**
 * THE REPO'S `.env` FOLLOWS THE SERVICE (genie#242).
 *
 * A workspace's service connection is the application's configuration, and the
 * application reads it out of `.env`. Genie never wrote that file — it injected
 * the values into a terminal at spawn instead, where a hosted site, a
 * `manageProcess` worker and a shell the user opened themselves never saw them,
 * and where (Laravel's dotenv being immutable) a value that had since gone stale
 * OVERRODE the `.env` somebody had just corrected.
 *
 * The manager is where the truth about a published port lives, so it is what has
 * to say when the file needs rewriting. These tests pin WHEN it says so —
 * especially the third, which is the reported failure: a restart moved Postgres
 * from 51157 to 58377 and nothing updated the file.
 */
describe('the service env reaches the repo .env', () => {
    it('announces a workspace when a service is BOUND', async () => {
        const runtime = fakeRuntime();
        const synced: string[] = [];
        const manager = createDevServiceManager({
            ...deps(runtime, { a: pgFor('svc-a') }),
            onServiceEnvChanged: (id) => synced.push(id),
        });

        await manager.acquire('a', 'svc-a');

        expect(synced).toContain('a');
    });

    it('announces it again when a REFRESH finds the published port has MOVED', async () => {
        // The reported bug, exactly: live Postgres on 58377, `repos/tynn/.env`
        // still saying 51157. A port moves on a container recreate — and a Genie
        // restart is one of the things that recreates one — so binding alone is
        // not enough; the file has to follow the port.
        const runtime = fakeRuntime();
        const synced: string[] = [];
        const manager = createDevServiceManager({
            ...deps(runtime, { a: pgFor('svc-a') }),
            onServiceEnvChanged: (id) => synced.push(id),
        });
        const acquired = await manager.acquire('a', 'svc-a');
        const before = acquired.endpoints?.[0]?.hostPort;
        if (before === undefined) throw new Error('the fake published no port');
        synced.length = 0;

        runtime.ports.set(acquired.containerId ?? '', [
            { container: 5432, hostPort: before + 7000, protocol: 'tcp', hostIp: '127.0.0.1' },
        ]);
        await manager.refresh();

        expect(synced).toEqual(['a']);
    });

    it('stays SILENT when a refresh finds nothing has moved', async () => {
        // Otherwise every readiness tick rewrites the user's `.env`. The write is
        // idempotent, but a lifecycle that announces a change on every poll is one
        // nobody can reason about.
        const runtime = fakeRuntime();
        const synced: string[] = [];
        const manager = createDevServiceManager({
            ...deps(runtime, { a: pgFor('svc-a') }),
            onServiceEnvChanged: (id) => synced.push(id),
        });
        await manager.acquire('a', 'svc-a');
        synced.length = 0;

        await manager.refresh();

        expect(synced).toEqual([]);
    });

    it('announces a workspace when a service is RELEASED', async () => {
        const runtime = fakeRuntime();
        const synced: string[] = [];
        const manager = createDevServiceManager({
            ...deps(runtime, { a: pgFor('svc-a') }),
            onServiceEnvChanged: (id) => synced.push(id),
        });
        await manager.acquire('a', 'svc-a');
        synced.length = 0;

        await manager.release('a', 'svc-a');

        expect(synced).toEqual(['a']);
    });

    it('a listener that throws cannot fail bringing a database up', async () => {
        const runtime = fakeRuntime();
        const manager = createDevServiceManager({
            ...deps(runtime, { a: pgFor('svc-a') }),
            onServiceEnvChanged: () => {
                throw new Error('the .env is read-only');
            },
        });

        const status = await manager.acquire('a', 'svc-a');

        expect(status.state).toBe('running');
    });
});

/**
 * A PUBLISHED PORT THAT DOES NOT MOVE (genie#242 follow-up).
 *
 * The engine container was created with no host port — "anything free" — so the
 * runtime picked a new number every time one was created, and a Genie restart
 * creates one. genie#242 answered by rewriting the repo `.env` whenever the number
 * moved. That is necessary, but it is a RACE, and five agents in one week landed
 * inside it: `.env` saying 51157 while Postgres answered on 58377.
 *
 * These tests are the other half — the number stops moving. See
 * `../service-ports.ts` for the derive-then-remember rule.
 */
describe('a published port that does not move', () => {
    const PG16_KEY = 'postgres-16';
    const wanted = preferredServicePort(PG16_KEY, 'postgres');

    /** A ledger backed by a plain object, standing in for `dev_service_ports`. */
    function ledger(seed: Record<string, Record<string, number>> = {}) {
        const rows: Record<string, Record<string, number>> = { ...seed };
        return {
            rows,
            read: (recordKey: string) => rows[recordKey] ?? {},
            save: (recordKey: string, ports: Record<string, number>) => {
                rows[recordKey] = { ...(rows[recordKey] ?? {}), ...ports };
            },
        };
    }

    const stable = (
        store: ReturnType<typeof ledger>,
        isPortFree: (port: number) => Promise<boolean> = async () => true,
    ) => ({
        servicePorts: { read: store.read, save: store.save },
        isPortFree,
    });

    it('asks the runtime for a DERIVED host port, not for whatever is free', async () => {
        const runtime = fakeRuntime();
        const store = ledger();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }, stable(store)));

        await manager.acquire('a', 'svc-a');

        expect(runtime.ran[0].ports?.[0]).toMatchObject({ container: 5432, host: wanted });
    });

    it('asks for the SAME port when the container is created again', async () => {
        const store = ledger();
        const first = fakeRuntime();
        await createDevServiceManager(deps(first, { a: pgFor('svc-a') }, stable(store))).acquire(
            'a',
            'svc-a',
        );

        // A fresh Genie, a fresh runtime, the container gone: the old code handed
        // out a brand-new ephemeral number here, and the `.env` went stale.
        const second = fakeRuntime();
        await createDevServiceManager(deps(second, { a: pgFor('svc-a') }, stable(store))).acquire(
            'a',
            'svc-a',
        );

        // Asserted to be a NUMBER first: "both undefined" is the bug, not the fix.
        expect(first.ran[0].ports?.[0].host).toBe(wanted);
        expect(second.ran[0].ports?.[0].host).toBe(first.ran[0].ports?.[0].host);
    });

    it('REMEMBERS the port it was given', async () => {
        const runtime = fakeRuntime();
        const store = ledger();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }, stable(store)));

        await manager.acquire('a', 'svc-a');

        expect(store.rows[PG16_KEY]).toEqual({ postgres: wanted });
    });

    it('re-requests a REMEMBERED port ahead of the derived one', async () => {
        const runtime = fakeRuntime();
        const store = ledger({ [PG16_KEY]: { postgres: 34567 } });
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }, stable(store)));

        await manager.acquire('a', 'svc-a');

        expect(runtime.ran[0].ports?.[0].host).toBe(34567);
    });

    it('MOVES when the port it wants is genuinely taken — and remembers where to', async () => {
        const runtime = fakeRuntime();
        const store = ledger();
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a') }, stable(store, async (p: number) => p !== wanted)),
        );

        await manager.acquire('a', 'svc-a');

        const got = runtime.ran[0].ports?.[0].host as number;
        expect(got).not.toBe(wanted);
        expect(store.rows[PG16_KEY]).toEqual({ postgres: got });
    });

    it('SAYS SO when the port had to move', async () => {
        // A move is the one moment an address genuinely changes, and anything that
        // captured the old one at spawn — a `queue:work`, a host-native dev server —
        // is now holding a dead socket. Genie rewrites the `.env` so the next read
        // is right; it cannot reach inside a running process. The least it owes
        // anyone is to say the address moved, instead of letting it look like a
        // broken database.
        const runtime = fakeRuntime();
        const store = ledger();
        const said: string[] = [];
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a') }, {
                ...stable(store, async (p: number) => p !== wanted),
                onPortMoved: (m: string) => said.push(m),
            }),
        );

        await manager.acquire('a', 'svc-a');

        expect(said).toHaveLength(1);
        expect(said[0]).toContain(String(wanted));
        expect(said[0]).toContain(String(runtime.ran[0].ports?.[0].host));
    });

    it('says NOTHING when the port did not move', async () => {
        // The corpse check for the test above: a message on every acquire would be
        // noise nobody reads, which is the same as no message at all.
        const runtime = fakeRuntime();
        const store = ledger();
        const said: string[] = [];
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a') }, { ...stable(store), onPortMoved: (m: string) => said.push(m) }),
        );

        await manager.acquire('a', 'svc-a');

        expect(said).toEqual([]);
    });

    it('a broken onPortMoved listener cannot fail an acquire', async () => {
        const runtime = fakeRuntime();
        const store = ledger();
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a') }, {
                ...stable(store, async (p: number) => p !== wanted),
                onPortMoved: () => {
                    throw new Error('listener exploded');
                },
            }),
        );

        expect((await manager.acquire('a', 'svc-a')).state).toBe('running');
    });

    it('still brings the engine up when no port ledger is wired at all', async () => {
        // A host that has not adopted this seam keeps working — it simply gets the
        // old ephemeral publication rather than failing to start.
        const runtime = fakeRuntime();
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }));

        const status = await manager.acquire('a', 'svc-a');

        expect(status.state).toBe('running');
        expect(runtime.ran[0].ports?.[0].host).toBeUndefined();
    });

    it('re-creates an ADOPTED engine that is published on the wrong port', async () => {
        // A container from before this change holds an ephemeral port, so it would
        // keep moving on every recreate. The named VOLUME is what makes re-creating
        // it safe — the same reasoning the beta.245 adoption repair already uses.
        const runtime = fakeRuntime();
        const store = ledger();
        runtime.containers.set('genie-svc-postgres-16', {
            id: 'old-id',
            name: 'genie-svc-postgres-16',
            image: 'postgres:16',
            state: 'running',
        });
        runtime.ports.set('old-id', [
            { container: 5432, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 51157 },
        ]);
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }, stable(store)));

        await manager.acquire('a', 'svc-a');

        expect(runtime.removed).toContain('old-id');
        expect(runtime.ran[0].ports?.[0].host).toBe(wanted);
    });

    it('does NOT re-create a healthy engine just because it is holding its OWN port', async () => {
        // Once the engine is running it OCCUPIES its published port, so a freeness
        // probe run on the next acquire truthfully answers "taken" — about ourselves.
        // Planning from that answer moves the port, which makes the perfectly
        // healthy running container look misplaced and restarts the database on
        // every single acquire. The adoption check must therefore compare against
        // what was REMEMBERED, never against a freshly probed plan.
        const runtime = fakeRuntime();
        const store = ledger();
        const held = new Set<number>();
        const manager = createDevServiceManager(
            deps(
                runtime,
                { a: pgFor('svc-a'), b: pgFor('svc-b') },
                stable(store, async (p: number) => !held.has(p)),
            ),
        );

        await manager.acquire('a', 'svc-a');
        held.add(runtime.ran[0].ports?.[0].host as number);
        await manager.acquire('b', 'svc-b');

        expect(runtime.ran).toHaveLength(1);
        expect(runtime.removed).toEqual([]);
    });

    it('LEAVES an adopted engine alone when it already holds the right port', async () => {
        const runtime = fakeRuntime();
        const store = ledger();
        runtime.containers.set('genie-svc-postgres-16', {
            id: 'good-id',
            name: 'genie-svc-postgres-16',
            image: 'postgres:16',
            state: 'running',
        });
        runtime.ports.set('good-id', [
            { container: 5432, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: wanted },
        ]);
        const manager = createDevServiceManager(deps(runtime, { a: pgFor('svc-a') }, stable(store)));

        await manager.acquire('a', 'svc-a');

        expect(runtime.removed).toEqual([]);
        expect(runtime.ran).toEqual([]);
    });

    it('re-creates the mis-published engine ONCE and then SETTLES', async () => {
        // Repair, then stop repairing. The second workspace adopts a container that
        // is now on the right port and must leave it alone — a repair that re-fires
        // is a database restarted on every acquire. (The loop guard for a runtime
        // that never honours the request is covered by the `publishNothing` test
        // above, which this must not regress.)
        const runtime = fakeRuntime();
        const store = ledger();
        runtime.containers.set('genie-svc-postgres-16', {
            id: 'old-id',
            name: 'genie-svc-postgres-16',
            image: 'postgres:16',
            state: 'running',
        });
        runtime.ports.set('old-id', [
            { container: 5432, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 51157 },
        ]);
        const manager = createDevServiceManager(
            deps(runtime, { a: pgFor('svc-a'), b: pgFor('svc-b') }, stable(store)),
        );

        await manager.acquire('a', 'svc-a');
        await manager.release('a', 'svc-a');
        await manager.acquire('b', 'svc-b');

        expect(runtime.removed).toEqual(['old-id']);
    });
});
