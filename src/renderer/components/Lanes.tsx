import { useRef, useState } from 'react';
import { drawerLabels, laneSummary, laneTracks, rangeFromDrag, timelineOf, type TimeRange } from '../../core/lanes.js';
import type { TimedEvent } from '../../core/stream-view.js';

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
 * to the edits of one turn. `L` opens this drawer (the board's `Lanes ▾`); the CHIPS ROW above it writes `?lane=`.
 * This drawer is the tracks and the drag: the lane buttons moved to the chips.
 */

export interface LanesProps {
    rows: readonly TimedEvent[];
    /** The time range from the route, or `null`. */
    range: TimeRange | null;
    /** A drag ended (a range), or the range was cleared (`null`). */
    onRange: (range: TimeRange | null) => void;
    /** The clock, for `– now` and the axis; injectable for tests. */
    now?: (() => number) | undefined;
}

export function Lanes({ rows, range, onRange, now }: LanesProps) {
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

    const tracks = timeline ? laneTracks(rows, timeline) : [];
    const labels = timeline ? drawerLabels(rows, timeline, range, (now ?? Date.now)()) : null;

    return (
        <div data-lanes className="flex shrink-0 flex-col gap-1 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-6 py-2.5">
            {/* THE HEADER (the board): `LANES`, the span, the hint, and the selection while a range is set. */}
            <div className="mb-1 flex h-[22px] items-center gap-3.5">
                <span className="w-14 shrink-0 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Lanes</span>
                {labels ? <span data-lanes-span="" className="font-mono text-[11px] text-[var(--fg-2)]">{labels.span}</span> : null}
                <span className="flex-1" />
                {labels ? <span className="text-[11px] text-[var(--fg-3)]">Drag across the lanes to select a range; the stream below filters to it.</span> : null}
                {labels?.selected ? <span data-lanes-selected="" className="font-mono text-[11px] text-[var(--fg-2)]">{labels.selected}</span> : null}
                {range ? (
                    <button type="button" data-range-clear onClick={() => onRange(null)} className="text-[11px] text-[var(--fg-3)] hover:text-[var(--fg-1)]">Clear range</button>
                ) : null}
            </div>

            {/*
             * The sentence, where four empty tracks would otherwise be. It appears INSTEAD of
             * the tracks, not beside them — a sentence under empty tracks would be read as a
             * caption on an accurate drawing.
             */}
            {summary.drawable && timeline ? (
                <div className="flex gap-3.5">
                <div className="flex w-14 shrink-0 flex-col gap-1">
                    {tracks.map((track) => (
                        <span key={track.lane} className="flex h-[26px] items-center text-[11px] text-[var(--fg-3)]">{LANE_LABEL[track.lane]}</span>
                    ))}
                </div>
                <div
                    ref={bar}
                    data-lanes-timeline
                    className="relative flex min-w-0 flex-1 cursor-crosshair select-none flex-col gap-1"
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
                    {/* THE FOUR TRACKS (the board): a label, then the blocks by time; the edits' blocks are the ticks (§4.2). */}
                    {tracks.map((track) => (
                        <div key={track.lane} data-lane-track={track.lane} className="flex h-[26px] items-center">
                            <div className="relative h-4 flex-1 rounded bg-[var(--bg-0)]">
                                {track.blocks.map((block) => (
                                    <span
                                        key={block.id}
                                        data-lane-block={block.id}
                                        {...(track.lane === 'edits' ? { 'data-tick': block.id } : {})}
                                        className={`absolute top-0.5 h-3 w-1 -translate-x-1/2 rounded-[3px] ${LANE_TONE[track.lane]}`}
                                        style={{ left: `${block.x * 100}%` }}
                                    />
                                ))}
                            </div>
                        </div>
                    ))}
                    {band ? (
                        <div
                            data-range-band={band.live ? 'live' : 'set'}
                            className="absolute inset-y-0 rounded border border-[var(--fg-3)] bg-[var(--fg-3)]/10"
                            style={{ left: `${band.left * 100}%`, width: `${(band.right - band.left) * 100}%` }}
                        />
                    ) : null}
                </div>
                </div>
            ) : (
                <p data-lanes-reason className="text-xs text-[var(--fg-3)]">{summary.reason}</p>
            )}

            {/* THE TIME AXIS (the board): five clocks across the span, the last `now` when it is. */}
            {labels && summary.drawable ? (
                <div className="ml-[4.375rem] flex font-mono text-[10px] text-[var(--fg-4)]">
                    {labels.axis.map((tick, i) => (
                        <span key={i} data-axis-tick={tick} className={i === labels.axis.length - 1 ? '' : 'flex-1'}>{tick}</span>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

const LANE_LABEL = { messages: 'Messages', thoughts: 'Thoughts', tools: 'Tools', edits: 'Edits' } as const;
/** The board's lane colours: the Stream's own tones. */
const LANE_TONE = { messages: 'bg-[var(--primary)]', thoughts: 'bg-[var(--violet-400)]', tools: 'bg-[var(--fg-3)]', edits: 'bg-[var(--success)]' } as const;
