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
    return (await threadStart(record(), servers) as unknown as { config?: Record<string, unknown> }).config;
}

/** The thread/start params a real CodexDriver sends for this record (a fake App Server answers initialize). */
async function threadStart(rec: AgentRecord, servers: readonly McpServer[]): Promise<Record<string, unknown>> {
    let params: Record<string, unknown> | null = null;
    const driver = new CodexDriver(codexOptionsFor(rec, '/w', null, servers), {}, (_o, h) => ({
        start: async () => {},
        send: (frame) => {
            const f = frame as { id?: number; method?: string; params?: Record<string, unknown> };
            if (f.method === 'initialize') queueMicrotask(() => h.onFrame({ jsonrpc: '2.0', id: f.id, result: {} }));
            // The SDK reads effective policy before starting a thread with an explicit session bearer.
            if (f.method === 'config/read') queueMicrotask(() => h.onFrame({ jsonrpc: '2.0', id: f.id, result: { config: { mcp_servers: {}, shell_environment_policy: {} } } }));
            if (f.method === 'thread/start') params = f.params ?? {};
        },
        close: () => {},
    }));
    void Promise.resolve(driver.start()).catch(() => {});
    try {
        await vi.waitFor(() => expect(params).not.toBeNull());
        return params!;
    } finally { driver.kill(); }
}

describe('Codex runs Genie’s tools without asking — every server Genie passes it', () => {
    it('Genie’s server is approved: Codex gets default_tools_approval_mode "approve" for genie', async () => {
        const config = await threadStartConfig(genie);
        expect((config as { mcp_servers: Record<string, Record<string, unknown>> }).mcp_servers.genie!.default_tools_approval_mode).toBe('approve');
    });

    /*
     * EVERY SERVER GENIE PASSES IS GENIE'S OWN, AND IS APPROVED (2026-10-22). The list reaches here from `mcpServersFor`
     * alone — Genie's `genie` server and the `tynn` server Genie itself wrote into the workspace (#1098) — so approving
     * "genie only" declined the other one Genie had just handed the agent. prism-slave's ledger, 2026-10-22 20:56:36Z:
     * `Codex asked "tynn" for an answer this driver cannot give (form): Allow the tynn MCP server to run tool "project"?.
     * Declined. Set mcpToolApproval for "tynn" to let its tools run without asking.` A server a person wrote by hand lives
     * in Codex's own config.toml, is never in this list, and keeps Codex's default (prism-acp refuses an approval naming a
     * server it was not given, so a name outside the list cannot even be said here).
     */
    it('the tynn server Genie wrote for the agent is approved too — every server in the list is (the ledger case)', async () => {
        const tynn: McpServer = { type: 'http', name: 'tynn', url: 'https://tynn.ai/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] };
        expect(codexOptionsFor(record(), '/w', null, [...genie, tynn]).mcpToolApproval).toEqual({ genie: 'approve', tynn: 'approve' });
        const servers = (await threadStartConfig([...genie, tynn]) as { mcp_servers: Record<string, Record<string, unknown>> }).mcp_servers;
        expect(servers.genie!.default_tools_approval_mode).toBe('approve');
        expect(servers.tynn!.default_tools_approval_mode).toBe('approve');
        // The list is the contract: whatever Genie passes under any name is Genie's to approve.
        expect(codexOptionsFor(record(), '/w', null, [other]).mcpToolApproval).toEqual({ other: 'approve' });
    });

    it('no server (no MCP endpoint): no approval at all — prism refuses one naming a server it was not given', () => {
        expect(codexOptionsFor(record(), '/w', null, [])).not.toHaveProperty('mcpToolApproval');
        expect(() => new CodexDriver(codexOptionsFor(record(), '/w', null, []))).not.toThrow();
    });

    /*
     * YOLO FOR AN AUTONOMOUS CODEX AGENT (the owner, 2026-10-22: "make sure codex agents are using yolo mode"; "apparently
     * even when I have autonomous turned on for a codex agent, it still gets stuck" — tynn-slave parked 11 minutes on
     * `git -C .ai/sandbox/g-agent-ops fetch origin`). prism-acp 0.23.0 passes Codex's documented `approval_policy` and
     * `sandbox` on thread/start AND thread/resume. Autonomous on: `never` + `danger-full-access`, so Codex never raises
     * an approval and runs outside its sandbox — what a Claude agent with 'all tools' already has (bypassPermissions).
     * Autonomous off: nothing passed, Codex's own defaults (as today).
     */
    it('an Autonomous Codex agent runs with approvalPolicy never and sandbox danger-full-access; one that is not gets neither', () => {
        const yolo = codexOptionsFor(record({ autoApprove: true } as never), '/w', null, genie);
        expect(yolo.approvalPolicy).toBe('never');
        expect(yolo.sandbox).toBe('danger-full-access');
        const asking = codexOptionsFor(record({ autoApprove: false } as never), '/w', null, genie);
        expect(asking).not.toHaveProperty('approvalPolicy');
        expect(asking).not.toHaveProperty('sandbox');
        expect(codexOptionsFor(record(), '/w', null, genie)).not.toHaveProperty('approvalPolicy');
        // The driver takes the two (an invalid value throws at construction, prism 0.23.0): a real CodexDriver is built from them.
        expect(() => new CodexDriver(yolo)).not.toThrow();
    });

    it('what Codex receives: approval_policy never and sandbox danger-full-access on thread/start, for the Autonomous agent only', async () => {
        const config = (params: Record<string, unknown> | null) => params as unknown as { approvalPolicy?: unknown; sandbox?: unknown } | null;
        const started = await threadStart(record({ autoApprove: true } as never), genie);
        expect(config(started)?.approvalPolicy).toBe('never');
        expect(config(started)?.sandbox).toBe('danger-full-access');
        // Not Autonomous: prism's own default policy (`on-request`, what Codex does today) and no sandbox override at all.
        const asking = await threadStart(record(), genie);
        expect(config(asking)?.approvalPolicy).toBe('on-request');
        expect(config(asking)).not.toHaveProperty('sandbox');
    });

    it('keeps what it carried: cwd, resume, model, the servers', () => {
        expect(codexOptionsFor(record({ model: 'gpt-5' } as never), '/w', 'thr_1', genie)).toEqual({ cwd: '/w', resumeSessionId: 'thr_1', replayHistory: false, model: 'gpt-5', mcpServers: genie, mcpToolApproval: { genie: 'approve' } });
    });
});
