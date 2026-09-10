/**
 * Re-establishing an agent's Genie MCP connections after Genie restarts.
 *
 * An upgrade replaces the process behind the MCP endpoint, so every running
 * agent's connection to it is stale afterwards. The upgrade notice then tells
 * the agent to act using tools that will not answer — which reads as the tools
 * being broken rather than merely disconnected.
 *
 * ## There is more than one connection (genie#613)
 *
 * This file used to say `genie`, once, as a literal. Genie configures TWO
 * servers against that endpoint for a Claude agent — `genie` and
 * `genie-agentinbox-channel` — and the upgrade takes out both. The notice
 * restored one and never mentioned the other, so the channel, which is the PUSH
 * delivery path, stayed down until a human noticed. Observed on the operator
 * terminal after .315 → .316.
 *
 * So no server is named here. The list comes from {@link genieEndpointServers},
 * the same declaration `writeWorkspaceAgentMcp` writes from — a third server
 * added there reaches this notice with no edit in this file.
 *
 * HOW the connections are repaired differs per harness, and it is not a matter
 * of taste:
 *
 *  - **claude** takes `/mcp reconnect …`, typed into the prompt. It must go
 *    through the nudge machinery so it is SUBMITTED with the terminal's real
 *    submit bytes — a raw write plus CR types the command and leaves it sitting
 *    there, which is how a reconnect and an inbox notice ended up sharing one
 *    input line. See {@link claudeReconnectCommand} for why ONE command has to
 *    cover every server.
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
 * is telling the truth: the connections were replaced, here is how to restore
 * them. The caller renders that into the upgrade notice and flags the terminal
 * for attention, so a provider Genie cannot repair is visible instead of silent.
 *
 * PURE: the caller performs whatever this returns.
 */

import { PROVIDER_IDS, type AgentTuiId } from './registry';
import { genieEndpointServers } from '../mcp/genie-servers';

/** `` `a` ``, `` `a` and `b` ``, `` `a`, `b` and `c` `` — the servers, named. */
export function namedServers(servers: readonly string[]): string {
    const quoted = servers.map((name) => `\`${name}\``);
    if (quoted.length <= 1) return quoted[0] ?? '';
    return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * What an agent is told to do when Genie cannot reconnect it — the text behind
 * every `notice` strategy.
 *
 * Deliberately harness-agnostic about the HOW, because that is exactly the
 * situation it covers: Genie knows the connections are stale and does not know
 * this TUI's input grammar well enough to repair them without guessing. It is
 * not agnostic about WHAT, though — it names every server, because an agent
 * cannot reconnect one nobody told it about.
 */
export function manualReconnectNotice(servers: readonly string[]): string {
    return (
        `Reconnect ${namedServers(servers)} from inside this terminal — the upgrade replaced the ` +
        'process behind Genie\'s MCP endpoint, so every one of those connections is stale. Use ' +
        'your tool\'s own MCP reconnect command, or stop and relaunch the agent. Genie will not ' +
        'type a guessed command into a prompt it cannot read.'
    );
}

/**
 * The one command Claude Code takes to restore EVERY server the upgrade
 * replaced.
 *
 * Two constraints decide this, and together they leave one answer:
 *
 *  1. **Claude Code's grammar takes one name, or `all`.** Its own usage string
 *     is `/mcp [reconnect <server>|enable|disable [<server>|all]]`, and the
 *     handler compares the argument to `"all"` and otherwise looks up a single
 *     server by name. There is no `/mcp reconnect a b` form to reach for.
 *  2. **Genie gets exactly ONE typed command per upgrade.**
 *     `wakeTerminalIfIdle` stamps `lastWokenAt` when a nudge lands and
 *     `shouldWakeAgent` allows one wake per idle period, so a second command
 *     typed straight after the first is refused — by design. Nor can the agent
 *     run the leftover itself: `/mcp` is a built-in local command, not a
 *     model-invocable one, so "run this other one yourself" is advice a Claude
 *     agent cannot act on. That is what made the hard-coded single name a
 *     SILENT failure rather than a partial one.
 *
 * So a single server is named directly, and two or more can only be `all`.
 *
 * `all` is narrower than it looks: Claude Code filters the set to the servers
 * that need it, which is why it can answer *"All enabled MCP servers are
 * already connected or connecting."* A server that survived the upgrade is left
 * alone. That is read from the CLI's own strings, not from a run — Genie cannot
 * verify another program's behaviour, and nothing below claims the reconnect
 * worked.
 */
export function claudeReconnectCommand(servers: readonly string[]): string {
    return servers.length === 1 ? `/mcp reconnect ${servers[0]}` : '/mcp reconnect all';
}

/** What Genie does about it. */
export type ReconnectAction =
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
 * The action, plus WHAT it is for.
 *
 * `servers` rides on every variant rather than only the ones whose text names
 * them, because the upgrade notice states what was replaced separately from
 * what Genie did about it — and a restart repairs servers just as a typed
 * command does.
 */
export type ReconnectStrategy = ReconnectAction & {
    /** Every Genie-endpoint MCP server this agent has. All of them are stale. */
    servers: readonly string[];
};

/**
 * A recovery path for EVERY registered provider.
 *
 * `Record<AgentTuiId, …>` is the load-bearing part, and the reason this is a
 * table rather than an `if` chain: a provider added to `PROVIDER_IDS` stops
 * this file compiling until it has a path, so genie#346's "none is left on
 * `{kind:'none'}`" is enforced by the compiler instead of by memory.
 *
 * The entries are FUNCTIONS of that provider's server list (genie#613): the
 * table decides the repair, never the names.
 */
const RECONNECT_ACTIONS: Partial<
    Record<AgentTuiId, (servers: readonly string[]) => ReconnectAction>
> = {
    claude: (servers) => ({ kind: 'command', text: claudeReconnectCommand(servers) }),
    // Out of band, never typed. Codex parks on key-driven modals -- update
    // pickers, approval requests, trust prompts -- where injected text is read
    // as an answer, and on the update picker option 1 runs a global npm install.
    codex: () => ({ kind: 'restart' }),
    // Everything else falls to the manual notice below. That was already the
    // value for `kiwi`, `genie` and `custom`, and it is the right one for every
    // provider whose reconnect grammar Genie has not verified: no known command
    // to type, and no resumable restart, so a restart would cost the
    // conversation.
};

const KNOWN_PROVIDERS = new Set<string>(PROVIDER_IDS);

export function reconnectStrategy(provider: string | null | undefined): ReconnectStrategy {
    // Resolved whatever happens next, because an unknown provider still HAS an
    // MCP config: `genieEndpointServers` falls back to the `.mcp.json` set, the
    // same default the rest of the MCP surface uses for a TUI it cannot place.
    const servers = genieEndpointServers(typeof provider === 'string' ? provider : null);
    // An unknown or absent provider — a terminal from a newer build, or one
    // whose `meta.agent` never got written — must not fall off the end of the
    // table into silence. It is exactly the case the notice exists for.
    if (typeof provider !== 'string' || !KNOWN_PROVIDERS.has(provider)) {
        return { kind: 'notice', text: manualReconnectNotice(servers), servers };
    }
    // A KNOWN provider with no wired strategy lands on the same notice, and by
    // the same reasoning: the previous exhaustive table could not return
    // `undefined`, and neither can this. The `??` is what preserves that.
    const action: ReconnectAction = RECONNECT_ACTIONS[provider as AgentTuiId]?.(servers) ?? {
        kind: 'notice',
        text: manualReconnectNotice(servers),
    };
    return { ...action, servers };
}

/**
 * The TUI command that reconnects Genie's servers, or null when there is none.
 * Retained for callers that only handle the typed form.
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

/**
 * The recovery an agent gets when Genie could not act at all — a reconnect that
 * threw, a terminal it could not reach, a caller with no reconnect wiring.
 *
 * The provider is unknown in every one of those cases, so the servers are the
 * default set. Erring LONG is deliberate: naming a server this harness turns
 * out not to have costs one refused reconnect, and naming one too few is
 * genie#613 — a delivery channel left silently dead.
 */
export const MANUAL_RECOVERY: McpRecovery = {
    strategy: {
        kind: 'notice',
        text: manualReconnectNotice(genieEndpointServers(null)),
        servers: genieEndpointServers(null),
    },
    applied: false,
};

/**
 * PURE. The sentence the upgrade notice carries — what happened to this agent's
 * connections and what to do about it.
 *
 * Never asserts a connection is BACK. A typed `/mcp reconnect …` can still
 * fail, and a resumed terminal can still come up against a server that has not
 * finished binding; the agent finds out by calling a tool, not by being told.
 */
export function recoveryInstruction(recovery: McpRecovery): string {
    const { strategy, applied } = recovery;
    const named = namedServers(strategy.servers);
    const areOrIs = strategy.servers.length === 1 ? 'is' : 'are';
    if (strategy.kind === 'command') {
        return applied
            ? `Genie ran \`${strategy.text}\` in this terminal to restore ${named}. If any of them still does not answer, run \`${strategy.text}\` again yourself.`
            : `Run \`${strategy.text}\` in this terminal to restore ${named} — Genie held the command back rather than type over a prompt that was in use.`;
    }
    if (strategy.kind === 'restart') {
        return applied
            ? `Genie restarted this terminal against the new endpoint and resumed the session, so ${named} ${areOrIs} fresh.`
            : `Restart this agent so it picks up the new endpoint for ${named} — Genie could not do it for you (no resumable session was captured).`;
    }
    return strategy.text;
}
