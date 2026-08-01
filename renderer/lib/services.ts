import type { HostingTone } from './hosting';
import type {
    HostedState,
    ServiceEngine,
    ServiceEnvWrite,
    ServiceKind,
    ServiceRow,
} from './genie';

/**
 * The Site Manager's SERVICES tab VIEW MODEL (Tynn #232, P3 wiring).
 *
 * The sibling of `hosting.ts`, arranged the same way and for the same reason:
 * the renderer test env is Node-only, so the surface is verified by hand / e2e
 * and every decision it makes lives here as a pure function.
 *
 * The one difference from the sites tab is what a "row" is. A site is discovered
 * — Genie scans the workspace and proposes what it found — so the sites list is
 * as long as the workspace is interesting. A service is CHOSEN from a closed set
 * of two, so the tab always lists both kinds whether or not they are configured,
 * and enabling one is what creates it. That keeps "I want a database here" a
 * single switch rather than an add-then-configure flow.
 *
 * Everything in this file is PURE.
 */

/** Every kind, in the order the tab lists them (mirrors SERVICE_KINDS in
 *  main/hosting/services/types.ts). */
export const SERVICE_KINDS: readonly ServiceKind[] = ['postgres', 'redis'];

/** The engine each kind runs on today (mirrors ENGINE_FOR_KIND in main). */
export const ENGINE_FOR_KIND: Readonly<Record<ServiceKind, ServiceEngine>> = {
    postgres: 'postgres',
    redis: 'garnet',
};

/** How each kind introduces itself. The blurb says what the service IS FOR,
 *  because "postgres" alone does not tell a user whether they need it. */
const DESCRIPTORS: Readonly<
    Record<ServiceKind, { name: string; blurb: string; icon: string }>
> = {
    postgres: {
        name: 'PostgreSQL',
        blurb: 'The database this workspace’s app connects to — its own cluster, port and credential.',
        icon: 'database',
    },
    redis: {
        name: 'Redis',
        blurb: 'Cache, sessions and queues — a RESP server on its own port.',
        icon: 'zap',
    },
};

/** One row in the Services tab: a configured service, or a kind on offer. */
export interface ServiceManagerRow {
    /** Stable React key — the serviceId once configured, else the kind. */
    key: string;
    kind: ServiceKind;
    /** What actually runs. Not always the kind — see {@link serviceEngineNote}. */
    engine: ServiceEngine;
    name: string;
    blurb: string;
    icon: string;
    /** False = a kind Genie offers that this workspace has never turned on. */
    configured: boolean;
    /** The stored opt-in. An unconfigured kind is never enabled. */
    enabled: boolean;
    state: HostedState;
    /** The loopback port, or null before the service exists (main derives it
     *  from the service id, so there is none to show until then). */
    port: number | null;
    endpoint: { host: string; port: number } | null;
    serviceId?: string;
    database?: string;
    user?: string;
    error?: string;
}

/**
 * PURE. One row per KIND, carrying whatever this workspace has configured.
 *
 * Merged onto the kind rather than appended, so a configured Postgres and the
 * offer of one are never both on screen — the tab is a fixed two-row surface
 * whose rows gain state, which is what makes "is there a database here?"
 * answerable at a glance.
 */
export function serviceManagerRows(configured: ServiceRow[]): ServiceManagerRow[] {
    const byKind = new Map<ServiceKind, ServiceRow>();
    for (const row of configured) byKind.set(row.kind, row);

    return SERVICE_KINDS.map((kind) => {
        const descriptor = DESCRIPTORS[kind];
        const row = byKind.get(kind);
        return {
            key: row?.serviceId ?? `kind:${kind}`,
            kind,
            engine: ENGINE_FOR_KIND[kind],
            name: descriptor.name,
            blurb: descriptor.blurb,
            icon: descriptor.icon,
            configured: !!row,
            enabled: !!row?.enabled,
            state: row?.state ?? 'stopped',
            port: row?.port ?? null,
            endpoint: row?.endpoint ?? null,
            ...(row ? { serviceId: row.serviceId } : {}),
            ...(row?.database ? { database: row.database } : {}),
            ...(row?.user ? { user: row.user } : {}),
            ...(row?.error ? { error: row.error } : {}),
        };
    });
}

/**
 * PURE. What a row's status line says.
 *
 * The same rule the sites tab follows: a running service reads as the ENDPOINT
 * (the one fact the user came for — where to point a client), and a failed one
 * reads as its REASON, never as merely off. A database whose cluster failed to
 * initialise looking identical to one nobody turned on is exactly the confusion
 * the manager keeps its last failure around to prevent.
 */
export function serviceStatusLabel(row: ServiceManagerRow): string {
    if (row.state === 'failed') return row.error || 'Failed to start';
    if (row.state === 'running') {
        const host = row.endpoint?.host ?? '127.0.0.1';
        const port = row.endpoint?.port ?? row.port;
        return port ? `${host}:${port}` : 'Running';
    }
    if (!row.configured) return 'Not set up yet';
    if (!row.enabled) return 'Disabled';
    return 'Starting…';
}

/** PURE. The tone of a row's status dot — identical rules to a site's, so the
 *  two tabs read the same way. */
export function serviceStatusTone(row: ServiceManagerRow): HostingTone {
    if (row.state === 'failed') return 'failed';
    if (row.state === 'running') return 'running';
    if (row.configured && row.enabled) return 'starting';
    return 'idle';
}

/** One line of the `.env` managed block, as the tab shows it. */
export interface ServiceEnvLine {
    key: string;
    value: string;
    /** A credential — displayed as a placeholder, never as itself. */
    secret?: boolean;
}

/** What stands in for a credential on screen. */
export const ENV_SECRET_PLACEHOLDER = '••••••••';

/**
 * PURE. The `.env` lines this service implies — the user-facing mirror of the
 * managed block `main/hosting/services/env.ts#serviceEnvVars` writes.
 *
 * The KEYS are that function's; if it gains one, this gains one. It is
 * duplicated rather than fetched because the real values include the database
 * password, and the password must not cross the IPC boundary for a preview:
 * `ServiceRow` deliberately omits it, so the tab shows a placeholder and points
 * at the app's `.env`, which is the only place the credential belongs.
 *
 * A service that is not enabled previews NOTHING, because the block genuinely
 * would not hold it — showing lines that are not in the file would be a lie
 * about a file in the user's repository.
 */
export function serviceEnvPreview(row: ServiceManagerRow): ServiceEnvLine[] {
    if (!row.configured || !row.enabled) return [];
    const port = String(row.endpoint?.port ?? row.port ?? '');
    if (row.kind === 'postgres') {
        return [
            { key: 'DB_CONNECTION', value: 'pgsql' },
            { key: 'DB_HOST', value: '127.0.0.1' },
            { key: 'DB_PORT', value: port },
            { key: 'DB_DATABASE', value: row.database ?? 'genie' },
            { key: 'DB_USERNAME', value: row.user ?? 'genie' },
            { key: 'DB_PASSWORD', value: ENV_SECRET_PLACEHOLDER, secret: true },
        ];
    }
    return [
        { key: 'REDIS_HOST', value: '127.0.0.1' },
        { key: 'REDIS_PORT', value: port },
    ];
}

/**
 * PURE. The note a kind needs when its ENGINE is not what it is called.
 *
 * Said out loud rather than hidden: upstream Redis publishes no binaries for any
 * platform and does not support Windows, so the `redis` slot runs Garnet, which
 * speaks the same protocol. A user debugging a client's `INFO` output should
 * learn that here and not from a surprise.
 */
export function serviceEngineNote(row: ServiceManagerRow): string | null {
    if (row.kind !== 'redis') return null;
    return 'Served by Garnet, Microsoft’s RESP-compatible server — your redis client, cache, session and queue drivers talk to it unchanged. Upstream Redis ships no binaries to fetch.';
}

/**
 * PURE. Whether the `.env` block supersedes keys the user set themselves.
 *
 * Their lines are never touched, but the managed block sits at the END of the
 * file and phpdotenv lets the last assignment win — so the effect IS overridden.
 * Reporting it is the whole reason main returns the conflicts.
 */
export function envConflictNote(conflicts: readonly string[]): string | null {
    if (!conflicts.length) return null;
    return `Your .env also sets ${conflicts.join(', ')} outside Genie’s block. Those lines are left exactly as you wrote them, but the managed block comes later in the file, so while hosting is on it is Genie’s value that the app uses.`;
}

/**
 * PURE. What to tell the user after main wrote (or declined to write) the
 * `.env`, or null when there is nothing worth saying.
 *
 * The `path: null` case is not a failure and must not read as one: main
 * deliberately never CREATES a `.env`, because dropping credentials into a
 * directory that has no configuration to extend is a surprise rather than a
 * convenience. The app still gets the services as real environment variables
 * from the hosted site's own process — it is `artisan migrate` on the command
 * line that would come up short, so the user has to know.
 */
export function envWriteNote(result: ServiceEnvWrite | null | undefined): string | null {
    if (!result) return null;
    if (result.path === null) {
        return 'This workspace has no .env, so nothing was written — Genie never creates one. The hosted site still gets these settings as environment variables; command-line tools like `artisan migrate` will not until the file exists.';
    }
    return envConflictNote(result.conflicts);
}

/** Why the Services tab cannot act, if it cannot. */
export type ServicesAvailability = 'ready' | 'remote' | 'unsupported';

/** PURE. The inert state's explanation, or null when services can run here. */
export function servicesUnavailableNote(availability: ServicesAvailability): string | null {
    if (availability === 'ready') return null;
    if (availability === 'remote') {
        return 'Services run on the machine that holds the workspace. This window is driving another machine, so they are managed over there — open Genie on that host to start a database or cache.';
    }
    return 'Services are not available on this host. Nothing is running and nothing was changed.';
}

/** PURE. How many services this workspace actually has turned on — the tab's
 *  count, so the badge means "running cost" rather than "kinds that exist". */
export function enabledServiceCount(rows: readonly ServiceManagerRow[]): number {
    return rows.filter((row) => row.enabled).length;
}
