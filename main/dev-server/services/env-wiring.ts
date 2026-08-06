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

export function serviceEnv(entries: ProvisionedService[]): Record<string, string> {
    const env: Record<string, string> = {};
    const ordered = sorted(entries);

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
