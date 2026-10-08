import { ACP_PROVIDERS } from '../acp/agent-spec';

/**
 * Which engine an agent runs on.
 *
 * ## ACP IS NOT OPTIONAL
 *
 * Owner directive: *"acp is the core of our agent communications, this is not optional."*
 * There is no global flag. A provider that can speak ACP speaks it.
 *
 * This REPLACES the previous rule, which was its opposite and was pinned by a test as "the
 * default does not move" — an agent ran on the pty unless something said otherwise, because
 * Genie 2 was a parallel surface whose default flipped at the end. That was correct while it
 * was true.
 *
 * ## Why it is safe NOW and was not an hour ago
 *
 * The flip was written, measured, and REVERTED once before landing, because it turned 8 test
 * files red and those tests were right: an ACP session could not resume a conversation, so
 * making it the default would have discarded one on every Genie restart. A restart on the
 * owner's machine wedged 21 of 32 agents the same day, so that was not hypothetical.
 *
 * Four things had to be true first, and now are:
 *
 *  - **`session/load` works from a client.** prism-acp 0.3.0, after its author found three
 *    stacked defects while confirming his own "yes" — chiefly that the CLI's session id was
 *    recorded as unmapped and reached no client at all.
 *  - **Genie captures and persists that id** (`META_CLI_SESSION_ID` → `meta.chat_session_id`),
 *    the same field the pty path writes, so a restart resumes through existing machinery.
 *  - **`restartOptionsFor` is engine-aware.** It keyed `canResume` on whether the provider's
 *    CLI has a `--resume` FLAG — true for claude and codex, FALSE for gemini and kimi, all of
 *    which are ACP-capable. Keying on the grammar hid the control that preserves a gemini
 *    conversation.
 *  - **`ACP_PROVIDERS` means capability.** codex was in the list and `acpLaunch` refuses it,
 *    so every codex agent was routed to an engine that declined it and never started.
 *
 * ## Capability is not a flag
 *
 * The capability check still comes FIRST. A provider with no ACP mode has nothing to connect
 * to; forcing one would spawn something that is not an ACP server and hang in the handshake,
 * which reads as a wedged agent. That is not a refusal to report — aider keeps working
 * exactly as it does today.
 *
 * ## What this does NOT give back
 *
 * A resumed conversation replays no history: `session/load` returns `{}` and sends no
 * updates, because the CLI replays nothing. The conversation continues on the provider's
 * side and nothing reappears on screen. Honest rather than complete — the alternative is
 * re-prompting the agent with a transcript it never had, which looks resumed and is not.
 */
export type AgentEngine = 'pty' | 'acp';

export interface EngineInput {
    /** The provider id, or null when the record does not say. */
    provider: string | null;
    /**
     * This agent's own choice.
     *
     * Kept, and NOT a global flag: one agent pinned to the pty for a reason is a per-agent
     * fact. The direction that matters now is holding BACK, since ACP is what a capable
     * provider gets. An ACP override cannot conjure a server that does not exist —
     * capability is checked first.
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
    // No flag. ACP is the mechanism — see the header.
    return 'acp';
}
