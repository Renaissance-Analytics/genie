import { createFeatures, type FeatureManager } from '@particle-academy/fancy-features';

/**
 * GitHub capability gating — which Genie features need which GitHub App
 * permission, what the installed App actually grants, and the
 * `@particle-academy/fancy-features` engine that turns the two into a
 * proactive "this feature is unavailable" gate.
 *
 * WHY a gate (not just per-call error surfacing): Issue Watch already explains
 * a per-call 403/404 AFTER it polls (see `WatchFetchError` in api.ts). This
 * module is the PROACTIVE half — at boot we read each installation's GRANTED
 * permissions, compute the set of capabilities whose required permission is
 * missing, and gate those features OFF so the UI can disable + explain them
 * instead of polling into a guaranteed failure.
 *
 * Genie authenticates as a GitHub App ("Genie IDE"). A GitHub App's
 * permissions are declared ON THE APP and only take effect where the App is
 * INSTALLED; a user token can't widen them. So the resolution is:
 *   App's declared permissions  →  granted per installation  →  we aggregate.
 * When the App's declared set grows (e.g. `contents` is added), the
 * installation owner must APPROVE the pending permission update on GitHub;
 * a reconnect (or refresh) then picks up the wider grant. That's the resolve
 * flow the renderer drives.
 */

/**
 * A GitHub App permission name as it appears in the `permissions` map GitHub
 * returns per installation (`GET /user/installations`). Only the ones Genie
 * actually depends on are listed; the value is the access level
 * (`read` | `write` | `admin`).
 */
export type GhPermission =
    | 'metadata'
    | 'issues'
    | 'pull_requests'
    | 'vulnerability_alerts'
    | 'contents'
    | 'administration';

/** The access level a permission can be granted at, lowest → highest. */
export type GhAccess = 'read' | 'write' | 'admin';

/** Numeric rank so `granted >= required` is a simple comparison. */
const ACCESS_RANK: Record<GhAccess, number> = { read: 1, write: 2, admin: 3 };

/** A GitHub-dependent Genie capability, keyed for fancy-features. */
export type CapabilityKey =
    | 'issue-watch.issues'
    | 'issue-watch.pulls'
    | 'issue-watch.dependabot'
    | 'github.provision';

/** What ONE capability needs from the GitHub App to function. */
export interface RequiredPermission {
    permission: GhPermission;
    /** Minimum access level the permission must be granted at. */
    access: GhAccess;
}

/**
 * The required-permission map: each GitHub-dependent capability → the App
 * permission (+ minimum access) it needs. Derived from the App-token API
 * calls Genie makes (grep `gh(` in api.ts + its callers):
 *
 *   - Issue Watch issues read  → GET …/issues            → `issues:read`
 *   - Issue Watch PRs read     → GET …/pulls             → `pull_requests:read`
 *   - Issue Watch Dependabot   → GET …/dependabot/alerts → `vulnerability_alerts:read`
 *   - Provisioning / clone / fork / create → push to repos, read repo contents
 *     → `contents:write` (the genie-ide App historically does NOT declare
 *       `contents`, so this is the live "missing" candidate — but we COMPUTE
 *       it from the granted set rather than hardcoding the conclusion).
 *
 * `metadata:read` is the GitHub App baseline (always granted) and isn't gated.
 */
export const REQUIRED: Record<CapabilityKey, RequiredPermission> = {
    'issue-watch.issues': { permission: 'issues', access: 'read' },
    'issue-watch.pulls': { permission: 'pull_requests', access: 'read' },
    'issue-watch.dependabot': { permission: 'vulnerability_alerts', access: 'read' },
    'github.provision': { permission: 'contents', access: 'write' },
};

/** Every capability key in the map (stable order for UI lists). */
export const CAPABILITY_KEYS = Object.keys(REQUIRED) as CapabilityKey[];

/**
 * The aggregate of granted permissions across every installation. A permission
 * is considered granted at the HIGHEST access level any installation grants it
 * — Genie can act through whichever installation has the access, so the
 * capability is available if ANY installation satisfies it.
 *
 * (Map of permission name → granted access level. Absent = not granted.)
 */
export type GrantedPermissions = Partial<Record<GhPermission, GhAccess>>;

/** The raw `permissions` map GitHub returns per installation. */
export type InstallationPermissions = Record<string, string>;

/**
 * Fold each installation's `permissions` map into a single aggregate, keeping
 * the highest access level seen for each permission. Unknown permission names
 * (ones Genie doesn't model) are ignored. Unknown access strings are skipped
 * rather than guessed.
 */
export function aggregatePermissions(
    perInstallation: InstallationPermissions[],
): GrantedPermissions {
    const out: GrantedPermissions = {};
    for (const perms of perInstallation) {
        for (const [name, level] of Object.entries(perms ?? {})) {
            if (!isModelledPermission(name)) continue;
            if (!isAccess(level)) continue;
            const prev = out[name];
            if (!prev || ACCESS_RANK[level] > ACCESS_RANK[prev]) {
                out[name] = level;
            }
        }
    }
    return out;
}

function isModelledPermission(name: string): name is GhPermission {
    return (
        name === 'metadata' ||
        name === 'issues' ||
        name === 'pull_requests' ||
        name === 'vulnerability_alerts' ||
        name === 'contents' ||
        name === 'administration'
    );
}

function isAccess(level: string): level is GhAccess {
    return level === 'read' || level === 'write' || level === 'admin';
}

/** True when `granted` covers `req` (present AND at sufficient access level). */
export function satisfies(
    granted: GrantedPermissions,
    req: RequiredPermission,
): boolean {
    const have = granted[req.permission];
    if (!have) return false;
    return ACCESS_RANK[have] >= ACCESS_RANK[req.access];
}

/**
 * The computed capability status against a granted-permission aggregate:
 * which capabilities are satisfied, which are missing, and the distinct set of
 * GitHub permissions that are missing (what the user must have the App granted
 * to resolve everything).
 */
export interface CapabilityStatus {
    /** Capability keys whose required permission IS granted. */
    satisfied: CapabilityKey[];
    /** Capability keys whose required permission is NOT granted. */
    missing: CapabilityKey[];
    /** Distinct missing permission names (e.g. `['contents']`) — the resolve set. */
    missingPermissions: GhPermission[];
}

/**
 * Compute which capabilities the granted permissions satisfy. Pure — feed it
 * the aggregate from {@link aggregatePermissions}. This is the heart of the
 * detection: it turns "what the App granted" into "what Genie can/can't do".
 */
export function computeCapabilityStatus(
    granted: GrantedPermissions,
): CapabilityStatus {
    const satisfied: CapabilityKey[] = [];
    const missing: CapabilityKey[] = [];
    const missingPerms = new Set<GhPermission>();
    for (const key of CAPABILITY_KEYS) {
        const req = REQUIRED[key];
        if (satisfies(granted, req)) {
            satisfied.push(key);
        } else {
            missing.push(key);
            missingPerms.add(req.permission);
        }
    }
    return {
        satisfied,
        missing,
        missingPermissions: [...missingPerms],
    };
}

/**
 * Build a fancy-features manager whose pre-strategy DENIES a GitHub-dependent
 * capability when its required permission isn't in the satisfied set. The
 * pre-strategy is authoritative (first non-null wins): it returns `false` to
 * gate a feature OFF, or `null` to defer (for non-GitHub features, or
 * capabilities whose permission IS satisfied).
 *
 * `getSatisfied()` is read lazily on every `canAccess()` so re-detecting after
 * a reconnect updates the gate WITHOUT rebuilding the manager — the renderer's
 * `canAccess` checks immediately reflect the new grant.
 */
export function buildFeatureManager(
    getSatisfied: () => ReadonlySet<CapabilityKey>,
): FeatureManager {
    const features = createFeatures({
        // Declare each GitHub-dependent capability as a boolean feature. They
        // default enabled; the pre-strategy is what gates them on missing
        // permissions, so a feature with no entry in REQUIRED stays on.
        features: Object.fromEntries(
            CAPABILITY_KEYS.map((key) => [
                key,
                { type: 'boolean' as const, enabled: true },
            ]),
        ),
    });
    features.registerPreStrategy('github-capability', (feature) => {
        const req = REQUIRED[feature as CapabilityKey];
        // Not a GitHub-gated capability → defer to normal resolution.
        if (!req) return null;
        // Required permission satisfied → allow (defer, so it resolves enabled);
        // missing → DENY authoritatively.
        return getSatisfied().has(feature as CapabilityKey) ? null : false;
    });
    return features;
}
