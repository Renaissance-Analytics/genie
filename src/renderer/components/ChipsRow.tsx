import { Button, Icon } from '@particle-academy/react-fancy';
import type { RefObject } from 'react';
import type { StreamFilter } from '../../core/lanes.js';
import type { Chip } from '../../core/session-timeline.js';
import { FACETS, FILTERS } from '../../core/stream-view.js';

/**
 * THE CHIPS ROW (44px) — the lane filter above the Stream, All being the clear, with Find in stream at its right.
 *
 * It lived beside the SESSION timeline strip in `TimelineStrip.tsx`; the strip went in beta.64 (the agent pulse in
 * the tab row replaced it), and the chips stayed.
 */

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
                <Button size="xs" labelClassName="contents"
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
                </Button>
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
