import { describe, expect, it } from 'vitest';
import { HOST_SOURCED_SETTINGS_KEYS, pickHostSettings } from '../api';
import type { Settings } from '../../db';

/**
 * The host-sourced settings allow-list (bucket 2) a remote DESKTOP may read + write
 * on this host. `pickHostSettings` is the server-side filter behind GET/POST
 * /api/desktop/settings; it MUST expose only the workspace/agent-environment keys and
 * NEVER leak host-machine or secret keys (github token, updater repo, the client's
 * own tynn_host, …). Pure (no DB) so the allow-list is asserted directly.
 */
describe('pickHostSettings — host-sourced allow-list', () => {
    it('keeps exactly the bucket-2 workspace/agent-environment keys', () => {
        expect([...HOST_SOURCED_SETTINGS_KEYS].sort()).toEqual(
            [
                'ai_system',
                'cli_tools_in_terminals',
                'mcp_port',
                'mcp_sync_agents',
                'mcp_sync_claude',
                'mcp_sync_codex',
                'mcp_sync_cursor',
                'agent_command_claude',
                'agent_flags_claude',
                'agent_command_codex',
                'agent_flags_codex',
                'agent_command_custom',
                'agent_flags_custom',
            ].sort(),
        );
    });

    it('exposes the bucket-2 keys and drops everything else (incl. secrets)', () => {
        const all = {
            // bucket 2 — kept:
            ai_system: 'Prefer TypeScript.',
            cli_tools_in_terminals: 'on',
            mcp_port: '51717',
            mcp_sync_claude: 'on',
            mcp_sync_cursor: 'off',
            mcp_sync_codex: 'on',
            mcp_sync_agents: 'on',
            agent_command_claude: 'claude',
            agent_flags_claude: '--dangerously-skip-permissions',
            agent_command_codex: 'codex',
            agent_flags_codex: '--yolo',
            agent_command_custom: 'my-agent',
            agent_flags_custom: '--interactive',
            // host-machine / device / secret — must NOT leak:
            primary_workspace: '/host/only/path',
            tynn_host: 'https://tynn.ai',
            notify_sound: 'on',
            terminal_copy_paste: 'winmac',
            remote_enabled: 'on',
            github_token_enc: 'SECRET',
            updater_repo: 'owner/repo',
        } as unknown as Settings;

        const picked = pickHostSettings(all);

        expect(picked).toEqual({
            ai_system: 'Prefer TypeScript.',
            cli_tools_in_terminals: 'on',
            mcp_port: '51717',
            mcp_sync_claude: 'on',
            mcp_sync_cursor: 'off',
            mcp_sync_codex: 'on',
            mcp_sync_agents: 'on',
            agent_command_claude: 'claude',
            agent_flags_claude: '--dangerously-skip-permissions',
            agent_command_codex: 'codex',
            agent_flags_codex: '--yolo',
            agent_command_custom: 'my-agent',
            agent_flags_custom: '--interactive',
        });
        // Explicit: no secret / host-machine key survives the filter.
        expect('github_token_enc' in picked).toBe(false);
        expect('primary_workspace' in picked).toBe(false);
        expect('tynn_host' in picked).toBe(false);
    });

    it('omits keys the host has not set (undefined)', () => {
        const picked = pickHostSettings({ ai_system: 'x' } as unknown as Settings);
        expect(picked).toEqual({ ai_system: 'x' });
        expect('mcp_port' in picked).toBe(false);
    });
});
