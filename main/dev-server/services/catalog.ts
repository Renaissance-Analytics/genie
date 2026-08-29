import { workspaceSlugFor } from '../argv';

/**
 * PURE. The typed service CATALOG (Tynn #234, P3) — the owner's service model
 * expressed as data.
 *
 * ## The model this file encodes
 *
 * A service engine is identified by **(engine, MAJOR version)** and nothing
 * else. That pair is what a container is keyed by, which is the whole of the
 * owner's decision in one sentence: *a user with twenty Postgres-16 workspaces
 * runs ONE postgres.* Each workspace then gets its own **database + role +
 * credentials** on that shared engine — logical isolation, exactly how Herd and
 * Valet serve every local site from one engine — with a **dedicated** container
 * where the engine cannot safely implement a normal framework operation inside
 * a logical slice. Redis is that exception: `FLUSHDB` cannot be ACL-prefix scoped.
 *
 * Version is part of the key rather than a singleton because `pg15` and `pg16`
 * are not interchangeable and a workspace pinned to one must not be silently
 * migrated to the other. Two engines is still two, not twenty.
 *
 * ## Three provisioning strategies, and why they differ
 *
 *   - **`sql-database-role`** (Postgres, MySQL) — the engines that are natively
 *     multi-tenant. `CREATE DATABASE` + a scoped role, and a role cannot reach
 *     another workspace's database. This is real isolation, enforced by the
 *     server.
 *   - **`redis-acl`** — a dedicated Redis still gets a non-admin workspace user.
 *     `FLUSHDB` is permitted because the whole container belongs to that workspace;
 *     server/admin commands remain denied. Legacy shared provisioning continues to
 *     deny `FLUSHDB`, because its key-prefix ACL cannot scope a keyless command.
 *   - **`s3-scoped-user`** (MinIO) — an IAM user per workspace, admitted by
 *     policy to the one bucket named after it. MinIO was a `namespace` engine
 *     until Tynn #250 step 4, which is to say every workspace was handed the
 *     ROOT credential and separation was by bucket NAME. A name is not a
 *     boundary: anyone holding root could delete anyone's bucket, an installed
 *     Genie App's included. MinIO has a real mechanism, so it uses it.
 *   - **`namespace`** (Meilisearch, Mailpit) — the owner's decision for these
 *     two is a per-workspace **namespace** (index prefix / inbox), not a
 *     per-workspace credential. Say so plainly rather than implying an isolation
 *     that is not there: workspaces sharing one of these share its master key,
 *     and separation is by name. Meilisearch could be scoped the same way MinIO
 *     now is — it has scoped API keys — but it GENERATES the key value
 *     server-side, and provisioning has no way to read a step's output back.
 *
 * ## Why `image()` is a function
 *
 * So the version is the ONLY thing that varies, and so a same-major image
 * change is one edit here rather than a search across the module. Nothing else
 * in the codebase names a service image.
 */

// --- engines ----------------------------------------------------------------

export const SERVICE_ENGINES = [
    'postgres',
    'mysql',
    'redis',
    'meilisearch',
    'minio',
    'mailpit',
    'reverb',
    /** The generic `{image, port, env}` escape hatch. Always dedicated. */
    'custom',
] as const;

export type ServiceEngine = (typeof SERVICE_ENGINES)[number];

export function isServiceEngine(value: unknown): value is ServiceEngine {
    return typeof value === 'string' && (SERVICE_ENGINES as readonly string[]).includes(value);
}

/** How a workspace's slice of an engine is carved out. See the file header. */
export type ProvisionStrategy =
    | 'sql-database-role'
    | 'redis-acl'
    | 's3-scoped-user'
    | 'namespace'
    | 'none';

/** One reachable surface of an engine. Non-HTTP ones are published and LISTED —
 *  the point of P3 is that a user, a program or an agent can connect. */
export interface EnginePort {
    /** Stable name (`postgres`, `s3`, `console`, `smtp`) — the endpoint key. */
    name: string;
    container: number;
    kind: 'http' | 'tcp';
    /** The one a connection string points at. Exactly one per engine. */
    primary?: boolean;
}

/** Engine state that must outlive the container (a database cluster). */
export interface EngineVolume {
    /** Appended to the engine's name — `genie-svc-postgres-16-data`. */
    suffix: string;
    target: string;
}

export interface EngineSpec {
    engine: ServiceEngine;
    /** Host-native engines ship with Genie; container engines require Docker/Podman. */
    runtime: 'host' | 'container';
    /** Pinned upstream bundled with a host-native engine. */
    distribution?: { project: string; version: string };
    /** For a human and for the MCP `catalog` action. */
    label: string;
    /** One line an agent can act on: what this is for. */
    summary: string;
    /** Known versions, newest-preferred first. An unknown version is REFUSED —
     *  an arbitrary tag is an arbitrary image to run. */
    versions: readonly string[];
    /** Container image; host-native engines return an empty string. */
    image: (version: string) => string;
    ports: readonly EnginePort[];
    volumes: readonly EngineVolume[];
    provision: ProvisionStrategy;
    /** The engine's own superuser, where it has one. */
    adminUser?: string;
    /** Env that BOOTSTRAPS the admin credential. Applied on first run only —
     *  every one of these engines ignores it once its volume is initialised,
     *  which is why the credential is persisted rather than regenerated. */
    adminEnv?: (adminPassword: string) => Record<string, string>;
    /** argv the container runs, when the image's default is not what we want. */
    command?: (adminPassword: string) => string[];
    /** An in-container readiness check (exit 0 = ready). Absent means "probe
     *  the published port", which is all a generic image affords. */
    readyExec?: (adminPassword: string) => string[];
    /** A caller-supplied image can have no shared story. */
    alwaysDedicated?: boolean;
}

// --- the engines ------------------------------------------------------------

const POSTGRES: EngineSpec = {
    engine: 'postgres',
    runtime: 'container',
    label: 'Postgres',
    summary: 'PostgreSQL. Each workspace gets its own database + login role on the shared engine.',
    versions: ['17', '16', '15', '14'],
    // pgvector/pgvector: stock PostgreSQL of the SAME major with the `vector`
    // extension preinstalled (plus the standard contrib set — hstore, pg_trgm,
    // uuid-ossp, citext, …), so `CREATE EXTENSION vector` (and the rest) just
    // works — extensions, especially pgvector, must be enable-able. Debian-based
    // (larger than the old `-alpine`) but still ships `psql`/`pg_isready` and keeps
    // the same PGDATA layout + env, so it is a drop-in for provisioning/readiness.
    // pgvector publishes pg14–pg17. NOTE: re-opening an EXISTING alpine (musl) data
    // volume with this debian (glibc) image can hit text-index collation
    // differences — fine for regenerable dev data; recreate the engine if a stale
    // volume misbehaves.
    image: (version) => `pgvector/pgvector:pg${version}`,
    ports: [{ name: 'postgres', container: 5432, kind: 'tcp', primary: true }],
    // PGDATA is a SUBDIRECTORY of the mount, not the mount itself: some volume
    // drivers leave a `lost+found` in the root, and initdb refuses to
    // initialise a directory that is not empty.
    volumes: [{ suffix: 'data', target: '/var/lib/postgresql/data' }],
    provision: 'sql-database-role',
    adminUser: 'postgres',
    adminEnv: (password) => ({
        POSTGRES_PASSWORD: password,
        POSTGRES_DB: 'postgres',
        PGDATA: '/var/lib/postgresql/data/pgdata',
    }),
    readyExec: () => ['pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
};

const MYSQL: EngineSpec = {
    engine: 'mysql',
    runtime: 'container',
    label: 'MySQL',
    summary: 'MySQL. Each workspace gets its own schema + user, granted only on that schema.',
    versions: ['8.4', '8.0'],
    image: (version) => `mysql:${version}`,
    ports: [{ name: 'mysql', container: 3306, kind: 'tcp', primary: true }],
    volumes: [{ suffix: 'data', target: '/var/lib/mysql' }],
    provision: 'sql-database-role',
    adminUser: 'root',
    adminEnv: (password) => ({ MYSQL_ROOT_PASSWORD: password }),
    readyExec: (password) => [
        'mysqladmin',
        'ping',
        '-h',
        '127.0.0.1',
        '-uroot',
        `-p${password}`,
    ],
};

const REDIS: EngineSpec = {
    engine: 'redis',
    runtime: 'container',
    label: 'Redis',
    summary:
        'Redis. Dedicated per workspace so framework cache clears can use FLUSHDB without touching another workspace.',
    versions: ['7', '6'],
    image: (version) => `redis:${version}-alpine`,
    ports: [{ name: 'redis', container: 6379, kind: 'tcp', primary: true }],
    volumes: [{ suffix: 'data', target: '/data' }],
    provision: 'redis-acl',
    // Redis ACL key patterns cannot scope FLUSHDB: the command names no key.
    // Frameworks such as Laravel legitimately use it for cache:clear, so Redis
    // must have a workspace-owned database/container rather than a shared slice.
    alwaysDedicated: true,
    adminUser: 'default',
    // The redis image reads no password env — it is a server flag. `appendonly`
    // so a restart does not silently empty every workspace's cache.
    command: (password) => ['redis-server', '--requirepass', password, '--appendonly', 'yes'],
    readyExec: (password) => ['redis-cli', '-a', password, '--no-auth-warning', 'ping'],
};

const MEILISEARCH: EngineSpec = {
    engine: 'meilisearch',
    runtime: 'container',
    label: 'Meilisearch',
    summary:
        'Meilisearch. Shared instance; each workspace gets an index-name prefix (namespace isolation, shared master key).',
    versions: ['1'],
    image: (version) => `getmeili/meilisearch:v${version}`,
    ports: [{ name: 'http', container: 7700, kind: 'http', primary: true }],
    volumes: [{ suffix: 'data', target: '/meili_data' }],
    provision: 'namespace',
    adminEnv: (password) => ({ MEILI_MASTER_KEY: password, MEILI_ENV: 'development' }),
};

const MINIO: EngineSpec = {
    engine: 'minio',
    runtime: 'container',
    label: 'MinIO (S3)',
    summary:
        'S3-compatible object storage. Shared instance; each workspace gets its own bucket and its own IAM user, admitted by policy to that bucket alone.',
    // MinIO tags are release TIMESTAMPS, not majors, so there is no stable
    // major to pin the way every other engine here is pinned. `latest` is the
    // honest default; pass an exact `RELEASE.…` tag as the version to pin.
    versions: ['latest'],
    image: (version) => `minio/minio:${version}`,
    ports: [
        { name: 's3', container: 9000, kind: 'http', primary: true },
        { name: 'console', container: 9001, kind: 'http' },
    ],
    volumes: [{ suffix: 'data', target: '/data' }],
    provision: 's3-scoped-user',
    adminUser: 'genie',
    adminEnv: (password) => ({ MINIO_ROOT_USER: 'genie', MINIO_ROOT_PASSWORD: password }),
    command: () => ['server', '/data', '--console-address', ':9001'],
};

const MAILPIT: EngineSpec = {
    engine: 'mailpit',
    runtime: 'container',
    label: 'Mailpit',
    summary:
        'Catch-all SMTP + a web inbox. Shared instance; each workspace tags its mail with its own namespace.',
    // Mailpit publishes `v<major>.<minor>` and `latest` — there is NO bare
    // `v1`, unlike Meilisearch. `v1` 404s at the registry, which is a failure
    // that no unit test can see and that the live smoke found on the first run.
    versions: ['1.30', 'latest'],
    image: (version) => `axllent/mailpit:${version === 'latest' ? 'latest' : `v${version}`}`,
    ports: [
        { name: 'smtp', container: 1025, kind: 'tcp', primary: true },
        { name: 'ui', container: 8025, kind: 'http' },
    ],
    volumes: [{ suffix: 'data', target: '/data' }],
    provision: 'namespace',
    adminEnv: () => ({ MP_DATABASE: '/data/mailpit.db' }),
};

const REVERB: EngineSpec = {
    engine: 'reverb',
    runtime: 'host',
    distribution: { project: 'sockudo/sockudo', version: '4.7.0' },
    label: 'WebSockets (Sockudo)',
    summary:
        'Bundled Sockudo Pusher-protocol WebSocket server. Runs natively on the Genie Host without Docker; each workspace gets its own app credentials.',
    versions: ['1'],
    image: () => '',
    // Reverb speaks HTTP and upgrades to WebSocket on the SAME port. `http` so
    // readiness probes the published port (any HTTP answer = the server is up).
    // The image also serves a monitoring/debugging DASHBOARD on 8081 (live apps,
    // channels, connections) — published + listed like MinIO's console so a
    // person or agent can open it; NOT the primary.
    ports: [{ name: 'websocket', container: 6001, kind: 'http', primary: true }],
    // Stateless: connection + channel state is in memory, nothing to persist.
    volumes: [],
    // Namespace isolation, exactly like MinIO/Meilisearch: the engine is shared,
    // separation is by app id, and the workspaces share the master credential —
    // here the master is the HMAC key the server derives every app secret from,
    // so a workspace can never forge another's secret without the master.
    provision: 'namespace',
};

const CUSTOM: EngineSpec = {
    engine: 'custom',
    runtime: 'container',
    label: 'Custom image',
    summary:
        'Any image, one port, your env. Always DEDICATED to the workspace — an arbitrary image has no multi-tenant story to share.',
    versions: ['custom'],
    // Never used: a custom service carries its OWN image, validated on the way
    // into the store. Present so the shape is total.
    image: () => '',
    ports: [{ name: 'service', container: 0, kind: 'tcp', primary: true }],
    volumes: [],
    provision: 'none',
    alwaysDedicated: true,
};

const CATALOG: Record<ServiceEngine, EngineSpec> = {
    postgres: POSTGRES,
    mysql: MYSQL,
    redis: REDIS,
    meilisearch: MEILISEARCH,
    minio: MINIO,
    mailpit: MAILPIT,
    reverb: REVERB,
    custom: CUSTOM,
};

export function engineSpecFor(engine: ServiceEngine): EngineSpec {
    return CATALOG[engine];
}

/** The version used when a caller names none. The first known one. */
export const DEFAULT_VERSIONS = Object.fromEntries(
    SERVICE_ENGINES.map((engine) => [engine, CATALOG[engine].versions[0]]),
) as Record<ServiceEngine, string>;

/**
 * PURE. The version to run, or `null` when the caller named one we do not know.
 *
 * Refusing an unknown version is a security decision, not pedantry: the version
 * becomes an image tag, and an arbitrary tag is an arbitrary image to run with
 * a workspace's data in it.
 */
export function resolveEngineVersion(engine: ServiceEngine, version?: string): string | null {
    if (!version) return DEFAULT_VERSIONS[engine];
    return CATALOG[engine].versions.includes(version) ? version : null;
}

// --- the engine key ---------------------------------------------------------

/** The `<engine>-<version>` key. THE sharing unit — see the file header. */
export function engineKeyFor(engine: ServiceEngine, version: string): string {
    return `${engine}-${version}`;
}

/**
 * PURE. Split an engine key back apart, or `null` if it is not one.
 *
 * The engine name comes FIRST and is drawn from a closed set that contains no
 * hyphen, so the split point is unambiguous even for a version that does
 * (`mysql-8.4`, and a future `postgres-16-rc1`).
 */
export function parseEngineKey(key: string): { engine: ServiceEngine; version: string } | null {
    for (const engine of SERVICE_ENGINES) {
        if (!key.startsWith(`${engine}-`)) continue;
        const version = key.slice(engine.length + 1);
        return version ? { engine, version } : null;
    }
    return null;
}

// --- per-workspace namespace identifiers ------------------------------------

/**
 * PURE. The workspace's database / role / ACL-user name.
 *
 * Built on `workspaceSlugFor`, so it inherits the property that matters: a
 * lossy sanitisation gets a digest of the ORIGINAL id appended, and two
 * workspaces that reduce to the same text still get different names. Sharing a
 * database name would mean sharing a database — the exact failure this whole
 * model exists to prevent.
 *
 * `ws_` prefix + underscores: a SQL identifier may not start with a digit, and
 * a hyphen would force every statement to quote it.
 */
export function workspaceSqlIdentifier(workspaceId: string): string {
    if (!workspaceId) throw new Error('dev-server: a service identifier needs a workspace id');
    const slug = workspaceSlugFor(workspaceId).replace(/-/g, '_');
    // 63 bytes is Postgres' NAMEDATALEN - 1; MySQL allows 64. `workspaceSlugFor`
    // already caps at 48, so this is a belt-and-braces slice.
    return `ws_${slug}`.slice(0, 63);
}

/**
 * PURE. The workspace's name where a DNS label is required — an S3 bucket.
 *
 * Buckets take lowercase letters, digits and hyphens (3–63), and no
 * underscores; so this is the hyphen form rather than the SQL one.
 */
export function workspaceDnsName(workspaceId: string): string {
    if (!workspaceId) throw new Error('dev-server: a service identifier needs a workspace id');
    return `ws-${workspaceSlugFor(workspaceId)}`.slice(0, 63).replace(/-+$/, '');
}
