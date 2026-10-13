import { activityRows } from '../../core/stream-view.js';
import { headroomLine, headroomOf } from '../../core/headroom.js';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { activityBars, outputHistogram, outputTotalLabel, activityLedger, lastOutputLabel, type TakeOverProbe } from '../../core/observed.js';
import { contextNote, diffHeader, headerActions, personaView, planSteps, processEnded, railMode, railSummary, tabNote } from '../../core/agent-view.js';
import { agentIndex, type IndexLive } from '../../core/agent-index.js';
import { FidelityDot } from './Dashboard.js';
import type { TerminalPaneProps } from './TerminalPane.js';
import { Dropdown, Icon } from '@particle-academy/react-fancy';
import { agentChanges } from '../../core/agent-changes.js';
import type { GenieBridge } from '../bridge.js';
import { FilesPanelContainer } from './FilesPanelContainer.js';
import { agentOpsMenu } from '../../core/agent-ops-menu.js';
import type { DeletePlan } from '../../core/agent-ops.js';
import type { Diagnosis, Repair } from '../../core/workspace-model.js';
import { approvalPlacement, approvalPolicySentence, budgetFor, parkedDivider, planFor, statePill, tabsFor } from '../../core/agent-view.js';
import { ApprovalCard, ApprovalMarker } from './ApprovalCard.js';
import type { Fidelity } from '../../core/dashboard-view.js';
import { inspectorFor } from '../../core/inspector.js';
import type { LiveSession } from '../../core/roster.js';
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
    terminal: 'Terminal',
    activity: 'Activity',
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
    /** A Claude agent's tools: all, or edits only (shell refused). Absent = no control (a window that cannot set it). */
    readonly permissions?: 'all' | 'edits';
    readonly onSetPermissions?: (permissions: 'all' | 'edits') => void;
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
    /** `null` unless an answer is in flight. */
    answeringApproval?: string | null | undefined;
    onAnswerApproval?: ((optionId: string) => void) | undefined;
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
    /** `Stop` while a turn runs (the board): stop the agent's work — §6.2 stop, everything about it kept. */
    onStop?: ((agentId: string) => void) | undefined;
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
    chatSubject, answeringApproval, onAnswerApproval, onLanes, range = null, onRange, onTakeOver, ops,
    files, workspace, initialChanges, initialDiskChanges, readCommits, initialCommits, takeOver = null, terminals, onStop, lanesOpen: lanesOpenProp, find: findProp, log = [], layout = 'ledger', personaText: personaTextProp, personaError: personaErrorProp = null, personaGit: personaGitProp, width: widthProp,
}: AgentViewProps) {
    const tabs = tabsFor(agent.fidelity);
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
    const menu = ops ? agentOpsMenu(agent) : [];
    const act = (id: string) => {
        if (!ops) return;
        if (id === 'restart-graceful') ops.onRestart('graceful');
        else if (id === 'restart-fresh') ops.onRestart('fresh');
        else if (id.startsWith('switch:')) ops.onSwitchDriver(id.slice('switch:'.length));
        else if (id === 'diagnose') ops.onDiagnose();
        else if (id === 'delete-unmount') ops.onPreviewDelete('unmount');
        else if (id === 'delete-delete') ops.onPreviewDelete('delete');
    };
    const budgetLimit = ops?.budgetUsd ?? null;
    const plan = planFor(session);
    // The plan's steps (the board): from the latest plan update in the rows; null keeps the step/of line alone.
    const steps = planSteps(rows);
    const budget = budgetFor(session, cost, turns);
    // The provider's headroom (the board's rail row): the latest rate-limit reading in the ledger; none, no row.
    const headroom = headroomOf(rows);
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
    const index = active === 'stream' ? agentIndex(rows, session, workspace?.path ?? null, selectedId) : null;
    // THE SESSION TIMELINE STRIP + CHIPS ROW (the board); the Lanes drawer behind `L`.
    // The activity the Stream shows (replies live in the chat): the strip, the find and the lanes read the same rows.
    const activity = activityRows(rows);
    const timeline = active === 'stream' ? sessionTimeline(activity, session) : null;
    const chips = chipRow(rows, lanes);
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
                    // `E` is a search ("find me the next one"): it opens the edit it lands on, and the cursor follows.
                    const next = nextEditAfter(rowsInRange(rows, range), selectedId);
                    if (!next) return;
                    e.preventDefault();
                    setCursorId(next);
                    onSelect(next);
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
                {workspace ? <span data-crumb={workspace.id} className="text-[13px] text-[var(--fg-3)]">{workspace.name ?? workspace.id} /</span> : null}
                <FidelityDot fidelity={agent.fidelity} state={pill.tone === 'ok' ? 'working' : pill.tone === 'warn' ? 'waiting' : pill.tone === 'bad' ? 'broken' : 'idle'} />
                <span className="font-medium">{agent.name}</span>
                <span data-provider-chip={agent.provider} className="rounded-sm bg-[var(--bg-2)] px-1.5 py-px font-mono text-[11px] text-[var(--fg-3)]">{agent.provider} · {agent.fidelity === 'observed' ? 'pty' : 'ACP'}</span>
                <span className="truncate font-mono text-[11px] text-[var(--fg-4)]" title={agent.cwd}>{agent.cwd}</span>

                <span data-pill={pill.word} className={`flex items-center gap-1.5 text-xs ${PILL_TONE[pill.tone]}`}>
                    <span className="size-1.5 rounded-full bg-current" />
                    {pill.word}
                    {/* A clock only while a turn runs. On an idle agent it counts up forever
                        and reads as work in progress. */}
                    {pill.elapsed ? <span className="font-mono tabular-nums">{pill.elapsed}</span> : null}
                </span>

                <div className="ml-auto flex items-center gap-1">
                    {/* STOP, while a turn runs (the board). Stop means stop (§6.2): identity, persona, inbox and history kept. */}
                    {actions.stop ? (
                        <button type="button" data-action="stop" title="Stop — the agent's work ends; everything about it is kept" onClick={() => onStop?.(agent.id)} className="flex items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]">
                            <Icon name="square" size="xs" />
                            Stop
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
                     * linkable and the subject lives in the URL.
                     */}
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

                    <button
                        type="button"
                        data-action="take-over"
                        onClick={() => onTakeOver?.(agent.id)}
                        className="flex items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]"
                    >
                        <Icon name="square-terminal" size="xs" />
                        Take over
                        <span className="font-mono text-[10px] text-[var(--fg-4)]">⌘⇧T</span>
                    </button>
                    {/* In the error state (the board): the Take Over window IS the terminal. */}
                    {actions.openTerminal ? (
                        <button type="button" data-action="open-terminal" onClick={() => onTakeOver?.(agent.id)} className="flex items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]">
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
                    </button>
                ))}
                {/* THE TAB NOTE (the board), right of the tabs: where Files / Changes open; on the Stream, a measurement of the rows. */}
                {(() => { const n = tabNote(rows, active, agent.name, clock()); return n ? <span data-tab-note={n.kind} className="ml-auto truncate font-mono text-[11px] text-[var(--fg-4)]">{n.text}</span> : null; })()}
            </div>

            <div className="flex min-h-0 flex-1">
                {index ? (
                    <nav data-index-column="" className="flex w-[216px] shrink-0 flex-col gap-0.5 overflow-hidden border-r border-[var(--border-1)] px-2 py-3">
                        {index.map((section) => (
                            <div key={section.title} className="mb-3.5 flex flex-col gap-0.5">
                                <h2 className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">{section.title}</h2>
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
                                    onAnswer={(id) => onAnswerApproval?.(id)}
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
                {showColumn && (inspector || plan || budget || budgetLimit !== null || headroom || policy || session?.mcpServers || ops || persona || ended || termBlock) ? (
                <aside data-right-column="" className={`flex min-h-0 w-[380px] shrink-0 flex-col border-l border-[var(--border-1)] ${railModeNow === 'strip' ? 'absolute right-0 top-0 z-20 h-full bg-[var(--surface)] shadow-xl' : ''}`}>
                {railModeNow === 'strip' ? (
                    <button type="button" data-action="collapse-rail" onClick={() => setRailOpen(false)} className="flex h-7 shrink-0 items-center gap-1.5 border-b border-[var(--border-1)] px-3 text-[11px] text-[var(--fg-3)] hover:bg-[var(--bg-2)]">Close</button>
                ) : null}
                {inspector ? <Inspector content={inspector} onClose={() => onSelect(null)} embedded header={diffHeader(rows, selectedId)} filesRoute={`genie://agent/${agent.id}?tab=files`} onNavigate={onNavigate} onRevert={revertSelected ?? undefined} revertOutcome={revertOutcome} /> : null}
                {plan || budget || budgetLimit !== null || headroom || policy || session?.mcpServers || ops || persona || ended || termBlock ? (
                <div data-rail-column className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 text-xs">
                    {/* THE PERSONA (the board's empty state): the one thing known before the first turn, so it is on screen. */}
                    {termBlock ? (
                        <section data-rail="terminal" className="flex flex-col gap-2">
                            <div className="flex items-center gap-2 text-[12px]">
                                <Icon name="square-terminal" size="xs" className="text-[var(--fg-3)]" />
                                <span className="font-semibold">Terminal</span>
                                <span className="text-[11px] text-[var(--fg-4)]">live, read-only here</span>
                                <span className="flex-1" />
                                <button type="button" data-action="take-over-rail" onClick={() => onTakeOver?.(agent.id)} className="flex items-center gap-1.5 text-[12px] text-[var(--fg-2)] hover:underline">
                                    Take over
                                    <span className="font-mono text-[10px] text-[var(--fg-4)]">⌘⇧T</span>
                                </button>
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
                                <button type="button" data-action="open-terminal-rail" onClick={() => onTakeOver?.(agent.id)} className="flex h-[26px] items-center rounded-lg border border-[var(--border-1)] px-2.5 text-[12px] text-[var(--fg-2)] hover:bg-[var(--bg-2)]">Open terminal</button>
                                <button type="button" data-action="copy-log" onClick={() => { void navigator.clipboard?.writeText([ended.reason, ended.lastTool ?? '', ended.log].filter(Boolean).join('\n')); }} className="flex h-[26px] items-center rounded-lg px-2.5 text-[12px] text-[var(--fg-3)] hover:bg-[var(--bg-2)]">Copy log</button>
                            </div>
                        </section>
                    ) : null}
                    {persona ? (
                        <section data-rail="persona">
                            <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Persona</h2>
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
                    {/*
                     * Plan and Budget are ABSENT before the first turn, not empty. An empty plan
                     * panel reads as an agent working without a plan; the truth is that it has
                     * not said what its plan is yet.
                     */}
                    {plan ? (
                        <section data-rail="plan">
                            <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">
                                Plan
                            </h2>
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
                        </section>
                    ) : null}

                    {ops ? (
                        <section data-rail="mode" data-mode={ops.mode}>
                            <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Mode</h2>
                            <div className="flex items-center gap-1 text-[11px]">
                                <span className="rounded-md bg-[var(--bg-3)] px-2 py-0.5 font-medium">{ops.mode}</span>
                                <button type="button" data-action={`mode-${ops.mode === 'manual' ? 'automated' : 'manual'}`} onClick={() => ops.onSetMode(ops.mode === 'manual' ? 'automated' : 'manual')} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 hover:bg-[var(--bg-2)]">
                                    switch to {ops.mode === 'manual' ? 'automated' : 'manual'}
                                </button>
                            </div>
                            <p className="mt-1 text-[11px] text-[var(--fg-4)]">Mode is wording for the agent, not a permission boundary.</p>
                            {/* A Claude session cannot ask mid-turn, so what it may do is chosen here; Codex asks in the chat. */}
                            {agent.provider === 'claude' && ops.onSetPermissions ? (
                                <label className="mt-2 block text-[11px] text-[var(--fg-3)]">
                                    Tools {agent.name} may use
                                    <select data-permissions={ops.permissions ?? 'all'} value={ops.permissions ?? 'all'} onChange={(e) => ops.onSetPermissions?.(e.target.value === 'edits' ? 'edits' : 'all')} className="ml-2 rounded-md border border-[var(--border-1)] bg-transparent px-1 py-0.5">
                                        <option value="all">all tools</option>
                                        <option value="edits">edits only — shell refused</option>
                                    </select>
                                    <span className="mt-0.5 block text-[var(--fg-4)]">A change applies when {agent.name} next starts.</span>
                                </label>
                            ) : null}
                            <label className="mt-2 block text-[11px] text-[var(--fg-3)]">
                                Who may message {agent.name}
                                <select data-access-scope={ops.accessScope} value={ops.accessScope === 'specific' ? 'self' : ops.accessScope} onChange={(e) => ops.onSetAccessScope(e.target.value as 'none' | 'self' | 'all')} className="ml-2 rounded-md border border-[var(--border-1)] bg-transparent px-1 py-0.5">
                                    <option value="none">nobody</option>
                                    <option value="self">this workspace</option>
                                    <option value="all">any workspace here</option>
                                </select>
                            </label>
                        </section>
                    ) : null}

                    {budget || budgetLimit !== null || headroom || policy || session?.mcpServers ? (
                        <section data-rail="budget">
                            <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">
                                Budget
                            </h2>
                            {budgetLimit !== null ? (
                                <p data-budget-limit={budgetLimit} className="mb-1.5 text-[11px] text-[var(--warning)]">
                                    limit ${budgetLimit}/day — unenforceable: this provider reports no cost, so nothing will park
                                </p>
                            ) : null}
                            {budget ? (
                            <p className="font-mono text-[11px] text-[var(--fg-3)]">
                                ctx {Math.round(budget.used / 1000)}k/{Math.round(budget.size / 1000)}k
                            </p>
                            ) : null}
                            {budget ? (
                            <span className="mt-1 block h-1 w-full overflow-hidden rounded-sm bg-[var(--bg-3)]">
                                <span
                                    data-budget-bar={budget.pct}
                                    className={`block h-full ${budget.pct >= 90 ? 'bg-[var(--danger)]' : budget.pct >= 80 ? 'bg-[var(--warning)]' : 'bg-[var(--sky-400)]'}`}
                                    style={{ width: `${budget.pct}%` }}
                                />
                            </span>
                            ) : null}
                            {/* The note under the bar (the board): compaction expected / compacted at / last reported. Absent when there is nothing to say. */}
                            {note ? (
                                <p data-context-note={note.tone} className={`mt-1.5 text-[11px] ${note.tone === 'bad' ? 'text-[var(--danger)]' : note.tone === 'warn' ? 'text-[var(--warning)]' : 'text-[var(--fg-3)]'}`}>{note.text}</p>
                            ) : null}
                            {/*
                             * No Cost row at all when the provider reports none — codex reports
                             * none. Not a `$0.00`, which claims the work was free, and not a
                             * dash, which reads as zero.
                             */}
                            {budget && budget.cost !== null ? (
                                <p data-rail-cost className="mt-1.5 font-mono text-[11px] text-[var(--fg-3)]">
                                    {`$${budget.cost.toFixed(2)} this session · ${budget.turns} turns`}
                                </p>
                            ) : budget ? (
                                <p className="mt-1.5 font-mono text-[11px] text-[var(--fg-3)]">{budget.turns} turns</p>
                            ) : null}
                            {/* Whether this session was STARTED with Genie's MCP — the servers the host handed the driver. */}
                            {session?.mcpServers ? (
                                session.mcpServers.includes('genie') ? (
                                    <p data-rail-mcp="given" className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--fg-3)]">Genie’s MCP — given to this session <button type="button" data-door="mcp-tools" onClick={() => onNavigate('genie://settings/mcp')} className="rounded-md border border-[var(--border-1)] px-1.5 text-[11px] hover:bg-[var(--bg-2)]">its tools →</button></p>
                                ) : (
                                    <p data-rail-mcp="missing" className="mt-1.5 text-[11px] text-[var(--warning)]">This session was not given Genie’s MCP — it started before the server was listening. Restart it to connect.</p>
                                )
                            ) : null}
                            {policy ? <p data-approval-policy className="mt-1.5 text-[11px] leading-normal text-[var(--fg-3)]">{policy}</p> : null}
                            {headroom ? (
                                <p data-rail-headroom className={`mt-1 font-mono text-[11px] ${headroom.over || headroom.leftPct < 10 ? 'text-[var(--warning)]' : 'text-[var(--fg-3)]'}`}>{headroomLine(headroom)}</p>
                            ) : null}
                        </section>
                    ) : null}
                </div>
                ) : null}
                </aside>
                ) : null}
            </div>
        </div>
    );
}
