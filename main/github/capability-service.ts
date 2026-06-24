import { BrowserWindow, ipcMain } from 'electron';
import { readInstallationGrants } from './api';
import { getToken } from './storage';
import { genieAppPermissionsUrl, genieInstallationReviewUrl } from '../config';
import {
    aggregatePermissions,
    buildFeatureManager,
    computeCapabilityStatus,
    CAPABILITY_KEYS,
    type CapabilityKey,
    type CapabilityStatus,
    type GhAccess,
    type GhPermission,
    type InstallationGrant,
} from './capabilities';

/**
 * GitHub capability SERVICE — the stateful main-side owner of "what can Genie
 * do with the GitHub token it has". It wraps the pure detection in
 * `capabilities.ts` with:
 *   - a cached current status (recomputed on connect/reconnect + at boot),
 *   - a fancy-features manager whose gate reads that cache live,
 *   - IPC the renderer consults (status + per-feature `canAccess`),
 *   - a broadcast so a boot/recheck pushes the status to every window.
 *
 * The token + installations live in main (never the renderer), so detection
 * MUST happen here; the renderer only renders the modal/warning/gated UI from
 * what this service reports.
 */

/**
 * One installation that's missing a permission, PLUS the deep-link to ITS own
 * review page. The renderer just renders the link — the URL (incl. the org vs
 * personal variant) is built here in main.
 */
export interface MissingInstallation {
    login: string;
    /** The installation id (keys the review URL); null when GitHub omitted it. */
    installationId: number | null;
    isOrg: boolean;
    /** Deep-link to this installation's permission-review page on GitHub. */
    reviewUrl: string;
}

/**
 * Per missing permission, the installations not granting it (each with its own
 * review link). The renderer-facing analogue of `MissingPermissionInstalls`
 * with URLs attached.
 */
export interface MissingPermissionGroup {
    permission: GhPermission;
    access: GhAccess;
    installations: MissingInstallation[];
}

/** The renderer-facing capability status (mirrors the IPC payload shape). */
export interface GithubCapabilities {
    /** Whether a GitHub token is present at all. When false the gate is inert
     *  (features fall back to their normal not-connected handling). */
    connected: boolean;
    /** Capability keys whose required permission is satisfied. */
    satisfiedFeatures: CapabilityKey[];
    /** Capability keys whose required permission is missing → gated OFF. */
    missing: CapabilityKey[];
    /** Distinct missing GitHub permission names (the resolve set). */
    missingPermissions: GhPermission[];
    /**
     * Per missing permission, the installations that don't grant it (each with
     * a deep-link to ITS review page) — so the resolve flow can list the EXACT
     * installs the user must approve (GitHub has no bulk-approve). Empty while
     * disconnected / before the first check.
     */
    missingByPermission: MissingPermissionGroup[];
    /**
     * Deep-link to the App's permission-settings page, where the App OWNER adds
     * a missing permission (the real first step before any install can approve
     * it). Always present so the resolve flow can render the button.
     */
    appPermissionsUrl: string;
    /** True once a detection pass has completed at least once this session. */
    checked: boolean;
}

/** The current satisfied set — the single source the fancy-features gate reads. */
let satisfied = new Set<CapabilityKey>();
let lastStatus: CapabilityStatus = {
    satisfied: [],
    missing: [],
    missingPermissions: [],
    missingByPermission: [],
};
let connected = false;
let checked = false;

// The gate reads `satisfied` lazily on every canAccess(), so recomputing the
// set after a reconnect updates gating with no manager rebuild.
const features = buildFeatureManager(() => satisfied);

/** The current capability snapshot for the renderer. */
export function getCapabilities(): GithubCapabilities {
    return {
        connected,
        satisfiedFeatures: lastStatus.satisfied,
        missing: lastStatus.missing,
        missingPermissions: lastStatus.missingPermissions,
        // Attach a per-install review deep-link (org vs personal variant) — the
        // renderer just renders it.
        missingByPermission: lastStatus.missingByPermission.map((g) => ({
            permission: g.permission,
            access: g.access,
            installations: g.installations.map((inst) => ({
                login: inst.login,
                installationId: inst.installationId,
                isOrg: inst.isOrg,
                reviewUrl: genieInstallationReviewUrl(
                    inst.installationId,
                    inst.isOrg ? inst.login : null,
                ),
            })),
        })),
        appPermissionsUrl: genieAppPermissionsUrl(),
        checked,
    };
}

/**
 * Re-detect capabilities from the live token's installation permissions and
 * update the cache + gate. Safe to call on boot, on connect, and on a
 * post-reconnect recheck.
 *
 *   - No token  → connected:false, EVERY capability treated as satisfied so
 *     the proactive gate stays out of the way (the not-connected path already
 *     handles the UX). We don't want to show "missing permission" warnings to
 *     a user who simply hasn't connected GitHub yet.
 *   - Token present → read each installation's granted permissions, aggregate,
 *     compute satisfied/missing, swap the gate's set.
 *
 * Never throws — a failed read leaves the previous snapshot intact (and logs),
 * so a transient network blip doesn't flip every gated feature off.
 */
export async function recheckCapabilities(): Promise<GithubCapabilities> {
    if (!getToken()) {
        connected = false;
        checked = true;
        // Treat all as satisfied while disconnected (gate inert).
        satisfied = new Set(CAPABILITY_KEYS);
        lastStatus = {
            satisfied: [...CAPABILITY_KEYS],
            missing: [],
            missingPermissions: [],
            missingByPermission: [],
        };
        return getCapabilities();
    }
    try {
        const installations: InstallationGrant[] = await readInstallationGrants();
        const granted = aggregatePermissions(
            installations.map((i) => i.permissions),
        );
        // Pass the installs (identity + own permission map) so the status also
        // carries which SPECIFIC installs are missing each permission.
        const status = computeCapabilityStatus(granted, installations);
        connected = true;
        checked = true;
        lastStatus = status;
        satisfied = new Set(status.satisfied);
    } catch (e) {
        // Keep the prior snapshot; just mark connected so the UI doesn't claim
        // "disconnected" on a transient read failure.
        connected = true;
        checked = true;
        // eslint-disable-next-line no-console
        console.warn(
            `[github] capability recheck failed: ${(e as Error).message}`,
        );
    }
    return getCapabilities();
}

/** Whether the renderer (via IPC) may use a given capability right now. */
export async function canAccessCapability(key: string): Promise<boolean> {
    // While disconnected the gate is inert (all satisfied) — canAccess returns
    // true and the feature's own not-connected handling takes over.
    return features.canAccess(key);
}

/** Push the current capability status to every open window. */
export function broadcastCapabilities(): void {
    const payload = getCapabilities();
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
            // Distinct from the `github:capabilities` invoke channel (status
            // read) — this is the push event the renderer subscribes to.
            win.webContents.send('github:capabilities-changed', payload);
        }
    }
}

/**
 * Run the boot-time capability check: re-detect, then broadcast so a freshly
 * launched renderer can raise the boot modal / header warning if anything
 * required is missing. Best-effort — swallows its own errors via
 * recheckCapabilities.
 */
export async function runBootCapabilityCheck(): Promise<void> {
    await recheckCapabilities();
    broadcastCapabilities();
}

let registered = false;

/** Register the capability IPC. Idempotent. */
export function registerCapabilityIpc(): void {
    if (registered) return;
    registered = true;

    // Current status (renderer reads on mount + on the
    // github:capabilities-changed push event).
    ipcMain.handle('github:capabilities', async (): Promise<GithubCapabilities> => {
        // If a check hasn't run yet (e.g. the renderer asks before the boot
        // check fired), run one now so the first read is accurate.
        if (!checked) await recheckCapabilities();
        return getCapabilities();
    });

    // Per-feature gate check (mirrors fancy-features canAccess across IPC).
    ipcMain.handle(
        'github:can-access',
        async (_e, key: string): Promise<boolean> => canAccessCapability(key),
    );

    // Force a re-detection (after the user reconnects / approves a permission
    // update on GitHub). Returns the fresh status AND broadcasts it so every
    // window's warning icon / modal clears together.
    ipcMain.handle('github:recheck-capabilities', async (): Promise<GithubCapabilities> => {
        const out = await recheckCapabilities();
        broadcastCapabilities();
        return out;
    });
}
