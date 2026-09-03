/**
 * Re-establishing an agent's `genie` MCP connection after Genie restarts.
 *
 * An upgrade replaces the process behind the MCP endpoint, so every running
 * agent's connection to `genie` is stale afterwards. The upgrade notice then
 * tells the agent to act using tools that will not answer — which reads as the
 * tools being broken rather than merely disconnected.
 *
 * HOW that is repaired differs per harness, and it is not a matter of taste:
 *
 *  - **claude** takes `/mcp reconnect genie`, typed into the prompt. It must go
 *    through the nudge machinery so it is SUBMITTED with the terminal's real
 *    submit bytes — a raw write plus CR types the command and leaves it sitting
 *    there, which is how a reconnect and an inbox notice ended up sharing one
 *    input line.
 *  - **codex** has NO equivalent. Verified against codex-cli 0.150.1 by the
 *    Codex agent itself: `codex mcp` exposes only list/get/add/remove/
 *    login/logout, with no single-server reconnect. Codex also does not
 *    discover the replacement URL on its own, because Genie passes it in launch
 *    config, so the running process keeps the old endpoint. The repair is a
 *    MANAGED RESTART, which resumes the session (`codex resume <id>`) against
 *    refreshed launch config and preserves the conversation.
 *  - **everything else** gets a NOTICE — stated, not typed (genie#346).
 *
 * ## Why `{kind:'none'}` is gone
 *
 * `kiwi`, `genie` and `custom` used to answer `none`, on the reasoning that
 * typing a guessed slash command into a live prompt is worse than leaving the
 * reconnect to the agent. The first half of that is still true and still
 * enforced — nothing below types into a TUI whose grammar Genie does not know.
 * The second half was the mistake: `none` did not leave the reconnect to the
 * agent, it left the agent UNTOLD. It stayed disconnected until a human
 * happened to notice, and the share of agents in that state grew with every
 * provider added to the registry.
 *
 * A restart is not the way out for those three either: `renderAgentResume`
 * renders a resume command for `claude` and `codex` ONLY, so
 * `restartAgentTerminal` refuses the rest rather than drop a conversation into a
 * fresh, context-less session. What is left — and what `none` was withholding —
 * is telling the truth: the connection was replaced, here is how to restore it.
 * The caller renders that into the upgrade notice and flags the terminal for
 * attention, so a provider Genie cannot repair is visible instead of silent.
 *
 * PURE: the caller performs whatever this returns.
 */

import { PROVIDER_IDS, type AgentTuiId } from './registry';

/**
 * What an agent is told to do when Genie cannot reconnect it — the ONE string
 * behind every `notice` strategy.
 *
 * Deliberately harness-agnostic, because that is exactly the situation it
 * covers: Genie knows the connection is stale and does not know this TUI's
 * input grammar well enough to repair it without guessing.
 */
export const MANUAL_RECONNECT_NOTICE =
    'Reconnect the `genie` MCP server from inside this terminal — its process was replaced by ' +
    'the upgrade, so the connection is stale. Use your tool\'s own MCP reconnect command, or stop ' +
    'and relaunch the agent. Genie will not type a guessed command into a prompt it cannot read.';

export type ReconnectStrategy =
    /** Type this into the prompt, through the nudge machinery. */
    | { kind: 'command'; text: string }
    /** Restart the agent's terminal; its session resumes against the new config. */
    | { kind: 'restart' }
    /**
     * Nothing Genie can safely perform — so SAY so, out of band. The caller
     * renders this into the upgrade notice and flags the terminal for attention.
     */
    | { kind: 'notice'; text: string };

/**
 * A recovery path for EVERY registered provider.
 *
 * `Record<AgentTuiId, …>` is the load-bearing part, and the reason this is a
 * table rather than an `if` chain: a provider added to `PROVIDER_IDS` stops
 * this file compiling until it has a path, so genie#346's "none is left on
 * `{kind:'none'}`" is enforced by the compiler instead of by memory.
 */
const RECONNECT_STRATEGIES: Record<AgentTuiId, ReconnectStrategy> = {
    claude: { kind: 'command', text: '/mcp reconnect genie' },
    // Out of band, never typed. Codex parks on key-driven modals -- update
    // pickers, approval requests, trust prompts -- where injected text is read
    // as an answer, and on the update picker option 1 runs a global npm install.
    codex: { kind: 'restart' },
    // No known reconnect grammar, and no resumable restart (`renderAgentResume`
    // covers claude + codex only), so a restart would cost the conversation.
    kiwi: { kind: 'notice', text: MANUAL_RECONNECT_NOTICE },
    genie: { kind: 'notice', text: MANUAL_RECONNECT_NOTICE },
    // A custom agent IS its command; Genie knows nothing about its prompt.
    custom: { kind: 'notice', text: MANUAL_RECONNECT_NOTICE },
};

const KNOWN_PROVIDERS = new Set<string>(PROVIDER_IDS);

export function reconnectStrategy(provider: string | null | undefined): ReconnectStrategy {
    // An unknown or absent provider — a terminal from a newer build, or one
    // whose `meta.agent` never got written — must not fall off the end of the
    // table into silence. It is exactly the case the notice exists for.
    if (typeof provider !== 'string' || !KNOWN_PROVIDERS.has(provider)) {
        return { kind: 'notice', text: MANUAL_RECONNECT_NOTICE };
    }
    return RECONNECT_STRATEGIES[provider as AgentTuiId];
}

/**
 * The TUI command that reconnects the `genie` server, or null when there is
 * none. Retained for callers that only handle the typed form.
 */
export function mcpReconnectCommand(provider: string | null | undefined): string | null {
    const strategy = reconnectStrategy(provider);
    return strategy.kind === 'command' ? strategy.text : null;
}

/**
 * What Genie CHOSE to do, and whether it actually happened.
 *
 * The two halves are separate because both actions can legitimately refuse:
 * `wakeTerminalIfIdle` will not type into a terminal that is mid-turn or holds
 * a human's draft, and `restartAgentTerminal` will not restart an agent with no
 * resumable session. Those refusals are correct — and they mean the reconnect
 * did NOT happen, so a notice claiming otherwise is a lie the agent then acts
 * on.
 */
export interface McpRecovery {
    strategy: ReconnectStrategy;
    /** True only when Genie performed the strategy and it took effect. */
    applied: boolean;
}

/** The recovery an agent gets when Genie could not act at all — a reconnect that
 *  threw, a terminal it could not reach, a caller with no reconnect wiring. */
export const MANUAL_RECOVERY: McpRecovery = {
    strategy: { kind: 'notice', text: MANUAL_RECONNECT_NOTICE },
    applied: false,
};

/**
 * PURE. The sentence the upgrade notice carries — what happened to this agent's
 * connection and what to do about it.
 *
 * Never asserts the connection is BACK. A typed `/mcp reconnect genie` can
 * still fail, and a resumed terminal can still come up against a server that
 * has not finished binding; the agent finds out by calling a tool, not by being
 * told.
 */
export function recoveryInstruction(recovery: McpRecovery): string {
    const { strategy, applied } = recovery;
    if (strategy.kind === 'command') {
        return applied
            ? `Genie ran \`${strategy.text}\` in this terminal to restore it. If \`genie\` still does not answer, run it again yourself.`
            : `Run \`${strategy.text}\` in this terminal to restore it — Genie held the command back rather than type over a prompt that was in use.`;
    }
    if (strategy.kind === 'restart') {
        return applied
            ? 'Genie restarted this terminal against the new endpoint and resumed the session, so the connection is fresh.'
            : 'Restart this agent so it picks up the new endpoint — Genie could not do it for you (no resumable session was captured).';
    }
    return strategy.text;
}
