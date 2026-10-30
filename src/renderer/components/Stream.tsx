import { Icon, VirtualList } from '@particle-academy/react-fancy';
import { countRender } from '../render-count.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STREAM_LIVE_ROWS, StreamPrep } from '../../core/stream-prep.js';
import {
    LedgerRowCache,
    visibleRows,
    type StreamFilter,
    type TimedEvent,
} from '../../core/stream-view.js';
import { StreamRow, type StreamMarkup } from './StreamRow.js';

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
    lanes: readonly StreamFilter[] | null;
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
    /**
     * The turn is RUNNING (the session reports `working`). Then the last row, when it is a thought, is the thought
     * still arriving — the board's live `Thinking…` row with its pulsing bar. Off by default: a replayed thread's last
     * thought is finished, and a bar pulsing on it would claim an agent is thinking that is not.
     */
    live?: boolean | undefined;
    /** The parked divider's words (`turn parked · waiting on you 0:42`) while an approval waits; `null` otherwise. */
    parked?: string | null | undefined;
    /** The stream cursor (`j`/`k`): the row it is on, or null. A focus, not the selection. */
    cursorId?: string | null | undefined;
    /** What an agent message's pills may open, and the opener for a person's click (genie#1263). Absent = words only. */
    markup?: StreamMarkup | undefined;
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

export function Stream({ rows, lanes, at, selectedId, onSelect, diffs, agentName, persona = null, onChat, onEditPersona, findQuery = '', live = false, parked = null, cursorId = null, markup }: StreamProps) {
    countRender('Stream');
    const [following, setFollowing] = useState(() => initialFollowTail(at));
    const [unseen, setUnseen] = useState(0);
    // Thoughts opened to their whole reasoning, by row id.
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    // Stable, so a memoised row is not drawn again for a new callback (genie#1340).
    const toggle = useCallback((id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
    // A row the push did not change keeps its mapped object (core/stream-view.ts LedgerRowCache): it is not drawn again.
    const rowCache = useRef<LedgerRowCache | null>(null);
    rowCache.current ??= new LedgerRowCache();

    // A deep link arriving later — an agent sends one mid-turn — must stop following too.
    useEffect(() => {
        if (at !== null) setFollowing(false);
    }, [at]);

    /**
     * NEVER THE WHOLE LEDGER PER PUSH (the owner, 2026-10-22). `StreamPrep` folds only the rows a push adds
     * (core/stream-prep.ts), and Following Live the list holds the last STREAM_LIVE_ROWS activity rows; the rows behind
     * them page in from the control above the list. Parked, the window holds still (new rows arrive below without moving
     * what is on screen); back at the end it is the live 500 again. A deep link gets the whole stream.
     */
    const prepRef = useRef<StreamPrep | null>(null);
    prepRef.current ??= new StreamPrep();
    const [extra, setExtra] = useState(0);
    const parkedStart = useRef<number | null>(null);
    useEffect(() => { if (following) { setExtra(0); parkedStart.current = null; } }, [following]);

    const view = useMemo(() => {
        // Token deltas and durations are computed over the WHOLE stream, then the filter is
        // applied. Computing them after filtering would attribute a thought's cost from
        // whichever usage rows happened to survive the lane selection — a number that changes
        // when you change the view, which is the definition of a figure not worth printing.
        // The activity: replies live in the chat, debug notices are not rows (`activityRows`).
        // The same as activityRows → resolveThinkTokens → resolveTurnCosts, resolveToolDurations over every frame (BEFORE
        // the updates fold into their call), and each compaction's summarised turns over the WHOLE stream — as a fold.
        const { rows: withTokens, durations, summarised } = prepRef.current!.update(rows);
        const all = visibleRows(withTokens, lanes);
        // Following Live: the last STREAM_LIVE_ROWS (+ pages asked for). Parked: where it was. A deep link: everything.
        const liveStart = Math.max(0, all.length - STREAM_LIVE_ROWS - extra);
        const start = at !== null ? 0 : following ? liveStart : Math.min(parkedStart.current ??= liveStart, liveStart);
        const visible = start === 0 ? all : all.slice(start);

        const mapped = visible.map((row) => {
            const context =
                row.event.kind === 'tool'
                    ? {
                          durationMs: durations.get(row.event.toolCallId),
                          // A real diff: given, or counted from the edit's own old/new strings (by the cache, once per
                          // edit). Never estimated.
                          diff: diffs?.get(row.id),
                          agentName,
                      }
                    : row.event.kind === 'divider'
                      ? { summarisedTurns: summarised.get(row.id), agentName }
                      : { agentName };
            return rowCache.current!.row(row, context);
        });
        return { rows: mapped, behind: start };
    }, [rows, lanes, diffs, agentName, at, following, extra]);
    const prepared = view.rows;

    // The live thought: the LAST row of the whole stream (not of the filtered view) while the turn runs.
    const last = rows.at(-1);
    const liveId = live && last && last.event.kind === 'think' ? last.id : null;
    // The agent's words still arriving, the same way: drawn progressively (react-fancy 5.68), every other prose row whole.
    const arrivingId = live && last && last.event.kind === 'message' && last.event.speaker === 'agent' ? last.id : null;

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
                            <button type="button" data-action="chat" onClick={onChat} className="flex items-center gap-1.5 rounded-lg border border-[var(--primary-hover)] bg-[var(--primary)] px-3 py-1 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)]">
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
        <div data-stream="rows" className="flex h-full flex-col">
            {view.behind > 0 ? (
                <button type="button" data-stream-earlier={view.behind} onClick={() => { parkedStart.current = Math.max(0, view.behind - STREAM_LIVE_ROWS); setExtra((n) => n + STREAM_LIVE_ROWS); }} className="shrink-0 self-center py-1 font-mono text-[11px] text-[var(--fg-3)] hover:text-[var(--fg-1)]">
                    {view.behind.toLocaleString('en-US')} earlier {view.behind === 1 ? 'row' : 'rows'} · show more
                </button>
            ) : null}
            <div className="relative min-h-0 flex-1">
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
                    <StreamRow row={row} selected={row.id === selectedId} live={row.id === liveId} streaming={row.id === arrivingId} cursor={row.id === cursorId} expanded={expanded.has(row.id)} onToggle={toggle} onSelect={onSelect} markup={markup} />
                )}
            />

            {/* THE PARKED DIVIDER: amber, at the end, as long as the request waits — state, not a row, so no filter hides it. */}
            {parked ? (
                <div data-divider="parked" className="absolute inset-x-0 bottom-0 flex h-7 items-center gap-2 border-t border-[var(--warning)] bg-[var(--surface)] px-5 font-mono text-[11px] text-[var(--warning)]">
                    <Icon name="pause" size="xs" />
                    {parked}
                </div>
            ) : null}
            </div>

            {/*
             * The `↓ n new` pill is ours to render, from `onUnseenChange`. It appears only
             * when both are true: the reader has scrolled away AND something arrived. A pill
             * reading `↓ 0 new` would be furniture.
             */}
            {/*
             * THE FOLLOW PILL: `Following live` while the ledger tails its own end; `Parked` once the reader scrolled
             * away or arrived by a deep link — with `↓ n new` while rows arrive meanwhile — and the parked pill is the
             * door back to the tail. It lives in the STATUS BAR under the stream, never over it (the owner, 2026-10-14:
             * floating bottom-right it covered the newest row's text and the scrollbar).
             */}
            <div data-stream-status="" className="flex h-7 shrink-0 items-center justify-end gap-2 border-t border-[var(--border-1)] bg-[var(--surface)] px-3">
            {following ? (
                <span data-follow="live" className="rounded-full border border-[var(--border-1)] bg-[var(--surface-raised)] px-2.5 py-0.5 font-mono text-[10px] text-[var(--fg-4)]">Following live</span>
            ) : (
                <button
                    type="button"
                    data-follow="parked"
                    {...(unseen > 0 ? { 'data-unseen': unseen } : {})}
                    onClick={() => setFollowing(true)}
                    className="rounded-full border border-[var(--border-2)] bg-[var(--surface-raised)] px-2.5 py-0.5 font-mono text-[10px] text-[var(--fg-2)] shadow-md hover:bg-[var(--bg-2)]"
                >
                    Parked{unseen > 0 ? ` · ↓ ${unseen} new` : ''}
                </button>
            )}
            </div>
        </div>
    );
}
