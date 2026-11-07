import { trayOf } from '../../core/row-tray.js';
import { ageLabel, lanesFor, revealOf, type LaneSegment, type Reveal } from '../../core/reveal.js';
import { ActivityLight, Button, Icon, Popover } from '@particle-academy/react-fancy';
import { Fragment, useEffect, useState, type CSSProperties } from 'react';
import { limitLevel, limitRows, resetsIn, tightestWindow, windowWords, type Headroom, type LimitLevel } from '../../core/headroom.js';
import { shortDateTime } from '../../core/clock-words.js';
import type { MailSignal } from '../../core/mail-signals.js';
import { MailSignalLayer } from './MailSignalLayer.js';
import { ProviderLogo, providerName } from './ProviderLogo.js';
import { WORKSPACE_PULSE } from './Sidebar.js';
import { WorkspaceSwatch } from '../workspace-colors.js';
import { dashboardAction, isTypingTarget, stepFocus } from '../../core/keys.js';
import {
    commsOf,
    contextOf,
    fixRoute,
    dashboardRows,
    shownState,
    statusOf,
    type FixRoute,
    summaryChips,
    targetOf,
    type AgentRow,
    type AgentState,
    type Delivery,
    type Fidelity,
    type WorkspaceFault,
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

/** One shared template: Agent · Workspace · Status · Target · Delivery · Comms · Context. */
const GRID =
    'grid grid-cols-[150px_120px_minmax(160px,1.15fr)_minmax(0,1.1fr)_minmax(0,1.45fr)_60px_84px] gap-4 pl-7 pr-5';

/** Dot colour carries STATE. Shape (below) carries what Genie can see. */
/** One status colour for the whole row, fidelity dot and census chip. */
const STATE_COLOR: Record<AgentState, string> = {
    working: 'var(--success)', cooling: 'var(--sky-400)', waiting: 'var(--warning)', broken: 'var(--danger)',
    idle: 'var(--zinc-400)', sleeping: 'var(--fg-4)', stopped: 'var(--danger)', remote: 'var(--fg-4)',
};
const stateStyle = (state: AgentState): CSSProperties => ({ '--agent-status': STATE_COLOR[state] } as CSSProperties);

const STATUS_TONE = {
    ok: 'text-[var(--success)]',
    warn: 'text-[var(--warning)]',
    bad: 'text-[var(--danger)]',
    muted: 'text-[var(--fg-3)]',
    // Cooling (core/session.ts COOLING_MS): its own colour, not Working's green nor Idle's grey.
    cool: 'text-[var(--sky-400)]',
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
    const colour = 'text-[var(--agent-status)]';
    if (fidelity === 'declared') {
        return <span data-fidelity="declared" style={stateStyle(state)} className={`size-2 shrink-0 rounded-full bg-current ${colour}`} />;
    }
    const border = fidelity === 'observed' ? 'border-solid' : 'border-dashed';
    return (
        <span
            data-fidelity={fidelity} style={stateStyle(state)}
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
                    <Button key={d.door} type="button" size="xs" data-door={d.door} onClick={(e) => { e.stopPropagation(); onNavigate(d.route); }}>{d.label}</Button>
                ))}
            </div>
        </div>
    );
}

function AgentRowView({ row, workspaceName, workspaceColor, workspaceFault, workspacePulsed = false, onLocateRepo, onOpenWorkspace, onOpen, onFix, focused = false, reveal = null, lanes, onReveal, emoji }: {
    row: AgentRow;
    workspaceName: string;
    workspaceColor?: string | undefined;
    workspaceFault?: WorkspaceFault | null | undefined;
    workspacePulsed?: boolean | undefined;
    onLocateRepo?: ((workspaceId: string, repo: string) => void) | undefined;
    onOpenWorkspace?: ((workspaceId: string) => void) | undefined;    /** What the agent just did with Genie (genie#1209), shown beside its name for a moment. */
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
            data-state={shownState(row)}
            {...(focused ? { 'data-focused': 'true' } : {})}
            {...(role ? { 'data-reveal': role } : {})}
            onClick={() => onOpen(row.id)}
            className={`${GRID} relative h-8 cursor-pointer items-center border-b border-[var(--border-1)] text-[13px] transition-opacity border-l-2 border-l-[var(--agent-status)] bg-[color-mix(in_srgb,var(--agent-status)_9%,transparent)] hover:bg-[color-mix(in_srgb,var(--agent-status)_15%,transparent)] ${focused ? 'bg-[var(--bg-2)] shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
            // The reveal: the rest dims to .32; the row and its peers carry a 2px violet left border (the board).
            style={{ ...stateStyle(shownState(row)), ...(shownState(row) === 'sleeping' ? { opacity: 0.5 } : {}), ...(role === 'dim' ? { opacity: 0.32 } : role ? { boxShadow: 'inset 2px 0 0 var(--violet-400)' } : {}) }}
        >
            <Lanes segments={lanes} />
            <div className="flex min-w-0 items-center gap-2">
                <FidelityDot fidelity={row.fidelity} state={shownState(row)} />
                <span className="truncate font-medium">{row.name}</span>
                {emoji ? <span data-row-emoji={emoji} className="shrink-0 animate-pulse" aria-label="what it just did">{emoji}</span> : null}
                <ProviderLogo provider={row.provider} />
            </div>

            <div data-column="workspace" data-workspace={row.workspaceId} {...(workspacePulsed ? { 'data-workspace-pulse': 'true' } : {})} className={`flex min-w-0 items-center gap-1.5${workspacePulsed ? ` ${WORKSPACE_PULSE}` : ''}`}>
                {workspaceColor ? <WorkspaceSwatch color={workspaceColor} /> : null}
                {onOpenWorkspace ? (
                    <Button type="button" variant="ghost" size="xs" data-open-workspace={row.workspaceId} className="min-w-0 px-0 text-xs font-normal text-[var(--fg-2)]" labelClassName="truncate" onClick={(event) => { event.stopPropagation(); onOpenWorkspace(row.workspaceId); }} title={workspaceName}>{workspaceName}</Button>
                ) : <span className="truncate text-xs text-[var(--fg-3)]">{workspaceName}</span>}
                {workspaceFault ? <Button type="button" variant="ghost" size="xs" icon="triangle-alert" data-workspace-fault={workspaceFault.repo} data-action="locate-repo" aria-label="Locate repo" title={workspaceFault.text} className="shrink-0 px-1 text-[var(--warning)]" onClick={(event) => { event.stopPropagation(); onLocateRepo?.(row.workspaceId, workspaceFault.repo); }} /> : null}
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
                            <Button
                                key={f}
                                type="button"
                                size="xs"
                                data-fix={f}
                                data-fix-for={row.id}
                                onClick={(e) => { e.stopPropagation(); (onFix ?? ((r) => onOpen(r.agentId)))(fixRoute(row.id, f)); }}
                                className="shrink-0 py-px"
                            >
                                {f}
                            </Button>
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
    /** Sidebar-only metadata exists even when there are no active workspaces. */
    hasHibernatedWorkspaces?: boolean | undefined;
    onOpenAgent: (agentId: string) => void;
    onAddAgent: (workspaceId: string) => void;
    onAddWorkspace?: (() => void) | undefined;
    onAddWorkspaceFromGit?: (() => void) | undefined;
    /** The third source (§6.1): the envelope from the Tynn project the token belongs to. */
    onAddWorkspaceFromTynn?: (() => void) | undefined;
    /** Open the workspace named in an agent's Workspace column. */
    onOpenWorkspace?: ((workspaceId: string) => void) | undefined;
    /** Workspace-level faults by workspace id (a missing repo), from the registry each workspace lists; absent = none seen. */
    faults?: Readonly<Record<string, WorkspaceFault | null | undefined>> | undefined;
    /** The fault's fix: the workspace's registry, where the path is edited. */
    onLocateRepo?: ((workspaceId: string, repo: string) => void) | undefined;
    /** A broken row's fix button (`core/dashboard-view.ts` `fixRoute`); absent = the button opens the agent. */
    onFix?: ((route: FixRoute) => void) | undefined;
    /** Genie's own agent's row; `null` = none. Alphabetical alongside workspace agents. */
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
    /** Workspaces an agent acted in that the person has not visited since: their Workspace cells pulse. */
    pulsing?: ReadonlySet<string> | undefined;
}

function readShown(kind: 'sleeping' | 'stopped'): boolean {
    try { return typeof window !== 'undefined' && window.localStorage.getItem(`genie.dashboard.show.${kind}`) === '1'; }
    catch { return false; }
}

export function Dashboard({ rows: reportedRows, genie = null, workspaces: knownWorkspaces, hasHibernatedWorkspaces = false, onOpenAgent, onAddAgent, onAddWorkspace, onAddWorkspaceFromGit, onAddWorkspaceFromTynn, onOpenWorkspace, faults, onLocateRepo, onFix, onChat, focusedId, revealId, trayId, onNavigate, rowEmoji, rateLimits, mailSignals, pulsing }: DashboardProps) {
    const workspaces = knownWorkspaces?.filter((workspace) => workspace.asleep !== true) ?? null;
    const hibernatedIds = new Set((knownWorkspaces ?? []).filter((workspace) => workspace.asleep === true).map((workspace) => workspace.id));
    const rows = reportedRows.filter((row) => !hibernatedIds.has(row.workspaceId));
    const all = genie ? [genie, ...rows] : rows;
    const [showSleeping, setShowSleeping] = useState(() => readShown('sleeping'));
    const [showStopped, setShowStopped] = useState(() => readShown('stopped'));
    const shown = dashboardRows(all, { sleeping: showSleeping, stopped: showStopped });
    const toggle = (kind: 'sleeping' | 'stopped') => {
        const next = kind === 'sleeping' ? !showSleeping : !showStopped;
        if (kind === 'sleeping') setShowSleeping(next); else setShowStopped(next);
        try { window.localStorage.setItem(`genie.dashboard.show.${kind}`, next ? '1' : '0'); } catch { /* Applies in this window even when storage is unavailable. */ }
    };
    const [ownFocus, setOwnFocus] = useState<string | null>(null);
    const focused = focusedId ?? ownFocus;
    const [ownReveal, setOwnReveal] = useState<string | null>(null);
    const reveal = revealOf(shown, revealId ?? ownReveal);
    const [ownTray, setOwnTray] = useState<string | null>(null);
    const openTray = trayId ?? ownTray;
    const go = (route: string) => { if (onNavigate) onNavigate(route); else if (route.startsWith('genie://agent/')) onOpenAgent(route.slice('genie://agent/'.length)); };
    const visibleIds = shown.map((row) => row.id);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('button,a,select,summary,[role="button"],[role="menuitem"],[role="radio"]'))) return;
            const action = dashboardAction({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, typing: isTypingTarget(event.target as never) });
            if (action === null) return;
            event.preventDefault();
            if (action === 'next-row') setOwnFocus(stepFocus(visibleIds, focused, 1));
            else if (action === 'prev-row') setOwnFocus(stepFocus(visibleIds, focused, -1));
            else if (action === 'open') { if (focused !== null && visibleIds.includes(focused)) onOpenAgent(focused); }
            else if (action === 'reveal') setOwnReveal((value) => value !== null || focused === null ? null : focused);
            else if (action === 'tray') setOwnTray((value) => focused === null || value === focused ? null : focused);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [visibleIds, focused, onOpenAgent]);
    const lanes = reveal ? lanesFor(visibleIds, reveal) : null;
    const chips = summaryChips(all);
    const workspaceOf = (row: AgentRow) => workspaces?.find((workspace) => workspace.id === row.workspaceId);
    const nameOf = (row: AgentRow) => {
        const workspace = workspaceOf(row);
        return row.id === genie?.id ? 'Genie' : workspace?.name ?? (workspace?.path ? workspace.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? row.workspaceId : row.workspaceId);
    };
    const legend = rows.some((row) => row.fidelity !== 'declared');

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
    if (knownWorkspaces?.length === 0 && !hasHibernatedWorkspaces) {
        return (
            <div data-dashboard="first-run" data-surface="dashboard" className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
                <h1 className="text-lg font-semibold tracking-tight">Nothing is being worked on yet</h1>
                <p className="max-w-[46ch] text-[13px] text-[var(--fg-3)]">
                    A workspace is a folder Genie works in. Add one and its agents appear here, with
                    what each is doing and what it has produced.
                </p>
                <Button type="button" size="md" icon="plus" data-add-workspace onClick={onAddWorkspace}>
                    Add a workspace
                </Button>
                {onAddWorkspaceFromGit ? (
                    <Button type="button" size="md" icon="git-branch" data-action="add-from-git" onClick={onAddWorkspaceFromGit}>
                        From a git URL
                    </Button>
                ) : null}
                {onAddWorkspaceFromTynn ? (
                    <Button type="button" size="md" icon="link" data-action="add-from-tynn" onClick={onAddWorkspaceFromTynn}>
                        From Tynn
                    </Button>
                ) : null}
            </div>
        );
    }

    return (
        <div data-surface="dashboard" className="relative flex min-h-0 flex-col">
            <div data-view-header="" className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-[var(--border-1)] px-5 py-2">
                <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
                <div className="flex items-center gap-3 text-xs text-[var(--fg-2)]">
                    {chips.filter((chip) => chip.state !== 'sleeping' && chip.state !== 'stopped').map((chip) => (
                        <span key={chip.state} data-chip={chip.state} style={stateStyle(chip.state)} className="flex items-center gap-1.5">
                            <span className="size-2 shrink-0 rounded-full bg-[var(--agent-status)]" />{chip.label}
                        </span>
                    ))}
                </div>
                <span className="flex-1" />
                {(['sleeping', 'stopped'] as const).map((kind) => {
                    const active = kind === 'sleeping' ? showSleeping : showStopped;
                    return <Button key={kind} type="button" size="xs" data-dashboard-filter={kind} data-chip={active && all.some((row) => shownState(row) === kind) ? kind : undefined} style={stateStyle(kind)} className={active ? 'ring-1 ring-[var(--agent-status)]' : ''} aria-pressed={active} onClick={() => toggle(kind)}>
                        {kind === 'sleeping' ? 'Sleeping' : 'Stopped'} {all.filter((row) => shownState(row) === kind).length}
                    </Button>;
                })}
                <span data-key-hints="" className="flex items-center gap-1 text-[10px] text-[var(--fg-4)]" title="J / K move the cursor · ↵ opens the agent">
                    {['J', 'K', '↵'].map((key) => <kbd key={key} className="rounded border border-[var(--border-1)] px-1 font-mono">{key}</kbd>)}
                </span>
                <RateLimitPills limits={rateLimits ?? {}} />
                <Button type="button" size="xs" icon="message-square" data-action="chat-genie" onClick={() => onChat?.()} title="Chat with genie">Chat <span className="ml-1.5 font-mono text-[11px] text-[var(--fg-4)]">⌘J</span></Button>
            </div>
            {legend ? <div data-legend="" className="flex shrink-0 flex-wrap gap-5 border-b border-[var(--border-1)] px-7 py-2 text-xs text-[var(--fg-3)]">
                <span className="flex items-center gap-1.5"><span className="size-[7px] rounded-full bg-[var(--fg-3)]" />Declared — reports plan, deliveries, comms, usage</span>
                <span className="flex items-center gap-1.5"><span className="size-[7px] rounded-full border-[1.5px] border-[var(--fg-3)]" />Observed — terminal activity, commits and file writes only</span>
                <span className="flex items-center gap-1.5"><span className="size-[7px] rounded-full border-[1.5px] border-dashed border-[var(--fg-3)]" />Remote — presence only</span>
            </div> : null}
            <div className={`${GRID} h-7 items-center border-b border-[var(--border-1)] text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]`}>
                {['Agent', 'Workspace', 'Status', 'Current target', 'Latest delivery', 'Comms', 'Context'].map((label) => <span key={label} className="truncate">{label}</span>)}
            </div>
            <div data-dashboard-list="">
                {shown.map((row) => <Fragment key={row.id}>
                    <AgentRowView row={row} workspaceName={nameOf(row)} workspaceColor={workspaceOf(row)?.color} workspaceFault={faults?.[row.workspaceId]} workspacePulsed={pulsing?.has(row.workspaceId)} onLocateRepo={onLocateRepo} onOpenWorkspace={row.id === genie?.id ? undefined : onOpenWorkspace} emoji={rowEmoji?.[row.id]} onOpen={onOpenAgent} onFix={onFix} focused={row.id === focused} reveal={reveal} lanes={lanes?.[row.id]} onReveal={setOwnReveal} />
                    {openTray === row.id ? <RowTrayView row={row} onNavigate={go} /> : null}
                </Fragment>)}
            </div>
            {workspaces.length === 0 ? <p data-dashboard-no-active-workspaces="" role="status" className="px-7 py-5 text-[13px] text-[var(--fg-3)]">No active workspaces. Redock a hibernated workspace from the sidebar to see it here.</p>
                : shown.length === 0 ? <p role="status" className="px-7 py-5 text-[13px] text-[var(--fg-3)]">No agents shown. Use Sleeping or Stopped to include those agents.</p> : null}
            {workspaces.filter((workspace) => !rows.some((row) => row.workspaceId === workspace.id)).map((workspace) => <div key={workspace.id} data-empty-workspace={workspace.id} data-workspace={workspace.id} {...(pulsing?.has(workspace.id) ? { 'data-workspace-pulse': 'true' } : {})} className={`flex items-center gap-3 border-b border-[var(--border-1)] px-7 py-3 text-xs text-[var(--fg-3)]${pulsing?.has(workspace.id) ? ` ${WORKSPACE_PULSE}` : ''}`}>
                {workspace.color ? <WorkspaceSwatch color={workspace.color} /> : null}
                <span>{workspace.name ?? workspace.id} has no agents yet.</span><Button type="button" size="xs" icon="plus" data-add-agent={workspace.id} onClick={() => onAddAgent(workspace.id)}>Add an agent</Button>
                {faults?.[workspace.id] ? <><span data-workspace-fault={faults[workspace.id]!.repo} className="text-[var(--warning)]">{faults[workspace.id]!.text}</span><Button type="button" size="xs" variant="ghost" icon="triangle-alert" data-action="locate-repo" onClick={() => onLocateRepo?.(workspace.id, faults[workspace.id]!.repo)}>Locate repo</Button></> : null}
            </div>)}
            <MailSignalLayer signals={mailSignals ?? []} />
        </div>
    );
}

/**
 * ONE RATE-LIMIT PILL PER PROVIDER in the Dashboard header (the owner, 2026-10-26): its logo and its most constrained
 * window. A click or Enter opens a POPOVER with every window (the owner, 2026-10-31: "can we make these cleaner? this
 * should be a popover not a tooltip"). Buffered in main, so this redraws at most once per provider per buffer.
 */
export function RateLimitPills({ limits, now }: { limits: Readonly<Record<string, Headroom>>; now?: number }) {
    const providers = Object.keys(limits).sort();
    if (providers.length === 0) return null;
    return (
        <div data-rate-limits="" className="flex items-center gap-1.5">
            {providers.map((p) => <RateLimitPill key={p} provider={p} limit={limits[p]!} now={now} />)}
        </div>
    );
}

const LEVEL_TEXT: Readonly<Record<LimitLevel, string>> = { ok: 'text-[var(--fg-2)]', warning: 'text-[var(--warning)]', danger: 'text-[var(--danger)]' };
const LEVEL_FILL: Readonly<Record<LimitLevel, string>> = { ok: 'bg-[var(--success)]', warning: 'bg-[var(--warning)]', danger: 'bg-[var(--danger)]' };

function RateLimitPill({ provider, limit, now }: { provider: string; limit: Headroom; now: number | undefined }) {
    const [open, setOpen] = useState(false);
    const tight = tightestWindow(limit);
    const level = limitLevel(tight);
    const name = providerName(provider);
    return (
        <Popover placement="bottom-end" open={open} onOpenChange={setOpen}>
            <Popover.Trigger>
                <Button
                    type="button"
                    size="xs"
                    data-rate-limit={provider}
                    data-level={level}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-label={`${name} rate limits: ${tight.over ? 'over the limit' : `${tight.leftPct}% left`} ${windowWords(tight.window)}`}
                    // Enter and Space toggle here and cancel the click the browser would add, so one key press is one toggle.
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } }}
                    className={`gap-1 hover:bg-[var(--bg-2)] ${open ? 'bg-[var(--bg-2)]' : ''}`}
                >
                    <ProviderLogo provider={provider} size="xs" className="text-[var(--fg-3)]" />
                    <span className={`tabular-nums ${LEVEL_TEXT[level]}`}>{tight.over ? 'over' : `${tight.leftPct}%`}</span>
                    <span className="text-[11px] text-[var(--fg-4)]">{tight.window}</span>
                </Button>
            </Popover.Trigger>
            <Popover.Content
                role="dialog"
                aria-label={`${name} rate limits`}
                data-rate-limit-popover={provider}
                className="w-60 border-[var(--border-1)] bg-[var(--surface-raised)] p-3 text-[var(--fg-1)]"
            >
                <RateLimitDetail provider={provider} limit={limit} now={now ?? Date.now()} />
            </Popover.Content>
        </Popover>
    );
}

/** The popover: the provider's logo (and plan, when reported), then one row per window — only reported figures. */
export function RateLimitDetail({ provider, limit, now }: { provider: string; limit: Headroom; now: number }) {
    return (
        <div data-rate-limit-detail={provider} className="flex flex-col gap-3 text-xs">
            <span className="flex items-center gap-1.5">
                <ProviderLogo provider={provider} size="md" />
                {limit.plan ? <span className="text-[var(--fg-3)]">{limit.plan}</span> : null}
            </span>
            {limitRows(limit).map((w) => ('unknown' in w ? (
                <div key={w.window} data-rate-limit-window={w.window} data-level="unknown" className="flex items-center gap-2 text-[var(--fg-3)]">
                    <span className="w-12 shrink-0 text-[var(--fg-2)]">{w.window}</span>
                    <Icon name="circle-help" size="xs" />
                    <span>unknown</span>
                </div>
            ) : (
                <div key={w.window} data-rate-limit-window={w.window} data-level={limitLevel(w)} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <span className="w-12 shrink-0 text-[var(--fg-2)]">{w.window}</span>
                        <span role="progressbar" aria-label={`${w.window} left`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.leftPct} className="block h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-3)]">
                            <span data-rate-limit-fill="" className={`block h-full rounded-full ${LEVEL_FILL[limitLevel(w)]}`} style={{ width: `${w.leftPct}%` }} />
                        </span>
                        <span data-rate-limit-pct="" className={`w-9 shrink-0 text-right tabular-nums ${LEVEL_TEXT[limitLevel(w)]}`}>{w.over ? 'over' : `${w.leftPct}%`}</span>
                    </div>
                    <div className="flex flex-col pl-14">
                        <span data-rate-limit-reset="" className="text-[var(--fg-2)]">{resetsIn(w.resetsAtMs, now)}</span>
                        <span data-rate-limit-at="" className="text-[11px] text-[var(--fg-4)]">{shortDateTime(w.resetsAtMs)}</span>
                    </div>
                </div>
            )))}
        </div>
    );
}
