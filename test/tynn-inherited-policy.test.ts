import { expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';

const captured = vi.hoisted(() => [] as Array<{ provider: string; options: Record<string, unknown> }>);
vi.mock('@particle-academy/prism-acp', async (original) => ({
    ...await original<typeof import('@particle-academy/prism-acp')>(),
    ClaudeDriver: class { constructor(options: Record<string, unknown>) { captured.push({ provider: 'claude', options }); } },
    CodexDriver: class { constructor(options: Record<string, unknown>) { captured.push({ provider: 'codex', options }); } },
}));
import { realDriverFor } from '../src/main/session-host.js';

for (const provider of ['claude', 'codex'] as const) {
    it(`${provider} disables inherited Tynn when no private Tynn server was prepared`, () => {
        const agent = agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider, name: 'atlas' });
        const factory = realDriverFor(agent, '/workspace', null, { mcpServers: [{ type: 'http', name: 'genie', url: 'http://127.0.0.1:1/mcp', headers: [] }] });
        expect(factory).not.toBeNull(); factory!({ cwd: '/workspace', events: {} });
        expect(captured.at(-1)?.options.disabledMcpServers).toEqual(['tynn']);
    });
    it(`${provider} supplies the explicit private Tynn server without contradicting Prism's disabled policy`, () => {
        const agent = agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider, name: 'atlas' });
        const servers = [{ type: 'http' as const, name: 'tynn', url: 'https://tynn.ai/mcp/tynn', headers: [{ name: 'Authorization', value: 'Bearer synthetic-private' }] }];
        const factory = realDriverFor(agent, '/workspace', null, { mcpServers: servers });
        factory!({ cwd: '/workspace', events: {} });
        const options = captured.at(-1)!.options;
        expect(options.disabledMcpServers ?? []).toEqual([]);
        expect(options.mcpServers === servers).toBe(true);
        if (provider === 'claude') expect(options.permissionPrompts).toEqual({ tools: ['Bash', 'PowerShell'] });
    });
}
