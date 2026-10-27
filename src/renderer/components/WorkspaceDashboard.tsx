import { Badge, Button, Card, Chart, Icon } from '@particle-academy/react-fancy';
import type { KeyboardEvent, MouseEvent } from 'react';
import type { FeedKind } from '../../core/activity-feed.js';
import type { DashLane, WorkspaceDashboardView } from '../../core/workspace-dashboard.js';
import { FidelityDot } from './Dashboard.js';
import { ProviderLogo } from './ProviderLogo.js';

/**
 * THE WORKSPACE DASHBOARD — A LANE PER AGENT (beta.33 item 10; the owner, 2026-10-20: "Each agent should have a full lane
 * that shows me a heartbeat of activity … THINK BETTER"; ROWS, q_99659edf).
 *
 * One full-width Card per agent of the workspace, stacked. The left column: the agent, its state and how long, the
 * heartbeat (a sparkline of rows per minute, 30 minutes), PLAN, NOW and its own waiting-on-you; a stopped agent shows its
 * last activity and Start. The right: its live feed, newest first, scrolling inside the lane. Clicking a lane opens the
 * agent. Every rule is in `core/workspace-dashboard.ts`; a line with nothing reported is not drawn.
 */

const TONE = {
    ok: 'text-[var(--success)]',
    warn: 'text-[var(--warning)]',
    bad: 'text-[var(--danger)]',
    muted: 'text-[var(--fg-3)]',
} as const;

const LABEL = 'w-10 shrink-0 text-[10px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]';

/** Each feed kind's glyph — every one registered in `renderer/icons.ts`. */
const FEED_ICON: Record<FeedKind, string> = {
    edit: 'pencil',
    command: 'square-terminal',
    tool: 'wrench',
    reply: 'message-square',
    prompt: 'message-square-reply',
    finished: 'check',
    stopped: 'square',
    approval: 'check',
    notice: 'circle-alert',
    handoff: 'arrow-right-left',
};

const FEED_TONE: Record<FeedKind, string> = {
    edit: 'text-[var(--success)]',
    command: 'text-[var(--fg-2)]',
    tool: 'text-[var(--fg-3)]',
    reply: 'text-[var(--fg-1)]',
    prompt: 'text-[var(--accent,var(--fg-1))]',
    finished: 'text-[var(--success)]',
    stopped: 'text-[var(--fg-3)]',
    approval: 'text-[var(--fg-2)]',
    notice: 'text-[var(--warning)]',
    handoff: 'text-[var(--fg-2)]',
};

const MONO: ReadonlySet<FeedKind> = new Set(['edit', 'command', 'tool']);

/** The heartbeat's line: the state's own colour, so a lane reads at a glance. */
const BEAT_COLOUR: Record<DashLane['tone'], string> = { ok: 'var(--success)', warn: 'var(--warning)', bad: 'var(--danger)', muted: 'var(--fg-4)' };

export interface WorkspaceDashboardProps {
    /** The workspace's display name, for the sentences. */
    name: string;
    workspaceId: string;
    view: WorkspaceDashboardView;
    onOpenAgent: (agentId: string) => void;
    onOpenDeckItem: (itemId: string) => void;
    onAddAgent: () => void;
    /** Start a stopped agent (the session host's start-or-reattach). Absent = no Start is offered. */
    onStartAgent?: ((agentId: string) => void) | undefined;
}

/** A control inside a lane does its own thing; it does not also open the agent. */
const own = (fn: () => void) => (event: MouseEvent) => { event.stopPropagation(); fn(); };

function Lane({ lane, onOpenAgent, onOpenDeckItem, onStartAgent }: { lane: DashLane } & Pick<WorkspaceDashboardProps, 'onOpenAgent' | 'onOpenDeckItem' | 'onStartAgent'>) {
    const open = (): void => onOpenAgent(lane.id);
    const onKey = (event: KeyboardEvent): void => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    };
    return (
        <Card
            interactive
            variant="outlined"
            padding="none"
            role="button"
            tabIndex={0}
            aria-label={`Open ${lane.name}`}
            data-dash-lane={lane.id}
            data-state={lane.stopped ? 'stopped' : lane.state}
            onClick={open}
            onKeyDown={onKey}
            className="grid cursor-pointer grid-cols-[minmax(240px,300px)_minmax(0,1fr)] text-left"
        >
            {/* THE LEFT: who, what state and how long, the heartbeat, plan, now, and what it waits on you for. */}
            <div className="flex min-w-0 flex-col gap-2 border-r border-[var(--border-1)] px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                    <FidelityDot fidelity={lane.fidelity} state={lane.state} />
                    <span className="truncate text-[13px] font-medium text-[var(--fg-1)]">{lane.name}</span>
                    <ProviderLogo provider={lane.provider} />
                    <span data-lane-state="" className={`ml-auto shrink-0 text-[11px] ${TONE[lane.tone]}`}>
                        {lane.word}
                        {lane.inState ? ` · ${lane.inState}` : null}
                    </span>
                </div>

                {lane.heartbeat ? (
                    <div data-lane-heartbeat="" title={`${lane.beats} events in the last 30 minutes`} className="flex items-end gap-2">
                        <Chart.Sparkline data={lane.heartbeat} width={200} height={24} color={BEAT_COLOUR[lane.tone]} />
                        <span className="text-[10px] text-[var(--fg-4)]">{lane.beats > 0 ? `${lane.beats} / 30m` : 'quiet 30m'}</span>
                    </div>
                ) : null}

                {lane.detail ? <p data-lane-detail="" className={`line-clamp-2 text-[12px] ${TONE[lane.tone]}`}>{lane.detail}</p> : null}

                {lane.plan ? (
                    <div data-lane-plan="" className="flex min-w-0 items-baseline gap-2 text-[12px]">
                        <span className={LABEL}>Plan</span>
                        <span className="shrink-0 font-mono text-[var(--fg-1)]">{lane.plan.step}</span>
                        {lane.plan.doing ? <span className="truncate text-[var(--fg-2)]">{lane.plan.doing}</span> : null}
                    </div>
                ) : null}

                {lane.now ? (
                    <div data-lane-now="" className="flex min-w-0 items-center gap-2 text-[12px]">
                        <span className={LABEL}>Now</span>
                        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--success)]" />
                        <span className="truncate font-mono text-[var(--fg-2)]">{lane.now}</span>
                    </div>
                ) : null}

                {lane.waiting.map((w) => (
                    <div key={w.id} data-lane-waiting={w.id} className="flex min-w-0 items-center gap-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-2 py-1 text-[12px]">
                        <span className="min-w-0 flex-1 truncate text-[var(--fg-1)]">{w.title}</span>
                        <Button type="button" size="xs" onClick={own(() => onOpenDeckItem(w.id))}>Open</Button>
                    </div>
                ))}

                {lane.stopped ? (
                    <div className="flex items-center gap-2 text-[12px] text-[var(--fg-3)]">
                        {lane.lastActive ? <span data-lane-last="">Last active {lane.lastActive === 'now' ? 'just now' : `${lane.lastActive} ago`}</span> : <span>No recorded activity</span>}
                        {onStartAgent ? <Button type="button" size="xs" className="ml-auto" data-lane-start={lane.id} onClick={own(() => onStartAgent(lane.id))}>Start</Button> : null}
                    </div>
                ) : null}
            </div>

            {/* THE RIGHT: its live feed, newest first, scrolling inside the lane. */}
            <ol data-lane-feed="" className="flex max-h-48 min-w-0 flex-col overflow-y-auto px-3 py-2">
                {lane.feed.length === 0 ? (
                    <li className="py-1 text-[12px] text-[var(--fg-4)]">{lane.heartbeat ? 'Nothing recorded yet.' : ''}</li>
                ) : lane.feed.map((item) => (
                    <li key={item.id} data-feed-item={item.kind} className="flex min-w-0 items-center gap-2 py-[3px] text-[12px]">
                        <span className="w-10 shrink-0 text-right font-mono text-[10px] text-[var(--fg-4)]">{item.age}</span>
                        <span className={`shrink-0 ${FEED_TONE[item.kind]}`}><Icon name={FEED_ICON[item.kind]} size="xs" /></span>
                        {item.by ? <span className="shrink-0 text-[11px] text-[var(--fg-3)]">{item.by}</span> : null}
                        <span className={`min-w-0 flex-1 truncate ${MONO.has(item.kind) ? 'font-mono' : ''} ${item.kind === 'reply' || item.kind === 'prompt' ? 'text-[var(--fg-1)]' : 'text-[var(--fg-2)]'}`}>{item.text}</span>
                        {item.plus !== null ? <span className="shrink-0 font-mono text-[11px] text-[var(--success)]">+{item.plus}</span> : null}
                        {item.minus !== null ? <span className="shrink-0 font-mono text-[11px] text-[var(--danger)]">−{item.minus}</span> : null}
                        {item.status === 'running' ? <Badge size="sm" color="amber" variant="soft">running</Badge> : null}
                        {item.status === 'failed' ? <Badge size="sm" color="red" variant="soft">failed</Badge> : null}
                    </li>
                ))}
            </ol>
        </Card>
    );
}

export function WorkspaceDashboard({ name, workspaceId, view, onOpenAgent, onOpenDeckItem, onAddAgent, onStartAgent }: WorkspaceDashboardProps) {
    return (
        <div data-workspace-dashboard={workspaceId} className="flex h-full min-w-0 flex-1 flex-col gap-2 overflow-y-auto bg-[var(--bg-1)] px-5 py-4">
            {/* A question in this workspace no agent's lane holds (a flow's) — it would otherwise have no way in here. */}
            {view.waiting.map((w) => (
                <div key={w.id} data-dash-waiting={w.id} className="flex items-center gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-[13px]">
                    <span className="min-w-0 flex-1 truncate text-[var(--fg-1)]">{w.title}</span>
                    <Button type="button" size="xs" onClick={() => onOpenDeckItem(w.id)}>Open</Button>
                </div>
            ))}
            {view.noAgents ? (
                <div className="mt-3 flex flex-col items-start gap-2 text-[13px] text-[var(--fg-3)]">
                    <p>No agents in {name}.</p>
                    <Button type="button" size="xs" data-add-agent={workspaceId} onClick={onAddAgent}>+ Add agent</Button>
                </div>
            ) : (
                view.lanes.map((lane) => <Lane key={lane.id} lane={lane} onOpenAgent={onOpenAgent} onOpenDeckItem={onOpenDeckItem} onStartAgent={onStartAgent} />)
            )}
        </div>
    );
}
