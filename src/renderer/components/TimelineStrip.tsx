import { Icon } from '@particle-academy/react-fancy';
import type { RefObject } from 'react';
import type { Lane } from '../../core/lanes.js';
import type { Chip, SessionTimeline, TickKind, TimelineHead } from '../../core/session-timeline.js';
import { LANES } from '../../core/stream-view.js';

/**
 * THE SESSION TIMELINE STRIP (46px) AND THE CHIPS ROW (44px) — the board's `Agent View`, above the Stream.
 *
 * Every decision is made in `core/session-timeline.ts` and tested without a DOM; this turns the model into markup.
 * The strip's `Lanes` button opens the drawer (`L`); the chips are the lane filter, All being the clear.
 */

/** The board's tick colours: edit emerald, message blue, thought violet, tool grey — the Stream's own tones. */
const TICK: Record<TickKind, string> = { edit: 'bg-emerald-500', message: 'bg-blue-500', thought: 'bg-violet-400', tool: 'bg-[var(--fg-4)]' };
const TICK_HEIGHT: Record<TickKind, string> = { edit: 'h-5', message: 'h-3.5', thought: 'h-2', tool: 'h-1.5' };
const HEAD: Record<TimelineHead, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500' };
const LEGEND: readonly TickKind[] = ['edit', 'message', 'thought', 'tool'];

export interface TimelineStripProps {
    timeline: SessionTimeline;
    lanesOpen: boolean;
    onToggleLanes: () => void;
    /** A segment is a door to its turn's row. */
    onOpenRow: (rowId: string) => void;
    /** The other layout, as a door: the route that opens it, and its label (`Turns` from the ledger, `Ledger` from the cards). */
    layoutDoor?: { label: string; route: string } | undefined;
    onNavigate?: ((route: string) => void) | undefined;
}

export function TimelineStrip({ timeline, lanesOpen, onToggleLanes, onOpenRow, layoutDoor, onNavigate }: TimelineStripProps) {
    return (
        <div data-session-timeline="" className="flex h-[46px] shrink-0 items-center gap-3.5 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-6">
            <span className="w-14 shrink-0 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Session</span>
            <div className="relative h-7 min-w-0 flex-1">
                {timeline.segments.map((s) => (
                    <button
                        key={s.rowId}
                        type="button"
                        data-segment={s.label}
                        onClick={() => onOpenRow(s.rowId)}
                        className="absolute inset-y-0 border-l border-[var(--border-2)] text-left hover:bg-[var(--bg-2)]"
                        style={{ left: `${s.x * 100}%`, width: `${s.w * 100}%` }}
                    >
                        <span className="absolute -top-px left-1 font-mono text-[9px] text-[var(--fg-4)]">{s.label}</span>
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
                {LEGEND.map((k) => (
                    <span key={k} data-legend={k} className="flex items-center gap-1">
                        <span className={`size-1.5 rounded-[2px] ${TICK[k]}`} />
                        {k}
                    </span>
                ))}
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
    selected: readonly Lane[] | null;
    onChange: (lanes: readonly Lane[] | null) => void;
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
        onChange(next.length === 0 || next.length === LANES.length ? null : next);
    };
    return (
        <div data-chips="" className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--border-1)] px-4">
            {chips.map((chip) => (
                <button
                    key={chip.id}
                    type="button"
                    {...(chip.id === 'all' ? { 'data-chip': 'all' } : { 'data-lane': chip.id })}
                    data-on={chip.on ? 'true' : 'false'}
                    aria-pressed={chip.on}
                    onClick={() => toggle(chip)}
                    className={`flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px] ${
                        chip.on ? 'border-[var(--border-2)] bg-[var(--bg-3)] text-[var(--fg-1)]' : 'border-[var(--border-1)] text-[var(--fg-2)] hover:bg-[var(--bg-2)]'
                    }`}
                >
                    {chip.label}
                    {/* A MEASURED zero is kept: a turn with no edits genuinely has none. */}
                    <span {...(chip.id === 'all' ? {} : { 'data-lane-count': chip.n })} className="font-mono text-[10px] tabular-nums text-[var(--fg-4)]">{chip.n}</span>
                </button>
            ))}
            {/* FIND IN STREAM (the board's `Find in stream  /`): a box at the right; Escape clears it and gives the keys back. */}
            <label className="ml-auto flex h-6 items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 text-[12px] text-[var(--fg-3)] focus-within:border-[var(--border-2)]">
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
