import { createHash, randomBytes } from 'node:crypto';
import { engineSpecFor, isServiceEngine, resolveEngineVersion } from './catalog';
import type { ServiceEngine } from './catalog';

/**
 * PURE. The persisted per-workspace SERVICE model (Tynn #234, P3).
 *
 * The sibling of `../sites-config.ts`, stored the same way — one JSON column on
 * `workspaces`, an opaque id per entry, all parsing and sanitizing here so
 * `db.ts` never interprets a blob it read — and a FOURTH column rather than a
 * reuse of v30's `workspace_services`, for exactly the reason v31 gave for
 * `dev_sites`: the beta.218 `workspace_services` row describes a HOST-NATIVE
 * Postgres fetched onto the user's machine, this one describes a workspace's
 * slice of a shared container. Both are live until P4 retires the first, and
 * folding them together now would make that retirement a data migration instead
 * of a deletion.
 *
 * ## What is stored, and what is derived
 *
 * Stored: which engine, which version, shared or dedicated, and the
 * workspace's own **password** on that engine. Derived everywhere else: the
 * database name, the role name, the ACL user, the key prefix, the bucket — all
 * functions of the workspace id (`catalog.ts`), so they survive a database that
 * has forgotten and cannot drift out of step with what was actually created.
 *
 * ## On the password
 *
 * Minted with `crypto.randomBytes` on the way IN to the store, exactly once,
 * and then never touched — regenerating it on read would lock the workspace out
 * of the database that was created with it. It is stored in the clear, and that
 * is deliberate for the same reason `hosting/services/config.ts` gives at
 * length: its entire purpose is to end up in a `.env` in the user's repo and in
 * a container's environment, in the clear, because that is the only way the
 * app can use it. The engine it opens listens on loopback and holds development
 * data.
 */

// --- the model --------------------------------------------------------------

export interface DevServiceConfig {
    engine: ServiceEngine;
    /** The engine version this workspace is pinned to (`16`, `8.4`). */
    version: string;
    /**
     * Opt-in HARD isolation: this workspace's own container rather than the
     * shared one. The escape hatch for a custom config, an extension, or
     * destructive testing.
     *
     * NOTE: shared and dedicated engines have different data volumes, so
     * flipping this does not move data — the workspace is re-provisioned empty
     * on the other side. Said here because it is the one surprising thing about
     * the toggle.
     */
    dedicated: boolean;
    /**
     * This is the version whose connection this workspace's apps get (#242 P3).
     *
     * The service key is (workspace, engine, VERSION), so a workspace can hold
     * postgres 16 AND 17 — different containers, different VOLUMES, different
     * data. `DATABASE_URL` / `DB_*` / `PG*` name ONE connection, so exactly one
     * version per engine may own them; the others stay reachable containers but
     * contribute no environment. At most one `active` per engine.
     *
     * NOTE: like {@link dedicated}, switching does NOT move data — each version
     * keeps its own volume, so the newly-active one starts empty.
     */
    active?: boolean;
    /** This workspace's credential on the engine. Minted once; see the header. */
    password: string;
    /** `custom` only: the image to run. */
    image?: string;
    /** `custom` only: the port it listens on inside the container. */
    port?: number;
    /** `custom` only: extra environment for the container. */
    env?: Record<string, string>;
    /** Strict opt-in — nothing runs until this is true. */
    enabled: boolean;
}

/** A workspace's services, keyed by {@link devServiceIdFor}. */
export type DevServices = Record<string, DevServiceConfig>;

/** Docker/OCI reference characters — permissive about registries and digests,
 *  strict about whitespace and shell metacharacters. */
const IMAGE_REF = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,254}$/;

/** Environment names we will put on a command line. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// --- identity ---------------------------------------------------------------

/**
 * The opaque id one workspace's service is stored and reported under.
 *
 * Keyed by (workspace, ENGINE KEY) — engine AND version — so one workspace can
 * hold a `postgres-15` and a `postgres-16` at once, and so a second `postgres-16`
 * cannot be added alongside the first and fight it for the same database name.
 *
 * The engine key comes first and `\0` separates, so no workspace id can shift
 * the boundary onto another pair's digest.
 */
export function devServiceIdFor(workspaceId: string, engineKey: string): string {
    return createHash('sha256')
        .update(`${engineKey}\0${workspaceId}`)
        .digest('hex')
        .slice(0, 16);
}

// --- credentials ------------------------------------------------------------

/**
 * A fresh credential.
 *
 * Base64url of 24 random bytes: no shell-special, URL-special or SQL-special
 * characters, so the same string is safe unquoted in a `.env`, inside a
 * `DATABASE_URL`, and in a `psql`/`redis-cli` argv — four places it is about to
 * appear. The provisioning layer asserts this shape rather than trusting it.
 */
export function generateServicePassword(): string {
    return randomBytes(24).toString('base64url');
}

/** PURE. Fill in what a config still needs before it can be provisioned. Called
 *  on the way IN to the store, never on read. */
export function withServiceCredentials(
    config: DevServiceConfig,
    newPassword: () => string = generateServicePassword,
): DevServiceConfig {
    return { ...config, password: config.password || newPassword() };
}

/**
 * PURE. Merge a service PATCH over the row already stored, deciding the whole
 * config that gets written — including which credential it keeps.
 *
 * Extracted from the db upsert so the one invariant that matters can be asserted
 * without a database (genie#193):
 *
 * **A re-add never RE-KEYS a workspace out of its own database.** The password
 * comes ONLY from the stored row, never from the patch — a patch crosses the
 * MCP/renderer boundary, and letting it set the credential would make `add` a way
 * to overwrite the secret the engine was actually provisioned with. A new one is
 * minted only when there is genuinely no previous row: a first add, or an add
 * after the registration was lost (genie#190, since fixed — that loss is what
 * produced the rotation seen in the wild).
 *
 * Defaults sit UNDER the stored row, which sits under the patch: a create gets a
 * complete row, an update touches only what it named.
 */
export function mergeDevServiceConfig(
    previous: DevServiceConfig | undefined,
    patch: Partial<DevServiceConfig> & { engine: DevServiceConfig['engine'] },
    version: string,
    newPassword: () => string = generateServicePassword,
): DevServiceConfig {
    const combined = { ...previous, ...patch };

    return withServiceCredentials(
        {
            engine: patch.engine,
            version,
            dedicated: combined.dedicated ?? false,
            enabled: combined.enabled ?? false,
            // NOT `combined.password` — that would let a patch carry one.
            password: previous?.password ?? '',
            ...(combined.image ? { image: combined.image } : {}),
            ...(combined.port ? { port: combined.port } : {}),
            ...(combined.env ? { env: combined.env } : {}),
        },
        newPassword,
    );
}

// --- sanitize ---------------------------------------------------------------

/** PURE. Normalize an untrusted patch: only well-typed, in-catalog fields survive. */
export function sanitizeDevServicePatch(
    patch: Partial<DevServiceConfig> | null | undefined,
): Partial<DevServiceConfig> {
    const out: Partial<DevServiceConfig> = {};
    if (!patch || typeof patch !== 'object') return out;

    if (isServiceEngine(patch.engine)) out.engine = patch.engine;

    if (out.engine && typeof patch.version === 'string') {
        // Refused rather than defaulted: a version becomes an image tag, and a
        // caller who named a version we do not know should hear so.
        const version = resolveEngineVersion(out.engine, patch.version);
        if (version === patch.version) out.version = version;
    }

    if (typeof patch.dedicated === 'boolean') out.dedicated = patch.dedicated;
    if (typeof patch.active === 'boolean') out.active = patch.active;
    // A caller-supplied image has no multi-tenant story — it cannot be shared.
    if (out.engine && engineSpecFor(out.engine).alwaysDedicated) out.dedicated = true;

    // image/port/env are the CUSTOM escape hatch only. A typed engine's image
    // comes from the catalog; letting a caller pin it would run an arbitrary
    // image under a name that says "postgres".
    if (out.engine === 'custom') {
        if (typeof patch.image === 'string') {
            const image = patch.image.trim();
            if (image && IMAGE_REF.test(image)) out.image = image;
        }
        if (typeof patch.port === 'number' && Number.isInteger(patch.port)) {
            if (patch.port >= 1 && patch.port <= 65535) out.port = patch.port;
        }
        if (patch.env && typeof patch.env === 'object' && !Array.isArray(patch.env)) {
            const env: Record<string, string> = {};
            for (const [name, value] of Object.entries(patch.env)) {
                if (!ENV_NAME.test(name) || typeof value !== 'string' || value.includes('\0')) {
                    continue;
                }
                env[name] = value;
            }
            out.env = env;
        }
    }

    if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;

    // The password is NOT settable from a patch — see the file header.
    return out;
}

/**
 * PURE. Parse a stored `dev_services` blob. Robust to NULL, corrupt JSON and
 * junk — an unreadable blob reads as `{}` (the safe default: nothing runs).
 */
export function parseDevServices(raw: string | null | undefined): DevServices {
    if (!raw) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const out: DevServices = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = value as Partial<DevServiceConfig> | null;
        if (!entry || typeof entry !== 'object') continue;
        const clean = sanitizeDevServicePatch(entry);
        // An engine or a version the catalog no longer knows would resolve to an
        // image we cannot name — the row is unusable, and showing it would offer
        // the user a service that can never start.
        if (!clean.engine || !clean.version) continue;
        // Reading OUR blob back, not accepting one from a caller: the password
        // survives the round trip even though a PATCH may not set it. Without
        // one the workspace could never connect, so the row is dropped.
        if (typeof entry.password !== 'string' || !entry.password) continue;
        if (clean.engine === 'custom' && (!clean.image || !clean.port)) continue;
        out[id] = {
            dedicated: false,
            enabled: false,
            ...clean,
            engine: clean.engine,
            version: clean.version,
            password: entry.password,
        } as DevServiceConfig;
    }
    return out;
}

// --- the ACTIVE version of an engine (#242 P3) -------------------------------

/**
 * PURE. Make one service the ACTIVE version of its engine, clearing the previous
 * one.
 *
 * Active is a property of the ENGINE, not of a row: a workspace can hold
 * postgres 16 and 17 (the key is (workspace, engine, VERSION)), but
 * `DATABASE_URL` / `DB_*` / `PG*` name ONE connection. Setting a new active
 * without clearing the old would leave two claimants and put the environment
 * back in the incoherent state this exists to remove — so the un-set is part of
 * the same operation rather than a second call a caller could forget.
 *
 * Other engines are untouched: the rule is one active PER ENGINE, so choosing a
 * Postgres never disturbs the workspace's Redis. Returns a new map; an unknown
 * id is returned unchanged rather than throwing.
 */
export function setActiveService(services: DevServices, serviceId: string): DevServices {
    const target = services[serviceId];
    if (!target) return services;
    const next: DevServices = {};
    for (const [id, config] of Object.entries(services)) {
        next[id] =
            config.engine === target.engine ? { ...config, active: id === serviceId } : config;
    }
    return next;
}

/**
 * The sentence shown BEFORE switching which version an engine's apps use, or
 * `null` when nothing would be lost.
 *
 * Each version keeps its OWN volume, so a switch does not carry the data — the
 * newly-active database is EMPTY. That is the same surprise {@link
 * DevServiceConfig.dedicated} carries, and the same reason it is said out loud:
 * discovering it after the switch means discovering it from an application that
 * suddenly has no rows.
 */
export function switchActiveWarning(
    current: DevServiceConfig | undefined,
    next: DevServiceConfig,
): string | null {
    if (!current || current.version === next.version) return null;
    const spec = engineSpecFor(next.engine);
    return (
        `${spec.label} ${next.version} keeps its own data, separate from ${spec.label} ` +
        `${current.version}. Switching points this workspace's apps at ${next.version}, which ` +
        `starts EMPTY — nothing is copied across, and nothing in ${current.version} is deleted ` +
        '(switching back brings it into view again).'
    );
}
