import type { Approval } from './approval.js';
import type { AgentRow, Delivery } from './dashboard-view.js';
import type { AgentRecord } from './identity.js';
import type { TurnState } from './session.js';

/**
 * RECORD + LIVE SESSION → DASHBOARD ROW.
 *
 * The one place "what Genie knows" becomes "what the board claims", which makes it the one
 * place the `null` discipline can be lost wholesale. A single `?? 0` here turns *we have not
 * heard* into *we looked and it was none*, across every row, and the surface has no way to
 * tell afterwards.
 *
 * ## The failure this file is shaped around
 *
 * §0.4. `sessionFidelity()` returned `observed` for every agent, because no declared field was
 * ever populated — so every agent rendered `Activity | Files | Changes` and the finished
 * Conversation UI was unreachable for three releases. **One mapping function, one wrong
 * default, and every test of the hidden feature stayed green.**
 *
 * So fidelity here is derived from the record's provider, which is a fact about whether the
 * thing speaks ACP, and `test/roster.test.ts` asserts it from a real record for every provider
 * Genie can register — counted, not spot-checked.
 */

/**
 * What a live session can tell the board.
 *
 * Deliberately a plain data interface rather than `AgentSession` itself: the mapping is pure
 * and testable, and the adapter that reads a real session is the only thing that has to know
 * about drivers. Every nullable field means **Genie has not been told**, never zero.
 */
export interface LiveSession {
    running: boolean;
    turnState: TurnState;
    /** Epoch ms. `null` when the session never recorded a start. */
    startedAt: number | null;
    /**
     * The approval waiting on a human, or `null`. Its presence is what makes a row `waiting`.
     *
     * The whole approval rather than just its question text, because the row is not the only
     * reader: the Deck and the composer need the OPTIONS, and deriving the question here while
     * carrying the options separately would be two copies of one fact.
     */
    pendingApproval: Approval | null;
    /** A reported failure and the routes out of it. `null` is not a fault — see below. */
    failure: { reason: string; fixes: readonly string[] } | null;
    contextUsed: number | null;
    contextSize: number | null;
    lastDelivery: Delivery | null;
    collaborators: number | null;
    commsAgeSeconds: number | null;
    /** The agent's own plan, when it reports one. */
    plan: { step: number; of: number; doing: string } | null;
}

/**
 * `Working 12m` / `Idle 42m`, or nothing.
 *
 * Under a minute there is no useful number and `0m` reads as a stalled agent, so it is absent
 * — the same rule as everywhere else: a measurement or nothing.
 */
function durationOf(startedAt: number | null, now: number): string | null {
    if (startedAt === null) return null;

    const minutes = Math.floor((now - startedAt) / 60_000);
    if (minutes < 1) return null;
    if (minutes < 60) return `${minutes}m`;

    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * The row for one agent.
 *
 * The state ladder, in the order it is decided and for the reasons it is decided that way:
 *
 *  1. **A parked question wins.** It is the only state where the human is the bottleneck.
 *  2. **A reported failure is `broken`.** Only a *reported* one — see 4.
 *  3. **`working` requires the protocol to have said so.** `turnState: 'unknown'` means it has
 *     not, and rendering `Working` there would be Genie asserting activity it cannot see,
 *     which is the one thing it must never do.
 *  4. **Everything else is `idle`.** A session that simply ended is idle, not broken: painting
 *     a stopped agent red is how a board learns to cry wolf, and then nobody reads the reds.
 */
export function agentRowFor(
    record: AgentRecord,
    session: LiveSession | null,
    clock: () => number,
): AgentRow {
    const now = clock();

    // Declared because the provider speaks ACP. `observed` belongs to a Take Over window,
    // which Genie does not manage and does not register, and `remote` to another workstation.
    const fidelity = 'declared' as const;

    const state: AgentRow['state'] =
        session === null ? 'idle'
        : session.pendingApproval !== null ? 'waiting'
        : session.failure !== null ? 'broken'
        : session.running && session.turnState === 'working' ? 'working'
        : 'idle';

    return {
        // Byte-identical to the record's id, which is the id the session store is keyed by.
        // An id split here is invisible: the UI looks up a session keyed by something else and
        // renders an empty one forever.
        id: record.id,
        name: record.name,
        provider: record.provider,
        workspaceId: record.workspaceId,
        fidelity,
        state,
        // A duration belongs to a state that is actually running. A `working` row's elapsed
        // time is a fact; an idle row's would be the age of a session that is no longer doing
        // anything with it.
        duration: state === 'working' ? durationOf(session?.startedAt ?? null, now) : null,
        ask: session?.pendingApproval?.question ?? null,
        reason: session?.failure?.reason ?? null,
        fixes: session?.failure?.fixes ?? [],
        step: session?.plan ? `${session.plan.step}/${session.plan.of}` : null,
        target: session?.plan?.doing ?? null,
        // Byte activity, and only for an observed agent. A declared one reports a plan, so
        // there is nothing to measure and nothing to draw.
        activity: null,
        delivery: session?.lastDelivery ?? null,
        collaborators: session?.collaborators ?? null,
        commsAgeSeconds: session?.commsAgeSeconds ?? null,
        contextUsed: session?.contextUsed ?? null,
        contextSize: session?.contextSize ?? null,
    };
}
