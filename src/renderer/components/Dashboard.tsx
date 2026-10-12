import { ActivityLight, Icon } from '@particle-academy/react-fancy';
import { useEffect, useState } from 'react';
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
    type WorkspaceGroup,
} from '../../core/dashboard-view.js';

/**
 * THE WORKFLOW DASHBOARD — the landing surface.
 *
 * *"What is being produced, and by whom?"* A board you READ. It carries **no resolving
 * control anywhere**: no approve, no deny, no answer, no composer, not even in a row tray. A
 * waiting row links to its Deck item and is answered there — the Deck resolves, the Dashboard
 * shows. `A`/`D` are deliberately unbound on this surface.
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
function AgentRowView({ row, onOpen, onFix, focused = false }: { row: AgentRow; onOpen: (id: string) => void; onFix?: ((route: FixRoute) => void) | undefined; focused?: boolean | undefined }) {
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
            onClick={() => onOpen(row.id)}
            className={`${GRID} h-8 items-center border-b border-[var(--border-1)] text-[13px] hover:bg-[var(--bg-1)] ${focused ? 'bg-[var(--bg-2)] shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
        >
            <div className="flex min-w-0 items-center gap-2">
                <FidelityDot fidelity={row.fidelity} state={row.state} />
                <span className="truncate font-medium">{row.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-[var(--fg-4)]">{row.provider}</span>
            </div>

            <div className="flex min-w-0 items-center gap-1.5">
                <span className={`shrink-0 font-medium ${STATUS_TONE[status.tone]}`}>{status.word}</span>
                {status.detail ? <span className="truncate text-xs text-[var(--fg-3)]">{status.detail}</span> : null}
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
            <div className="flex items-center gap-1.5 text-xs text-[var(--fg-2)]">
                {comms ? (
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
}: {
    group: WorkspaceGroup;
    /** The envelope's name, else the folder — the rail's rule; the id only when nothing else is known. */
    name: string;
    path: string;
    onAddAgent: (workspaceId: string) => void;
    onOpenWorkspace?: ((workspaceId: string) => void) | undefined;
}) {
    return (
        <>
            <div className="flex h-7 items-center border-b border-[var(--border-1)] bg-[var(--bg-1)] pl-7 pr-5 text-xs">
                <span className="font-semibold">{name}</span>
                <span className="ml-2.5 truncate font-mono text-[11px] text-[var(--fg-4)]">{path}</span>
                {group.summary ? <span className="ml-2.5 shrink-0 text-[var(--fg-3)]">{group.summary}</span> : null}
                {group.governedBy ? <span data-governed-by={group.governedBy} className="ml-2.5 shrink-0 text-[var(--fg-4)]">governed by {group.governedBy}</span> : null}
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
     * Every workspace Genie knows, in rail order — including those with no agents.
     *
     * `null` = **not read yet**, which renders a skeleton. `[]` = read, and there are none,
     * which renders the first-run invitation. Collapsing them puts a confident claim about an
     * empty machine on screen before anybody has looked.
     */
    workspaces: readonly { id: string; path: string; name?: string | undefined; governedBy?: string | null | undefined }[] | null;
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
    /** A broken row's fix button (`core/dashboard-view.ts` `fixRoute`); absent = the button opens the agent. */
    onFix?: ((route: FixRoute) => void) | undefined;
    /** `Chat ⌘J` — the composer, on genie, one click from the board. */
    onChat?: (() => void) | undefined;
    /** The row cursor (`J`/`K`), controlled — for tests that render server-side. Otherwise the board keeps its own. */
    focusedId?: string | null | undefined;
}

export function Dashboard({ rows, workspaces, onOpenAgent, onAddAgent, onAddWorkspace, onAddWorkspaceFromGit, onAddWorkspaceFromTynn, group = 'workspace', onGroup, onOpenWorkspace, onFix, onChat, focusedId }: DashboardProps) {
    const groups = groupByWorkspace(
        rows,
        (workspaces ?? []).map((w) => w.id),
        Object.fromEntries((workspaces ?? []).flatMap((w) => (w.governedBy ? [[w.id, w.governedBy]] : []))),
    );
    // THE ROW CURSOR (§4.1): `J`/`K` over the rows in document order, `↵` opens, `G` cycles the grouping. `A`/`D` are
    // unbound here — the Dashboard resolves nothing. The keys are decided in `core/keys.ts`; letters never act while typing.
    const [ownFocus, setOwnFocus] = useState<string | null>(null);
    const focused = focusedId ?? ownFocus;
    const statusGroupsForOrder = groupByStatus(rows);
    const visibleIds = group === 'status' ? statusGroupsForOrder.flatMap((g) => g.rows.map((r) => r.id)) : groups.flatMap((g) => g.rows.map((r) => r.id));
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const action = dashboardAction({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: isTypingTarget(e.target as never) });
            if (action === null) return;
            e.preventDefault();
            if (action === 'next-row') setOwnFocus(stepFocus(visibleIds, focused, 1));
            else if (action === 'prev-row') setOwnFocus(stepFocus(visibleIds, focused, -1));
            else if (action === 'open') { if (focused !== null && visibleIds.includes(focused)) onOpenAgent(focused); }
            else if (action === 'cycle-group') onGroup?.(group === 'workspace' ? 'status' : 'workspace');
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [visibleIds, focused, onOpenAgent, onGroup, group]);
    const statusGroups = groupByStatus(rows);
    const chips = summaryChips(rows);
    const pathOf = (id: string): string => workspaces?.find((w) => w.id === id)?.path ?? '';
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
    if (workspaces.length === 0) {
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
        <div data-surface="dashboard" className="flex min-h-0 flex-col">
            {/* View header, 56px. */}
            <div className="flex h-14 shrink-0 items-center gap-4 border-b border-[var(--border-1)] pl-7 pr-5">
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
                            <div className="flex h-7 items-center border-b border-[var(--border-1)] bg-[var(--bg-1)] pl-7 pr-5 text-xs">
                                <span className={`mr-2 size-2 rounded-full ${CHIP_DOT[g.state]}`} />
                                <span className="font-semibold">{g.label}</span>
                                <span className="ml-2.5 text-[var(--fg-3)]">{g.rows.length} {g.rows.length === 1 ? 'agent' : 'agents'}</span>
                            </div>
                            {g.rows.map((row) => (
                                <AgentRowView key={row.id} row={row} onOpen={onOpenAgent} onFix={onFix} focused={row.id === focused} />
                            ))}
                        </div>
                    ))}
                </div>
            ) : groups.map((group) => (
                <div key={group.workspaceId} data-workspace={group.workspaceId}>
                    <GroupHeader group={group} name={nameOf(group.workspaceId)} path={pathOf(group.workspaceId)} onAddAgent={onAddAgent} onOpenWorkspace={onOpenWorkspace} />
                    {group.rows.map((row) => (
                        <AgentRowView key={row.id} row={row} onOpen={onOpenAgent} onFix={onFix} focused={row.id === focused} />
                    ))}
                </div>
            ))}
        </div>
    );
}
