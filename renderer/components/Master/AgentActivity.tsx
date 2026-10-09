import { useState } from 'react';
import { Icon, Text } from '@particle-academy/react-fancy';
import type { AgentSession, ToolCall } from '../../../main/agentsession/model';
import { ToolInspector } from './ToolInspector';
import {
    agentActivity,
    ACTIVITY_KIND_ICON,
    type ActivityRow,
    type ActivitySource,
} from '../../lib/agent-activity';

/**
 * ACTIVITY — the Observed agent's first tab, and its default.
 *
 * Every decision is in `lib/agent-activity.ts`: which rows exist, what each one says, which of
 * them can be opened, and — the load-bearing half — which sources Genie cannot see at all.
 * This file is the render and deliberately holds no rules of its own, because the test
 * environment has no DOM and a rule made inside a component is a rule nobody checks.
 *
 * ## The two things it does decide, and both are about absence
 *
 * **An unknown time renders NO element.** Not a dash, not "unknown" — a placeholder in a time
 * column reads as a time that failed to load, when the truth is that nobody stamped the event.
 *
 * **A source with no count prints no number.** The panel below the list names all six of the
 * board's sources, and the four Genie cannot measure per agent say why instead of showing a
 * `0`. That is the whole reason this surface exists rather than an empty list: an empty list
 * reads as *"this agent has done nothing"*, which is a claim about the agent rather than about
 * Genie's eyesight.
 */

function Row({
    row,
    onInspect,
}: {
    row: ActivityRow;
    onInspect?: (toolCallId: string) => void;
}): React.JSX.Element {
    /**
     * A BUTTON when there is something behind it, a plain div otherwise.
     *
     * Never a div with an onClick: a row that responds to Enter and announces itself as
     * activatable is the difference between a surface a keyboard reaches and one it does not.
     * And a row with nothing to open stays inert rather than becoming a control that does
     * nothing when pressed — absence of a control, not a dead one.
     */
    const inspect = row.inspect;
    const open = inspect !== null && onInspect ? () => onInspect(inspect) : null;
    const Tag = open ? 'button' : 'div';

    return (
        <Tag
            className="activity-row"
            data-kind={row.kind}
            data-level={row.level ?? undefined}
            data-live={row.live ? '' : undefined}
            {...(open ? { type: 'button' as const, onClick: open } : {})}
        >
            {/* NOTHING AT ALL for an unstamped row. `dateTime` carries the instant for
                machines; the text is local-time for the reader, which is also why no test
                pins the label — CI runs in a different zone from this desktop. */}
            {row.iso !== null ? (
                <time className="activity-time" dateTime={row.iso}>
                    {new Date(row.iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </time>
            ) : null}
            <Icon name={ACTIVITY_KIND_ICON[row.kind]} size="xs" />
            {/* ONE LINE. Already flattened by the projection — the ellipsis here is for width,
                because an activity row has exactly one line and always will. */}
            <Text size="xs" className="activity-main">
                {row.main}
            </Text>
            {row.meta ? (
                <Text size="xs" className="activity-meta">
                    {row.meta}
                </Text>
            ) : null}
        </Tag>
    );
}

function Source({ source }: { source: ActivitySource }): React.JSX.Element {
    if (source.count === null) {
        return (
            <div className="activity-blind" data-source={source.id} data-blind="">
                <Text size="xs" className="activity-blind-label">
                    {source.label}
                </Text>
                {/* The REASON, always — "no count and no explanation" is strictly worse than
                    either, which is the case `rateLimitUnavailable` exists to prevent. */}
                <Text size="xs" className="activity-blind-reason">
                    {source.unavailable}
                </Text>
            </div>
        );
    }

    return (
        <div className="activity-source" data-source={source.id}>
            <Text size="xs" className="activity-source-count">
                {source.count}
            </Text>
            <Text size="xs" className="activity-source-label">
                {source.label}
            </Text>
        </div>
    );
}

export function AgentActivity({
    session,
    onInspect,
}: {
    session: AgentSession;
    /**
     * Open a tool call. Absent means nothing on this surface can show one, and then no row is
     * a control — a button that opens nothing invites a press and swallows it.
     */
    onInspect?: (toolCallId: string) => void;
}): React.JSX.Element {
    const view = agentActivity(session);
    /**
     * Activity's OWN inspector.
     *
     * `agentActivity` marks a tool row with `inspect: c.id`, and nothing was passing
     * `onInspect` — so every one of those rows rendered as an inert `<div>`. The idiom was
     * right and the wiring was missing, which is the exact defect this release spent its day
     * removing; I built the guard that catches it and then left this one.
     *
     * Resolved FRESH each render rather than stored, for the reason the Stream records: a
     * selected call is frequently the one still running, and a stored copy would show
     * "running" forever after it finished.
     */
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selected: ToolCall | null = (selectedId && session.tools.find((c) => c.id === selectedId)) || null;
    // The caller's handler wins when there is one; otherwise Activity inspects in place. A
    // row is still inert when NEITHER exists, so `inspect: null` rows never become controls.
    const inspectRow = onInspect ?? ((id: string) => setSelectedId((cur) => (cur === id ? null : id)));

    return (
        <div className="agent-activity" data-testid="agent-activity">
            {view.rows.length === 0 ? (
                /**
                 * NOT "no activity". The list being empty says nothing about the agent: the
                 * sources panel directly below names what Genie cannot see per agent, and that
                 * is the honest account of an empty Activity tab.
                 */
                <Text size="sm" className="activity-empty">
                    Nothing observed through Genie&apos;s own channels yet.
                </Text>
            ) : (
                <div className="activity-rows">
                    {view.rows.map((row) => (
                        <Row key={row.id} row={row} onInspect={inspectRow} />
                    ))}
                </div>
            )}

            {/* WHAT THIS SURFACE CAN AND CANNOT SEE, always rendered — including on a busy
                agent, where it is the only thing that stops the list reading as complete. */}
            <ToolInspector call={selected} onClose={() => setSelectedId(null)} />

            <div className="activity-sources">
                {view.sources.map((source) => (
                    <Source key={source.id} source={source} />
                ))}
            </div>
        </div>
    );
}
