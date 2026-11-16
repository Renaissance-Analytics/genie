import type { AgentRow } from './dashboard-view.js';

/**
 * THE COLLABORATOR REVEAL (§4.1), decided without React. A focused row's peers are the agents its measured links
 * (AgentInbox, core/comms.ts) name that are ON THIS BOARD; a row with no links reveals nothing. A link is live when
 * its newest message is at most 30 s old — the same threshold as the comms dot. The reveal is egocentric and one
 * hop: the global graph is never drawn.
 */
export interface Reveal {
    readonly focus: string;
    readonly peers: Readonly<Record<string, { count: number; ageSeconds: number; live: boolean }>>;
}

const LIVE_SECONDS = 30;

export function revealOf(rows: readonly AgentRow[], focusId: string | null): Reveal | null {
    if (focusId === null) return null;
    const focus = rows.find((r) => r.id === focusId);
    const on = new Set(rows.map((r) => r.id));
    const links = (focus?.links ?? []).filter((l) => on.has(l.peer) && l.peer !== focusId);
    if (!focus || links.length === 0) return null;
    return { focus: focusId, peers: Object.fromEntries(links.map((l) => [l.peer, { count: l.count, ageSeconds: l.ageSeconds, live: l.ageSeconds <= LIVE_SECONDS }])) };
}

/** `8s`, `2m`, `3h` — a link's age in the peer's comms cell. */
export function ageLabel(seconds: number): string {
    return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
}
