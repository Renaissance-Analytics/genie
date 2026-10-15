/**
 * SERVICE ENGINES (§6.6) — the pure half.
 *
 * Shared and dedicated services in containers with PORT ISOLATION ONLY — the owner's host-native
 * decision: the app, its tools and its agents all run on the host and reach the engine over
 * `127.0.0.1:<published port>`. A shared engine is ONE workstation-level service, never one per
 * workspace; Reverb is shared by nature and a dedicated one is refused.
 *
 * ## One version per engine emits env
 *
 * v1 shipped a bug here: a workspace holding pg16 AND pg17 gave the single-valued keys
 * (`DATABASE_URL`, `DB_*`) to the first entry while the native keys (`PGHOST`…) were overwritten by
 * the last — an app and a tool reached DIFFERENT databases, with nothing reporting it. Here exactly
 * one instance per engine emits: the active one, else the highest version, deterministically.
 * `custom` engines emit only what they declare.
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
 * A SHARED Postgres / MySQL / MariaDB / Redis that Genie 2 creates is carved exactly like Genie 1's: the engine
 * keeps its own superuser (`admin`, generated once), and each workspace that uses it gets a `slice` — its own
 * database + role (or Redis ACL user + key prefix) named `ws_<slug>`, with its own password
 * (core/service-provision.ts). So env emission is ONE path: an instance with `slices` gives a workspace only its
 * own slice's connection, whoever created the engine. A shared engine created before slices existed (no `slices`
 * field) keeps the single credential it was created with — re-keying it would move every app off its data.
 */

export type ServiceScope = { kind: 'shared' } | { kind: 'dedicated'; workspaceId: string };

export interface EngineDef {
    readonly engine: string;
    readonly image: string;
    readonly internalPort: number;
    readonly majors: readonly string[];
    readonly sharing: 'shared-or-dedicated' | 'shared-only';
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
    /** The container's own credential env, from the instance's credentials. */
    readonly containerEnv: (c: Credentials) => Record<string, string>;
    /** The container's command (after the image), from the password it is protected with — Redis's `--requirepass`. */
    readonly command?: (password: string) => readonly string[];
    /** The host-form env a workspace gets. */
    readonly hostEnv: (host: string, port: number, c: Credentials) => Record<string, string>;
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
export const SHARED_TENANCY: Readonly<Record<string, { readonly adminUser: string; readonly containerEnv: (adminPassword: string) => Record<string, string> }>> = {
    // POSTGRES_DB=postgres: the image creates no extra database when it is the maintenance one.
    postgres: { adminUser: 'genie', containerEnv: (pw) => ({ POSTGRES_USER: 'genie', POSTGRES_PASSWORD: pw, POSTGRES_DB: 'postgres' }) },
    // Root only: the image refuses MYSQL_USER=root, and a second user here would be one no workspace's slice is.
    mysql: { adminUser: 'root', containerEnv: (pw) => ({ MYSQL_ROOT_PASSWORD: pw }) },
    mariadb: { adminUser: 'root', containerEnv: (pw) => ({ MARIADB_ROOT_PASSWORD: pw }) },
    // `--requirepass` (the launch command) sets the `default` user's password; each workspace is an ACL user.
    redis: { adminUser: 'default', containerEnv: () => ({}) },
};

export interface ServiceInstance {
    readonly id: string;
    readonly engine: string;
    readonly version: string;
    readonly scope: ServiceScope;
    readonly publishedPort: number;
    readonly credentials: Credentials;
    readonly active: boolean;
    /** `custom` engines: the env they declare, verbatim. */
    readonly env?: Readonly<Record<string, string>>;
    /** The container's own name, when Genie 2 did not derive it (an adopted Genie 1 container: `genie-svc-…`). */
    readonly containerName?: string;
    /** The image the container runs, as observed — Genie 1's own Postgres image, not the stock one. */
    readonly image?: string;
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
    /** Every surface the container publishes, by Genie 1's surface name (Mailpit's `ui`, MinIO's `console`). */
    readonly publishedPorts?: Readonly<Record<string, number>>;
}

/** One workspace's slice of a multi-tenant engine — as Genie 1 provisioned it, or as Genie 2 did (core/service-provision.ts). */
export interface AdoptedSlice {
    /** Genie 1's `ws_<slug>`: the database, the role, the Redis ACL user, the mail tag. */
    readonly identifier: string;
    /** The workspace's own password on the engine (Genie 1's `dev_services` row). */
    readonly password: string;
    /** Redis: the key prefix the ACL restricts the user to (`<identifier>:`). */
    readonly prefix?: string;
    /** MinIO: the bucket, which is also the access key (`ws-<slug>`). */
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

export const SERVICE_CATALOG: readonly EngineDef[] = [
    {
        engine: 'postgres', image: 'postgres', internalPort: 5432, majors: ['14', '15', '16', '17'], sharing: 'shared-or-dedicated',
        containerEnv: (c) => ({ POSTGRES_USER: c.user ?? 'genie', POSTGRES_PASSWORD: c.password ?? '', POSTGRES_DB: c.database ?? 'app' }),
        hostEnv: sqlEnv('pgsql', 'genie'),
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
        engine: 'reverb', image: 'particleacademy/genie-reverb', internalPort: 8080, majors: ['1'], sharing: 'shared-only',
        containerEnv: () => ({}),
        hostEnv: (host, port) => ({ REVERB_HOST: host, REVERB_PORT: String(port), REVERB_SCHEME: 'http' }),
    },
    {
        // Catch-all SMTP. The published port is SMTP; the web inbox (8025) is published too on an adopted
        // Genie 1 Mailpit and recorded in `publishedPorts.ui`.
        engine: 'mailpit', image: 'axllent/mailpit', tag: (major) => `v${major}`, internalPort: 1025, majors: ['1.30'], sharing: 'shared-or-dedicated',
        containerEnv: () => ({ MP_DATABASE: '/data/mailpit.db' }),
        hostEnv: (host, port) => ({ MAIL_MAILER: 'smtp', MAIL_HOST: host, MAIL_PORT: String(port) }),
    },
    {
        engine: 'minio', image: 'quay.io/minio/minio', internalPort: 9000, majors: ['latest'], sharing: 'shared-only', adoptOnly: true,
        containerEnv: () => ({}),
        hostEnv: (host, port) => ({ AWS_ENDPOINT: `http://${host}:${port}`, AWS_DEFAULT_REGION: 'us-east-1', AWS_USE_PATH_STYLE_ENDPOINT: 'true' }),
    },
];

/** The image reference for an engine at a major — `tag` where the registry's tags are not the bare major. */
export function imageFor(def: EngineDef, major: string): string {
    return `${def.image}:${def.tag ? def.tag(major) : major}`;
}

const HOST = '127.0.0.1';

function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

/**
 * The host-form env for a workspace: exactly one instance per engine, active first, else highest version.
 *
 * `workspaceId` is whose env this is. A multi-tenant engine (one with `slices`: adopted from Genie 1, or
 * a new shared one) serves a workspace only through that workspace's SLICE — a shared Postgres holding
 * three workspaces' databases has nothing to say to a fourth — and its "active" is the slice's, because
 * one shared engine is active for one workspace and not for another. Without a `workspaceId` no
 * multi-tenant instance emits.
 */
export function serviceEnvFor(instances: readonly ServiceInstance[], workspaceId?: string): Record<string, string> {
    const sliceOf = (i: ServiceInstance): AdoptedSlice | undefined => (workspaceId === undefined ? undefined : i.slices?.[workspaceId]);
    const byEngine = new Map<string, ServiceInstance[]>();
    for (const i of instances) {
        let view = i;
        if (i.slices !== undefined) {
            const slice = sliceOf(i);
            if (!slice) continue;
            view = { ...i, active: slice.active === true };
        }
        byEngine.set(view.engine, [...(byEngine.get(view.engine) ?? []), view]);
    }
    const chosen = new Map<string, ServiceInstance>();
    for (const [engine, list] of byEngine) {
        if (engine === 'custom') continue;
        chosen.set(engine, list.find((i) => i.active) ?? [...list].sort((a, b) => compareVersions(b.version, a.version))[0]!);
    }
    const env: Record<string, string> = {};
    for (const [engine, list] of byEngine) {
        if (engine === 'custom') {
            for (const i of list) Object.assign(env, i.env ?? {});
            continue;
        }
        const one = chosen.get(engine)!;
        if (one.slices !== undefined) {
            // Genie 1 gave `DATABASE_URL`/`DB_*` to Postgres when a workspace had both Postgres and MySQL.
            Object.assign(env, v1HostEnv(engine, one.publishedPort, sliceOf(one)!, { primaryRelational: (engine !== 'mysql' && engine !== 'mariadb') || !chosen.has('postgres') }));
            continue;
        }
        const def = SERVICE_CATALOG.find((e) => e.engine === engine);
        if (!def) continue;
        Object.assign(env, def.hostEnv(HOST, one.publishedPort, one.credentials));
    }
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
        case 'minio': {
            const bucket = slice.bucket ?? '';
            return { AWS_ENDPOINT: `http://${HOST}:${p}`, AWS_ACCESS_KEY_ID: bucket, AWS_SECRET_ACCESS_KEY: pw, AWS_BUCKET: bucket, AWS_DEFAULT_REGION: 'us-east-1', AWS_USE_PATH_STYLE_ENDPOINT: 'true' };
        }
        case 'mailpit':
            // The plus address Mailpit auto-tags (genie#552), and the same tag for an app that sets its own From.
            return { MAIL_MAILER: 'smtp', MAIL_HOST: HOST, MAIL_PORT: p, MAIL_FROM_ADDRESS: `genie+${id}@mail.gen`, GENIE_MAIL_TAG: id };
        default:
            return {};
    }
}

export function switchActiveWarning(input: { engine: string; from: string; to: string }): string {
    return `Switching ${input.engine} from ${input.from} to ${input.to}: each version keeps its own data volume, so ${input.to} starts EMPTY. Nothing in ${input.from} is deleted; switch back any time.`;
}

export interface ContainerPlan {
    readonly image: string;
    readonly name: string;
    readonly volume: string;
    /** `127.0.0.1:<published>:<internal>` — loopback only. */
    readonly publish: string;
    readonly env: Record<string, string>;
    /** The container's command after the image, when the engine needs one (Redis's `--requirepass`). */
    readonly command?: readonly string[];
}

/**
 * `admin` = a new SHARED multi-tenant engine: the container is created with its superuser only (SHARED_TENANCY), and
 * every workspace's credential is a slice made later. Otherwise `credentials` are the container's own.
 */
export function containerPlan(input: { engine: string; major: string; scope: ServiceScope; publishedPort: number; credentials?: Credentials; admin?: EngineAdmin }): ContainerPlan {
    const def = SERVICE_CATALOG.find((e) => e.engine === input.engine);
    if (!def) throw new Error(`${input.engine} is not an engine Genie manages`);
    if (def.adoptOnly) throw new Error(`${input.engine} can only be taken over from Genie 1, not created: its images are no longer published`);
    if (!def.majors.includes(input.major)) throw new Error(`${input.engine} ${input.major} is not a major Genie knows (${def.majors.join(', ')})`);
    if (def.sharing === 'shared-only' && input.scope.kind !== 'shared') throw new Error(`${input.engine} is a shared service — one per workstation, never per workspace`);
    const tenancy = input.admin ? SHARED_TENANCY[def.engine] : undefined;
    if (input.admin && !tenancy) throw new Error(`${input.engine} is not carved into per-workspace slices; it has no admin-only container`);
    const key = `${input.scope.kind === 'shared' ? 'shared' : input.scope.workspaceId}-${input.engine}-${input.major}`;
    const password = input.admin?.password ?? input.credentials?.password;
    const command = def.command && password ? def.command(password) : undefined;
    return {
        image: imageFor(def, input.major),
        name: `genie-${key}`,
        volume: `genie-${key}-data`,
        publish: `${HOST}:${input.publishedPort}:${def.internalPort}`,
        env: tenancy && input.admin ? tenancy.containerEnv(input.admin.password) : def.containerEnv(input.credentials ?? {}),
        ...(command ? { command } : {}),
    };
}
