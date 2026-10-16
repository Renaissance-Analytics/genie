/**
 * WHICH ENGINE AN AGENT RUNS ON — and there is only one.
 *
 * ## The rule
 *
 * An agent is a session. A session is not a terminal. **No agent process is ever attached to
 * a pty, for any reason, including "an unused one".**
 *
 * A pty exists for exactly four things, none of which is an agent: a shell a person opened,
 * a build or script someone ran, a background process or service Genie supervises, and a
 * hosted site's server process.
 *
 * ## Why this is a type and not a convention
 *
 * The previous implementation had `AgentEngine = 'pty' | 'acp'` and an `engineFor` that
 * returned `'pty'` whenever a provider could not speak ACP. That read as graceful
 * degradation and was not: it is the line that put all thirty of the owner's agents into
 * terminals. Removing it was not enough on its own either — a pty was still spawned seventy
 * lines before the engine was consulted — which is the other half of the lesson: **the
 * engine decision must precede every spawn.**
 *
 * So `AgentEngine` has ONE member. "Agent on a pty" is not a state to be avoided; it is
 * unrepresentable. A compiler error is the only guard that survives a year of edits.
 */
export type AgentEngine = 'acp';

/**
 * Providers that can actually be driven over ACP today.
 *
 * Measured against `@particle-academy/prism-acp@0.6.1`, which ships exactly two drivers —
 * `ClaudeDriver` and `CodexDriver`. This list means CAPABILITY, and it is deliberately the
 * same two the owner has scoped the product to.
 *
 * Adding a name here is a claim that prism-acp can drive it. Do not add one on the strength
 * of a changelog: the previous build listed codex before its driver existed, so every codex
 * agent was routed to an engine that declined it and never started.
 */
export const ACP_PROVIDERS = ['claude', 'codex'] as const;

export type AcpProvider = (typeof ACP_PROVIDERS)[number];

export function isAcpProvider(provider: string | null | undefined): provider is AcpProvider {
    if (!provider) return false;
    return (ACP_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * The engine this agent runs on, or `null` meaning **it cannot run as an agent at all**.
 *
 * `null` is the important half of the signature. It replaces the old `'pty'` return, and the
 * difference is not cosmetic: a caller that treats "cannot" as "use a terminal" reintroduces
 * the entire defect. A provider with no ACP mode has nothing to connect to, and there is no
 * second engine to fall back to — so the honest answer is a refusal that a caller must
 * surface, not a quiet downgrade.
 *
 * A person may still run such a provider themselves through Take Over, which opens a
 * terminal in its own window with Genie's MCP available. That is a window the user owns;
 * Genie does not start it, manage it, restart it or revive it, and it is not an agent.
 */
export function engineFor(provider: string | null | undefined): AgentEngine | null {
    return isAcpProvider(provider) ? 'acp' : null;
}
