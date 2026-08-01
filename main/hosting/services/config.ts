import crypto from 'node:crypto';
import path from 'node:path';
import { assignPort, preferredPort, type PortRange } from '../ports';
import { ENGINE_FOR_KIND, isServiceKind, SERVICE_KINDS } from './types';
import type { ServiceInstance, ServiceKind } from './types';

/**
 * The persisted per-workspace SERVICE model, and the isolation rules that make
 * two workspaces' services genuinely separate (Tynn #232, P3).
 *
 * The sibling of `../sites-config.ts`, and stored the same way: one JSON column
 * on `workspaces`, an opaque id per entry, all parsing and sanitizing PURE and
 * in this file so `db.ts` never interprets a blob it read.
 *
 * ## What isolation means here
 *
 * Three things, and all three are derived rather than allocated:
 *
 *   - **A private data directory** per (workspace, kind). Two workspaces running
 *     `postgres` do not share a cluster, so dropping or migrating one's schema
 *     cannot reach the other's.
 *   - **A private PORT**, hashed from the service id exactly the way a site's is
 *     hashed from its site id (`../ports.ts`), from a DISJOINT range. Derived,
 *     not assigned, for the same reason: a stable endpoint is what lets the
 *     generated `.env` stay correct across restarts, and what stops two
 *     workspaces from racing for one number.
 *   - **A private password**, generated once per instance.
 *
 * ## On the password
 *
 * Generated with `crypto.randomBytes`, not derived from the workspace id — a
 * derived credential is the same secret on every machine that knows the
 * derivation, which is not a property to want. It is stored in the clear in
 * `genie.db` alongside the rest of the workspace's hosting config. That is
 * deliberate and worth being explicit about: the credential's whole purpose is
 * to end up in a `.env` file in the user's repository, in the clear, because
 * that is the only way `php artisan migrate` can use it. Encrypting the copy in
 * the database while writing the plaintext one two directories away would buy
 * nothing. The server it opens is bound to 127.0.0.1 and holds development data.
 */

// --- the model -------------------------------------------------------------

export interface ServiceConfig {
    /** Strict opt-in — nothing runs until this is true. */
    enabled: boolean;
    kind: ServiceKind;
    /** Generated once, at first enable. `redis` has none. */
    password?: string;
    /** The app's database name (`postgres` only). Defaults to `genie`. */
    database?: string;
}

/** A workspace's services, keyed by {@link serviceIdFor}. */
export type WorkspaceServices = Record<string, ServiceConfig>;

/**
 * The port band services draw from — disjoint from the sites' 20000–20999.
 *
 * Deliberately NOT the engines' famous defaults (5432, 6379). A managed cluster
 * that grabbed 5432 would collide with the Postgres a developer already runs,
 * and — far worse — an app misconfigured to talk to `localhost:5432` would
 * silently reach whichever of the two won the bind. Sitting somewhere
 * unmistakable makes "am I talking to Genie's Postgres?" answerable by looking
 * at the port.
 */
export const SERVICE_PORTS: PortRange = { min: 21_000, max: 21_999 };

/**
 * PURE. The id one service instance is stored and reported under.
 *
 * Keyed by (workspace, kind): a workspace has at most one Postgres and one
 * Redis. Hashed rather than concatenated so the id is a fixed-width opaque
 * token like every other id in this subsystem, and so a workspace id containing
 * a separator cannot forge another workspace's service id.
 *
 * The KIND comes first and `:` is the separator, which makes the split point
 * unambiguous: a kind is drawn from a closed set of lowercase words and can
 * never contain a colon, so no workspace id — whatever it holds — can shift the
 * boundary onto another pair's digest.
 */
export function serviceIdFor(workspaceId: string, kind: ServiceKind): string {
    return crypto.createHash('sha256').update(`${kind}:${workspaceId}`).digest('hex').slice(0, 16);
}

/** PURE. The stable loopback port for a service instance. */
export function servicePort(serviceId: string, taken: ReadonlySet<number> = new Set()): number {
    return assignPort(serviceId, taken, SERVICE_PORTS);
}

/** PURE. The port an instance WANTS, ignoring collisions. Exported for the UX,
 *  which shows it before anything has started. */
export function preferredServicePort(serviceId: string): number {
    return preferredPort(serviceId, SERVICE_PORTS);
}

/**
 * PURE. Where one instance's state lives.
 *
 * Under Genie's userData, keyed by service id — so it survives app updates, and
 * so removing a workspace's service is a single directory delete that cannot
 * take a neighbour's data with it.
 */
export function serviceDataDir(baseDir: string, serviceId: string): string {
    return path.join(baseDir, 'hosting', 'services', serviceId);
}

// --- credentials -----------------------------------------------------------

/**
 * The fixed role name every managed Postgres uses.
 *
 * Not the workspace's name: a role name that varied per workspace would leak
 * into the generated `.env` and make two developers' setups differ for no gain,
 * and `postgres` (the conventional superuser name) is exactly the account an
 * app should NOT be handed.
 */
export const SERVICE_DB_USER = 'genie';

/** The default database name created for the app. */
export const DEFAULT_DATABASE = 'genie';

/**
 * A fresh credential.
 *
 * Base64url of 24 random bytes: no shell-special or URL-special characters, so
 * the same string is safe unquoted in a `.env`, in a `DATABASE_URL`, and on a
 * `psql` command line — three places it is about to appear.
 */
export function generatePassword(): string {
    return crypto.randomBytes(24).toString('base64url');
}

// --- sanitize --------------------------------------------------------------

/** A database name Postgres will accept unquoted, and that cannot smuggle SQL. */
function sanitizeDatabase(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const name = value.trim().toLowerCase();
    // Postgres identifiers: leading letter or underscore, then letters/digits/_.
    // 63 bytes is the server's own limit (NAMEDATALEN - 1).
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) return undefined;
    return name;
}

/** PURE. Normalize an untrusted patch: only well-typed, in-bounds fields survive. */
export function sanitizeServicePatch(
    patch: Partial<ServiceConfig> | null | undefined,
): Partial<ServiceConfig> {
    const out: Partial<ServiceConfig> = {};
    if (!patch || typeof patch !== 'object') return out;

    if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;
    if (isServiceKind(patch.kind)) out.kind = patch.kind;

    const database = sanitizeDatabase(patch.database);
    if (database !== undefined) out.database = database;

    // The password is NOT settable from a patch. It is generated by
    // `withCredentials` on first enable and never travels inbound, so a
    // renderer — or anything replaying an IPC message — cannot pin a
    // workspace's database credential to a value it chose.
    return out;
}

/**
 * PURE. Parse a stored `workspace_services` blob. Robust to NULL, corrupt JSON
 * and junk values — an unreadable blob reads as `{}` (the safe default: nothing
 * running).
 */
export function parseWorkspaceServices(raw: string | null | undefined): WorkspaceServices {
    if (!raw) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: WorkspaceServices = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = value as Partial<ServiceConfig> | null;
        if (!entry || typeof entry !== 'object' || !isServiceKind(entry.kind)) continue;
        const clean = sanitizeServicePatch(entry) as ServiceConfig;
        // The password survives a round-trip even though a PATCH may not set it
        // — this is reading OUR blob back, not accepting one from a caller.
        if (typeof entry.password === 'string' && entry.password) clean.password = entry.password;
        out[id] = clean;
    }
    return out;
}

/**
 * PURE. Fill in whatever a config still needs before it can be started.
 *
 * Called on the way IN to the store (never on read), so a password is minted
 * exactly once per instance and then persists — regenerating it on every read
 * would invalidate the `.env` the user's app is already using.
 */
export function withCredentials(
    config: ServiceConfig,
    newPassword: () => string = generatePassword,
): ServiceConfig {
    const out: ServiceConfig = { ...config };
    if (out.kind === 'postgres') {
        out.password ||= newPassword();
        out.database ||= DEFAULT_DATABASE;
    }
    return out;
}

// --- resolve ---------------------------------------------------------------

/**
 * PURE. Turn a stored config into the runnable {@link ServiceInstance}, or
 * `null` when it cannot safely be started.
 *
 * `taken` lets the caller keep two instances that hash to the same slot off one
 * port; it is the live set the manager already tracks, which keeps this pure.
 */
export function resolveServiceInstance(
    workspaceId: string,
    baseDir: string,
    config: Partial<ServiceConfig>,
    taken: ReadonlySet<number> = new Set(),
): ServiceInstance | null {
    if (!workspaceId || !baseDir || !isServiceKind(config.kind)) return null;
    const kind = config.kind;
    const id = serviceIdFor(workspaceId, kind);
    const instance: ServiceInstance = {
        id,
        workspaceId,
        kind,
        engine: ENGINE_FOR_KIND[kind],
        port: servicePort(id, taken),
        dataDir: serviceDataDir(baseDir, id),
    };
    if (kind === 'postgres') {
        // A Postgres with no credential cannot be started at all — refusing here
        // is better than initialising a cluster with trust auth and calling it
        // done.
        if (!config.password) return null;
        instance.user = SERVICE_DB_USER;
        instance.password = config.password;
        instance.database = config.database || DEFAULT_DATABASE;
    }
    return instance;
}

export { SERVICE_KINDS };
export type { ServiceKind };
