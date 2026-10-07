import type { AgentSession } from './model';

/**
 * Declared data over the floor projection — P3's reducer.
 *
 * The plan states the rule in one line: *"declared fields win, floor fields survive where a
 * report is silent."* It was never written, and that is why the declared path was
 * disconnected end to end: `applySessionUpdate` mapped ACP's twenty `session/update` kinds
 * into an `AgentSession`, and nothing merged the result with what Genie already knew.
 *
 * ## "Silent" is the whole difficulty
 *
 * A declared field is authoritative when the agent SAID something — including when it said
 * "nothing". `plan: []` declares that there is no plan; `plan: null` is the agent never
 * having mentioned plans. The first must win over the floor; the second must not erase it.
 *
 * Two fields need more than that rule, and both for the same reason — the floor sees things
 * the agent cannot:
 *
 * - **`error`** comes from `diagnoseAgent`: a lost host, a dead transport. An agent that is
 *   fine from the inside must not clear a failure observed from the outside.
 * - **`approvals`** are UNIONED. A pending ForceTheQuestion and a mid-turn tool permission
 *   come from different places and both block a human; treating them as alternatives would
 *   hide one.
 *
 * And `turn` is special in the other direction: `emptyAgentSession` starts at `idle`, so a
 * freshly-connected session reports idle before the agent has said anything. Letting that
 * overwrite a floor state of `thinking` would report working agents as idle — and
 * `agentinbox/wake.ts` reads idle as "safe to deliver mail into".
 */

/** A declared value counts when it is not null/undefined — `[]` is a declaration. */
const said = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;

export function mergeDeclared(
    floor: AgentSession,
    declared: AgentSession | null | undefined,
): AgentSession {
    // Every pty agent takes this path, which is most of them.
    if (!declared) return floor;

    return {
        // Genie's identity, not the agent's to rename. The declared side knows a provider
        // and a cwd; the floor side owns the agent record.
        agentId: floor.agentId,
        specId: floor.specId,
        session: {
            ...floor.session,
            // The one identity field only the declared side has.
            sessionId: declared.session.sessionId ?? floor.session.sessionId,
        },

        // A declared turn wins unless it is still the untouched default. See the note above
        // on why an unspoken `idle` must not overwrite an observed `thinking`.
        turn:
            declared.turn.state === 'idle' && floor.turn.state !== 'idle'
                ? floor.turn
                : declared.turn,

        // A real conversation replaces projected mail; an empty one leaves it, so a session
        // that has connected but not spoken does not go blank.
        transcript: declared.transcript.length > 0 ? declared.transcript : floor.transcript,

        // Declared-only and streaming. The floor sets neither (measured: zero assignments),
        // so the declared value is simply the value — including `[]`, which says the agent
        // is running no tools rather than that we cannot see any.
        live: declared.live,
        tools: declared.tools,

        // Declared-only fields: the floor never sets any of these, so `said` is the whole
        // rule and an empty declared value is still a declaration.
        // Declared-only, like the rest: a pty agent never reports a rate limit, so the floor
        // has nothing to defend here. The REASON survives the same way — an explanation for
        // an absent gauge is still information.
        rateLimit: said(declared.rateLimit) ? declared.rateLimit : floor.rateLimit,
        rateLimitUnavailable: said(declared.rateLimitUnavailable)
            ? declared.rateLimitUnavailable
            : floor.rateLimitUnavailable,

        composer: said(declared.composer) ? declared.composer : floor.composer,
        plan: said(declared.plan) ? declared.plan : floor.plan,
        usage: said(declared.usage) ? declared.usage : floor.usage,
        commands: said(declared.commands) ? declared.commands : floor.commands,

        // Unioned, not replaced — both block, and they come from different places. Declared
        // first: a mid-turn permission is what the agent is parked on right now.
        approvals: [...declared.approvals, ...floor.approvals],

        // The agent may clear an error it reported itself, but may not clear one observed
        // from outside.
        error: said(declared.error) ? declared.error : floor.error,
    };
}
