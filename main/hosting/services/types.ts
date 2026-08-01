import type { HostedProcessHandle, ProcessSpawner, SpawnOptions } from '../types';

/**
 * Genie's per-workspace SERVICE manager (Tynn #232, P3) — the type surface.
 *
 * P1/P2 gave a workspace a real web tier: FrankenPHP serves the app at one
 * stable same-origin URL. That is only half of "hosted". A Laravel app that
 * cannot reach a database is a 500, so the other half is the stateful services
 * the app actually connects to — and reproducing those across Windows, macOS and
 * Linux was the fork the owner deferred out of P1 ("bundled binaries vs
 * containers, default hybrid").
 *
 * ## The verdict from the P3 spike (2026-08-01, measured on Windows)
 *
 * **Native binaries, no container runtime — for both services.**
 *
 * - **PostgreSQL** ships official relocatable binary distributions (the ones
 *   postgresql.org itself points Windows users at). Unzip, `initdb`, run
 *   `postgres.exe`. Verified end-to-end on this machine: 17.6, scram-sha-256
 *   auth, loopback-only, a real table queried through `psql`.
 * - **Redis** does not: upstream publishes SOURCE only, for every platform, and
 *   explicitly does not support Windows at all. There is therefore no "official
 *   Redis binary" to fetch on ANY OS. The service is served instead by an engine
 *   that speaks the same wire protocol — see {@link ServiceEngine}.
 *
 * So no Docker dependency for either, which keeps the promise P1 made: hosting a
 * workspace needs nothing installed beyond Genie.
 *
 * ## Kind vs engine
 *
 * A {@link ServiceKind} is what the APP sees — `redis` means "there is a RESP
 * server at REDIS_HOST:REDIS_PORT and your `predis`/`phpredis` client will talk
 * to it". A {@link ServiceEngine} is what we actually run. Keeping them separate
 * is what lets the Redis slot be honest about being Garnet today without the
 * `.env` we generate, the config we store, or the UX ever having to change if a
 * real `redis-server` becomes fetchable later.
 *
 * ## Shape
 *
 * Deliberately the same shape as `SiteRuntime` in `../types`: one runtime per
 * engine, `start`/`stop`/`status`, readiness OBSERVED rather than assumed, every
 * spawn and every byte of I/O behind an injected seam. The reasons are the same
 * ones the file header of `../types.ts` gives, and so is the payoff — the whole
 * lifecycle is unit-tested with no download, no data directory and no bound port.
 */

// --- what gets run ---------------------------------------------------------

/**
 * What the hosted app connects to. This is the vocabulary of the `.env` we
 * generate and of the Site Manager UX.
 *
 * MySQL / Meilisearch / Mailpit / MinIO are the obvious next entries; the
 * manager is written so adding one is a new {@link ServiceRuntime} plus a row in
 * the descriptor table, not a change to anything here.
 */
export type ServiceKind = 'postgres' | 'redis';

/**
 * The program that actually implements a {@link ServiceKind}.
 *
 * `postgres` — the upstream PostgreSQL server.
 *
 * `garnet` — Microsoft's MIT-licensed RESP server, which is what backs the
 * `redis` kind. Chosen after the spike, on three grounds no other candidate met
 * together: it publishes official prebuilt binaries for every platform/arch
 * Genie ships to (win/osx/linux × x64/arm64) with a per-asset digest, it is
 * permissively licensed by the vendor rather than a community re-port, and it
 * answers the Laravel command surface — cache, session, sorted-set queues, and
 * `EVAL`/`SCRIPT LOAD` for Illuminate's Lua (with `--lua` on; it is off by
 * default and the runtime turns it on, because Laravel's queue driver is dead
 * without it). It reports `redis_version:7.4.3` to `INFO`, so clients that gate
 * on a version see a modern server.
 *
 * The alternatives and why not: upstream Redis has no Windows support and ships
 * no binaries anywhere; Memurai is proprietary; the community Windows ports are
 * third-party forks of a Redis five majors old. A container was the remaining
 * option and is what `garnet` avoids.
 */
export type ServiceEngine = 'postgres' | 'garnet';

/** The engine each kind runs on today. */
export const ENGINE_FOR_KIND: Readonly<Record<ServiceKind, ServiceEngine>> = {
    postgres: 'postgres',
    redis: 'garnet',
};

/** Every kind, in the order the UX should list them. */
export const SERVICE_KINDS: readonly ServiceKind[] = ['postgres', 'redis'];

export function isServiceKind(value: unknown): value is ServiceKind {
    return typeof value === 'string' && (SERVICE_KINDS as readonly string[]).includes(value);
}

// --- one instance ----------------------------------------------------------

/**
 * A service instance Genie has been asked to run for ONE workspace.
 *
 * Per-workspace isolation is the whole contract: its own data directory, its own
 * port, its own credentials. Two workspaces both running `postgres` share
 * nothing — not a socket, not a cluster, not a database name — so migrating or
 * dropping one workspace's schema can never touch another's.
 */
export interface ServiceInstance {
    /** Stable id — `serviceIdFor(workspaceId, kind)`. Keys every map here. */
    id: string;
    workspaceId: string;
    kind: ServiceKind;
    engine: ServiceEngine;
    /** Loopback port, DERIVED from the id (see `./ports.ts`) so it never moves. */
    port: number;
    /** ABSOLUTE path to this instance's private data directory. */
    dataDir: string;
    /** Credentials the generated `.env` hands the app. `redis` has none. */
    user?: string;
    password?: string;
    /** The database created for the app (`postgres` only). */
    database?: string;
}

export type ServiceState = 'stopped' | 'starting' | 'running' | 'failed';

/** What a runtime reports about one instance. */
export interface ServiceStatus {
    serviceId: string;
    kind: ServiceKind;
    engine: ServiceEngine;
    state: ServiceState;
    /** Where the app dials, or `null` unless `running`. */
    endpoint: { host: string; port: number } | null;
    pid?: number;
    /** Failure detail when `state === 'failed'`. */
    error?: string;
}

/**
 * "Given a service instance, get it running on its own data directory and port;
 * start / stop / status / logs."
 *
 * One implementation per {@link ServiceEngine}. The manager above them never
 * learns whether it is talking to a database or a cache.
 */
export interface ServiceRuntime {
    readonly engine: ServiceEngine;
    /** Idempotent: starting a running instance returns its current status. */
    start(instance: ServiceInstance): Promise<ServiceStatus>;
    stop(serviceId: string): Promise<void>;
    /** Synchronous — IPC polls this without awaiting a probe. */
    status(serviceId: string): ServiceStatus;
    /** The tail of this instance's server log, for the Site Manager. */
    logs(serviceId: string): string;
    stopAll(): Promise<void>;
}

// --- injected seams --------------------------------------------------------

/**
 * Everything a service runtime does to the filesystem, as one seam.
 *
 * `SiteRuntime` only ever WROTE a config file, so `../types.ts` gets away with a
 * one-method `ConfigWriter`. A service also has to create its data directory,
 * ask whether it has already been initialised, and delete it when the workspace
 * drops the service — so the seam is wider, and it is one interface rather than
 * three so a test substitutes a single fake.
 */
export interface ServiceFs {
    exists(p: string): Promise<boolean>;
    mkdir(p: string): Promise<void>;
    write(filePath: string, contents: string): Promise<void>;
    read(filePath: string): Promise<string | null>;
    remove(p: string): Promise<void>;
}

/**
 * A one-shot child process (`initdb`, `createdb`), as opposed to the long-lived
 * server {@link ProcessSpawner} starts.
 *
 * Separate from `ProcessSpawner` because the interesting thing about these is
 * their EXIT — `initdb` failing is a hard error with a message the user needs,
 * whereas a server's exit is a lifecycle event.
 */
export interface CommandRunner {
    run(
        command: string,
        args: string[],
        opts: { cwd?: string; env?: Record<string, string> },
    ): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/**
 * A TCP reachability probe.
 *
 * Postgres and Garnet both announce readiness on their log, and that is what the
 * runtimes wait for. This exists for the SECOND question — "is the port I am
 * about to hand out already someone else's?" — which a log line cannot answer.
 */
export interface PortProbe {
    /** True when something is already listening on `host:port`. */
    inUse(host: string, port: number): Promise<boolean>;
}

export type { HostedProcessHandle, ProcessSpawner, SpawnOptions };
