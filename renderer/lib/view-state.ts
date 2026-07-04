import type { LayoutMode } from './terminal-grid-layout';

/**
 * CLIENT-LOCAL panel VIEW state — how THIS window/device lays out a workspace's
 * panels, kept separate from the panels' host-owned IDENTITY (`terminal_specs`).
 *
 * The owner split: WORK/CONTENT (terminals, files, processes, and a spec's
 * host-side `enabled` suspend/retain flag) is HOST-sourced; UI/LAYOUT/PER-DEVICE
 * prefs are CLIENT-LOCAL. Different devices (host screen, laptop, phone-driven
 * host window) need different layouts, so the host must NOT dictate which panels
 * a given window shows. This store is that per-device layer.
 *
 * It lives in the LOCAL `settings` table under `view_state_json` — deliberately
 * NOT one of the namespaces the remote bridge re-points at the host
 * (`renderer/lib/remote-bridge.ts`), so `api().settings` stays local even in a
 * host window. That's what lets a host window hide a panel WITHOUT writing the
 * host's `terminal_specs.enabled` (which used to be the only persisted hide, so
 * hiding here dictated the host's layout).
 *
 * Keyed by `${connKey}|${workspaceId}` so the local window (`connKey: 'local'`)
 * and each host window (`connKey: <host key>`) keep independent layouts of the
 * same workspace without colliding.
 */
export interface WorkspaceViewState {
    /** Spec ids visible as panels in this window for the workspace. */
    visibleIds: string[];
    /** Focused panel (null = none). */
    focusId: string | null;
    /** Maximized panel (null = none). */
    maximizedId: string | null;
    /** Grid layout mode for this workspace in this window. */
    layoutMode: LayoutMode;
}

/** The whole store: `${connKey}|${workspaceId}` → the window's view of it. */
export type ViewStateStore = Record<string, WorkspaceViewState>;

/** Compose the store key for a window (connKey) + workspace. */
export function viewStateKey(connKey: string, workspaceId: string): string {
    return `${connKey}|${workspaceId}`;
}

/** Parse the JSON-encoded `view_state_json` setting; malformed → empty store. */
export function parseViewStateStore(json: string | null | undefined): ViewStateStore {
    if (!json) return {};
    try {
        const parsed = JSON.parse(json) as unknown;
        if (!parsed || typeof parsed !== 'object') return {};
        return parsed as ViewStateStore;
    } catch {
        return {};
    }
}

/**
 * Read a window's saved view of a workspace. Returns null when nothing is saved
 * (FIRST RUN for this `(connKey, workspace)` — the caller seeds from the host's
 * `enabled` specs instead). Defensively normalises the shape so a hand-edited or
 * older blob can't crash a restore.
 */
export function readWorkspaceView(
    store: ViewStateStore,
    connKey: string,
    workspaceId: string,
): WorkspaceViewState | null {
    const v = store[viewStateKey(connKey, workspaceId)];
    if (!v || !Array.isArray(v.visibleIds)) return null;
    return {
        visibleIds: v.visibleIds.filter((id): id is string => typeof id === 'string'),
        focusId: typeof v.focusId === 'string' ? v.focusId : null,
        maximizedId: typeof v.maximizedId === 'string' ? v.maximizedId : null,
        layoutMode: (v.layoutMode ?? 'auto') as LayoutMode,
    };
}

/** Return a NEW store with the window's view of a workspace set (immutable). */
export function writeWorkspaceView(
    store: ViewStateStore,
    connKey: string,
    workspaceId: string,
    state: WorkspaceViewState,
): ViewStateStore {
    return { ...store, [viewStateKey(connKey, workspaceId)]: state };
}

/**
 * Overlay THIS window's `connKey` slice from a local cache onto a FRESHLY-READ
 * persisted store, returning the store to persist.
 *
 * `view_state_json` is a SINGLE blob spanning every window's connKey (the local
 * window's `local|*` plus each host window's `host:<id>|*`). Each window holds its
 * own in-memory cache seeded from the blob at mount, so writing that cache back
 * wholesale would revert a CONCURRENT window's edits to OTHER connKeys (a
 * last-writer-wins clobber — close a panel in a host window, then any view change
 * in the local window resurrects it). A window OWNS only its own `${connKey}|…`
 * entries, so before writing we re-read the authoritative store (`latest`) and copy
 * over ONLY our own slice; every other window's slice is preserved as-is. The `|`
 * delimiter makes the prefix test exact (`host:ab` never matches `host:abc|…`).
 */
export function overlayOwnConnKey(
    latest: ViewStateStore,
    cache: ViewStateStore,
    connKey: string,
): ViewStateStore {
    const prefix = `${connKey}|`;
    const out: ViewStateStore = { ...latest };
    for (const [key, value] of Object.entries(cache)) {
        if (key.startsWith(prefix)) out[key] = value;
    }
    return out;
}
