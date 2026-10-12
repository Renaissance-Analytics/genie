import { Icon } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { ledgerRow, type TimedEvent } from '../../core/stream-view.js';
import type { TurnCard } from '../../core/turn-cards.js';
import { StreamRow } from './StreamRow.js';

/**
 * THE `turns` LAYOUT (the board): one card per turn — a header with the title, the meta line and the outcome chips,
 * and the turn's rows inside when the card is open. The latest turn arrives open; a click on a header toggles.
 * Rows are the same `StreamRow` the ledger draws, so a turn reads the same either way.
 */

const CHIP_TONE = { ok: 'text-[var(--success)]', violet: 'text-[var(--violet-400)]' } as const;

/** `14:07`, in the viewer's own locale. */
function clock(at: number | null): string | null {
    if (at === null) return null;
    return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

export interface TurnCardsProps {
    cards: readonly TurnCard[];
    rows: readonly TimedEvent[];
    agentName: string;
    selectedId: string | null;
    onSelect: (id: string) => void;
}

export function TurnCards({ cards, rows, agentName, selectedId, onSelect }: TurnCardsProps) {
    const [toggled, setToggled] = useState<ReadonlySet<number>>(new Set());
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    const isOpen = (c: TurnCard) => (toggled.has(c.n) ? !c.open : c.open);
    const toggle = (n: number) => setToggled((prev) => { const next = new Set(prev); if (next.has(n)) next.delete(n); else next.add(n); return next; });

    return (
        <div data-turn-cards="" className="flex h-full flex-col justify-end gap-2 overflow-y-auto px-4 py-3">
            {cards.map((card) => {
                const open = isOpen(card);
                const time = clock(card.at);
                return (
                    <section key={card.n} data-turn-card={card.n} data-open={open ? 'true' : 'false'} className="overflow-hidden rounded-[10px] border border-[var(--border-1)] bg-[var(--surface)]">
                        <button type="button" onClick={() => toggle(card.n)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] hover:bg-[var(--bg-1)]">
                            <Icon name={open ? 'chevron-down' : 'chevron-right'} size="sm" className="text-[var(--fg-3)]" />
                            <span className="font-semibold">{card.title}</span>
                            <span className="font-mono text-[11px] text-[var(--fg-4)]">{time ? `${time} · ${card.meta}` : card.meta}</span>
                            <span className="flex-1" />
                            {card.chips.map((chip) => (
                                <span key={chip.label} data-turn-chip={chip.icon} className="flex h-[22px] items-center gap-1.5 rounded-md bg-[var(--bg-2)] px-2 font-mono text-[11px] text-[var(--fg-2)]">
                                    <Icon name={chip.icon} size="xs" className={CHIP_TONE[chip.tone]} />
                                    {chip.label}
                                </span>
                            ))}
                        </button>
                        {open && card.rowIds.length > 0 ? (
                            <div className="border-t border-[var(--border-1)] py-1">
                                {card.rowIds.map((id) => {
                                    const row = byId.get(id);
                                    if (!row) return null;
                                    return <StreamRow key={id} row={ledgerRow(row, { agentName })} selected={id === selectedId} onSelect={onSelect} />;
                                })}
                            </div>
                        ) : null}
                    </section>
                );
            })}
        </div>
    );
}
