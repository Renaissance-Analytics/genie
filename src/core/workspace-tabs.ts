import { formatRoute, parseRoute, type WorkspaceView } from './route.js';
/**
 * WORKSPACE TABS YOU DESIGN (Tynn story #282). The owner, 2026-10-17: "By default we will have the Agents and Settings
 * tab, but in between those tabs is a small tab with a plus sign. Clicking this will create a new tab (this plus tab is
 * always to the left of Settings so settings is always the last tab). New tabs open to a panel designer that lets me
 * choose my grid layout and add panels to the grid. … Panels can be any kind of content from terminals, file browser,
 * genie site, artboards, and dashboard widgets. Genie Workspaces are not just dev environments for building apps, they
 * are for building out any kind of agentic apps and workflows."
 *
 * THE MODEL, pure: the tabs a workspace has, in order; each tab's grid; what sits in each cell; how it is kept (a
 * per-workspace setting, `workspace_tabs`). Agents and Settings are not stored — they are always there, first and last.
 */

export type PanelKind = 'terminal' | 'files' | 'site' | 'artboard' | 'widget';

/** What a cell shows. `ref` names WHICH one — a terminal id, a folder, a site's host, a widget — or `null` = to choose. */
export interface Panel {
    readonly kind: PanelKind;
    readonly ref: string | null;
}

export type LayoutId = 'single' | 'columns-2' | 'columns-3' | 'rows-2' | 'grid-2x2' | 'main-side' | 'main-stack';

export interface WorkspaceTab {
    readonly id: string;
    readonly name: string;
    readonly layout: LayoutId;
    /** One entry per cell of the layout, in reading order; `null` = an empty cell, offering "Add panel". */
    readonly cells: readonly (Panel | null)[];
}

export interface TabsState {
    readonly tabs: readonly WorkspaceTab[];
}

/** The order the designer offers them in; `columns`/`rows`/`areas` are CSS grid templates for the renderer. */
export const LAYOUTS: readonly { readonly id: LayoutId; readonly label: string; readonly cells: number; readonly columns: string; readonly rows: string; readonly areas?: string }[] = [
    { id: 'single', label: 'One panel', cells: 1, columns: '1fr', rows: '1fr' },
    { id: 'columns-2', label: 'Two columns', cells: 2, columns: '1fr 1fr', rows: '1fr' },
    { id: 'columns-3', label: 'Three columns', cells: 3, columns: '1fr 1fr 1fr', rows: '1fr' },
    { id: 'rows-2', label: 'Two rows', cells: 2, columns: '1fr', rows: '1fr 1fr' },
    { id: 'grid-2x2', label: '2 × 2 grid', cells: 4, columns: '1fr 1fr', rows: '1fr 1fr' },
    { id: 'main-side', label: 'Main and side', cells: 2, columns: '2fr 1fr', rows: '1fr' },
    { id: 'main-stack', label: 'Main and two stacked', cells: 3, columns: '2fr 1fr', rows: '1fr 1fr', areas: '"a b" "a c"' },
];

export const PANEL_KINDS: readonly PanelKind[] = ['terminal', 'files', 'site', 'artboard', 'widget'];

const layoutOf = (id: string) => LAYOUTS.find((l) => l.id === id);
const isKind = (k: unknown): k is PanelKind => typeof k === 'string' && (PANEL_KINDS as readonly string[]).includes(k);

export type StripItem =
    /** The workspace dashboard (the owner, 2026-10-19; q_09d1f4a0) — the `home` view. */
    | { readonly kind: 'dashboard' }
    /** An agent you opened in this workspace (Tynn #805): its page is drawn under this strip. */
    | { readonly kind: 'agent'; readonly id: string; readonly name: string }
    | { readonly kind: 'designed'; readonly id: string; readonly name: string }
    /** IssueWatch's view (Tynn #806), for a workspace linked to a Tynn project. */
    | { readonly kind: 'github' }
    /** The workspace's files, a tab of their own (beta.35 #41): the tree and the editor take the whole tab. */
    | { readonly kind: 'files' }
    | { readonly kind: 'add' }
    | { readonly kind: 'settings' };

/**
 * Dashboard, the agents you opened (Tynn #805 — agents open INSIDE their workspace, as in Genie 1), the designed tabs in
 * the order made, +, Settings — + always just before Settings, Settings always last.
 */
export function tabStrip(state: TabsState, openAgents: ReadonlyArray<{ id: string; name: string }> = [], extra: { github?: boolean } = {}): StripItem[] {
    return [
        { kind: 'dashboard' },
        // FILES, ITS OWN TAB (the owner, 2026-10-21: the panel docked beside the dashboard was "garbage"): always there.
        { kind: 'files' },
        ...openAgents.map((a) => ({ kind: 'agent' as const, id: a.id, name: a.name })),
        ...state.tabs.map((t) => ({ kind: 'designed' as const, id: t.id, name: t.name })),
        // IssueWatch's view (Tynn #806): only for a workspace linked to a Tynn project — the others have nothing to show.
        ...(extra.github ? [{ kind: 'github' as const }] : []),
        { kind: 'add' },
        { kind: 'settings' },
    ];
}

/** The route of one of a workspace's views (`home`, `settings`, `tab:<id>`), built by the router (Tynn #805). */
export function workspaceViewRoute(workspaceId: string, view: string): string {
    const base = parseRoute(`genie://workspace/${encodeURIComponent(workspaceId)}`);
    return base.surface === 'workspace' ? formatRoute({ ...base, view: view as WorkspaceView }) : `genie://workspace/${encodeURIComponent(workspaceId)}`;
}

/**
 * A workspace's agent tabs: EVERY agent of the workspace, in roster order, running or not (the owner, 2026-10-20: "I
 * have no fucking way to select different agents now"). The strip is an agent's door — the Dashboard shows only the
 * running ones — so a tab per agent you happened to open left a stopped agent unreachable, and after an upgrade, all.
 */
export function agentTabsOf<A extends { id: string; name: string; workspaceId: string; state: string }>(roster: readonly A[], workspaceId: string): Array<{ id: string; name: string; state: string }> {
    return roster.filter((a) => a.workspaceId === workspaceId).map((a) => ({ id: a.id, name: a.name, state: a.state }));
}

function freshId(state: TabsState): string {
    let n = state.tabs.length + 1;
    const taken = new Set(state.tabs.map((t) => t.id));
    while (taken.has(`tab-${n}`)) n += 1;
    return `tab-${n}`;
}

/** A new tab: the name given, else "Tab N"; one empty cell — it opens to the designer. */
export function addTab(state: TabsState, name?: string): { state: TabsState; id: string } {
    const id = freshId(state);
    const label = name && name.trim() !== '' ? name.trim() : `Tab ${state.tabs.length + 1}`;
    return { state: { tabs: [...state.tabs, { id, name: label, layout: 'single', cells: [null] }] }, id };
}

function update(state: TabsState, id: string, change: (t: WorkspaceTab) => WorkspaceTab | null): TabsState {
    const at = state.tabs.findIndex((t) => t.id === id);
    if (at < 0) return state;
    const next = change(state.tabs[at]!);
    if (next === state.tabs[at]) return state;
    return { tabs: next === null ? state.tabs.filter((_, i) => i !== at) : state.tabs.map((t, i) => (i === at ? next : t)) };
}

/** A blank name is refused (the tab keeps its own). */
export function renameTab(state: TabsState, id: string, name: string): TabsState {
    const trimmed = name.trim();
    return trimmed === '' ? state : update(state, id, (t) => ({ ...t, name: trimmed }));
}

export function removeTab(state: TabsState, id: string): TabsState {
    return update(state, id, () => null);
}

/**
 * Another grid: the panels keep their order; a smaller grid HANDS BACK the panels that no longer fit (`dropped`), so the
 * designer can say so — nothing is lost silently.
 */
export function setLayout(state: TabsState, id: string, layout: LayoutId): { state: TabsState; dropped: Panel[] } {
    const def = layoutOf(layout);
    if (!def) return { state, dropped: [] };
    let dropped: Panel[] = [];
    const next = update(state, id, (t) => {
        const cells = Array.from({ length: def.cells }, (_, i) => t.cells[i] ?? null);
        dropped = t.cells.slice(def.cells).filter((c): c is Panel => c !== null);
        return { ...t, layout, cells };
    });
    return { state: next, dropped };
}

/** A panel into a cell; out of range, or a kind Genie does not have, is refused. */
export function placePanel(state: TabsState, id: string, cell: number, panel: Panel): TabsState {
    if (!isKind(panel.kind)) return state;
    return update(state, id, (t) => (cell < 0 || cell >= t.cells.length ? t : { ...t, cells: t.cells.map((c, i) => (i === cell ? { kind: panel.kind, ref: panel.ref } : c)) }));
}

export function clearCell(state: TabsState, id: string, cell: number): TabsState {
    return update(state, id, (t) => (cell < 0 || cell >= t.cells.length ? t : { ...t, cells: t.cells.map((c, i) => (i === cell ? null : c)) }));
}

export function serializeTabs(state: TabsState): string {
    return JSON.stringify({ tabs: state.tabs });
}

/**
 * Read forgivingly: the value is a setting a person (or a newer Genie) may have written. A malformed value is no tabs; a
 * malformed TAB is dropped and the rest kept; a malformed cell is emptied — never a thrown error on the path that draws
 * the Workspace view.
 */
export function parseTabs(raw: string): TabsState {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return { tabs: [] }; }
    const tabs = typeof value === 'object' && value !== null ? (value as { tabs?: unknown }).tabs : undefined;
    if (!Array.isArray(tabs)) return { tabs: [] };
    const out: WorkspaceTab[] = [];
    for (const t of tabs) {
        if (typeof t !== 'object' || t === null) continue;
        const r = t as Record<string, unknown>;
        const def = typeof r['layout'] === 'string' ? layoutOf(r['layout']) : undefined;
        if (typeof r['id'] !== 'string' || r['id'] === '' || typeof r['name'] !== 'string' || r['name'].trim() === '' || !def) continue;
        const cellsRaw = Array.isArray(r['cells']) ? r['cells'] : [];
        const cells = Array.from({ length: def.cells }, (_, i): Panel | null => {
            const c = cellsRaw[i] as Record<string, unknown> | null | undefined;
            if (typeof c !== 'object' || c === null || !isKind(c['kind'])) return null;
            return { kind: c['kind'], ref: typeof c['ref'] === 'string' ? c['ref'] : null };
        });
        out.push({ id: r['id'], name: r['name'], layout: def.id, cells });
    }
    return { tabs: out };
}
