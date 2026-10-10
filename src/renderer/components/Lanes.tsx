import { useRef, useState } from 'react';
import { laneSummary, rangeFromDrag, timelineOf, type Lane, type TimeRange } from '../../core/lanes.js';
import { LANES, type TimedEvent } from '../../core/stream-view.js';

/**
 * LANES — the filter over the current turn.
 *
 * ## It renders a SENTENCE rather than four empty tracks
 *
 * *"With no timestamped rows, Lanes renders a sentence, not four empty tracks."* Empty tracks
 * read as **"nothing happened"**; the truth is **"Genie has no times for these"** — a thread
 * replayed from storage that kept no timestamps. Different claims about somebody's work.
 *
 * The counts still show in that case, because what is missing is *when*, not *whether*.
 *
 * ## The selection is in the route
 *
 * So a filtered view is linkable and survives a refresh, and an agent can hand a human a link
 * to the edits of one turn. `L` opens it; the toggles write `?lane=`.
 */

const LABEL: Record<Lane, string> = {
    messages: 'Messages',
    thoughts: 'Thoughts',
    tools: 'Tools',
    edits: 'Edits',
};

export interface LanesProps {
    rows: readonly TimedEvent[];
    /** `null` = not filtering. `[]` = filtering to nothing, which is a different request. */
    selected: readonly Lane[] | null;
    onChange: (lanes: readonly Lane[] | null) => void;
    /** The time range from the route, or `null`. */
    range: TimeRange | null;
    /** A drag ended (a range), or the range was cleared (`null`). */
    onRange: (range: TimeRange | null) => void;
}

export function Lanes({ rows, selected, onChange, range, onRange }: LanesProps) {
    const summary = laneSummary(rows);
    const timeline = timelineOf(rows);

    /*
     * THE DRAG. Pointer down records a fraction of the bar; pointer move previews; pointer up
     * commits through `onRange`. Pointer capture keeps the drag alive when the pointer leaves
     * the bar, so releasing past the edge clamps to it rather than losing the drag.
     *
     * All the arithmetic is `rangeFromDrag`, which is pure and tested; this only reads the
     * pointer's position as a fraction of the bar.
     */
    const bar = useRef<HTMLDivElement | null>(null);
    const [drag, setDrag] = useState<{ start: number; now: number } | null>(null);
    const fractionAt = (clientX: number): number => {
        const rect = bar.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return 0;
        return (clientX - rect.left) / rect.width;
    };

    // The band: the committed range, or the drag in progress, as fractions of the span —
    // clamped, so a range from a link to a longer turn is shown as far as it applies.
    const band = (() => {
        if (!timeline) return null;
        const span = timeline.end - timeline.start || 1;
        const toFraction = (t: number) => Math.min(1, Math.max(0, (t - timeline.start) / span));
        if (drag) return { left: Math.min(drag.start, drag.now), right: Math.max(drag.start, drag.now), live: true };
        if (range) return { left: toFraction(range.from), right: toFraction(range.to), live: false };
        return null;
    })();

    const toggle = (lane: Lane): void => {
        // From "not filtering", the first click means "only this lane" — which is what somebody
        // clicking one lane is asking for. Starting from all-four-selected would make the first
        // click appear to do nothing.
        if (selected === null) {
            onChange([lane]);
            return;
        }

        const next = selected.includes(lane) ? selected.filter((l) => l !== lane) : [...selected, lane];
        // Back to every lane is the same view as no filter, so it is recorded as no filter —
        // one state for one view, and the route stays clean.
        onChange(next.length === LANES.length ? null : next);
    };

    return (
        <div data-lanes className="flex shrink-0 flex-col gap-2 border-b border-[var(--border-1)] px-5 py-2">
            <div className="flex flex-wrap items-center gap-1.5">
                {LANES.map((lane) => {
                    const on = selected === null || selected.includes(lane);
                    return (
                        <button
                            key={lane}
                            type="button"
                            data-lane={lane}
                            data-on={on ? 'true' : 'false'}
                            aria-pressed={on}
                            onClick={() => toggle(lane)}
                            className={`flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${
                                on
                                    ? 'border-[var(--border-2)] bg-[var(--bg-2)] text-[var(--fg-1)]'
                                    : 'border-[var(--border-1)] text-[var(--fg-4)]'
                            }`}
                        >
                            {LABEL[lane]}
                            {/*
                             * A MEASURED zero is kept. A turn with no edits genuinely has none,
                             * and the reader asking "did it change anything?" is answered by a
                             * `0` — this is the opposite case from a count Genie could not
                             * attribute, which renders nothing.
                             */}
                            <span data-lane-count={summary.counts[lane]} className="font-mono tabular-nums text-[var(--fg-4)]">
                                {summary.counts[lane]}
                            </span>
                        </button>
                    );
                })}

                {selected !== null ? (
                    <button
                        type="button"
                        data-lanes-clear
                        onClick={() => onChange(null)}
                        className="ml-1 text-xs text-[var(--fg-3)] hover:text-[var(--fg-1)]"
                    >
                        Clear
                    </button>
                ) : null}
            </div>

            {/*
             * The sentence, where four empty tracks would otherwise be. It appears INSTEAD of
             * the timeline, not beside it — a sentence under empty tracks would be read as a
             * caption on an accurate drawing.
             */}
            {summary.drawable && timeline ? (
                <div className="flex items-center gap-2">
                    <div
                        ref={bar}
                        data-lanes-timeline
                        className="relative h-6 flex-1 cursor-crosshair select-none rounded bg-[var(--bg-1)]"
                        onPointerDown={(e) => {
                            e.currentTarget.setPointerCapture(e.pointerId);
                            const f = fractionAt(e.clientX);
                            setDrag({ start: f, now: f });
                        }}
                        onPointerMove={(e) => { if (drag) setDrag({ start: drag.start, now: fractionAt(e.clientX) }); }}
                        onPointerUp={(e) => {
                            if (!drag) return;
                            const next = rangeFromDrag(timeline, drag.start, fractionAt(e.clientX));
                            setDrag(null);
                            // A click (zero-width drag) is null and clears nothing: it is a mis-click,
                            // not a request to filter to nothing.
                            if (next) onRange(next);
                        }}
                    >
                        {band ? (
                            <div
                                data-range-band={band.live ? 'live' : 'set'}
                                className="absolute inset-y-0 rounded bg-[var(--accent)]/20 ring-1 ring-inset ring-[var(--accent)]/50"
                                style={{ left: `${band.left * 100}%`, width: `${(band.right - band.left) * 100}%` }}
                            />
                        ) : null}
                        {/*
                         * One tick per EDIT, placed by arrival time (§4.2). Not messages, not
                         * tools: the timeline answers "where did it change something?".
                         */}
                        {timeline.ticks.map((tick) => (
                            <span
                                key={tick.id}
                                data-tick={tick.id}
                                className="absolute top-1 h-4 w-0.5 -translate-x-1/2 rounded bg-[var(--success)]"
                                style={{ left: `${tick.x * 100}%` }}
                            />
                        ))}
                    </div>
                    {range ? (
                        <button
                            type="button"
                            data-range-clear
                            onClick={() => onRange(null)}
                            className="text-xs text-[var(--fg-3)] hover:text-[var(--fg-1)]"
                        >
                            Clear range
                        </button>
                    ) : null}
                </div>
            ) : (
                <p data-lanes-reason className="text-xs text-[var(--fg-3)]">{summary.reason}</p>
            )}
        </div>
    );
}
