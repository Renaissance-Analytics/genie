import { trayOf } from '../../core/row-tray.js';
import { ageLabel, revealOf, type Reveal } from '../../core/reveal.js';
import { ARC_WINDOW_SECONDS, arcsFor, type Point, type Rect } from '../../core/flight-arcs.js';
import { FlightPaths } from './FlightPaths.js';
import { ActivityLight, Button, Dropdown, Icon, Popover } from '@particle-academy/react-fancy';
import { PlanHover } from './PlanHover.js';
import { Fragment, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { useNow } from '../use-now.js';
import { allRefreshed, leftWords, limitLevel, limitRows, readLimitWindow, resetsIn, tightestWindow, windowWords, type Headroom, type LimitLevel } from '../../core/headroom.js';
import { shortDateTime } from '../../core/clock-words.js';
import type { MailSignal } from '../../core/mail-signals.js';
import { MailSignalLayer } from './MailSignalLayer.js';
import { ProviderLogo, providerName } from './ProviderLogo.js';
import { AccountsChip } from './AccountsChip.js';
import type { AccountsSnapshot } from '../../core/accounts-view.js';
import type { AccountsAction, AccountsActResult } from '../../core/account-settings.js';
import { offerWords, type SwitchOffer } from '../../core/switch-offer.js';
import { WORKSPACE_PULSE } from './Sidebar.js';
import { WorkspaceSwatch } from '../workspace-colors.js';
import { agentStatusStyle } from '../agent-status-color.js';
import { useDashboardFilter, useNeedsYouFilter } from '../dashboard-filter.js';
import { DAY_MS, deckBand, dismissableOlderThan, dismissableStale, signalStrip, type DeckItem, type SignalAction, type SignalState } from '../../core/deck.js';
import type { ApprovalAnswering } from '../../core/approval-answering.js';
import { groupWaiting, needsYouChipCount, needsYouRows, waitingBadges, type WaitingBadge, type WaitingKind } from '../../core/waiting.js';
import { DeckRow, type RowProps } from './DeckRow.js';
import { dashboardAction, isTypingTarget, stepFocus } from '../../core/keys.js';
import {
    commsOf,
    contextOf,
    fixRoute,
    dashboardRows,
    shownState,
    statusOf,
    windowEntriesFor,
    WINDOW_ENTRIES,
    type FixRoute,
    faultTextParts,
    summaryChips,
    targetOf,
    type AgentRow,
    type AgentState,
    type Delivery,
    type Fidelity,
    type WorkspaceFault,
} from '../../core/dashboard-view.js';

/** What a window opener answers when it can say whether it opened (the workspace terminal's `scratchTerminal`). */
type WindowOpened = { ok: true } | { ok: false; reason: string };

/**
 * THE WORKFLOW DASHBOARD — the landing surface.
 *
 * *"What is being produced, and by whom?"* A board you READ - and, since the Deck merged into it (Tynn #730, the owner's
 * option B), *what is waiting on you*, on the row of the agent it is about. The board itself carries **no resolving control**:
 * no approve, no deny, no composer, not even in a row tray. A row click (a waiting one too) opens that agent's chat beside the
 * board, which stays (the owner, 2026-10-28). What waits on an agent is a BADGE on its row (an approval, a question, stale,
 * mail); the badge opens the items under the row, where they are answered, dismissed or collected in place - except an
 * approval a toast carries, which is answered on the toast (core/approval-toasts.ts). Items with no agent are the Genie
 * row's. `A`/`D` are deliberately unbound on this surface.
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

const NO_ITEMS: readonly DeckItem[] = [];

/** One shared template: Agent · Workspace · Status · Target · Delivery · Comms · Context · Windows. */
const GRID =
    'grid grid-cols-[150px_120px_minmax(160px,1.15fr)_minmax(0,1.1fr)_minmax(0,1.45fr)_60px_84px_36px] gap-4 pl-7 pr-5';

/** Dot colour carries STATE. Shape (below) carries what Genie can see. */
/** One status colour for the whole row, fidelity dot and census chip. */
/** The map lives in `agent-status-color.ts`: the sidebar's agent list draws the same colours (Tynn #687). */
const stateStyle = agentStatusStyle;

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
/** The badges' colours: an approval blocks an agent (amber), a question is the person's to answer (violet), the rest are quiet. */
const BADGE_TONE: Record<WaitingKind, string> = {
    approval: 'border-[var(--warning)]/50 bg-[var(--warning)]/10 text-[var(--warning)]',
    question: 'border-[var(--accent)]/50 bg-[var(--accent)]/10 text-[var(--accent)]',
    mail: 'border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)]',
    todo: 'border-[var(--border-2)] text-[var(--fg-2)]',
    genie: 'border-[var(--border-2)] text-[var(--fg-2)]',
    stale: 'border-[var(--border-2)] text-[var(--fg-3)]',
};

/**
 * WHAT WAITS ON AN AGENT, as badges on its row (Tynn #730, option B): one per kind, each a real button that opens or folds
 * the items under the row - one click to see them, one to answer, no page change. The row's own click opens the chat, so
 * these stop it.
 */
function WaitingBadges({ owner, badges, open, onToggle }: { owner: string; badges: readonly WaitingBadge[]; open: boolean; onToggle: () => void }) {
    return (
        <span data-waiting-badges={owner} className="flex shrink-0 items-center gap-1">
            {badges.map((badge) => (
                <Button
                    key={badge.kind}
                    type="button"
                    size="xs"
                    data-waiting-badge={badge.kind}
                    aria-expanded={open}
                    title={open ? 'Hide what is waiting' : 'Show what is waiting'}
                    onClick={(event) => { event.stopPropagation(); onToggle(); }}
                    className={`rounded-full border px-2 py-0 text-[11px] ${BADGE_TONE[badge.kind]}`}
                >
                    {badge.label}
                </Button>
            ))}
        </span>
    );
}

/** An agent's items (or the Genie row's), opened under its row: the Deck's own rows, with their own actions. */
function WaitingItems({ owner, items, row }: { owner: string; items: readonly DeckItem[]; row: RowProps }) {
    return (
        <div data-waiting-items={owner} className="border-b border-[var(--border-1)] bg-[var(--bg-1)]">
            <div className="ml-5 border-l-2 border-[var(--accent)]/50">
                {items.map((item) => <DeckRow key={item.id} item={item} {...row} />)}
            </div>
        </div>
    );
}

/**
 * THE ROW TRAY (§4.1 `Space`): under its row, read-only plus three doors. Sections the row did not measure are not
 * drawn. Nothing here approves, denies or composes — the Deck resolves; the Dashboard shows.
 */
function RowTrayView({ row, onNavigate, onTerminal }: { row: AgentRow; onNavigate: (route: string) => void; onTerminal?: (() => void | Promise<WindowOpened>) | undefined }) {
    const tray = trayOf(row);
    // `Terminal →` (Tynn #857) opens a shell in the workspace through the row's terminal opener; absent = disabled, never a page.
    const terminal = useTerminalOpener(onTerminal);
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
                {tray.doors.map((d) => d.door === 'terminal' ? (
                    <Button key={d.door} type="button" size="xs" data-door={d.door} disabled={!terminal.open}
                        title={terminal.failed === null ? 'Open a terminal in this workspace, in a new window' : `The terminal did not open: ${terminal.failed}`}
                        data-terminal-failed={terminal.failed !== null ? '' : undefined} className={terminal.failed !== null ? 'text-[var(--danger)]' : undefined}
                        onClick={(e) => { e.stopPropagation(); terminal.open?.(); }}>{d.label}</Button>
                ) : (
                    <Button key={d.door} type="button" size="xs" data-door={d.door} onClick={(e) => { e.stopPropagation(); onNavigate(d.route); }}>{d.label}</Button>
                ))}
            </div>
        </div>
    );
}

/**
 * A terminal opener with its last failure (Tynn #851, #857): `open` starts it and clears the last failure; an answer of
 * `{ ok: false }` or a throw is kept as `failed`, the reason the button says. No opener = no `open` (the button is disabled).
 */
function useTerminalOpener(onTerminal: (() => void | Promise<WindowOpened>) | undefined): { failed: string | null; open: (() => void) | undefined } {
    const [failed, setFailed] = useState<string | null>(null);
    const open = onTerminal ? () => {
        setFailed(null);
        let answer: void | Promise<WindowOpened>;
        try { answer = onTerminal(); } catch (error) { setFailed(error instanceof Error ? error.message : String(error)); return; }
        void Promise.resolve(answer).then(
            (r) => { if (r && !r.ok) setFailed(r.reason); },
            (error: unknown) => setFailed(error instanceof Error ? error.message : String(error)),
        );
    } : undefined;
    return { failed, open };
}

function AgentRowView({ row, workspaceName, workspaceColor, workspaceFault, workspacePulsed = false, onLocateRepo, onLocateFolder, onOpenWorkspace, onOpen, onFix, focused = false, reveal = null, onReveal, onArc, emoji, windows, waiting, switchOffer }: {
    row: AgentRow;
    workspaceName: string;
    workspaceColor?: string | undefined;
    workspaceFault?: WorkspaceFault | null | undefined;
    workspacePulsed?: boolean | undefined;
    onLocateRepo?: ((workspaceId: string, repo: string) => void) | undefined;
    onLocateFolder?: ((workspaceId: string) => void) | undefined;
    onOpenWorkspace?: ((workspaceId: string) => void) | undefined;    /** What the agent just did with Genie (genie#1209), shown beside its name for a moment. */
    emoji?: string | undefined;
    onOpen: (id: string) => void;
    onFix?: ((route: FixRoute) => void) | undefined;
    focused?: boolean | undefined;
    /** The board's collaborator reveal, when one is shown. */
    reveal?: Reveal | null | undefined;
    /** Hovering the comms cell reveals this row's collaborators; leaving it ends the reveal. */
    onReveal?: ((id: string | null) => void) | undefined;
    /** The same hover draws the flight paths (Tynn #750): enter and move carry the pointer. */
    onArc?: { enter: (id: string, event: ReactMouseEvent) => void; move: (event: ReactMouseEvent) => void; leave: () => void } | undefined;
    /** What waits on this agent: its badges, and whether its items are open under the row. Absent = nothing waits (or no Deck). */
    waiting?: { badges: readonly WaitingBadge[]; open: boolean; onToggle: () => void } | undefined;
    /** The windows column (Tynn #706): absent = this row has none (Genie's own, or a workspace this window may not open). */
    windows?: { onTerminal?: (() => void | Promise<WindowOpened>) | undefined; onFiles?: (() => void) | undefined } | undefined;
    /** Its provider's standing switch offer (Tynn #483): one click starts the switch. Absent = none. */
    switchOffer?: { offer: SwitchOffer; onSwitch: (provider: string, choose?: string) => void } | undefined;
}) {
    const role = reveal ? (reveal.focus === row.id ? 'focus' : reveal.peers[row.id] ? 'peer' : 'dim') : null;
    const peerLink = role === 'peer' ? reveal!.peers[row.id]! : null;
    const status = statusOf(row);
    const target = targetOf(row);
    const comms = commsOf(row);
    const context = contextOf(row);
    // A Terminal that did not open is said on the row's windows button (Tynn #851), never a dead click; the next try clears it.
    const { failed: terminalFailed, open: openTerminal } = useTerminalOpener(windows?.onTerminal);

    return (
        <div
            role="row"
            tabIndex={0}
            data-agent={row.id}
            data-state={shownState(row)}
            {...(focused ? { 'data-focused': 'true' } : {})}
            {...(role ? { 'data-reveal': role } : {})}
            // The windows column's button and its menu (portalled, still React children of this row) open windows, not the agent.
            onClick={(event) => { if (event.target instanceof Element && event.target.closest('[data-column="windows"],[data-react-fancy-dropdown]')) return; onOpen(row.id); }}
            className={`${GRID} relative h-8 cursor-pointer items-center border-b border-[var(--border-1)] text-[13px] transition-opacity border-l-2 border-l-[var(--agent-status)] bg-[color-mix(in_srgb,var(--agent-status)_9%,transparent)] hover:bg-[color-mix(in_srgb,var(--agent-status)_15%,transparent)] ${focused ? 'bg-[var(--bg-2)] shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
            // The reveal: the rest dims to .32; the row and its peers carry a 2px violet left border (the board).
            style={{ ...stateStyle(shownState(row)), ...(shownState(row) === 'sleeping' ? { opacity: 0.5 } : {}), ...(role === 'dim' ? { opacity: 0.32 } : role ? { boxShadow: 'inset 2px 0 0 var(--violet-400)' } : {}) }}
        >
            <div className="flex min-w-0 items-center gap-2">
                <FidelityDot fidelity={row.fidelity} state={shownState(row)} />
                <span data-agent-name="" className="truncate font-medium">{row.name}</span>
                {emoji ? <span data-row-emoji={emoji} className="shrink-0 animate-pulse" aria-label="what it just did">{emoji}</span> : null}
                <ProviderLogo provider={row.provider} />
                {switchOffer ? (
                    <Button type="button" size="xs" variant="ghost" icon="arrow-right-left" data-switch-offer-row={switchOffer.offer.id}
                        aria-label={`${offerWords(switchOffer.offer)} Switch account`}
                        title={`${offerWords(switchOffer.offer)} Switch account`}
                        className="shrink-0 px-1 text-[var(--warning)]"
                        onClick={(event) => { event.stopPropagation(); switchOffer.onSwitch(row.provider, switchOffer.offer.targets[0]?.label); }} />
                ) : null}
            </div>

            <div data-column="workspace" data-workspace={row.workspaceId} {...(workspacePulsed ? { 'data-workspace-pulse': 'true' } : {})} className={`flex min-w-0 items-center gap-1.5${workspacePulsed ? ` ${WORKSPACE_PULSE}` : ''}`}>
                {workspaceColor ? <WorkspaceSwatch color={workspaceColor} /> : null}
                {onOpenWorkspace ? (
                    <Button type="button" variant="ghost" size="xs" data-open-workspace={row.workspaceId} className="min-w-0 px-0 text-xs font-normal text-[var(--fg-2)]" labelClassName="truncate" onClick={(event) => { event.stopPropagation(); onOpenWorkspace(row.workspaceId); }} title={workspaceName}>{workspaceName}</Button>
                ) : <span className="truncate text-xs text-[var(--fg-3)]">{workspaceName}</span>}
                {workspaceFault?.kind === 'folder'
                    ? <Button type="button" variant="ghost" size="xs" icon="triangle-alert" data-workspace-missing={row.workspaceId} data-action="locate-folder" aria-label="Locate folder" title={`Locate folder (${workspaceFault.text})`} className="shrink-0 px-1 text-[var(--warning)]" onClick={(event) => { event.stopPropagation(); onLocateFolder?.(row.workspaceId); }} />
                    : workspaceFault ? <Button type="button" variant="ghost" size="xs" icon="triangle-alert" data-workspace-fault={workspaceFault.repo} data-action="locate-repo" aria-label="Locate repo" title={workspaceFault.text} className="shrink-0 px-1 text-[var(--warning)]" onClick={(event) => { event.stopPropagation(); onLocateRepo?.(row.workspaceId, workspaceFault.repo); }} /> : null}
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
                <span className={`shrink-0 font-medium ${STATUS_TONE[status.tone]}`}>{status.word}</span>
                {waiting ? <WaitingBadges owner={row.id} badges={waiting.badges} open={waiting.open} onToggle={waiting.onToggle} /> : null}
                {status.detail ? <span className="truncate text-xs text-[var(--fg-3)]" {...(status.title ? { title: status.title } : {})}>{status.detail}</span> : null}
            </div>

            <div className="flex min-w-0 items-center gap-2">
                {target?.kind === 'target' ? (
                    // Hovered, the whole plan (Tynn #918); the step and target stay as they are.
                    <PlanHover plan={target.plan}>
                        {target.step ? (
                            <span className="shrink-0 font-mono text-[11px] text-[var(--fg-4)]">{target.step}</span>
                        ) : null}
                        <span className="truncate text-[var(--fg-2)]">{target.text}</span>
                    </PlanHover>
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
                data-comms-cell=""
                className="flex items-center gap-1.5 text-xs text-[var(--fg-2)]"
                {...(comms && comms.count > 0 && onReveal ? { onMouseEnter: (event: ReactMouseEvent) => { onReveal(row.id); onArc?.enter(row.id, event); }, onMouseMove: (event: ReactMouseEvent) => onArc?.move(event), onMouseLeave: () => { onReveal(null); onArc?.leave(); } } : {})}
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

            {/* The windows column (Tynn #706): an icon Button and a menu of Terminal / Files, each in a NEW window; this one stays. */}
            <div data-column="windows" className="flex items-center justify-end">
                {windows ? (
                    <Dropdown placement="bottom-end">
                        <Dropdown.Trigger>
                            <Button type="button" variant="ghost" size="xs" icon="app-window" data-windows-menu={row.id} aria-label={`Open ${row.name} in a new window`}
                                title={terminalFailed === null ? 'Open in a new window' : `The terminal did not open: ${terminalFailed}`} data-terminal-failed={terminalFailed !== null ? '' : undefined}
                                disabled={!windows.onTerminal && !windows.onFiles} className={`px-1 ${terminalFailed !== null ? 'text-[var(--danger)]' : 'text-[var(--fg-3)]'}`} />
                        </Dropdown.Trigger>
                        <Dropdown.Items>
                            {WINDOW_ENTRIES.map((entry) => {
                                const open = entry.kind === 'terminal' ? openTerminal : windows.onFiles;
                                return (
                                    <Dropdown.Item key={entry.kind} disabled={!open} onClick={() => open?.()}>
                                        <span data-windows-entry={entry.kind} className="flex items-center gap-2 text-xs"><Icon name={entry.icon} size="xs" />{entry.label}</span>
                                    </Dropdown.Item>
                                );
                            })}
                        </Dropdown.Items>
                    </Dropdown>
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
    /** The fix for a workspace whose own folder is not there (host split P7): the host's picker, then its registry is told. */
    onLocateFolder?: ((workspaceId: string) => void) | undefined;
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
    /**
     * The standing switch offers (Tynn #483), drawn on each agent row of that provider. The account pills themselves are in
     * Genie's title bar (Tynn #949), not this header.
     */
    accounts?: AccountsSnapshot | undefined;
    /** One click to switch a provider's account (S9): the provider's own login, in its one home. */
    onSwitchAccount?: ((provider: string, choose?: string) => void) | undefined;
    /** Mail between agents, drawn from the sender's row to the recipient's (genie#1209). */
    mailSignals?: readonly MailSignal[] | undefined;
    /** Workspaces an agent acted in that the person has not visited since: their Workspace cells pulse. */
    pulsing?: ReadonlySet<string> | undefined;
    /**
     * WHAT WAITS ON THE PERSON (Tynn #730: the Deck merged into this board). Absent = no Deck here (a window that serves none):
     * no badges, no "Needs you" chip, no Genie row.
     */
    waiting?: DashboardWaiting | undefined;
    /**
     * The windows column's openers (Tynn #706): a SHELL in the workspace (Tynn #851 — not a Genie window on its Terminals
     * view), or its Files, in a NEW window. The terminal's answer, when given, says whether it opened. Absent = disabled.
     */
    onOpenTerminalWindow?: ((workspaceId: string) => void | Promise<WindowOpened>) | undefined;
    onOpenFilesWindow?: ((workspaceId: string) => void) | undefined;
    /** A workspace-share window's workspace (Tynn #690/#691): the column offers that workspace only. Absent = a workstation window. */
    scopeWorkspaceId?: string | null | undefined;
}

export interface DashboardWaiting {
    /** The Deck's items. */
    items: readonly DeckItem[];
    signals: SignalState;
    /** The answer in flight, if any - which agent's (core/approval-answering.ts): only THAT agent's row refuses a second press. */
    answering: ApprovalAnswering | null;
    /** `note`: the person's words with an approval's answer; absent = none. */
    onAnswer: (item: DeckItem, optionId: string, note?: string) => void;
    /** Open the item's agent (its chat). */
    onOpenItem: (item: DeckItem) => void;
    onAnswerForm?: ((item: DeckItem, selections: string[][], notes: string[]) => void) | undefined;
    /** The last refused action, said beside THAT item (or under the header for the two bulk dismissals). */
    formRefusal?: { itemId: string; reason: string } | null | undefined;
    /** Dismiss an agent's question without an answer, with the notes written in its form. Absent = not offered. */
    onDismiss?: ((item: DeckItem, notes: string[]) => void) | undefined;
    /** "Dismiss all older than 1 day": the age, in ms. Absent = not offered. */
    onDismissOlder?: ((olderThanMs: number) => void) | undefined;
    /** "Dismiss all stale": exactly the ids shown marked stale. Absent = not offered. */
    onDismissStale?: ((ids: string[]) => void) | undefined;
    onTrustWorkspace?: ((workspaceId: string) => Promise<unknown>) | undefined;
    /** The signal strip's update door (download, then install). */
    onSignalAction?: ((action: SignalAction) => void) | undefined;
    /** The action in flight on one of Genie's own items: that button shows progress, its row takes no second press. */
    busy?: { itemId: string; optionId: string } | null | undefined;
    /** The approvals a toast carries (core/approval-toasts.ts): the toast answers them, their rows show a marker. */
    toastIds?: ReadonlySet<string> | undefined;
    /** The item the reader was SENT to (`?item=<id>`): its agent's row is open on it, marked and scrolled to. */
    focusItemId?: string | null | undefined;
    /** Items drawn opened in place (a long to-do or message shows its first line; this opens the whole text). */
    initiallyExpanded?: readonly string[] | undefined;
    /** Rows drawn opened (a test of the opened row; the board itself opens one on a click): agent ids, or `genie:`. */
    initiallyOpen?: readonly string[] | undefined;
    /** The clock the ages are read against; now by default (tests pass a fixed one). */
    now?: number | undefined;
}

/**
 * THE COMMS FLIGHT PATHS' HOVER (Tynn #750). Nothing is computed at rest. On entering a Comms cell the rows' name positions
 * are measured ONCE (reads only, no writes in between); the pointer then follows through one requestAnimationFrame at a
 * time, and the arches are derived (core/flight-arcs.ts) from the newest twelve partners of the last 24 h. Leaving drops
 * all of it, so the overlay is not in the tree.
 */
interface ArcState {
    readonly focus: string;
    readonly pointer: Point;
    readonly targets: Readonly<Record<string, Point>>;
    /** Every row's text, measured once on entering: the labels keep off it. */
    readonly obstacles: readonly Rect[];
    readonly size: { width: number; height: number };
    readonly reducedMotion: boolean;
}

function useFlightPaths(shown: readonly AgentRow[], colorOf: (row: AgentRow) => string | null | undefined) {
    const surface = useRef<HTMLDivElement | null>(null);
    const [state, setState] = useState<ArcState | null>(null);
    const pending = useRef<{ x: number; y: number } | null>(null);
    const scheduled = useRef(false);
    const frame = useRef(0);
    const live = useRef(false);
    useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);
    const enter = (id: string, event: ReactMouseEvent) => {
        const host = surface.current;
        const row = shown.find((r) => r.id === id);
        if (!host || !row) return;
        const box = host.getBoundingClientRect();
        const targets: Record<string, Point> = {};
        for (const link of row.links ?? []) {
            if (link.ageSeconds > ARC_WINDOW_SECONDS || link.peer === id) continue;
            const name = host.querySelector<HTMLElement>(`[data-agent="${CSS.escape(link.peer)}"] [data-agent-name]`);
            if (!name) continue;
            const r = name.getBoundingClientRect();
            targets[link.peer] = { x: r.right - box.left + 8, y: r.top + r.height / 2 - box.top };
        }
        // Every text leaf on the board (rows, column headers, buttons), read in one go with the targets (no writes in between): what a label must not cover.
        const obstacles: Rect[] = [];
        host.querySelectorAll<HTMLElement>('*').forEach((el) => {
            if (el.closest('[data-flight-paths]') || el.childElementCount > 0 || (el.textContent ?? '').trim() === '') return;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) obstacles.push({ x: r.left - box.left - 2, y: r.top - box.top - 1, w: r.width + 4, h: r.height + 2 });
        });
        live.current = true;
        setState({
            focus: id,
            pointer: { x: event.clientX - box.left, y: event.clientY - box.top },
            targets,
            obstacles,
            size: { width: box.width, height: host.scrollHeight || box.height },
            reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
        });
    };
    const move = (event: ReactMouseEvent) => {
        if (!live.current) return;
        pending.current = { x: event.clientX, y: event.clientY };
        if (scheduled.current) return;
        scheduled.current = true;
        frame.current = requestAnimationFrame(() => {
            scheduled.current = false;
            const at = pending.current;
            const host = surface.current;
            if (!at || !host || !live.current) return;
            const box = host.getBoundingClientRect();
            setState((prev) => (prev ? { ...prev, pointer: { x: at.x - box.left, y: at.y - box.top } } : prev));
        });
    };
    const leave = () => {
        live.current = false;
        pending.current = null;
        scheduled.current = false;
        if (frame.current) cancelAnimationFrame(frame.current);
        setState(null);
    };
    const row = state ? shown.find((r) => r.id === state.focus) : undefined;
    const paths = state && row
        ? {
            arcs: arcsFor({ focus: state.focus, links: row.links ?? [], order: shown.map((r) => r.id), targets: state.targets, obstacles: state.obstacles, names: Object.fromEntries(shown.map((r) => [r.id, r.name])), colors: Object.fromEntries(shown.map((r) => [r.id, colorOf(r)])), pointer: state.pointer }),
            size: state.size,
            pointer: state.pointer,
            reducedMotion: state.reducedMotion,
        }
        : null;
    return { surface, paths, handlers: { enter, move, leave } };
}


/** The Genie row's key: items that belong to no agent, or whose agent has no row on screen. */
export const GENIE_ROW = 'genie:';

const HEADER_BUTTON = 'rounded-md border border-[var(--border-1)] px-2 py-1 text-xs text-[var(--fg-2)] hover:bg-[var(--bg-2)]';

export function Dashboard({ rows: reportedRows, genie = null, workspaces: knownWorkspaces, hasHibernatedWorkspaces = false, onOpenAgent, onAddAgent, onAddWorkspace, onAddWorkspaceFromGit, onAddWorkspaceFromTynn, onOpenWorkspace, faults, onLocateRepo, onLocateFolder, onFix, onChat, focusedId, revealId, trayId, onNavigate, rowEmoji, accounts, onSwitchAccount, mailSignals, pulsing, onOpenTerminalWindow, onOpenFilesWindow, scopeWorkspaceId, waiting }: DashboardProps) {
    const workspaces = knownWorkspaces?.filter((workspace) => workspace.asleep !== true) ?? null;
    const hibernatedIds = new Set((knownWorkspaces ?? []).filter((workspace) => workspace.asleep === true).map((workspace) => workspace.id));
    const rows = reportedRows.filter((row) => !hibernatedIds.has(row.workspaceId));
    const all = genie ? [genie, ...rows] : rows;
    const { filter, toggle } = useDashboardFilter();
    const { sleeping: showSleeping, stopped: showStopped } = filter;
    const needsYou = useNeedsYouFilter();
    const items = waiting?.items ?? NO_ITEMS;
    // "Needs you": only the agents with something waiting - the Sleeping / Stopped filters do not hide one that needs the person.
    const shown = waiting && needsYou.on ? dashboardRows(needsYouRows(all, items), { sleeping: true, stopped: true }) : dashboardRows(all, filter);
    const groups = groupWaiting(items, new Set(shown.map((row) => row.id)));
    // Which rows are open: a click on a badge opens one; the item the reader was sent to is open; under "Needs you" all are.
    const focusItem = waiting?.focusItemId ?? null;
    const focusKey = focusItem === null ? null : ([...groups.byAgent].find(([, list]) => list.some((i) => i.id === focusItem))?.[0] ?? (groups.genie.some((i) => i.id === focusItem) ? GENIE_ROW : null));
    const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set(waiting?.initiallyOpen ?? []));
    const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
    const isOpen = (key: string): boolean => !closed.has(key) && (opened.has(key) || key === focusKey || (needsYou.on && waiting !== undefined));
    const toggleOpen = (key: string): void => {
        const wasOpen = isOpen(key);
        setOpened((prev) => { const next = new Set(prev); if (wasOpen) next.delete(key); else next.add(key); return next; });
        setClosed((prev) => { const next = new Set(prev); if (wasOpen) next.add(key); else next.delete(key); return next; });
    };
    const focusRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => { focusRef.current?.scrollIntoView?.({ block: 'center' }); }, [focusItem]);
    const rowProps: RowProps | null = waiting ? {
        answering: waiting.answering, onAnswer: waiting.onAnswer, onOpenItem: waiting.onOpenItem, onAnswerForm: waiting.onAnswerForm,
        formRefusal: waiting.formRefusal ?? null, focusId: focusItem, focusRef: focusRef as RefObject<HTMLDivElement | null>,
        onDismiss: waiting.onDismiss, now: waiting.now ?? Date.now(), busy: waiting.busy, onTrustWorkspace: waiting.onTrustWorkspace, toastIds: waiting.toastIds, initiallyExpanded: waiting.initiallyExpanded,
    } : null;
    const [ownFocus, setOwnFocus] = useState<string | null>(null);
    const focused = focusedId ?? ownFocus;
    const [ownReveal, setOwnReveal] = useState<string | null>(null);
    const reveal = revealOf(shown, revealId ?? ownReveal);
    // An arc is drawn in its sender's workspace colour: the dot in the Workspace column.
    const arcs = useFlightPaths(shown, (row) => workspaces?.find((workspace) => workspace.id === row.workspaceId)?.color);
    const arcHandlers = arcs.handlers;
    const [ownTray, setOwnTray] = useState<string | null>(null);
    const openTray = trayId ?? ownTray;
    // Whether a row may open windows (Tynn #706: never Genie's own row, only workspaces this window may open), and its shell
    // opener: one for the windows column and the tray's `Terminal →` (Tynn #851, #857).
    const opensWindows = (row: AgentRow) => row.id !== genie?.id && windowEntriesFor(row.workspaceId, scopeWorkspaceId).length > 0;
    const terminalOpenerFor = (row: AgentRow) => opensWindows(row) && onOpenTerminalWindow ? () => onOpenTerminalWindow(row.workspaceId) : undefined;
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
    const band = deckBand(items);
    const staleItems = dismissableStale(band);
    const olderItems = dismissableOlderThan(band, waiting?.now ?? Date.now(), DAY_MS);
    const strip = waiting ? signalStrip(waiting.signals) : [];
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
        <div ref={arcs.surface} data-surface="dashboard" className="relative flex min-h-0 flex-col">
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
                {/* The questions nobody waits for any more: exactly the ones on screen, put aside in one go (the Deck's, kept). */}
                {waiting?.onDismissStale && staleItems.length > 0 ? (
                    <Button size="xs" type="button" data-action="deck-dismiss-stale" data-deck-stale={staleItems.length} onClick={() => waiting.onDismissStale?.(staleItems.map((i) => i.id))} title="Every question whose agent no longer waits; each agent is told" className={HEADER_BUTTON}>
                        {`Dismiss all stale (${staleItems.length})`}
                    </Button>
                ) : null}
                {/* The questions nobody is going to answer: put aside in one go, each agent told. Only when there are such. */}
                {waiting?.onDismissOlder && olderItems.length > 0 ? (
                    <Button size="xs" type="button" data-action="deck-dismiss-older" data-deck-older={olderItems.length} onClick={() => waiting.onDismissOlder?.(DAY_MS)} title="Each agent is told its question was dismissed without an answer" className={HEADER_BUTTON}>
                        {`Dismiss all older than 1 day (${olderItems.length})`}
                    </Button>
                ) : null}
                {/* NEEDS YOU (Tynn #730): only the agents with something waiting, beside the status filters, in the same store. */}
                {waiting ? (
                    <Button type="button" size="xs" icon="hand" data-dashboard-filter="needsYou" className={needsYou.on ? 'ring-1 ring-[var(--warning)]' : ''} aria-pressed={needsYou.on} onClick={needsYou.toggle}>
                        {`Needs you ${needsYouChipCount(items)}`}
                    </Button>
                ) : null}
                {(['sleeping', 'stopped'] as const).map((kind) => {
                    const active = kind === 'sleeping' ? showSleeping : showStopped;
                    return <Button key={kind} type="button" size="xs" data-dashboard-filter={kind} data-chip={active && all.some((row) => shownState(row) === kind) ? kind : undefined} style={stateStyle(kind)} className={active ? 'ring-1 ring-[var(--agent-status)]' : ''} aria-pressed={active} onClick={() => toggle(kind)}>
                        {kind === 'sleeping' ? 'Sleeping' : 'Stopped'} {all.filter((row) => shownState(row) === kind).length}
                    </Button>;
                })}
                <span data-key-hints="" className="flex items-center gap-1 text-[10px] text-[var(--fg-4)]" title="J / K move the cursor · ↵ opens the agent">
                    {['J', 'K', '↵'].map((key) => <kbd key={key} className="rounded border border-[var(--border-1)] px-1 font-mono">{key}</kbd>)}
                </span>
                {/* The account pills are in Genie's title bar, on every view (Tynn #949), not here. */}
                <Button type="button" size="xs" icon="message-square" data-action="chat-genie" onClick={() => onChat?.()} title="Chat with genie">Chat <span className="ml-1.5 font-mono text-[11px] text-[var(--fg-4)]">⌘J</span></Button>
            </div>
            {/* "Dismiss all stale" or "Dismiss all older" refused: said under the header (Tynn #600). */}
            {waiting?.formRefusal && (waiting.formRefusal.itemId === 'deck:stale' || waiting.formRefusal.itemId === 'deck:older') ? (
                <p data-deck-refusal={waiting.formRefusal.itemId} role="alert" className="px-7 pb-2 text-xs text-[var(--danger)]">{waiting.formRefusal.reason}</p>
            ) : null}
            {/* The signal strip - silent unless something is true, and every signal a door (the Deck's, kept). */}
            {strip.length > 0 ? (
                <div data-signal-strip="" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-1)] px-7 py-2">
                    {strip.map((signal) => (
                        <Button size="xs" key={signal.kind} type="button" data-signal={signal.kind} data-nav={signal.route} data-action={signal.action} onClick={() => (signal.action ? waiting?.onSignalAction?.(signal.action) : go(signal.route))} className={HEADER_BUTTON}>
                            {signal.label}
                        </Button>
                    ))}
                </div>
            ) : null}
            {legend ? <div data-legend="" className="flex shrink-0 flex-wrap gap-5 border-b border-[var(--border-1)] px-7 py-2 text-xs text-[var(--fg-3)]">
                <span className="flex items-center gap-1.5"><span className="size-[7px] rounded-full bg-[var(--fg-3)]" />Declared — reports plan, deliveries, comms, usage</span>
                <span className="flex items-center gap-1.5"><span className="size-[7px] rounded-full border-[1.5px] border-[var(--fg-3)]" />Observed — terminal activity, commits and file writes only</span>
                <span className="flex items-center gap-1.5"><span className="size-[7px] rounded-full border-[1.5px] border-dashed border-[var(--fg-3)]" />Remote — presence only</span>
            </div> : null}
            <div className={`${GRID} h-7 items-center border-b border-[var(--border-1)] text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]`}>
                {['Agent', 'Workspace', 'Status', 'Current target', 'Latest delivery', 'Comms', 'Context'].map((label) => <span key={label} className="truncate">{label}</span>)}
                {/* Icon only (Tynn #706): the tooltip says what the column is. */}
                <div data-column-header="windows" title="Open in a new window" aria-label="Open in a new window" className="flex items-center justify-end"><Icon name="app-window" size="xs" /></div>
            </div>
            <div data-dashboard-list="">
                {shown.map((row) => <Fragment key={row.id}>
                    <AgentRowView waiting={groups.byAgent.has(row.id) ? { badges: waitingBadges(groups.byAgent.get(row.id)!), open: isOpen(row.id), onToggle: () => toggleOpen(row.id) } : undefined} row={row} workspaceName={nameOf(row)} workspaceColor={workspaceOf(row)?.color} workspaceFault={faults?.[row.workspaceId]} workspacePulsed={pulsing?.has(row.workspaceId)} onLocateRepo={onLocateRepo} onLocateFolder={onLocateFolder} onOpenWorkspace={row.id === genie?.id ? undefined : onOpenWorkspace} emoji={rowEmoji?.[row.id]} switchOffer={(() => { const offer = onSwitchAccount ? accounts?.offers.find((o) => o.provider === row.provider) : undefined; return offer && onSwitchAccount ? { offer, onSwitch: onSwitchAccount } : undefined; })()} onOpen={onOpenAgent} onFix={onFix} focused={row.id === focused} reveal={reveal} onReveal={setOwnReveal} onArc={arcHandlers} windows={opensWindows(row) ? { onTerminal: terminalOpenerFor(row), onFiles: onOpenFilesWindow ? () => onOpenFilesWindow(row.workspaceId) : undefined } : undefined} />
                    {openTray === row.id ? <RowTrayView row={row} onNavigate={go} onTerminal={terminalOpenerFor(row)} /> : null}
                    {rowProps && groups.byAgent.has(row.id) && isOpen(row.id) ? <WaitingItems owner={row.id} items={groups.byAgent.get(row.id)!} row={rowProps} /> : null}
                </Fragment>)}
                {/* THE GENIE ROW: what belongs to no agent (a flow signal, a workstation item, Genie's own asks), and what waits on an agent with no row on screen. */}
                {rowProps && groups.genie.length > 0 ? (
                    <div data-waiting-genie="">
                        <div className="flex h-8 items-center gap-3 border-b border-[var(--border-1)] pl-7 pr-5 text-[13px]">
                            <Icon name="sparkles" size="sm" className="shrink-0 text-[var(--fg-3)]" />
                            <span className="font-medium">Genie</span>
                            <span className="text-xs text-[var(--fg-3)]">items that belong to no agent</span>
                            <WaitingBadges owner={GENIE_ROW} badges={waitingBadges(groups.genie)} open={isOpen(GENIE_ROW)} onToggle={() => toggleOpen(GENIE_ROW)} />
                        </div>
                        {isOpen(GENIE_ROW) ? <WaitingItems owner={GENIE_ROW} items={groups.genie} row={rowProps} /> : null}
                    </div>
                ) : null}
            </div>
            {workspaces.length === 0 ? <p data-dashboard-no-active-workspaces="" role="status" className="px-7 py-5 text-[13px] text-[var(--fg-3)]">No active workspaces. Redock a hibernated workspace from the sidebar to see it here.</p>
                : waiting && needsYou.on && shown.length === 0 && groups.genie.length === 0 ? <p data-needs-you="empty" role="status" className="px-7 py-5 text-[13px] text-[var(--fg-3)]">Nothing needs you.</p>
                : shown.length === 0 && !(waiting && needsYou.on) ? <p role="status" className="px-7 py-5 text-[13px] text-[var(--fg-3)]">No agents shown. Use Sleeping or Stopped to include those agents.</p> : null}
            {workspaces.filter((workspace) => !rows.some((row) => row.workspaceId === workspace.id)).map((workspace) => <div key={workspace.id} data-empty-workspace={workspace.id} data-workspace={workspace.id} {...(pulsing?.has(workspace.id) ? { 'data-workspace-pulse': 'true' } : {})} className={`@container flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--border-1)] px-7 py-3 text-xs text-[var(--fg-3)]${pulsing?.has(workspace.id) ? ` ${WORKSPACE_PULSE}` : ''}`}>
                {workspace.color ? <WorkspaceSwatch color={workspace.color} /> : null}
                <span className="min-w-0 truncate">{workspace.name ?? workspace.id} has no agents yet.</span>
                {/* The folder is not there: the message takes the width that is left, its path cut in the middle (the whole text
                    is its title); in a narrow Dashboard it drops to its own line under the name, the buttons at the right. */}
                {faults?.[workspace.id]?.kind === 'folder' ? (() => { const text = faults[workspace.id]!.text; const parts = faultTextParts(text); return (
                    <span data-workspace-missing={workspace.id} title={text} className="order-last flex min-w-0 flex-1 basis-full text-[var(--warning)] @2xl:order-none @2xl:basis-0"><span className="truncate">{parts.head}</span><span className="shrink-0 whitespace-nowrap">{parts.tail}</span></span>
                ); })() : null}
                <span data-workspace-actions={workspace.id} className={`flex shrink-0 items-center gap-2${faults?.[workspace.id]?.kind === 'folder' ? ' ml-auto' : ''}`}>
                    <Button type="button" size="xs" icon="plus" data-add-agent={workspace.id} className="shrink-0 whitespace-nowrap" onClick={() => onAddAgent(workspace.id)}>Add an agent</Button>
                    {faults?.[workspace.id]?.kind === 'folder' ? <Button type="button" size="xs" variant="ghost" icon="triangle-alert" data-action="locate-folder" title="Locate folder" className="shrink-0 whitespace-nowrap" onClick={() => onLocateFolder?.(workspace.id)}>Locate folder</Button> : null}
                </span>
                {faults?.[workspace.id]?.kind === 'folder' ? null
                    : faults?.[workspace.id] ? <><span data-workspace-fault={faults[workspace.id]!.repo} className="text-[var(--warning)]">{faults[workspace.id]!.text}</span><Button type="button" size="xs" variant="ghost" icon="triangle-alert" data-action="locate-repo" onClick={() => onLocateRepo?.(workspace.id, faults[workspace.id]!.repo)}>Locate repo</Button></> : null}
            </div>)}
            <MailSignalLayer signals={mailSignals ?? []} />
            {arcs.paths ? <FlightPaths arcs={arcs.paths.arcs} size={arcs.paths.size} pointer={arcs.paths.pointer} reducedMotion={arcs.paths.reducedMotion} /> : null}
        </div>
    );
}

/**
 * ONE RATE-LIMIT PILL PER PROVIDER in Genie's title bar (the owner, 2026-10-26; moved off the Dashboard header, Tynn #949): its logo and its most constrained
 * window. A click or Enter opens a POPOVER with every window (the owner, 2026-10-31: "can we make these cleaner? this
 * should be a popover not a tooltip"). Buffered in main, so this redraws at most once per provider per buffer.
 */
export interface RateLimitPillsProps {
    limits: Readonly<Record<string, Headroom>>;
    now?: number | undefined;
    /** Every known account and the standing offers (Tynn #483): a provider with accounts draws its account chip instead. */
    accounts?: AccountsSnapshot | undefined;
    onSwitchAccount?: ((provider: string, choose?: string) => void) | undefined;
    onDismissSwitchOffer?: ((id: string) => void) | undefined;
    onDesignSignIn?: (() => void) | undefined;
    /** Tynn #1011: add a Claude account of its own, or make one active. */
    onAccountsAct?: ((action: AccountsAction) => Promise<AccountsActResult>) | undefined;
}

export function RateLimitPills({ limits, now: pinned, accounts, onSwitchAccount, onDismissSwitchOffer, onDesignSignIn, onAccountsAct }: RateLimitPillsProps) {
    // Re-read twice a minute: a window that resets while the header is open turns Refreshed without a new reading.
    const now = useNow(true, pinned, 30_000);
    const viewOf = (p: string) => accounts?.providers.find((v) => v.provider === p) ?? null;
    const providers = [...new Set([...Object.keys(limits), ...(accounts?.providers.map((v) => v.provider) ?? [])])].sort();
    if (providers.length === 0) return null;
    return (
        <div data-rate-limits="" className="flex items-center gap-1.5">
            {providers.map((p) => {
                const view = viewOf(p);
                if (view) return <AccountsChip key={p} view={view} offer={accounts?.offers.find((o) => o.provider === p) ?? null} now={now} onSwitch={onSwitchAccount} onDismissOffer={onDismissSwitchOffer} design={accounts?.design} onDesignSignIn={onDesignSignIn} onAccountsAct={onAccountsAct} signIns={accounts?.signIns} />;
                return limits[p] ? <RateLimitPill key={p} provider={p} limit={limits[p]!} now={now} /> : null;
            })}
        </div>
    );
}

const LEVEL_TEXT: Readonly<Record<LimitLevel, string>> = { ok: 'text-[var(--fg-2)]', warning: 'text-[var(--warning)]', danger: 'text-[var(--danger)]' };
const LEVEL_FILL: Readonly<Record<LimitLevel, string>> = { ok: 'bg-[var(--success)]', warning: 'bg-[var(--warning)]', danger: 'bg-[var(--danger)]' };

function RateLimitPill({ provider, limit, now }: { provider: string; limit: Headroom; now: number }) {
    const [open, setOpen] = useState(false);
    // Every window past its reset: Refreshed, never the last figure (Tynn #478).
    const refreshed = allRefreshed(limit, now);
    const tight = tightestWindow(limit, now);
    const level = refreshed ? 'ok' : limitLevel(tight);
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
                    aria-label={refreshed ? `${name} rate limits: refreshed` : `${name} rate limits: ${tight.over ? 'over the limit' : `${tight.leftPct}% left`} ${windowWords(tight.window)}`}
                    // Enter and Space toggle here and cancel the click the browser would add, so one key press is one toggle.
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } }}
                    className={`gap-1 hover:bg-[var(--bg-2)] ${open ? 'bg-[var(--bg-2)]' : ''}`}
                >
                    <ProviderLogo provider={provider} size="xs" className="text-[var(--fg-3)]" />
                    <span className={`tabular-nums ${LEVEL_TEXT[level]}`}>{refreshed ? 'Refreshed' : leftWords(tight)}</span>
                    <span className="text-[11px] text-[var(--fg-4)]">{tight.window}</span>
                </Button>
            </Popover.Trigger>
            <Popover.Content
                role="dialog"
                aria-label={`${name} rate limits`}
                data-rate-limit-popover={provider}
                className="w-60 border-[var(--border-1)] bg-[var(--surface-raised)] p-3 text-[var(--fg-1)]"
            >
                <RateLimitDetail provider={provider} limit={limit} now={now} />
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
            ) : readLimitWindow(w, now).refreshed ? (
                <div key={w.window} data-rate-limit-window={w.window} data-level="refreshed" className="flex items-center gap-2 text-[var(--fg-3)]">
                    <span className="w-12 shrink-0 text-[var(--fg-2)]">{w.window}</span>
                    <span data-rate-limit-pct="">Refreshed</span>
                </div>
            ) : (
                <div key={w.window} data-rate-limit-window={w.window} data-level={limitLevel(w)} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <span className="w-12 shrink-0 text-[var(--fg-2)]">{w.window}</span>
                        <span role="progressbar" aria-label={`${w.window} left`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.leftPct} className="block h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-3)]">
                            <span data-rate-limit-fill="" className={`block h-full rounded-full ${LEVEL_FILL[limitLevel(w)]}`} style={{ width: `${w.leftPct}%` }} />
                        </span>
                        <span data-rate-limit-pct="" className={`w-16 shrink-0 text-right tabular-nums ${LEVEL_TEXT[limitLevel(w)]}`}>{leftWords(w)}</span>
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
