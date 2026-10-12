import { VirtualList } from '@particle-academy/react-fancy';
import { useEffect, useMemo, useState } from 'react';
import {
    editLineCounts,
    ledgerRow,
    resolveThinkTokens,
    resolveToolDurations,
    visibleRows,
    type Lane,
    type TimedEvent,
} from '../../core/stream-view.js';
import { StreamRow } from './StreamRow.js';

/**
 * THE STREAM — a windowed ledger.
 *
 * `VirtualList` does the hard parts: only the visible slice is in the DOM, row heights are
 * **measured** rather than predicted, `scrollToId` resolves a deep link, and tail-following
 * sticks to the bottom as rows arrive.
 *
 * ## The deep-link trap, measured by the component's author
 *
 * A pending `scrollToId` wins over `followTail` *while it resolves* — but if `followTail` is
 * still `true` when the link lands, the list resumes following and carries the reader straight
 * back to the bottom. So **arriving with `?at=` starts with following OFF**, which is also the
 * only sensible reading of the intent: a link to one event is a request to look at that event.
 *
 * ## Tail-follow breaks on INTENT, not on position
 *
 * Any upward gesture stops it immediately, even while the list is still pinned to the bottom.
 * Position cannot tell "the human scrolled up" from "content grew downward", so a
 * position-only implementation follows through a wheel-up and then yanks the reader back on
 * the next append. `VirtualList` handles that; this component only has to honour
 * `onFollowChange` by actually updating its state — until it does, nothing changes.
 */

export interface StreamProps {
    rows: readonly TimedEvent[];
    /** `null` = not filtering, which is a different state from filtering to nothing. */
    lanes: readonly Lane[] | null;
    /** The `?at=` anchor from the route. */
    at: string | null;
    selectedId: string | null;
    onSelect: (id: string) => void;
    /** Diffs, keyed by row id. Absent = computed here from each edit's own old/new strings (`editLineCounts`); a call that carried none gets no counts — never a `+0 −0`. */
    diffs?: ReadonlyMap<string, { plus: number; minus: number; newFile: boolean }> | undefined;
    /** The agent's name, for its message rows' speaker label. */
    agentName?: string | undefined;
    /** The empty state's actions (the board): `Message <agent> ⌘J` and `Edit <persona>`; absent = no button. */
    persona?: string | null | undefined;
    onChat?: (() => void) | undefined;
    onEditPersona?: (() => void) | undefined;
    /** The find query (`/`), already applied to `rows` by the caller; here so an empty result can say which nothing it is. */
    findQuery?: string | undefined;
}

/**
 * Whether to tail-follow on arrival.
 *
 * Its own function so the rule is testable and stated once: **a deep link turns following
 * off.** See the note above — this is the difference between landing on the event somebody
 * sent you and being dragged to the bottom a moment later.
 */
export function initialFollowTail(at: string | null): boolean {
    return at === null;
}

export function Stream({ rows, lanes, at, selectedId, onSelect, diffs, agentName, persona = null, onChat, onEditPersona, findQuery = '' }: StreamProps) {
    const [following, setFollowing] = useState(() => initialFollowTail(at));
    const [unseen, setUnseen] = useState(0);

    // A deep link arriving later — an agent sends one mid-turn — must stop following too.
    useEffect(() => {
        if (at !== null) setFollowing(false);
    }, [at]);

    const prepared = useMemo(() => {
        // Token deltas and durations are computed over the WHOLE stream, then the filter is
        // applied. Computing them after filtering would attribute a thought's cost from
        // whichever usage rows happened to survive the lane selection — a number that changes
        // when you change the view, which is the definition of a figure not worth printing.
        const withTokens = resolveThinkTokens(rows);
        const durations = resolveToolDurations(withTokens);
        const visible = visibleRows(withTokens, lanes);

        return visible.map((row) => {
            const context =
                row.event.kind === 'tool'
                    ? {
                          durationMs: durations.get(row.event.toolCallId),
                          // A real diff: given, or counted from the edit's own old/new strings. Never estimated.
                          diff: diffs?.get(row.id) ?? (row.event.toolKind === 'edit' ? editLineCounts(row.event.rawInput) ?? undefined : undefined),
                          agentName,
                      }
                    : { agentName };
            return ledgerRow(row, context);
        });
    }, [rows, lanes, diffs, agentName]);

    /**
     * The empty state.
     *
     * Stream is ALWAYS present for a declared agent and is never gated on anything. With no
     * events it says so and the composer stays — it does not hide. §0.4 is a finished UI that
     * was unreachable because one condition decided it should not render.
     *
     * The sentence distinguishes the two cases a blank panel would merge: an agent that has
     * not been asked anything yet, and a lane filter that excludes everything.
     */
    // A find that matches nothing leaves only the structure rows; the reader asked a question and gets its answer.
    if (findQuery.trim() !== '' && !prepared.some((r) => r.kind !== 'turn' && r.kind !== 'compacted')) {
        return (
            <div data-stream="empty" data-find-empty="" className="flex h-full items-center justify-center px-8 text-center text-[13px] text-[var(--fg-3)]">
                Nothing says “{findQuery.trim()}”. Clear the find to see the whole turn.
            </div>
        );
    }

    if (prepared.length === 0) {
        const filtered = rows.length > 0;
        if (filtered) {
            return (
                <div data-stream="empty" className="flex h-full items-center justify-center px-8 text-center text-[13px] text-[var(--fg-3)]">
                    No events in the selected lanes. Clear the filter to see the whole turn.
                </div>
            );
        }
        // The board's empty state: a heading, the sentence, `Message <agent> ⌘J` as the primary action, `Edit <persona>`.
        return (
            <div data-stream="empty" className="flex h-full flex-col items-start justify-center gap-2 px-12 text-[13px] text-[var(--fg-3)]">
                <div className="text-[15px] font-semibold text-[var(--fg-1)]">No events yet</div>
                <p className="max-w-[420px] leading-normal">Nothing has happened in this session. Send {agentName ?? 'the agent'} a message and the ledger fills in, one line per event.</p>
                {onChat || (persona && onEditPersona) ? (
                    <div className="mt-1 flex items-center gap-2">
                        {onChat ? (
                            <button type="button" data-action="chat" onClick={onChat} className="flex items-center gap-1.5 rounded-lg border border-blue-600 bg-blue-500 px-3 py-1 text-[12px] font-medium text-white hover:bg-blue-600">
                                Message {agentName ?? 'the agent'}
                                <span className="font-mono text-[10px] opacity-80">⌘J</span>
                            </button>
                        ) : null}
                        {persona && onEditPersona ? (
                            <button type="button" data-action="edit-persona" onClick={onEditPersona} className="rounded-lg border border-[var(--border-1)] px-3 py-1 text-[12px] text-[var(--fg-1)] hover:bg-[var(--bg-2)]">
                                Edit <span className="font-mono">{persona}</span>
                            </button>
                        ) : null}
                    </div>
                ) : null}
            </div>
        );
    }

    return (
        <div data-stream="rows" className="relative h-full">
            <VirtualList
                items={prepared}
                height="100%"
                // Seeded from the COMMON row, not the average: a one-line event row. Messages
                // wrap and are taller, and their real heights replace the estimate the moment
                // they are on screen.
                estimateRowHeight={28}
                followTail={following}
                onFollowChange={setFollowing}
                onUnseenChange={setUnseen}
                scrollToId={at}
                renderRow={(row) => (
                    <StreamRow row={row} selected={row.id === selectedId} onSelect={onSelect} />
                )}
            />

            {/*
             * The `↓ n new` pill is ours to render, from `onUnseenChange`. It appears only
             * when both are true: the reader has scrolled away AND something arrived. A pill
             * reading `↓ 0 new` would be furniture.
             */}
            {!following && unseen > 0 ? (
                <button
                    type="button"
                    data-unseen={unseen}
                    onClick={() => setFollowing(true)}
                    className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-lg border border-[var(--border-2)] bg-[var(--surface-raised)] px-3 py-1 text-xs shadow-md"
                >
                    ↓ {unseen} new
                </button>
            ) : null}
        </div>
    );
}
