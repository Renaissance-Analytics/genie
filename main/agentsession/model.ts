import type { SessionRateLimit } from './rate-limit';
/**
 * `AgentSession` — what Genie can say about one agent, as a value.
 *
 * ## Why this exists
 *
 * Genie drives every agent by typing into a pty and reads it back as bytes, so
 * five separate subsystems exist to INFER what a structured transport would
 * simply report: `agent-pulse` (output means working), `agentinbox/wake` (silence
 * means idle), `agentinbox/draft` (reconstruct the TUI's input box from the
 * keystrokes we sent), `agents/injection-guard` (regex the last twelve screen
 * lines for `(y/N)`), and `agents/triage` (eleven ailments, which exist because
 * *"from outside, a silent agent looks identical whatever is wrong with it"*).
 *
 * This is the type those inferences are being replaced by. One model, several
 * producers: a floor projector that works for all twenty-one providers from facts
 * Genie already owns, the `reportState` receiver a cooperating harness feeds
 * (genie#433), and an ACP engine. The UI renders the model and never the
 * transport. Design: `.ai/plans/genie-2-session-model.md`.
 *
 * The shape is LIFTED from `repos/genie-tui/src/protocol.ts` rather than
 * reinvented, so the harness that already emits it needs no translation layer.
 * Three things are added, because the host knows things one harness does not:
 * a `specId` to tie it to Genie's identity, a `fidelity` so the UI can be honest
 * about what it can see, and the fields ACP carries that no TUI exposes (plan,
 * usage, commands).
 *
 * ## THE RULE: `null` is "cannot see", `[]` is "none"
 *
 * Every optional field here is nullable for one reason. A pty agent HAS a
 * composer, a plan, a running cost and a set of slash commands; Genie just cannot
 * see any of them. Defaulting those to `[]` or `0` would assert "the agent has
 * none" and "it has spent nothing" — claims we have no standing to make, and ones
 * the UI would faithfully render as a confident zero.
 *
 * Genie has already paid for this distinction twice and written it down both
 * times. `read-buffer.ts` keeps *"0 bytes because we hold no buffer for this
 * terminal"* apart from *"0 bytes because the terminal is quiet"*. And
 * `provider-brand.ts` gives only three of twenty-one providers a logo because
 * *"borrowing another vendor's mark would assert a relationship that does not
 * exist."* Same discipline, now about an agent's state.
 */

/** What the agent is doing. Lifted verbatim from the harness protocol.
 *  `tool` is deliberately distinct from `thinking`: a build or a test suite can
 *  run silently for minutes, which is exactly what silence heuristics get wrong. */
export type TurnState = 'idle' | 'thinking' | 'tool' | 'awaiting-approval' | 'awaiting-input';

export type MessageRole = 'user' | 'agent' | 'tool' | 'error' | 'system';

export interface Message {
    id: string;
    role: MessageRole;
    content: string;
    /**
     * Who sent it, when `role` alone cannot say — null for the owner and for the
     * agent's own voice.
     *
     * A host-side addition. The lifted protocol carries only a role, which is
     * enough for a single-agent harness where every `user` message is the person
     * sitting there. Genie's floor transcript is built partly from AgentInbox
     * mail, which is MULTI-PARTY: a message from a sibling agent is neither this
     * agent speaking nor the owner speaking. Encoding the sender into `content` as
     * a prefix would be munging somebody's text, so it gets a field.
     */
    author?: string | null;
}

export interface ToolCall {
    id: string;
    name: string;
    status: 'pending' | 'success' | 'failure';
}

export interface PendingApproval {
    id: string;
    name: string;
    args: unknown;
}

/** The input box as fact rather than reconstruction. `busy` is what lets a
 *  delivery be QUEUED instead of typed — the current nudge has to cut the line,
 *  paste a notice, send a bare CR 60ms later and restore what it cut. */
export interface ComposerState {
    text: string;
    cursor: number;
    busy: boolean;
}

/** One entry of the agent's own plan. Mutates in place, so the UI renders it as a
 *  rail rather than appending it to the transcript. */
export interface PlanEntry {
    id: string;
    title: string;
    status: 'pending' | 'in-progress' | 'done' | 'dropped';
}

/** What the turn has cost so far. Any member may be null on its own: a harness
 *  can know its context window without knowing a price. */
export interface SessionUsage {
    contextUsed: number | null;
    contextMax: number | null;
    costUsd: number | null;
}

/** A command the agent itself offers. Today a human has to KNOW an agent's slash
 *  commands; a declaring agent hands over the list. */
export interface SlashCommand {
    name: string;
    hint: string | null;
}

/** How much of this session Genie can actually see. Drives which surface an agent
 *  gets — not a quality score, and never rendered as a deficiency. */
export type SessionFidelity =
    /** The agent states its own state. Full conversation, plan, approvals. */
    | 'declared'
    /** Running, and Genie can see activity plus whatever the agent volunteers
     *  through Genie's own channels (questions, lists, mail, handoffs). */
    | 'observed'
    /** Genie cannot even say what this is. Needs a repair, not an empty view. */
    | 'unknown';

export interface AgentSessionIdentity {
    /**
     * `workspace_agents.id` — the DURABLE identity, and the key.
     *
     * Not the terminal. An agent is not its TUI (shipped beta.285): it can switch
     * drivers, each with its own pty, and it exists while running none of them. The
     * AMS grid already fixed this exact mistake once and wrote down what it cost —
     * *"a registered agent that was not running was INVISIBLE, so every
     * `role: 'workspace'` agent seeded since v50 has never been shown to anyone"* —
     * and keying a session by its terminal would reintroduce it, because a dormant
     * agent has no terminal to key on.
     */
    agentId: string;
    /**
     * The fronted runtime's `terminal_specs.id`, or **null when the agent is
     * dormant**. Reused across restarts when it exists, because that is what carries
     * the agent's AgentInbox identity and queued mail — but its absence is a normal
     * state, not a missing value.
     */
    specId: string | null;
    /** The provider id from `main/agents/registry.ts`, or null when unresolvable. */
    provider: string | null;
    name: string;
    cwd: string;
    workspaceId: string | null;
}

export interface AgentSession {
    /** The durable agent identity — see {@link AgentSessionIdentity.agentId}. */
    agentId: string;
    /** Its current terminal, or null while dormant. */
    specId: string | null;
    session: {
        provider: string | null;
        name: string;
        cwd: string;
        workspaceId: string | null;
        /** The harness conversation id, once something has bound one. */
        sessionId: string | null;
    };
    turn: { state: TurnState; since: number };
    /** null ⇒ Genie cannot see the input box (every pty provider). */
    composer: ComposerState | null;
    /** Committed messages. The floor fills this from Genie's OWN channels, which
     *  is why a non-empty transcript does not imply declared fidelity. */
    transcript: Message[];
    /** The in-flight message, if any. */
    live: Message | null;
    tools: ToolCall[];
    /** Genie owns its approval queue, so `[]` here is a fact for any provider. */
    approvals: PendingApproval[];
    /**
     * SUBSCRIPTION HEADROOM — what is left before the wall.
     *
     * Owner requirement: *"I do need to see what is remaining on rate limits at least."*
     * Arrives on a `notice` update's `_meta`, parsed by `prism-acp`. `null` is "cannot see" —
     * a pty agent never reports one, and a declared agent has not yet in its first turn. It
     * must never render as full headroom.
     */
    rateLimit: SessionRateLimit | null;
    /**
     * Why there is no reading, when the provider changed shape.
     *
     * Prism refuses an unrecognised payload TOTALLY and names the field that failed. Without
     * storing the reason, a provider rename shows no gauge AND no explanation — strictly
     * worse than a false gauge only in that nobody is misled, and strictly worse than this.
     */
    rateLimitUnavailable: string | null;
    /** null ⇒ not visible. `[]` ⇒ the agent has no plan right now. */
    plan: PlanEntry[] | null;
    /** null ⇒ not visible. NEVER render a dash for this — a dash reads as zero. */
    usage: SessionUsage | null;
    /** null ⇒ not visible. `[]` ⇒ the agent offers no commands. */
    commands: SlashCommand[] | null;
    error: string | null;
}

/**
 * The honest zero value: everything Genie owns set to empty, everything it cannot
 * see set to null. A producer overwrites what it actually knows and leaves the
 * rest alone, so a partial report never fabricates the gaps.
 */
export function emptyAgentSession(identity: AgentSessionIdentity, now = Date.now()): AgentSession {
    return {
        agentId: identity.agentId,
        specId: identity.specId,
        session: {
            provider: identity.provider,
            name: identity.name,
            cwd: identity.cwd,
            workspaceId: identity.workspaceId,
            sessionId: null,
        },
        turn: { state: 'idle', since: now },
        composer: null,
        transcript: [],
        live: null,
        tools: [],
        approvals: [],
        rateLimit: null,
        rateLimitUnavailable: null,
        plan: null,
        usage: null,
        commands: null,
        error: null,
    };
}

/**
 * How much of this session we can see, derived from the session itself rather
 * than promised by a provider table.
 *
 * The composer is the discriminator because it is the one field no observer can
 * ever infer. `agentinbox/draft.ts` says so in its own doc comment — *"Genie
 * cannot read a TUI's input box … there is no keystroke that makes a TUI hand its
 * buffer over"* — so it reconstructs a guess from the keystrokes Genie itself
 * sent. A composer that is actually PRESENT therefore means the agent told us,
 * and the rest of its report can be trusted on the same grounds.
 *
 * A transcript deliberately does NOT count. The floor projector fills that for
 * every provider out of the AgentInbox thread and the last handoff note, so
 * treating it as a declaration would have every pty agent claiming to show its
 * conversation while it was showing its mail.
 */
/**
 * Fields NO OBSERVER CAN PRODUCE, so the presence of any one proves a declaration.
 *
 * Measured against the floor projector, which assigns exactly four fields — `turn`,
 * `transcript`, `approvals`, `error` — and leaves these four at their `emptyAgentSession`
 * nulls. That asymmetry is what makes this a proof rather than a guess.
 *
 * `transcript` is deliberately NOT here: the projector fills it for every provider out of
 * the AgentInbox thread and the last handoff, so treating it as a declaration would have
 * every pty agent claiming to show its conversation while showing its mail.
 */
const DECLARED_ONLY_FIELDS = ['composer', 'plan', 'usage', 'commands', 'rateLimit'] as const;

/**
 * How much of this session Genie can actually see.
 *
 * It used to be `s.composer ? 'declared' : 'observed'`, and the reasoning was right for the
 * producer it was written for: `reportState` (genie-tui) reports an input box, and
 * `draft.ts` says in its own doc that *"Genie cannot read a TUI's input box"* — so a present
 * composer meant the agent told us.
 *
 * ACP has no composer. The agent cannot see what the human is typing, so
 * `applySessionUpdate` never sets one, and an ACP session would have been classified
 * `observed` forever — Terminal-first tabs, no Conversation tab — however much declared data
 * arrived. Keying on ANY declared-only field admits both producers without admitting the
 * projector.
 */
export function sessionFidelity(s: AgentSession): SessionFidelity {
    if (!s.session.provider) return 'unknown';
    // Non-null, not truthy: `plan: []` and `commands: []` are DECLARATIONS — the agent said
    // it has none — and a falsy check would read them as absence.
    const declared = DECLARED_ONLY_FIELDS.some((f) => s[f] !== null && s[f] !== undefined);
    return declared ? 'declared' : 'observed';
}

/** Which fields the UI is entitled to render for this session. */
export interface KnownFacts {
    composer: boolean;
    plan: boolean;
    usage: boolean;
    commands: boolean;
    transcript: boolean;
    /**
     * Subscription headroom — a reading, or the explanation for its absence.
     *
     * Separate from `usage` because they answer different questions from different frames:
     * `usage` is this session's tokens and cost, a rate limit is the ACCOUNT's remaining
     * capacity. An agent can have either without the other.
     */
    rateLimit: boolean;
}

/**
 * Per-field visibility, so a surface never has to re-derive the null/empty rule
 * and never accidentally renders a confident zero.
 *
 * Note the asymmetry, which is the point: an EMPTY declared value is KNOWN. A
 * `plan: []` should render "no plan" — the agent said so — whereas `plan: null`
 * should hide the section, because we are not in a position to say.
 */
export function knownFacts(s: AgentSession): KnownFacts {
    return {
        composer: s.composer !== null,
        plan: s.plan !== null,
        usage:
            s.usage !== null &&
            (s.usage.contextUsed !== null || s.usage.contextMax !== null || s.usage.costUsd !== null),
        commands: s.commands !== null,
        transcript: s.transcript.length > 0,
        // The explanation counts as a fact: "no reading, and here is why" is worth a line, and
        // it is the case prism explicitly warned would otherwise leave no gauge AND no reason.
        rateLimit: s.rateLimit !== null || s.rateLimitUnavailable !== null,
    };
}
