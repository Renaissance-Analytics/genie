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
}

export interface WorkspaceState {
    terminals: readonly TerminalTab[];
    /** The terminal shown. `null` when there are none. */
    active: string | null;
    /** Output per terminal, as one growing string — the shape `fancy-term`'s `output` prop wants. */
    output: Readonly<Record<string, string>>;
}

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
    return { terminals: [], active: null, output: {} };
}

/** A terminal the engine just opened. It becomes the active one — the user asked for it. */
export function terminalOpened(
    state: WorkspaceState,
    tab: TerminalTab,
    scrollback: string,
): WorkspaceState {
    return {
        terminals: [...state.terminals, tab],
        active: tab.id,
        output: { ...state.output, [tab.id]: scrollback },
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
    if (!state.terminals.some((t) => t.id === id)) return state;

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
export function terminalClosed(state: WorkspaceState, id: string): WorkspaceState {
    const index = state.terminals.findIndex((t) => t.id === id);
    if (index === -1) return state;

    const terminals = state.terminals.filter((t) => t.id !== id);
    const { [id]: _dropped, ...output } = state.output;
    const active =
        state.active !== id
            ? state.active
            : (terminals[Math.min(index, terminals.length - 1)]?.id ?? null);
    return { terminals, active, output };
}

export function activate(state: WorkspaceState, id: string): WorkspaceState {
    if (!state.terminals.some((t) => t.id === id)) return state;
    return { ...state, active: id };
}
