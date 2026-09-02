import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withClaudeAgentInboxChannelLaunch } from '../agent-config';

/**
 * The AgentInbox channel loads with the DEVELOPMENT flag, because nothing else
 * loads it at all.
 *
 * #324 moved this the other way. Claude Code's own warning suggests it —
 * *"Please use --channels to run a list of approved channels"* — and
 * `claude --channels` really does take `<servers...>`, so the swap looked like
 * a clean escape from a prompt that fires on every launch.
 *
 * IT DOES NOT LOAD OUR CHANNEL. The channels reference is explicit:
 *
 *   > During the research preview, every channel must be on the approved
 *   > allowlist to register... The bypass is per-entry. Combining this flag
 *   > with `--channels` doesn't extend the bypass to the `--channels` entries.
 *   > ...the approved allowlist is Anthropic-curated, so your channel stays on
 *   > the development flag while you build and test.
 *
 * The allowlist is the channel plugins in `claude-plugins-official`.
 * `genie-agentinbox-channel` is a bare `server:` entry of ours, so `--channels`
 * matches nothing — and the same page notes that when a session has not loaded
 * a server as a channel, "Claude Code drops the events silently and returns no
 * error to your server".
 *
 * So #324 traded a VISIBLE prompt for an INVISIBLE no-op: the flag looked
 * right, the launch stopped nagging, and channel delivery quietly stopped
 * working with nothing anywhere reporting it. That is strictly worse than the
 * problem it fixed, and it is why this file now asserts the opposite.
 *
 * Both flags are verified present in the installed CLI (2.1.258) even though
 * neither appears in `claude --help`.
 *
 * The prompt is real and is handled separately — Genie owns the pty it launches
 * into and answers its OWN channel's warning (see `dev-channel-consent.ts`).
 * Removing the flag is not an option: it is the only thing that registers the
 * channel.
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

describe('the channel loads with the development flag (#324 reversed)', () => {
    it('uses the development flag, which is the only one that registers a custom channel', () => {
        const cmd = withClaudeAgentInboxChannelLaunch('claude', wired());

        expect(cmd).toContain(
            '--dangerously-load-development-channels server:genie-agentinbox-channel',
        );
    });

    it('REPLACES a stale --channels flag on a command that already carries it', () => {
        // The mirror of what #324 did. Specs written while that shipped have
        // `--channels` baked into their stored command; appending the working
        // flag beside it would leave an entry that registers nothing and,
        // per the docs, does not extend the development bypass either.
        const stale = 'claude --dangerously-skip-permissions --channels server:genie-agentinbox-channel';

        const cmd = withClaudeAgentInboxChannelLaunch(stale, wired());

        expect(cmd).not.toContain('--channels server:genie-agentinbox-channel');
        expect(cmd).toContain(
            '--dangerously-load-development-channels server:genie-agentinbox-channel',
        );
        // POSITIVE CONTROL: the rest of the command survives the surgery.
        expect(cmd).toContain('--dangerously-skip-permissions');
    });

    it('is still idempotent — a second pass adds nothing', () => {
        const once = withClaudeAgentInboxChannelLaunch('claude', wired());
        const twice = withClaudeAgentInboxChannelLaunch(once, wired());

        expect(twice).toBe(once);
    });

    it('adds nothing for a non-claude agent', () => {
        const cmd = withClaudeAgentInboxChannelLaunch('codex', {
            agent: 'codex',
            mcpSyncClaudeOff: false,
            workspacePath: workspace(true),
        });

        expect(cmd).toBe('codex');
    });

    it('adds nothing when claude MCP sync is off', () => {
        const cmd = withClaudeAgentInboxChannelLaunch('claude', {
            agent: 'claude',
            mcpSyncClaudeOff: true,
            workspacePath: workspace(true),
        });

        expect(cmd).toBe('claude');
    });

    /**
     * genie#319 — the flag names an MCP server the workspace must actually
     * define. Without the adapter on disk, Claude Code raises the warning and
     * then reports `no MCP server configured with that name`: a prompt paid for
     * nothing. The adapter's presence is the honest precondition.
     */
    it('adds nothing when the workspace has no channel adapter', () => {
        const cmd = withClaudeAgentInboxChannelLaunch('claude', {
            agent: 'claude',
            mcpSyncClaudeOff: false,
            workspacePath: workspace(false),
        });

        expect(cmd).toBe('claude');
    });
});
