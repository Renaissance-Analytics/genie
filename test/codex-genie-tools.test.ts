import { CodexDriver, type McpServer } from '@particle-academy/prism-acp';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { genieMcpServers } from '../src/main/mcp-callers.js';
import { codexOptionsFor } from '../src/main/session-host.js';

/**
 * CODEX AGENTS CAN USE GENIE'S TOOLS (Tynn #797). Codex asks before an MCP server's tools run (an elicitation), and a
 * session has nobody to answer it, so every Genie tool call from a Codex agent was declined. prism-acp 0.16.0's
 * `mcpToolApproval` sets Codex's documented `default_tools_approval_mode` per server. Genie approves its OWN server
 * and only that: Claude agents already run Genie's tools unasked (`bypassPermissions`), and every Genie tool that acts
 * for the person gates itself (manageTerminals write, services/processes add, gated plugin tools).
 *
 * Measured against the real CodexDriver with a fake App Server: what reaches Codex is the thread/start config.
 */
const record = (over: Partial<AgentRecord> = {}) => ({ id: 'ag_1', name: 'kai', provider: 'codex', workspaceId: 'w', permissions: 'all', model: null, ...over } as unknown as AgentRecord);
const genie = genieMcpServers({ url: 'http://127.0.0.1:7777/mcp', token: 'tok' }, 'key');
const other: McpServer = { type: 'http', name: 'other', url: 'http://example.test/mcp', headers: [] };

async function threadStartConfig(servers: readonly McpServer[]): Promise<Record<string, unknown> | undefined> {
    let params: Record<string, unknown> | null = null;
    const driver = new CodexDriver(codexOptionsFor(record(), '/w', null, servers), {}, (_o, h) => ({
        start: async () => {},
        send: (frame) => {
            const f = frame as { id?: number; method?: string; params?: Record<string, unknown> };
            if (f.method === 'initialize') queueMicrotask(() => h.onFrame({ jsonrpc: '2.0', id: f.id, result: {} }));
            if (f.method === 'thread/start') params = f.params ?? {};
        },
        close: () => {},
    }));
    void Promise.resolve(driver.start()).catch(() => {});
    await vi.waitFor(() => expect(params).not.toBeNull());
    driver.kill();
    return (params as unknown as { config?: Record<string, unknown> }).config;
}

describe('Codex runs Genie’s tools without asking — Genie’s server only', () => {
    it('Genie’s server is approved: Codex gets default_tools_approval_mode "approve" for genie', async () => {
        const config = await threadStartConfig(genie);
        expect((config as { mcp_servers: Record<string, Record<string, unknown>> }).mcp_servers.genie!.default_tools_approval_mode).toBe('approve');
    });

    it('any other server keeps Codex’s own default (CONTROL: same session, genie approved, other untouched)', async () => {
        const servers = (await threadStartConfig([...genie, other]) as { mcp_servers: Record<string, Record<string, unknown>> }).mcp_servers;
        expect(servers.genie!.default_tools_approval_mode).toBe('approve');
        expect(servers.other).toBeDefined();
        expect(servers.other!).not.toHaveProperty('default_tools_approval_mode');
    });

    it('no Genie server (no MCP endpoint): no approval at all — prism refuses one naming a server it was not given', () => {
        expect(codexOptionsFor(record(), '/w', null, [])).not.toHaveProperty('mcpToolApproval');
        expect(codexOptionsFor(record(), '/w', null, [other])).not.toHaveProperty('mcpToolApproval');
        expect(() => new CodexDriver(codexOptionsFor(record(), '/w', null, []))).not.toThrow();
    });

    it('keeps what it carried: cwd, resume, model, the servers', () => {
        expect(codexOptionsFor(record({ model: 'gpt-5' } as never), '/w', 'thr_1', genie)).toEqual({ cwd: '/w', resumeSessionId: 'thr_1', model: 'gpt-5', mcpServers: genie, mcpToolApproval: { genie: 'approve' } });
    });
});
