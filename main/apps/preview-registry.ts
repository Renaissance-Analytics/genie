/**
 * The previews that are open right now (Tynn #250).
 *
 * An installed GApp is a ROW: a grant in sqlite, a workspace, a site config, an
 * entry in the Apps list, a pill in the tray. A preview is deliberately none of
 * those. It exists in this map for exactly as long as its window is open, and the
 * requirement it serves is the owner's: *"no entry in the Apps list, no tray pill,
 * nothing to uninstall afterwards. Closing the window is the whole cleanup."*
 *
 * That is why it lives in memory rather than being a grant row with a flag on it.
 * A flagged row is one forgotten `WHERE` clause away from showing up in the Apps
 * list, in the tray, in the update check, in a backup — and each of those would be
 * a separate bug found by a separate user. A record that was never written cannot
 * leak into a list that reads the table.
 *
 * The cost is that the handful of places which must see a preview have to be named
 * explicitly, and they are: the bridge (so `me()` and `call()` answer), the MCP
 * caller resolver (so a granted `call()` reaches a workspace), the window's
 * `describe` (so the strip and the Agent tab know what they are showing), and
 * teardown. That list being short and stated is the point — a preview is visible
 * to the app RUNTIME and invisible to the app REGISTRY, and the boundary is here.
 */

import { grantableCapabilities } from './manage-core';
import { gappHomeUrl } from './hostname';
import type { InstalledAppView } from './manage';
import type { AppGrant } from './bridge-decision';
import type { AppManifest } from './manifest';
import type { PreviewIdentity } from './preview';

export interface LivePreview {
    identity: PreviewIdentity;
    /**
     * The manifest as the DEVELOPER wrote it.
     *
     * What `me()` reports and what the window's title says, because that is what
     * the app IS. A developer whose code branches on its own id must not silently
     * take a different branch because Genie renamed it for bookkeeping.
     */
    source: AppManifest;
    /**
     * The manifest the WINDOW was built from — `source` wearing the preview
     * identity. What the tab strip, the partition and the origin derive from.
     */
    manifest: AppManifest;
    /** The developer's folder. A preview shows live source, never a copy. */
    folder: string;
    /** The ephemeral workspace this preview's panels and site live in. */
    workspaceId: string;
    grant: AppGrant;
    /** The dev-site row serving it, so teardown can stop exactly this one. */
    siteId: string;
    /**
     * What did not come up, in words.
     *
     * Carried on the record rather than returned once, because the window has to
     * keep saying it. A preview whose site never started shows empty app tabs, and
     * an empty tab with no explanation is read as a bug in the app being built —
     * which is precisely the wrong lesson for a previewer to teach.
     */
    warnings: string[];
}

/** Keyed by PREVIEW app id (`<id>~preview`), never by the app's own. */
const previews = new Map<string, LivePreview>();
/** The reverse index, kept in step below so teardown never has to scan. */
const byWorkspace = new Map<string, string>();

export function rememberPreview(live: LivePreview): void {
    // Drop whatever this app was previewing before. Re-previewing a folder is the
    // ordinary case — it is what "reload" and "I changed the manifest" both look
    // like — and a second entry would leave the first one's workspace index
    // answering for a workspace that teardown has already removed.
    forgetPreview(live.identity.appId);
    previews.set(live.identity.appId, live);
    byWorkspace.set(live.workspaceId, live.identity.appId);
}

export function forgetPreview(appId: string): void {
    const live = previews.get(appId);
    if (!live) return;
    previews.delete(appId);
    byWorkspace.delete(live.workspaceId);
}

/** The preview with this app id, or null. Never answers for an installed app. */
export function livePreview(appId: string): LivePreview | null {
    return previews.get(appId) ?? null;
}

export function previewForWorkspace(workspaceId: string): LivePreview | null {
    const appId = byWorkspace.get(workspaceId);
    return appId ? (previews.get(appId) ?? null) : null;
}

export function listPreviews(): LivePreview[] {
    return [...previews.values()];
}

/**
 * A preview as the WINDOW needs to see itself.
 *
 * The same {@link InstalledAppView} an installed app's window gets, because the
 * window is the same window — `gapp.tsx` reads a name, a slug and a workspace id
 * and should not have to know which kind of app it is showing. Building a second
 * shape here would fork the one page this whole design keeps unforked.
 *
 * Two fields say the truth rather than the bookkeeping:
 *
 *   - `id` is the app's REAL id, not the `~preview` one. That is what the app IS,
 *     and a developer whose code branches on its own id must not silently take a
 *     different branch because Genie renamed it internally. The preview id keys
 *     the bridge, the partition and the caller — none of which the page sees.
 *   - `installPath` is the developer's folder, because that is where this app is
 *     actually running from.
 */
export function previewAppView(live: LivePreview): InstalledAppView {
    const declared = live.source.permissions.capabilities;
    return {
        id: live.source.id,
        name: live.source.name,
        // The PREVIEW slug: the strip shows the address, and showing the app's own
        // would tell the developer they are looking at something they are not.
        slug: live.manifest.slug,
        version: live.source.version,
        workspaceId: live.workspaceId,
        installPath: live.folder,
        scope: live.grant.scope,
        workspaces: live.grant.workspaces ?? [],
        revoked: false,
        // Dev tools ON, and the title says "development" — a preview is a place an
        // app is being built, and you have to be able to inspect it.
        devMode: true,
        homeUrl: gappHomeUrl(live.manifest.slug),
        permissions: grantableCapabilities(declared).map((c) => ({
            key: c.key,
            label: c.label,
            grantDescription: c.grantDescription,
            risk: c.risk,
            granted: live.grant.capabilities.includes(c.key),
        })),
        // A preview is not installed, so there is no install date to report. The
        // field is on the shape the window shares with an installed app; leaving
        // it empty says "never" more honestly than a timestamp for an event that
        // did not happen.
        installedAt: '',
    };
}

export interface GrantLookups {
    preview: (appId: string) => LivePreview | null;
    installed: (appId: string) => AppGrant | null;
}

/**
 * PURE. The grant a GApp acts under, whether it is installed or being previewed.
 *
 * Two callers need this and they used to convert a grant row themselves, side by
 * side: the bridge that answers `me()`/`call()`, and the MCP caller resolver that
 * decides which workspace an allowed call lands in. Two copies of "who is this
 * app?" is exactly the shape that goes wrong when a third kind of app appears —
 * which is what a preview is — so it is one function now, and previews became
 * visible to both in a single edit rather than in two that could disagree.
 *
 * Preview first. Where both could answer, the preview's grant is the narrower,
 * differently-named one pointed at the preview's own workspace; falling through to
 * the installed copy would let a throwaway window act with the authority of the
 * app the user actually trusts.
 */
export function resolveAppGrant(appId: string, lookups: GrantLookups): AppGrant | null {
    return lookups.preview(appId)?.grant ?? lookups.installed(appId) ?? null;
}
