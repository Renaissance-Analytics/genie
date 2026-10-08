import { Icon, Text } from '@particle-academy/react-fancy';
import { useState } from 'react';
import type { AgentSession, ToolCall } from '../../../main/agentsession/model';
import { agentStream, EVENT_KIND_ICON, type StreamRow } from '../../lib/agent-stream';
import { ToolInspector } from './ToolInspector';

/**
 * THE STREAM — §5.2's body, "oversight on every edit, every thought".
 *
 * One ordered list of two row shapes. SPEECH wraps; an EVENT is exactly one line and
 * **cannot grow** — which is enforced in `lib/agent-stream.ts` by flattening, not here by
 * CSS. The reason is worth keeping at both sites: `white-space: nowrap` in a stylesheet is one
 * careless override away from being lost with nothing failing, and the whole point of the rule
 * is that the rows above the tail never move.
 *
 * A live thought renders as `Thinking…` with the text withheld. Not coyness — it is the only
 * version of "show me the reasoning" that does not reflow the stream on every chunk.
 *
 * What this does NOT do yet, named so it is not mistaken for finished: the Inspector (a
 * selected edit opening as a diff on the right), the lane pulldown, and the timeline ticks.
 * All three need `ToolCall.result` parsed into structured hunks, and the board's own diff rows
 * are the shape to build them against.
 */

function Row({
    row,
    selected,
    onSelect,
}: {
    row: StreamRow;
    selected: boolean;
    onSelect?: () => void;
}): React.JSX.Element {
    if (row.type === 'speech') {
        return (
            <div className="stream-speech" data-live={row.live ? '' : undefined}>
                {row.meta ? (
                    <Text size="xs" className="stream-who">
                        {row.meta}
                    </Text>
                ) : null}
                {/* The ONE place text is allowed to wrap. */}
                <Text size="sm" className="stream-speech-text">
                    {row.main}
                </Text>
            </div>
        );
    }

    if (row.type === 'divider') {
        return (
            <div className="stream-divider" data-level={row.level ?? undefined}>
                <Text size="xs">{row.main}</Text>
            </div>
        );
    }

    /**
     * A tool row is a BUTTON when it has something to inspect, and a plain div otherwise.
     *
     * Not a div with an onClick: a row that responds to Enter and announces itself as
     * activatable is the difference between a surface a keyboard reaches and one it does not.
     * And rows with nothing behind them stay inert rather than becoming controls that do
     * nothing — absence of a control, not a dead one.
     */
    const Tag = onSelect ? 'button' : 'div';
    return (
        <Tag
            className="stream-event"
            data-kind={row.kind ?? undefined}
            data-level={row.level ?? undefined}
            data-live={row.live ? '' : undefined}
            data-selected={selected ? '' : undefined}
            {...(onSelect ? { type: 'button' as const, onClick: onSelect, 'aria-pressed': selected } : {})}
        >
            {row.kind ? <Icon name={EVENT_KIND_ICON[row.kind] as never} size="xs" /> : null}
            {/* ONE LINE. The text is already flattened; the ellipsis is for width, not for
                height — an event row has exactly one of those and always will. */}
            <Text size="xs" className="stream-main">
                {row.main}
            </Text>
            {row.meta ? (
                <Text size="xs" className="stream-meta">
                    {row.meta}
                </Text>
            ) : null}
        </Tag>
    );
}

export function AgentStream({
    session,
    now = Date.now(),
}: {
    session: AgentSession;
    now?: number;
}): React.JSX.Element {
    const rows = agentStream(session, { now });
    const [selectedId, setSelectedId] = useState<string | null>(null);

    /**
     * The selected call, looked up FRESH each render rather than stored.
     *
     * Storing the ToolCall itself would freeze it at selection time — and a selected call is
     * frequently the one still running, whose status and result arrive after you clicked it.
     * A stale copy would show "running" forever.
     */
    const byRowId = new Map<string, ToolCall>(session.tools.map((c) => [`tool:${c.id}`, c]));
    const selected: ToolCall | null = (selectedId && byRowId.get(selectedId)) || null;

    if (rows.length === 0) {
        // The board's empty state is a SENTENCE, not a blank panel: a new agent has said
        // nothing, which is a fact rather than a fault.
        return (
            <div className="agent-stream">
                <Text size="sm">Nothing yet. The persona and provider are known before the first turn.</Text>
            </div>
        );
    }

    return (
        <div className="agent-stream-wrap">
            <div className="agent-stream">
                {rows.map((row) => {
                    const call = byRowId.get(row.id);
                    return (
                        <Row
                            key={row.id}
                            row={row}
                            selected={row.id === selectedId}
                            {...(call ? { onSelect: () => setSelectedId(row.id === selectedId ? null : row.id) } : {})}
                        />
                    );
                })}
            </div>
            {/* FIXED pane, outside the scroller. Expansion happens here and never in the
                stream, so opening a row cannot move the rows above it — which is the whole
                reason the stream's rows are one line in the first place. */}
            <ToolInspector call={selected} onClose={() => setSelectedId(null)} />
        </div>
    );
}
