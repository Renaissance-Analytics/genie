import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withClaudeAgentInboxChannelLaunch } from '../agent-config';

/**
 * The channel flag must not be promised into a workspace that cannot honour it.
 *
 * `--dangerously-load-development-channels server:genie-agentinbox-channel`
 * needs TWO things present in the workspace it launches into: an MCP entry of
 * that name, and the adapter it points at
 * (`.agents/_genie/agentinbox-claude-channel.cjs`). The flag was appended on
 * two conditions only — "the agent is claude" and "mcp sync is not off" —
 * neither of which says anything about either file.
 *
 * In the Genie OS workspace, which had neither, the result was a launch that
 * raised Claude Code's dangerous-channels prompt on EVERY start and then
 * reported `no MCP server configured with that name` (genie#319).
 *
 * Fixing the boot order means the OSA is wired now, so the flag will usually
 * resolve. This is the belt to that braces: a workspace that is not wired must
 * not be told to load a channel, because the cost of asking is a HITL prompt
 * the user has to answer before finding out it could not work.
 */

function workspace(withAdapter: boolean): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-chan-'));
    if (withAdapter) {
        const dir = path.join(root, '.agents', '_genie');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'agentinbox-claude-channel.cjs'), '// adapter\n');
    }
    return root;
}

describe('the AgentInbox channel flag checks its preconditions (#319)', () => {
    it('OMITS the flag when the workspace has no channel adapter', () => {
        const cmd = withClaudeAgentInboxChannelLaunch('claude', {
            agent: 'claude',
            mcpSyncClaudeOff: false,
            workspacePath: workspace(false),
        });

        expect(cmd).toBe('claude');
        expect(cmd).not.toContain('--dangerously-load-development-channels');
    });

    it('adds the flag when the adapter is actually there', () => {
        // POSITIVE CONTROL: without this the test above passes on a function
        // that never adds the flag at all.
        const cmd = withClaudeAgentInboxChannelLaunch('claude', {
            agent: 'claude',
            mcpSyncClaudeOff: false,
            workspacePath: workspace(true),
        });

        expect(cmd).toContain(
            '--dangerously-load-development-channels server:genie-agentinbox-channel',
        );
    });

    it('still refuses a non-claude agent even with the adapter present', () => {
        expect(
            withClaudeAgentInboxChannelLaunch('codex', {
                agent: 'codex',
                mcpSyncClaudeOff: false,
                workspacePath: workspace(true),
            }),
        ).toBe('codex');
    });

    it('still honours the mcp-sync-off opt-out with the adapter present', () => {
        expect(
            withClaudeAgentInboxChannelLaunch('claude', {
                agent: 'claude',
                mcpSyncClaudeOff: true,
                workspacePath: workspace(true),
            }),
        ).toBe('claude');
    });
});
