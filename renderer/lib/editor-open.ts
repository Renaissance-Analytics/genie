import { SYSTEM_WORKSPACE_ID, type TerminalSpec, type WorkspaceRow } from './genie';

/**
 * Reuse-vs-new arbitration + a tiny "open this file in THIS panel" bus for the
 * `openFileForUser` MCP tool. The MCP handler (main) resolves the workspace +
 * path and pushes `editor:open-file`; master.tsx decides whether an already-open
 * CodePanel can be REUSED (this module's pure `pickReusePanel`) or a new panel is
 * needed, then either signals the live panel via `emitOpenInPanel` or creates a
 * fresh seeded spec.
 */

/** A code panel's effective workspace id (system specs → `__system__`). */
function panelWorkspaceId(s: TerminalSpec): string | null {
    if (s.workspace_id) return s.workspace_id;
    if ((s.meta as { system?: boolean } | undefined)?.system) return SYSTEM_WORKSPACE_ID;
    return null;
}

/**
 * A code panel's effective ROOT directory — the folder its tabs are relative to.
 * A workspace-attached panel roots at the workspace path; a System / unattached
 * panel roots at its own `cwd` (which is exactly how `PanelFor` chooses the
 * CodePanel's `workspace` prop: attached → the row, else undefined → spec.cwd).
 */
function panelRoot(s: TerminalSpec, workspacesById: Map<string, WorkspaceRow>): string {
    if (s.workspace_id) return workspacesById.get(s.workspace_id)?.path ?? s.cwd;
    return s.cwd;
}

/**
 * Choose which OPEN editor panel to reuse for an open-file request, or null when
 * a new one should be created. A candidate is a `type:'code'` spec that is
 * currently SELECTED (mounted), resolves to `workspaceId`, and is rooted at
 * `root` (so its relative tabs address the same tree). The focused panel wins,
 * else the first match. Pure → unit-testable.
 */
export function pickReusePanel(
    specs: TerminalSpec[],
    target: { workspaceId: string; root: string },
    focusId: string | null,
    selected: ReadonlySet<string>,
    workspacesById: Map<string, WorkspaceRow>,
): string | null {
    const candidates = specs.filter(
        (s) =>
            s.type === 'code' &&
            selected.has(s.id) &&
            panelWorkspaceId(s) === target.workspaceId &&
            panelRoot(s, workspacesById) === target.root,
    );
    if (candidates.length === 0) return null;
    const focused = candidates.find((s) => s.id === focusId);
    return (focused ?? candidates[0]).id;
}

// --- "open this file in panel <id>" bus ------------------------------------
// A CodePanel seeds its tabs from spec.meta only on mount, so reusing a LIVE
// panel needs a side channel. Each mounted CodePanel subscribes by its spec id;
// master.tsx emits to the chosen panel after arbitration.

type OpenInPanelListener = (relPath: string, line?: number) => void;
const panelListeners = new Map<string, Set<OpenInPanelListener>>();

/** Subscribe a mounted CodePanel (by spec id) to open-file requests. Returns an
 *  unsubscribe. */
export function onOpenInPanel(specId: string, cb: OpenInPanelListener): () => void {
    let set = panelListeners.get(specId);
    if (!set) {
        set = new Set();
        panelListeners.set(specId, set);
    }
    set.add(cb);
    return () => {
        const s = panelListeners.get(specId);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) panelListeners.delete(specId);
    };
}

/** Tell the mounted CodePanel `specId` to open `relPath` as a tab + focus it. */
export function emitOpenInPanel(specId: string, relPath: string, line?: number): void {
    const set = panelListeners.get(specId);
    if (!set) return;
    for (const cb of set) cb(relPath, line);
}
