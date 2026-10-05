/**
 * The FLOOR projector — an `AgentSession` built only from what Genie already owns.
 *
 * No provider cooperation is required, so this works for all twenty-one providers
 * in `main/agents/registry.ts`, including the ones that will never declare
 * anything. That is the point: the surface is useful on day one and at the same
 * fidelity for everybody, and the declared producers (`reportState`, and later an
 * ACP engine) RAISE it rather than being a prerequisite for it.
 *
 * Its five sources are all Genie's own:
 *
 * | source | gives |
 * |---|---|
 * | `terminal/agent-pulse` | declared mid-turn, per agent (`workingAgentTerminals`) |
 * | `ask/force-question` | questions this agent is parked on |
 * | `agentinbox` | mail the agent has exchanged |
 * | `agents/handoff` | the last `imDone` note — the agent's own prose |
 * | `agents/triage` | an ailment, when one has been computed |
 *
 * ## It is pure, and it takes facts rather than fetching them
 *
 * Everything arrives as an argument. `AgentPulse` in particular could not be
 * reached from here without dragging timers and a singleton into a unit test — and
 * it exposes no per-agent accessor anyway (`WsState.workingAgents` is private, and
 * `snapshotAll()` is keyed by WORKSPACE). The caller reads those; this decides.
 *
 * ## The restraint is the feature
 *
 * Two ways to fail, and they are symmetric: state too little and the surface is
 * empty, state too much and it lies about an agent. So the composer, the plan, the
 * usage and the command list stay `null` — not `[]`, not `0` — because this
 * projector genuinely cannot see them, and `null` is the only answer that says so.
 * See the rule in `./model.ts`.
 */

import { emptyAgentSession, type AgentSession, type AgentSessionIdentity, type Message } from './model';

/** A ForceTheQuestion this agent is waiting on. Only the age is needed here. */
export interface FloorQuestion {
    id: string;
    createdAt: number;
}

/** The agent's last `imDone` handoff note. */
export interface FloorHandoff {
    text: string;
    at: number;
}

/** One piece of AgentInbox traffic Genie can show for this agent. */
export interface FloorMessage {
    id: string;
    /** `agent` is this agent's own voice; `human` is the owner; `peer` is a sibling. */
    from: 'human' | 'agent' | 'peer';
    /** The sender's name, for a `peer`. Null for the owner and for the agent itself. */
    author: string | null;
    body: string;
    at: number;
}

export interface FloorInputs {
    identity: AgentSessionIdentity;
    /**
     * The agent DECLARED itself mid-turn — `noteAgentWorking`, cleared by `imDone`,
     * with a backstop decay. Read from `agentPulse.workingAgentTerminals()`, which
     * is per-TERMINAL and therefore per-agent.
     *
     * **There is deliberately no byte-activity input beside it.** Genie counts pty
     * bytes per WORKSPACE (`agentPulse.note(workspaceId, bytes)`; `feedTerminalData`
     * has the terminal id and does not pass it), so a byte-derived signal here
     * would report a SIBLING agent's output as this agent thinking — a confident
     * claim about the wrong agent, which is the exact failure this model exists to
     * prevent. An earlier draft of this interface carried `byteActive`, and a caller
     * wiring it to the only available source would have been wrong without anything
     * saying so.
     *
     * If per-agent activity is wanted later it has to be MEASURED per agent first,
     * in `agent-pulse` at the call site that already knows the id.
     */
    working: boolean;
    /** Pending questions asked BY this agent, in any order. */
    questions: readonly FloorQuestion[];
    handoff: FloorHandoff | null;
    /** Mail for this agent, in any order. */
    mail: readonly FloorMessage[];
    /** A triage ailment id, or null when triage found nothing. */
    ailment: string | null;
    now?: number;
}

/** Message role for a piece of mail. An external sender is `user` whoever they
 *  are — from this agent's side of the conversation the owner and a sibling agent
 *  are both somebody else asking for something. `author` distinguishes them. */
function roleFor(from: FloorMessage['from']): Message['role'] {
    return from === 'agent' ? 'agent' : 'user';
}

export function projectFloorSession(inputs: FloorInputs): AgentSession {
    const now = inputs.now ?? Date.now();
    const base = emptyAgentSession(inputs.identity, now);

    const messages: Array<Message & { at: number }> = inputs.mail.map((m) => ({
        id: m.id,
        role: roleFor(m.from),
        author: m.author,
        content: m.body,
        at: m.at,
    }));

    // The handoff is the agent's own account of what it did, and the single most
    // useful thing on this surface — `readHandoff` has had no production caller at
    // all, so it has been written and never read. It is placed BY ITS TIMESTAMP
    // rather than pinned last, because mail that arrived after the agent finished
    // is genuinely newer, and burying it would hide a reply somebody is waiting on.
    if (inputs.handoff && inputs.handoff.text.trim() !== '') {
        messages.push({
            // Keyed on the AGENT, not its terminal: a spec id is absent while
            // dormant — exactly when the handoff matters most — and `handoff:null`
            // would collide across every dormant agent.
            id: `handoff:${inputs.identity.agentId}`,
            role: 'agent',
            author: null,
            content: inputs.handoff.text,
            at: inputs.handoff.at,
        });
    }

    messages.sort((a, b) => a.at - b.at);

    return {
        ...base,
        turn: turnOf(inputs, now),
        transcript: messages.map(({ at: _at, ...m }) => m),
        // Deliberately NOT populated from the question queue. `PendingApproval` is a
        // TOOL approval; a ForceTheQuestion has options, a priority, DND deferral,
        // an age and a host, and flattening one into the other would discard all of
        // that and then render it as a tool call. A pending question shows up here
        // as `turn.state === 'awaiting-input'`; the question itself belongs to the
        // attention queue, which already distinguishes the two kinds.
        approvals: [],
        error: inputs.ailment,
    };
}

/**
 * The turn state, from one per-agent signal and a queue.
 *
 * Precedence matters: a pending question OUTRANKS being mid-turn, because an agent
 * parked on a human is blocked whether or not it believes it is working. And `tool`
 * is never produced — distinguishing a tool call from thinking requires the agent
 * to say so, which is precisely why the two are separate states and precisely what
 * a silence heuristic gets wrong about a test suite that runs quietly for minutes.
 */
function turnOf(inputs: FloorInputs, now: number): AgentSession['turn'] {
    if (inputs.questions.length > 0) {
        // Dated from the OLDEST question, so the surface can say how long this has
        // been waiting. `since` means when the state began, not when we last looked.
        const oldest = inputs.questions.reduce((a, q) => (q.createdAt < a ? q.createdAt : a), Infinity);
        return { state: 'awaiting-input', since: Number.isFinite(oldest) ? oldest : now };
    }
    if (inputs.working) return { state: 'thinking', since: now };
    return { state: 'idle', since: now };
}
