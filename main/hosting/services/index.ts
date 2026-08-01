/**
 * Genie's per-workspace SERVICE manager — module surface (Tynn #232, P3).
 *
 * ## What this adds to P1/P2
 *
 * P1 and P2 gave a workspace a real web tier: FrankenPHP serving the app at one
 * stable same-origin URL. This is the other half of "hosted" — the stateful
 * services the app connects to. Without it a hosted Laravel app is a 500 on its
 * first database query, and the whole point of hosting a site rather than
 * tunnelling a dev server is undone by still needing the user to have run
 * Postgres by hand.
 *
 * ## The fork the owner deferred, and how it was settled
 *
 * P1 left services as the open question: "bundled native binaries (Herd-style)
 * vs containers (a Docker dependency)", defaulting to hybrid. The P3 spike
 * settled it EMPIRICALLY on Windows, and the answer is **native binaries for
 * both, no container runtime**:
 *
 *   - **PostgreSQL** publishes official relocatable binary distributions (the
 *     ones postgresql.org points Windows and macOS users at). Fetched, `initdb`'d
 *     and served on loopback with scram-sha-256 auth — verified end to end.
 *   - **Redis** publishes none, anywhere: upstream ships SOURCE for every
 *     platform and does not support Windows at all. So the `redis` service runs
 *     Garnet, Microsoft's MIT-licensed RESP server, which does publish prebuilt
 *     binaries for every platform/arch Genie targets. Laravel connects to it
 *     unchanged. See `types.ts#ServiceEngine` for the alternatives and why each
 *     was rejected.
 *
 * So a workspace gets a database and a cache with nothing installed beyond
 * Genie — which is the promise P1 made about the web tier, kept for the rest.
 *
 * ## The layers
 *
 *   - PURE (unit-tested directly, no I/O): `config.ts` (ids, ports, isolation,
 *     sanitising), `env.ts` (what gets written into the user's `.env`), and the
 *     artifact-selection half of the three fetchers.
 *   - THIN IMPURE (spawn / fs / net): the two runtimes' `start`/`stop`, behind
 *     the seams in `seams.ts`, so the whole lifecycle is unit-tested with no
 *     engine on the machine.
 *   - POLICY: `manager.ts`, which owns fetch-on-first-use, reconcile, and the
 *     two paths by which a hosted app learns its credentials.
 *
 * ## Extending it
 *
 * MySQL, Meilisearch, Mailpit and MinIO are the obvious next services. Each is a
 * new `ServiceRuntime` plus a `ServiceKind`, a row in `ENGINE_FOR_KIND` and a
 * clause in `serviceEnvVars` — no change to the manager, the config model, the
 * port isolation or the `.env` writer.
 */

export {
    ENGINE_FOR_KIND,
    isServiceKind,
    SERVICE_KINDS,
} from './types';
export type {
    CommandRunner,
    PortProbe,
    ServiceEngine,
    ServiceFs,
    ServiceInstance,
    ServiceKind,
    ServiceRuntime,
    ServiceState,
    ServiceStatus,
} from './types';

export {
    generatePassword,
    parseWorkspaceServices,
    preferredServicePort,
    resolveServiceInstance,
    sanitizeServicePatch,
    serviceDataDir,
    serviceIdFor,
    servicePort,
    withCredentials,
    DEFAULT_DATABASE,
    SERVICE_DB_USER,
    SERVICE_PORTS,
} from './config';
export type { ServiceConfig, WorkspaceServices } from './config';

export {
    applyManagedEnv,
    quoteEnvValue,
    renderManagedEnv,
    serviceEnvVars,
    MANAGED_BEGIN,
    MANAGED_END,
} from './env';
export type { ManagedEnvResult } from './env';

export { assertDigest, engineInstallDir, ensureStagedInstall, isArchive } from './fetch-seams';
export type { FetchPhase, FetchSeams, ResolvedArtifact, StagedInstallPlan } from './fetch-seams';

export {
    assetFor as postgresAssetFor,
    ensurePostgres,
    installedBinDir,
    layoutForBinDir,
    postgresInstallDir,
    POSTGRES_VERSION,
} from './postgres-fetch';
export type { PostgresAsset, PostgresInstall, PostgresLayout } from './postgres-fetch';

export {
    assetFor as dotnetAssetFor,
    dotnetHostPath,
    dotnetInstallDir,
    ensureDotnet,
    ridFor,
    DOTNET_TFM,
    DOTNET_VERSION,
} from './dotnet-fetch';
export type { DotnetAsset, DotnetInstall } from './dotnet-fetch';

export {
    assetNameFor as garnetAssetNameFor,
    ensureGarnet,
    garnetInstallDir,
    garnetServerPath,
    releaseApiUrl as garnetReleaseApiUrl,
    selectAsset as garnetSelectAsset,
    GARNET_VERSION,
} from './garnet-fetch';
export type { GarnetInstall } from './garnet-fetch';

export {
    createPostgresRuntime,
    initdbArgs,
    postgresArgs,
    PG_READY_MARKER,
    PG_START_TIMEOUT_MS,
    PG_VERSION_FILE,
} from './postgres';
export type { PostgresRuntimeOptions } from './postgres';

export { createRedisRuntime, garnetArgs, GARNET_READY_MARKER, GARNET_START_TIMEOUT_MS } from './redis';
export type { RedisRuntimeOptions } from './redis';

export {
    createServiceManager,
    initServices,
    resetServicesForTests,
    serviceManager,
    workspaceServiceEnv,
} from './manager';
export type {
    EnvWriteResult,
    ServiceManager,
    ServiceManagerDeps,
    ServiceRow,
    ServicesWorkspace,
} from './manager';

export {
    defaultCommandRunner,
    defaultPortProbe,
    defaultServiceFs,
    defaultServiceSpawner,
} from './seams';
