import path from 'node:path';
import { resolveServiceInstance } from './config';
import { ensureDotnet as realEnsureDotnet } from './dotnet-fetch';
import { ensureGarnet as realEnsureGarnet } from './garnet-fetch';
import { ensurePostgres as realEnsurePostgres } from './postgres-fetch';
import { applyManagedEnv, serviceEnvVars } from './env';
import { createPostgresRuntime } from './postgres';
import { createRedisRuntime } from './redis';
import { defaultServiceFs } from './seams';
import type { EnsureInstallOptions } from './fetch-seams';
import type { DotnetInstall } from './dotnet-fetch';
import type { GarnetInstall } from './garnet-fetch';
import type { PostgresInstall } from './postgres-fetch';
import type { WorkspaceServices } from './config';
import type {
    ServiceFs,
    ServiceInstance,
    ServiceKind,
    ServiceRuntime,
    ServiceStatus,
} from './types';

/**
 * The SERVICE manager (Tynn #232, P3) — the piece that turns "this workspace
 * wants a database" into a running server the workspace's app can connect to.
 *
 * The exact counterpart of `../manager.ts` for sites, and deliberately shaped
 * the same way, because the same properties matter:
 *
 *   - **Fetch on first use.** A workspace that enables `postgres` downloads
 *     PostgreSQL once; one that never does pays nothing. The install promise —
 *     not its result — is cached, so two workspaces enabling a database at the
 *     same moment share ONE download rather than racing into one staging
 *     directory.
 *   - **Failures are STATUSES, not exceptions.** `reconcile()` starts every
 *     enabled service on boot; one workspace with a corrupt data directory must
 *     not take the others, or the app, down with it.
 *   - **Every dependency injected**, so the whole policy is unit-tested with no
 *     download, no data directory and no bound port.
 *
 * One RUNTIME PER ENGINE, shared across workspaces (not one per instance): a
 * runtime is a stateless supervisor keyed by service id, and the isolation that
 * matters — data directory, port, credential — lives in the
 * {@link ServiceInstance}, not in the supervisor.
 */

// --- deps ------------------------------------------------------------------

export interface ServicesWorkspace {
    id: string;
    /** The workspace root on disk — where its `.env` lives. */
    path: string;
}

export interface ServiceManagerDeps {
    /** Genie's userData dir: where fetched engines and every data directory
     *  live. Must persist across app updates. */
    baseDir: string;
    listWorkspaces(): ServicesWorkspace[];
    servicesFor(workspaceId: string): WorkspaceServices;
    platform?: NodeJS.Platform | string;
    // Seams — the real implementations by default.
    ensurePostgres?: (opts: EnsureInstallOptions) => Promise<PostgresInstall>;
    ensureGarnet?: (opts: EnsureInstallOptions) => Promise<GarnetInstall>;
    ensureDotnet?: (opts: EnsureInstallOptions) => Promise<DotnetInstall>;
    createPostgres?: (opts: { binDir: string; platform?: NodeJS.Platform | string }) => ServiceRuntime;
    createRedis?: (opts: { serverPath: string; dotnetRoot: string }) => ServiceRuntime;
    fs?: ServiceFs;
}

/** One configured service plus whatever its runtime currently says about it. */
export interface ServiceRow {
    workspaceId: string;
    serviceId: string;
    kind: ServiceKind;
    enabled: boolean;
    state: ServiceStatus['state'];
    /** The port the instance WOULD use, even while stopped — the Site Manager
     *  shows it before anything has started. */
    port: number;
    endpoint: ServiceStatus['endpoint'];
    /** Shown so a user can connect with their own client. Never the password. */
    database?: string;
    user?: string;
    error?: string;
}

export interface EnvWriteResult {
    /** The `.env` written, or null when there was none to write to. */
    path: string | null;
    changed: boolean;
    /** Managed keys the user also sets outside the block — see `env.ts`. */
    conflicts: string[];
}

export interface ServiceManager {
    /** Start one configured service. Never throws — failure is a failed status. */
    start(workspaceId: string, kind: ServiceKind): Promise<ServiceStatus>;
    stop(workspaceId: string, kind: ServiceKind): Promise<void>;
    stopAll(): Promise<void>;
    /** Configured services + live state. All workspaces, or one. */
    list(workspaceId?: string): ServiceRow[];
    /** The server log tail for one service. */
    logs(workspaceId: string, kind: ServiceKind): string;
    /** Start every enabled service and stop everything that no longer is. */
    reconcile(): Promise<void>;
    /**
     * The environment a workspace's RUNNING services imply — what a hosted site
     * is started with. Synchronous: `../manager.ts` calls it while assembling a
     * site's spawn options.
     */
    envFor(workspaceId: string): Record<string, string>;
    /** Write (or remove) the managed block in this workspace's `.env`. */
    writeEnvFile(workspaceId: string): Promise<EnvWriteResult>;
}

// --- implementation --------------------------------------------------------

interface Live {
    workspaceId: string;
    instance: ServiceInstance;
    runtime: ServiceRuntime;
}

export function createServiceManager(deps: ServiceManagerDeps): ServiceManager {
    const ensurePostgresFn = deps.ensurePostgres ?? realEnsurePostgres;
    const ensureGarnetFn = deps.ensureGarnet ?? realEnsureGarnet;
    const ensureDotnetFn = deps.ensureDotnet ?? realEnsureDotnet;
    const makePostgres = deps.createPostgres ?? createPostgresRuntime;
    const makeRedis = deps.createRedis ?? createRedisRuntime;
    const fs = deps.fs ?? defaultServiceFs;

    const live = new Map<string, Live>();
    /** In-flight `start()`s, keyed by service id. */
    const starting = new Map<string, Promise<ServiceStatus>>();
    /** Why a service is NOT running, kept until it starts or is stopped — the
     *  same reason `../manager.ts` keeps one: a failed instance never enters
     *  `live`, so without this the Site Manager would show a broken cluster as
     *  merely "off" and throw away the message explaining why. */
    const lastFailure = new Map<string, ServiceStatus>();

    let postgresRuntime: ServiceRuntime | null = null;
    let redisRuntime: ServiceRuntime | null = null;
    let postgresInstall: Promise<PostgresInstall> | null = null;
    let redisInstall: Promise<[GarnetInstall, DotnetInstall]> | null = null;

    const failed = (serviceId: string, kind: ServiceKind, error: string): ServiceStatus => ({
        serviceId,
        kind,
        engine: kind === 'postgres' ? 'postgres' : 'garnet',
        state: 'failed',
        endpoint: null,
        error,
    });

    async function postgresBackend(): Promise<ServiceRuntime> {
        if (postgresRuntime) return postgresRuntime;
        postgresInstall ??= ensurePostgresFn({ baseDir: deps.baseDir, platform: deps.platform });
        try {
            const install = await postgresInstall;
            postgresRuntime ??= makePostgres({
                binDir: install.binDir,
                platform: deps.platform,
            });
            return postgresRuntime;
        } catch (e) {
            // A failed fetch must not poison every later attempt — the network
            // may simply have been down.
            postgresInstall = null;
            throw e;
        }
    }

    async function redisBackend(): Promise<ServiceRuntime> {
        if (redisRuntime) return redisRuntime;
        // Both halves in one promise: Garnet is useless without the runtime that
        // executes it, so there is no state where one is installed and the
        // service is startable.
        redisInstall ??= Promise.all([
            ensureGarnetFn({ baseDir: deps.baseDir, platform: deps.platform }),
            ensureDotnetFn({ baseDir: deps.baseDir, platform: deps.platform }),
        ]);
        try {
            const [garnet, dotnet] = await redisInstall;
            redisRuntime ??= makeRedis({
                serverPath: garnet.serverPath,
                dotnetRoot: dotnet.dotnetRoot,
            });
            return redisRuntime;
        } catch (e) {
            redisInstall = null;
            throw e;
        }
    }

    const backendFor = (kind: ServiceKind): Promise<ServiceRuntime> =>
        kind === 'postgres' ? postgresBackend() : redisBackend();

    /** Ports already spoken for, so two instances never share one. */
    const takenPorts = (exceptId?: string): Set<number> => {
        const taken = new Set<number>();
        for (const [id, entry] of live) {
            if (id !== exceptId) taken.add(entry.instance.port);
        }
        return taken;
    };

    /** Resolve one workspace's configured service into a runnable instance. */
    function instanceFor(workspaceId: string, kind: ServiceKind): ServiceInstance | null {
        const config = Object.values(deps.servicesFor(workspaceId)).find((c) => c?.kind === kind);
        if (!config) return null;
        return resolveServiceInstance(workspaceId, deps.baseDir, config, takenPorts());
    }

    /** Every RUNNING instance for a workspace. */
    function runningInstances(workspaceId: string): ServiceInstance[] {
        const out: ServiceInstance[] = [];
        for (const [id, entry] of live) {
            if (entry.workspaceId !== workspaceId) continue;
            if (entry.runtime.status(id).state === 'running') out.push(entry.instance);
        }
        return out;
    }

    async function startOnce(workspaceId: string, kind: ServiceKind): Promise<ServiceStatus> {
        const instance = instanceFor(workspaceId, kind);
        if (!instance) {
            return failed('', kind, `${kind} is not configured for this workspace`);
        }
        try {
            const runtime = await backendFor(kind);
            await fs.mkdir(instance.dataDir);
            const status = await runtime.start(instance);
            if (status.state === 'running') {
                live.set(instance.id, { workspaceId, instance, runtime });
            }
            return status;
        } catch (e) {
            return failed(instance.id, kind, e instanceof Error ? e.message : String(e));
        }
    }

    async function start(workspaceId: string, kind: ServiceKind): Promise<ServiceStatus> {
        const instance = instanceFor(workspaceId, kind);
        const key = instance?.id ?? `${workspaceId}:${kind}`;
        const inFlight = starting.get(key);
        if (inFlight) return inFlight;
        const promise = startOnce(workspaceId, kind)
            .then((status) => {
                if (status.state === 'running') lastFailure.delete(key);
                else lastFailure.set(key, status);
                return status;
            })
            .finally(() => starting.delete(key));
        starting.set(key, promise);
        return promise;
    }

    async function stopById(serviceId: string): Promise<void> {
        lastFailure.delete(serviceId);
        const entry = live.get(serviceId);
        if (!entry) return;
        live.delete(serviceId);
        await entry.runtime.stop(serviceId);
    }

    function statusOf(serviceId: string, kind: ServiceKind): ServiceStatus | null {
        const entry = live.get(serviceId);
        return entry ? entry.runtime.status(serviceId) : lastFailure.get(serviceId) ?? null;
    }

    return {
        start,

        async stop(workspaceId, kind) {
            const instance = instanceFor(workspaceId, kind);
            if (instance) await stopById(instance.id);
        },

        async stopAll() {
            live.clear();
            await Promise.all(
                [postgresRuntime, redisRuntime]
                    .filter((r): r is ServiceRuntime => !!r)
                    .map((r) => r.stopAll()),
            );
        },

        list(workspaceId) {
            const rows: ServiceRow[] = [];
            for (const workspace of deps.listWorkspaces()) {
                if (workspaceId && workspace.id !== workspaceId) continue;
                for (const config of Object.values(deps.servicesFor(workspace.id))) {
                    if (!config?.kind) continue;
                    const instance = resolveServiceInstance(
                        workspace.id,
                        deps.baseDir,
                        config,
                        takenPorts(),
                    );
                    if (!instance) continue;
                    const status = statusOf(instance.id, config.kind);
                    rows.push({
                        workspaceId: workspace.id,
                        serviceId: instance.id,
                        kind: config.kind,
                        enabled: !!config.enabled,
                        state: status?.state ?? 'stopped',
                        port: instance.port,
                        endpoint: status?.endpoint ?? null,
                        ...(instance.database ? { database: instance.database } : {}),
                        ...(instance.user ? { user: instance.user } : {}),
                        ...(status?.error ? { error: status.error } : {}),
                    });
                }
            }
            return rows;
        },

        logs(workspaceId, kind) {
            const instance = instanceFor(workspaceId, kind);
            if (!instance) return '';
            return live.get(instance.id)?.runtime.logs(instance.id) ?? '';
        },

        async reconcile() {
            const wanted = new Set<string>();
            for (const workspace of deps.listWorkspaces()) {
                for (const config of Object.values(deps.servicesFor(workspace.id))) {
                    if (!config?.enabled || !config.kind) continue;
                    const instance = instanceFor(workspace.id, config.kind);
                    if (instance) wanted.add(instance.id);
                    await start(workspace.id, config.kind);
                }
            }
            for (const serviceId of [...live.keys()]) {
                if (!wanted.has(serviceId)) await stopById(serviceId);
            }
        },

        envFor(workspaceId) {
            return serviceEnvVars(runningInstances(workspaceId));
        },

        async writeEnvFile(workspaceId) {
            const workspace = deps.listWorkspaces().find((w) => w.id === workspaceId);
            if (!workspace) return { path: null, changed: false, conflicts: [] };
            const envPath = path.join(workspace.path, '.env');

            const existing = await fs.read(envPath);
            // NEVER create the file. An app with no `.env` is either not a
            // Laravel app or not set up yet, and dropping credentials into a
            // directory that has no configuration to extend is a surprise, not
            // a convenience.
            if (existing === null) return { path: null, changed: false, conflicts: [] };

            // The CONFIGURED-and-enabled instances, not the running ones: the
            // file has to be correct for `artisan migrate` before anything has
            // been started, and it must be cleaned up the moment a service is
            // disabled even if it was never up.
            const instances: ServiceInstance[] = [];
            for (const config of Object.values(deps.servicesFor(workspaceId))) {
                if (!config?.enabled || !config.kind) continue;
                const instance = instanceFor(workspaceId, config.kind);
                if (instance) instances.push(instance);
            }

            const result = applyManagedEnv(existing, serviceEnvVars(instances));
            if (result.changed) await fs.write(envPath, result.contents);
            return { path: envPath, changed: result.changed, conflicts: result.conflicts };
        },
    };
}

// --- the process-wide instance ---------------------------------------------

let instance: ServiceManager | null = null;

/**
 * Create the one service manager for this process.
 *
 * Called from `background.ts` beside `initHosting`, and for the same reason it
 * is: the manager reads workspaces and their service configs from the database,
 * so it cannot exist before `initDatabase`. Creating it starts nothing.
 */
export function initServices(deps: ServiceManagerDeps): ServiceManager {
    instance ??= createServiceManager(deps);
    return instance;
}

/** The live manager, or null when services were never initialised (headless
 *  host-core, tests, an early boot path). Callers must tolerate null. */
export function serviceManager(): ServiceManager | null {
    return instance;
}

/**
 * The environment a workspace's running services imply, for the SITE runtime.
 *
 * Returns `{}` rather than throwing when services were never initialised, which
 * is what makes the hosting-side wiring purely additive.
 */
export function workspaceServiceEnv(workspaceId: string): Record<string, string> {
    return instance?.envFor(workspaceId) ?? {};
}

/** Test-only: drop the process-wide instance. */
export function resetServicesForTests(): void {
    instance = null;
}
