import { ACP_PROVIDERS } from '../acp/agent-spec';

/**
 * Which engine an agent runs on.
 *
 * ## ACP IS NOT OPTIONAL
 *
 * Owner directive, 2026-10-07: *"acp is the core of our agent communications, this is not
 * optional."* There is no global flag. A provider that can speak ACP speaks ACP.
 *
 * This REPLACES the previous rule, which was its opposite and was pinned by a test as "the
 * default does not move": an agent ran on the pty unless something explicitly said
 * otherwise, because Genie 2 was a parallel surface whose default flipped at the end. That
 * was correct while it was true, and it stopped being true when the owner decided ACP is
 * the mechanism rather than a mode — the same way the Deck stopped being opt-in.
 *
 * ## Capability is not a flag
 *
 * The capability check still comes FIRST. A provider with no ACP mode has nothing to
 * connect to; forcing one would spawn something that is not an ACP server and then hang in
 * the handshake, which reads as a wedged agent. That is not a refusal to report — aider
 * keeps working exactly as it does today.
 *
 * The capability list lives in `main/acp/agent-spec.ts` as one closed set rather than a
 * field repeated across twenty-one registry rows, because four values duplicated
 * twenty-one times is an invitation to drift.
 */
export type AgentEngine = 'pty' | 'acp';

export interface EngineInput {
    /** The provider id, or null when the record does not say. */
    provider: string | null;
    /**
     * The global setting.
     *
     * HELD, not wanted. The owner's direction is that ACP is the mechanism rather than a mode
     * (*"acp is the core of our agent communications, this is not optional"*), and the flag is
     * removed the moment that is SAFE. It is not safe yet: an ACP session cannot resume a
     * conversation, because `prism-acp`'s `session/load` cannot be handed the id it needs
     * (`session/new` returns a minted id, not the CLI's). Making ACP mandatory today would
     * discard a conversation on every Genie restart — and a restart on this machine wedged 21
     * of 32 agents. Eight tests catch exactly that, and they are right.
     */
    acpEnabled: boolean;
    /**
     * This agent's own choice.
     *
     * Kept, and NOT a reintroduction of the global flag: one agent pinned to the pty for a
     * reason is a per-agent fact. The direction that matters now is holding back, since ACP
     * is what a capable provider gets. An ACP override cannot conjure a server that does
     * not exist — capability is still checked first.
     */
    agentOverride?: AgentEngine;
}

function canDoAcp(provider: string | null): boolean {
    // A null provider is already "unknown" to the session model. Starting a structured
    // session for something we cannot name would be a guess about which binary to run.
    if (!provider) return false;
    return (ACP_PROVIDERS as readonly string[]).includes(provider);
}

export function engineFor(input: EngineInput): AgentEngine {
    // Capability first: an override is a preference, not a capability.
    if (!canDoAcp(input.provider)) return 'pty';
    if (input.agentOverride) return input.agentOverride;
    return input.acpEnabled ? 'acp' : 'pty';
}
