import { trayOf } from '../../core/row-tray.js';
import { ageLabel, lanesFor, revealOf, type LaneSegment, type Reveal } from '../../core/reveal.js';
import { ActivityLight, Icon, Tooltip } from '@particle-academy/react-fancy';
import { Fragment, useEffect, useState } from 'react';
import { windowDetail, type Headroom } from '../../core/headroom.js';
import type { MailSignal } from '../../core/mail-signals.js';
import { MailSignalLayer } from './MailSignalLayer.js';
import { ProviderLogo, providerName } from './ProviderLogo.js';
import { WORKSPACE_PULSE } from './Sidebar.js';
import { WorkspaceSwatch, wsStyle } from '../workspace-colors.js';
import { dashboardAction, isTypingTarget, stepFocus } from '../../core/keys.js';
import type { DashboardGroup } from '../../core/route.js';
import {
    commsOf,
    contextOf,
    fixRoute,
    groupByStatus,
    groupByWorkspace,
    statusOf,
    type FixRoute,
    summaryChips,
    targetOf,
    type AgentRow,
    type AgentState,
    type Delivery,
    type Fidelity,
    type WorkspaceFault,
    type WorkspaceGroup,
} from '../../core/dashboard-view.js';

/**
 * THE WORKFLOW DASHBOARD — the landing surface.
 *
 * *"What is being produced, and by whom?"* A board you READ. It carries **no resolving
 * control anywhere**: no approve, no deny, no answer, no composer, not even in a row tray. A
 * row click (a waiting one too) opens that agent's chat beside the board, which stays (the
 * owner, 2026-10-28); a question is answered on the Deck, its toast or that chat. `A`/`D` are
 * deliberately unbound on this surface.
 *
 * ## This file only renders
 *
 * Every decision — the sort, the status word, the comms recency level, whether a cell exists
 * at all — comes from `dashboard-view.ts` and is tested without a DOM. What is left here is
 * markup. A decision taken inside a component is a decision nobody checks, and that is where
 * the previous build kept most of them.
 *
 * ## Tailwind, and nothing else (see `docs/decisions.md` D2)
 *
 * `tailwindcss` is a declared peer of `react-fancy`, so it is in-kit and not optional. One
 * styling system: utilities throughout, arbitrary values where the design board states an
 * exact metric. Colour only ever by token name. No inline style objects — they defeat
 * `tailwind-merge`, so a Fancy component could no longer be adjusted through `className`.
 * The two `style` attributes that remain are percentage and pixel *data* — a bar's width and
 * an activity bar's height — which are values, not styling choices.
 *
 * ## Nothing here is hand-rolled that Fancy ships
 *
 * `Icon` for every glyph; **`ActivityLight` for the comms cell**, which is the component it
 * was built for — an *edge* indicator belonging to a pair, where `Avatar status` is a
 * *presence* dot belonging to one party. The bespoke part is the grid template and the row
 * heights, which come from the board as exact values that no generic table reproduces, and
 * nothing here enters the z-index ladder.
 *
 * ## Density budget
 *
 * Twenty agents at 32px rows fit a 900px screen without scrolling. There is no "+n more"
 * anywhere: a census that hides members is not a census.
 */

/** The board's column template, verbatim. Agent · Status · Target · Delivery · Comms · Context. */
const GRID =
    'grid grid-cols-[150px_minmax(190px,1.15fr)_minmax(0,1.1fr)_minmax(0,1.45fr)_60px_84px] gap-4 pl-7 pr-5';

/** Dot colour carries STATE. Shape (below) carries what Genie can see. */
const STATE_DOT: Record<AgentState, string> = {
    working: 'text-[var(--success)]',
    waiting: 'text-[var(--warning)]',
    broken: 'text-[var(--danger)]',
    idle: 'text-[var(--zinc-400)]',
    remote: 'text-[var(--fg-4)]',
};

const STATUS_TONE = {
    ok: 'text-[var(--success)]',
    warn: 'text-[var(--warning)]',
    bad: 'text-[var(--danger)]',
    muted: 'text-[var(--fg-3)]',
} as const;

/**
 * The fidelity dot: **filled** = declared · **ring** = observed · **dashed** = remote.
 *
 * Three shapes rather than three colours, because colour is already carrying state. The
 * distinction has to survive a greyscale screenshot and colour-blindness both, and a reader
 * who cannot tell "Genie is being told this" from "Genie can only see bytes" is reading a
 * board that flatters itself.
 */
export function FidelityDot({ fidelity, state }: { fidelity: Fidelity; state: AgentState }) {
    const colour = STATE_DOT[state];
    if (fidelity === 'declared') {
        return <span data-fidelity="declared" className={`size-2 shrink-0 rounded-full bg-current ${colour}`} />;
    }
    const border = fidelity === 'observed' ? 'border-solid' : 'border-dashed';
    return (
        <span
            data-fidelity={fidelity}
            className={`size-2 shrink-0 rounded-full border-[1.5px] border-current ${border} ${colour}`}
        />
    );
}

const DELIVERY_ICON: Record<Delivery['kind'], string> = {
    commit: 'git-commit-horizontal',
    file: 'file-code',
    handoff: 'arrow-right-left',
    answer: 'message-square-reply',
};

/**
 * The last thing the agent **produced** — never the last thing it said.
 *
 * A waiting agent keeps its delivery; the question it is waiting on goes in Status. Line
 * counts appear only when they came from a real diff, which is why they are nullable rather
 * than defaulted to zero.
 */
function DeliveryCell({ delivery }: { delivery: Delivery | null }) {
    // No delivery renders an EMPTY cell — not a dash, not "none", not a synthesised
    // timestamp. The agent has produced nothing yet, and every one of those alternatives
    // would be an invention the reader would believe.
    if (!delivery) return <div />;

    const mono = delivery.kind === 'commit' || delivery.kind === 'file';
    return (
        <div data-delivery={delivery.kind} className="flex min-w-0 items-center gap-2">
            <Icon name={DELIVERY_ICON[delivery.kind]} size="sm" className="shrink-0 text-[var(--fg-3)]" />
            <span className={`truncate text-xs ${mono ? 'font-mono' : ''}`}>{delivery.main}</span>
            {delivery.sub ? (
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--fg-3)]">{delivery.sub}</span>
            ) : null}
            {delivery.plus !== null ? (
                <span className="shrink-0 font-mono text-[11px] text-[var(--success)]">+{delivery.plus}</span>
            ) : null}
            {delivery.minus !== null ? (
                <span className="shrink-0 font-mono text-[11px] text-[var(--danger)]">−{delivery.minus}</span>
            ) : null}
            <span className="shrink-0 font-mono text-[11px] text-[var(--fg-4)]">{delivery.age}</span>
        </div>
    );
}

/** The 32px agent row. */
/**
 * The collaborator reveal's lanes in a line's left gutter (§4.1): one per peer, solid violet for a live link, dashed
 * `--fg-4` when quiet; a tick into the row at each end. Purely drawn — nothing here is a control.
 */
function Lanes({ segments }: { segments: readonly LaneSegment[] | undefined }) {
    if (!segments || segments.length === 0) return null;
    return (
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-7">
            {segments.map((s) => {
                const x = 5 + s.lane * 5;
                const stroke = s.live ? '2px solid var(--violet-400)' : '2px dashed var(--fg-4)';
                return (
                    <span key={s.lane} data-lane={s.lane} data-part={s.part} data-live={String(s.live)}>
                        <span className="absolute" style={{ left: x, top: s.part === 'start' ? '50%' : 0, bottom: s.part === 'end' ? '50%' : 0, borderLeft: stroke }} />
                        {s.part === 'mid' ? null : <span className="absolute" style={{ left: x, right: 2, top: '50%', borderTop: stroke }} />}
                    </span>
                );
            })}
        </span>
    );
}

/**
 * THE ROW TRAY (§4.1 `Space`): under its row, read-only plus three doors. Sections the row did not measure are not
 * drawn. Nothing here approves, denies or composes — the Deck resolves; the Dashboard shows.
 */
function RowTrayView({ row, onNavigate }: { row: AgentRow; onNavigate: (route: string) => void }) {
    const tray = trayOf(row);
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    return (
        <div data-row-tray={row.id} className="flex flex-col gap-3 border-b border-[var(--border-1)] bg-[var(--bg-1)] py-3 pl-7 pr-5 text-[12px]">
            {tray.target ? (
                <div data-tray-section="target" className="flex flex-col gap-0.5">
                    <span className="text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Target</span>
                    <span className="flex items-center gap-2">{tray.target.step ? <span className="font-mono text-[11px] text-[var(--fg-4)]">{tray.target.step}</span> : null}<span className="text-[var(--fg-2)]">{tray.target.text}</span></span>
                </div>
            ) : null}
            {tray.delivered ? (
                <div data-tray-section="delivered" className="flex flex-col gap-0.5">
                    <span className="text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Delivered</span>
                    <DeliveryCell delivery={row.delivery} />
                </div>
            ) : null}
            {tray.context ? (
                <div data-tray-section="context" className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Context</span>
                    <span className="block h-1 w-24 overflow-hidden rounded-sm bg-[var(--bg-3)]"><span className="block h-full bg-[var(--fg-3)]" style={{ width: `${Math.min(100, Math.round((tray.context.used / tray.context.size) * 100))}%` }} /></span>
                    <span className="font-mono text-[11px] text-[var(--fg-3)]">{`${k(tray.context.used)} / ${k(tray.context.size)}`}</span>
                </div>
            ) : null}
            <div className="flex gap-2">
                {tray.doors.map((d) => (
                    <button key={d.door} type="button" data-door={d.door} onClick={(e) => { e.stopPropagation(); onNavigate(d.route); }} className="rounded-md border border-[var(--border-2)] px-2 py-0.5 text-xs hover:bg-[var(--bg-2)]">{d.label}</button>
                ))}
            </div>
        </div>
    );
}

function AgentRowView({ row, onOpen, onFix, focused = false, reveal = null, lanes, onReveal, emoji }: {
    row: AgentRow;
    /** What the agent just did with Genie (genie#1209), shown beside its name for a moment. */
    emoji?: string | undefined;
    onOpen: (id: string) => void;
    onFix?: ((route: FixRoute) => void) | undefined;
    focused?: boolean | undefined;
    /** The board's collaborator reveal, when one is shown. */
    reveal?: Reveal | null | undefined;
    lanes?: readonly LaneSegment[] | undefined;
    /** Hovering the comms cell reveals this row's collaborators; leaving it ends the reveal. */
    onReveal?: ((id: string | null) => void) | undefined;
}) {
    const role = reveal ? (reveal.focus === row.id ? 'focus' : reveal.peers[row.id] ? 'peer' : 'dim') : null;
    const peerLink = role === 'peer' ? reveal!.peers[row.id]! : null;
    const status = statusOf(row);
    const target = targetOf(row);
    const comms = commsOf(row);
    const context = contextOf(row);

    return (
        <div
            role="row"
            tabIndex={0}
            data-agent={row.id}
            data-state={row.state}
            {...(focused ? { 'data-focused': 'true' } : {})}
            {...(role ? { 'data-reveal': role } : {})}
            onClick={() => onOpen(row.id)}
            className={`${GRID} relative h-8 items-center border-b border-[var(--border-1)] text-[13px] transition-opacity hover:bg-[var(--bg-1)] ${focused ? 'bg-[var(--bg-2)] shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
            // The reveal: the rest dims to .32; the row and its peers carry a 2px violet left border (the board).
            {...(role === 'dim' ? { style: { opacity: 0.32 } } : role ? { style: { boxShadow: 'inset 2px 0 0 var(--violet-400)' } } : {})}
        >
            <Lanes segments={lanes} />
            <div className="flex min-w-0 items-center gap-2">
                <FidelityDot fidelity={row.fidelity} state={row.state} />
                <span className="truncate font-medium">{row.name}</span>
                {emoji ? <span data-row-emoji={emoji} className="shrink-0 animate-pulse" aria-label="what it just did">{emoji}</span> : null}
                <ProviderLogo provider={row.provider} />
            </div>

            <div className="flex min-w-0 items-center gap-1.5">
                <span className={`shrink-0 font-medium ${STATUS_TONE[status.tone]}`}>{status.word}</span>
                {status.detail ? <span className="truncate text-xs text-[var(--fg-3)]" {...(status.title ? { title: status.title } : {})}>{status.detail}</span> : null}
            </div>

            <div className="flex min-w-0 items-center gap-2">
                {target?.kind === 'target' ? (
                    <>
                        {target.step ? (
                            <span className="shrink-0 font-mono text-[11px] text-[var(--fg-4)]">{target.step}</span>
                        ) : null}
                        <span className="truncate text-[var(--fg-2)]">{target.text}</span>
                    </>
                ) : null}

                {/*
                 * Activity bars for an observed agent: a MEASUREMENT, where a target is a
                 * claim. Genie sees bytes from that TUI and nothing else, so it draws what it
                 * measured rather than a sentence it would have to invent.
                 */}
                {target?.kind === 'activity' ? (
                    <div data-activity="bars" className="flex h-4 items-end gap-0.5 text-[var(--fg-4)]">
                        {target.bars.map((b, i) => (
                            <span key={i} className="w-[3px] rounded-[1px] bg-current" style={{ height: `${b}px` }} />
                        ))}
                    </div>
                ) : null}

                {/* Broken: the target is replaced by the ROUTE TO FIX IT. */}
                {target?.kind === 'fixes' ? (
                    <div className="flex min-w-0 gap-1.5">
                        {target.fixes.map((f) => (
                            <button
                                key={f}
                                type="button"
                                data-fix={f}
                                data-fix-for={row.id}
                                onClick={(e) => { e.stopPropagation(); (onFix ?? ((r) => onOpen(r.agentId)))(fixRoute(row.id, f)); }}
                                className="shrink-0 rounded-md border border-[var(--border-2)] px-2 py-px text-xs hover:bg-[var(--bg-2)]"
                            >
                                {f}
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>

            <DeliveryCell delivery={row.delivery} />

            {/*
             * Comms. Absent for observed and remote agents, and absent when the count could
             * not be attributed — a `0` would claim this agent works alone.
             *
             * The number beside the icon is COLLABORATORS; `ActivityLight`'s own `count` is
             * traffic VOLUME, which this column does not show, so it is deliberately not
             * passed. Violet overrides the component's generic emerald ramp because the board
             * specifies violet for comms, and `tailwind-merge` resolves the later class.
             */}
            <div
                className="flex items-center gap-1.5 text-xs text-[var(--fg-2)]"
                {...(comms && comms.count > 0 && onReveal ? { onMouseEnter: () => onReveal(row.id), onMouseLeave: () => onReveal(null) } : {})}
            >
                {peerLink ? (
                    // A peer in the reveal: its link to the focused row — messages · age of the newest.
                    <span data-peer-link={row.id} className="font-mono text-[11px] text-[var(--violet-400)]">{`↔ ${peerLink.count} · ${ageLabel(peerLink.ageSeconds)}`}</span>
                ) : comms ? (
                    <>
                        <Icon name="users" size="sm" className="shrink-0 text-[var(--fg-4)]" />
                        <span className="font-mono tabular-nums">{comms.count}</span>
                        <ActivityLight
                            level={comms.level}
                            label={`${row.name} and its collaborators`}
                            className={comms.level === 'live' ? 'text-[var(--violet-400)]' : ''}
                        />
                    </>
                ) : null}
            </div>

            {/* Context: a WARNING, not a readout. Nothing below 160k; amber there, red at 180k. */}
            <div className="flex items-center gap-1.5">
                {context ? (
                    <>
                        <span className="block h-1 w-9 overflow-hidden rounded-sm bg-[var(--bg-3)]">
                            <span
                                data-context-bar={context.tone}
                                className={`block h-full ${context.tone === 'bad' ? 'bg-[var(--danger)]' : 'bg-[var(--warning)]'}`}
                                style={{ width: `${context.pct}%` }}
                            />
                        </span>
                        <span
                            className={`font-mono text-[11px] ${context.tone === 'bad' ? 'text-[var(--danger)]' : 'text-[var(--warning)]'}`}
                        >
                            {Math.round(context.used / 1000)}k
                        </span>
                    </>
                ) : null}
            </div>
        </div>
    );
}

function GroupHeader({
    group,
    name,
    path,
    onAddAgent,
    onOpenWorkspace,
    onLocateRepo,
    lanes,
    pulsed = false,
    color = null,
}: {
    /** An agent acted in this workspace and the person has not been there since (genie#1265): the header pulses. */
    pulsed?: boolean;
    /** The workspace's colour (genie#1300): the header's left edge and a swatch beside its name. `null` = none known. */
    color?: string | null | undefined;
    group: WorkspaceGroup;
    /** The envelope's name, else the folder — the rail's rule; the id only when nothing else is known. */
    name: string;
    path: string;
    onAddAgent: (workspaceId: string) => void;
    onOpenWorkspace?: ((workspaceId: string) => void) | undefined;
    onLocateRepo?: ((workspaceId: string, repo: string) => void) | undefined;
    lanes?: readonly LaneSegment[] | undefined;
}) {
    return (
        <>
            <div className={`relative flex h-7 items-center whitespace-nowrap border-b border-[var(--border-1)] bg-[var(--bg-1)] pl-7 pr-5 text-xs${pulsed ? ` ${WORKSPACE_PULSE}` : ''}${color ? ' border-l-4 border-l-[var(--ws)]' : ''}`} data-workspace-head={group.workspaceId} {...(color ? { 'data-workspace-color': color } : {})} style={wsStyle(color)} {...(pulsed ? { 'data-workspace-pulse': 'true', title: 'An agent did something here — open it to see' } : {})}>
                <Lanes segments={lanes} />
                <WorkspaceSwatch color={color} className="mr-1.5" />
                <span className="font-semibold">{name}</span>
                <span className="ml-2.5 min-w-0 truncate font-mono text-[11px] text-[var(--fg-4)]">{path}</span>
                {group.summary ? <span className="ml-2.5 shrink-0 text-[var(--fg-3)]">{group.summary}</span> : null}
                {group.governedBy ? <span data-governed-by={group.governedBy} className="ml-2.5 shrink-0 text-[var(--fg-4)]">governed by {group.governedBy}</span> : null}
                {/* THE WORKSPACE-LEVEL FAULT (the board): `⚠ repo site not found in moic.agi` and its own fix button. */}
                {group.fault ? (
                    <span data-workspace-fault={group.fault.repo} className="ml-2.5 flex shrink-0 items-center gap-1.5 text-[var(--warning)]">
                        <Icon name="circle-alert" size="xs" />
                        {group.fault.text}
                        <button type="button" data-action="locate-repo" onClick={() => onLocateRepo?.(group.workspaceId, group.fault!.repo)} className="rounded border border-[var(--border-1)] px-1.5 text-[11px] text-[var(--fg-2)] hover:bg-[var(--bg-2)]">Locate repo</button>
                    </span>
                ) : null}
                {/* A DOOR, not a label: the board's right-aligned `Open workspace →` opens the workspace's own page. */}
                <button type="button" data-open-workspace={group.workspaceId} onClick={() => onOpenWorkspace?.(group.workspaceId)} className="ml-auto shrink-0 rounded px-1 text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]">Open workspace →</button>
            </div>

            {/*
             * An empty workspace gets a row that OFFERS something, rather than a blank space
             * that reads as a loading failure. "No agents" and "we have not heard yet" are
             * different claims and must not share a rendering.
             */}
            {group.empty ? (
                <div className="flex h-8 items-center gap-3 border-b border-[var(--border-1)] pl-7 pr-5 text-[13px] text-[var(--fg-3)]">
                    <span>No agents</span>
                    <button
                        type="button"
                        data-add-agent={group.workspaceId}
                        onClick={() => onAddAgent(group.workspaceId)}
                        className="flex items-center gap-1 rounded-md border border-[var(--border-1)] px-2 py-px text-xs hover:bg-[var(--bg-2)]"
                    >
                        <Icon name="plus" size="xs" />
                        Add agent
                    </button>
                </div>
            ) : null}
        </>
    );
}

const CHIP_DOT: Record<AgentState, string> = {
    waiting: 'bg-[var(--warning)]',
    broken: 'bg-[var(--danger)]',
    working: 'bg-[var(--success)]',
    idle: 'bg-[var(--zinc-400)]',
    remote: 'bg-[var(--fg-4)]',
};

export interface DashboardProps {
    rows: readonly AgentRow[];
    /**
     * Registry workspaces in rail order, including those with no agents. Hibernated entries are filtered here.
     *
     * `null` = **not read yet**, which renders a skeleton. `[]` = read, and there are none,
     * which renders the first-run invitation. Collapsing them puts a confident claim about an
     * empty machine on screen before anybody has looked.
     */
    workspaces: readonly { id: string; path: string; name?: string | undefined; governedBy?: string | null | undefined; asleep?: boolean | undefined; color?: string | undefined }[] | null;
    onOpenAgent: (agentId: string) => void;
    onAddAgent: (workspaceId: string) => void;
    onAddWorkspace?: (() => void) | undefined;
    onAddWorkspaceFromGit?: (() => void) | undefined;
    /** The third source (§6.1): the envelope from the Tynn project the token belongs to. */
    onAddWorkspaceFromTynn?: (() => void) | undefined;
    /** `By workspace | By status` — from the route's `group=`; defaults to workspace. */
    group?: DashboardGroup | undefined;
    onGroup?: ((group: DashboardGroup) => void) | undefined;
    /** `Open workspace →` on a group header. */
    onOpenWorkspace?: ((workspaceId: string) => void) | undefined;
    /** Workspace-level faults by workspace id (a missing repo), from the registry each workspace lists; absent = none seen. */
    faults?: Readonly<Record<string, WorkspaceFault | null | undefined>> | undefined;
    /** The fault's fix: the workspace's registry, where the path is edited. */
    onLocateRepo?: ((workspaceId: string, repo: string) => void) | undefined;
    /** A broken row's fix button (`core/dashboard-view.ts` `fixRoute`); absent = the button opens the agent. */
    onFix?: ((route: FixRoute) => void) | undefined;
    /** Genie's own agent's row (the design mockup's first group, `default agent · not in a workspace`); `null` = none. */
    genie?: AgentRow | null | undefined;
    /** `Chat ⌘J` — the composer, on genie, one click from the board. */
    onChat?: (() => void) | undefined;
    /** The row cursor (`J`/`K`), controlled — for tests that render server-side. Otherwise the board keeps its own. */
    focusedId?: string | null | undefined;
    /** The collaborator reveal's row, controlled — for server-side tests. Otherwise hover and `C` drive the board's own. */
    revealId?: string | null | undefined;
    /** The open row tray, controlled — for server-side tests. Otherwise `Space` on the cursor row drives the board's own. */
    trayId?: string | null | undefined;
    /** The tray's doors navigate; absent = `Open agent →` still opens the agent and the others do nothing. */
    onNavigate?: ((route: string) => void) | undefined;
    /** What each agent just did with Genie (genie#1209): 👍 thumbsUp, ✅ imDone, 🧞 a Genie action — by agent id. */
    rowEmoji?: Readonly<Record<string, string>> | undefined;
    /** Each provider's rate limit, buffered in main (the header's pills). */
    rateLimits?: Readonly<Record<string, Headroom>> | undefined;
    /** Mail between agents, drawn from the sender's row to the recipient's (genie#1209). */
    mailSignals?: readonly MailSignal[] | undefined;
    /** Workspaces an agent acted in that the person has not visited since (genie#1265): their group headers pulse. */
    pulsing?: ReadonlySet<string> | undefined;
}

export function Dashboard({ rows: reportedRows, genie = null, workspaces: knownWorkspaces, onOpenAgent, onAddAgent, onAddWorkspace, onAddWorkspaceFromGit, onAddWorkspaceFromTynn, group = 'workspace', onGroup, onOpenWorkspace, faults, onLocateRepo, onFix, onChat, focusedId, revealId, trayId, onNavigate, rowEmoji, rateLimits, mailSignals, pulsing }: DashboardProps) {
    // Hide known hibernated workspaces consistently; unregistered agents keep their status visibility.
    const workspaces = knownWorkspaces?.filter((workspace) => workspace.asleep !== true) ?? null;
    const hibernatedIds = new Set((knownWorkspaces ?? []).filter((workspace) => workspace.asleep === true).map((workspace) => workspace.id));
    const rows = reportedRows.filter((row) => !hibernatedIds.has(row.workspaceId));
    const groups = groupByWorkspace(
        rows,
        (workspaces ?? []).map((w) => w.id),
        Object.fromEntries((workspaces ?? []).flatMap((w) => (w.governedBy ? [[w.id, w.governedBy]] : []))),
        faults ?? {},
    );
    // THE ROW CURSOR (§4.1): `J`/`K` over the rows in document order, `↵` opens, `G` cycles the grouping. `A`/`D` are
    // unbound here — the Dashboard resolves nothing. The keys are decided in `core/keys.ts`; letters never act while typing.
    const [ownFocus, setOwnFocus] = useState<string | null>(null);
    const focused = focusedId ?? ownFocus;
    // THE COLLABORATOR REVEAL (§4.1): hover a comms cell, or `C` on the cursor row; in the table, never a popover.
    const [ownReveal, setOwnReveal] = useState<string | null>(null);
    const reveal = revealOf(rows, revealId ?? ownReveal);
    // THE ROW TRAY (§4.1): `Space` on the cursor row; one open at a time.
    const [ownTray, setOwnTray] = useState<string | null>(null);
    const openTray = trayId ?? ownTray;
    const go = (route: string) => { if (onNavigate) onNavigate(route); else if (route.startsWith('genie://agent/')) onOpenAgent(route.slice('genie://agent/'.length)); };
    // EVERY ROW DRAWN — genie's own, then the workspace agents: what the census counts and the cursor walks.
    const all = genie ? [genie, ...rows] : rows;
    const statusGroupsForOrder = groupByStatus(all);
    const visibleIds = group === 'status' ? statusGroupsForOrder.flatMap((g) => g.rows.map((r) => r.id)) : [...(genie ? [genie.id] : []), ...groups.flatMap((g) => g.rows.map((r) => r.id))];
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const action = dashboardAction({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: isTypingTarget(e.target as never) });
            if (action === null) return;
            e.preventDefault();
            if (action === 'next-row') setOwnFocus(stepFocus(visibleIds, focused, 1));
            else if (action === 'prev-row') setOwnFocus(stepFocus(visibleIds, focused, -1));
            else if (action === 'open') { if (focused !== null && visibleIds.includes(focused)) onOpenAgent(focused); }
            else if (action === 'cycle-group') onGroup?.(group === 'workspace' ? 'status' : 'workspace');
            else if (action === 'reveal') setOwnReveal((r) => (r !== null || focused === null ? null : focused));
            else if (action === 'tray') setOwnTray((t) => (focused === null || t === focused ? null : focused));
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [visibleIds, focused, onOpenAgent, onGroup, group]);
    const statusGroups = groupByStatus(all);
    // The board's lines in document order (rows and group headers), for the reveal's lanes.
    const lines = group === 'status'
        ? statusGroups.flatMap((g) => [`head:${g.state}`, ...g.rows.map((r) => r.id)])
        : [...(genie ? ['head:genie', genie.id] : []), ...groups.flatMap((g) => [`head:${g.workspaceId}`, ...g.rows.map((r) => r.id)])];
    const lanes = reveal ? lanesFor(lines, reveal) : null;
    // The census counts every row drawn, genie's included — each count has its row (the mockup's header).
    const chips = summaryChips(all);
    const pathOf = (id: string): string => workspaces?.find((w) => w.id === id)?.path ?? '';
    const colorOf = (id: string): string | null => workspaces?.find((w) => w.id === id)?.color ?? null;
    // The rail's rule: the envelope's name, else the folder, never the id when a name is known.
    const nameOf = (id: string): string => { const w = workspaces?.find((x) => x.id === id); return w?.name ?? (w?.path ? w.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? id : id); };
    // The legend belongs to the cannot-see state: it appears when the board holds an agent Genie can only observe or
    // only see the presence of — the one moment the dot shapes need explaining.
    const legend = rows.some((r) => r.fidelity !== 'declared');

    /**
     * FIRST PAINT, before the bridge has answered.
     *
     * *"First paint is skeletons, never zeros and never an empty state."* A skeleton says "we
     * are still reading"; the first-run invitation below says "we read, and there is nothing
     * here". Showing the second while the first is true is a confident claim about somebody's
     * machine, made before anybody looked at it.
     */
    if (workspaces === null) {
        return (
            <div data-dashboard="loading" data-surface="dashboard" className="flex h-full flex-col gap-2 p-7">
                {[0, 1, 2].map((i) => (
                    <div key={i} className="h-8 w-full animate-pulse rounded-md bg-[var(--bg-2)]" />
                ))}
            </div>
        );
    }

    /**
     * THE FIRST RUN — and this was missing until somebody opened the window.
     *
     * With no workspaces there are no groups, so the board rendered its header and its column
     * headers over **a completely blank body**. Every markup test passed, because every test
     * handed it workspaces — which is what a test author thinks to write, and the one state
     * every new user sees first is the one nobody fixtures.
     *
     * It failed the owner's acceptance bar outright: *"a person who has never used Genie,
     * given no instructions, reaches the Dashboard and opens an agent within 30 seconds."*
     * There was nothing on the screen to click.
     *
     * So: no table at all, because column headers over a void read as a list that failed to
     * load. One sentence that is true, and the single action that leads anywhere.
     */
    if (knownWorkspaces?.length === 0) {
        return (
            <div data-dashboard="first-run" data-surface="dashboard" className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
                <h1 className="text-lg font-semibold tracking-tight">Nothing is being worked on yet</h1>
                <p className="max-w-[46ch] text-[13px] text-[var(--fg-3)]">
                    A workspace is a folder Genie works in. Add one and its agents appear here, with
                    what each is doing and what it has produced.
                </p>
                <button
                    type="button"
                    data-add-workspace
                    onClick={onAddWorkspace}
                    className="flex items-center gap-1.5 rounded-lg border border-[var(--border-2)] px-3 py-1.5 text-[13px] hover:bg-[var(--bg-2)]"
                >
                    <Icon name="plus" size="sm" />
                    Add a workspace
                </button>
                {onAddWorkspaceFromGit ? (
                    <button type="button" data-action="add-from-git" onClick={onAddWorkspaceFromGit} className="flex items-center gap-1.5 rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-[13px] hover:bg-[var(--bg-2)]">
                        From a git URL
                    </button>
                ) : null}
                {onAddWorkspaceFromTynn ? (
                    <button type="button" data-action="add-from-tynn" onClick={onAddWorkspaceFromTynn} className="flex items-center gap-1.5 rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-[13px] hover:bg-[var(--bg-2)]">
                        <Icon name="link" size="sm" />
                        From Tynn
                    </button>
                ) : null}
            </div>
        );
    }

    return (
        <div data-surface="dashboard" className="relative flex min-h-0 flex-col">
            {/* View header, 56px. */}
            <div data-view-header="" className="flex h-14 shrink-0 items-center gap-4 border-b border-[var(--border-1)] pl-7 pr-5">
                <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
                <div className="flex items-center gap-3.5 text-xs text-[var(--fg-2)]">
                    {chips.map((c) => (
                        <span key={c.state} data-chip={c.state} className="flex items-center gap-1.5">
                            <span className={`size-2 shrink-0 rounded-full ${CHIP_DOT[c.state]}`} />
                            {c.label}
                        </span>
                    ))}
                </div>
                <span className="flex-1" />
                {/* The keys, discoverable: J K move, ↵ opens, G regroups. A/D are not here — the Deck resolves. */}
                <span data-key-hints="" className="flex items-center gap-1 text-[10px] text-[var(--fg-4)]" title="J / K move the cursor · ↵ opens the agent · G cycles the grouping">
                    {['J', 'K', '↵', 'G'].map((k) => <kbd key={k} className="rounded border border-[var(--border-1)] px-1 font-mono">{k}</kbd>)}
                </span>
                {/* The board's segmented control. The grouping lives in the route (`group=`), so it is linkable. */}
                <div className="flex overflow-hidden rounded-lg border border-[var(--border-1)] text-xs">
                    {(['workspace', 'status'] as const).map((g, i) => (
                        <button key={g} type="button" data-group-toggle={g} {...(g === group ? { 'data-current': 'true' } : {})} onClick={() => onGroup?.(g)} className={`px-2.5 py-1 ${i > 0 ? 'border-l border-[var(--border-1)] ' : ''}${g === group ? 'bg-[var(--bg-3)] text-[var(--fg-1)]' : 'text-[var(--fg-3)] hover:bg-[var(--bg-2)]'}`}>
                            {g === 'workspace' ? 'By workspace' : 'By status'}
                        </button>
                    ))}
                </div>
                <RateLimitPills limits={rateLimits ?? {}} />
                {/* `py-1`, not a row-height class: the row-height census counts ` h-7 ` as "28px header rows", and this is a button. */}
                <button type="button" data-action="chat-genie" onClick={() => onChat?.()} title="Chat with genie — the composer, one click from the board" className="flex items-center gap-1.5 rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-xs text-[var(--fg-2)] hover:bg-[var(--bg-2)]">
                    <Icon name="message-square" className="h-3.5 w-3.5" />
                    Chat
                    <span className="font-mono text-[11px] text-[var(--fg-4)]">⌘J</span>
                </button>
            </div>
            {legend ? (
                <div data-legend="" className="flex shrink-0 items-center gap-5 border-b border-[var(--border-1)] px-7 py-2 text-xs text-[var(--fg-3)]">
                    <span className="flex items-center gap-1.5"><span className="size-[7px] rounded-full bg-[var(--fg-3)]" />Declared — reports plan, deliveries, comms, usage</span>
                    <span className="flex items-center gap-1.5"><span className="size-[7px] rounded-full border-[1.5px] border-[var(--fg-3)]" />Observed — terminal activity, commits and file writes only</span>
                    <span className="flex items-center gap-1.5"><span className="size-[7px] rounded-full border-[1.5px] border-dashed border-[var(--fg-3)]" />Remote — presence only</span>
                </div>
            ) : null}

            {/*
             * `truncate` on every header, and it is not cosmetic.
             *
             * The header row is a fixed 28px. A two-word label in a narrow column WRAPS, and
             * the second line has nowhere to go — it spills out of the row and over the first
             * agent beneath it. Seen on a 1024px-wide Windows window, where "Current target"
             * broke across two lines; invisible at the 1440px the board is drawn at, which is
             * the only width I had been looking at.
             *
             * Truncating is the right answer rather than shrinking the type: a clipped header
             * is still readable from its neighbours and its column, and a reader who needs the
             * full word can widen the window.
             */}
            <div
                className={`${GRID} h-7 items-center border-b border-[var(--border-1)] text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]`}
            >
                <span className="truncate">Agent</span>
                <span className="truncate">Status</span>
                <span className="truncate">Current target</span>
                <span className="truncate">Latest delivery</span>
                <span className="truncate">Comms</span>
                <span className="truncate">Context</span>
            </div>

            {group === 'status' ? (
                <div data-group-by="status">
                    {statusGroups.map((g) => (
                        <div key={g.state} data-status-group={g.state}>
                            <div className="relative flex h-7 items-center whitespace-nowrap border-b border-[var(--border-1)] bg-[var(--bg-1)] pl-7 pr-5 text-xs">
                                <Lanes segments={lanes?.[`head:${g.state}`]} />
                                <span className={`mr-2 size-2 rounded-full ${CHIP_DOT[g.state]}`} />
                                <span className="font-semibold">{g.label}</span>
                                <span className="ml-2.5 text-[var(--fg-3)]">{g.rows.length} {g.rows.length === 1 ? 'agent' : 'agents'}</span>
                            </div>
                            {g.rows.map((row) => (
                                <Fragment key={row.id}>
                                    <AgentRowView row={row} emoji={rowEmoji?.[row.id]} onOpen={onOpenAgent} onFix={onFix} focused={row.id === focused} reveal={reveal} lanes={lanes?.[row.id]} onReveal={setOwnReveal} />
                                    {openTray === row.id ? <RowTrayView row={row} onNavigate={go} /> : null}
                                </Fragment>
                            ))}
                        </div>
                    ))}
                </div>
            ) : (
            <>
            {/* GENIE'S OWN GROUP (the design mockup): first, `genie · default agent · not in a workspace · 1 agent`. */}
            {genie ? (
                <div data-genie-group="">
                    <div className="relative flex h-7 items-center whitespace-nowrap border-b border-[var(--border-1)] bg-[var(--bg-1)] pl-7 pr-5 text-xs">
                        <Lanes segments={lanes?.['head:genie']} />
                        <span className="font-semibold">genie</span>
                        <span className="ml-2.5 min-w-0 truncate font-mono text-[11px] text-[var(--fg-4)]">default agent · not in a workspace</span>
                        <span className="ml-2.5 shrink-0 text-[var(--fg-3)]">1 agent</span>
                    </div>
                    <AgentRowView row={genie} emoji={rowEmoji?.[genie.id]} onOpen={onOpenAgent} onFix={onFix} focused={genie.id === focused} reveal={reveal} lanes={lanes?.[genie.id]} onReveal={setOwnReveal} />
                    {openTray === genie.id ? <RowTrayView row={genie} onNavigate={go} /> : null}
                </div>
            ) : null}
            {groups.map((group) => (
                <div key={group.workspaceId} data-workspace={group.workspaceId}>
                    <GroupHeader pulsed={pulsing?.has(group.workspaceId) === true} color={colorOf(group.workspaceId)} group={group} name={nameOf(group.workspaceId)} path={pathOf(group.workspaceId)} onAddAgent={onAddAgent} onOpenWorkspace={onOpenWorkspace} onLocateRepo={onLocateRepo} lanes={lanes?.[`head:${group.workspaceId}`]} />
                    {group.rows.map((row) => (
                        <Fragment key={row.id}>
                            <AgentRowView row={row} emoji={rowEmoji?.[row.id]} onOpen={onOpenAgent} onFix={onFix} focused={row.id === focused} reveal={reveal} lanes={lanes?.[row.id]} onReveal={setOwnReveal} />
                            {openTray === row.id ? <RowTrayView row={row} onNavigate={go} /> : null}
                        </Fragment>
                    ))}
                </div>
            ))}
            </>
            )}
            {workspaces.length === 0 ? (
                <p data-dashboard-no-active-workspaces="" role="status" className="px-7 py-5 text-[13px] text-[var(--fg-3)]">
                    No active workspaces. Wake a hibernated workspace from the sidebar to see it here.
                </p>
            ) : null}
            <MailSignalLayer signals={mailSignals ?? []} />
        </div>
    );
}

/**
 * ONE RATE-LIMIT PILL PER PROVIDER in the Dashboard header (the owner, 2026-10-26): its share of the binding window left;
 * on hover EVERY window the provider reported, with its usage and reset (genie#1268). Buffered in main, so this redraws
 * at most once per provider per buffer.
 */
export function RateLimitPills({ limits }: { limits: Readonly<Record<string, Headroom>> }) {
    const providers = Object.keys(limits).sort();
    if (providers.length === 0) return null;
    return (
        <div data-rate-limits="" className="flex items-center gap-1.5">
            {providers.map((p) => {
                const h = limits[p]!;
                const tone = h.over || h.leftPct <= 10 ? 'text-[var(--danger)]' : h.leftPct <= 30 ? 'text-[var(--warning)]' : 'text-[var(--fg-2)]';
                return (
                    <Tooltip key={p} content={<RateLimitDetail provider={p} limit={h} />} placement="bottom">
                        {/* The hover's words are the pill's accessible name: a screen reader never sees a tooltip drawn on hover. */}
                        <span data-rate-limit={p} role="group" tabIndex={0} aria-label={`${providerName(p)} rate limits: ${h.windows.map(windowDetail).join('; ')}`} className="flex items-center gap-1 rounded-lg border border-[var(--border-1)] px-2 py-1 text-xs">
                            <ProviderLogo provider={p} size="xs" className="text-[var(--fg-3)]" />
                            <span className={`font-mono ${tone}`}>{h.over ? 'over' : `${h.leftPct}%`}</span>
                            <span className="font-mono text-[11px] text-[var(--fg-4)]">{h.window}</span>
                        </span>
                    </Tooltip>
                );
            })}
        </div>
    );
}

/** The pill's hover (genie#1268): the provider's logo and plan, then every window it reported — only reported figures. */
export function RateLimitDetail({ provider, limit }: { provider: string; limit: Headroom }) {
    return (
        <div data-rate-limit-detail={provider} className="flex flex-col gap-1 text-xs">
            <span className="flex items-center gap-1.5">
                <ProviderLogo provider={provider} size="sm" />
                {limit.plan ? <span className="text-[var(--fg-3)]">{limit.plan}</span> : null}
            </span>
            {limit.windows.map((w) => (
                <span key={w.window} data-rate-limit-window={w.window} className="font-mono">{windowDetail(w)}</span>
            ))}
        </div>
    );
}
