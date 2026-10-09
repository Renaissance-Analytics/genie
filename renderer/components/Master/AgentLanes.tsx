import { useRef, useState } from 'react';
import { Text } from '@particle-academy/react-fancy';
import {
    laneOffset,
    laneTimeAt,
    type LaneSpan,
    type LanesView,
} from '../../lib/agent-lanes';

/**
 * The LANES strip (§5.2) — messages, thoughts, tools and edits over the current turn.
 *
 * Render only. Which rows become ticks, what a range admits, and how a drag becomes a time
 * all live in `lib/agent-lanes.ts`, which is tested; this file positions things.
 *
 * ## It says when it cannot draw
 *
 * With no stamped rows there is no span, and the strip renders a sentence instead of four
 * empty tracks. Four empty tracks would read as "nothing happened" when the truth is "Genie
 * has no times for these" — the same distinction `null` carries everywhere else in this
 * model, and the one that is easiest to lose at the render layer.
 */
export function AgentLanes({
    view,
    range,
    onRange,
}: {
    view: LanesView;
    range: LaneSpan | null;
    onRange: (range: LaneSpan | null) => void;
}): React.JSX.Element {
    const stripRef = useRef<HTMLDivElement | null>(null);
    // The in-flight drag, as fractions. Kept local because a half-made selection is not
    // state anyone else needs — committing to the URL on every pointer move would put a
    // history entry behind every pixel.
    const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

    if (!view.span) {
        return (
            <div className="lanes lanes-empty" data-testid="agent-lanes">
                <Text size="xs">No times reported for this turn, so there is nothing to place.</Text>
            </div>
        );
    }
    const span = view.span;

    const fractionAt = (clientX: number): number => {
        const el = stripRef.current;
        if (!el) return 0;
        const box = el.getBoundingClientRect();
        if (box.width <= 0) return 0;
        return (clientX - box.left) / box.width;
    };

    const commit = (d: { from: number; to: number }) => {
        const a = laneTimeAt(Math.min(d.from, d.to), span);
        const b = laneTimeAt(Math.max(d.from, d.to), span);
        // A CLICK is not a selection. Without this, a stray click on the strip filters the
        // stream to a single instant and empties it, which reads as the lanes deleting the
        // transcript.
        if (Math.abs(d.to - d.from) < 0.01) {
            onRange(null);
            return;
        }
        onRange({ from: a, to: b });
    };

    const selection = drag ?? (range ? { from: laneOffset(range.from, span), to: laneOffset(range.to, span) } : null);

    return (
        <div className="lanes" data-testid="agent-lanes">
            <div className="lanes-head">
                <Text size="xs">Lanes</Text>
                {range ? (
                    <button type="button" className="lanes-clear" onClick={() => onRange(null)}>
                        Clear range
                    </button>
                ) : null}
                {view.unplaceable > 0 ? (
                    // Reported, not hidden. These rows stay in the stream under any range,
                    // and saying how many explains why a tight range still shows some.
                    <Text size="xs" className="lanes-unplaceable">
                        {view.unplaceable} unplaced
                    </Text>
                ) : null}
            </div>

            <div
                className="lanes-strip"
                ref={stripRef}
                onPointerDown={(e) => {
                    const f = fractionAt(e.clientX);
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setDrag({ from: f, to: f });
                }}
                onPointerMove={(e) => {
                    if (!drag) return;
                    setDrag({ from: drag.from, to: fractionAt(e.clientX) });
                }}
                onPointerUp={(e) => {
                    if (!drag) return;
                    const d = { from: drag.from, to: fractionAt(e.clientX) };
                    setDrag(null);
                    commit(d);
                }}
                onPointerCancel={() => setDrag(null)}
            >
                {selection ? (
                    <div
                        className="lanes-selection"
                        style={{
                            left: `${Math.min(selection.from, selection.to) * 100}%`,
                            width: `${Math.abs(selection.to - selection.from) * 100}%`,
                        }}
                    />
                ) : null}

                {view.lanes.map((lane) => (
                    <div key={lane.id} className="lanes-lane" data-lane={lane.id}>
                        <Text size="xs" className="lanes-label">
                            {lane.label}
                        </Text>
                        <div className="lanes-track">
                            {lane.ticks.map((tick) => (
                                <span
                                    key={tick.id}
                                    className="lanes-tick"
                                    data-tick={tick.id}
                                    data-level={tick.level ?? undefined}
                                    data-live={tick.live ? '' : undefined}
                                    style={{ left: `${laneOffset(tick.at, span) * 100}%` }}
                                />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
