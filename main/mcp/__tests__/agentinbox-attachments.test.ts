import { describe, expect, it, vi } from 'vitest';
import { handleMcpMessage, type McpContext } from '../protocol';
import { GENIE_MCP_GUIDE } from '../guide';

/**
 * The `agentinbox` ATTACHMENT surface as agents actually meet it: the advertised
 * schema, the dispatch, and the guide that tells them it exists.
 *
 * A capability an agent is never told about is a capability that ships unused, so
 * the schema/guide assertions here matter as much as the dispatch ones.
 */

function ctx(overrides: Partial<McpContext> = {}): McpContext {
    return {
        terminalId: 'term-1',
        serverName: 'genie',
        serverVersion: '0.0.0-test',
        onImDone: vi.fn().mockReturnValue({ attention: 1 }),
        checkIssues: vi.fn(),
        onForceQuestion: vi.fn(),
        describeWorkspace: vi.fn(),
        manageProcess: vi.fn(),
        manageSite: vi.fn(),
        provisionWorkspaces: vi.fn(),
        manageTerminals: vi.fn(),
        runAgent: vi.fn(),
        manageWorkspaces: vi.fn(),
        agentInbox: vi.fn().mockResolvedValue({ ok: true }),
        knowledge: vi.fn(),
        openFileForUser: vi.fn(),
        setEnv: vi.fn(),
        checkEnv: vi.fn(),
        isOpsProject: vi.fn().mockResolvedValue(false),
        ...overrides,
    } as unknown as McpContext;
}

async function callTool(
    args: Record<string, unknown>,
    c: McpContext,
): Promise<{ error?: { code: number; message: string }; result?: unknown }> {
    const res = await handleMcpMessage(
        {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'agentinbox', arguments: args },
        },
        c,
    );
    return (res ?? {}) as { error?: { code: number; message: string }; result?: unknown };
}

async function agentInboxSchema(): Promise<{
    properties: Record<string, { enum?: string[]; type?: string; items?: unknown }>;
    description: string;
}> {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx());
    const tools = (
        res?.result as { tools: Array<{ name: string; description: string; inputSchema?: unknown }> }
    ).tools;
    const tool = tools.find((t) => t.name === 'agentinbox');
    if (!tool) throw new Error('agentinbox tool not advertised');
    return {
        properties: (tool.inputSchema as { properties: Record<string, { enum?: string[] }> })
            .properties,
        description: tool.description,
    };
}

describe('the advertised agentinbox schema', () => {
    it('offers saveAttachment as an action', async () => {
        const { properties } = await agentInboxSchema();
        expect(properties.action.enum).toContain('saveAttachment');
    });

    it('offers `attachments` on send as a list of paths', async () => {
        const { properties } = await agentInboxSchema();
        expect(properties.attachments?.type).toBe('array');
        expect(properties.attachmentId?.type).toBe('string');
        expect(properties.path?.type).toBe('string');
    });

    it('says in the description that files can be attached', async () => {
        const { description } = await agentInboxSchema();
        expect(description).toMatch(/attach/i);
    });
});

describe('agentinbox attachment dispatch', () => {
    it('forwards `attachments` on a send', async () => {
        const agentInbox = vi.fn().mockResolvedValue({ ok: true, delivered: 1 });
        await callTool(
            { action: 'send', to: 'peer', text: 'here', attachments: ['docs/spec.md'] },
            ctx({ agentInbox }),
        );
        expect(agentInbox).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({ action: 'send', attachments: ['docs/spec.md'] }),
        );
    });

    it('forwards saveAttachment with its id, destination and overwrite flag', async () => {
        const agentInbox = vi
            .fn()
            .mockResolvedValue({ ok: true, savedPath: 'inbox/spec.md', savedBytes: 12 });
        await callTool(
            { action: 'saveAttachment', attachmentId: 'a1', path: 'inbox/', overwrite: true },
            ctx({ agentInbox }),
        );
        expect(agentInbox).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({
                action: 'saveAttachment',
                attachmentId: 'a1',
                path: 'inbox/',
                overwrite: true,
            }),
        );
    });

    it('summarises a save with where the file landed', async () => {
        const res = await callTool(
            { action: 'saveAttachment', attachmentId: 'a1' },
            ctx({
                agentInbox: vi
                    .fn()
                    .mockResolvedValue({ ok: true, savedPath: 'inbox/spec.md', savedBytes: 12 }),
            }),
        );
        const text = (res.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('inbox/spec.md');
    });

    it('still rejects an action that does not exist', async () => {
        const res = await callTool({ action: 'exfiltrate' }, ctx());
        expect(res.error?.code).toBe(-32602);
    });
});

describe('the guide documents attachments', () => {
    it('documents every action the tool accepts', async () => {
        const { properties } = await agentInboxSchema();
        for (const action of properties.action.enum ?? []) {
            if (action === 'registerSession' || action === 'acknowledge') continue;
            // Both are native-adapter-only and deliberately undocumented to agents.
            expect(
                GENIE_MCP_GUIDE,
                `the guide never mentions the \`${action}\` action — an agent cannot use what it is not told about`,
            ).toContain(`\`${action}\``);
        }
    });

    it('tells agents attachments are read from their own workspace and saved into it', () => {
        expect(GENIE_MCP_GUIDE).toMatch(/`attachments`/);
        expect(GENIE_MCP_GUIDE).toMatch(/workspace/i);
    });
});
