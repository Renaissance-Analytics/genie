/**
 * WHAT THE FILE PANEL REMEMBERS, PER WORKSPACE (beta.33 item 15; Genie 1 kept these in the code view's meta: `word_wrap`,
 * `tree_pinned`, `locked` + `root`, `open_files`, `active_file`, `expanded_tree_ids`). A relaunch opens the panel as you left
 * it. Kept in the window's storage — a per-device choice, like the sidebar's collapsed state — and read defensively: a value
 * of the wrong shape is the default, never a throw.
 */

export interface PanelPrefs {
    readonly wordWrap: boolean;
    /** The tree column is hidden (its toggle brings it back). */
    readonly treeHidden: boolean;
    /** Pinned: the tree stays when a file opens; unpinned, it hides itself (Genie 1). */
    readonly treePinned: boolean;
    /** The folder the tree is rooted at (workspace-relative), or `null` = the whole workspace. */
    readonly lockedRoot: string | null;
    readonly tabs: readonly string[];
    readonly active: string | null;
    readonly expanded: readonly string[];
}

export const DEFAULT_PANEL_PREFS: PanelPrefs = { wordWrap: false, treeHidden: false, treePinned: true, lockedRoot: null, tabs: [], active: null, expanded: [] };

export interface PrefsStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const keyOf = (workspaceId: string) => `genie.files-panel.${workspaceId}`;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function readPanelPrefs(storage: PrefsStorage | null, workspaceId: string): PanelPrefs {
    if (!storage) return DEFAULT_PANEL_PREFS;
    let raw: unknown;
    try { raw = JSON.parse(storage.getItem(keyOf(workspaceId)) ?? 'null'); } catch { return DEFAULT_PANEL_PREFS; }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_PANEL_PREFS;
    const r = raw as Record<string, unknown>;
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
    return {
        wordWrap: bool(r.wordWrap, DEFAULT_PANEL_PREFS.wordWrap),
        treeHidden: bool(r.treeHidden, DEFAULT_PANEL_PREFS.treeHidden),
        treePinned: bool(r.treePinned, DEFAULT_PANEL_PREFS.treePinned),
        lockedRoot: typeof r.lockedRoot === 'string' && r.lockedRoot !== '' ? r.lockedRoot : null,
        tabs: strings(r.tabs),
        active: typeof r.active === 'string' ? r.active : null,
        expanded: strings(r.expanded),
    };
}

export function writePanelPrefs(storage: PrefsStorage | null, workspaceId: string, prefs: PanelPrefs): void {
    if (!storage) return;
    try { storage.setItem(keyOf(workspaceId), JSON.stringify(prefs)); } catch { /* storage full or refused: the panel works, it just forgets */ }
}
