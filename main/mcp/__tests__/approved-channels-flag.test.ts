import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withClaudeAgentInboxChannelLaunch } from '../agent-config';

/**
 * Load the AgentInbox channel as an APPROVED channel, not a development one.
 *
 * Genie launched every Claude agent with:
 *
 *     --dangerously-load-development-channels server:genie-agentinbox-channel
 *
 * That flag is interactive BY DESIGN. Claude Code stops on a warning —
 * "1. I am using this for local development / 2. Exit" — and waits, on EVERY
 * launch. For an agent a human starts that is an annoyance; for the Genie OS
 * agent, which Genie starts by itself, it is a wall: it relaunches, prompts,
 * and cannot get past its own boot without someone sitting there answering.
 *
 * Claude Code's own warning names the alternative:
 *
 *     Please use --channels to run a list of approved channels.
 *
 * and `claude --channels` confirms the flag is real:
 *
 *     error: option '--channels <servers...>' argument missing
 *
 * so the channel can be loaded without the prompt. Fixing #319's wiring was
 * necessary — the OSA workspace now really does carry the entry and the adapter
 * — but it only made the flag CORRECT to add, which left the prompt firing on
 * every launch instead of failing after it.
 */

function workspace(withAdapter: boolean): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-chan2-'));
    if (withAdapter) {
        const dir = path.join(root, '.agents', '_genie');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'agentinbox-claude-channel.cjs'), '// adapter\n');
    }
    return root;
}

const wired = () => ({ agent: 'claude', mcpSyncClaudeOff: false, workspacePath: workspace(true) });

describe('the channel loads as an approved channel (#324)', () => {
    it('uses --channels, never the interactive development flag', () => {
        const cmd = withClaudeAgentInboxChannelLaunch('claude', wired());

        expect(cmd).toContain('--channels server:genie-agentinbox-channel');
        expect(cmd).not.toContain('--dangerously-load-development-channels');
    });

    it('REPLACES the old development flag on a command that already carries it', () => {
        // Terminal specs written before this change have the dangerous flag
        // baked into their stored command. Appending the new one would leave
        // both, and the interactive one still prompts — so it must be removed,
        // not merely skipped.
        const stale =
            'claude --dangerously-skip-permissions ' +
            '--dangerously-load-development-channels server:genie-agentinbox-channel';

        const cmd = withClaudeAgentInboxChannelLaunch(stale, wired());

        expect(cmd).not.toContain('--dangerously-load-development-channels');
        expect(cmd).toContain('--channels server:genie-agentinbox-channel');
        // POSITIVE CONTROL: the rest of the command survives the surgery.
        expect(cmd).toContain('--dangerously-skip-permissions');
    });

    it('is still idempotent — a second pass adds nothing', () => {
        const once = withClaudeAgentInboxChannelLaunch('claude', wired());
        const twice = withClaudeAgentInboxChannelLaunch(once, wired());

        expect(twice).toBe(once);
    });

    it('still omits the flag entirely when the workspace has no adapter', () => {
        // POSITIVE CONTROL for #319: switching flags must not lose the
        // precondition check that stopped Genie promising a channel a workspace
        // cannot serve.
        const cmd = withClaudeAgentInboxChannelLaunch('claude', {
            agent: 'claude',
            mcpSyncClaudeOff: false,
            workspacePath: workspace(false),
        });

        expect(cmd).toBe('claude');
    });
});
