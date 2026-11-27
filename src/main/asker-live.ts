import type { AskerState } from '../core/deck-sources.js';
import type { AgentId } from '../core/identity.js';

/**
 * THE ASKING AGENT'S SESSION: its live session (the agent engine) or its Take Over terminal, read for every Deck item on
 * every Deck refresh. The Deck reads it only to know liveness has been heard (`undefined` = not yet): a session that ended
 * or restarted never makes a question stale, since its answer is mailed (Tynn #1085); only an agent gone from the roster does.
 */
export interface AskerLiveDeps {
    /** Not heard yet: nothing is judged (`undefined`), never "gone" or "ended". */
    readonly known: () => boolean;
    /** The engine's LIVENESS, never its probe: a probe carries the Dashboard's comms cell, a scan of the agent's mail. */
    readonly engine: () => { liveness(agentId: AgentId): { readonly running: boolean; readonly startedAt: number | null } | null } | null;
    readonly takeOvers: () => { probe(agentId: AgentId): { readonly startedAt: number } | null } | null;
}

export function askerLiveFrom(deps: AskerLiveDeps): (id: string) => AskerState | null | undefined {
    return (id) => {
        if (!deps.known()) return undefined;
        const session = deps.engine()?.liveness(id as AgentId) ?? null;
        if (session?.running) return { running: true, startedAt: session.startedAt };
        const takeOver = deps.takeOvers()?.probe(id as AgentId) ?? null;
        if (takeOver) return { running: true, startedAt: takeOver.startedAt };
        return session ? { running: false, startedAt: session.startedAt } : null;
    };
}
