import { createHmac } from 'node:crypto';
import { SERVICE_ENGINES } from './catalog';
import type { ServiceEngine } from './catalog';
import type { WorkspaceSlice } from './provision';

/**
 * PURE. A workspace's provisioned services → the environment its app containers
 * read.
 *
 * This is the seam that makes the whole phase useful: the result goes into
 * `DevSiteConfig.env` → `ContainerSpec.env`, so a repo's dev server comes up
 * already knowing its `DATABASE_URL` without anyone writing a `.env`.
 *
 * ## The one value that is easy to get wrong
 *
 * The HOST. Inside the workspace's network the engine is reachable by its
 * CONTAINER NAME on its real port (`genie-svc-postgres-16:5432`) — never by the
 * loopback port published on the desktop. Publishing exists so a person, an
 * agent or a `psql` on the host can connect; it is not how a sibling container
 * connects. Emitting the loopback form here would produce a `DATABASE_URL` that
 * works when pasted into a terminal and fails inside every container, which is
 * the most confusing failure this feature could ship.
 *
 * ## Single-valued keys
 *
 * `DATABASE_URL` and the framework-shaped `DB_*` set name ONE connection. A
 * workspace with both a Postgres and a MySQL has to be told which is the
 * default, so the choice is made deterministically (Postgres first) rather than
 * by whichever happened to start last — and the other engine still gets its own
 * native `MYSQL_*` variables, so nothing becomes unreachable.
 */

export interface ProvisionedService {
    engine: ServiceEngine;
    /** The engine's major version. A workspace can hold two of them (the service
     *  key is (engine, VERSION)), which is why {@link active} has to exist. */
    version?: string;
    /** This is the version whose connection the shared names point at (#242 P3).
     *  At most one per engine; absent everywhere ⇒ a deterministic fallback. */
    active?: boolean;
    /** The engine container's name — how a sibling container reaches it. */
    host: string;
    /** The port INSIDE the container. */
    port: number;
    /** This workspace's derived names + credential. */
    slice: WorkspaceSlice;
    /** The engine's own master credential. Only the namespace engines hand it
     *  out — they have no per-workspace one. */
    adminUser?: string;
    adminPassword?: string;
    /** `custom` only: the service's name, and the env it carries. */
    name?: string;
    customEnv?: Record<string, string>;
}

/** Which relational engine owns `DATABASE_URL` / `DB_*` when there are two. */
const RELATIONAL_PRIORITY: readonly ServiceEngine[] = ['postgres', 'mysql'];

/** A stable order, so the same set of services always produces the same env. */
function sorted(entries: ProvisionedService[]): ProvisionedService[] {
    return [...entries].sort((a, b) => {
        const byEngine = SERVICE_ENGINES.indexOf(a.engine) - SERVICE_ENGINES.indexOf(b.engine);
        return byEngine !== 0 ? byEngine : a.host.localeCompare(b.host);
    });
}

/**
 * The secret for a workspace's Reverb app: HMAC-SHA256 of the app id, keyed by
 * the engine's master secret. The shared genie-reverb server derives the EXACT
 * same value from the same master (`hash_hmac('sha256', $appId, $master)`), so
 * the site and the server agree on a per-workspace app with NO registration —
 * and no workspace can forge another's secret without the master. This formula
 * is a CONTRACT: keep it in lockstep with the server's app provider.
 */
export function reverbAppSecret(master: string, appId: string): string {
    return createHmac('sha256', master).update(appId).digest('hex');
}

/** `thing` → `THING`, for the custom escape hatch's endpoint variables. */
function envToken(value: string): string {
    return value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SERVICE';
}

/**
 * One entry per ENGINE — the ACTIVE version (#242 P3).
 *
 * A workspace can hold postgres 16 and 17 at once, and they are different
 * containers with different VOLUMES, i.e. different data. Every name they would
 * emit (`DATABASE_URL`, `DB_*`, `PG*`) is single-valued, so letting both through
 * does not produce a debatable answer — it produces an INCOHERENT one: the
 * single-valued keys took the first entry while the engine-native keys were
 * overwritten by the last, so an app reading `DB_HOST` and a tool reading
 * `PGHOST` reached different databases.
 *
 * So exactly one version of each engine contributes: the one marked active, else
 * a deterministic fallback (the existing container-name order) so an unchosen
 * workspace is at least consistent with itself. `custom` is exempt — several
 * custom services are legitimate and namespaced by their own name.
 */
function activeOnly(ordered: ProvisionedService[]): ProvisionedService[] {
    const chosen = new Map<ServiceEngine, ProvisionedService>();
    const customs: ProvisionedService[] = [];
    for (const entry of ordered) {
        if (entry.engine === 'custom') {
            customs.push(entry);
            continue;
        }
        const current = chosen.get(entry.engine);
        // An explicit choice always wins; otherwise keep the first (stable).
        if (!current || (entry.active && !current.active)) chosen.set(entry.engine, entry);
    }
    // Preserve the incoming order so the primary-relational pick is unchanged.
    return ordered.filter((e) => customs.includes(e) || chosen.get(e.engine) === e);
}

export function serviceEnv(entries: ProvisionedService[]): Record<string, string> {
    const env: Record<string, string> = {};
    const ordered = activeOnly(sorted(entries));

    const primaryRelational = RELATIONAL_PRIORITY.map((engine) =>
        ordered.find((e) => e.engine === engine),
    ).find(Boolean);

    for (const entry of ordered) {
        const { host, port, slice } = entry;
        const isPrimary = entry === primaryRelational;

        switch (entry.engine) {
            case 'postgres': {
                Object.assign(env, {
                    PGHOST: host,
                    PGPORT: String(port),
                    PGUSER: slice.identifier,
                    PGPASSWORD: slice.password,
                    PGDATABASE: slice.identifier,
                });
                if (isPrimary) {
                    Object.assign(env, {
                        DATABASE_URL: `postgresql://${slice.identifier}:${slice.password}@${host}:${port}/${slice.identifier}`,
                        DB_CONNECTION: 'pgsql',
                        DB_HOST: host,
                        DB_PORT: String(port),
                        DB_DATABASE: slice.identifier,
                        DB_USERNAME: slice.identifier,
                        DB_PASSWORD: slice.password,
                    });
                }
                break;
            }

            case 'mysql': {
                Object.assign(env, {
                    MYSQL_HOST: host,
                    MYSQL_PORT: String(port),
                    MYSQL_USER: slice.identifier,
                    MYSQL_PASSWORD: slice.password,
                    MYSQL_DATABASE: slice.identifier,
                });
                if (isPrimary) {
                    Object.assign(env, {
                        DATABASE_URL: `mysql://${slice.identifier}:${slice.password}@${host}:${port}/${slice.identifier}`,
                        DB_CONNECTION: 'mysql',
                        DB_HOST: host,
                        DB_PORT: String(port),
                        DB_DATABASE: slice.identifier,
                        DB_USERNAME: slice.identifier,
                        DB_PASSWORD: slice.password,
                    });
                }
                break;
            }

            case 'redis': {
                Object.assign(env, {
                    REDIS_URL: `redis://${slice.identifier}:${slice.password}@${host}:${port}`,
                    REDIS_HOST: host,
                    REDIS_PORT: String(port),
                    REDIS_USERNAME: slice.identifier,
                    REDIS_PASSWORD: slice.password,
                    // The ACL restricts this user to `<identifier>:*`, so an app
                    // that ignores the prefix gets a permission error rather
                    // than silently reading nothing.
                    REDIS_PREFIX: `${slice.identifier}:`,
                });
                break;
            }

            case 'meilisearch': {
                Object.assign(env, {
                    MEILISEARCH_HOST: `http://${host}:${port}`,
                    // The SHARED master key: Meilisearch is namespace-isolated,
                    // not credential-isolated (see `catalog.ts`).
                    ...(entry.adminPassword ? { MEILISEARCH_KEY: entry.adminPassword } : {}),
                    MEILISEARCH_INDEX_PREFIX: `${slice.identifier}_`,
                });
                break;
            }

            case 'minio': {
                Object.assign(env, {
                    AWS_ENDPOINT: `http://${host}:${port}`,
                    ...(entry.adminUser ? { AWS_ACCESS_KEY_ID: entry.adminUser } : {}),
                    ...(entry.adminPassword ? { AWS_SECRET_ACCESS_KEY: entry.adminPassword } : {}),
                    // A bucket name is a DNS label — the SQL identifier's
                    // underscores are illegal there.
                    AWS_BUCKET: slice.dnsName,
                    AWS_DEFAULT_REGION: 'us-east-1',
                    // MinIO serves buckets as a path, not a subdomain.
                    AWS_USE_PATH_STYLE_ENDPOINT: 'true',
                });
                break;
            }

            case 'mailpit': {
                Object.assign(env, {
                    MAIL_MAILER: 'smtp',
                    MAIL_HOST: host,
                    MAIL_PORT: String(port),
                });
                break;
            }

            case 'reverb': {
                const appId = slice.identifier;
                // Namespace isolation: shared master, per-workspace app whose
                // secret is DERIVED so the server needs no registration.
                const secret = entry.adminPassword
                    ? reverbAppSecret(entry.adminPassword, appId)
                    : '';
                Object.assign(env, {
                    BROADCAST_CONNECTION: 'reverb',
                    REVERB_APP_ID: appId,
                    // The app KEY is the public client identifier — the workspace
                    // slug is fine, it is not a secret.
                    REVERB_APP_KEY: appId,
                    REVERB_APP_SECRET: secret,
                    // BACKEND path: the site reaches the shared server by
                    // CONTAINER name on its container port over http — never the
                    // published loopback. The BROWSER-facing wss route
                    // (VITE_REVERB_* → reverb.<ws>.gen) is injected at the site
                    // layer, where the `.gen` name is known.
                    REVERB_HOST: host,
                    REVERB_PORT: String(port),
                    REVERB_SCHEME: 'http',
                });
                break;
            }

            case 'custom': {
                const token = envToken(entry.name ?? 'service');
                Object.assign(env, {
                    [`GENIE_SERVICE_${token}_HOST`]: host,
                    [`GENIE_SERVICE_${token}_PORT`]: String(port),
                    ...(entry.customEnv ?? {}),
                });
                break;
            }
        }
    }

    return env;
}

// --- what an interactive TERMINAL may inherit (genie#221) --------------------

/**
 * Names a framework reads as ITS OWN datastore configuration.
 *
 * Ambient values for these silently outrank a project's test settings, which is
 * how a Laravel suite run from a Genie terminal came to drop the development
 * database while reporting `99 passed`: PHPUnit's `<env>` defaults to
 * `force="false"`, so the `DB_CONNECTION=sqlite` / `DB_DATABASE=:memory:` lines
 * every Laravel skeleton ships were skipped because Genie had already exported
 * `DB_CONNECTION`. `RefreshDatabase` then ran `migrate:fresh` against the live
 * workspace Postgres.
 *
 * `force="true"` is not a fix either: PHPUnit writes `<env>` to `$_ENV` and
 * `putenv()` and never to `$_SERVER`, and Laravel's Dotenv chain consults
 * `$_SERVER` first — where the shell's variables are.
 *
 * Only DATASTORES are listed. These are the ones a test run will DESTROY —
 * `migrate:fresh` drops the schema, a cache flush empties Redis. `MAIL_*`,
 * `REVERB_*` and `AWS_*` are left alone: shadowing them cannot lose data, and
 * taking them away would break a dev server started from a terminal for no gain.
 */
const TERMINAL_RESERVED = /^(DATABASE_URL$|DB_|REDIS_)/;

/**
 * The service env an interactive TERMINAL is allowed to inherit.
 *
 * A terminal gets the CLIENT credentials, not the APPLICATION's configuration:
 * `PG*`/`MYSQL_*` pass through (that is what makes `psql` work with nothing
 * typed, and nothing treats them as an app's datastore), while the framework's
 * own names are moved under `GENIE_` — withheld from being picked up by
 * accident, but still there for an agent that wants the managed connection.
 *
 * SITES and PROCESSES do NOT go through here and are unchanged: a served app and
 * a `queue:work` ARE the application and need its configuration. The narrowing
 * is only where a test suite gets typed.
 */
export function terminalServiceEnv(env: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (key.startsWith('GENIE_')) {
            out[key] = value;
        } else if (TERMINAL_RESERVED.test(key)) {
            out[`GENIE_${key}`] = value;
        } else {
            out[key] = value;
        }
    }
    return out;
}
