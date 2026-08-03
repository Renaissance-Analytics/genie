import { describe, expect, it, vi } from 'vitest';
import { handleMcpMessage, manageServiceSummary, type McpContext } from '../protocol';
import type { ManageServiceRequest, ManageServiceResult } from '../protocol';

/**
 * `manageService inventory` — THE MACHINE's engines, for an agent.
 *
 * Everything else in `manageService` is scoped to a workspace. The shared
 * engines are not: one `postgres:16` container serves every workspace pinned to
 * Postgres 16, and its lifecycle is reference-counted across all of them. A
 * human has had a settings page for that since the workstation Services page
 * shipped; an agent had no way to ask at all, which is the gap this closes.
 *
 * The reason it matters is the same reason the human page exists: an agent that
 * cannot see the reference count will stop an engine that five other workspaces
 * are using and report success.
 */

function ctx(over: Partial<McpContext> = {}): McpContext {
    return {
        terminalId: 'term-1',
        serverName: 'genie',
        serverVersion: '0.7.0',
        onImDone: vi.fn(),
        checkIssues: vi.fn().mockResolvedValue({
            connected: true,
            workspaceResolved: true,
            counts: { issue: 0, pr: 0, security: 0 },
            items: [],
        }),
        onForceQuestion: vi.fn().mockResolvedValue({ cancelled: true, answers: [] }),
        describeWorkspace: vi.fn().mockResolvedValue(null),
        manageProcess: vi.fn().mockResolvedValue({ ok: true, processes: [] }),
        manageSite: vi.fn().mockResolvedValue({ ok: true, sites: [] }),
        manageService: vi.fn().mockResolvedValue({ ok: true, services: [] }),
        devServerAvailable: vi.fn().mockResolvedValue(true),
        provisionWorkspaces: vi.fn().mockResolvedValue({ ok: true, isOps: true, children: [] }),
        manageTerminals: vi.fn().mockResolvedValue({ ok: true, terminals: [] }),
        runAgent: vi.fn().mockResolvedValue({ ok: true }),
        manageWorkspaces: vi.fn().mockResolvedValue({ ok: true, workspaces: [] }),
        agentInbox: vi.fn().mockResolvedValue({ ok: true }),
        knowledge: vi.fn().mockResolvedValue({ ok: true }),
        openFileForUser: vi.fn().mockResolvedValue({ ok: true }),
        setEnv: vi.fn().mockReturnValue({ ok: true, file: '.env' }),
        checkEnv: vi.fn().mockReturnValue({ ok: true, exists: false, file: '.env' }),
        isOpsProject: vi.fn().mockResolvedValue(false),
        ...over,
    };
}

const call = (args: Partial<ManageServiceRequest>, over: Partial<McpContext> = {}) =>
    handleMcpMessage(
        {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'manageService', arguments: args },
        },
        ctx(over),
    );

const toolSchema = async () => {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx());
    const tools = (res?.result as { tools: Array<Record<string, never>> }).tools ?? [];
    return tools.find((t) => (t as unknown as { name: string }).name === 'manageService') as unknown as {
        description: string;
        inputSchema: { properties: { action: { enum: string[] } } };
    };
};

describe('the action exists and is reachable', () => {
    it('is offered in the tool schema', async () => {
        const tool = await toolSchema();
        expect(tool.inputSchema.properties.action.enum).toContain('inventory');
    });

    it('is described as MACHINE-level, so an agent knows it is not their workspace', async () => {
        const tool = await toolSchema();
        expect(tool.description).toMatch(/inventory/);
        expect(tool.description).toMatch(/machine|workstation/i);
    });

    it('passes through to the host with no workspace required', async () => {
        const manageService = vi
            .fn()
            .mockResolvedValue({ ok: true, services: [], engines: [] } as ManageServiceResult);
        await call({ action: 'inventory' }, { manageService });
        expect(manageService).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({ action: 'inventory' }),
        );
    });
});

describe('the result an agent reads', () => {
    it('carries every engine, with the reference count and WHO holds it', async () => {
        const manageService = vi.fn().mockResolvedValue({
            ok: true,
            services: [],
            engines: [
                {
                    recordKey: 'postgres-16',
                    engineKey: 'postgres-16',
                    engine: 'postgres',
                    version: '16',
                    label: 'PostgreSQL',
                    image: 'postgres:16-alpine',
                    containerName: 'genie-svc-postgres-16',
                    installed: true,
                    state: 'running',
                    dedicated: false,
                    holders: 3,
                    configured: 5,
                    workspaces: ['acme', 'beta', 'gamma'],
                },
            ],
        } as ManageServiceResult);
        const res = await call({ action: 'inventory' }, { manageService });
        const text = (res?.result as { content: Array<{ text: string }> }).content[0]?.text ?? '';
        const parsed = JSON.parse(text.slice(text.indexOf('{'))) as ManageServiceResult;
        expect(parsed.engines?.[0]?.holders).toBe(3);
        expect(parsed.engines?.[0]?.workspaces).toEqual(['acme', 'beta', 'gamma']);
    });

    it('the headline SAYS how many engines are up, not just that the call worked', () => {
        // A machine-level read whose summary is "ok" makes an agent parse JSON to
        // learn the one fact it asked for.
        const summary = manageServiceSummary({
            ok: true,
            services: [],
            engines: [
                { recordKey: 'a', engineKey: 'postgres-16', engine: 'postgres', version: '16', label: 'PostgreSQL', image: 'i', containerName: 'c', installed: true, state: 'running', dedicated: false, holders: 2, configured: 2, workspaces: ['x', 'y'] },
                { recordKey: 'b', engineKey: 'redis-7', engine: 'redis', version: '7', label: 'Redis', image: 'i', containerName: 'c', installed: true, state: 'absent', dedicated: false, holders: 0, configured: 0, workspaces: [] },
            ],
        } as ManageServiceResult);
        expect(summary).toMatch(/1 .*running/i);
    });
});
