import { ACP_PROVIDERS } from '../acp/agent-spec';

/**
 * Which engine an agent runs on.
 *
 * ## The default does not move
 *
 * An agent runs on the **pty** unless something explicitly says otherwise. That is the
 * owner's decision — Genie 2 is a parallel surface and the default flips at the end —
 * and it is pinned by a test rather than assumed, because I have already exceeded it
 * twice in this work: once by defaulting the route to the Deck, once by giving the Deck
 * a global key. Both hid the grid, and both looked fine locally.
 *
 * Getting it backwards would change how every existing agent starts, silently, on
 * upgrade.
 *
 * ## Enabling is permission, not a promise
 *
 * A provider with no ACP mode stays on the pty even when ACP is enabled. That is not a
 * refusal to report — aider keeps working exactly as it does today. The capability list
 * lives in `main/acp/agent-spec.ts` as one closed set rather than a field repeated
 * across twenty-one registry rows, because four values duplicated twenty-one times is
 * an invitation to drift.
 */
export type AgentEngine = 'pty' | 'acp';

export interface EngineInput {
    /** The provider id, or null when the record does not say. */
    provider: string | null;
    /** The global setting. */
    acpEnabled: boolean;
    /** This agent's own choice, which overrides the global setting in BOTH directions —
     *  an agent moved across keeps ACP when the flag is off, and one held back keeps the
     *  pty when it is on. */
    agentOverride?: AgentEngine;
}

function canDoAcp(provider: string | null): boolean {
    // A null provider is already "unknown" to the session model. Starting a structured
    // session for something we cannot name would be a guess about which binary to run.
    if (!provider) return false;
    return (ACP_PROVIDERS as readonly string[]).includes(provider);
}

export function engineFor(input: EngineInput): AgentEngine {
    // Capability first: an override is a preference, not a capability. Honouring an ACP
    // override for a provider that cannot do it would spawn something that is not an ACP
    // server and then hang in the handshake, which reads as a wedged agent.
    if (!canDoAcp(input.provider)) return 'pty';
    if (input.agentOverride) return input.agentOverride;
    return input.acpEnabled ? 'acp' : 'pty';
}
