/**
 * IS THAT AGENT RUNNING? — the answer `agentinbox list` gives next to `reachable` (which is PERMISSION, not liveness).
 * A friction report from an agent, for the owner (2026-10-14): asked "is your slave running?" it could not say — the
 * list said only who it may message, no terminal showed the sidecar, and the one probe (`runAgent`) STARTS it. This is
 * read-only and never starts anything:
 *
 * - `working` — its session is in a turn; `idle` — its session is up, between turns;
 * - `failed` — its session reported a failure; `stopped` — no session at all;
 * - `lastSeen` — when its session last did anything (its newest ledger row), or `null` when Genie has not seen it.
 */
export type PeerState = 'working' | 'idle' | 'failed' | 'stopped';

export interface Liveness {
    readonly state: PeerState;
    readonly lastSeen: string | null;
}

export function livenessOf(session: { running: boolean; turnState: string; failure: unknown } | null, lastActivityAt: number | null): Liveness {
    const lastSeen = lastActivityAt === null ? null : new Date(lastActivityAt).toISOString();
    if (session === null || !session.running) return { state: 'stopped', lastSeen };
    if (session.failure !== null || session.turnState === 'failed') return { state: 'failed', lastSeen };
    return { state: session.turnState === 'working' ? 'working' : 'idle', lastSeen };
}
