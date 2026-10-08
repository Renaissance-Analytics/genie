import { IconBox, IconLayoutGrid } from './icons';
import TerminalGrid from './TerminalGrid';
import { HibernatedFloor } from './Hibernation';
import type { AgentRecordSpec, AgentRuntimeSpec } from '../../lib/ams-grid';
import type { RestartMode } from '../../../main/agents/restart-options';
import type { LayoutMode } from './TerminalGrid';
import type { AgentInboxIncomingNotice, TerminalSpec, WorkspaceRow } from '../../lib/genie';

/**
 * The Floor — Genie's panel management, as one component (Tynn #250).
 *
 * The grid of terminal/code panels plus the status bar beneath it. Extracted from
 * `master.tsx` so a GApp window's Agent tab can mount THE SAME surface rather than
 * a copy of it: a GApp is a special workspace, and "the same UX as a workspace"
 * has to mean the same code or it stops being true within a release.
 *
 * The state STAYS with the caller, deliberately. The two callers derive it
 * differently for a real reason — the master window tracks specs across every
 * workspace and keeps off-workspace panels mounted-hidden so their ptys survive a
 * switch, while a GApp window is a single workspace and has no switch to survive.
 * Forcing one state model on both would mean carrying master's multi-workspace
 * machinery into a window that has no use for it.
 *
 * What IS shared is the contract: one props shape, one composition, one place to
 * change when the floor changes.
 */
export interface FloorState {
    /** Active-workspace specs — these lay out the visible grid. */
    specs: TerminalSpec[];
    /** Every known spec, including a disabled `<name>-slave` screen that is not
     *  itself a floor tile. Defaults to the rendered specs for simple callers. */
    allSpecs?: TerminalSpec[];
    /** Off-workspace selected specs, rendered mounted-hidden to keep ptys alive. */
    backgroundSpecs?: TerminalSpec[];
    workspacesById: Map<string, WorkspaceRow>;
    /** The active workspace's registered agents + their TUIs. Reaches each
     *  agent panel so its driver control knows which agent it is showing. */
    agentRecord?: { agents: AgentRecordSpec[]; runtimes: AgentRuntimeSpec[] };
    onRuntimesChanged?: () => void;
    activeWorkspaceId?: string | null;
    focusId: string | null;
    attentionIds: Set<string>;
    pendingNudges?: Record<string, AgentInboxIncomingNotice>;
    onSendPendingNudge?: (
        id: string,
        options?: { clearInput?: boolean },
    ) => Promise<boolean> | void;
    onAttentionClear?: (id: string) => void;
    recoverGen?: Record<string, number>;
    maximizedId: string | null;
    onClose: (id: string) => void;
    onFocus: (id: string) => void;
    onToggleMaximize: (id: string) => void;
    onDisable?: (id: string) => void;
    onAgentSettings?: (spec: TerminalSpec) => void;
    onRestartAgent?: (spec: TerminalSpec, mode: RestartMode) => void;
    onAddTerminal: () => void;
    onAddCode?: () => void;
    onMarkActive: (id: string) => void;
    onMarkInactive: (id: string) => void;
    layoutMode: LayoutMode;
    addDisabled?: boolean;
    addDisabledReason?: string;
    onReorder?: (orderedIds: string[]) => void;
    /**
     * How many projects have a live panel, and how many agents are running.
     *
     * These used to paint a status bar at the bottom of the Floor (`.gstatus`), deleted in P7:
     * the Deck is the default surface now and reports "N live · N waiting on you" from the same
     * facts, so the bar was grid-era chrome repeating what the landing view already says.
     *
     * The NUMBERS are kept and published as data attributes on `.gbody`, because
     * `e2e/screenshots.spec.ts` uses them as deliberate corroboration — *"from the app rather
     * than from the DOM… if these two ever disagree, that gap IS the bug"*. Dropping them would
     * have removed a real signal along with the chrome, which is the cheapest kind of mistake to
     * make while deleting things.
     */
    projectCount: number;
    activeCount: number;
    /** Set when the ACTIVE workspace is hibernating (genie#672). Its panels are
     *  not mounted — nothing in it may start — so the floor says so and offers
     *  the way back. */
    hibernated?: { name: string; waking: boolean; onWake: () => void };
    /** A cross-workspace surface mounted ABOVE the grid (the Deck). */
    deck?: React.ReactNode;
    /** Conceal the grid with CSS while `deck` is showing. NEVER unmount it — see the
     *  comment at the render site and the source guard in `lib/floor-surface.ts`. */
    hideGrid?: boolean;
}

export default function Floor(state: FloorState) {
    const { projectCount, activeCount, hibernated, deck, hideGrid, ...grid } = state;
    return (
        <>
            {deck}
            {/* HIDDEN, never unmounted. Every panel in here owns a live xterm bound to
                a pty; unmounting the grid to show another surface would remount all of
                them on the way back and reset the terminals. TerminalGrid already keeps
                off-workspace panels mounted-hidden for exactly this reason — a panel
                that changed child-slot "got a different effective key … → XTerm
                remounted → PTY reset". Opening the Deck is the same hazard in a new
                hat, so it conceals rather than replaces. `renderer/lib/floor-surface.ts`
                carries a source guard that fails if this ever becomes conditional. */}
            <div
                className="gbody"
                style={hideGrid ? { display: 'none' } : undefined}
                // The floor's own account of itself — see the note on `projectCount`.
                data-panel-count={state.specs.length}
                data-project-count={projectCount}
                data-live-count={activeCount}
            >
                <TerminalGrid
                    {...grid}
                    // In place of the empty workspace's Add tiles, so the OTHER
                    // workspaces' background panels stay mounted behind it.
                    emptyState={
                        hibernated ? (
                            <HibernatedFloor
                                name={hibernated.name}
                                waking={hibernated.waking}
                                onWake={hibernated.onWake}
                            />
                        ) : undefined
                    }
                />
            </div>
        </>
    );
}
