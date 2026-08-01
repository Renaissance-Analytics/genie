import { defaultServiceFs, defaultServiceSpawner } from './seams';
import type {
    HostedProcessHandle,
    ProcessSpawner,
    ServiceFs,
    ServiceInstance,
    ServiceRuntime,
    ServiceStatus,
} from './types';

/**
 * The `redis` {@link ServiceRuntime}, running on Garnet (Tynn #232, P3).
 *
 * `types.ts#ServiceEngine` argues the choice; the short version is that upstream
 * Redis ships source only and does not support Windows, so there is no official
 * Redis binary to fetch on any platform, and Garnet is Microsoft's MIT-licensed
 * RESP server with prebuilt binaries for every platform/arch Genie targets.
 *
 * From the app's side this IS Redis: `predis` and `phpredis` connect unchanged,
 * `REDIS_HOST`/`REDIS_PORT` mean what they mean, and `INFO` reports
 * `redis_version:7.4.3`. Measured against Garnet 2.1.1 on Windows, the whole
 * surface Laravel uses answers correctly — string cache with `SET … EX`,
 * `INCR`, hashes for sessions, sorted sets for delayed and reserved jobs, and
 * `EVAL`/`SCRIPT LOAD` for Illuminate's Lua (including the `cjson` round-trip in
 * the queue-pop script).
 *
 * Far simpler than the Postgres runtime: there is no cluster to initialise, no
 * credential, and no second step after the server is up. Start it, watch for the
 * ready line, done.
 */

// --- readiness -------------------------------------------------------------

/**
 * Garnet's "I am up" line.
 *
 * Pinned as a literal, verified against Garnet 2.1.1. Readiness is OBSERVED for
 * the same reason it is everywhere else in this subsystem: the process existing
 * proves nothing, and reporting `running` on spawn would hand a Laravel app a
 * cache connection that refuses every request.
 */
export const GARNET_READY_MARKER = 'Ready to accept connections';

export const GARNET_START_TIMEOUT_MS = 20_000;

const LOG_TAIL_LIMIT = 8_000;

// --- runtime ---------------------------------------------------------------

export interface RedisRuntimeOptions {
    /** Absolute path to `GarnetServer` / `GarnetServer.exe`. */
    serverPath: string;
    /**
     * The private .NET runtime directory, exposed to the child as `DOTNET_ROOT`.
     *
     * Garnet is published framework-dependent, so without this its app host
     * looks for a SYSTEM .NET — which is either absent (the server refuses to
     * start with a message about installing .NET) or a version Genie did not
     * choose. See `dotnet-fetch.ts`.
     */
    dotnetRoot: string;
    spawner?: ProcessSpawner;
    fs?: ServiceFs;
    startTimeoutMs?: number;
}

interface Entry {
    status: ServiceStatus;
    proc?: HostedProcessHandle;
    log: string;
    stopping?: boolean;
}

/**
 * PURE. The argv Garnet is started with. Exported so the test pins it exactly.
 *
 *   - `--bind 127.0.0.1` — loopback only, like every other managed service here.
 *   - `--checkpointdir` — this instance's private directory, which is what keeps
 *     two workspaces' caches from sharing state on disk.
 *   - `--lua` — Lua scripting is OFF by default in Garnet, and Laravel's queue
 *     driver and atomic cache locks are `EVAL` scripts. Without this flag every
 *     `EVAL` answers "This instance has Lua scripting support disabled" and the
 *     queue silently does nothing, which is exactly the sort of failure that
 *     would be blamed on Laravel rather than on a missing flag.
 */
export function garnetArgs(instance: ServiceInstance): string[] {
    return [
        '--port',
        String(instance.port),
        '--bind',
        '127.0.0.1',
        '--checkpointdir',
        instance.dataDir,
        '--lua',
    ];
}

export function createRedisRuntime(opts: RedisRuntimeOptions): ServiceRuntime {
    const spawner = opts.spawner ?? defaultServiceSpawner;
    const fs = opts.fs ?? defaultServiceFs;
    const startTimeoutMs = opts.startTimeoutMs ?? GARNET_START_TIMEOUT_MS;
    const entries = new Map<string, Entry>();

    const stopped = (serviceId: string): ServiceStatus => ({
        serviceId,
        kind: 'redis',
        engine: 'garnet',
        state: 'stopped',
        endpoint: null,
    });

    async function start(instance: ServiceInstance): Promise<ServiceStatus> {
        const existing = entries.get(instance.id);
        if (existing && (existing.status.state === 'running' || existing.status.state === 'starting')) {
            return existing.status;
        }

        const entry: Entry = { status: { ...stopped(instance.id), state: 'starting' }, log: '' };
        entries.set(instance.id, entry);

        // The data directory is BOTH the checkpoint target and the child's cwd,
        // and a spawn into a cwd that does not exist fails with an exit code of
        // `null` and an empty log — a failure with nothing in it to explain
        // itself. Creating it here rather than relying on the caller is what
        // makes the runtime correct on its own; the manager also does it, but a
        // runtime that only works when someone else prepared the ground is a
        // trap for the next caller.
        await fs.mkdir(instance.dataDir);

        return new Promise<ServiceStatus>((resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
                finish('failed', `garnet did not report ready within ${startTimeoutMs}ms`);
                entry.proc?.stop();
            }, startTimeoutMs);

            const finish = (state: 'running' | 'failed', error?: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                entry.status =
                    state === 'running'
                        ? {
                              ...stopped(instance.id),
                              state: 'running',
                              endpoint: { host: '127.0.0.1', port: instance.port },
                              pid: entry.proc?.pid,
                          }
                        : { ...stopped(instance.id), state: 'failed', error };
                resolve(entry.status);
            };

            entry.proc = spawner.spawn(opts.serverPath, garnetArgs(instance), {
                cwd: instance.dataDir,
                env: { DOTNET_ROOT: opts.dotnetRoot },
                onStderr: (chunk) => {
                    entry.log = (entry.log + chunk).slice(-LOG_TAIL_LIMIT);
                    if (chunk.includes(GARNET_READY_MARKER)) finish('running');
                },
            });

            void entry.proc.exited.then((code) => {
                // A stop WE asked for is not a crash — same reasoning as
                // `frankenphp.ts`, and the same bug if it is left out: stopping
                // an instance that is still STARTING would resolve its pending
                // `start()` as a spurious crash.
                if (entry.stopping) {
                    finish('failed', 'stopped before it finished starting');
                    return;
                }
                // A `null` code means the child never ran (spawn failed) rather
                // than exited — and in that case the log is empty, so without
                // naming the executable the status says nothing at all.
                const error =
                    code === null
                        ? `garnet could not be started (${opts.serverPath})`
                        : `garnet exited (${code}): ${entry.log.slice(-500)}`;
                finish('failed', error);
                if (entry.status.state === 'running') {
                    entry.status = { ...stopped(instance.id), state: 'failed', error };
                }
            });
        });
    }

    async function stop(serviceId: string): Promise<void> {
        const entry = entries.get(serviceId);
        if (!entry) return;
        entry.stopping = true;
        entry.proc?.stop();
        if (entry.proc) await entry.proc.exited;
        entries.delete(serviceId);
    }

    return {
        engine: 'garnet',
        start,
        stop,
        status: (serviceId) => entries.get(serviceId)?.status ?? stopped(serviceId),
        logs: (serviceId) => entries.get(serviceId)?.log ?? '',
        async stopAll() {
            await Promise.all([...entries.keys()].map((id) => stop(id)));
        },
    };
}
