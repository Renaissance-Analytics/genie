import { useEffect } from 'react';
import { Icon } from '@particle-academy/react-fancy';
import { approvalPlacement, budgetFor, planFor, statePill, tabsFor } from '../../core/agent-view.js';
import { ApprovalCard, ApprovalMarker } from './ApprovalCard.js';
import type { Fidelity } from '../../core/dashboard-view.js';
import { inspectorFor } from '../../core/inspector.js';
import type { LiveSession } from '../../core/roster.js';
import type { AgentTab } from '../../core/route.js';
import type { Lane, TimedEvent } from '../../core/stream-view.js';
import { Inspector } from './Inspector.js';
import { Lanes } from './Lanes.js';
import { nextEditAfter, rowsInRange, type TimeRange } from '../../core/lanes.js';
import { visibleRows } from '../../core/stream-view.js';
import { agentViewAction, approvalChoice, isTypingTarget, stepRow, toggleThoughts } from '../../core/keys.js';
import { Stream } from './Stream.js';

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

const TAB_LABEL: Record<AgentTab, string> = {
    stream: 'Stream',
    files: 'Files',
    changes: 'Changes',
    terminal: 'Terminal',
    activity: 'Activity',
};

const PILL_TONE = {
    ok: 'text-emerald-500',
    warn: 'text-amber-500',
    bad: 'text-red-500',
    muted: 'text-[var(--fg-3)]',
} as const;

export interface AgentViewProps {
    agent: { id: string; name: string; provider: string; fidelity: Fidelity; cwd: string };
    session: LiveSession | null;
    rows: readonly TimedEvent[];
    tab: AgentTab;
    lanes: readonly Lane[] | null;
    at: string | null;
    selectedId: string | null;
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
    onLanes?: ((lanes: readonly Lane[] | null) => void) | undefined;
    /** The time range from the route; a drag on the timeline changes it. */
    range?: TimeRange | null | undefined;
    onRange?: ((range: TimeRange | null) => void) | undefined;
    /** Take Over (§1): open this agent's TUI in a new window. */
    onTakeOver?: ((agentId: string) => void) | undefined;
    now?: (() => number) | undefined;
}

export function AgentView({
    agent, session, rows, tab, lanes, at, selectedId, turns, cost, onNavigate, onSelect, now,
    chatSubject, answeringApproval, onAnswerApproval, onLanes, range = null, onRange, onTakeOver,
}: AgentViewProps) {
    const tabs = tabsFor(agent.fidelity);
    const pill = statePill(session, now ?? (() => Date.now()));
    const plan = planFor(session);
    const budget = budgetFor(session, cost, turns);

    // A tab the agent does not have falls back to its first one, rather than rendering an empty
    // body under a tab strip that does not contain the selected tab.
    const active = tabs.includes(tab) ? tab : (tabs[0] ?? 'files');

    const chatRoute = `genie://agent/${agent.id}?tab=${active}&chat=${agent.id}`;

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
            const inView = visibleRows(rowsInRange(rows, range), lanes).map((r) => r.id);

            switch (action) {
                case 'next-edit': {
                    const next = nextEditAfter(rowsInRange(rows, range), selectedId);
                    if (!next) return;
                    e.preventDefault();
                    onSelect(next);
                    return;
                }
                case 'next-row':
                case 'prev-row': {
                    const next = stepRow(inView, selectedId, action === 'next-row' ? 'next' : 'prev');
                    if (!next) return;
                    e.preventDefault();
                    onSelect(next);
                    return;
                }
                case 'toggle-inspector': {
                    // Selection IS the Inspector in this build: a selected tool row opens it. So
                    // Enter closes it when something is selected, and does nothing when nothing
                    // is — there is nothing to open without a cursor on a row.
                    if (selectedId === null) return;
                    e.preventDefault();
                    onSelect(null);
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
    }, [rows, range, lanes, selectedId, onSelect, onNavigate, onLanes, approval, placement, onAnswerApproval, onTakeOver, agent.id]);

    const selectedRow = selectedId === null ? null : rows.find((r) => r.id === selectedId);
    const inspector =
        selectedRow && selectedRow.event.kind === 'tool' ? inspectorFor(selectedRow.event) : null;

    return (
        <div data-surface="agent" data-agent={agent.id} className="flex h-full min-h-0 flex-col">
            {/* Header, with the identity written the way the board writes it. */}
            <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border-1)] px-5">
                <span className="font-medium">{agent.name}</span>
                <span className="font-mono text-[11px] text-[var(--fg-4)]">{agent.provider}</span>
                <span className="font-mono text-[11px] text-[var(--fg-4)]">{agent.cwd}</span>

                <span data-pill={pill.word} className={`flex items-center gap-1.5 text-xs ${PILL_TONE[pill.tone]}`}>
                    <span className="size-1.5 rounded-full bg-current" />
                    {pill.word}
                    {/* A clock only while a turn runs. On an idle agent it counts up forever
                        and reads as work in progress. */}
                    {pill.elapsed ? <span className="font-mono tabular-nums">{pill.elapsed}</span> : null}
                </span>

                <div className="ml-auto flex items-center gap-1">
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
                    </button>

                    <button
                        type="button"
                        data-action="take-over"
                        onClick={() => onTakeOver?.(agent.id)}
                        className="flex items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]"
                    >
                        <Icon name="square-terminal" size="xs" />
                        Take over
                    </button>
                </div>
            </div>

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
            </div>

            <div className="flex min-h-0 flex-1">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    {active === 'stream' ? (
                        <>
                            <Lanes
                                rows={rows}
                                selected={lanes}
                                onChange={(next) => onLanes?.(next)}
                                range={range}
                                onRange={(next) => onRange?.(next)}
                            />

                            <div className="min-h-0 flex-1">
                                <Stream
                                    rows={rowsInRange(rows, range)}
                                    lanes={lanes}
                                    at={at}
                                    selectedId={selectedId}
                                    onSelect={onSelect}
                                />
                            </div>

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
                                />
                            ) : null}

                            {approval && placement === 'chat' ? <ApprovalMarker where="the chat" /> : null}
                        </>
                    ) : null}
                </div>

                {inspector ? <Inspector content={inspector} onClose={() => onSelect(null)} /> : null}

                {/*
                 * The right rail, 260px, inside the Agent view's own grid — **it is not a
                 * dock.** The dock slot belongs to chat, files and lists, and at most one of
                 * those is pinned at a time; the rail is part of this surface and does not
                 * compete for that slot.
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
                {plan || budget ? (
                <aside data-rail-column className="flex w-[260px] shrink-0 flex-col gap-4 border-l border-[var(--border-1)] p-4 text-xs">
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
                            <p className="mt-1 text-[var(--fg-2)]">{plan.doing}</p>
                        </section>
                    ) : null}

                    {budget ? (
                        <section data-rail="budget">
                            <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">
                                Budget
                            </h2>
                            <p className="font-mono text-[11px] text-[var(--fg-3)]">
                                ctx {Math.round(budget.used / 1000)}k/{Math.round(budget.size / 1000)}k
                            </p>
                            <span className="mt-1 block h-1 w-full overflow-hidden rounded-sm bg-[var(--bg-3)]">
                                <span
                                    data-budget-bar={budget.pct}
                                    className="block h-full bg-sky-400"
                                    style={{ width: `${budget.pct}%` }}
                                />
                            </span>
                            {/*
                             * No Cost row at all when the provider reports none — codex reports
                             * none. Not a `$0.00`, which claims the work was free, and not a
                             * dash, which reads as zero.
                             */}
                            {budget.cost !== null ? (
                                <p data-rail-cost className="mt-1.5 font-mono text-[11px] text-[var(--fg-3)]">
                                    ${budget.cost.toFixed(2)} · {budget.turns} turns
                                </p>
                            ) : (
                                <p className="mt-1.5 font-mono text-[11px] text-[var(--fg-3)]">{budget.turns} turns</p>
                            )}
                        </section>
                    ) : null}
                </aside>
                ) : null}
            </div>
        </div>
    );
}
