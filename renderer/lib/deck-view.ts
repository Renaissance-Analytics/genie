/**
 * What the Deck puts on screen, as a value.
 *
 * The Deck is the surface a person trusts to answer "does anything need me", so the
 * rules here are all about honesty under absence. Two of them are the whole reason
 * this is a tested module rather than JSX:
 *
 * **A cost or context we cannot see renders as ABSENT.** Not a dash, not a zero. A
 * dash in a money column reads as "nothing spent", which is a claim, and the one
 * place to guess least. `null` here means the surface renders nothing at all and
 * lets the column header carry the footnote — the same discipline
 * `provider-brand.ts` applies to logos, where only three of twenty-one providers get
 * a mark because *"borrowing another vendor's mark would assert a relationship that
 * does not exist."*
 *
 * **An agent that believes it is working but has not moved is a THIRD state.** Not
 * "active", not "idle". It is the state the current product cannot see at all and
 * the one that wastes the most human time — and it is rendered as a FACT (how long,
 * since when) rather than a verdict, because a test suite that runs quietly for ten
 * minutes is legitimate and only the human can judge.
 */

import { AGENT_WORK_WINDOW_MS } from '../../main/terminal/agent-pulse';
import { sessionFidelity, type AgentSession, type SessionFidelity } from '../../main/agentsession/model';

/** What a roster row says the agent is doing. */
export type RosterState =
    /** A human is the bottleneck. The only state where nothing moves until you act. */
    | 'awaiting-you'
    /** Mid-turn and inside the work window. */
    | 'working'
    /** Mid-turn, and nothing has moved for the whole work window. */
    | 'stalled'
    | 'idle';

export interface RosterContext {
    used: number | null;
    max: number | null;
}

export interface RosterRow {
    agentId: string;
    specId: string | null;
    name: string;
    provider: string | null;
    workspaceId: string | null;
    state: RosterState;
    /** When the state began, so the row can say how long. */
    since: number;
    /** Is an agent STOPPED behind this? Drives order and emphasis. */
    blocking: boolean;
    fidelity: SessionFidelity;
    /** null ⇒ not visible. NEVER render a dash for this. */
    context: RosterContext | null;
    /** null ⇒ not visible. `0` is a real figure and must look different. */
    costUsd: number | null;
    error: string | null;
}

export function rosterRow(s: AgentSession, now: number): RosterRow {
    const usage = s.usage;
    // Context counts as visible only when there is a figure in it. A usage object
    // whose every member is null is the session saying "I cannot see this".
    const context =
        usage && (usage.contextUsed !== null || usage.contextMax !== null)
            ? { used: usage.contextUsed, max: usage.contextMax }
            : null;

    return {
        agentId: s.agentId,
        specId: s.specId,
        name: s.session.name,
        provider: s.session.provider,
        workspaceId: s.session.workspaceId,
        state: stateOf(s, now),
        since: s.turn.since,
        blocking: s.turn.state === 'awaiting-input' || s.turn.state === 'awaiting-approval',
        fidelity: sessionFidelity(s),
        context,
        costUsd: usage?.costUsd ?? null,
        error: s.error,
    };
}

function stateOf(s: AgentSession, now: number): RosterState {
    // Waiting on a person is never "stalled", however long it has waited. It is not
    // stuck — saying so would send somebody to debug an agent behaving perfectly.
    if (s.turn.state === 'awaiting-input' || s.turn.state === 'awaiting-approval') return 'awaiting-you';
    if (s.turn.state === 'idle') return 'idle';

    // Mid-turn. The existing decay threshold decides working vs stalled — reusing it
    // rather than inventing a second number that would drift from the rail glow's.
    return now - s.turn.since > AGENT_WORK_WINDOW_MS ? 'stalled' : 'working';
}

export interface DeckFigures {
    live: number;
    needingYou: number;
    /** null ⇒ NOTHING on the board can report a context. Not 0. */
    contextUsed: number | null;
    /** null ⇒ NOTHING on the board can report a cost. Not 0 — a board that says
     *  "$0.00 today" when it simply cannot see any cost is guessing about money. */
    costUsd: number | null;
}

export interface DeckView {
    roster: RosterRow[];
    figures: DeckFigures;
}

export function deckView(sessions: readonly AgentSession[], now: number): DeckView {
    const roster = sessions.map((s) => rosterRow(s, now));

    let contextUsed: number | null = null;
    let costUsd: number | null = null;
    for (const r of roster) {
        if (r.context?.used !== null && r.context?.used !== undefined) {
            contextUsed = (contextUsed ?? 0) + r.context.used;
        }
        if (r.costUsd !== null) costUsd = (costUsd ?? 0) + r.costUsd;
    }

    roster.sort((a, b) => {
        // Blocked first: it is the only state where the human is the bottleneck.
        if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
        // Then most-recently-changed. Alphabetical is stable and therefore dead — the
        // thing that just changed is the thing nobody has looked at.
        return b.since - a.since;
    });

    return {
        roster,
        figures: {
            // A stalled agent counts as live: its turn has not ended, and hiding it
            // from the count is how it stays invisible.
            live: roster.filter((r) => r.state === 'working' || r.state === 'stalled').length,
            needingYou: roster.filter((r) => r.blocking).length,
            contextUsed,
            costUsd,
        },
    };
}
