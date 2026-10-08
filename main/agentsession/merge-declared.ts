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
 * Three fields need more than that rule, and all for the same reason — the floor sees things
 * the agent cannot:
 *
 * - **`error`** comes from `diagnoseAgent`: a lost host, a dead transport. An agent that is
 *   fine from the inside must not clear a failure observed from the outside.
 * - **`approvals`** are UNIONED. A pending ForceTheQuestion and a mid-turn tool permission
 *   come from different places and both block a human; treating them as alternatives would
 *   hide one.
 * - **`transcript`** is INTERLEAVED, because a measured ACP session reports the agent's voice
 *   and nothing else — no echo of the owner's prompt, and no replay on resume. The human half
 *   of the conversation exists only on the floor side. See `mergeTranscripts`.
 *
 * And `turn` is special in the other direction: `emptyAgentSession` starts at `idle`, so a
 * freshly-connected session reports idle before the agent has said anything. Letting that
 * overwrite a floor state of `thinking` would report working agents as idle — and
 * `agentinbox/wake.ts` reads idle as "safe to deliver mail into".
 */

/** A declared value counts when it is not null/undefined — `[]` is a declaration. */
const said = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;

/**
 * ONE CONVERSATION out of two streams — P7's *"human↔agent DMs fold into the Agent
 * Conversation"*.
 *
 * ## What this replaces, and what measuring changed
 *
 * The rule was `declared.transcript.length > 0 ? declared.transcript : floor.transcript`: the
 * declared conversation REPLACES the projected one. Stated as "a real conversation beats
 * projected mail" that reads as obviously right. A real claude ACP session says otherwise
 * (`handshake.real.test.ts`, logged on every run):
 *
 * ```
 * [acp transcript] live=agent_message_chunk,notice,usage_update | replay=(0) none
 * ```
 *
 * The declared stream is the **agent's voice only**. The owner's prompt is never echoed back as
 * `user_message_chunk` during a session, and `session/load` on the CLI's own session id replays
 * nothing whatsoever. The two streams are not rival accounts of one conversation — they are its
 * two halves, and the old rule threw one half away the moment the agent spoke.
 *
 * The same measurement removes the reason replacement looked safe. A DM to an ACP agent is
 * delivered as a prompt (`acpMailSender`), so concatenating looked certain to show every DM
 * twice. There is no second copy for it to collide with.
 *
 * ## Ordering
 *
 * By `at`, because mail arriving MID-SESSION is the normal case for a working agent and
 * appending either stream would put an interruption after the reply it provoked.
 *
 * A message with no `at` — a `reportState` harness need not keep times — sorts LAST rather than
 * first. "I do not know when" has one honest position among times that are known, and placing
 * it at the end is also what the surface did before, so no ordering is lost. On a tie the floor
 * comes first: mail is stamped when it ARRIVES and a reply when Genie sees it, so at equal
 * resolution the prompt was the earlier of the two.
 */
function mergeTranscripts(floor: AgentSession, declared: AgentSession): AgentSession['transcript'] {
    // A session that has connected but not spoken must not blank the surface, and the floor's
    // mail plus last handoff is the most useful thing on it at that moment.
    if (declared.transcript.length === 0) return floor.transcript;
    if (floor.transcript.length === 0) return declared.transcript;

    /**
     * A CODEX ECHO MUST NOT DOUBLE A DM.
     *
     * The fear C23 dismissed is false for claude and TRUE for codex. Measured
     * (`handshake-codex.real.test.ts`): codex reports the user's turn as `user_message_chunk` — once
     * per turn on prism-acp 0.5.3, twice before that, which was prism's own missing lifecycle guard
     * and not codex's doing. One copy lands in the declared transcript either way, and a DM delivered
     * through `acpMailSender` is ALSO in the AgentInbox thread, hence in the floor one. Two streams,
     * one message, both legitimate — and no fix on either side changes that.
     *
     * The FLOOR copy wins, and that is what makes this resolvable rather than a coin toss: it carries
     * `author`, so it can say a sibling agent sent it. ACP has no notion of an author, so the echo is
     * anonymous and strictly the poorer record of the same text.
     *
     * ONE-TO-ONE, by consuming a count rather than testing set membership: two separate DMs of the
     * same text are two messages, and a set would keep one and swallow the rest.
     *
     * Scoped to `user`, because roles are not interchangeable — an agent quoting the owner back is the
     * agent speaking.
     */
    const floorSaid = new Map<string, number>();
    for (const m of floor.transcript) {
        if (m.role !== 'user') continue;
        floorSaid.set(m.content, (floorSaid.get(m.content) ?? 0) + 1);
    }
    const unechoed = declared.transcript.filter((m) => {
        if (m.role !== 'user') return true;
        const left = floorSaid.get(m.content) ?? 0;
        if (left === 0) return true;
        floorSaid.set(m.content, left - 1);
        return false;
    });

    // Floor first, so an equal stamp resolves in its favour. `i` carries the original position
    // because the comparator must not rely on `sort` being stable OR on arithmetic: two unstamped
    // messages give `Infinity - Infinity`, which is NaN, and a comparator returning NaN makes
    // `Array.prototype.sort` implementation-defined by spec. V8 treats it as 0 and stays stable,
    // so the ordering was correct by accident — the kind that holds until an engine changes.
    const keyed = [...floor.transcript, ...unechoed].map((m, i) => ({ m, i }));
    const at = (m: AgentSession['transcript'][number]) => m.at ?? Number.POSITIVE_INFINITY;
    return keyed
        .sort((a, b) => {
            const av = at(a.m);
            const bv = at(b.m);
            if (av === bv) return a.i - b.i;
            return av < bv ? -1 : 1;
        })
        .map((k) => k.m);
}

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

        // ONE conversation, not two. See `mergeTranscripts` — and the measurement that put
        // it there, which is that an ACP session's transcript holds no human messages at all.
        transcript: mergeTranscripts(floor, declared),

        // Declared-only and streaming. The floor sets neither (measured: zero assignments),
        // so the declared value is simply the value — including `[]`, which says the agent
        // is running no tools rather than that we cannot see any.
        live: declared.live,
        tools: declared.tools,

        /**
         * REASONING IS DECLARED-ONLY, and more absolutely than anything else here: a pty
         * floor cannot produce a thought even in principle. Genie sees bytes on a terminal;
         * an agent's reasoning exists only because the agent reports it.
         *
         * So the declared value is simply the value, `[]` included — which says this agent
         * has thought nothing yet, not that we cannot see its thinking.
         */
        thoughts: declared.thoughts,
        liveThought: declared.liveThought,

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
