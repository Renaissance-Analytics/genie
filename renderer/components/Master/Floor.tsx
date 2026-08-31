import { IconBox, IconLayoutGrid } from './icons';
import TerminalGrid from './TerminalGrid';
import type { AgentRecordSpec, AgentRuntimeSpec } from '../../lib/ams-grid';
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
    onSendPendingNudge?: (id: string) => void;
    onAttentionClear?: (id: string) => void;
    recoverGen?: Record<string, number>;
    maximizedId: string | null;
    onClose: (id: string) => void;
    onFocus: (id: string) => void;
    onToggleMaximize: (id: string) => void;
    onDisable?: (id: string) => void;
    onAgentSettings?: (spec: TerminalSpec) => void;
    onRestartAgent?: (spec: TerminalSpec) => void;
    onAddTerminal: () => void;
    onAddCode?: () => void;
    onMarkActive: (id: string) => void;
    onMarkInactive: (id: string) => void;
    layoutMode: LayoutMode;
    addDisabled?: boolean;
    addDisabledReason?: string;
    onReorder?: (orderedIds: string[]) => void;
    /** Status bar: how many projects have a live panel, and how many are running. */
    projectCount: number;
    activeCount: number;
}

export default function Floor(state: FloorState) {
    const { projectCount, activeCount, ...grid } = state;
    return (
        <>
            <div className="gbody">
                <TerminalGrid {...grid} />
            </div>
            <StatusBar
                panelCount={state.specs.length}
                projectCount={projectCount}
                activeCount={activeCount}
            />
        </>
    );
}

interface StatusBarProps {
    panelCount: number;
    projectCount: number;
    activeCount: number;
}

function StatusBar({ panelCount, projectCount, activeCount }: StatusBarProps) {
    return (
        <div className="gstatus">
            <span className="si">
                <IconLayoutGrid size={13} /> {panelCount} panel
                {panelCount === 1 ? '' : 's'}
            </span>
            <span className="si">
                <IconBox size={13} />
                {projectCount === 0
                    ? 'No project'
                    : projectCount === 1
                      ? '1 project'
                      : `${projectCount} projects`}
            </span>
            <span className="si">
                <span className="sdot" style={{ background: '#10b981' }} />
                {activeCount} live
            </span>
        </div>
    );
}
