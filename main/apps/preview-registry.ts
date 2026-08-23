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
