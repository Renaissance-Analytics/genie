import { Icon, Text } from '@particle-academy/react-fancy';
import type { AgentSession } from '../../../main/agentsession/model';
import { agentStream, EVENT_KIND_ICON, type StreamRow } from '../../lib/agent-stream';

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

function Row({ row }: { row: StreamRow }): React.JSX.Element {
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

    return (
        <div
            className="stream-event"
            data-kind={row.kind ?? undefined}
            data-level={row.level ?? undefined}
            data-live={row.live ? '' : undefined}
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
        </div>
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
        <div className="agent-stream">
            {rows.map((row) => (
                <Row key={row.id} row={row} />
            ))}
        </div>
    );
}
