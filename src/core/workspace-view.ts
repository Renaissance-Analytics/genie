/**
 * THE WORKSPACE SURFACE'S STATE — terminals for one workspace, as the renderer holds them.
 *
 * Pure. The renderer feeds it bridge events (`opened`, `data`, `exit`) and user actions
 * (`activate`, `closed`); the component renders whatever comes out. Nothing here knows about
 * React, IPC or xterm, which is what makes it testable without a window and what keeps the
 * component thin.
 *
 * §4.6: terminals, editors and panels for one workspace — for shells, builds, services and
 * hosted sites only. **No agent has one.** There is no agent id anywhere in this file.
 */

export interface TerminalTab {
    id: string;
    workspaceId: string;
    shell: string;
    pid: number;
    /** `null` while running. A code once the shell has ended — kept on screen, not vanished. */
    exited: number | null;
    /** Output is held back while suspended; the bytes that arrived meanwhile are COUNTED, not lost silently. */
    suspended?: boolean;
    droppedWhileSuspended?: number;
}

/** A CODE PANE (§4.6 `+code`): one file open in the grid beside the shells. The id is the path under a prefix: one pane per file. */
export interface CodeTab {
    id: string;
    path: string;
}

export const CODE_PANE_PREFIX = 'code:';

/** A PLUGIN PANE (§4.6 `+plugin`): a plugin's panel in the grid — one vetted Fancy component, no plugin code. */
export interface PluginTab {
    id: string;
    pluginId: string;
    panelId: string;
}

export const PLUGIN_PANE_PREFIX = 'plugin:';

export interface WorkspaceState {
    terminals: readonly TerminalTab[];
    /** Code panes (§4.6), after the terminals in the strip. Absent on an older state = none. */
    codes?: readonly CodeTab[];
    /** Plugin panes (§4.6), after the code panes. Absent on an older state = none. */
    plugins?: readonly PluginTab[];
    /** The terminal shown. `null` when there are none. */
    active: string | null;
    /** Output per terminal, as one growing string — the shape `fancy-term`'s `output` prop wants. */
    output: Readonly<Record<string, string>>;
    /** Hidden terminals (§6.5): still running, off the strip, shown again on request. */
    hidden?: readonly TerminalTab[];
    /** A RUNNING terminal whose close is waiting on the person's confirm (Tynn #763); absent/`null` = none. */
    closing?: string | null;
}

/** What separates a restored snapshot from live output (§6.5): old above, live below, never confused. */
export const PREVIOUS_SESSION_DIVIDER = '\r\n\x1b[2m— previous session —\x1b[0m\r\n';

/**
 * How much output to keep per terminal, in characters.
 *
 * A build that logs for an hour would otherwise grow the renderer's memory without bound, and
 * `fancy-term` diffs `output` against its previous value on every change — a string that only
 * ever grows makes that diff grow with it. Trimmed from the FRONT, so the newest output is
 * always present; xterm's own scrollback is the one the user scrolls, and it has its own cap.
 */
export const OUTPUT_CAP = 2_000_000;

export function emptyWorkspace(): WorkspaceState {
    return { terminals: [], active: null, output: {}, hidden: [], codes: [], plugins: [] };
}

/** A terminal the engine just opened. It becomes the active one — the user asked for it. */
export function terminalOpened(
    state: WorkspaceState,
    tab: TerminalTab,
    scrollback: string,
    options: { restored?: boolean } = {},
): WorkspaceState {
    // A snapshot restored from disk opens ABOVE the divider; a live reattach's scrollback is live.
    const seeded = options.restored && scrollback.length > 0 ? scrollback + PREVIOUS_SESSION_DIVIDER : scrollback;
    return {
        ...state,
        terminals: [...state.terminals, tab],
        active: tab.id,
        output: { ...state.output, [tab.id]: seeded },
    };
}

/**
 * Output arrived. Appended, capped from the front.
 *
 * An unknown id is IGNORED, not created: data for a terminal this workspace does not hold
 * belongs to another workspace's panel, and conjuring a tab for it would show a terminal
 * nobody opened here.
 */
export function terminalData(state: WorkspaceState, id: string, data: string): WorkspaceState {
    const tab = state.terminals.find((t) => t.id === id) ?? (state.hidden ?? []).find((t) => t.id === id);
    if (!tab) return state;
    if (tab.suspended) {
        // Held back, and COUNTED: a resume says how much it did not show rather than pretending nothing happened.
        return { ...state, terminals: state.terminals.map((t) => (t.id === id ? { ...t, droppedWhileSuspended: (t.droppedWhileSuspended ?? 0) + data.length } : t)) };
    }

    const joined = (state.output[id] ?? '') + data;
    const kept = joined.length > OUTPUT_CAP ? joined.slice(joined.length - OUTPUT_CAP) : joined;
    return { ...state, output: { ...state.output, [id]: kept } };
}

/**
 * The shell ended on its own. The tab STAYS, marked with its exit code, so the user sees that
 * it ended and how — a tab that vanished the moment a build finished would take its last
 * screen of output with it.
 */
export function terminalExited(state: WorkspaceState, id: string, code: number): WorkspaceState {
    if (!state.terminals.some((t) => t.id === id)) return state;
    return {
        ...state,
        terminals: state.terminals.map((t) => (t.id === id ? { ...t, exited: code } : t)),
    };
}

/** The user closed a tab. The neighbour becomes active, so the panel never shows nothing while tabs remain. */
/**
 * CLOSING A TERMINAL (Tynn #763; Genie 1's delete confirm): a RUNNING shell asks first — one stray click on × used to end
 * a build, a server or a REPL; one that has already exited closes at once, there is nothing left to lose.
 */
export function closeRequested(state: WorkspaceState, id: string): { state: WorkspaceState; closeNow: boolean } {
    const tab = state.terminals.find((t) => t.id === id) ?? (state.hidden ?? []).find((t) => t.id === id);
    if (!tab || tab.exited !== null) return { state: { ...state, closing: null }, closeNow: true };
    return { state: { ...state, closing: id }, closeNow: false };
}

/** The person kept it: nothing closes. */
export function closeCancelled(state: WorkspaceState): WorkspaceState {
    return { ...state, closing: null };
}

export function terminalClosed(state: WorkspaceState, id: string): WorkspaceState {
    if (state.closing === id) state = { ...state, closing: null };
    if ((state.hidden ?? []).some((t) => t.id === id)) {
        const { [id]: _droppedHidden, ...output } = state.output;
        return { ...state, hidden: (state.hidden ?? []).filter((t) => t.id !== id), output };
    }
    const index = state.terminals.findIndex((t) => t.id === id);
    if (index === -1) return state;

    const terminals = state.terminals.filter((t) => t.id !== id);
    const { [id]: _dropped, ...output } = state.output;
    const active =
        state.active !== id
            ? state.active
            : (terminals[Math.min(index, terminals.length - 1)]?.id ?? null);
    return { ...state, terminals, active, output };
}

/** HIDE (§6.5): the shell keeps running; the tab leaves the strip and is listed as hidden; a neighbour becomes active. */
export function terminalHidden(state: WorkspaceState, id: string): WorkspaceState {
    const index = state.terminals.findIndex((t) => t.id === id);
    if (index === -1) return state;
    const tab = state.terminals[index]!;
    const terminals = state.terminals.filter((t) => t.id !== id);
    const active = state.active !== id ? state.active : (terminals[Math.min(index, terminals.length - 1)]?.id ?? null);
    return { ...state, terminals, active, hidden: [...(state.hidden ?? []), tab] };
}

/** SHOW a hidden terminal: back on the strip, active, output intact. */
export function terminalShown(state: WorkspaceState, id: string): WorkspaceState {
    const tab = (state.hidden ?? []).find((t) => t.id === id);
    if (!tab) return state;
    return { ...state, terminals: [...state.terminals, tab], active: tab.id, hidden: (state.hidden ?? []).filter((t) => t.id !== id) };
}

/** SUSPEND / RESUME: the tab stays; output is held back (and counted) while suspended. */
export function terminalSuspended(state: WorkspaceState, id: string, suspended: boolean): WorkspaceState {
    if (!state.terminals.some((t) => t.id === id)) return state;
    return { ...state, terminals: state.terminals.map((t) => (t.id === id ? { ...t, suspended, droppedWhileSuspended: suspended ? (t.droppedWhileSuspended ?? 0) : 0 } : t)) };
}

export function activate(state: WorkspaceState, id: string): WorkspaceState {
    if (!state.terminals.some((t) => t.id === id) && !(state.codes ?? []).some((c) => c.id === id) && !(state.plugins ?? []).some((p) => p.id === id)) return state;
    return { ...state, active: id };
}

/** Open a file as a pane (§4.6): one pane per path; opening it again just activates it. */
export function codeOpened(state: WorkspaceState, path: string): WorkspaceState {
    const id = `${CODE_PANE_PREFIX}${path}`;
    const codes = state.codes ?? [];
    if (codes.some((c) => c.id === id)) return { ...state, active: id };
    return { ...state, codes: [...codes, { id, path }], active: id };
}

/** Close a code pane: the file stays on disk, the shells keep running; the active pane falls back to a neighbour, then a terminal. */
export function codeClosed(state: WorkspaceState, id: string): WorkspaceState {
    const codes = state.codes ?? [];
    if (!codes.some((c) => c.id === id)) return state;
    const rest = codes.filter((c) => c.id !== id);
    const active = state.active === id ? (rest[rest.length - 1]?.id ?? state.terminals[state.terminals.length - 1]?.id ?? null) : state.active;
    return { ...state, codes: rest, active };
}

/** Open a plugin's panel as a pane (§4.6): one pane per panel; opening it again just activates it. */
export function pluginOpened(state: WorkspaceState, pluginId: string, panelId: string): WorkspaceState {
    const id = `${PLUGIN_PANE_PREFIX}${pluginId}/${panelId}`;
    const plugins = state.plugins ?? [];
    if (plugins.some((p) => p.id === id)) return { ...state, active: id };
    return { ...state, plugins: [...plugins, { id, pluginId, panelId }], active: id };
}

/** Close a plugin pane: the active pane falls back to a neighbour, then a code pane, then a terminal. */
export function pluginClosed(state: WorkspaceState, id: string): WorkspaceState {
    const plugins = state.plugins ?? [];
    if (!plugins.some((p) => p.id === id)) return state;
    const rest = plugins.filter((p) => p.id !== id);
    const codes = state.codes ?? [];
    const active = state.active === id ? (rest[rest.length - 1]?.id ?? codes[codes.length - 1]?.id ?? state.terminals[state.terminals.length - 1]?.id ?? null) : state.active;
    return { ...state, plugins: rest, active };
}
