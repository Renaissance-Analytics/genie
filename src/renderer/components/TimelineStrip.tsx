import { Icon } from '@particle-academy/react-fancy';
import type { RefObject } from 'react';
import type { StreamFilter } from '../../core/lanes.js';
import type { Chip, SessionTimeline, TickKind, TimelineHead } from '../../core/session-timeline.js';
import { FACETS, FILTERS, type StreamFilter as LaneFilter } from '../../core/stream-view.js';

/**
 * THE SESSION TIMELINE STRIP (46px) AND THE CHIPS ROW (44px) — the board's `Agent View`, above the Stream.
 *
 * Every decision is made in `core/session-timeline.ts` and tested without a DOM; this turns the model into markup.
 * The strip's `Lanes` button opens the drawer (`L`); the chips are the lane filter, All being the clear.
 */

/** The board's tick colours: edit emerald, message blue, thought violet, tool grey — the Stream's own tones. */
const TICK: Record<TickKind, string> = { edit: 'bg-[var(--success)]', message: 'bg-[var(--primary)]', thought: 'bg-[var(--violet-400)]', tool: 'bg-[var(--fg-4)]' };
const TICK_HEIGHT: Record<TickKind, string> = { edit: 'h-5', message: 'h-3.5', thought: 'h-2', tool: 'h-1.5' };
const HEAD: Record<TimelineHead, string> = { ok: 'bg-[var(--success)]', warn: 'bg-[var(--warning)]', bad: 'bg-[var(--danger)]' };
// The activity's kinds: replies live in the chat, so the strip carries no message ticks and no message legend.
const LEGEND = ['edit', 'thought', 'tool'] as const;
/** The Stream lane each legend entry shows. */
const LEGEND_LANE: Record<(typeof LEGEND)[number], LaneFilter> = { edit: 'edits', thought: 'thoughts', tool: 'tools' };

export interface TimelineStripProps {
    timeline: SessionTimeline;
    lanesOpen: boolean;
    onToggleLanes: () => void;
    /** A segment is a door to its turn's row. */
    onOpenRow: (rowId: string) => void;
    /** The other layout, as a door: the route that opens it, and its label (`Turns` from the ledger, `Ledger` from the cards). */
    layoutDoor?: { label: string; route: string } | undefined;
    onNavigate?: ((route: string) => void) | undefined;
    /** `Next edit`: what `E` does — open the next edit after the one open. */
    onNextEdit?: (() => void) | undefined;
    /** The Stream's lane filter (`null`: everything) and its change — a legend entry shows only its kind. */
    filter?: readonly LaneFilter[] | null | undefined;
    onFilter?: ((next: readonly LaneFilter[] | null) => void) | undefined;
}

export function TimelineStrip({ timeline, lanesOpen, onToggleLanes, onOpenRow, layoutDoor, onNavigate, onNextEdit, filter = null, onFilter }: TimelineStripProps) {
    return (
        <div data-session-timeline="" className="flex h-[46px] shrink-0 items-center gap-3.5 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-6">
            <span className="w-14 shrink-0 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Session</span>
            <div className="relative h-7 min-w-0 flex-1">
                {timeline.segments.map((s) => (
                    <button
                        key={s.rowId}
                        type="button"
                        data-segment={s.label}
                        title={`Turn ${s.n}`}
                        aria-label={`Turn ${s.n}`}
                        onClick={() => onOpenRow(s.rowId)}
                        className="absolute inset-y-0 border-l border-[var(--border-2)] text-left hover:bg-[var(--bg-2)]"
                        style={{ left: `${s.x * 100}%`, width: `${s.w * 100}%` }}
                    >
                        {/* A label only where there is room (session-timeline.ts LABEL_GAP); the title names every turn. */}
                        {s.showLabel ? <span data-segment-label="" className="absolute -top-0.5 left-1 whitespace-nowrap font-mono text-[11px] text-[var(--fg-3)]">{s.label}</span> : null}
                    </button>
                ))}
                {timeline.ticks.map((k) => (
                    <span
                        key={k.id}
                        data-tick-kind={k.kind}
                        className={`absolute bottom-0.5 w-0.5 rounded-[1px] ${TICK[k.kind]} ${TICK_HEIGHT[k.kind]}`}
                        style={{ left: `${k.x * 100}%` }}
                    />
                ))}
                {timeline.head ? <span data-head={timeline.head} className={`absolute bottom-0 right-0 top-1 w-0.5 ${HEAD[timeline.head]}`} /> : null}
            </div>
            <div className="flex shrink-0 gap-2.5 text-[11px] text-[var(--fg-3)]">
                {/* Each kind is a button: the Stream shows only that kind; pressed again, everything. */}
                {LEGEND.map((k) => {
                    const lane = LEGEND_LANE[k];
                    const on = filter !== null && filter.includes(lane);
                    return (
                        <button
                            key={k}
                            type="button"
                            data-legend={k}
                            aria-pressed={on}
                            title={on ? 'Show everything' : `Show only ${lane}`}
                            onClick={() => onFilter?.(filter !== null && filter.length === 1 && filter[0] === lane ? null : [lane])}
                            className={`flex items-center gap-1 rounded px-1 ${on ? 'bg-[var(--bg-3)] text-[var(--fg-1)]' : 'hover:bg-[var(--bg-2)]'}`}
                        >
                            <span className={`size-1.5 rounded-[2px] ${TICK[k]}`} />
                            {k}
                        </button>
                    );
                })}
                {/* NEXT EDIT (§4.2 `E`), a button: only when there is an edit to go to — a button that would do nothing is not drawn. */}
                {timeline.ticks.some((k) => k.kind === 'edit') ? (
                    <button type="button" data-action="next-edit" title="Next edit (E)" onClick={() => onNextEdit?.()} className="flex items-center gap-1 rounded px-1 hover:bg-[var(--bg-2)]">
                        Next edit
                        <kbd className="font-mono text-[10px] text-[var(--fg-4)]">E</kbd>
                    </button>
                ) : null}
            </div>
            {layoutDoor ? (
                <button
                    type="button"
                    data-action="toggle-layout"
                    data-nav={layoutDoor.route}
                    title="Switch the Stream's layout"
                    onClick={() => onNavigate?.(layoutDoor.route)}
                    className="flex h-[26px] shrink-0 items-center rounded-md border border-[var(--border-1)] px-2.5 text-[12px] text-[var(--fg-1)] hover:bg-[var(--bg-2)]"
                >
                    {layoutDoor.label}
                </button>
            ) : null}
            <button
                type="button"
                data-action="toggle-lanes"
                aria-pressed={lanesOpen}
                title="Toggle lanes (L)"
                onClick={onToggleLanes}
                className={`flex h-[26px] shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-1)] pl-2.5 pr-2 text-[12px] text-[var(--fg-1)] ${lanesOpen ? 'bg-[var(--bg-3)]' : 'hover:bg-[var(--bg-2)]'}`}
            >
                Lanes
                <Icon name={lanesOpen ? 'chevron-up' : 'chevron-down'} size="xs" className="text-[var(--fg-3)]" />
            </button>
        </div>
    );
}

export interface ChipsRowProps {
    chips: readonly Chip[];
    selected: readonly StreamFilter[] | null;
    onChange: (lanes: readonly StreamFilter[] | null) => void;
    /** Find in stream (`/`): the query, its box (focused by the key), and the match count while a query is set. */
    find?: string | undefined;
    onFind?: ((query: string) => void) | undefined;
    findRef?: RefObject<HTMLInputElement | null> | undefined;
    matches?: number | null | undefined;
}

export function ChipsRow({ chips, selected, onChange, find = '', onFind, findRef, matches = null }: ChipsRowProps) {
    const toggle = (chip: Chip): void => {
        if (chip.id === 'all') { onChange(null); return; }
        const lane = chip.id;
        // From "not filtering", the first click means "only this lane". Back to every lane is no filter.
        if (selected === null) { onChange([lane]); return; }
        const next = selected.includes(lane) ? selected.filter((l) => l !== lane) : [...selected, lane];
        onChange(next.length === 0 || next.length === FILTERS.length ? null : next);
    };
    return (
        <div data-chips="" className="flex h-11 min-w-0 shrink-0 items-center gap-1.5 border-b border-[var(--border-1)] px-4">
            {/*
             * The chips SCROLL sideways in their own lane when the column is narrow; the find box never moves out of
             * view (the owner, 2026-10-14: it ran under the right column and was cut off).
             */}
            <div data-chip-lane="" className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
            {chips.map((chip) => (
                <button
                    key={chip.id}
                    type="button"
                    {...(chip.id === 'all' ? { 'data-chip': 'all' } : (FACETS as readonly string[]).includes(chip.id) ? { 'data-facet': chip.id } : { 'data-lane': chip.id })}
                    data-on={chip.on ? 'true' : 'false'}
                    aria-pressed={chip.on}
                    onClick={() => toggle(chip)}
                    className={`flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] ${
                        chip.on ? 'border-[var(--border-2)] bg-[var(--bg-3)] text-[var(--fg-1)]' : 'border-[var(--border-1)] text-[var(--fg-2)] hover:bg-[var(--bg-2)]'
                    }`}
                >
                    {chip.label}
                    {/* A MEASURED zero is kept: a turn with no edits genuinely has none. */}
                    <span {...(chip.id === 'all' ? {} : (FACETS as readonly string[]).includes(chip.id) ? { 'data-facet-count': chip.n } : { 'data-lane-count': chip.n })} className="font-mono text-[10px] tabular-nums text-[var(--fg-4)]">{chip.n}</span>
                </button>
            ))}
            </div>
            {/* FIND IN STREAM (the board's `Find in stream  /`): a box at the right; Escape clears it and gives the keys back. */}
            <label data-find-box="" className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 text-[12px] text-[var(--fg-3)] focus-within:border-[var(--border-2)]">
                <Icon name="search" size="xs" />
                <input
                    ref={findRef}
                    data-find=""
                    value={find}
                    placeholder="Find in stream"
                    onChange={(e) => onFind?.(e.currentTarget.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onFind?.(''); e.currentTarget.blur(); } }}
                    className="w-36 bg-transparent text-[12px] text-[var(--fg-1)] outline-none placeholder:text-[var(--fg-4)]"
                />
                {matches !== null ? <span data-find-count={matches} className="font-mono text-[10px] tabular-nums text-[var(--fg-4)]">{matches}</span> : <span className="font-mono text-[10px] text-[var(--fg-4)]">/</span>}
            </label>
        </div>
    );
}
