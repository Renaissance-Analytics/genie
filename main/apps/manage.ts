/**
 * Genie App management, factored out of the IPC handlers (Tynn #250).
 *
 * Mirrors `plugins/manage.ts`: one implementation of list / permissions / revoke /
 * uninstall, free of Electron, so the Apps panel and any later remote-host route
 * share it rather than growing a second copy that rots.
 *
 * The install itself is NOT here — it needs a folder picker and an OS modal, so it
 * lives in `ipc.ts` with the Electron it requires, over the injected-I/O core in
 * `install.ts`.
 */

import {
    deleteAppGrant,
    getAppGrant,
    listAppGrants,
    setAppGrantCapabilities,
    setAppGrantRevoked,
    setWorkspaceAppKind,
    type AppGrantRow,
} from '../db';
import { validateAppManifest } from './manifest';
import { resolveAppRequirements, type AppRequirementPlan, type RequirementMachine } from './requirements';
import { toolchainMachineFacts } from './machine';
import { grantableCapabilities, narrowGrant } from './manage-core';
import type { CapabilityRisk } from './capabilities';

export interface AppPermissionView {
    key: string;
    label: string;
    grantDescription: string;
    risk: CapabilityRisk;
    granted: boolean;
}

export interface InstalledAppView {
    id: string;
    name: string;
    slug: string;
    version: string;
    workspaceId: string;
    installPath: string;
    scope: AppGrantRow['scope'];
    /** Named workspaces, when the scope is `workspaces`. */
    workspaces: string[];
    revoked: boolean;
    /** Running from a folder Genie does not control, with dev tools on. */
    devMode: boolean;
    /** `https://<slug>.gen/` — where its window opens. */
    homeUrl: string;
    permissions: AppPermissionView[];
    installedAt: string;
}

/** The capabilities a stored manifest DECLARED — the ceiling on any grant. */
function declaredFor(row: AppGrantRow): string[] {
    try {
        const parsed = validateAppManifest(JSON.parse(row.manifestJson));
        if (parsed.ok) return parsed.value.permissions.capabilities;
    } catch {
        // A manifest that no longer parses (hand-edited, or from a Genie whose
        // schema moved) declares NOTHING. Failing closed here means the app keeps
        // what it was granted but cannot be given more from the screen.
    }
    return [];
}

function toView(row: AppGrantRow): InstalledAppView {
    const declared = declaredFor(row);
    return {
        id: row.appId,
        name: row.name,
        slug: row.slug,
        version: row.version,
        workspaceId: row.workspaceId,
        installPath: row.installPath,
        scope: row.scope,
        workspaces: row.workspaces,
        revoked: row.revoked,
        devMode: row.devMode,
        homeUrl: `https://${row.slug}.gen/`,
        permissions: grantableCapabilities(declared).map((c) => ({
            key: c.key,
            label: c.label,
            grantDescription: c.grantDescription,
            risk: c.risk,
            granted: row.capabilities.includes(c.key),
        })),
        installedAt: row.installedAt,
    };
}


/**
 * What an installed app still needs from THIS machine.
 *
 * Derived from the stored manifest on every read, never a snapshot taken at
 * install: the machine changes. A user who installs Rust the day after should
 * stop being told to install Rust, and a stored "you must provide" list would go
 * on nagging them forever.
 *
 * `machine` is injectable so every branch is assertable; production passes the
 * real toolchain probe. An unreadable manifest yields NOTHING rather than an
 * error — that failure is already reported where it matters, and inventing
 * requirements out of a parse failure would put a scary, wrong list in front of
 * the user.
 */
export async function appRequirements(
    manifestJson: string,
    machine?: RequirementMachine,
): Promise<AppRequirementPlan> {
    let requires: Array<{ tool: string; version?: string; reason?: string }> = [];
    try {
        const parsed: unknown = JSON.parse(manifestJson);
        const raw =
            typeof parsed === 'object' && parsed !== null
                ? (parsed as { requires?: unknown }).requires
                : undefined;
        if (Array.isArray(raw)) {
            requires = raw.filter(
                (r): r is { tool: string } =>
                    typeof r === 'object' && r !== null && typeof (r as { tool?: unknown }).tool === 'string',
            );
        }
    } catch {
        /* nothing declared */
    }

    return resolveAppRequirements(
        requires,
        machine ?? (await toolchainMachineFacts(requires.map((r) => r.tool))),
    );
}

/** The live requirement plan for an installed app, or null when it is not one. */
export async function appsRequirements(appId: string): Promise<AppRequirementPlan | null> {
    const row = getAppGrant(appId);
    return row ? appRequirements(row.manifestJson) : null;
}

export function appsList(): InstalledAppView[] {
    return listAppGrants().map(toView);
}

export function appsGet(appId: string): InstalledAppView | null {
    const row = getAppGrant(appId);
    return row ? toView(row) : null;
}

export interface AppActionResult {
    ok: boolean;
    error?: string;
    app?: InstalledAppView;
}

/**
 * Change what an app is allowed to do.
 *
 * The requested set is narrowed to what the manifest declared before it is
 * stored — see `manage-core.ts` for why that guard is here and not only in the UI.
 */
export function appsSetCapabilities(appId: string, requested: string[]): AppActionResult {
    const row = getAppGrant(appId);
    if (!row) return { ok: false, error: 'That app is not installed.' };

    setAppGrantCapabilities(appId, narrowGrant(declaredFor(row), requested ?? []));
    return { ok: true, app: appsGet(appId) ?? undefined };
}

/**
 * Turn an app's permissions off (or back on) without uninstalling it.
 *
 * Revoking is immediate and total: the next call it makes fails closed. The
 * caller closes its windows — a revoked app whose window stayed up would keep
 * showing a live surface whose every action now fails, which reads as broken
 * rather than as revoked.
 */
export function appsSetRevoked(appId: string, revoked: boolean): AppActionResult {
    if (!getAppGrant(appId)) return { ok: false, error: 'That app is not installed.' };
    setAppGrantRevoked(appId, revoked);
    return { ok: true, app: appsGet(appId) ?? undefined };
}

/**
 * Uninstall: the app stops being an app.
 *
 * Its grant goes, so it can call nothing, and its workspace stops being marked as
 * an App workspace. Its stored browser data goes too, UNLESS the user chose to
 * keep it — in which case a reinstall from the same origin restores it. The
 * workspace and its files STAY either way. Deleting a workspace is
 * a bigger, more destructive act than removing a permission grant, and the user
 * may well want what is in there; they can delete it like any other workspace, and
 * the Apps panel says so.
 */
export interface UninstallEffects {
    clearStorage?: (appId: string) => Promise<void>;
    /** Remember that the data was KEPT, and which origin it belongs to. */
    retainData?: (appId: string, sourceOrigin: string) => void;
}

export async function appsUninstall(
    appId: string,
    keepData: boolean,
    effects: UninstallEffects = {},
): Promise<AppActionResult> {
    const row = getAppGrant(appId);
    if (!row) return { ok: false, error: 'That app is not installed.' };

    if (keepData && row.source?.origin) {
        // Kept FOR THIS ORIGIN. A reinstall from the same place picks up where it
        // left off; anything else arriving under this app id gets a clean slate,
        // because it is not the same app — it merely claims the same name.
        effects.retainData?.(appId, row.source.origin);
    } else {
        // Deleting is best effort, and deliberately NOT the guarantee: a partition
        // can be held open by a window that is still closing, and an uninstall that
        // refused for that reason would strand an app the user asked to be rid of.
        // The guarantee is at INSTALL, where it cannot be skipped.
        //
        // An app with no recorded origin cannot have its data kept either, however
        // the user answered: there would be nothing to match a reinstall against,
        // and data nobody can vouch for is data nobody should inherit.
        try {
            await effects.clearStorage?.(appId);
        } catch {
            /* the install-side clear covers this */
        }
    }

    deleteAppGrant(appId);
    if (row.workspaceId) setWorkspaceAppKind(row.workspaceId, null);
    return { ok: true };
}
