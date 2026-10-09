import { useState } from 'react';
import { Badge, Button, Card, Heading, Progress, Text, Textarea } from '@particle-academy/react-fancy';
import type { AgentSession } from '../../../main/agentsession/model';
import { knownFacts, sessionFidelity } from '../../../main/agentsession/model';
import { agentViewTabs, defaultTabFor, parkedApproval, type AgentViewTab } from '../../lib/agent-view';
import { AgentStream } from './AgentStream';
import { AgentFiles } from './AgentFiles';
import { AgentActivity } from './AgentActivity';
import { AgentChanges } from './AgentChanges';
import type { AgentChangesInput } from '../../lib/agent-changes-view';
import type { AgentFilesView } from '../../lib/agent-files-view';
import type { LaneSpan } from '../../lib/agent-lanes';
// The LEAF, not `./rate-limit` — that one imports prism's types and the renderer boundary
// test refuses a `main/` module with a bare package specifier in it.
import { rateLimitSummary } from '../../../main/agentsession/rate-limit-headroom';
import { headroomDisplay } from '../../lib/rate-limit-view';

/**
 * ONE AGENT — Genie 2's most important screen.
 *
 * The shape comes from `lib/agent-view.ts` and the rails from the session model's own
 * `knownFacts`; both are tested. This file is the render, and deliberately holds no
 * decisions of its own.
 *
 * ## Decisions it renders, each from the approved spec
 *
 * **Approvals are INLINE, never a modal.** An `Edit` approval fires many times per turn, so
 * a modal per approval makes the modal the new TUI. The reasoning that justifies the
 * decision sits directly above it, and the turn visibly PARKS.
 *
 * **A thought is one line with its token cost, never auto-expanded.** Content jumping as
 * reasoning streams is the worst reading experience in agent UIs.
 *
 * **The plan is a RAIL, not a transcript entry** — a transcript is append-only, a plan
 * mutates in place.
 *
 * **Context leads, cost follows.** 178k/200k means it is about to compact and get
 * measurably worse, which is a reason to act now; a dollar figure is a reason to act later.
 *
 * **Never a dash for an unknown number** — a dash reads as zero. An absent fact renders
 * nothing at all, which is why every rail is gated on `knownFacts`.
 */

import type { AgentSpecLike, RestartMode } from '../../../main/agents/restart-options';
import {
    AgentChromeMenu,
    AgentHeaderActions,
    useAgentChromeMenu,
} from './AgentChrome';

/**
 * WHO SPOKE — the author when there is one, otherwise the role.
 *
 * P7 folds human↔agent DMs into this surface, and `mergeDeclared` now interleaves the
 * AgentInbox thread with the declared session rather than replacing it, because a measured ACP
 * session reports the agent's voice and nothing else. So this transcript has THREE speakers
 * where it had two: the agent, the owner, and a sibling agent that messaged this one.
 *
 * Rendering `role` alone labelled a sibling's message `user` — the same word as the owner's own
 * — on the one screen whose job is deciding what to do next. `Message.author` exists for exactly
 * this: *"a message from a sibling agent is neither this agent speaking nor the owner speaking…
 * encoding the sender into `content` as a prefix would be munging somebody's text, so it gets a
 * field."* It was simply never read here.
 *
 * `you` rather than `user` for the owner, because this transcript is now read alongside named
 * agents and `user` beside `kora` reads as a second anonymous party rather than as the reader.
 */
function speakerOf(m: { role: string; author?: string | null }): string {
    if (m.author) return m.author;
    return m.role === 'user' ? 'you' : m.role;
}

export interface AgentViewProps {
    session: AgentSession;
    tab?: AgentViewTab;
    onTab?: (tab: AgentViewTab) => void;
    onApprove?: (approvalId: string, decision: 'allow-once' | 'allow-always' | 'deny-once') => void;
    onTakeOver?: () => void;
    /**
     * Send a prompt to the session. Absent means this surface cannot talk to the agent, and then
     * NO composer is rendered — a box that cannot send is worse than no box, because it invites
     * typing and swallows it.
     */
    onSend?: (text: string) => void;
    /** Ask the agent to stop the turn. `session/cancel` only ASKS, and the control says so. */
    onCancel?: () => void;
    /**
     * This agent's terminal spec, for the shared chrome (restart + settings).
     *
     * Optional because a projected session can exist before Genie holds a spec for it, and
     * `agentChromeControls` already returns nothing for an absent or non-agent spec — so the
     * header simply has no chrome rather than a row of controls that cannot act.
     */
    spec?: AgentSpecLike | null;
    onRestartAgent?: (mode: RestartMode) => void;
    onAgentSettings?: () => void;
    /** §5.2's Lanes pulldown (`L`) — closed by default; it is an instrument, not chrome. */
    lanesOpen?: boolean;
    /** The dragged window, parsed from the url so a refresh and a shared link agree. */
    lanesRange?: LaneSpan | null;
    onLanesRange?: (range: LaneSpan | null) => void;
    /** `/` — the stream's find box is open. */
    findOpen?: boolean;
    onFindClose?: () => void;
    /** `E` — a nonce; bumping it jumps the stream's selection to the next edit. */
    jumpToNextEdit?: number;
    /**
     * The Files tab's projection, or null while the workspace has not been read yet.
     *
     * Null renders the placeholder rather than an empty list: an empty list is a CLAIM that
     * the agent changed nothing, and `agentFilesView` keeps that (`rows: []`) distinct from
     * "cannot see the workspace" (`rows: null`). Collapsing the two here would throw away the
     * distinction the model exists to preserve.
     */
    filesView?: AgentFilesView | null;
    onOpenFile?: (path: string) => void;
    onOpenAgent?: (agentId: string) => void;
    /**
     * What the Changes tab needs beyond this session: the roster it compares against, and
     * what the watcher saw. `agentId` is NOT taken from here — it comes from the session on
     * screen, so the tab cannot end up reporting a different agent than its own header.
     */
    changesInput?: Omit<AgentChangesInput, 'agentId'>;
    now?: number;
}

const TAB_LABEL: Record<AgentViewTab, string> = {
    // The route key is `session`; what a person calls it is "Conversation".
    session: 'Conversation',
    terminal: 'Terminal',
    activity: 'Activity',
    files: 'Files',
    changes: 'Changes',
};

const TURN_LABEL: Record<AgentSession['turn']['state'], string> = {
    idle: 'idle',
    thinking: 'thinking',
    tool: 'working',
    'awaiting-approval': 'awaiting approval',
    'awaiting-input': 'awaiting your answer',
};

function elapsed(now: number, since: number): string {
    const secs = Math.max(0, Math.floor((now - since) / 1000));
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

export function AgentView({
    session,
    tab,
    onTab,
    onApprove,
    onTakeOver,
    onSend,
    onCancel,
    spec,
    onRestartAgent,
    onAgentSettings,
    lanesOpen = false,
    lanesRange = null,
    onLanesRange,
    findOpen = false,
    onFindClose,
    jumpToNextEdit,
    filesView = null,
    onOpenFile,
    onOpenAgent,
    changesInput,
    now = Date.now(),
}: AgentViewProps): React.JSX.Element {
    const tabs = agentViewTabs(session);
    const active = tab && tabs.includes(tab) ? tab : defaultTabFor(session);
    const facts = knownFacts(session);
    /**
     * SUBSCRIPTION HEADROOM — the one number the owner asked to see.
     *
     * Computed from `now` rather than `Date.now()` so the reset label is deterministic and
     * assertable: a render that reads the clock itself is a render no test can pin.
     */
    const headroom = facts.rateLimit
        ? headroomDisplay(
              rateLimitSummary(session.rateLimit, { unrecognised: session.rateLimitUnavailable }),
              now,
          )
        : null;
    const fidelity = sessionFidelity(session);
    const parked = parkedApproval(session);
    /**
     * The composer's text.
     *
     * Cleared only on a send that was accepted. A failed one keeps it — the IPC answers
     * `{ok:false, reason}` rather than throwing, precisely so nothing a person typed is lost to
     * a closed channel or a budget cap.
     */
    const [draft, setDraft] = useState('');
    const working = session.turn.state !== 'idle';
    /**
     * A composer only for a DECLARED session, and only when something can carry the text.
     *
     * An Observed agent is driven by typing into its TUI on the Terminal tab; a second input
     * that cannot reach it would be two ways to do one thing, one of which fails in silence.
     */
    const canSend = !!onSend && fidelity === 'declared';
    const send = (): void => {
        const text = draft.trim();
        if (!text) return;
        onSend?.(text);
        setDraft('');
    };
    /**
     * The SAME chrome the Floor tile renders (`AgentTerminal`), from the same decisions.
     *
     * It was missing here entirely: restart and agent settings lived only on the grid tile,
     * inside `AgentPanel`. The Genie 2 plan proposed deleting that component on the grounds
     * its pieces would "migrate to the Agent header" — this is that migration, finally done,
     * and shared rather than reimplemented so the two surfaces cannot drift.
     */
    const menu = useAgentChromeMenu();
    const chrome = {
        spec: spec ?? null,
        onRestart: !!onRestartAgent,
        onSettings: !!onAgentSettings,
        screenSwitch: null,
    };

    return (
        <div
            className="agent-view"
            data-fidelity={fidelity}
            data-testid="agent-view"
            onContextMenu={menu.open}
        >
            <AgentChromeMenu
                menu={menu}
                input={chrome}
                onRestartAgent={onRestartAgent}
                onAgentSettings={onAgentSettings}
            />
            <div className="agent-view-head">
                <Heading as="h2" size="sm">
                    {session.session.name}
                </Heading>
                <Text size="xs">
                    {/* Only what is known. An unresolved provider renders nothing rather
                        than a placeholder that looks like a value. */}
                    {[session.session.provider, session.session.cwd].filter(Boolean).join(' · ')}
                </Text>
                <Badge color={session.turn.state === 'idle' ? 'zinc' : 'amber'} size="sm" dot>
                    {TURN_LABEL[session.turn.state]} {elapsed(now, session.turn.since)}
                </Badge>
                {onTakeOver ? (
                    <Button size="sm" variant="ghost" onClick={onTakeOver}>
                        {/* A VERB, distinct from the Terminal tab, which is a place. */}
                        Take over
                    </Button>
                ) : null}
                <AgentHeaderActions input={chrome} onRestartAgent={onRestartAgent} />
            </div>

            <div className="agent-view-tabs" role="tablist">
                {tabs.map((t) => (
                    <button
                        key={t}
                        role="tab"
                        aria-selected={t === active}
                        className={t === active ? 'agent-tab on' : 'agent-tab'}
                        onClick={() => onTab?.(t)}
                    >
                        {TAB_LABEL[t]}
                    </button>
                ))}
            </div>

            <div className="agent-view-body">
                {active === 'session' ? (
                    <div className="agent-conversation">
                        {/**
                          * THE STREAM (§5.2) replaces the raw transcript, the live message and
                          * the tool-call list that used to be rendered here as three separate
                          * runs. One ordered list is the point: a thought, the tool it led to,
                          * and what the agent said about the result read as a sequence, which
                          * three lists stacked in field order cannot show.
                          *
                          * The approval card and the composer below are deliberately left in
                          * place. The board moves the composer into the chat flyout, and that
                          * is a real change — but doing it here would leave this surface with
                          * no way to type before the flyout is the default way in.
                          */}
                        <AgentStream
                            session={session}
                            now={now}
                            lanesOpen={lanesOpen}
                            range={lanesRange}
                            {...(onLanesRange ? { onRange: onLanesRange } : {})}
                            findOpen={findOpen}
                            {...(onFindClose ? { onFindClose } : {})}
                            {...(jumpToNextEdit !== undefined ? { jumpToNextEdit } : {})}
                        />

                        {parked ? (
                            <Card className="agent-approval">
                                <Text size="sm">
                                    Approve {parked.name}
                                </Text>
                                <div className="agent-approval-actions">
                                    <Button size="sm" variant="ghost" onClick={() => onApprove?.(parked.id, 'allow-once')}>
                                        Allow
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => onApprove?.(parked.id, 'allow-always')}
                                    >
                                        Allow for session
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => onApprove?.(parked.id, 'deny-once')}>
                                        Deny
                                    </Button>
                                </div>
                                {/* THE STREAM SAYS THIS NOW, once, as its tail divider.
                                    Saying it here too was a real regression: `getByText(/turn
                                    parked/)` matched two elements and failed Playwright's strict
                                    mode, which is how E2E caught it on two platforms. The turn
                                    must still visibly park (§6.4) — it does, one row below. */}
                            </Card>
                        ) : null}


                        {canSend ? (
                            <div className="agent-composer" data-testid="agent-composer">
                                <Textarea
                                    rows={3}
                                    value={draft}
                                    placeholder="Say something to this agent"
                                    onChange={(e: { target: { value: string } }) => setDraft(e.target.value)}
                                    onKeyDown={(e: {
                                        key: string;
                                        metaKey: boolean;
                                        ctrlKey: boolean;
                                        shiftKey: boolean;
                                        preventDefault: () => void;
                                    }) => {
                                        // ⌘↵ SENDS; a bare Enter is a newline. The plan's keyboard
                                        // model, and the right way round for a box people paste
                                        // multi-line instructions into.
                                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                            e.preventDefault();
                                            send();
                                        }
                                    }}
                                />
                                <div className="agent-composer-actions">
                                    <Button size="sm" disabled={!draft.trim()} onClick={send}>
                                        Send
                                    </Button>
                                    {working && onCancel ? (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            className="agent-stop"
                                            data-testid="agent-stop"
                                            onClick={onCancel}
                                        >
                                            {/* ASKS the agent to stop — `session/cancel` is a
                                                request, not a kill, and the word is chosen so
                                                nobody reads it as the latter. */}
                                            Stop
                                        </Button>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}
                    </div>
                ) : active === 'activity' ? (
                    // Built from the session this view already holds — no extra plumbing, and
                    // no second source that could disagree with the header above it.
                    <AgentActivity session={session} />
                ) : active === 'changes' && changesInput ? (
                    <AgentChanges
                        {...changesInput}
                        agentId={session.agentId}
                        {...(onOpenFile ? { onOpenFile } : {})}
                    />
                ) : active === 'files' && filesView ? (
                    <AgentFiles
                        view={filesView}
                        now={now}
                        {...(onOpenFile ? { onOpenFile } : {})}
                        {...(onOpenAgent ? { onOpenAgent } : {})}
                    />
                ) : (
                    // The remaining tabs have no body yet. A placeholder that prints the tab's
                    // own name is not a feature — it is a stub, and it is named as one here so
                    // nobody mistakes it for a considered empty state.
                    <div className="agent-view-placeholder" data-tab={active}>
                        <Text size="sm">{TAB_LABEL[active]}</Text>
                    </div>
                )}
            </div>

            <div className="agent-view-rail">
                {facts.plan && session.plan ? (
                    <div className="rail-section" data-testid="rail-plan">
                        <Text size="xs">Plan {session.plan.filter((p) => p.status === 'done').length}/{session.plan.length}</Text>
                        {session.plan.map((p) => (
                            <Text size="xs" key={p.id} className={`plan-${p.status}`}>
                                {p.title}
                            </Text>
                        ))}
                    </div>
                ) : null}

                {facts.usage && session.usage ? (
                    <div className="rail-section" data-testid="rail-usage">
                        {/* Context FIRST: it is the number that predicts the agent getting
                            worse, and therefore the one worth acting on. */}
                        {session.usage.contextUsed !== null && session.usage.contextMax !== null ? (
                            <>
                                <Text size="xs">
                                    ctx {session.usage.contextUsed}/{session.usage.contextMax}
                                </Text>
                                <Progress value={(session.usage.contextUsed / session.usage.contextMax) * 100} />
                            </>
                        ) : null}
                        {session.usage.costUsd !== null ? <Text size="xs">${session.usage.costUsd}</Text> : null}
                    </div>
                ) : null}

                {headroom ? (
                    <div className="rail-section" data-testid="rail-ratelimit" data-tone={headroom.tone}>
                        {/* What is LEFT, never what is used: the question is how much work is
                            still available, and a utilization figure makes a reader do the
                            subtraction. The exception is overage, where "140% used" IS the fact. */}
                        <Text size="xs">
                            {headroom.bindingLabel ? `${headroom.bindingLabel} · ` : ''}
                            {headroom.headline}
                        </Text>
                        {headroom.barPercent !== null ? <Progress value={headroom.barPercent} /> : null}
                        {headroom.resetsLabel ? <Text size="xs">{headroom.resetsLabel}</Text> : null}
                        {/* The OTHER windows, because they disagree: a 5-hour window with room
                            beside a 7-day one nearly gone is the case where one number alone
                            misleads. Only ever as well as the binding one, never instead. */}
                        {headroom.windows
                            .filter((w) => w.label !== headroom.bindingLabel)
                            .map((w) => (
                                <Text size="xs" key={w.label}>
                                    {w.label} · {w.percentLeft}% left
                                </Text>
                            ))}
                        {headroom.note ? <Text size="xs">{headroom.note}</Text> : null}
                    </div>
                ) : null}

                {facts.commands && session.commands ? (
                    <div className="rail-section" data-testid="rail-commands">
                        <Text size="xs">{session.commands.length} commands</Text>
                    </div>
                ) : null}

                {session.error ? (
                    <div className="rail-section" data-testid="rail-error">
                        <Text size="xs">{session.error}</Text>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
