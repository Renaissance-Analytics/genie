import { Badge, Button, Card, Heading, Progress, Text } from '@particle-academy/react-fancy';
import type { AgentSession } from '../../../main/agentsession/model';
import { knownFacts, sessionFidelity } from '../../../main/agentsession/model';
import { agentViewTabs, defaultTabFor, parkedApproval, type AgentViewTab } from '../../lib/agent-view';

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

export interface AgentViewProps {
    session: AgentSession;
    tab?: AgentViewTab;
    onTab?: (tab: AgentViewTab) => void;
    onApprove?: (approvalId: string, decision: 'allow-once' | 'allow-always' | 'deny-once') => void;
    onTakeOver?: () => void;
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
    now = Date.now(),
}: AgentViewProps): React.JSX.Element {
    const tabs = agentViewTabs(session);
    const active = tab && tabs.includes(tab) ? tab : defaultTabFor(session);
    const facts = knownFacts(session);
    const fidelity = sessionFidelity(session);
    const parked = parkedApproval(session);

    return (
        <div className="agent-view" data-fidelity={fidelity} data-testid="agent-view">
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
                        {session.transcript.map((m) => (
                            <div className="agent-msg" key={m.id} data-role={m.role}>
                                <Text size="xs" className="agent-msg-who">
                                    {m.role}
                                </Text>
                                <Text size="sm">{m.content}</Text>
                            </div>
                        ))}

                        {session.live ? (
                            <div className="agent-msg live" data-role={session.live.role}>
                                <Text size="sm">{session.live.content}</Text>
                            </div>
                        ) : null}

                        {session.tools.map((t) => (
                            <Card className="agent-tool" key={t.id}>
                                <Text size="xs">
                                    {t.name} · {t.status}
                                </Text>
                            </Card>
                        ))}

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
                                {/* The turn has STOPPED. Saying so is why approvals are
                                    inline rather than hidden behind a modal. */}
                                <Text size="xs">turn parked {elapsed(now, session.turn.since)}</Text>
                            </Card>
                        ) : null}

                        {session.transcript.length === 0 && !session.live ? (
                            <Text size="sm">Nothing said yet.</Text>
                        ) : null}
                    </div>
                ) : (
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
