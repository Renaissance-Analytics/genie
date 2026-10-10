import { laneSummary, type Lane } from '../../core/lanes.js';
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
}

export function Lanes({ rows, selected, onChange }: LanesProps) {
    const summary = laneSummary(rows);

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
            {summary.drawable ? (
                <div data-lanes-timeline className="h-6 rounded bg-[var(--bg-1)]" />
            ) : (
                <p data-lanes-reason className="text-xs text-[var(--fg-3)]">{summary.reason}</p>
            )}
        </div>
    );
}
