import type { DeckItem } from './deck.js';

/**
 * AN ELEVATION WAITING FOR A WINDOW (the host split, P5a). genie-host runs Genie's hosting with or without a window, but
 * it never raises an OS prompt (the hosts file, the trust store) on its own: with no window connected, a privileged
 * step it needs is held, answered "waiting for a window", and the next window is told by this Deck item. Approving it
 * runs the hosts sync again from that window — the one privileged step the host can need with no one asking.
 */
export const ELEVATION_WAITING_DECK_ID = 'genie:elevation-waiting';

/** The prefix every "held for a window" answer starts with, so whoever reads it can tell it from a declined prompt. */
export const WAITING_FOR_A_WINDOW = 'waiting for a window';

export function elevationWaitingDeckItem(labels: readonly string[], at: number): DeckItem | null {
    if (labels.length === 0) return null;
    return {
        id: ELEVATION_WAITING_DECK_ID,
        source: 'genie',
        agentId: null,
        agentName: null,
        workspaceId: null,
        title: `Genie needs your approval to ${labels.join(' and ')} — it waited for a window to ask`,
        blocking: false,
        priority: 'normal',
        at,
        answer: { kind: 'inline', options: [{ id: 'approve', label: 'Approve now', tone: 'ok' }] },
        forwardedFrom: null,
    };
}
