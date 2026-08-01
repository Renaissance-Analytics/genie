import path from 'node:path';
import { defaultCommandRunner, defaultServiceFs, defaultServiceSpawner } from './seams';
import { layoutForBinDir } from './postgres-fetch';
import type {
    CommandRunner,
    HostedProcessHandle,
    ProcessSpawner,
    ServiceFs,
    ServiceInstance,
    ServiceRuntime,
    ServiceStatus,
} from './types';

/**
 * The PostgreSQL {@link ServiceRuntime} (Tynn #232, P3).
 *
 * Owns one cluster per workspace: create it if it does not exist, run the
 * server on this workspace's derived port, make sure the app's database is
 * there, and report honestly whether it is actually accepting connections.
 *
 * ## Three things that are easy to get wrong, and how they are handled
 *
 * **`initdb` is once, not every start.** A data directory is expensive to build
 * and holds the user's development data; re-running `initdb` over one would
 * either fail or destroy it. The `PG_VERSION` file upstream writes at the end of
 * a successful `initdb` is the sentinel — its presence means "this directory is
 * a cluster", and it appears only when initialisation finished, so a crashed
 * `initdb` is retried rather than mistaken for success.
 *
 * **Readiness is OBSERVED.** Postgres logs `database system is ready to accept
 * connections` when — and only when — recovery is done and the socket is open.
 * Before that line the port is bound but every connection is refused with "the
 * database system is starting up", which is exactly the kind of "running" that
 * would hand a Laravel app a 500 on its first request. Verified against 17.6 on
 * Windows.
 *
 * **The password never goes on a command line.** `initdb --pwfile` reads it from
 * a file (deleted immediately after) and `psql` reads `PGPASSWORD` from the
 * environment. An argument vector is world-readable in the process list on every
 * platform Genie runs on.
 *
 * As with the site runtimes, every spawn, command and file operation is an
 * injected seam, so this whole lifecycle is unit-tested with no PostgreSQL on
 * the machine.
 */

// --- readiness -------------------------------------------------------------

/**
 * The line the server prints once it is genuinely accepting connections.
 *
 * Pinned as a literal for the same reason `READY_MARKER` is in `frankenphp.ts`:
 * a marker built by concatenation is one typo away from a runtime that never
 * reports ready and times out on every start, and a test asserting the same
 * concatenation would pass anyway.
 */
export const PG_READY_MARKER = 'database system is ready to accept connections';

/** The file `initdb` writes last. Its presence means the cluster is complete. */
export const PG_VERSION_FILE = 'PG_VERSION';

/** How long a cluster gets to come up before we call it failed and kill it. */
export const PG_START_TIMEOUT_MS = 30_000;

/** How long a clean `pg_ctl` shutdown gets before the child is killed anyway. */
export const PG_STOP_GRACE_MS = 10_000;

/** Keep the log tail bounded — it exists to explain a failure and to feed the
 *  Site Manager's log panel, not to be a durable record. */
const LOG_TAIL_LIMIT = 8_000;

// --- runtime ---------------------------------------------------------------

export interface PostgresRuntimeOptions {
    /** Directory holding `initdb`/`postgres`/`psql`. */
    binDir: string;
    platform?: NodeJS.Platform | string;
    spawner?: ProcessSpawner;
    runner?: CommandRunner;
    fs?: ServiceFs;
    startTimeoutMs?: number;
    /** How long a clean `pg_ctl` shutdown gets before the child is killed. */
    stopGraceMs?: number;
}

interface Entry {
    status: ServiceStatus;
    proc?: HostedProcessHandle;
    log: string;
    /** Remembered so `stop()` can point `pg_ctl` at the right cluster without
     *  re-deriving it from a config that may have changed since the start. */
    dataDir?: string;
    /** Set by `stop()` so the resulting exit is not reported as a crash. */
    stopping?: boolean;
    /** True once the child process is actually gone, so `stop()` can tell a
     *  finished shutdown from a `pg_ctl` that merely returned 0. */
    exitedCleanly?: boolean;
}

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        // `unref` so a pending grace timer cannot hold the process open at quit.
        const timer = setTimeout(resolve, ms);
        (timer as unknown as { unref?: () => void }).unref?.();
    });

/**
 * PURE. The argv the server is started with.
 *
 * Exported so the test pins it exactly — every one of these flags is load-bearing:
 *
 *   - `-p` / `listen_addresses=127.0.0.1` — loopback ONLY. A managed development
 *     database must not be reachable from the network, and the default would
 *     bind whatever `postgresql.conf` says.
 *   - `unix_socket_directories=` (empty) — no socket file. Windows has none
 *     anyway, and on macOS/Linux a socket in a shared temp directory is a second
 *     way in that bypasses the port isolation above.
 *   - `-c logging_collector=off` — keep the log on stderr, where the runtime is
 *     already watching for the readiness marker. With the collector on, the line
 *     goes to a file and the start would always time out.
 */
export function postgresArgs(dataDir: string, port: number): string[] {
    return [
        '-D',
        dataDir,
        '-p',
        String(port),
        '-c',
        'listen_addresses=127.0.0.1',
        '-c',
        'unix_socket_directories=',
        '-c',
        'logging_collector=off',
    ];
}

/** PURE. The argv `initdb` is run with. */
export function initdbArgs(dataDir: string, user: string, pwfile: string): string[] {
    return [
        '-D',
        dataDir,
        '-U',
        user,
        // scram-sha-256 for BOTH paths: the app authenticates over TCP, but
        // leaving local connections on `trust` would mean anything running as
        // this user could open the database without the credential.
        '--auth-local=scram-sha-256',
        '--auth-host=scram-sha-256',
        `--pwfile=${pwfile}`,
        '-E',
        'UTF8',
        // No locale: a cluster initialised with the machine's locale sorts
        // differently on another machine, which turns "works on my laptop" into
        // a test-ordering bug. UTF8 + C collation is reproducible.
        '--no-locale',
    ];
}

export function createPostgresRuntime(opts: PostgresRuntimeOptions): ServiceRuntime {
    const platform = opts.platform ?? process.platform;
    const layout = layoutForBinDir(opts.binDir, platform);
    const spawner = opts.spawner ?? defaultServiceSpawner;
    const runner = opts.runner ?? defaultCommandRunner;
    const fs = opts.fs ?? defaultServiceFs;
    const startTimeoutMs = opts.startTimeoutMs ?? PG_START_TIMEOUT_MS;
    const stopGraceMs = opts.stopGraceMs ?? PG_STOP_GRACE_MS;
    const entries = new Map<string, Entry>();

    const stopped = (instance: Pick<ServiceInstance, 'id'>): ServiceStatus => ({
        serviceId: instance.id,
        kind: 'postgres',
        engine: 'postgres',
        state: 'stopped',
        endpoint: null,
    });

    /**
     * Create the cluster if this data directory does not already hold one.
     *
     * The password file is written next to the data directory and removed in a
     * `finally` — including when `initdb` fails, which is the case that would
     * otherwise leave a credential on disk indefinitely.
     */
    async function ensureCluster(instance: ServiceInstance): Promise<void> {
        if (await fs.exists(path.join(instance.dataDir, PG_VERSION_FILE))) return;

        await fs.mkdir(path.dirname(instance.dataDir));
        const pwfile = `${instance.dataDir}.pw`;
        try {
            await fs.write(pwfile, instance.password ?? '');
            const result = await runner.run(
                layout.initdbPath,
                initdbArgs(instance.dataDir, instance.user ?? 'genie', pwfile),
                {},
            );
            if (result.code !== 0) {
                // A half-built directory would be mistaken for a cluster by the
                // NEXT start only if PG_VERSION exists — it will not — but it
                // would still make `initdb` refuse ("directory not empty"), so
                // clear it.
                await fs.remove(instance.dataDir).catch(() => {});
                throw new Error(
                    `initdb failed (${result.code}): ${(result.stderr || result.stdout).slice(-600)}`,
                );
            }
        } finally {
            await fs.remove(pwfile).catch(() => {});
        }
    }

    /**
     * Create the app's database if it is not there yet.
     *
     * `createdb` exits non-zero when the database exists, which is not an error
     * here — every start after the first hits that path. Distinguished by the
     * message rather than by pre-querying, so there is no window between the
     * check and the create.
     */
    async function ensureDatabase(instance: ServiceInstance): Promise<void> {
        if (!instance.database) return;
        const result = await runner.run(
            layout.createdbPath,
            [
                '-h',
                '127.0.0.1',
                '-p',
                String(instance.port),
                '-U',
                instance.user ?? 'genie',
                instance.database,
            ],
            { env: { PGPASSWORD: instance.password ?? '' } },
        );
        if (result.code === 0) return;
        if (/already exists/i.test(result.stderr)) return;
        if (/password authentication failed/i.test(result.stderr)) {
            // The cluster on disk was initialised with a DIFFERENT password
            // than the one now stored — the data directory outlived the config
            // that created it (a reset `genie.db`, a restored backup, a data
            // directory copied between machines). Nothing here can recover it:
            // changing the role's password requires authenticating as the role.
            //
            // Reported explicitly because the raw error is "password
            // authentication failed for user genie" on a password the user has
            // never seen, typed or chosen — with no possible next step unless
            // we say which directory holds the mismatched cluster.
            throw new Error(
                `the existing cluster at ${instance.dataDir} was created with a different ` +
                    'password than the one Genie now has for it. Delete that directory to ' +
                    'start a fresh database (this discards its data), or restore the ' +
                    'workspace configuration that matches it.',
            );
        }
        throw new Error(`createdb failed (${result.code}): ${result.stderr.slice(-600)}`);
    }

    async function start(instance: ServiceInstance): Promise<ServiceStatus> {
        const existing = entries.get(instance.id);
        // Idempotent — re-starting a live instance must not orphan its process.
        if (existing && (existing.status.state === 'running' || existing.status.state === 'starting')) {
            return existing.status;
        }

        const entry: Entry = {
            status: { ...stopped(instance), state: 'starting' },
            log: '',
            dataDir: instance.dataDir,
        };
        entries.set(instance.id, entry);

        try {
            await ensureCluster(instance);
        } catch (e) {
            entry.status = {
                ...stopped(instance),
                state: 'failed',
                error: e instanceof Error ? e.message : String(e),
            };
            return entry.status;
        }

        const ready = await new Promise<ServiceStatus>((resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
                finish('failed', `postgres did not report ready within ${startTimeoutMs}ms`);
                entry.proc?.stop();
            }, startTimeoutMs);

            const finish = (state: 'running' | 'failed', error?: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                entry.status =
                    state === 'running'
                        ? {
                              ...stopped(instance),
                              state: 'running',
                              endpoint: { host: '127.0.0.1', port: instance.port },
                              pid: entry.proc?.pid,
                          }
                        : { ...stopped(instance), state: 'failed', error };
                resolve(entry.status);
            };

            entry.proc = spawner.spawn(
                layout.serverPath,
                postgresArgs(instance.dataDir, instance.port),
                {
                    cwd: instance.dataDir,
                    onStderr: (chunk) => {
                        entry.log = (entry.log + chunk).slice(-LOG_TAIL_LIMIT);
                        if (chunk.includes(PG_READY_MARKER)) finish('running');
                    },
                },
            );

            void entry.proc.exited.then((code) => {
                entry.exitedCleanly = true;
                if (entry.stopping) {
                    finish('failed', 'stopped before it finished starting');
                    return;
                }
                // `null` means the child never ran, not that it exited — see
                // the same case in `redis.ts`.
                const error =
                    code === null
                        ? `postgres could not be started (${layout.serverPath})`
                        : `postgres exited (${code}): ${entry.log.slice(-500)}`;
                finish('failed', error);
                if (entry.status.state === 'running') {
                    entry.status = { ...stopped(instance), state: 'failed', error };
                }
            });
        });

        if (ready.state !== 'running') return ready;

        // The server is up; the app's database may still not exist. Failing here
        // leaves a RUNNING server behind on purpose — the cluster is fine and
        // the next start will retry the database, which is better than tearing
        // down a healthy server over a recoverable step.
        try {
            await ensureDatabase(instance);
        } catch (e) {
            entry.status = {
                ...entry.status,
                state: 'failed',
                error: e instanceof Error ? e.message : String(e),
            };
        }
        return entry.status;
    }

    /**
     * Shut a cluster down CLEANLY, then make sure it is actually gone.
     *
     * Killing the process is the wrong primitive here, and differently wrong on
     * each platform. A POSIX `SIGTERM` asks Postgres for a SMART shutdown, which
     * waits for every client to disconnect — a single idle `psql` holds the stop
     * open indefinitely. On Windows Node has no signals at all, so
     * `child.kill()` is a `TerminateProcess`: the postmaster dies mid-write and
     * the next start pays for it with crash recovery.
     *
     * `pg_ctl stop -m fast` is the operation actually wanted on all three
     * platforms — roll back open transactions, disconnect clients, checkpoint,
     * exit — and it reaches the server through `postmaster.pid`, so it works on
     * a postmaster we spawned directly rather than through `pg_ctl`.
     *
     * The kill remains as the fallback for the case where `pg_ctl` itself cannot
     * run (a half-installed runtime, a data directory already gone). Leaving a
     * postmaster holding the port would make the next start of THIS workspace
     * fail to bind, which is worse than an unclean exit.
     */
    async function stop(serviceId: string): Promise<void> {
        const entry = entries.get(serviceId);
        if (!entry) return;
        entry.stopping = true;
        entries.delete(serviceId);
        const proc = entry.proc;

        let clean = false;
        if (entry.dataDir) {
            const result = await runner
                .run(layout.pgCtlPath, ['stop', '-D', entry.dataDir, '-m', 'fast', '-w'], {})
                .catch(() => ({ code: null, stdout: '', stderr: '' }));
            clean = result.code === 0;
        }

        if (!proc) return;
        if (clean) {
            // `pg_ctl -w` reports success once the postmaster is gone, so this
            // normally resolves at once. It is RACED with a timer anyway: a
            // `stop()` that can block forever on a process which did not
            // actually exit would hang app quit, and "the shutdown command
            // succeeded" is not the same fact as "the child is gone" —
            // especially for a cluster killed while it was still starting, when
            // there may be no postmaster.pid for pg_ctl to have found.
            await Promise.race([proc.exited, delay(stopGraceMs)]);
        }
        if (!entry.exitedCleanly) proc.stop();
        await proc.exited;
    }

    return {
        engine: 'postgres',
        start,
        stop,
        status: (serviceId) => entries.get(serviceId)?.status ?? stopped({ id: serviceId }),
        logs: (serviceId) => entries.get(serviceId)?.log ?? '',
        async stopAll() {
            await Promise.all([...entries.keys()].map((id) => stop(id)));
        },
    };
}
