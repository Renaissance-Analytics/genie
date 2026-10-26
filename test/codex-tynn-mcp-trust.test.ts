import { expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { codexOptionsFor } from '../src/main/session-host.js';

it('approves the explicit private Tynn server for this Codex session on start and resume', () => {
    const agent = agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'codex', name: 'atlas' });
    const servers = [{ type: 'http' as const, name: 'tynn', url: 'https://tynn.ai/mcp/tynn', headers: [{ name: 'Authorization', value: 'Bearer synthetic-private' }] }];
    for (const resume of [null, 'thread-id']) {
        const options = codexOptionsFor(agent, '/workspace', resume, servers);
        expect(options.mcpServers === servers).toBe(true); expect(options.mcpToolApproval).toEqual({ tynn: 'approve' });
        expect(options.resumeSessionId ?? null).toBe(resume);
    }
    expect(codexOptionsFor(agent, '/workspace', null, []).mcpToolApproval).toBeUndefined();
});
