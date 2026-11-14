import { expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';

/**
 * THE OPTIONS HANDED TO THE PROVIDER'S DRIVER (Tynn #628): an MCP server switched off for an agent is in the
 * `disabledMcpServers` of THAT agent's launch, for Claude Code and for Codex, and in no other agent's. Genie's own server
 * is never in it. The drivers are stand-ins that keep what they were constructed with; nothing is launched.
 */
const captured = vi.hoisted(() => [] as Array<{ provider: string; options: Record<string, unknown> }>);
vi.mock('@particle-academy/prism-acp', async (original) => ({
    ...await original<typeof import('@particle-academy/prism-acp')>(),
    ClaudeDriver: class { constructor(options: Record<string, unknown>) { captured.push({ provider: 'claude', options }); } },
    CodexDriver: class { constructor(options: Record<string, unknown>) { captured.push({ provider: 'codex', options }); } },
}));
import { realDriverFor } from '../src/main/session-host.js';

const GENIE = [
    { type: 'http' as const, name: 'genie', url: 'http://127.0.0.1:1/mcp', headers: [] },
    { type: 'http' as const, name: 'tynn', url: 'https://tynn.ai/mcp/tynn', headers: [{ name: 'Authorization', value: 'Bearer synthetic-private' }] },
];
const launched = (record: ReturnType<typeof agentRecord>) => {
    realDriverFor(record, '/workspace', null, { mcpServers: GENIE })!({ cwd: '/workspace', events: {} });
    return captured.at(-1)!;
};

for (const provider of ['claude', 'codex'] as const) {
    const agent = (name: string, mcpOff?: readonly string[]) => ({ ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider, name }), ...(mcpOff ? { mcpOff } : {}) });

    it(`${provider}: a switched-off server is disabled in that agent's launch, and not in another agent's`, () => {
        const off = launched(agent('atlas', ['slack', 'claude.ai Drive']));
        expect(off.provider).toBe(provider);
        expect(off.options.disabledMcpServers).toEqual(['claude.ai Drive', 'slack']);
        expect(launched(agent('bolt')).options.disabledMcpServers ?? []).toEqual([]);
    });

    it(`${provider}: Genie's own servers are never disabled, whatever the record holds, and are still supplied`, () => {
        const got = launched(agent('atlas', ['genie', 'tynn', 'slack']));
        expect(got.options.disabledMcpServers).toEqual(['slack']);
        expect((got.options.mcpServers as Array<{ name: string }>).map((s) => s.name)).toEqual(['genie', 'tynn']);
    });

    it(`${provider}: switched back on, it is no longer disabled at the next launch`, () => {
        const record = agent('atlas', ['slack']);
        expect(launched(record).options.disabledMcpServers).toEqual(['slack']);
        expect(launched({ ...record, mcpOff: [] }).options.disabledMcpServers ?? []).toEqual([]);
    });
}
