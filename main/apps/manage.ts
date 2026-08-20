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
 * an App workspace — but the workspace and its files STAY. Deleting a workspace is
 * a bigger, more destructive act than removing a permission grant, and the user
 * may well want what is in there; they can delete it like any other workspace, and
 * the Apps panel says so.
 */
export function appsUninstall(appId: string): AppActionResult {
    const row = getAppGrant(appId);
    if (!row) return { ok: false, error: 'That app is not installed.' };

    deleteAppGrant(appId);
    if (row.workspaceId) setWorkspaceAppKind(row.workspaceId, null);
    return { ok: true };
}
