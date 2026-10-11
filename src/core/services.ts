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
 */

export type ServiceScope = { kind: 'shared' } | { kind: 'dedicated'; workspaceId: string };

export interface EngineDef {
    readonly engine: string;
    readonly image: string;
    readonly internalPort: number;
    readonly majors: readonly string[];
    readonly sharing: 'shared-or-dedicated' | 'shared-only';
    /** The container's own credential env, from the instance's credentials. */
    readonly containerEnv: (c: Credentials) => Record<string, string>;
    /** The host-form env a workspace gets. */
    readonly hostEnv: (host: string, port: number, c: Credentials) => Record<string, string>;
}

export interface Credentials {
    readonly user?: string;
    readonly password?: string;
    readonly database?: string;
}

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
        hostEnv: (host, port) => ({ REDIS_URL: `redis://${host}:${port}`, REDIS_HOST: host, REDIS_PORT: String(port) }),
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
];

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

/** The host-form env for a workspace: exactly one instance per engine, active first, else highest version. */
export function serviceEnvFor(instances: readonly ServiceInstance[]): Record<string, string> {
    const byEngine = new Map<string, ServiceInstance[]>();
    for (const i of instances) byEngine.set(i.engine, [...(byEngine.get(i.engine) ?? []), i]);
    const env: Record<string, string> = {};
    for (const [engine, list] of byEngine) {
        if (engine === 'custom') {
            for (const i of list) Object.assign(env, i.env ?? {});
            continue;
        }
        const chosen = list.find((i) => i.active) ?? [...list].sort((a, b) => compareVersions(b.version, a.version))[0]!;
        const def = SERVICE_CATALOG.find((e) => e.engine === engine);
        if (!def) continue;
        Object.assign(env, def.hostEnv(HOST, chosen.publishedPort, chosen.credentials));
    }
    return env;
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
}

export function containerPlan(input: { engine: string; major: string; scope: ServiceScope; publishedPort: number; credentials?: Credentials }): ContainerPlan {
    const def = SERVICE_CATALOG.find((e) => e.engine === input.engine);
    if (!def) throw new Error(`${input.engine} is not an engine Genie manages`);
    if (!def.majors.includes(input.major)) throw new Error(`${input.engine} ${input.major} is not a major Genie knows (${def.majors.join(', ')})`);
    if (def.sharing === 'shared-only' && input.scope.kind !== 'shared') throw new Error(`${input.engine} is a shared service — one per workstation, never per workspace`);
    const key = `${input.scope.kind === 'shared' ? 'shared' : input.scope.workspaceId}-${input.engine}-${input.major}`;
    return {
        image: `${def.image}:${input.major}`,
        name: `genie-${key}`,
        volume: `genie-${key}-data`,
        publish: `${HOST}:${input.publishedPort}:${def.internalPort}`,
        env: def.containerEnv(input.credentials ?? {}),
    };
}
