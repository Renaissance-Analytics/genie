import { Icon, Text } from '@particle-academy/react-fancy';
import type { AgentSession } from '../../../main/agentsession/model';
import {
    dashboardView,
    DELIVERY_ICON,
    type DashboardDelivery,
    type DashboardFigures,
    type DashboardGroup,
    type DashboardRow,
    type DashboardWorkspace,
} from '../../lib/dashboard-view';

/**
 * THE WORKFLOW DASHBOARD — `genie://dashboard?group=workspace`.
 *
 * The owner's surface, from the spec board. It answers *"what is being produced, and by
 * whom?"*, which is deliberately not the Deck's *"does anything need me?"* — the Deck is a
 * queue you clear, this is a board you read. The same agent appears on both; only the Deck
 * row asks for anything.
 *
 * ## This file is the RENDER
 *
 * Every decision — the sort order, the status words, the 160k context threshold, what counts
 * as a delivery — lives in `lib/dashboard-view.ts` with its tests. `Deck.tsx` set that
 * pattern and said why: a rule trapped in JSX can only be reached by an E2E shard.
 *
 * ## What it refuses to draw
 *
 * **Nothing, where Genie cannot see.** No dash, no zero, no "unknown". An agent with no
 * delivery gets an empty cell; an Observed agent gets no context cell AT ALL rather than an
 * empty one — the first is §6.1 of the brief (a figure not worth showing yet), the second is
 * §6.3 (absence of a control, not a disabled one). `DashboardRow` keeps them as separate
 * fields precisely so this file cannot conflate them.
 *
 * **No collaborator count yet.** `whisper_messages` keys on the terminal's own id rather than
 * `workspace_agents.id`, and that join breaks for a dormant agent — so the number is
 * genuinely unattributable today and renders as absent. A `0` there would claim an agent
 * works alone, which is the confident-zero mistake this product has already paid for once.
 */

/** The dot's shape carries the fidelity, which is the one thing a glance must not get wrong:
 *  filled = declared, hollow ring = observed, dashed = remote (2.1). */
function StateDot({ row }: { row: DashboardRow }): React.JSX.Element {
    const shape = row.fidelity === 'observed' ? 'ring' : 'filled';
    return <span className="dash-dot" data-shape={shape} data-state={row.state} />;
}

function Delivery({ delivery }: { delivery: DashboardDelivery }): React.JSX.Element {
    return (
        <>
            <Icon name={DELIVERY_ICON[delivery.kind] as never} size="xs" />
            {/* MONO for a commit or a path, sans for prose — the board's distinction, and it
                is load-bearing: a sha in a proportional face is unreadable at 12px. */}
            <Text size="xs" className="dash-del-main" data-mono={delivery.mono ? '' : undefined}>
                {delivery.main}
            </Text>
            {delivery.sub ? (
                <Text size="xs" className="dash-del-sub">
                    {delivery.sub}
                </Text>
            ) : null}
        </>
    );
}

function Row({ row, onOpen }: { row: DashboardRow; onOpen?: () => void }): React.JSX.Element {
    /**
     * THE ROW IS THE DOOR.
     *
     * Same idiom as the stream's rows, and for the same reason: a `<div>` with an onClick is
     * unreachable by keyboard and announces nothing, while a row with nothing behind it stays
     * inert rather than becoming a control that does nothing.
     *
     * beta.1 shipped this surface with neither — no handler and no element — so the board the
     * owner was meant to work from could not be worked from at all. `data-agent` is carried on
     * the element so a row wired to the wrong agent is a visible defect, not a silent one.
     */
    const Tag = onOpen ? 'button' : 'div';
    return (
        <Tag
            className="dash-row"
            data-state={row.state}
            data-fidelity={row.fidelity}
            data-agent={row.agentId}
            {...(onOpen ? { type: 'button' as const, onClick: onOpen } : {})}
        >
            <div className="dash-cell dash-agent">
                <StateDot row={row} />
                <Text size="sm" className="dash-name">
                    {row.name}
                </Text>
                <Text size="xs" className="dash-prov">
                    {/* `· pty` says WHY this row is thinner, at the one place a reader asks.
                        An unresolvable provider says so rather than showing a blank, because
                        the repair is the point of the row. */}
                    {row.provider ?? 'provider unknown'}
                    {row.fidelity === 'observed' ? ' · pty' : ''}
                </Text>
            </div>

            <div className="dash-cell dash-status">
                <Text size="sm" className="dash-status-word">
                    {row.statusWord}
                </Text>
                {row.statusDetail ? (
                    <Text size="xs" className="dash-status-detail">
                        {row.statusDetail}
                    </Text>
                ) : null}
            </div>

            <div className="dash-cell dash-target">
                {row.step ? (
                    <Text size="xs" className="dash-step">
                        {row.step}
                    </Text>
                ) : null}
                {row.target ? (
                    <Text size="xs" className="dash-target-text">
                        {row.target}
                    </Text>
                ) : null}
            </div>

            <div className="dash-cell dash-delivery">
                {row.delivery ? <Delivery delivery={row.delivery} /> : null}
            </div>

            <div className="dash-cell dash-comms">
                {row.collaborators !== null ? (
                    <>
                        <Icon name="users" size="xs" />
                        <Text size="xs" className="dash-comms-count">
                            {row.collaborators}
                        </Text>
                    </>
                ) : null}
            </div>

            {/* The cell EXISTS or it does not. An Observed agent has no usage to report, so it
                gets no cell — rather than an empty one that promises a reading it can never
                give. A declared agent below the threshold gets the cell and nothing in it. */}
            <div className="dash-cell dash-context">
                {row.showsContextCell && row.context ? (
                    <>
                        <span className="dash-ctx-bar" data-level={row.context.level}>
                            <span style={{ width: `${row.context.pct}%` }} />
                        </span>
                        <Text size="xs" className="dash-ctx-label" data-level={row.context.level}>
                            {row.context.label}
                        </Text>
                    </>
                ) : null}
            </div>
        </Tag>
    );
}

function Group({
    group,
    onOpenAgent,
    onAddAgent,
}: {
    group: DashboardGroup;
    onOpenAgent?: (agentId: string) => void;
    onAddAgent?: (workspaceId: string) => void;
}): React.JSX.Element {
    return (
        <div className="dash-group">
            <div className="dash-group-head">
                <Text size="xs" className="dash-group-name">
                    {group.name}
                </Text>
                <Text size="xs" className="dash-group-path">
                    {group.path}
                </Text>
                <Text size="xs" className="dash-group-summary">
                    {group.summary}
                </Text>
            </div>
            {group.isEmpty ? (
                // KEPT, not hidden. A workspace that disappears when its agents stop is a
                // workspace you cannot start work in — so it offers the way in instead.
                // "Offers" is the operative word, and it took a button: the row printed
                // "No agents" and left you with nowhere to go from the empty state.
                <div className="dash-empty-row">
                    <Text size="sm">No agents</Text>
                    {onAddAgent ? (
                        <button
                            type="button"
                            className="dash-add-agent"
                            data-workspace={group.key}
                            onClick={() => onAddAgent(group.key)}
                        >
                            Add agent
                        </button>
                    ) : null}
                </div>
            ) : null}
            {group.rows.map((row) => (
                <Row
                    key={row.agentId}
                    row={row}
                    {...(onOpenAgent ? { onOpen: () => onOpenAgent(row.agentId) } : {})}
                />
            ))}
        </div>
    );
}

/**
 * Which figures the header strip can show, and in what order.
 *
 * Typed against `DashboardFigures` rather than `DashboardState`, which the compiler caught:
 * `remote` is a real STATE but not a real FIGURE, because nothing produces one until
 * cross-workstation (2.1) exists. Writing it here would have put an "N unreachable" count on
 * screen that could only ever read zero — and §6.2 says a signal that is always silent trains
 * people to stop reading the strip.
 */
const SUMMARY_ORDER: Array<{ state: keyof DashboardFigures; label: string }> = [
    { state: 'waiting', label: 'waiting on you' },
    { state: 'broken', label: 'broken' },
    { state: 'working', label: 'working' },
    { state: 'idle', label: 'idle' },
];

export function Dashboard({
    sessions,
    workspaces,
    // Defaulted like `Deck`'s, so the surface can be mounted without the shell having to own a
    // clock. The decay in `statusDetail` is coarse (minutes), so one value per render is right
    // — a per-second tick to animate a duration is heat, not oversight.
    now = Date.now(),
    onOpenAgent,
    onAddAgent,
}: {
    sessions: AgentSession[];
    workspaces: DashboardWorkspace[];
    now?: number;
    /**
     * Open an agent. THE reason this surface can hold the default — "the top level shows
     * status and communication; work opens one level down", and without this there was no
     * level down to open.
     */
    onOpenAgent?: (agentId: string) => void;
    /** The way into a workspace that has no agents yet. */
    onAddAgent?: (workspaceId: string) => void;
}): React.JSX.Element {
    const view = dashboardView(sessions, { now, workspaces });

    return (
        <div className="dashboard">
            <div className="dash-head">
                <Text size="lg" className="dash-title">
                    Dashboard
                </Text>
                {/* SILENT UNLESS TRUE — §6.2. A strip that always reads "0 broken" trains
                    people to stop reading it, so each figure appears only when it is non-zero. */}
                <div className="dash-figures">
                    {SUMMARY_ORDER.filter(({ state }) => view.figures[state] > 0).map(({ state, label }) => (
                        <span key={state} className="dash-figure">
                            <span className="dash-dot" data-shape="filled" data-state={state} />
                            <Text size="xs">{`${view.figures[state]} ${label}`}</Text>
                        </span>
                    ))}
                </div>
            </div>

            <div className="dash-table">
                <div className="dash-row dash-col-head">
                    <span>Agent</span>
                    <span>Status</span>
                    <span>Current target</span>
                    <span>Latest delivery</span>
                    <span>Comms</span>
                    <span>Context</span>
                </div>
                {view.groups.map((group) => (
                    <Group
                        key={group.key}
                        group={group}
                        {...(onOpenAgent ? { onOpenAgent } : {})}
                        {...(onAddAgent ? { onAddAgent } : {})}
                    />
                ))}
            </div>
        </div>
    );
}
