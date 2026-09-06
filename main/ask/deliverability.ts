import type { AskDeliverability } from './force-question';

/**
 * CAN AN ANSWER GET BACK? — one rule, asked of the registry that delivers.
 *
 * ## What was wrong (genie#502)
 *
 * genie#321 added a gate: refuse a question at ask time when its answer could
 * never be delivered, because accepting one and dropping the answer is
 * indistinguishable, from the human's side, from the agent ignoring them. The
 * gate is right. Its lookup was not.
 *
 * `hasInboxIdentity` was computed as
 *
 * ```ts
 * listWorkspaceAgents(workspaceId).some((a) => a.terminal_spec_id === terminalId)
 * ```
 *
 * — whether some `workspace_agents` row NAMES this terminal in a column
 * `main/db.ts` describes as *"only its cached mirror"* of the fronted runtime.
 * That is not an AgentInbox identity, and the delivery it guards never consults
 * it: `deliverHumanMessageToTerminal` resolves through the broker's
 * `byTerminal` map. Two registries, one of which was not the one being asked
 * about.
 *
 * The workstation operator can never satisfy the mirror test. Its charter says
 * so outright (`main/agents/upgrade-guide.ts`):
 *
 * > *"You are deliberately never registered as a workspace agent: no
 * > `workspace_agents` row is ever written for you, so that deleting a project
 * > or rebuilding workspace state cannot delete, rename or re-parent this
 * > identity."*
 *
 * So the one agent whose whole job is to escalate to the human could not ask the
 * human anything — and was told it had no AgentInbox identity while holding one
 * (`meta.agent_id: 'genie:workstation'`, joined at every boot by
 * `rehydrateAgentInbox`). Measured on a live workstation: 70 terminal specs, 12
 * carrying an identity, exactly one named by no `workspace_agents` row, and it
 * was the operator.
 *
 * ## Why this is a module and not two more copies
 *
 * The same expression stood in THREE places — the ask gate, the boot-time
 * rehydrate guard, and (transitively) whatever read the mirror after
 * `frontAgentRuntime` moved which runtime was fronted without moving it. The
 * boot guard's own comment already claimed it applied *"the same test the ask
 * path applies … a terminal in a workspace, with an AgentInbox identity bound to
 * it"*, which is what it meant and not what it did. One function, two callers,
 * so the next divergence has to be deliberate.
 *
 * PURE — the two lookups are injected, so the rule is testable without a
 * database, an Electron app, or a broker singleton.
 */
export interface AskDeliverabilityLookup {
    /** The terminal's workspace id, or null when it is in none. */
    workspaceOfTerminal: (terminalId: string) => string | null;
    /**
     * The AgentInbox agent id registered ON this terminal, or null.
     *
     * Deliberately the SAME lookup delivery uses
     * (`AgentInboxBroker.agentIdForTerminal` → `byTerminal`), not a proxy for
     * it. An agent that is `away` still resolves, and that is correct: the inbox
     * is durable, so a queued answer waits rather than being lost — the gate
     * exists for answers with nowhere to land, not for agents that are quiet.
     */
    inboxIdentityFor: (terminalId: string) => string | null;
}

/** What {@link forceQuestionRefusal} needs, resolved for one terminal. */
export function resolveAskDeliverability(
    terminalId: string,
    lookup: AskDeliverabilityLookup,
): AskDeliverability {
    const workspaceId = terminalId ? lookup.workspaceOfTerminal(terminalId) : null;
    return {
        workspaceId,
        // Asked even when the workspace is missing would be wasted work, and
        // the refusal names the workspace first anyway.
        hasInboxIdentity: workspaceId ? lookup.inboxIdentityFor(terminalId) !== null : false,
    };
}
