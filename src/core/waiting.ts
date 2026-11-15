import { deckBand, isStale, needsYouCount, type DeckItem } from './deck.js';
import type { AgentRow } from './dashboard-view.js';

/**
 * WHAT WAITS ON THE PERSON, SEEN FROM THE AGENT'S ROW (Tynn #730, the owner's option B). The Deck is no longer a page:
 * every item that used to be a Deck row is attached to the agent it is about, as a badge on that agent's Dashboard row
 * that opens its items in place. Pure — the Dashboard (renderer/components/Dashboard.tsx) only draws this.
 *
 * - KIND: what an item is, in the one word its badge says. A tool or Genie-workflow approval is `approval`; an agent's
 *   ForceTheQuestion is `question`; a message nobody collected is `mail`; a to-do is `todo`; an item of Genie's own
 *   (the certificate, a main-process error) is `genie`; anything its agent no longer waits for is `stale` whatever it was.
 * - THE GENIE ROW: items that belong to no agent (a flow signal, a workstation item, Genie's own asks) — and items whose
 *   agent has no row on screen (gone, or hidden by the Sleeping / Stopped filters) — so nothing waiting is ever
 *   unreachable. The Deck's "earlier runs" band is the same: its items sit on their agent's row, badged stale.
 */
export type WaitingKind = 'approval' | 'question' | 'mail' | 'todo' | 'genie' | 'stale';

/** The badges' order: what blocks an agent first, what nobody waits for last. */
export const WAITING_KINDS: readonly WaitingKind[] = ['approval', 'question', 'mail', 'todo', 'genie', 'stale'];

export function waitingKind(item: DeckItem): WaitingKind {
    if (isStale(item)) return 'stale';
    switch (item.source) {
        case 'unread-dm': return 'mail';
        case 'user-list': return 'todo';
        case 'genie': return 'genie';
        case 'agent-question': return item.id.startsWith('q_') ? 'question' : 'approval';
    }
}

const WORDS: Record<WaitingKind, readonly [string, string]> = {
    approval: ['approval', 'approvals'],
    question: ['question', 'questions'],
    mail: ['mail', 'mail'],
    todo: ['to-do', 'to-dos'],
    genie: ['item', 'items'],
    stale: ['stale', 'stale'],
};

export interface WaitingBadge {
    readonly kind: WaitingKind;
    readonly count: number;
    /** `1 approval`, `2 questions`, `3 mail`, `2 stale`. */
    readonly label: string;
}

/** One badge per kind present, in `WAITING_KINDS` order. No items, no badges. */
export function waitingBadges(items: readonly DeckItem[]): readonly WaitingBadge[] {
    const counts = new Map<WaitingKind, number>();
    for (const item of items) counts.set(waitingKind(item), (counts.get(waitingKind(item)) ?? 0) + 1);
    return WAITING_KINDS.filter((kind) => counts.has(kind)).map((kind) => {
        const count = counts.get(kind)!;
        const [one, many] = WORDS[kind];
        return { kind, count, label: `${count} ${count === 1 ? one : many}` };
    });
}

export interface WaitingGroups {
    /** Each shown agent's items, in the Deck's rank (blocking, priority, oldest). Absent = nothing waits on that agent. */
    readonly byAgent: ReadonlyMap<string, readonly DeckItem[]>;
    /** The Genie row's: no agent, or an agent with no row on screen. Same rank. */
    readonly genie: readonly DeckItem[];
}

/** Attach every item to its agent's row, or to the Genie row when it has no row to sit on. */
export function groupWaiting(items: readonly DeckItem[], shownAgentIds: ReadonlySet<string>): WaitingGroups {
    const byAgent = new Map<string, DeckItem[]>();
    const genie: DeckItem[] = [];
    for (const item of deckBand(items)) {
        if (item.agentId !== null && shownAgentIds.has(item.agentId)) {
            const list = byAgent.get(item.agentId) ?? [];
            list.push(item);
            byAgent.set(item.agentId, list);
        } else genie.push(item);
    }
    return { byAgent, genie };
}

/**
 * The rows the "Needs you" filter shows: every agent with something waiting — whatever the Sleeping / Stopped filters
 * say, because an agent that needs the person is never hidden from the one view that asks for them.
 */
export function needsYouRows<T extends Pick<AgentRow, 'id'>>(rows: readonly T[], items: readonly DeckItem[]): readonly T[] {
    const waiting = new Set(items.map((item) => item.agentId).filter((id): id is string => id !== null));
    return rows.filter((row) => waiting.has(row.id));
}

/** The chip's number: what is WAITING on the person (a stale item is not), the same number as the sidebar's badge. */
export function needsYouChipCount(items: readonly DeckItem[]): number {
    return needsYouCount(items);
}
