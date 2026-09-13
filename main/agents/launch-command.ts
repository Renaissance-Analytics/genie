import { getAllSettings } from '../db';
import { appendLaunchFlags } from '../agentinbox/session-capture';
import {
    readTynnMcpUrl,
    withClaudeAgentInboxChannelLaunch,
    withCodexMcpLaunch,
} from '../mcp/agent-config';
import {
    resolveAgentCommand as resolveProviderCommand,
    resolveAgentFlags as resolveProviderFlags,
} from './command';
import type { AgentTuiId } from './registry';

/**
 * WHAT AN AGENT IS LAUNCHED WITH — for a new agent and for a saved one coming
 * back.
 *
 * These lived in `mcp/host-tools.ts`, which the relaunch path in
 * `terminal/ipc.ts` cannot import (host-tools imports it). So the relaunch
 * never reached the builder: it replayed whatever `meta.agent_command` held, and
 * when a migration had deleted that command it resumed a bare `claude` — no
 * always-on flags, and no AgentInbox channel. Here, both paths share one answer.
 */

/**
 * Resolve the CLI command for an agent type from the configurable settings, or
 * an explicit override. `custom` has no default — it needs an explicit command
 * (here or in Settings). Returns null when nothing resolves.
 */
export function resolveAgentCommand(agent: AgentTuiId, override?: string): string | null {
    // The DECISION lives in `agents/command.ts`, driven by TUI_REGISTRY
    // (genie#261). This is only the settings read.
    return resolveProviderCommand(agent, override, getAllSettings());
}

/**
 * Resolve an agent's FULL launch command: the base command
 * ({@link resolveAgentCommand}) plus the user's ALWAYS-ON flags for that agent
 * type (`agent_flags_<agent>` in Settings), appended after the command. Both
 * launch paths (specialized-terminal create + runAgent start) go through this so
 * the flags apply everywhere. The session-id flag is injected LATER (in
 * createAgentTerminal's `renderAgentLaunch`), giving the order
 * `<command> <flags> --session-id <uuid>` — and that injection already skips
 * adding a second `--session-id` if the user's flags happen to include one.
 * Returns null when no base command resolves (same contract as
 * resolveAgentCommand).
 */
export function resolveAgentLaunch(
    agent: AgentTuiId,
    override?: string,
    workspace?: { id: string; path: string },
): string | null {
    const base = resolveAgentCommand(agent, override);
    if (!base) return null;
    const s = getAllSettings();
    const withFlags = appendLaunchFlags(base, resolveProviderFlags(agent, s));
    // Without a workspace there are no URLs to resolve; the gate (Codex + sync-on)
    // itself lives in withCodexMcpLaunch so it's unit-tested off host-tools.
    if (!workspace) {
        return withFlags;
    }
    // Only the WORKSPACE-scoped Tynn override is baked here. The genie endpoint is
    // deliberately NOT: it must be the TERMINAL's own per-terminal URL so its token
    // self-identifies the terminal (genie #35) — a workspace-scoped genie URL makes
    // the server REFUSE every multi-terminal call lacking `terminalId`. The terminal
    // id doesn't exist yet at this point, so the genie `-c` override is woven in
    // later, at terminal-create time, via withCodexGenieMcpLaunch (see terminal/ipc).
    const withNativeInbox = withClaudeAgentInboxChannelLaunch(withFlags, {
        agent,
        mcpSyncClaudeOff: s.mcp_sync_claude === 'off',
        workspacePath: workspace.path,
    });
    return withCodexMcpLaunch(withNativeInbox, {
        agent,
        mcpSyncCodexOff: s.mcp_sync_codex === 'off',
        tynnUrl: readTynnMcpUrl(workspace.path),
    });
}

/**
 * The BASE command a SAVED agent relaunches with: its stored
 * `meta.agent_command`, completed by the builder where it falls short.
 *
 *  - **Missing** — a migration deleted it (v59, v65 sweep commands whose frozen
 *    flags went bad, so that "resolution falls through to the builder"). Rebuilt
 *    from current settings, exactly as a new agent's would be.
 *  - **Present** — kept as written, because it may be a command the owner chose.
 *    Only the AgentInbox channel opt-in is re-applied, and that function is
 *    idempotent: the channel is Genie's integration rather than part of the
 *    owner's command, it was only ever added when a command was first BUILT, and
 *    a command stored before the channel existed would otherwise relaunch
 *    without it for good. The owner's opt-out (`mcp_sync_claude: off`) and the
 *    bridge-file precondition still apply.
 *
 * Returns null when there is no agent, or nothing resolves.
 */
export function resolveSavedAgentLaunch(
    agent: AgentTuiId,
    storedCommand: string | null | undefined,
    workspace: { id: string; path: string } | null,
): string | null {
    const stored = typeof storedCommand === 'string' ? storedCommand.trim() : '';
    if (!stored) return resolveAgentLaunch(agent, undefined, workspace ?? undefined);
    if (!workspace) return stored;
    return withClaudeAgentInboxChannelLaunch(stored, {
        agent,
        mcpSyncClaudeOff: getAllSettings().mcp_sync_claude === 'off',
        workspacePath: workspace.path,
    });
}
