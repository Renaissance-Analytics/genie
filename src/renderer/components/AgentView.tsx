import { activityRows } from '../../core/stream-view.js';
import { providerLogin } from '../../core/provider-login.js';
import { headroomLine, headroomOf } from '../../core/headroom.js';
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { activityBars, outputHistogram, outputTotalLabel, activityLedger, lastOutputLabel, type TakeOverProbe } from '../../core/observed.js';
import { contextNote, diffHeader, headerActions, personaView, planSteps, processEnded, railMode, railSummary, tabNote } from '../../core/agent-view.js';
import { agentIndex, type IndexLive } from '../../core/agent-index.js';
import { readIndexCollapsed, turnNumbers, writeIndexCollapsed } from '../../core/index-column.js';
import { FidelityDot } from './Dashboard.js';
import type { TerminalPaneProps } from './TerminalPane.js';
import { Dropdown, Icon, Select, Switch } from '@particle-academy/react-fancy';
import { ACP_PROVIDERS } from '../../core/engine.js';
import { agentChanges } from '../../core/agent-changes.js';
import { IW_DELIVERIES, type IssueWatchPrefs, type IssueWatchSetting, type IwDelivery } from '../../core/issue-watch.js';
import { agentShells } from '../../core/agent-shells.js';
import { ShellsPanel } from './ShellsPanel.js';
import type { GenieBridge } from '../bridge.js';
import { FilesPanelContainer } from './FilesPanelContainer.js';
import { agentOpsMenu } from '../../core/agent-ops-menu.js';
import { controlOutcome, issueWatchGroups, removeControls, runControls, settingsSectionShown, settingsSections, type SettingsControl, type SettingsSection } from '../../core/agent-settings-view.js';
import { TurnStop } from './TurnStop.js';
import type { DeletePlan } from '../../core/agent-ops.js';
import type { Diagnosis, Repair } from '../../core/workspace-model.js';
import { approvalPlacement, approvalPolicySentence, budgetFor, parkedDivider, planFor, statePill, tabsFor } from '../../core/agent-view.js';
import { ApprovalCard, ApprovalMarker } from './ApprovalCard.js';
import type { Fidelity } from '../../core/dashboard-view.js';
import { inspectorFor } from '../../core/inspector.js';
import type { LiveSession } from '../../core/roster.js';
import type { AgentPermissions } from '../../core/identity.js';
import { chosenModel, modelLabel, type ModelChoices } from '../../core/provider-models.js';
import type { AgentTab } from '../../core/route.js';
import type { StreamFilter, TimedEvent } from '../../core/stream-view.js';
import { Inspector } from './Inspector.js';
import { Lanes } from './Lanes.js';
import { ChipsRow, TimelineStrip } from './TimelineStrip.js';
import { chipRow, sessionTimeline } from '../../core/session-timeline.js';
import { nextEditAfter, rowsInRange, type TimeRange } from '../../core/lanes.js';
import { findRows, ledgerRow, visibleRows } from '../../core/stream-view.js';
import { editPathIn, revertEdit } from '../../core/revert-edit.js';
import type { RepoCommit } from '../../core/commits.js';
import { agentViewAction, approvalChoice, inspectorOnEnter, isTypingTarget, stepRow, toggleThoughts } from '../../core/keys.js';
import { Stream } from './Stream.js';
import { TurnCards } from './TurnCards.js';
import { turnCards } from '../../core/turn-cards.js';
import type { StreamLayout } from '../../core/route.js';

/**
 * THE AGENT VIEW — the most important screen.
 *
 * Header · tabs · Stream · Inspector · right rail.
 *
 * ## Tabs come from fidelity, and absence is the mechanism
 *
 * A declared agent has `Stream | Files | Changes`; an observed one has
 * `Terminal | Activity | Files | Changes` and **no Stream tab at all**. Not a disabled one —
 * *"a disabled control is an accusation; a different shape is a fact."*
 *
 * **Stream is never gated on anything beyond fidelity.** With no events it shows an empty state
 * and the composer stays. §0.4 is this exact screen shipping three times with a finished
 * Conversation UI nobody could reach, because `sessionFidelity()` returned `observed` for
 * every agent — one condition, an entire feature hidden, every test green.
 *
 * ## The Inspector competes with the Stream's HEIGHT, never with the right edge
 *
 * It sits inside the body, between the Stream and the rail, and the Stream shrinks to make
 * room. It never pushes the Stream sideways: a panel that shoves the conversation left when a
 * row is selected moves the thing the reader was reading.
 *
 * It is closed on arrival and does not remember being open across agents.
 */

/** The index column's live dot — the current turn's state, the Dashboard's colours. */
const INDEX_LIVE: Record<IndexLive, string> = { ok: 'bg-[var(--success)]', warn: 'bg-[var(--warning)]', bad: 'bg-[var(--danger)]' };

const TAB_LABEL: Record<AgentTab, string> = {
    stream: 'Stream',
    files: 'Files',
    changes: 'Changes',
    shells: 'Shells',
    terminal: 'Terminal',
    activity: 'Activity',
    settings: 'Settings',
};

const PILL_TONE = {
    ok: 'text-[var(--success)]',
    warn: 'text-[var(--warning)]',
    bad: 'text-[var(--danger)]',
    muted: 'text-[var(--fg-3)]',
} as const;

/**
 * AGENT OPERATIONS (§6.2) as the view sees them. Absent for an Observed agent and for a window that
 * cannot operate agents — no dead controls. A delete is previewed (the plan) before it is confirmed.
 */
export interface AgentOpsProps {
    readonly deletePreview: DeletePlan | null;
    readonly diagnosis: Diagnosis | null;
    /** The last operation's refusal or result, shown where it was caused. */
    readonly lastOutcome: string | null;
    readonly budgetUsd: number | null;
    /** Mode is WORDING for the agent (§6.2): automated / manual. Not a permission boundary. */
    readonly mode: 'automated' | 'manual';
    /** The agent's own half of who may message it (§6.4). */
    readonly accessScope: 'none' | 'self' | 'specific' | 'all';
    readonly onSetMode: (mode: 'automated' | 'manual') => void;
    readonly onSetAccessScope: (scope: 'none' | 'self' | 'all') => void;
    /** Autonomous (Tynn #801): its services/processes/sites/terminals actions run without asking. Absent setter = no switch. */
    readonly autoApprove?: boolean;
    readonly onSetAutoApprove?: (on: boolean) => void;
    /** May manage the workspace's tabs (beta.35 item 36): the `workspaceTabs` tool. Absent = no switch. */
    readonly manageTabs?: boolean;
    readonly onSetManageTabs?: (on: boolean) => void;
    /** May drive pages (browser rebuild step 7). */
    readonly drivePages?: boolean;
    readonly onSetDrivePages?: (on: boolean) => void;
    /** What it hears from IssueWatch (Tynn #806): how, and which kinds. Absent setter = no section (a window that cannot set it). */
    readonly issueWatch?: IssueWatchPrefs;
    readonly onSetIssueWatch?: (setting: IssueWatchSetting) => void;
    /** A Claude agent's tools: all, ask before shell commands, or edits only (shell refused). Absent = no control (a window that cannot set it). */
    readonly permissions?: AgentPermissions;
    readonly onSetPermissions?: (permissions: AgentPermissions) => void;
    /** The model CHOSEN for the agent (`null` = the provider's default); the one IN USE is `session.model`. Absent `onSetModel` = no control. */
    readonly model?: string | null;
    readonly onSetModel?: (model: string | null) => void;
    /**
     * The PROVIDER's models for the picker (prism-acp 0.22; the owner, 2026-10-21: "using actual available options from the
     * providers"). `'loading'` while it is asked; absent = a host that cannot list them, which keeps the free-text field.
     */
    readonly models?: ModelChoices | 'loading';
    /** Ask the provider again (its CLI starts once more). */
    readonly onRefreshModels?: () => void;
    readonly onRestart: (kind: 'graceful' | 'fresh') => void;
    readonly onSwitchDriver: (to: string) => void;
    readonly onDiagnose: () => void;
    readonly onPreviewDelete: (outcome: 'unmount' | 'delete') => void;
    readonly onConfirmDelete: (outcome: 'unmount' | 'delete', alsoRemoveFrom: string[]) => void;
    readonly onCancelDelete: () => void;
    readonly onSetBudget: (dailyLimitUsd: number | null) => void;
}

const REPAIR_LABEL = (r: Repair): string =>
    r.action === 'install-provider' ? 'install the provider'
    : r.action === 'sign-in' ? 'sign in to the provider'
    : r.action === 'restart-graceful' ? 'restart gracefully'
    : `restart fresh — ${r.reason}`;

export interface AgentViewProps {
    /** The Active Plan column shown (beta.33 item 11: hidden from the workspace tab row's toggle); absent = shown. */
    planOpen?: boolean | undefined;
    /** Where the index column's collapsed state is remembered; `undefined` = the browser's localStorage, `null` = nowhere (tests). */
    indexStorage?: Pick<Storage, 'getItem' | 'setItem'> | null | undefined;
    agent: { id: string; name: string; provider: string; fidelity: Fidelity; cwd: string; instructions?: string | null | undefined; raisesApprovals?: boolean | null | undefined };
    session: LiveSession | null;
    rows: readonly TimedEvent[];
    tab: AgentTab;
    lanes: readonly StreamFilter[] | null;
    at: string | null;
    selectedId: string | null;
    /** The stream cursor (`j`/`k`): a focus that is not a selection; Enter opens the Inspector on it. Given = its start. */
    cursor?: string | null | undefined;
    /** Turn count and cost belong to the session's accounting, not to a single row. */
    turns: number;
    cost: number | null;
    /** The agent the chat flyout is open on, from the route. Decides where an approval acts. */
    chatSubject?: string | null | undefined;
    /** The option id in flight for THIS agent's parked approval (core/approval-answering.ts); `null` = none. */
    answeringApproval?: string | null | undefined;
    /** The host's refusal of the last answer to THIS approval, in words, for the card. */
    approvalRefusal?: string | null | undefined;
    /** `note`: the person's words with the answer (beta.33 item 16), delivered to the agent; absent = none. */
    onAnswerApproval?: ((optionId: string, note?: string) => void) | undefined;
    onNavigate: (route: string) => void;
    onSelect: (rowId: string | null) => void;
    /** Writes `?lane=` — the selection lives in the route so a filtered view is linkable. */
    onLanes?: ((lanes: readonly StreamFilter[] | null) => void) | undefined;
    /** The Lanes drawer (tracks + drag) open — controlled, for tests that render server-side; otherwise the view keeps its own (`L`). */
    lanesOpen?: boolean | undefined;
    /** Find in stream (`/`) — controlled, for tests that render server-side; otherwise the view keeps its own. */
    find?: string | undefined;
    /** The provider's recent stderr (the process-ended block's log); empty when it said nothing. */
    log?: readonly string[] | undefined;
    /** The Stream's layout from the route (the board): the ledger, or one card per turn. */
    layout?: StreamLayout | undefined;
    /** The content width in px — controlled for tests; otherwise measured by the view (§4.2: the rail collapses below 1100 px). */
    width?: number | null | undefined;
    /** The persona file's text (the board shows it under the path) — controlled for tests; otherwise read through `files.open`. `null` = read, nothing. */
    personaText?: string | null | undefined;
    /** Why the persona file could not be read, when it could not. */
    personaError?: string | null | undefined;
    /** The persona file's git state — controlled for tests; otherwise from the same `files.open`. */
    personaGit?: 'committed' | 'modified' | 'untracked' | null | undefined;
    /** The time range from the route; a drag on the timeline changes it. */
    range?: TimeRange | null | undefined;
    onRange?: ((range: TimeRange | null) => void) | undefined;
    /** Take Over (§1): open this agent's TUI in a new window. */
    onTakeOver?: ((agentId: string) => void) | undefined;
    /** The chat is already on this page beside the view (the doctor window): no Chat button that would go nowhere. */
    chatInView?: boolean | undefined;
    /** Agent operations (§6.2); absent = none offered. */
    ops?: AgentOpsProps | undefined;
    now?: (() => number) | undefined;
    /** The file host (§4.3) for the Files and Changes tabs; absent = this window has none, and the tabs say so. */
    files?: GenieBridge['files'] | undefined;
    /** The agent's workspace — the one file panel is per workspace. Absent = unknown; the tabs say so. */
    workspace?: { id: string; name?: string | undefined; path: string } | undefined;
    /** The Changes tab's starting list — for tests that render server-side. Read from the host otherwise. */
    initialChanges?: readonly string[] | null | undefined;
    /** The disk changes (path, when seen) at mount, for a render without the bridge; afterwards the bridge's state. */
    initialDiskChanges?: readonly { path: string; at: number }[] | null | undefined;
    /** The commits in the workspace's repos since a moment (git's own account), for an observed agent's Activity tab. */
    readCommits?: ((workspaceId: string, sinceMs: number) => Promise<readonly RepoCommit[]>) | undefined;
    initialCommits?: readonly RepoCommit[] | null | undefined;
    /** The live Take Over probe for an OBSERVED agent (§4.2): its terminal, its bursts. `null`/absent = none. */
    takeOver?: TakeOverProbe | null | undefined;
    /** The terminal host, for the Terminal tab's second attach to the TUI's pty; absent = this window has none. */
    terminals?: GenieBridge['terminals'] | undefined;
    /** "Stop agent" in the operations menu while the agent runs: END its session (§6.2 stop, everything about it kept). */
    onStop?: ((agentId: string) => void) | undefined;
    /**
     * `Stop this turn` beside the state pill while a turn runs that can be stopped (`turnStopOffered`): the TURN ends,
     * the agent keeps running. Ending the session is `onStop`, a separate and explicit action.
     */
    onCancelTurn?: ((agentId: string) => void) | undefined;
    /** `Resume now` while the agent's provider login is held for its rate limit (Tynn #794). */
    onResumeLimit?: ((agentId: string) => void) | undefined;
    /** `Log in to <provider>` for a signed-out agent (the owner, 2026-10-18). */
    onProviderLogin?: ((agentId: string) => void) | undefined;
    /** `Try again` for an agent whose ACCOUNT the provider paused (the owner, 2026-10-21): every agent on that login comes back. */
    onAccountRetry?: ((agentId: string) => void) | undefined;
    /** `Log in to Claude Design` for an agent a tool refused for want of `/design-login` (#1081). */
    onDesignLogin?: ((agentId: string) => void) | undefined;
    /** `Start` for a declared agent that is not running: start it (it reattaches rather than starting a second). */
    onStart?: ((agentId: string) => void) | undefined;
    /** The Settings tab's sub-tab — controlled, for tests that render server-side; otherwise the view keeps its own (General first). */
    settingsSection?: SettingsSection | undefined;
}

/**
 * The observed agent's terminal: a second attach to the TUI's pty (§6.5 multi-attach — the Take Over window keeps
 * its own). xterm is loaded CLIENT-SIDE ONLY (see `Workspace.tsx`): until it resolves, the mount point stands with
 * the terminal's id on it, which is what a server render shows.
 */
function ObservedTerminal({ terminalId, terminals }: { terminalId: string; terminals: GenieBridge['terminals'] }) {
    const [Pane, setPane] = useState<ComponentType<TerminalPaneProps> | null>(null);
    const [output, setOutput] = useState('');
    const size = useRef({ cols: 120, rows: 30 });
    useEffect(() => {
        let live = true;
        void import('./TerminalPane.js').then((m) => { if (live) setPane(() => m.TerminalPane); });
        void terminals.attach(null, terminalId).then((joined) => { if (live && joined) setOutput(joined.scrollback); });
        const off = terminals.onData((id, data) => { if (id === terminalId) setOutput((o) => o + data); });
        return () => { live = false; off(); };
    }, [terminals, terminalId]);
    return (
        <div data-observed-terminal={terminalId} className="min-h-0 flex-1 bg-[var(--bg-0)]">
            {Pane ? (
                <Pane
                    paneId={`observed-${terminalId}`}
                    output={output}
                    readOnly={false}
                    onData={(data) => terminals.write(terminalId, data)}
                    onResize={({ cols, rows }) => { size.current = { cols, rows }; terminals.resize(terminalId, cols, rows); }}
                />
            ) : null}
        </div>
    );
}

export function AgentView({
    agent, session, rows, tab, lanes, at, selectedId, cursor: cursorProp = null, turns, cost, onNavigate, onSelect, now,
    chatSubject, answeringApproval, approvalRefusal, onAnswerApproval, onLanes, range = null, onRange, onTakeOver, chatInView = false, ops,
    files, workspace, initialChanges, initialDiskChanges, readCommits, initialCommits, takeOver = null, terminals, onStop, onCancelTurn, onResumeLimit, onProviderLogin, onAccountRetry, onDesignLogin, onStart, lanesOpen: lanesOpenProp, find: findProp, log = [], layout = 'ledger', personaText: personaTextProp, personaError: personaErrorProp = null, personaGit: personaGitProp, width: widthProp, indexStorage, planOpen = true, settingsSection: settingsSectionProp,
}: AgentViewProps) {
    const tabs = tabsFor(agent.fidelity);
    // THE INDEX COLUMN, collapsible to the turn numbers (core/index-column.ts); the choice outlives the view.
    const indexStore = indexStorage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : indexStorage;
    const [indexCollapsed, setIndexCollapsed] = useState(() => readIndexCollapsed(indexStore));
    const toggleIndex = () => setIndexCollapsed((was) => { writeIndexCollapsed(indexStore, !was); return !was; });
    const clock = now ?? (() => Date.now());
    // CHANGES (§4.2): the files THIS agent changed this session, from the file host's groups; re-read on every change
    // the host reports. `null` = absent — the tab says so in a sentence.
    const [changes, setChanges] = useState<readonly string[] | null>(initialChanges ?? null);
    const [diskChanges, setDiskChanges] = useState<readonly { path: string; at: number }[] | null>(initialDiskChanges ?? null);
    // COMMITS since the Take Over window opened (the board's blind index): read when the view mounts and when the
    // workspace's files change (a commit follows edits); never polled.
    const [commits, setCommits] = useState<readonly RepoCommit[] | null>(initialCommits ?? null);
    const windowStart = takeOver?.startedAt ?? null;
    useEffect(() => {
        if (!readCommits || !workspace || windowStart === null) return;
        let live = true;
        const read = () => { void readCommits(workspace.id, windowStart).then((c) => { if (live) setCommits(c); }); };
        read();
        const off = files?.onChange((id) => { if (id === workspace.id) read(); });
        return () => { live = false; off?.(); };
    }, [readCommits, workspace, windowStart, files]);
    const [changeOpen, setChangeOpen] = useState<string | null>(null);
    // THE STREAM CURSOR (§4.2 `j`/`k`): a focus, drawn as a ring, that is NOT the Inspector's selection. Enter opens
    // the Inspector on it; a click (a selection) brings the cursor along, so the keys continue from where the reader is.
    const [cursorId, setCursorId] = useState<string | null>(cursorProp);
    useEffect(() => { if (cursorProp !== null) setCursorId(cursorProp); }, [cursorProp]);
    useEffect(() => { if (selectedId !== null) setCursorId(selectedId); }, [selectedId]);
    // The Lanes drawer, closed on arrival (the board draws the strip and the chips; the tracks are behind `Lanes ▾` / `L`).
    const [ownLanesOpen, setOwnLanesOpen] = useState(false);
    // Find in stream: the query is view state the box owns; `/` focuses the box, Escape in it clears.
    const [ownFind, setOwnFind] = useState('');
    const findQuery = findProp ?? ownFind;
    const findRef = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        if (!files || !workspace) return;
        let live = true;
        const read = () => { void files.state(workspace.id).then((s) => { if (live) { setChanges(agentChanges(s, agent.name)); setDiskChanges(s?.diskChanges ?? null); } }); };
        read();
        const off = files.onChange((id) => { if (id === workspace.id) read(); });
        return () => { live = false; off(); };
    }, [files, workspace, agent.name]);
    const pill = statePill(session, now ?? (() => Date.now()), { turns, takeOver: agent.fidelity === 'observed' ? takeOver : null });
    const actions = headerActions(session, agent.fidelity);
    // "Stop agent" is offered while the session is up and there is something to end it with.
    const menu = ops ? agentOpsMenu(agent, undefined, { running: session?.running === true && onStop !== undefined }) : [];
    const act = (id: string) => {
        if (!ops) return;
        if (id === 'stop-agent') onStop?.(agent.id);
        else if (id === 'restart-graceful') ops.onRestart('graceful');
        else if (id === 'restart-fresh') ops.onRestart('fresh');
        else if (id.startsWith('switch:')) ops.onSwitchDriver(id.slice('switch:'.length));
        else if (id === 'diagnose') ops.onDiagnose();
        else if (id === 'delete-unmount') ops.onPreviewDelete('unmount');
        else if (id === 'delete-delete') ops.onPreviewDelete('delete');
    };
    // THE SETTINGS SUB-TAB the person picked (General until then), and the control last touched there — so a result that
    // arrives after the touch is shown beside that control (`controlOutcome`), not only in the line under the header.
    const [ownSettingsSection, setOwnSettingsSection] = useState<SettingsSection | null>(null);
    const [touched, setTouched] = useState<{ control: SettingsControl; before: string | null } | null>(null);
    useEffect(() => { setOwnSettingsSection(null); setTouched(null); }, [agent.id]);
    const budgetLimit = ops?.budgetUsd ?? null;
    const plan = planFor(session);
    // The plan's steps (the board): from the latest plan update in the rows; null keeps the step/of line alone.
    // Read from the rows when THEY change, not on every render of the window (the owner, 2026-10-20: "severe UI lag").
    const rowSteps = useMemo(() => planSteps(rows), [rows]);
    // After a restart the plan is the KEPT one (the session's `planSteps`) until this run reports its own — the rows may
    // hold no plan row at all (the owner, 2026-10-21: "The plan loaded in genie should survive a restart").
    const keptSteps = session?.planSteps ?? null;
    const steps = useMemo(() => (keptSteps && keptSteps.length > 0 ? keptSteps.map((s) => ({ content: s.content, status: s.status, current: s.status === 'in_progress' })) : rowSteps), [keptSteps, rowSteps]);
    const budget = budgetFor(session, cost, turns);
    // The provider's headroom (the board's rail row): the latest rate-limit reading in the ledger; none, no row.
    const headroom = useMemo(() => headroomOf(rows), [rows]);
    // Whether this provider can ask at all (the driver's claim): said once in the rail when it cannot.
    const policy = approvalPolicySentence(agent.name, agent.provider, agent.raisesApprovals);
    // The persona path and the context note — both facts, both absent when unknown (§5).
    const persona = agent.instructions ?? null;
    // THE PERSONA'S TEXT (the board): read once per agent through the files bridge; the path shows regardless.
    const [personaRead, setPersonaRead] = useState<{ text: string | null; error: string | null; git?: 'committed' | 'modified' | 'untracked' | null | undefined }>({ text: null, error: null });
    useEffect(() => {
        if (personaTextProp !== undefined || !files || !workspace || !persona) return;
        let live = true;
        void files.open(workspace.id, persona).then((r) => { if (live) setPersonaRead(r.ok ? { text: r.text, error: null, git: r.git ?? null } : { text: null, error: r.error }); });
        return () => { live = false; };
    }, [files, workspace, persona, personaTextProp]);
    const personaShown = personaView(personaTextProp !== undefined ? personaTextProp : personaRead.text);
    const personaError = personaTextProp !== undefined ? personaErrorProp : personaRead.error;
    const personaGitShown = personaTextProp !== undefined ? personaGitProp ?? null : personaRead.git ?? null;
    const note = contextNote(session, rows, pill.tone);
    // THE RAIL COLLAPSE (§4.2): the root's width, measured; below 1100 px the column is a strip with a door to a popover.
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [measured, setMeasured] = useState<number | null>(null);
    useEffect(() => {
        const el = rootRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const report = () => setMeasured(el.getBoundingClientRect().width);
        report();
        const ro = new ResizeObserver(report);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const railModeNow = railMode(widthProp !== undefined ? widthProp : measured);
    const [railOpen, setRailOpen] = useState(false);
    const railText = railSummary(session, note?.tone ?? null);
    const showColumn = railModeNow === 'full' || railOpen;
    // THE PROCESS-ENDED BLOCK (the board's error state): only when the session failed; the engine's own words.
    const ended = processEnded(session, rows, log);
    // THE TERMINAL BLOCK (the board's blind state): an observed agent's column carries its Take Over window's facts.
    const termBlock = agent.fidelity === 'observed' && takeOver ? takeOver : null;

    // A tab the agent does not have falls back to its first one, rather than rendering an empty
    // body under a tab strip that does not contain the selected tab.
    const active = tabs.includes(tab) ? tab : (tabs[0] ?? 'files');

    const chatRoute = `genie://agent/${agent.id}?tab=${active}&chat=${agent.id}`;

    // THE INDEX COLUMN (the board): Turns / Files touched, counted from the rows; absent without turn markers.
    const shells = useMemo(() => agentShells(rows), [rows]);
    const index = active === 'stream' ? agentIndex(rows, session, workspace?.path ?? null, selectedId) : null;
    // THE SESSION TIMELINE STRIP + CHIPS ROW (the board); the Lanes drawer behind `L`.
    // The activity the Stream shows (replies live in the chat): the strip, the find and the lanes read the same rows.
    // The same array while the rows are unchanged, so the Stream's own derivations (keyed on it) are not run again.
    const activity = useMemo(() => activityRows(rows), [rows]);
    const timeline = active === 'stream' ? sessionTimeline(activity, session) : null;
    // NEXT EDIT — `E` and the strip's button: a search ("find me the next one") that opens the edit it lands on, the
    // cursor following. `false` when there is none.
    const nextEdit = (): boolean => {
        const next = nextEditAfter(rowsInRange(rows, range), selectedId);
        if (!next) return false;
        setCursorId(next);
        onSelect(next);
        return true;
    };
    const chips = useMemo(() => chipRow(rows, lanes), [rows, lanes]);
    // The find's match count: content rows that say the query (structure rows are not matches); null without a query.
    const findMatches = findQuery.trim() === '' ? null : findRows(rowsInRange(activity, range), findQuery).filter((r) => r.event.kind !== 'turn' && r.event.kind !== 'divider').length;
    const drawerOpen = lanesOpenProp ?? ownLanesOpen;
    // THE `turns` LAYOUT (the board): the Stream folded into cards; the chips row goes, the index and the strip stay.
    const shownRows = findRows(rowsInRange(activity, range), findQuery);
    const cards = active === 'stream' && layout === 'turns' ? turnCards(shownRows, session, workspace?.path ?? null) : null;
    const otherLayout = layout === 'turns' ? { label: 'Ledger', route: `genie://agent/${agent.id}?tab=stream` } : { label: 'Turns', route: `genie://agent/${agent.id}?tab=stream&layout=turns` };

    /**
     * Where a parked approval is ACTIONABLE — exactly one place.
     *
     * The chat flyout is the only composer, so an open chat on this agent takes the approval
     * with it and the Stream keeps a marker. Two live sets of buttons for one decision leaves
     * one of them showing a question that has already been resolved.
     */

    const approval = session?.pendingApproval ?? null;
    const placement = approvalPlacement(agent.id, chatSubject ?? null);

    /*
     * `E` — the next edit (§4.2). One `keydown` listener; every decision is made by the pure
     * `keys.ts`, so the rule that an unmodified letter never acts while a human is typing is
     * proven in a test rather than hoped for.
     */
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target instanceof HTMLElement ? e.target : null;
            const typing = isTypingTarget(target);
            const action = agentViewAction({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing });
            if (action === null) return;

            // The rows a cursor can land on are the ones on screen: inside the range AND the
            // lane selection. Stepping onto a filtered-out row would select something invisible.
            const inView = visibleRows(findRows(rowsInRange(activity, range), findQuery), lanes).map((r) => r.id);

            switch (action) {
                case 'next-edit': {
                    if (nextEdit()) e.preventDefault();
                    return;
                }
                case 'next-row':
                case 'prev-row': {
                    // The cursor steps from itself — or from the open row when it has not moved yet — and opens nothing.
                    const next = stepRow(inView, cursorId ?? selectedId, action === 'next-row' ? 'next' : 'prev');
                    if (!next) return;
                    e.preventDefault();
                    setCursorId(next);
                    return;
                }
                case 'toggle-inspector': {
                    // Enter opens the Inspector on the cursor row (an edit with arguments), closes it on the row already
                    // open, and does nothing on a row that cannot be inspected — an empty cell is not a control.
                    const inspectable = (id: string): boolean => { const row = rows.find((r) => r.id === id); return row ? ledgerRow(row).inspectable : false; };
                    const decision = inspectorOnEnter(cursorId, selectedId, inspectable);
                    if (decision === null) return;
                    e.preventDefault();
                    onSelect(decision === 'close' ? null : decision.open);
                    return;
                }
                case 'escape': {
                    // In a field, Esc means "stop typing" and nothing more: blur, and let the
                    // rest of the map stay out of it.
                    if (typing) { target?.blur(); return; }
                    // Otherwise: the Inspector FIRST, and only then the Deck (§4.2). Two
                    // presses to leave, so one stray Esc never throws the reader off the agent.
                    e.preventDefault();
                    if (selectedId !== null) { onSelect(null); return; }
                    onNavigate('genie://deck');
                    return;
                }
                case 'toggle-lanes': {
                    e.preventDefault();
                    setOwnLanesOpen((open) => !open);
                    return;
                }
                case 'find': {
                    e.preventDefault();
                    findRef.current?.focus();
                    return;
                }
                case 'toggle-thoughts': {
                    e.preventDefault();
                    onLanes?.(toggleThoughts(lanes));
                    return;
                }
                case 'allow':
                case 'deny': {
                    // Only when the approval is ACTIONABLE here. With the chat pinned to this
                    // agent the composer owns the decision and the stream shows a marker; a
                    // letter here would be a second set of buttons for one decision.
                    if (placement !== 'stream') return;
                    const optionId = approvalChoice(approval, action);
                    if (!optionId) return;
                    e.preventDefault();
                    onAnswerApproval?.(optionId);
                    return;
                }
                case 'take-over': {
                    // The same call the header button makes (§1: a NEW window, an Observed
                    // row, never a managed agent on a pty). The host de-duplicates per agent,
                    // so holding the chord focuses the window rather than opening a second TUI.
                    e.preventDefault();
                    onTakeOver?.(agent.id);
                    return;
                }
                default:
                    return;
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [rows, range, lanes, selectedId, cursorId, onSelect, onNavigate, onLanes, approval, placement, onAnswerApproval, onTakeOver, agent.id, findQuery]);

    const selectedRow = selectedId === null ? null : rows.find((r) => r.id === selectedId);
    const inspector =
        selectedRow && selectedRow.event.kind === 'tool' ? inspectorFor(selectedRow.event) : null;
    // REVERT THIS EDIT (the board's footer door): the call's own before-text goes back through the file panel's write,
    // only where the file still holds exactly what the edit wrote; the footer says what happened. Offered only when
    // this view has the file panel's bridge and the edit names a file inside the workspace.
    const [revertOutcome, setRevertOutcome] = useState<string | null>(null);
    useEffect(() => { setRevertOutcome(null); }, [selectedId]);
    const revertPath = selectedRow && selectedRow.event.kind === 'tool' && workspace ? editPathIn(selectedRow.event.rawInput, workspace.path) : null;
    const revertSelected = inspector?.kind === 'diff' && files && workspace && revertPath !== null && selectedRow && selectedRow.event.kind === 'tool'
        ? () => {
              const event = selectedRow.event;
              if (event.kind !== 'tool') return;
              void (async () => {
                  const opened = await files.open(workspace.id, revertPath);
                  if (!opened.ok) { setRevertOutcome(opened.error); return; }
                  const reverted = revertEdit(opened.text, event.rawInput);
                  if (!reverted.ok) { setRevertOutcome(reverted.reason); return; }
                  const written = await files.write(workspace.id, revertPath, reverted.text, opened.sha);
                  setRevertOutcome(written.ok ? `reverted ${revertPath}` : written.reason);
              })();
          }
        : null;

    return (
        <div ref={rootRef} data-surface="agent" data-agent={agent.id} className="relative flex h-full min-h-0 flex-col">
            {/* Header, the way the board writes it: `{workspace} /` · fidelity dot · name · provider chip · pill · actions. */}
            <div data-view-header="" className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border-1)] px-5">
                {/* Back to its workspace (Tynn #805): the crumb is a link. */}
                {workspace ? <button data-crumb={workspace.id} type="button" data-nav={`genie://workspace/${workspace.id}`} onClick={() => onNavigate(`genie://workspace/${workspace.id}`)} title={`Back to ${workspace.name ?? workspace.id}`} className="max-w-[12rem] shrink truncate whitespace-nowrap text-left text-[13px] text-[var(--fg-3)] hover:text-[var(--fg-1)] hover:underline">{workspace.name ?? workspace.id} /</button> : null}
                <FidelityDot fidelity={agent.fidelity} state={pill.tone === 'ok' ? 'working' : pill.tone === 'warn' ? 'waiting' : pill.tone === 'bad' ? 'broken' : 'idle'} />
                <span className="shrink-0 whitespace-nowrap font-medium">{agent.name}</span>
                <span data-provider-chip={agent.provider} className="shrink-0 whitespace-nowrap rounded-sm bg-[var(--bg-2)] px-1.5 py-px font-mono text-[11px] text-[var(--fg-3)]">{agent.provider} · {agent.fidelity === 'observed' ? 'pty' : 'ACP'}</span>
                <span className="min-w-0 truncate font-mono text-[11px] text-[var(--fg-4)]" title={agent.cwd}>{agent.cwd}</span>

                <span data-pill={pill.word} className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${PILL_TONE[pill.tone]}`}>
                    <span className="size-1.5 rounded-full bg-current" />
                    {pill.word}
                    {/* A clock only while a turn runs. On an idle agent it counts up forever
                        and reads as work in progress. */}
                    {pill.elapsed ? <span className="font-mono tabular-nums">{pill.elapsed}</span> : null}
                </span>

                <div className="ml-auto flex items-center gap-1">
                    {/* START, when it is not running (the owner: there was no way to start the genie agent). */}
                    {actions.start && onStart ? (
                        <button type="button" data-action="start" title="Start — the agent's session begins; its conversation resumes when it has one" onClick={() => onStart(agent.id)} className="flex items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]">
                            <Icon name="play" size="xs" />
                            Start
                        </button>
                    ) : null}
                    {/* STOP THIS TURN, while a turn runs that can be stopped: the TURN ends, the agent keeps running. Ending the
                        session is "Stop agent" in the operations menu. */}
                    {actions.stop && onCancelTurn ? <TurnStop onStop={() => onCancelTurn(agent.id)} agentName={agent.name} /> : null}
                    {/* SIGNED OUT (the owner, 2026-10-18): the provider's own login, in a window of its own, with what to do. */}
                    {actions.login && onProviderLogin ? (
                        <button
                            type="button"
                            data-action="provider-login"
                            title={`Open the ${providerLogin(agent.provider)?.name ?? agent.provider} login in a window of its own; your agents come back once you are signed in`}
                            onClick={() => onProviderLogin(agent.id)}
                            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--warning)] bg-[var(--warning)]/10 px-2 py-0.5 text-xs text-[var(--fg-1)] hover:bg-[var(--warning)]/20"
                        >
                            Log in to {providerLogin(agent.provider)?.name ?? agent.provider}
                        </button>
                    ) : null}
                    {/* ACCOUNT PAUSED (the owner, 2026-10-21: a payment failure): put the account right with the provider, then this. */}
                    {actions.retryAccount && onAccountRetry ? (
                        <button
                            type="button"
                            data-action="account-retry"
                            title={`Once the ${providerLogin(agent.provider)?.name ?? agent.provider} account is put right: every agent it stopped comes back`}
                            onClick={() => onAccountRetry(agent.id)}
                            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--danger)] bg-[var(--danger)]/10 px-2 py-0.5 text-xs text-[var(--fg-1)] hover:bg-[var(--danger)]/20"
                        >
                            Try again
                        </button>
                    ) : null}
                    {/* CLAUDE DESIGN'S LOGIN (#1081): a tool was refused for want of /design-login; one click opens it. */}
                    {actions.designLogin && onDesignLogin ? (
                        <button
                            type="button"
                            data-action="design-login"
                            title="Open Claude Code in a window of its own to run /design-login; the agents waiting on it are told to retry once it has run"
                            onClick={() => onDesignLogin(agent.id)}
                            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--warning)] bg-[var(--warning)]/10 px-2 py-0.5 text-xs text-[var(--fg-1)] hover:bg-[var(--warning)]/20"
                        >
                            Log in to Claude Design
                        </button>
                    ) : null}
                    {actions.resumeLimit && onResumeLimit ? (
                        <button
                            type="button"
                            data-action="resume-limit"
                            title={`Resume now — every ${agent.provider} agent waiting for the rate limit goes on`}
                            onClick={() => onResumeLimit(agent.id)}
                            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border-1)] px-2 py-0.5 text-xs text-[var(--fg-1)] hover:bg-[var(--bg-2)]"
                        >
                            Resume now
                        </button>
                    ) : null}
                    {/*
                     * The way to TALK to this agent.
                     *
                     * The chat flyout is the only place a human types to an agent — it replaces
                     * this view's composer — so without a control that opens it, the Agent view
                     * is read-only and somebody can open an agent and then do nothing with it.
                     * That is what the first screenshot of this screen showed.
                     *
                     * It navigates rather than toggling local state, so the conversation is
                     * linkable and the subject lives in the URL. Not drawn when the chat is already on the page.
                     */}
                    {chatInView ? null : (
                    <button
                        type="button"
                        data-action="chat"
                        // The destination as an ATTRIBUTE, matching the rail's `data-nav`
                        // convention. A route that exists only inside a click handler cannot be
                        // asserted from markup, and "there is a button" is not the same claim as
                        // "the button goes somewhere" — which is precisely the gap that let a
                        // finished Conversation UI ship unreachable.
                        data-nav={chatRoute}
                        onClick={() => onNavigate(chatRoute)}
                        className="flex items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]"
                    >
                        <Icon name="message-square" size="xs" />
                        Chat
                        <span className="font-mono text-[10px] text-[var(--fg-4)]">⌘J</span>
                    </button>
                    )}

                    {/* Take over and Open terminal only where this window can open one: a button with nothing behind it is not drawn. */}
                    {onTakeOver ? (
                    <button
                        type="button"
                        data-action="take-over"
                        onClick={() => onTakeOver(agent.id)}
                        className="flex items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]"
                    >
                        <Icon name="square-terminal" size="xs" />
                        Take over
                        <span className="font-mono text-[10px] text-[var(--fg-4)]">⌘⇧T</span>
                    </button>
                    ) : null}
                    {/* In the error state (the board): the Take Over window IS the terminal. */}
                    {actions.openTerminal && onTakeOver ? (
                        <button type="button" data-action="open-terminal" onClick={() => onTakeOver(agent.id)} className="flex items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]">
                            <Icon name="square-terminal" size="xs" />
                            Open terminal
                        </button>
                    ) : null}
                    {ops && menu.length > 0 ? (
                        <>
                            {/* RESTART only when broken (the board) — primary there; the graceful kind, which refuses if it cannot resume. */}
                            {actions.restart ? (
                                <button
                                    type="button"
                                    data-action="restart-graceful"
                                    title="Restart gracefully — same conversation; refuses if it cannot resume"
                                    onClick={() => ops.onRestart('graceful')}
                                    className="flex items-center gap-1.5 rounded-md border border-[var(--primary-hover)] bg-[var(--primary)] px-2 py-1 text-xs font-medium text-white hover:bg-[var(--primary-hover)]"
                                >
                                    <Icon name="rotate-ccw" size="xs" />
                                    Restart
                                </button>
                            ) : null}
                            <Dropdown placement="bottom-end">
                                <Dropdown.Trigger>
                                    <button type="button" data-action="agent-more" aria-label="More operations" className="flex items-center rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]">
                                        <Icon name="ellipsis" size="xs" />
                                    </button>
                                </Dropdown.Trigger>
                                <Dropdown.Items>
                                    {menu.map((item) => (
                                        <Dropdown.Item key={item.id} {...(item.danger ? { danger: true } : {})} onClick={() => act(item.id)}>
                                            <span className="flex flex-col"><span>{item.label}</span><span className="text-[11px] text-[var(--fg-4)]">{item.hint}</span></span>
                                        </Dropdown.Item>
                                    ))}
                                </Dropdown.Items>
                            </Dropdown>
                        </>
                    ) : null}
                </div>
            </div>

            {ops?.lastOutcome ? (
                <p data-ops-outcome className="shrink-0 border-b border-[var(--border-1)] px-5 py-2 text-xs text-[var(--fg-2)]">{ops.lastOutcome}</p>
            ) : null}
            {ops?.diagnosis ? (
                <p data-diagnosis={ops.diagnosis.state} data-diagnosis-fault={ops.diagnosis.fault ? '' : undefined} className={`shrink-0 border-b border-[var(--border-1)] px-5 py-2 text-xs ${ops.diagnosis.fault ? 'text-[var(--danger)]' : 'text-[var(--fg-3)]'}`}>
                    <span className="font-semibold">{ops.diagnosis.state}</span>
                    {ops.diagnosis.cause ? <span> — {ops.diagnosis.cause}</span> : null}
                    {ops.diagnosis.repair ? <span> · repair: {REPAIR_LABEL(ops.diagnosis.repair)}</span> : null}
                </p>
            ) : null}
            {ops?.deletePreview ? (
                <form
                    data-delete-confirm={ops.deletePreview.outcome}
                    className="shrink-0 border-b border-[var(--warning)] bg-[var(--bg-1)] px-5 py-3 text-xs"
                    onSubmit={(e) => {
                        e.preventDefault();
                        const data = new FormData(e.currentTarget);
                        const also = ops.deletePreview!.external.filter((x) => x.action === 'kept' && data.get(`also-${x.system}`) === 'on').map((x) => x.system);
                        ops.onConfirmDelete(ops.deletePreview!.outcome, also);
                    }}
                >
                    <p className="font-semibold">{ops.deletePreview.outcome === 'delete' ? `Delete ${agent.name} — this removes files` : `Unmount ${agent.name} from Genie`}</p>
                    <div className="mt-2 grid grid-cols-2 gap-4">
                        <div>
                            <p className="text-[11px] uppercase tracking-wide text-[var(--fg-4)]">Goes</p>
                            <ul className="list-disc pl-4">{ops.deletePreview.removes.map((r) => <li key={r}>{r}</li>)}</ul>
                        </div>
                        <div>
                            <p className="text-[11px] uppercase tracking-wide text-[var(--fg-4)]">Stays</p>
                            <ul className="list-disc pl-4">{ops.deletePreview.keeps.map((k) => <li key={k}>{k}</li>)}</ul>
                        </div>
                    </div>
                    {ops.deletePreview.external.length > 0 ? (
                        <div className="mt-2 flex flex-col gap-1">
                            {ops.deletePreview.external.map((x) =>
                                x.action === 'kept' ? (
                                    <label key={x.system} className="flex items-center gap-2">
                                        <input type="checkbox" name={`also-${x.system}`} />
                                        <span>also remove from {x.system} <span className="font-mono text-[var(--fg-4)]">({x.optIn})</span></span>
                                    </label>
                                ) : (
                                    <span key={x.system}>removed from {x.system}</span>
                                ),
                            )}
                        </div>
                    ) : null}
                    <div className="mt-3 flex gap-2">
                        <button type="submit" data-action="confirm-delete" className="rounded-lg bg-[var(--danger)] px-3 py-1.5 text-xs text-white">{ops.deletePreview.outcome === 'delete' ? 'Delete' : 'Unmount'} {agent.name}</button>
                        <button type="button" onClick={ops.onCancelDelete} className="rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-xs">Cancel</button>
                    </div>
                </form>
            ) : null}

            {/* Tabs. The set itself is the signal — a missing tab says what Genie cannot see. */}
            <div role="tablist" className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border-1)] px-5">
                {tabs.map((t) => (
                    <button
                        key={t}
                        type="button"
                        role="tab"
                        data-tab={t}
                        data-active={t === active ? 'true' : 'false'}
                        aria-selected={t === active}
                        onClick={() => onNavigate(`genie://agent/${agent.id}?tab=${t}`)}
                        className={`rounded-md px-2.5 py-1 text-[13px] ${
                            t === active ? 'bg-[var(--bg-3)] font-medium text-[var(--fg-1)]' : 'text-[var(--fg-3)] hover:bg-[var(--bg-2)]'
                        }`}
                    >
                        {TAB_LABEL[t]}
                        {/* The indicator: how many it has running now, on the tab, from every tab. */}
                        {t === 'shells' && shells.count > 0 ? <span data-shells-count={shells.count} className="ml-1.5 rounded-full bg-[var(--success)] px-1.5 text-[10px] font-semibold text-[var(--bg-1)]">{shells.count}</span> : null}
                    </button>
                ))}
                {/* THE TAB NOTE (the board), right of the tabs: where Files / Changes open; on the Stream, a measurement of the rows. */}
                {(() => { const n = tabNote(rows, active, agent.name, clock()); return n ? <span data-tab-note={n.kind} className="ml-auto truncate font-mono text-[11px] text-[var(--fg-4)]">{n.text}</span> : null; })()}
            </div>

            <div className="flex min-h-0 flex-1">
                {index && indexCollapsed ? (
                    <nav data-index-column="collapsed" className="flex min-h-0 w-[52px] shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-[var(--border-1)] px-1 py-3">
                        <button type="button" data-index-toggle="expand" aria-label="Expand the turns column" title="Expand" onClick={toggleIndex} className="mb-1.5 rounded-md p-1 text-[var(--fg-4)] hover:bg-[var(--bg-1)] hover:text-[var(--fg-2)]">
                            <Icon name="chevron-right" size="xs" />
                        </button>
                        {turnNumbers(index).map((t) => {
                            const door = `genie://agent/${agent.id}?tab=stream&at=${t.rowId}`;
                            return (
                                <button key={t.id} type="button" data-index-number={t.n} {...(t.live ? { 'data-live': t.live } : {})} data-nav={door} title={`Turn ${t.n}`} onClick={() => onNavigate(door)} className={`flex w-full items-center justify-center gap-1 rounded-md py-1 font-mono text-[11px] text-[var(--fg-2)] ${t.selected ? 'bg-[var(--bg-2)]' : 'hover:bg-[var(--bg-1)]'}`}>
                                    {t.live ? <span className={`size-1.5 shrink-0 animate-pulse rounded-full ${INDEX_LIVE[t.live]}`} /> : null}
                                    {t.n}
                                </button>
                            );
                        })}
                    </nav>
                ) : index ? (
                    <nav data-index-column="" className="flex min-h-0 w-[216px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--border-1)] px-2 py-3">
                        {index.map((section, i) => (
                            <div key={section.title} className="mb-3.5 flex shrink-0 flex-col gap-0.5">
                                <h2 className="flex items-center px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">
                                    <span className="flex-1">{section.title}</span>
                                    {i === 0 ? (
                                        <button type="button" data-index-toggle="collapse" aria-label="Collapse the turns column to its numbers" title="Collapse" onClick={toggleIndex} className="rounded-md p-0.5 normal-case hover:bg-[var(--bg-1)] hover:text-[var(--fg-2)]">
                                            <Icon name="chevron-left" size="xs" />
                                        </button>
                                    ) : null}
                                </h2>
                                {section.items.map((item) => {
                                    const door = `genie://agent/${agent.id}?tab=stream&at=${item.rowId}`;
                                    return (
                                        <button
                                            key={item.id}
                                            type="button"
                                            data-index-item={item.id}
                                            {...(item.live ? { 'data-live': item.live } : {})}
                                            data-nav={door}
                                            onClick={() => onNavigate(door)}
                                            className={`flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left ${item.selected ? 'bg-[var(--bg-2)]' : 'hover:bg-[var(--bg-1)]'}`}
                                        >
                                            <span className="flex w-full items-center gap-1.5 text-[12px] text-[var(--fg-1)]">
                                                {item.live ? <span className={`size-1.5 shrink-0 animate-pulse rounded-full ${INDEX_LIVE[item.live]}`} /> : null}
                                                <span className={`truncate ${item.mono ? 'font-mono' : ''}`}>{item.label}</span>
                                            </span>
                                            {item.meta ? <span className="w-full truncate font-mono text-[10px] text-[var(--fg-4)]">{item.meta}</span> : null}
                                        </button>
                                    );
                                })}
                            </div>
                        ))}
                    </nav>
                ) : null}
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    {active === 'stream' ? (
                        <>
                            {timeline ? (
                                <TimelineStrip
                                    timeline={timeline}
                                    lanesOpen={drawerOpen}
                                    onToggleLanes={() => setOwnLanesOpen((open) => !open)}
                                    onOpenRow={(rowId) => onNavigate(`genie://agent/${agent.id}?tab=stream&at=${rowId}`)}
                                    layoutDoor={otherLayout}
                                    onNavigate={onNavigate}
                                    onNextEdit={() => { nextEdit(); }}
                                    filter={lanes}
                                    onFilter={(next) => onLanes?.(next)}
                                />
                            ) : null}
                            {/* The board's empty state draws no chips and no strip: counts over nothing are furniture. */}
                            {layout === 'turns' || rows.length === 0 ? null : <ChipsRow chips={chips} selected={lanes} onChange={(next) => onLanes?.(next)} find={findQuery} onFind={setOwnFind} findRef={findRef} matches={findMatches} />}
                            {drawerOpen ? <Lanes rows={activity} range={range} onRange={(next) => onRange?.(next)} /> : null}

                            <div className="min-h-0 flex-1">
                                {cards ? (
                                    <TurnCards cards={cards} rows={shownRows} agentName={agent.name} selectedId={selectedId} onSelect={onSelect} />
                                ) : (
                                <Stream
                                    rows={shownRows}
                                    findQuery={findQuery}
                                    lanes={lanes}
                                    at={at}
                                    selectedId={selectedId}
                                    cursorId={cursorId}
                                    onSelect={onSelect}
                                    agentName={agent.name}
                                    live={session?.running === true && session.turnState === 'working'}
                                    parked={parkedDivider(session, now ?? (() => Date.now()))}
                                    persona={persona}
                                    onChat={() => onNavigate(chatRoute)}
                                    onEditPersona={() => onNavigate(`genie://agent/${agent.id}?tab=files`)}
                                />
                                )}
                            </div>

                            {/*
                             * THE ERROR CARD (the board): the turn did not finish. The last tool call has no result,
                             * and nothing after the break was received. Inline, at the end — where the reader is.
                             */}
                            {session?.failure ? (
                                <div data-stream-error="" className="mx-5 my-2 shrink-0 rounded-[10px] border border-[var(--danger)] bg-[var(--bg-1)] px-3 py-2 text-[12px]">
                                    <div className="flex items-center gap-2 font-mono text-[12px] text-[var(--danger)]">
                                        <Icon name="circle-alert" size="xs" />
                                        <span>{session.failure.reason}</span>
                                    </div>
                                    <p className="mt-1 text-[var(--fg-3)]">The turn did not finish. The last tool call has no result.</p>
                                </div>
                            ) : null}

                            {/*
                             * Inline, at the END of the stream — where the reader already is
                             * when the agent stops. A question parked at the top of a long
                             * ledger is a question nobody sees.
                             */}
                            {approval && placement === 'stream' ? (
                                <ApprovalCard
                                    approval={approval}
                                    answering={answeringApproval ?? null}
                                    refusal={approvalRefusal ?? null}
                                    onAnswer={(id, note) => onAnswerApproval?.(id, note)}
                                    agentName={agent.name}
                                />
                            ) : null}

                            {approval && placement === 'chat' ? <ApprovalMarker where="the chat" /> : null}
                        </>
                    ) : null}

                    {/* FILES (§4.3): the workspace's ONE file panel, mounted here for the agent's workspace. */}
                    {active === 'files' ? (
                        files && workspace ? (
                            <div className="min-h-0 flex-1">
                                <FilesPanelContainer workspace={workspace} files={files} pinned={false} onPin={() => {}} onClose={() => onNavigate(`genie://agent/${agent.id}?tab=${tabs[0] ?? 'files'}`)} />
                            </div>
                        ) : (
                            <p data-tab-unavailable="files" className="p-5 text-[13px] text-[var(--fg-3)]">
                                {workspace ? 'This window has no file host, so the files cannot be shown here.' : `Genie does not know which workspace ${agent.name} belongs to, so its files cannot be shown.`}
                            </p>
                        )
                    ) : null}

                    {/* CHANGES: the files this agent changed this session (the host's own groups — never a guess), each opening in the panel. */}
                    {active === 'changes' ? (
                        <div className="flex min-h-0 flex-1">
                            <div data-agent-changes={agent.id} className={`${changeOpen ? 'w-72 shrink-0 border-r border-[var(--border-1)]' : 'flex-1'} min-h-0 overflow-y-auto px-5 py-3`}>
                                {changes === null ? (
                                    <p className="text-[13px] text-[var(--fg-3)]">No changes from {agent.name} this session.</p>
                                ) : (
                                    <ul className="flex flex-col gap-0.5">
                                        {changes.map((path) => (
                                            <li key={path}>
                                                <button type="button" data-agent-change={path} onClick={() => setChangeOpen(path)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-[12px] ${changeOpen === path ? 'bg-[var(--bg-3)] text-[var(--fg-1)]' : 'text-[var(--fg-2)] hover:bg-[var(--bg-2)]'}`}>
                                                    <Icon name="file-code" className="h-3.5 w-3.5 shrink-0 text-[var(--success)]" />
                                                    <span className="truncate">{path}</span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                            {changeOpen && files && workspace ? (
                                <div className="min-h-0 min-w-0 flex-1">
                                    <FilesPanelContainer key={changeOpen} workspace={workspace} files={files} pinned={false} single={changeOpen} onPin={() => {}} onClose={() => setChangeOpen(null)} />
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    {/* TERMINAL (observed, §4.2): the TUI's own terminal, attached here as a SECOND view of the same pty (§6.5). */}
                    {/* AGENT SETTINGS (Tynn #800; in sub-tabs since agent-management parity item 3 — the owner, 2026-10-21: "the
                        whole agent settings UX is very clunky with a lot of scrolling and wasted space"). Genie 1's shape: short
                        tabs of labelled fields — General, Permissions, IssueWatch, Persona, Skills — one at a time, the budget as
                        a strip above them. Which tab holds which control is `core/agent-settings-view.ts`. */}
                    {active === 'settings' ? (() => {
                        const sections = settingsSections({
                            fidelity: agent.fidelity, provider: agent.provider, ops: ops !== undefined,
                            model: ops?.onSetModel !== undefined, tools: ops?.onSetPermissions !== undefined, autonomous: ops?.onSetAutoApprove !== undefined,
                            manageTabs: ops?.onSetManageTabs !== undefined, drivePages: ops?.onSetDrivePages !== undefined,
                            issueWatch: ops?.onSetIssueWatch !== undefined && ops.issueWatch !== undefined,
                            persona: persona !== null, skills: session?.extensions != null,
                        });
                        const shown = settingsSectionShown(sections, settingsSectionProp ?? ownSettingsSection);
                        const has = new Set(sections.find((s) => s.id === shown)?.controls ?? []);
                        const beside = controlOutcome(touched, ops?.lastOutcome ?? null);
                        const outcomeFor = (c: SettingsControl) => (beside?.control === c ? <span data-control-outcome={c} className="ml-2 text-[var(--fg-2)]">{beside.text}</span> : null);
                        const touch = (c: SettingsControl) => setTouched({ control: c, before: ops?.lastOutcome ?? null });
                        const rowClass = 'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border-1)] py-2 last:border-b-0';
                        const labelClass = 'w-44 shrink-0 text-[var(--fg-2)]';
                        // ONE short line of help; the whole of it on hover when the row is too narrow to show it.
                        const help = (text: string) => <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--fg-4)]" title={text}>{text}</span>;
                        const selectClass = 'rounded-md border border-[var(--border-1)] bg-transparent px-1 py-0.5';
                        const showStrip = budget || budgetLimit !== null || headroom || policy || session?.mcpServers || note;
                        return (
                            <div data-agent-settings="" className="flex min-h-0 flex-1 flex-col text-xs">
                                {/* BUDGET, a strip (the owner: no half-empty column): context, cost and turns, the limit, the MCP, headroom. */}
                                {showStrip ? (
                                    <section data-rail="budget" data-settings-strip="" className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--border-1)] px-5 py-2 text-[11px] text-[var(--fg-3)]">
                                        {budget ? (
                                            <span className="flex items-center gap-2 font-mono">
                                                ctx {Math.round(budget.used / 1000)}k/{Math.round(budget.size / 1000)}k
                                                <span className="block h-1 w-24 overflow-hidden rounded-sm bg-[var(--bg-3)]">
                                                    <span
                                                        data-budget-bar={budget.pct}
                                                        className={`block h-full ${budget.pct >= 90 ? 'bg-[var(--danger)]' : budget.pct >= 80 ? 'bg-[var(--warning)]' : 'bg-[var(--sky-400)]'}`}
                                                        style={{ width: `${budget.pct}%` }}
                                                    />
                                                </span>
                                            </span>
                                        ) : null}
                                        {/* No Cost at all when the provider reports none (codex): not `$0.00`, which claims the work was free. */}
                                        {budget && budget.cost !== null ? (
                                            <span data-rail-cost className="font-mono">{`$${budget.cost.toFixed(2)} this session · ${budget.turns} turns`}</span>
                                        ) : budget ? (
                                            <span className="font-mono">{budget.turns} turns</span>
                                        ) : null}
                                        {budgetLimit !== null ? (
                                            <span data-budget-limit={budgetLimit} className="text-[var(--warning)]">
                                                limit ${budgetLimit}/day — unenforceable: this provider reports no cost, so nothing will park
                                            </span>
                                        ) : null}
                                        {headroom ? (
                                            <span data-rail-headroom className={`font-mono ${headroom.over || headroom.leftPct < 10 ? 'text-[var(--warning)]' : ''}`}>{headroomLine(headroom)}</span>
                                        ) : null}
                                        {/* Whether this session was STARTED with Genie's MCP — the servers the host handed the driver. */}
                                        {session?.mcpServers ? (
                                            session.mcpServers.includes('genie') ? (
                                                <span data-rail-mcp="given" className="flex items-center gap-2">Genie’s MCP — given to this session <button type="button" data-door="mcp-tools" onClick={() => onNavigate('genie://settings/mcp')} className="rounded-md border border-[var(--border-1)] px-1.5 text-[11px] hover:bg-[var(--bg-2)]">its tools →</button></span>
                                            ) : (
                                                <span data-rail-mcp="missing" className="text-[var(--warning)]">This session was not given Genie’s MCP — it started before the server was listening. Restart it to connect.</span>
                                            )
                                        ) : null}
                                        {/* The note under the bar (the board): compaction expected / compacted at / last reported. */}
                                        {note ? (
                                            <span data-context-note={note.tone} className={`basis-full ${note.tone === 'bad' ? 'text-[var(--danger)]' : note.tone === 'warn' ? 'text-[var(--warning)]' : ''}`}>{note.text}</span>
                                        ) : null}
                                        {policy ? <span data-approval-policy className="basis-full">{policy}</span> : null}
                                    </section>
                                ) : null}

                                {sections.length > 0 ? (
                                    <div role="tablist" data-settings-tabs="" className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--border-1)] px-5">
                                        {sections.map((s) => (
                                            <button
                                                key={s.id}
                                                type="button"
                                                role="tab"
                                                data-settings-tab={s.id}
                                                aria-selected={s.id === shown}
                                                onClick={() => setOwnSettingsSection(s.id)}
                                                className={`rounded-md px-2 py-0.5 text-[12px] ${s.id === shown ? 'bg-[var(--bg-3)] font-medium text-[var(--fg-1)]' : 'text-[var(--fg-3)] hover:bg-[var(--bg-2)]'}`}
                                            >
                                                {s.label}
                                            </button>
                                        ))}
                                    </div>
                                ) : null}

                                {shown ? (
                                    <div className="min-h-0 flex-1 overflow-y-auto">
                                        <div data-settings-section={shown} className="mx-auto max-w-[820px] px-5 py-3">
                                            {/* ── GENERAL: provider and model first (the owner's first ask), mode, run controls; Remove at the foot. */}
                                            {ops && has.has('provider') ? (
                                                <div data-settings-row="provider-model" className="grid grid-cols-1 gap-3 border-b border-[var(--border-1)] pb-3 md:grid-cols-2">
                                                    {/* PROVIDER: the CLI it runs on; changing it is Switch driver — identity, inbox and history stay. */}
                                                    <section data-rail="provider" data-agent-provider={agent.provider}>
                                                        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Provider</h3>
                                                        <Select list={ACP_PROVIDERS.map((p) => ({ value: p, label: p }))} value={agent.provider} onValueChange={(to) => { if (to !== agent.provider) { touch('provider'); ops.onSwitchDriver(to); } }} aria-label={`${agent.name}'s provider`} />
                                                        <p className="mt-1 text-[11px] text-[var(--fg-4)]">Its name, inbox and history stay; its next turn runs on the new provider.{outcomeFor('provider')}</p>
                                                    </section>
                                                    {/* MODEL: the PROVIDER's list (prism-acp 0.22), what the agent starts with, and what it runs. Never one Genie made up. */}
                                                    {has.has('model') ? (() => {
                                                        const choices = ops.models;
                                                        const listed = choices !== undefined && choices !== 'loading' && choices.ok ? choices : null;
                                                        // IN USE: the running session's own answer (modelState) — a provider list asked before any session
                                                        // knows only the provider's default, which is not a reading of this agent.
                                                        const inUseId = listed?.source === 'session' ? listed.current : null;
                                                        const inUse = inUseId === null ? null : listed?.models.find((m) => m.modelId === inUseId) ?? null;
                                                        const reading = inUse ? modelLabel(inUse) : inUseId ?? session?.model ?? null;
                                                        const defaultEntry = listed?.models.find((m) => m.isDefault === true) ?? null;
                                                        const selected = ops.model ?? defaultEntry?.modelId ?? '';
                                                        const selectedEntry = listed?.models.find((m) => m.modelId === selected) ?? null;
                                                        const unlisted = listed && ops.model && !listed.models.some((m) => m.modelId === ops.model) ? ops.model : null;
                                                        const refresh = ops.onRefreshModels ? (
                                                            <button type="button" data-action="models-refresh" onClick={() => ops.onRefreshModels?.()} className="ml-2 rounded-md border border-[var(--border-1)] px-1.5 py-0.5 hover:bg-[var(--bg-2)]">
                                                                Refresh list
                                                            </button>
                                                        ) : null;
                                                        // A running agent switches without a restart (prism-acp 0.22 setModel): Claude's CLI at once, Codex
                                                        // with its next turn. Said as the select's tooltip — one line of help, not a paragraph.
                                                        const applies = agent.provider === 'codex'
                                                            ? `A change applies from ${agent.name}’s next turn — a turn already running finishes on the model it began with.`
                                                            : `A change applies at once — ${agent.name}’s running session switches models on the same conversation.`;
                                                        return (
                                                            <section data-rail-model={session?.model ?? ''} className="text-[11px] text-[var(--fg-3)]">
                                                                {/* The reading: what the provider says it runs — in the heading's place, so the select sits level with the provider's. */}
                                                                <p data-model-reported={reading ? 'yes' : 'no'} className="mb-1 truncate text-[11px]">
                                                                    Model{' '}
                                                                    {reading ? (
                                                                        <span className="font-mono text-[var(--fg-2)]">{reading}</span>
                                                                    ) : ops.model ? (
                                                                        <span className="text-[var(--fg-4)]">not reported yet</span>
                                                                    ) : (
                                                                        <span className="text-[var(--fg-4)]">{"the provider's default"}</span>
                                                                    )}
                                                                </p>
                                                                {/* The owner, 2026-10-21: "make sure that the model selection for agents is using actual available
                                                                    options from the providers". The list is the provider's own answer; free text only when it could not be had. */}
                                                                {choices === 'loading' ? (
                                                                    <p data-model-list="loading" className="text-[var(--fg-4)]">Asking {agent.provider} for its models…</p>
                                                                ) : listed ? (
                                                                    <label data-model-list={listed.source} className="flex items-center" title={applies}>
                                                                        <select
                                                                            data-model-select={selected}
                                                                            value={selected}
                                                                            aria-label={`Start ${agent.name} with`}
                                                                            onChange={(e) => { const next = chosenModel(e.target.value, listed); if (next !== (ops.model ?? null)) { touch('model'); ops.onSetModel?.(next); } }}
                                                                            className={`min-w-0 flex-1 ${selectClass}`}
                                                                        >
                                                                            {defaultEntry ? null : <option value="">{"the provider's default"}</option>}
                                                                            {unlisted ? <option value={unlisted}>{`${unlisted} — not in ${agent.provider}’s list`}</option> : null}
                                                                            {listed.models.map((m) => (
                                                                                <option key={m.modelId} value={m.modelId} title={m.description}>
                                                                                    {`${modelLabel(m)}${m.isDefault ? ' · default' : ''}${m.modelId === inUseId ? ' · in use' : ''}`}
                                                                                </option>
                                                                            ))}
                                                                        </select>
                                                                        {refresh}
                                                                    </label>
                                                                ) : (
                                                                    <>
                                                                        {choices !== undefined && !choices.ok ? (
                                                                            <p data-model-list="failed" className="mb-1 text-[var(--fg-4)]">
                                                                                Couldn’t get {agent.provider}’s list of models: {choices.reason}
                                                                                {refresh}
                                                                            </p>
                                                                        ) : null}
                                                                        <label className="block" title={applies}>
                                                                            Start {agent.name} with
                                                                            {/* The other path, only when the provider's list could not be had: any name the provider
                                                                                accepts, suggesting only the model the provider reported. */}
                                                                            <input
                                                                                key={ops.model ?? ''}
                                                                                data-model-input={ops.model ?? ''}
                                                                                type="text"
                                                                                list={session?.model ? `models-${agent.id}` : undefined}
                                                                                defaultValue={ops.model ?? ''}
                                                                                placeholder="provider default"
                                                                                spellCheck={false}
                                                                                onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v !== (ops.model ?? '')) { touch('model'); ops.onSetModel?.(v === '' ? null : v); } }}
                                                                                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                                                                className="ml-2 w-40 rounded-md border border-[var(--border-1)] bg-transparent px-1 py-0.5 font-mono"
                                                                            />
                                                                            {session?.model ? (
                                                                                <datalist id={`models-${agent.id}`}><option value={session.model} /></datalist>
                                                                            ) : null}
                                                                        </label>
                                                                    </>
                                                                )}
                                                                {selectedEntry?.description || beside?.control === 'model' ? (
                                                                    <p className="mt-1 truncate text-[var(--fg-4)]">
                                                                        {selectedEntry?.description ? <span data-model-description={selectedEntry.modelId}>{selectedEntry.description}</span> : null}
                                                                        {outcomeFor('model')}
                                                                    </p>
                                                                ) : null}
                                                            </section>
                                                        );
                                                    })() : null}
                                                </div>
                                            ) : null}
                                            {ops && has.has('mode') ? (
                                                <div data-rail="mode" data-mode={ops.mode} className={rowClass}>
                                                    <span className={labelClass}>Mode</span>
                                                    <span className="rounded-md bg-[var(--bg-3)] px-2 py-0.5 font-medium">{ops.mode}</span>
                                                    <button type="button" data-action={`mode-${ops.mode === 'manual' ? 'automated' : 'manual'}`} onClick={() => { touch('mode'); ops.onSetMode(ops.mode === 'manual' ? 'automated' : 'manual'); }} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 hover:bg-[var(--bg-2)]">
                                                        switch to {ops.mode === 'manual' ? 'automated' : 'manual'}
                                                    </button>
                                                    {help('Mode is wording for the agent, not a permission boundary.')}
                                                    {outcomeFor('mode')}
                                                </div>
                                            ) : null}
                                            {ops && has.has('run') ? (
                                                <div data-settings-row="run" className={rowClass}>
                                                    <span className={labelClass}>Run</span>
                                                    {runControls(agent, session?.running === true && onStop !== undefined).map((item) => (
                                                        <button key={item.id} type="button" data-run-action={item.id} title={item.hint} onClick={() => { touch('run'); act(item.id); }} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 hover:bg-[var(--bg-2)]">
                                                            {item.label}
                                                        </button>
                                                    ))}
                                                    {outcomeFor('run')}
                                                </div>
                                            ) : null}
                                            {/* REMOVE FROM WORKSPACE (the owner: "purge an agent ... or detach it"): the operations menu's own two items,
                                                set apart at the foot; each opens the same preview-and-confirm as the menu. */}
                                            {ops && has.has('remove') ? (
                                                <div data-settings-remove="" className="mt-6 rounded-lg border border-[var(--border-1)] px-3 py-2">
                                                    <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Remove from workspace</h3>
                                                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                                                        {removeControls(agent).map((item) => (
                                                            <span key={item.id} className="flex items-center gap-2">
                                                                <button type="button" data-remove-action={item.id} onClick={() => { touch('remove'); act(item.id); }} className={`rounded-md border px-2 py-0.5 ${item.danger ? 'border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--bg-2)]' : 'border-[var(--border-1)] hover:bg-[var(--bg-2)]'}`}>
                                                                    {item.label}
                                                                </button>
                                                                <span className="text-[11px] text-[var(--fg-4)]">{item.hint}</span>
                                                            </span>
                                                        ))}
                                                        {outcomeFor('remove')}
                                                    </div>
                                                </div>
                                            ) : null}

                                            {/* ── PERMISSIONS: one row each — label, control, ONE short line; the longer word is the row's tooltip. */}
                                            {ops && has.has('tools') ? (
                                                <label data-settings-row="tools" className={rowClass}>
                                                    <span className={labelClass}>Tools {agent.name} may use</span>
                                                    <select data-permissions={ops.permissions ?? 'all'} value={ops.permissions ?? 'all'} onChange={(e) => { touch('tools'); ops.onSetPermissions?.(e.target.value === 'edits' ? 'edits' : e.target.value === 'ask' ? 'ask' : 'all'); }} className={selectClass}>
                                                        <option value="all">all tools</option>
                                                        <option value="ask">ask me before shell commands</option>
                                                        <option value="edits">edits only — shell refused</option>
                                                    </select>
                                                    {help(`A change applies at once while ${agent.name} is idle, or when its turn ends — it restarts on the same conversation.`)}
                                                    {outcomeFor('tools')}
                                                </label>
                                            ) : null}
                                            {ops && has.has('access') ? (
                                                <label data-settings-row="access" className={rowClass}>
                                                    <span className={labelClass}>Who may message {agent.name}</span>
                                                    <select data-access-scope={ops.accessScope} value={ops.accessScope === 'specific' ? 'self' : ops.accessScope} onChange={(e) => { touch('access'); ops.onSetAccessScope(e.target.value as 'none' | 'self' | 'all'); }} className={selectClass}>
                                                        <option value="none">nobody</option>
                                                        <option value="self">this workspace</option>
                                                        <option value="all">any workspace here</option>
                                                    </select>
                                                    {outcomeFor('access')}
                                                </label>
                                            ) : null}
                                            {ops && has.has('autonomous') ? (
                                                <label data-settings-row="autonomous" className={rowClass} title="Each one is recorded. Genie keeps an engine’s data on every remove; deleting data is always yours. Creating an agent always asks you. Applies to its next action.">
                                                    <span className={labelClass}>Autonomous</span>
                                                    <span data-auto-approve={ops.autoApprove ? 'on' : 'off'}><Switch checked={ops.autoApprove === true} onCheckedChange={(checked) => { touch('autonomous'); ops.onSetAutoApprove?.(checked); }} aria-label={`${agent.name} is autonomous`} /></span>
                                                    {help(`${agent.name} sets up services, processes, sites and terminals without asking you.${agent.provider === 'codex' ? ' Codex runs commands and edits files without asking, outside its sandbox.' : ''}`)}
                                                    {outcomeFor('autonomous')}
                                                </label>
                                            ) : null}
                                            {ops && has.has('manage-tabs') ? (
                                                <label data-settings-row="manage-tabs" className={rowClass} title={`The workspace’s default agent always can. Each change asks you unless ${agent.name} is autonomous.`}>
                                                    <span className={labelClass}>May manage workspace tabs</span>
                                                    <span data-manage-tabs={ops.manageTabs ? 'on' : 'off'}><Switch checked={ops.manageTabs === true} onCheckedChange={(checked) => { touch('manage-tabs'); ops.onSetManageTabs?.(checked); }} aria-label={`${agent.name} may manage workspace tabs`} /></span>
                                                    {help(`${agent.name} can add, arrange and remove this workspace’s tabs and their panels.`)}
                                                    {outcomeFor('manage-tabs')}
                                                </label>
                                            ) : null}
                                            {ops && has.has('drive-pages') ? (
                                                <label data-settings-row="drive-pages" className={rowClass} title={`The workspace’s default agent always can. A submit, or a click that changes or deletes something, always asks you first — even when ${agent.name} is autonomous.`}>
                                                    <span className={labelClass}>May drive pages</span>
                                                    <span data-drive-pages={ops.drivePages ? 'on' : 'off'}><Switch checked={ops.drivePages === true} onCheckedChange={(checked) => { touch('drive-pages'); ops.onSetDrivePages?.(checked); }} aria-label={`${agent.name} may drive pages`} /></span>
                                                    {help(`${agent.name} can read this workspace’s Genie site pages, fill their fields and click through them.`)}
                                                    {outcomeFor('drive-pages')}
                                                </label>
                                            ) : null}

                                            {/* ── ISSUEWATCH: delivery, then the kinds in three groups. */}
                                            {ops?.onSetIssueWatch && ops.issueWatch && has.has('issuewatch') ? (
                                                <IssueWatchSettings name={agent.name} prefs={ops.issueWatch} onSet={(s) => { touch('issuewatch'); ops.onSetIssueWatch?.(s); }} outcome={outcomeFor('issuewatch')} />
                                            ) : null}

                                            {/* ── PERSONA: read-only here (editing is a later item). */}
                                            {persona && has.has('persona') ? (
                                                <section data-rail="persona">
                                                    <p className="font-mono text-[11px] text-[var(--fg-2)]">
                                                        {persona}
                                                        {/* The board's `· committed`: git's own word on the file the session runs on; nothing when git said nothing. */}
                                                        {personaGitShown ? <> · <span data-persona-git={personaGitShown} className={personaGitShown === 'committed' ? 'text-[var(--fg-3)]' : 'text-[var(--warning)]'}>{personaGitShown === 'committed' ? 'committed' : personaGitShown === 'modified' ? 'uncommitted changes' : 'not committed'}</span></> : null}
                                                    </p>
                                                    {personaShown ? (
                                                        <pre data-persona-text="" className="mt-2 whitespace-pre-wrap rounded-md bg-[var(--bg-1)] px-2.5 py-2 font-mono text-[11.5px] leading-[19px] text-[var(--fg-2)]">{personaShown.lines.join('\n')}</pre>
                                                    ) : null}
                                                    {personaShown?.truncated ? <p data-persona-clipped="" className="mt-1 text-[11px] text-[var(--fg-4)]">… more in the file</p> : null}
                                                    {personaError ? <p data-persona-error="" className="mt-1 text-[11px] text-[var(--warning)]">could not read it: {personaError}</p> : null}
                                                </section>
                                            ) : null}

                                            {/* ── SKILLS: what the agent's OWN CLI can run (the owner, 2026-10-14), read-only; run one from the chat's `/` menu. */}
                                            {session?.extensions && has.has('skills') ? (
                                                <section data-rail="extensions">
                                                    <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Skills and commands</h3>
                                                    {session.extensions.commands.length === 0 ? (
                                                        <p className="text-[11px] text-[var(--fg-3)]">Its CLI offers none.</p>
                                                    ) : (
                                                        <ul data-rail-commands={session.extensions.commands.length} className="grid grid-cols-1 gap-x-6 font-mono text-[11px] text-[var(--fg-2)] md:grid-cols-2">
                                                            {session.extensions.commands.map((c) => (
                                                                <li key={c.name} data-command={c.name} className="flex justify-between gap-2 py-px">
                                                                    <span className="truncate">/{c.name}</span>
                                                                    <span className="shrink-0 truncate font-sans text-[var(--fg-4)]">{c.source ?? c.description}</span>
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    )}
                                                    {session.extensions.plugins && session.extensions.plugins.length > 0 ? (
                                                        <p data-rail-plugins={session.extensions.plugins.length} className="mt-1.5 text-[11px] leading-normal text-[var(--fg-3)]">
                                                            Plugins: {session.extensions.plugins.map((p) => (p.version ? `${p.name} ${p.version}` : p.name)).join(', ')}
                                                        </p>
                                                    ) : null}
                                                    {session.extensions.subagents && session.extensions.subagents.length > 0 ? (
                                                        <p data-rail-subagents={session.extensions.subagents.length} className="mt-1 text-[11px] leading-normal text-[var(--fg-3)]">
                                                            Subagents: {session.extensions.subagents.join(', ')}
                                                        </p>
                                                    ) : null}
                                                </section>
                                            ) : null}
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        );
                    })() : null}

                    {active === 'shells' ? <ShellsPanel shells={shells} agentName={agent.name} provider={agent.provider} /> : null}

                    {active === 'terminal' ? (
                        takeOver && terminals ? (
                            <ObservedTerminal key={takeOver.terminalId} terminalId={takeOver.terminalId} terminals={terminals} />
                        ) : (
                            <p data-tab-unavailable="terminal" className="p-5 text-[13px] text-[var(--fg-3)]">
                                {takeOver ? 'This window has no terminal host, so the TUI cannot be shown here.' : `${agent.name}'s Take Over window is not open, so there is no terminal to show.`}
                            </p>
                        )
                    ) : null}

                    {/* ACTIVITY (observed): what Genie measured — bytes and when — and nothing it did not. */}
                    {active === 'activity' ? (
                        takeOver ? (
                            <div data-observed-activity={agent.id} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
                                <div className="flex items-center gap-4">
                                    <div className="flex h-4 items-end gap-0.5 text-[var(--fg-4)]" title="Output over the last minute, in 5-second buckets">
                                        {activityBars(takeOver.bursts, clock()).map((b, i) => (
                                            <span key={i} data-activity-bar={i} className="w-[3px] rounded-[1px] bg-current" style={{ height: `${Math.max(1, b)}px` }} />
                                        ))}
                                    </div>
                                    <span className="font-mono text-[11px] text-[var(--fg-3)]">{lastOutputLabel(takeOver.lastOutputAt, clock())}</span>
                                </div>
                                {/* THE OUTPUT TIMELINE (the board's blind state): bytes out across the window's whole life, and the total. */}
                                <div className="flex items-center gap-4">
                                    <div data-output-histogram={agent.id} className="flex h-4 items-end gap-0.5 text-[var(--fg-4)]" title="Output over the whole window, start to now">
                                        {outputHistogram(takeOver.bursts, takeOver.startedAt, clock()).map((b, i) => (
                                            <span key={i} data-output-bar={i} className="w-[3px] rounded-[1px] bg-current" style={{ height: `${Math.max(1, b)}px` }} />
                                        ))}
                                    </div>
                                    <span data-output-total="" className="font-mono text-[11px] text-[var(--fg-3)]">{outputTotalLabel(takeOver.bursts, takeOver.startedAt, clock())}</span>
                                </div>
                                <ul className="flex flex-col divide-y divide-[var(--border-1)] text-[12px]">
                                    {activityLedger(takeOver.bursts).map((r) => (
                                        <li key={r.at} data-activity-burst={r.at} className="flex items-center gap-3 py-1">
                                            <span className="font-mono text-[11px] text-[var(--fg-4)]">{new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                            <Icon name="square-terminal" className="h-3.5 w-3.5 text-[var(--fg-3)]" />
                                            <span className="font-mono text-[var(--fg-2)]">{r.label}</span>
                                        </li>
                                    ))}
                                </ul>
                                {/* FILES WRITTEN (the board's blind index): what changed on disk since this window opened. Not attributed — Genie does not guess the author. */}
                                {diskChanges ? (() => {
                                    const written = diskChanges.filter((c) => c.at >= takeOver.startedAt);
                                    return (
                                        <section data-observed-files-written={agent.id} className="flex flex-col gap-1">
                                            <h3 className="text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Files written on disk since this window opened · not attributed</h3>
                                            {written.length === 0 ? (
                                                <p data-observed-files-none="" className="text-[12px] text-[var(--fg-3)]">None yet.</p>
                                            ) : (
                                                <ul className="flex flex-col divide-y divide-[var(--border-1)] text-[12px]">
                                                    {written.map((c) => (
                                                        <li key={c.path} data-observed-file={c.path} className="flex items-center gap-3 py-1">
                                                            <span className="font-mono text-[11px] text-[var(--fg-4)]">{new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                                                            <span className="font-mono text-[var(--fg-2)]">{c.path}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                        </section>
                                    );
                                })() : null}
                                {/* COMMITS (the board's blind index): git's own account of the workspace's repos since this window opened. */}
                                {commits ? (
                                    <section data-observed-commits={agent.id} className="flex flex-col gap-1">
                                        <h3 className="text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Commits since this window opened</h3>
                                        {commits.length === 0 ? (
                                            <p data-observed-commits-none="" className="text-[12px] text-[var(--fg-3)]">None yet.</p>
                                        ) : (
                                            <ul className="flex flex-col divide-y divide-[var(--border-1)] text-[12px]">
                                                {commits.map((c) => (
                                                    <li key={`${c.repo}:${c.sha}`} data-observed-commit={c.sha} className="flex items-center gap-3 py-1">
                                                        <span className="font-mono text-[11px] text-[var(--fg-4)]">{c.sha}</span>
                                                        <span className="min-w-0 flex-1 truncate text-[var(--fg-2)]">{c.subject}</span>
                                                        <span className="shrink-0 font-mono text-[11px] text-[var(--fg-4)]">{c.author} · {c.repo}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </section>
                                ) : null}
                            </div>
                        ) : (
                            <p data-tab-unavailable="activity" className="p-5 text-[13px] text-[var(--fg-3)]">{agent.name}'s Take Over window is not open, so there is no activity to measure.</p>
                        )
                    ) : null}
                </div>

                {/*
                 * The right column, ONE 380px panel (the board): the Inspector — a diff, a tool's
                 * arguments — above Plan / Context / Cost. Inside the Agent view's own grid — **it
                 * is not a dock.** The dock slot belongs to chat, files and lists, and at most one
                 * of those is pinned at a time; this column is part of this surface and does not
                 * compete for that slot. The Inspector competes with the stream's height, never
                 * with the right edge, and never pushes the stream sideways: the stream shrinks.
                 */}
                {/*
                 * *"A section that can never populate is not drawn for that agent — absence of
                 * the rail, not an empty rail."*
                 *
                 * The first screenshot of this screen showed a 260px column with a left border
                 * and nothing inside it. An empty bordered panel reads as one that failed to
                 * load, and it costs a fifth of the width of the screen that matters most.
                 *
                 * EITHER panel is enough to draw it. Requiring both would hide a context
                 * warning on an agent that never reported a plan, which is most of them.
                 */}
                {railModeNow === 'strip' && !railOpen && railText ? (
                    <div data-right-column="strip" className="flex h-8 w-8 shrink-0 flex-col items-center border-l border-[var(--border-1)] bg-[var(--bg-1)]">
                        <button type="button" data-action="expand-rail" title={railText} onClick={() => setRailOpen(true)} className="flex h-full w-full items-center justify-center text-[var(--fg-3)] hover:bg-[var(--bg-2)]">
                            <Icon name="panel-right" size="xs" />
                        </button>
                        <span className="sr-only">{railText}</span>
                    </div>
                ) : null}
                {showColumn && (inspector || ended || termBlock) ? (
                <aside data-right-column="" className={`flex min-h-0 w-[380px] shrink-0 flex-col border-l border-[var(--border-1)] ${railModeNow === 'strip' ? 'absolute right-0 top-0 z-20 h-full bg-[var(--surface)] shadow-xl' : ''}`}>
                {railModeNow === 'strip' ? (
                    <button type="button" data-action="collapse-rail" onClick={() => setRailOpen(false)} className="flex h-7 shrink-0 items-center gap-1.5 border-b border-[var(--border-1)] px-3 text-[11px] text-[var(--fg-3)] hover:bg-[var(--bg-2)]">Close</button>
                ) : null}
                {inspector ? <Inspector content={inspector} onClose={() => onSelect(null)} embedded header={diffHeader(rows, selectedId)} filesRoute={`genie://agent/${agent.id}?tab=files`} onNavigate={onNavigate} onRevert={revertSelected ?? undefined} revertOutcome={revertOutcome} /> : null}
                {ended || termBlock ? (
                <div data-rail-column className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 text-xs">
                    {/* THE PERSONA (the board's empty state): the one thing known before the first turn, so it is on screen. */}
                    {termBlock ? (
                        <section data-rail="terminal" className="flex flex-col gap-2">
                            <div className="flex items-center gap-2 text-[12px]">
                                <Icon name="square-terminal" size="xs" className="text-[var(--fg-3)]" />
                                <span className="font-semibold">Terminal</span>
                                <span className="text-[11px] text-[var(--fg-4)]">live, read-only here</span>
                                <span className="flex-1" />
                                {onTakeOver ? (
                                    <button type="button" data-action="take-over-rail" onClick={() => onTakeOver(agent.id)} className="flex items-center gap-1.5 text-[12px] text-[var(--fg-2)] hover:underline">
                                        Take over
                                        <span className="font-mono text-[10px] text-[var(--fg-4)]">⌘⇧T</span>
                                    </button>
                                ) : null}
                            </div>
                            <p className="font-mono text-[11px] text-[var(--fg-3)]">{lastOutputLabel(termBlock.lastOutputAt, clock())}</p>
                            <p className="text-[12px] leading-normal text-[var(--fg-2)]">{agent.provider} runs in a terminal and reports no conversation, plan, context or cost. Genie sees its terminal output.</p>
                        </section>
                    ) : null}
                    {ended ? (
                        <section data-rail="process-ended" className="flex flex-col gap-2">
                            <h2 className="flex items-center gap-2 text-[12px] font-semibold text-[var(--danger)]">
                                <Icon name="circle-alert" size="xs" />
                                Process ended
                            </h2>
                            <p className="font-mono text-[11px] leading-[17px] text-[var(--fg-2)]">{ended.reason}</p>
                            {ended.lastTool ? <p data-last-tool="" className="font-mono text-[11px] text-[var(--fg-3)]">last call, no result: {ended.lastTool}</p> : null}
                            {ended.exit ? <p data-exit={ended.exit} className="font-mono text-[11px] text-[var(--fg-3)]">{ended.exit}</p> : null}
                            {ended.log ? <pre data-process-log="" className="max-h-40 overflow-hidden whitespace-pre-wrap rounded-md bg-[var(--bg-2)] px-2.5 py-2 font-mono text-[11px] leading-[17px] text-[var(--fg-2)]">{ended.log}</pre> : null}
                            <div className="flex items-center gap-2">
                                {ops ? (
                                    <button type="button" data-action="restart-resume" onClick={() => ops.onRestart('graceful')} className="flex h-[26px] items-center rounded-lg border border-[var(--primary-hover)] bg-[var(--primary)] px-2.5 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)]">Restart and resume</button>
                                ) : null}
                                {/* The board's `Open terminal` in the block: a Take Over window on this agent — the same door the header offers, where the reader is looking. */}
                                {onTakeOver ? <button type="button" data-action="open-terminal-rail" onClick={() => onTakeOver(agent.id)} className="flex h-[26px] items-center rounded-lg border border-[var(--border-1)] px-2.5 text-[12px] text-[var(--fg-2)] hover:bg-[var(--bg-2)]">Open terminal</button> : null}
                                <button type="button" data-action="copy-log" onClick={() => { void navigator.clipboard?.writeText([ended.reason, ended.lastTool ?? '', ended.log].filter(Boolean).join('\n')); }} className="flex h-[26px] items-center rounded-lg px-2.5 text-[12px] text-[var(--fg-3)] hover:bg-[var(--bg-2)]">Copy log</button>
                            </div>
                        </section>
                    ) : null}


                </div>
                ) : null}
                </aside>
                ) : null}
                {/*
                 * THE ACTIVE PLAN COLUMN (the owner, 2026-10-19: "Genie needs to include an Active Plan column in the agent
                 * view to the left of the chat"): its own column, the view's LAST — directly left of the docked chat — and
                 * always there for an agent that reports plans. Before any plan it says so; an agent seen only through its
                 * terminal reports none, so it has no column.
                 */}
                {agent.fidelity !== 'observed' && planOpen ? (
                    <aside data-plan-column="" className="flex min-h-0 w-[260px] shrink-0 flex-col gap-1.5 overflow-y-auto border-l border-[var(--border-1)] bg-[var(--bg-1)] p-4 text-xs">
                        <h2 className="text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Active plan</h2>
                        {plan ? (
                            <>
                                <p className="font-mono text-[11px] text-[var(--fg-3)]">
                                    {plan.step}/{plan.of}
                                </p>
                                {steps ? (
                                <ol className="mt-1.5 flex flex-col gap-1">
                                    {steps.map((step, i) => (
                                        <li key={i} data-plan-step={step.status} {...(step.current ? { 'data-current': 'true' } : {})} className={`flex items-start gap-1.5 text-[12px] ${step.current ? 'font-semibold text-[var(--fg-1)]' : step.status === 'completed' ? 'text-[var(--fg-3)]' : 'text-[var(--fg-2)]'}`}>
                                            <span className={`w-3 shrink-0 ${step.status === 'completed' ? 'text-[var(--success)]' : step.current ? 'text-[var(--sky-400)]' : 'text-[var(--fg-4)]'}`}>{step.status === 'completed' ? '✓' : step.current ? '◐' : '○'}</span>
                                            <span className="min-w-0">{step.content}</span>
                                        </li>
                                    ))}
                                </ol>
                            ) : (
                                <p className="mt-1 text-[var(--fg-2)]">{plan.doing}</p>
                            )}
                            </>
                        ) : (
                            <p className="text-[12px] leading-normal text-[var(--fg-3)]">{agent.name} has not reported a plan yet.</p>
                        )}
                    </aside>
                ) : null}
            </div>
        </div>
    );
}

/**
 * WHAT THIS AGENT HEARS FROM ISSUEWATCH (Tynn #806; the owner: "the granularity is set in genie in the agent settings").
 * How it hears — pushed as a turn, on its next turn, only the count on imDone, or not at all — and a box per kind. Never
 * set, it says so: the workspace's first agent hears the default kinds, every other agent nothing.
 */
function IssueWatchSettings({ name, prefs, onSet, outcome }: { name: string; prefs: IssueWatchPrefs; onSet: (setting: IssueWatchSetting) => void; outcome?: ReactNode }) {
    return (
        <div data-issue-watch="" className="text-[11px] text-[var(--fg-3)]">
            <label className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[var(--fg-2)]">GitHub, through IssueWatch: {name} hears it</span>
                <select data-issue-watch-delivery={prefs.delivery} value={prefs.delivery} onChange={(e) => onSet({ delivery: e.target.value as IwDelivery, kinds: prefs.kinds })} className="rounded-md border border-[var(--border-1)] bg-transparent px-1 py-0.5">
                    {IW_DELIVERIES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
                {outcome}
            </label>
            {prefs.chosen ? null : (
                <span data-issue-watch-default="" className="mt-1 block text-[var(--fg-4)]">
                    {prefs.delivery === 'off' ? 'Never set: the workspace’s first agent hears GitHub, so this one does not.' : 'Never set: as the workspace’s first agent, it hears new issues, pull requests, security alerts and feedback.'}
                </span>
            )}
            {/* The kinds in three short groups side by side (agent-management parity item 3), each kind's default marked. */}
            <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-3">
                {issueWatchGroups().map((g) => (
                    <fieldset key={g.label} data-iw-group={g.label} className="min-w-0">
                        <legend className="mb-1 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">{g.label}</legend>
                        <div className="grid gap-1">
                            {g.kinds.map((k) => (
                                <label key={k.kind} title={k.label} className={`flex items-center gap-2 ${prefs.delivery === 'off' ? 'opacity-60' : ''}`}>
                                    <input
                                        type="checkbox"
                                        data-issue-watch-kind={k.kind}
                                        checked={prefs.kinds.includes(k.kind)}
                                        disabled={prefs.delivery === 'off'}
                                        onChange={(e) => onSet({ delivery: prefs.delivery, kinds: e.target.checked ? [...prefs.kinds, k.kind] : prefs.kinds.filter((x) => x !== k.kind) })}
                                    />
                                    <span className="truncate">{k.label}</span>
                                    {k.default ? <span data-iw-default={k.kind} className="shrink-0 text-[var(--fg-4)]">· default</span> : null}
                                </label>
                            ))}
                        </div>
                    </fieldset>
                ))}
            </div>
        </div>
    );
}
