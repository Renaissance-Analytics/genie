import { assertGeneratedPassword, seaweedEntrypointScript } from './service-provision.js';
import { APP_ENGINES, SOCKUDO_COMMAND, SOCKUDO_CONFIG_TARGET, SOCKUDO_IMAGE, SOCKUDO_PORT, SOCKUDO_VERSION, websocketHostEnv } from './websockets.js';

/**
 * SERVICE ENGINES (§6.6) — the pure half.
 *
 * Shared and dedicated services in containers with PORT ISOLATION ONLY — the owner's host-native
 * decision: the app, its tools and its agents all run on the host and reach the engine over
 * `127.0.0.1:<published port>`. A shared engine is ONE workstation-level service, never one per
 * workspace; the WebSocket server (Sockudo, core/websockets.ts) is shared by nature and a dedicated one is refused.
 *
 * ## One version per engine emits env
 *
 * v1 shipped a bug here: a workspace holding pg16 AND pg17 gave the single-valued keys
 * (`DATABASE_URL`, `DB_*`) to the first entry while the native keys (`PGHOST`…) were overwritten by
 * the last — an app and a tool reached DIFFERENT databases, with nothing reporting it. Here exactly
 * one instance per engine emits: the active one, else the highest version, deterministically.
 * `custom` engines emit only what they declare, plus Genie 1's `GENIE_SERVICE_<NAME>_HOST/PORT`.
 *
 * ## Engines taken over from Genie 1 (`adopted: 'v1'`)
 *
 * The owner, after the first real upgrade: "the upgrade should have shut down everything that was
 * genie 1 so that everything running was genie 2 and what needed to be migrated, was migrated."
 * Genie 1's engines hold every workspace's data, and every workspace's `.env` already names them —
 * Genie 1 WROTE those files (its env-sync, genie#242). So Genie 2 takes the containers over IN
 * PLACE (core/v1-services.ts plans it): same container, same volume, same credentials, same port.
 * An adopted instance is never created, pulled or re-keyed by Genie 2 — every engine bakes its
 * credential into its data directory on first init, so a fresh one would lock the apps out.
 *
 * Genie 1's engines are MULTI-TENANT where Genie 2's are not: one Postgres, a database + role per
 * workspace (`ws_<slug>`), each with its own password. That is a `slice` per workspace, and the
 * env an adopted instance emits is Genie 1's own — the exact names and values its env-wiring
 * produced in host form — so what Genie 2 hands a process equals what is already in the `.env`.
 *
 * ## New shared engines are multi-tenant the same way (hosting ship line H3)
 *
 * A SHARED Postgres / MySQL / MariaDB / Redis / SeaweedFS that Genie 2 creates is carved exactly like Genie 1's: the
 * engine keeps its own superuser (`admin`, generated once), and each workspace that uses it gets a `slice` — its own
 * database + role (Redis: ACL user + key prefix; SeaweedFS: bucket + access key) named after the workspace, with its
 * own password (core/service-provision.ts). So env emission is ONE path: an instance with `slices` gives a workspace
 * only its own slice's connection, whoever created the engine. A shared engine created before slices existed (no
 * `slices` field) keeps the single credential it was created with — re-keying it would move every app off its data.
 *
 * ## Namespace engines (Genie 1's `provision: 'namespace'`, hosting ship line H6/H7)
 *
 * Mailpit and Meilisearch are NOT credential-isolated, in Genie 1 or here: every workspace shares the engine, and
 * what keeps them apart is a NAME derived from the workspace — Mailpit's plus-address tag (genie#552), Meilisearch's
 * index prefix. Nothing is created in the engine for it, so there is no slice: the name is computed from the
 * workspace whose env is being built (`serviceEnvFor`'s `namespace`). Meilisearch's key is the engine's master key,
 * handed to every workspace that uses it — Genie 1's decision, kept, and said here because it is the one engine where
 * a workspace holds a credential that reaches another workspace's data.
 *
 * ## The WebSocket engine's slices are APPS (hosting ship line H8)
 *
 * A shared `websockets` engine has no superuser and nothing is created inside it, and it keeps NO data volume
 * (`stateless`: connection and channel state live in memory): each workspace's slice is an app —
 * `ws_<slug>` as id and key, a generated secret — in a config file Genie writes and the container reads
 * (core/websockets.ts). Its env is Genie 1's `GENIE_WS_*` / `REVERB_*` / `VITE_*` names, through the same slice path.
 *
 * ## Which engine of a KIND a workspace uses (`chooseEngines`)
 *
 * A workspace can see several engines of one kind — its own dedicated Postgres, a shared one, Genie 1's taken-over one,
 * a custom image that declared it IS a Postgres — and exactly one of them gives it `DB_*`. The rule, in order:
 * the workspace's OWN active engine; then a shared one active for it (its slice's `active`, or an unsliced shared
 * engine's own flag); then its own engine, highest version; then a shared one, highest version. A shared engine the
 * workspace DETACHED from (`detached`) is never a candidate: its slice and data stay, its env does not come. So adding
 * a dedicated engine moves the workspace onto it without anyone choosing — the bug the moic agent reported
 * (2026-10-15): Genie 1's shared `postgres-17` kept handing moic its `DB_*` beside moic's own engine, because a custom
 * image was never a Postgres and the first ACTIVE instance in services.json won whoever owned it.
 *
 * ## Variants (`pgvector`)
 *
 * The postgres engine also comes as `pgvector`: the official `pgvector/pgvector:pg<major>` image, which is the stock
 * Postgres image of that major plus the extension (Genie 1 built its own Postgres image ON it — repos/genie
 * main/dev-server/services/catalog.ts GENIE_POSTGRES_IMAGE). Same engine, same env, same slices; its container is named
 * with the variant so a stock 17 and a pgvector 17 never collide. `vector` is NOT a trusted extension (pgvector's
 * vector.control sets no `trusted`; its maintainer declined it in pgvector#288 and #1017), so a workspace ROLE on a
 * shared engine cannot `CREATE EXTENSION vector` itself: Genie creates it, as the engine's superuser, in the
 * workspace's own database when the slice is made (core/service-provision.ts) — Genie 1's genie#526 answer. An app's
 * `CREATE EXTENSION IF NOT EXISTS vector` is then a no-op that succeeds.
 *
 * ## Custom engines of a known kind
 *
 * A custom image may say which engine it IS (`kind`: postgres, mysql, mariadb, redis, mongo). It is then a candidate
 * for that kind like any dedicated engine, and when chosen it emits that engine's env — `DB_*`, `PG*`, `DATABASE_URL` —
 * with its LIVE published port and the credentials the person gave the image (`POSTGRES_USER` / `POSTGRES_PASSWORD` /
 * `POSTGRES_DB`, read the way the official images read them). It is never sliced: a custom image is dedicated.
 */

export type ServiceScope = { kind: 'shared' } | { kind: 'dedicated'; workspaceId: string };

/** A surface an engine publishes BESIDE its primary port — Mailpit's web inbox. Named as Genie 1 named it. */
export interface EngineSurface {
    readonly name: string;
    readonly internalPort: number;
}

export interface EngineDef {
    readonly engine: string;
    readonly image: string;
    readonly internalPort: number;
    readonly majors: readonly string[];
    /** `dedicated-only`: the custom image — an arbitrary image has no multi-tenant story to share (Genie 1's `alwaysDedicated`). */
    readonly sharing: 'shared-or-dedicated' | 'shared-only' | 'dedicated-only';
    /**
     * The image tag for a major, when it is not the major itself — Mailpit publishes `v1.30`, and
     * there is no bare `1.30` (Genie 1 measured that 404 on its first live run).
     */
    readonly tag?: (major: string) => string;
    /**
     * Known only so Genie 1's containers can be TAKEN OVER — never offered, never created. MinIO
     * withdrew its public images (Genie 1 measured 401 from quay.io and Docker Hub, genie#758), so a
     * new one cannot start; an existing one still serves its workspaces' buckets.
     */
    readonly adoptOnly?: true;
    /** The image, port and env are the PERSON's (the custom engine): nothing here names them. */
    readonly custom?: true;
    /** Published beside the primary port, each on its own loopback port (core/services.ts `containerPlan`). */
    readonly surfaces?: readonly EngineSurface[];
    /** The container's own credential env, from the instance's credentials. */
    readonly containerEnv: (c: Credentials) => Record<string, string>;
    /** The container's command (after the image), from the password it is protected with — Redis's `--requirepass`. */
    readonly command?: (password: string) => readonly string[];
    /**
     * The host-form env a workspace gets. `namespace` is the workspace's derived name (`ws_<slug>`) when the env is
     * built FOR a workspace — what a namespace engine keeps workspaces apart by.
     */
    readonly hostEnv: (host: string, port: number, c: Credentials, namespace?: string) => Record<string, string>;
    /**
     * The engine reads its tenants from a FILE Genie writes (Sockudo's app list): bind-mounted read-only at `target`,
     * and the container runs `command` on it. A container plan for such an engine needs that file's host path.
     */
    readonly config?: { readonly target: string; readonly command: readonly string[] };
    /** Nothing to persist (Sockudo keeps connection and channel state in memory): no data volume is created. */
    readonly stateless?: true;
    /** The same engine from another image (postgres → `pgvector`): same env, port, data directory and slices. */
    readonly variants?: Readonly<Record<string, EngineVariant>>;
}

/** An engine's other image — everything else about the engine is the engine's own. */
export interface EngineVariant {
    readonly image: string;
    /** The image tag for a major (pgvector publishes `pg17`). */
    readonly tag: (major: string) => string;
    /** What it adds, for a person and an agent reading the catalog. */
    readonly summary: string;
    /**
     * Extensions Genie creates, as the engine's superuser, in each workspace's database on a SHARED engine — the ones a
     * workspace role cannot create itself (not `trusted`). A dedicated engine's user is the image's superuser and needs none.
     */
    readonly extensions?: readonly string[];
}

export interface Credentials {
    readonly user?: string;
    readonly password?: string;
    readonly database?: string;
}

/** An engine's own superuser: kept (it is baked into the volume on first init), never handed to a workspace. */
export interface EngineAdmin {
    readonly user: string;
    readonly password: string;
}

/**
 * The engines a NEW shared instance is created multi-tenant on: its superuser's name and the container env that
 * creates it. Nothing else is created in the container — every workspace's database and role is a slice.
 */
export const SHARED_TENANCY: Readonly<Record<string, {
    readonly adminUser: string;
    readonly containerEnv: (adminPassword: string) => Record<string, string>;
    /** `--entrypoint` (one word) and what follows the image: SeaweedFS writes its admin identity BEFORE its server starts. */
    readonly entrypoint?: (adminPassword: string) => { readonly entrypoint: string; readonly command: readonly string[] };
}>> = {
    // POSTGRES_DB=postgres: the image creates no extra database when it is the maintenance one.
    postgres: { adminUser: 'genie', containerEnv: (pw) => ({ POSTGRES_USER: 'genie', POSTGRES_PASSWORD: pw, POSTGRES_DB: 'postgres' }) },
    // Root only: the image refuses MYSQL_USER=root, and a second user here would be one no workspace's slice is.
    mysql: { adminUser: 'root', containerEnv: (pw) => ({ MYSQL_ROOT_PASSWORD: pw }) },
    mariadb: { adminUser: 'root', containerEnv: (pw) => ({ MARIADB_ROOT_PASSWORD: pw }) },
    // `--requirepass` (the launch command) sets the `default` user's password; each workspace is an ACL user.
    redis: { adminUser: 'default', containerEnv: () => ({}) },
    // No credential env exists for SeaweedFS: started without `-s3.config` it serves EVERY request unauthenticated
    // (Genie 1 read auth_credentials.go:414). So the entrypoint writes the admin identity file and only then execs the
    // image's own entrypoint with `-s3.config` — fail-closed from the first second (Genie 1's catalog.ts, ported).
    seaweedfs: {
        adminUser: 'genie',
        containerEnv: () => ({}),
        entrypoint: (pw) => ({ entrypoint: 'sh', command: ['-c', seaweedEntrypointScript(assertGeneratedPassword(pw, 'admin'))] }),
    },
};

export interface ServiceInstance {
    readonly id: string;
    readonly engine: string;
    /** The engine's major — or, for a `custom` engine, the NAME the person gave it (one per name per workspace). */
    readonly version: string;
    readonly scope: ServiceScope;
    readonly publishedPort: number;
    readonly credentials: Credentials;
    readonly active: boolean;
    /** `custom` engines: the env they declare, verbatim — the container's, and the workspace's. */
    readonly env?: Readonly<Record<string, string>>;
    /** The container's own name, when Genie 2 did not derive it (an adopted Genie 1 container: `genie-svc-…`). */
    readonly containerName?: string;
    /** The image the container runs, as observed — Genie 1's own Postgres image, not the stock one; a `custom` engine's own. */
    readonly image?: string;
    /** `custom` engines: the port the image listens on INSIDE its container. */
    readonly internalPort?: number;
    /** The data volume, as observed; Genie 1 named its volumes, so `<container>-data` is not assumed. */
    readonly volume?: string;
    /** Taken over from Genie 1 in place: never created, pulled, or re-keyed by Genie 2. */
    readonly adopted?: 'v1';
    /** The engine's own superuser — as Genie 1 minted it, or generated once for a new shared engine. Kept (it is baked into the volume); never handed to a workspace. */
    readonly admin?: EngineAdmin;
    /**
     * Per workspace id: that workspace's slice of this engine — what its env is built from. Present on every adopted
     * engine and every NEW shared multi-tenant one (possibly empty: no workspace uses it yet); absent = the instance's
     * own `credentials` are its env (a dedicated engine, or a shared one created before slices existed).
     */
    readonly slices?: Readonly<Record<string, AdoptedSlice>>;
    /** Every surface the container publishes BESIDE the primary, by Genie 1's surface name (Mailpit's `ui`, MinIO's `console`). */
    readonly publishedPorts?: Readonly<Record<string, number>>;
    /** The engine's variant (`pgvector`), from its catalog entry's `variants`; absent = the engine's own image. */
    readonly variant?: string;
    /** `custom` engines: the engine the image IS (`postgres`…), so its env is that engine's — one of CUSTOM_KINDS. */
    readonly kind?: string;
    /** A SHARED engine: the workspaces it gives no env to, by their choice. Their slices and data stay in it. */
    readonly detached?: readonly string[];
}

/** One workspace's slice of a multi-tenant engine — as Genie 1 provisioned it, or as Genie 2 did (core/service-provision.ts). */
export interface AdoptedSlice {
    /** Genie 1's `ws_<slug>`: the database, the role, the Redis ACL user, the mail tag. */
    readonly identifier: string;
    /** The workspace's own password on the engine (Genie 1's `dev_services` row). */
    readonly password: string;
    /** Redis: the key prefix the ACL restricts the user to (`<identifier>:`). */
    readonly prefix?: string;
    /** MinIO / SeaweedFS: the bucket, which is also the access key (`ws-<slug>`). */
    readonly bucket?: string;
    /** This version is the one whose connection the workspace gets (Genie 1's `active`). */
    readonly active?: boolean;
}

const sqlEnv = (driver: string, defaultUser: string) => (host: string, port: number, c: Credentials): Record<string, string> => {
    const user = c.user ?? defaultUser;
    const password = c.password ?? '';
    const database = c.database ?? '';
    const scheme = driver === 'pgsql' ? 'postgresql' : driver;
    const out: Record<string, string> = {
        DATABASE_URL: `${scheme}://${user}:${password}@${host}:${port}/${database}`,
        DB_CONNECTION: driver,
        DB_HOST: host,
        DB_PORT: String(port),
        DB_DATABASE: database,
        DB_USERNAME: user,
        DB_PASSWORD: password,
    };
    if (driver === 'pgsql') Object.assign(out, { PGHOST: host, PGPORT: String(port), PGDATABASE: database, PGUSER: user, PGPASSWORD: password });
    if (driver === 'mysql') Object.assign(out, { MYSQL_HOST: host, MYSQL_TCP_PORT: String(port) });
    return out;
};

/** The plus address Mailpit auto-tags (genie#552) — Genie 1's env-wiring.ts, byte for byte. */
const mailTagEnv = (namespace: string): Record<string, string> => ({ MAIL_FROM_ADDRESS: `genie+${namespace}@mail.gen`, GENIE_MAIL_TAG: namespace });

export const SERVICE_CATALOG: readonly EngineDef[] = [
    {
        engine: 'postgres', image: 'postgres', internalPort: 5432, majors: ['14', '15', '16', '17'], sharing: 'shared-or-dedicated',
        containerEnv: (c) => ({ POSTGRES_USER: c.user ?? 'genie', POSTGRES_PASSWORD: c.password ?? '', POSTGRES_DB: c.database ?? 'app' }),
        hostEnv: sqlEnv('pgsql', 'genie'),
        // Docker Hub publishes pgvector/pgvector:pg14…pg18 (read 2026-10-15); the stock image of that major plus pgvector,
        // on the official entrypoint — so POSTGRES_* , psql and pg_isready are the stock image's.
        variants: {
            pgvector: { image: 'pgvector/pgvector', tag: (major) => `pg${major}`, summary: 'PostgreSQL with pgvector — the `vector` type and its ivfflat and hnsw indexes', extensions: ['vector'] },
        },
    },
    {
        engine: 'mysql', image: 'mysql', internalPort: 3306, majors: ['8', '9'], sharing: 'shared-or-dedicated',
        containerEnv: (c) => ({ MYSQL_USER: c.user ?? 'genie', MYSQL_PASSWORD: c.password ?? '', MYSQL_DATABASE: c.database ?? 'app', MYSQL_ROOT_PASSWORD: c.password ?? '' }),
        hostEnv: sqlEnv('mysql', 'genie'),
    },
    {
        engine: 'mariadb', image: 'mariadb', internalPort: 3306, majors: ['10', '11'], sharing: 'shared-or-dedicated',
        containerEnv: (c) => ({ MARIADB_USER: c.user ?? 'genie', MARIADB_PASSWORD: c.password ?? '', MARIADB_DATABASE: c.database ?? 'app', MARIADB_ROOT_PASSWORD: c.password ?? '' }),
        hostEnv: sqlEnv('mysql', 'genie'),
    },
    {
        engine: 'redis', image: 'redis', internalPort: 6379, majors: ['7', '8'], sharing: 'shared-or-dedicated',
        containerEnv: () => ({}),
        command: (password) => ['redis-server', '--requirepass', password],
        // A Redis created before passwords were set (no `password`) keeps the URL it was created with.
        hostEnv: (host, port, c) => (c.password
            ? { REDIS_URL: `redis://:${c.password}@${host}:${port}`, REDIS_HOST: host, REDIS_PORT: String(port), REDIS_PASSWORD: c.password }
            : { REDIS_URL: `redis://${host}:${port}`, REDIS_HOST: host, REDIS_PORT: String(port) }),
    },
    {
        engine: 'mongo', image: 'mongo', internalPort: 27017, majors: ['7', '8'], sharing: 'shared-or-dedicated',
        containerEnv: (c) => (c.user ? { MONGO_INITDB_ROOT_USERNAME: c.user, MONGO_INITDB_ROOT_PASSWORD: c.password ?? '' } : {}),
        hostEnv: (host, port, c) => ({ MONGODB_URI: c.user ? `mongodb://${c.user}:${c.password ?? ''}@${host}:${port}` : `mongodb://${host}:${port}`, MONGO_HOST: host, MONGO_PORT: String(port) }),
    },
    {
        // Genie 1's bundled server, Sockudo, at its pinned version (core/websockets.ts) — one per workstation, an app per
        // workspace. NOT `reverb`: that names Laravel's server, which Genie does not run (Genie 1's v71 rename), and the
        // `particleacademy/genie-reverb` image this entry used to name was never published (Docker Hub: 404).
        engine: 'websockets', image: SOCKUDO_IMAGE, internalPort: SOCKUDO_PORT, majors: [SOCKUDO_VERSION], sharing: 'shared-only',
        config: { target: SOCKUDO_CONFIG_TARGET, command: SOCKUDO_COMMAND },
        stateless: true,
        containerEnv: () => ({}),
        // Never emits on its own: a workspace's connection is its app (a slice), `v1HostEnv` below.
        hostEnv: () => ({}),
    },
    {
        // Catch-all SMTP on the primary port AND its web inbox (8025, Genie 1's `ui`) — an inbox nobody can open is
        // half an engine. Each workspace's mail carries its own tag (a namespace, as Genie 1's did): the plus address
        // in MAIL_FROM_ADDRESS, which Mailpit tags by default from v1.19, and GENIE_MAIL_TAG for an app that sets its
        // own From.
        engine: 'mailpit', image: 'axllent/mailpit', tag: (major) => `v${major}`, internalPort: 1025, majors: ['1.30'], sharing: 'shared-or-dedicated',
        surfaces: [{ name: 'ui', internalPort: 8025 }],
        containerEnv: () => ({ MP_DATABASE: '/data/mailpit.db' }),
        hostEnv: (host, port, _c, namespace) => ({ MAIL_MAILER: 'smtp', MAIL_HOST: host, MAIL_PORT: String(port), ...(namespace ? mailTagEnv(namespace) : {}) }),
    },
    {
        engine: 'minio', image: 'quay.io/minio/minio', internalPort: 9000, majors: ['latest'], sharing: 'shared-only', adoptOnly: true,
        containerEnv: () => ({}),
        hostEnv: (host, port) => ({ AWS_ENDPOINT: `http://${host}:${port}`, AWS_DEFAULT_REGION: 'us-east-1', AWS_USE_PATH_STYLE_ENDPOINT: 'true' }),
    },
    {
        // Genie 1's Meilisearch (catalog.ts MEILISEARCH): `getmeili/meilisearch:v1`, the master key from env, and each
        // workspace kept apart by an INDEX PREFIX — namespace isolation, the master key shared (see the header).
        engine: 'meilisearch', image: 'getmeili/meilisearch', tag: (major) => `v${major}`, internalPort: 7700, majors: ['1'], sharing: 'shared-or-dedicated',
        containerEnv: (c) => ({ MEILI_MASTER_KEY: c.password ?? '', MEILI_ENV: 'development' }),
        hostEnv: (host, port, c, namespace) => ({
            MEILISEARCH_HOST: `http://${host}:${port}`,
            ...(c.password ? { MEILISEARCH_KEY: c.password } : {}),
            ...(namespace ? { MEILISEARCH_INDEX_PREFIX: `${namespace}_` } : {}),
        }),
    },
    {
        // THE S3 engine (MinIO's images are gone, genie#758): Genie 1's SeaweedFS, pinned to a dotted semver. Shared
        // only: it is carved into a bucket + access key per workspace (a slice), which needs the engine's admin — the
        // identity its entrypoint writes (SHARED_TENANCY). The filer (8888) is NOT published: it has no authentication,
        // and on a loopback port every process on the machine could read every workspace's bucket through it.
        engine: 'seaweedfs', image: 'chrislusf/seaweedfs', internalPort: 8333, majors: ['4.48'], sharing: 'shared-only',
        containerEnv: () => ({}),
        // A slice's env is `v1HostEnv` (the access key and bucket are the workspace's); with no slice, no credential.
        hostEnv: (host, port) => ({ AWS_ENDPOINT: `http://${host}:${port}`, AWS_DEFAULT_REGION: 'us-east-1', AWS_USE_PATH_STYLE_ENDPOINT: 'true' }),
    },
    {
        // Any image, one port, the person's env (Genie 1's CUSTOM). Its image is the instance's own, validated on the way
        // in (core/forms.ts); there are no majors — `version` is the name the person gave it.
        engine: 'custom', image: '', internalPort: 0, majors: [], sharing: 'dedicated-only', custom: true,
        containerEnv: () => ({}),
        hostEnv: () => ({}),
    },
];

/** The image reference for an engine at a major — `tag` where the registry's tags are not the bare major; a variant's own image. */
export function imageFor(def: EngineDef, major: string, variant?: string): string {
    if (variant !== undefined) {
        const v = def.variants?.[variant];
        if (!v) throw new Error(`${def.engine} has no variant ${JSON.stringify(variant)}${def.variants ? ` (${Object.keys(def.variants).join(', ')})` : ''}`);
        return `${v.image}:${v.tag(major)}`;
    }
    return `${def.image}:${def.tag ? def.tag(major) : major}`;
}

/** The extensions Genie creates in a workspace's database on a shared engine of this variant (none for most). */
export function variantExtensions(engine: string, variant: string | undefined): readonly string[] {
    if (variant === undefined) return [];
    return SERVICE_CATALOG.find((e) => e.engine === engine)?.variants?.[variant]?.extensions ?? [];
}

const HOST = '127.0.0.1';

/** Dotted numbers compared numerically; anything else (a custom engine's NAME) by text, so the order is still total. */
function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return a.localeCompare(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

/** The engines a custom image may declare it IS: each one's env is the catalog engine's, from the image's own env. */
export const CUSTOM_KINDS: readonly string[] = ['postgres', 'mysql', 'mariadb', 'redis', 'mongo'];

/** The kind an instance is chosen as: its engine — or, for a custom image that declared one, that kind. A custom image without one is `custom`. */
export function engineKindOf(i: Pick<ServiceInstance, 'engine' | 'kind'>): string {
    return i.engine === 'custom' && i.kind !== undefined ? i.kind : i.engine;
}

/**
 * A custom image's credentials, read from the env the person gave it the way the official image of its kind reads them:
 * Postgres's user defaults to `postgres` and its database to the user; MySQL's/MariaDB's to root with the root password
 * unless a user is named; Mongo's root user. What the image was not told is not invented.
 */
export function customKindCredentials(kind: string, env: Readonly<Record<string, string>>): Credentials {
    const pick = (...names: string[]): string | undefined => names.map((n) => env[n]).find((v) => v !== undefined && v !== '');
    switch (kind) {
        case 'postgres': {
            const user = pick('POSTGRES_USER') ?? 'postgres';
            return { user, password: pick('POSTGRES_PASSWORD') ?? '', database: pick('POSTGRES_DB') ?? user };
        }
        case 'mysql':
        case 'mariadb': {
            const named = pick('MARIADB_USER', 'MYSQL_USER');
            return {
                user: named ?? 'root',
                password: (named ? pick('MARIADB_PASSWORD', 'MYSQL_PASSWORD') : pick('MARIADB_ROOT_PASSWORD', 'MYSQL_ROOT_PASSWORD')) ?? '',
                database: pick('MARIADB_DATABASE', 'MYSQL_DATABASE') ?? '',
            };
        }
        case 'redis': {
            const password = pick('REDIS_PASSWORD');
            return password ? { password } : {};
        }
        case 'mongo': {
            const user = pick('MONGO_INITDB_ROOT_USERNAME');
            return user ? { user, password: pick('MONGO_INITDB_ROOT_PASSWORD') ?? '' } : {};
        }
        default:
            return {};
    }
}

/** One engine a workspace could use for a kind, as `chooseEngines` sees it. */
export interface EngineCandidate {
    readonly instance: ServiceInstance;
    /** The workspace's own (dedicated) engine, rather than a shared one. */
    readonly own: boolean;
    /** Active FOR THIS WORKSPACE: its slice's flag on a multi-tenant engine, the engine's own otherwise. */
    readonly active: boolean;
    /** A shared engine this workspace detached from: listed (so it can be attached again), never chosen. */
    readonly detached: boolean;
}

/** Per kind: every candidate and the one chosen (`null` = none, e.g. every shared one detached). */
export interface EngineChoice {
    readonly kind: string;
    readonly chosen: ServiceInstance | null;
    readonly candidates: readonly EngineCandidate[];
}

/**
 * WHICH ENGINE OF EACH KIND A WORKSPACE USES — the one rule env emission, the agents' `list` and the Services tab all
 * read (see the header). `workspaceId` absent: no multi-tenant engine is a candidate and every dedicated one is (the
 * old, workspace-less call). A custom image without a kind is not a candidate for anything: it always emits its own names.
 */
export function chooseEngines(instances: readonly ServiceInstance[], workspaceId?: string): EngineChoice[] {
    const byKind = new Map<string, EngineCandidate[]>();
    for (const i of instances) {
        if (i.engine === 'custom' && i.kind === undefined) continue;
        let active: boolean;
        let detached = false;
        if (i.slices !== undefined) {
            const slice = workspaceId === undefined ? undefined : i.slices[workspaceId];
            if (!slice) continue;
            active = slice.active === true;
        } else {
            active = i.active;
        }
        if (i.scope.kind === 'dedicated') {
            if (workspaceId !== undefined && i.scope.workspaceId !== workspaceId) continue;
        } else if (workspaceId !== undefined && i.detached?.includes(workspaceId)) {
            detached = true;
        }
        const kind = engineKindOf(i);
        byKind.set(kind, [...(byKind.get(kind) ?? []), { instance: i, own: i.scope.kind === 'dedicated', active, detached }]);
    }
    const rank = (c: EngineCandidate): number => (c.active ? (c.own ? 0 : 1) : c.own ? 2 : 3);
    const out: EngineChoice[] = [];
    for (const [kind, candidates] of byKind) {
        const eligible = candidates.filter((c) => !c.detached);
        // Stable: equal rank and version keep services.json's order.
        const best = [...eligible].sort((a, b) => rank(a) - rank(b) || compareVersions(b.instance.version, a.instance.version))[0];
        out.push({ kind, chosen: best?.instance ?? null, candidates });
    }
    return out;
}

/** Genie 1's `envToken` (env-wiring.ts): `custom-echo` → `CUSTOM_ECHO`, for a custom engine's endpoint variables. */
export function customEnvToken(value: string): string {
    return value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SERVICE';
}

/**
 * The host-form env for a workspace: exactly one instance per engine, active first, else highest version.
 *
 * `workspaceId` is whose env this is. A multi-tenant engine (one with `slices`: adopted from Genie 1, or
 * a new shared one) serves a workspace only through that workspace's SLICE — a shared Postgres holding
 * three workspaces' databases has nothing to say to a fourth — and its "active" is the slice's, because
 * one shared engine is active for one workspace and not for another. Without a `workspaceId` no
 * multi-tenant instance emits.
 *
 * `namespace` is that workspace's derived name (`ws_<slug>`, core/v1-services.ts — computed by the caller, so this
 * file stays free of node imports for the renderer): the tag and prefix the namespace engines emit.
 */
export function serviceEnvFor(instances: readonly ServiceInstance[], workspaceId?: string, options: { namespace?: string } = {}): Record<string, string> {
    const env: Record<string, string> = {};
    // Every custom engine emits its own names (each is namespaced by its own name) and its env, as Genie 1's did —
    // whether or not it is the workspace's engine of its kind. Its env is applied LAST (below): what was set by hand on
    // an engine wins over what Genie derives — a kind-less custom engine's DB_* were overwritten by a shared Postgres's
    // after #309, and its site would silently have moved to Genie's own database (moic, 2026-10-16).
    const custom: Record<string, string> = {};
    for (const i of instances) {
        if (i.engine !== 'custom') continue;
        if (i.scope.kind === 'dedicated' && workspaceId !== undefined && i.scope.workspaceId !== workspaceId) continue;
        const token = customEnvToken(`custom-${i.version}`);
        Object.assign(env, { [`GENIE_SERVICE_${token}_HOST`]: HOST, [`GENIE_SERVICE_${token}_PORT`]: String(i.publishedPort) });
        Object.assign(custom, i.env ?? {});
    }
    const chosen = new Map<string, ServiceInstance>();
    for (const c of chooseEngines(instances, workspaceId)) if (c.chosen) chosen.set(c.kind, c.chosen);
    for (const [kind, one] of chosen) {
        const def = SERVICE_CATALOG.find((e) => e.engine === kind);
        if (!def) continue;
        if (one.engine === 'custom') {
            // A custom image that IS this kind: the kind's env, its LIVE port, the credentials its own env gave the image.
            Object.assign(env, def.hostEnv(HOST, one.publishedPort, customKindCredentials(kind, one.env ?? {}), options.namespace));
            continue;
        }
        if (one.slices !== undefined) {
            const slice = workspaceId === undefined ? undefined : one.slices[workspaceId];
            if (!slice) continue;
            // Genie 1 gave `DATABASE_URL`/`DB_*` to Postgres when a workspace had both Postgres and MySQL.
            Object.assign(env, v1HostEnv(kind, one.publishedPort, slice, { primaryRelational: (kind !== 'mysql' && kind !== 'mariadb') || !chosen.has('postgres') }));
            continue;
        }
        Object.assign(env, def.hostEnv(HOST, one.publishedPort, one.credentials, options.namespace));
    }
    Object.assign(env, custom);
    return env;
}

/**
 * The env for one workspace's slice of a multi-tenant engine — Genie 1's or a new shared one — in HOST
 * form: GENIE 1's names and values, byte for byte what Genie 1's
 * `serviceEnv` over `provisionedForHost` produced (main/dev-server/services/env-wiring.ts), which is
 * what its env-sync wrote into the workspace's `.env`. Names and values both: a Genie 2 that renamed
 * one (`MYSQL_TCP_PORT` for `MYSQL_PORT`) or dropped one (`REDIS_USERNAME`) would hand a process an
 * env that disagrees with the file the app reads, and the exported variable wins (dotenv is
 * immutable) — which is how Genie 1's genie#242 broke apps in the first place.
 */
export function v1HostEnv(engine: string, port: number, slice: AdoptedSlice, options: { primaryRelational: boolean }): Record<string, string> {
    const id = slice.identifier;
    const pw = slice.password;
    const p = String(port);
    switch (engine) {
        case 'postgres':
            return {
                PGHOST: HOST, PGPORT: p, PGUSER: id, PGPASSWORD: pw, PGDATABASE: id,
                ...(options.primaryRelational ? { DATABASE_URL: `postgresql://${id}:${pw}@${HOST}:${p}/${id}`, DB_CONNECTION: 'pgsql', DB_HOST: HOST, DB_PORT: p, DB_DATABASE: id, DB_USERNAME: id, DB_PASSWORD: pw } : {}),
            };
        case 'mysql':
        case 'mariadb':
            return {
                MYSQL_HOST: HOST, MYSQL_PORT: p, MYSQL_USER: id, MYSQL_PASSWORD: pw, MYSQL_DATABASE: id,
                ...(options.primaryRelational ? { DATABASE_URL: `mysql://${id}:${pw}@${HOST}:${p}/${id}`, DB_CONNECTION: 'mysql', DB_HOST: HOST, DB_PORT: p, DB_DATABASE: id, DB_USERNAME: id, DB_PASSWORD: pw } : {}),
            };
        case 'redis':
            return { REDIS_URL: `redis://${id}:${pw}@${HOST}:${p}`, REDIS_HOST: HOST, REDIS_PORT: p, REDIS_USERNAME: id, REDIS_PASSWORD: pw, REDIS_PREFIX: slice.prefix ?? `${id}:` };
        // BOTH S3 engines, one body, as in Genie 1: an app's configuration is byte-identical either way.
        case 'minio':
        case 'seaweedfs': {
            const bucket = slice.bucket ?? '';
            return { AWS_ENDPOINT: `http://${HOST}:${p}`, AWS_ACCESS_KEY_ID: bucket, AWS_SECRET_ACCESS_KEY: pw, AWS_BUCKET: bucket, AWS_DEFAULT_REGION: 'us-east-1', AWS_USE_PATH_STYLE_ENDPOINT: 'true' };
        }
        case 'mailpit':
            // The plus address Mailpit auto-tags (genie#552), and the same tag for an app that sets its own From.
            return { MAIL_MAILER: 'smtp', MAIL_HOST: HOST, MAIL_PORT: p, ...mailTagEnv(id) };
        case 'websockets':
            // The workspace's own app on the shared server: Genie 1's env-wiring.ts + hosting.ts names (core/websockets.ts).
            // The one secure address, every key (core/websockets.ts WEBSOCKETS_HOST); the workspace is its app.
            return websocketHostEnv(slice);
        default:
            return {};
    }
}

export function switchActiveWarning(input: { engine: string; from: string; to: string }): string {
    return `Switching ${input.engine} from ${input.from} to ${input.to}: each version keeps its own data volume, so ${input.to} starts EMPTY. Nothing in ${input.from} is deleted; switch back any time.`;
}

/**
 * The default name of a custom engine, so a single one's env is Genie 1's own: `GENIE_SERVICE_CUSTOM_CUSTOM_HOST/PORT`.
 * (Here, not in core/forms.ts, because the renderer's form needs it and forms.ts imports node:path.)
 */
export const DEFAULT_CUSTOM_NAME = 'custom';

/** `NAME=value` per line, as the form's text box holds them. A line that is not one keeps its text as the name, so validation names it. */
export function parseEnvLines(text: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) env[line] = '';
        else env[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
    return env;
}

/** What a `custom` engine is, as the person gave it. */
export interface CustomEngineSpec {
    readonly image: string;
    readonly internalPort: number;
    readonly env: Readonly<Record<string, string>>;
    /** The engine it IS (one of CUSTOM_KINDS), so the workspace gets that engine's env from it. */
    readonly kind?: string;
}

export interface ContainerPlan {
    readonly image: string;
    readonly name: string;
    /**
     * The data volume; `null` for a custom image, which declares no data directory (Genie 1's had no volume either),
     * and for a stateless engine (Sockudo), which has nothing to persist.
     */
    readonly volume: string | null;
    /** `127.0.0.1:<published>:<internal>` — loopback only. The primary first, then every surface. */
    readonly publish: readonly string[];
    readonly env: Record<string, string>;
    /** `--entrypoint` (Docker takes one word); the rest of what it runs is `command`. */
    readonly entrypoint?: string;
    /** The container's command after the image, when the engine needs one (Redis's `--requirepass`). */
    readonly command?: readonly string[];
    /** Host files bind-mounted read-only (Sockudo's app config). */
    readonly mounts?: readonly { readonly source: string; readonly target: string }[];
}

/**
 * The container Genie derives for an instance (`genie-<shared|workspace>-<engine>[-<variant>]-<version>`), unless it has
 * its own (an adopted one's). The variant is in the name, so a stock 17 and a pgvector 17 are two containers.
 */
export function containerNameOf(i: Pick<ServiceInstance, 'engine' | 'version' | 'scope' | 'containerName'> & { readonly variant?: string | undefined }): string {
    if (i.containerName) return i.containerName;
    return `genie-${i.scope.kind === 'shared' ? 'shared' : i.scope.workspaceId}-${i.engine}${i.variant ? `-${i.variant}` : ''}-${i.version}`;
}

/**
 * The volume a "delete data" removes: the instance's own (Genie 1 named its volumes), else `<container>-data`; none for
 * a custom image, and none for a stateless engine (the WebSocket server: its apps are a config file, not data).
 */
export function dataVolumeOf(i: Pick<ServiceInstance, 'engine' | 'version' | 'scope' | 'containerName' | 'volume'> & { readonly variant?: string | undefined }): string | null {
    if (i.volume) return i.volume;
    if (i.engine === 'custom') return null;
    if (isStateless(i.engine)) return null;
    return `${containerNameOf(i)}-data`;
}

/**
 * `admin` = a new SHARED multi-tenant engine: the container is created with its superuser only (SHARED_TENANCY), and
 * every workspace's credential is a slice made later. Otherwise `credentials` are the container's own.
 * `surfacePorts` = the loopback port for each of the engine's surfaces (Mailpit's `ui`): every one is required — an
 * engine planned with its inbox unpublished is the bug this exists to end. `custom` = the person's image, port and env.
 */
export function containerPlan(input: {
    engine: string;
    major: string;
    scope: ServiceScope;
    publishedPort: number;
    credentials?: Credentials;
    admin?: EngineAdmin;
    surfacePorts?: Readonly<Record<string, number>>;
    custom?: CustomEngineSpec;
    /** The host path of the file an engine that reads its tenants from one is given (Sockudo's apps). */
    configFile?: string;
    /** The engine's variant (`pgvector`): its image, everything else the engine's. */
    variant?: string;
}): ContainerPlan {
    const def = SERVICE_CATALOG.find((e) => e.engine === input.engine);
    if (!def) throw new Error(`${input.engine} is not an engine Genie manages`);
    if (def.adoptOnly) throw new Error(`${input.engine} can only be taken over from Genie 1, not created: its images are no longer published`);
    if (def.sharing === 'shared-only' && input.scope.kind !== 'shared') throw new Error(`${input.engine} is a shared service — one per workstation, never per workspace`);
    if (def.sharing === 'dedicated-only' && input.scope.kind !== 'dedicated') throw new Error(`${input.engine} is always dedicated to one workspace — an arbitrary image has no multi-tenant story to share`);
    if (input.variant !== undefined && !def.variants?.[input.variant]) throw new Error(`${input.engine} has no variant ${JSON.stringify(input.variant)}`);
    const key = `${input.scope.kind === 'shared' ? 'shared' : input.scope.workspaceId}-${input.engine}${input.variant ? `-${input.variant}` : ''}-${input.major}`;
    if (def.custom) {
        const c = input.custom;
        if (!c) throw new Error(`${input.engine} needs its image, port and env`);
        return {
            image: c.image,
            name: `genie-${key}`,
            volume: null,
            publish: [`${HOST}:${input.publishedPort}:${c.internalPort}`],
            env: { ...c.env },
        };
    }
    if (!def.majors.includes(input.major)) throw new Error(`${input.engine} ${input.major} is not a major Genie knows (${def.majors.join(', ')})`);
    const tenancy = input.admin ? SHARED_TENANCY[def.engine] : undefined;
    if (input.admin && !tenancy) throw new Error(`${input.engine} is not carved into per-workspace slices; it has no admin-only container`);
    if (!input.admin && SHARED_TENANCY[def.engine]?.entrypoint) throw new Error(`${input.engine} needs its admin identity at creation: without it the engine serves every request unauthenticated`);
    if (def.config && !input.configFile) throw new Error(`${input.engine} reads its workspaces' apps from a file Genie writes; the container cannot be planned without it`);
    const publish = [`${HOST}:${input.publishedPort}:${def.internalPort}`];
    for (const surface of def.surfaces ?? []) {
        const port = input.surfacePorts?.[surface.name];
        if (port === undefined) throw new Error(`${input.engine} publishes its ${surface.name} (${surface.internalPort}) too, and no port was given for it`);
        publish.push(`${HOST}:${port}:${surface.internalPort}`);
    }
    const password = input.admin?.password ?? input.credentials?.password;
    const launch = tenancy?.entrypoint && input.admin ? tenancy.entrypoint(input.admin.password) : undefined;
    // The config engine's command is fixed (its binary on the mounted file); SeaweedFS's comes with its entrypoint.
    const command = def.config ? def.config.command : launch ? launch.command : def.command && password ? def.command(password) : undefined;
    return {
        image: imageFor(def, input.major, input.variant),
        name: `genie-${key}`,
        // A stateless engine (Sockudo) has nothing to keep: no volume is created, and none is there for "delete data".
        volume: def.stateless ? null : `genie-${key}-data`,
        publish,
        env: tenancy && input.admin ? tenancy.containerEnv(input.admin.password) : def.containerEnv(input.credentials ?? {}),
        ...(launch ? { entrypoint: launch.entrypoint } : {}),
        ...(command ? { command } : {}),
        ...(def.config && input.configFile ? { mounts: [{ source: input.configFile, target: def.config.target }] } : {}),
    };
}

/** Does this engine keep nothing on disk (no data volume is ever created for it)? */
export function isStateless(engine: string): boolean {
    return SERVICE_CATALOG.find((e) => e.engine === engine)?.stateless === true;
}

/** Is a workspace's slice of this engine only a name in a config — droppable without losing anything? */
export function sliceIsDroppable(engine: string): boolean {
    return APP_ENGINES.has(engine);
}
