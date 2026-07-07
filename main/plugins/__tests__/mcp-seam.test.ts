import { describe, expect, it, vi } from 'vitest';
import {
    handleMcpMessage,
    type McpContext,
    type McpToolDescriptor,
    type McpToolCallResult,
} from '../../mcp/protocol';

/**
 * The generalized MCP `tools/list` + `tools/call` seam (§5.1), tested at the
 * PURE protocol layer with a stub context — no DB, no registry, no worker. This
 * proves the generalization itself: plugin descriptors are appended to the core
 * list, a namespaced call falls through to `dispatchPluginTool`, the plugin
 * surface is fail-closed, and errors are contained.
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
        provisionWorkspaces: vi.fn().mockResolvedValue({ ok: true, isOps: true, children: [] }),
        manageTerminals: vi.fn().mockResolvedValue({ ok: true, terminals: [] }),
        runAgent: vi.fn().mockResolvedValue({ ok: true }),
        manageWorkspaces: vi.fn().mockResolvedValue({ ok: true, workspaces: [] }),
        whisper: vi.fn().mockResolvedValue({ ok: true }),
        openFileForUser: vi.fn().mockResolvedValue({ ok: true, reused: false, openedNew: true }),
        setEnv: vi.fn().mockReturnValue({ ok: true, file: '.env' }),
        checkEnv: vi.fn().mockReturnValue({ ok: true, exists: false, file: '.env' }),
        isOpsProject: vi.fn().mockResolvedValue(false),
        ...over,
    };
}

const HELLO: McpToolDescriptor = {
    name: 'hello.greet',
    description: 'Return a greeting.',
    inputSchema: { type: 'object', properties: {} },
};

async function list(c: McpContext): Promise<string[]> {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, c);
    return (res?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
}

describe('tools/list plugin generalization', () => {
    it('appends enabled-plugin descriptors AFTER the core tools', async () => {
        const names = await list(ctx({ pluginTools: () => [HELLO] }));
        expect(names[0]).toBe('imDone'); // core still leads
        expect(names[names.length - 1]).toBe('hello.greet'); // plugin tools last
        expect(names).toContain('genieGuide');
    });

    it('WHEN a plugin appears it is listed; when it is gone the list drops it', async () => {
        expect(await list(ctx({ pluginTools: () => [HELLO] }))).toContain('hello.greet');
        expect(await list(ctx({ pluginTools: () => [] }))).not.toContain('hello.greet');
    });

    it('fails CLOSED — a throwing plugin registry never poisons the core list', async () => {
        const names = await list(
            ctx({
                pluginTools: () => {
                    throw new Error('registry down');
                },
            }),
        );
        // Core tools intact; nothing plugin-shaped leaks in.
        expect(names).toContain('imDone');
        expect(names).toContain('genieGuide');
        expect(names.some((n) => n.includes('.'))).toBe(false);
    });

    it('the core list is unchanged when no plugin hooks are provided', async () => {
        const names = await list(ctx());
        expect(names).toEqual([
            'imDone',
            'checkIssues',
            'ForceTheQuestion',
            'manageProcess',
            'manageTerminals',
            'runAgent',
            'manageWorkspaces',
            'whisper',
            'openFileForUser',
            'setEnv',
            'checkEnv',
            'genieGuide',
        ]);
    });
});

describe('tools/call plugin fall-through', () => {
    async function call(c: McpContext, name: string, args: Record<string, unknown> = {}) {
        return handleMcpMessage(
            { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
            c,
        );
    }

    it('routes a namespaced call to dispatchPluginTool and returns its content', async () => {
        const dispatch = vi
            .fn<(name: string, args: Record<string, unknown>, terminalId: string) => Promise<McpToolCallResult>>()
            .mockResolvedValue({ content: [{ type: 'text', text: 'Hello, world!' }] });
        const res = await call(ctx({ dispatchPluginTool: dispatch }), 'hello.greet', { name: 'world' });
        expect((res?.result as McpToolCallResult).content[0].text).toBe('Hello, world!');
        expect(dispatch).toHaveBeenCalledWith('hello.greet', { name: 'world' }, 'term-1');
    });

    it('propagates a contained isError result from the plugin', async () => {
        const dispatch = vi
            .fn()
            .mockResolvedValue({ content: [{ type: 'text', text: 'nope' }], isError: true });
        const res = await call(ctx({ dispatchPluginTool: dispatch }), 'hello.broken');
        expect((res?.result as McpToolCallResult).isError).toBe(true);
    });

    it('a thrown dispatcher becomes a JSON-RPC error, not an unhandled rejection', async () => {
        const dispatch = vi.fn().mockRejectedValue(new Error('worker crashed'));
        const res = await call(ctx({ dispatchPluginTool: dispatch }), 'hello.greet');
        expect(res?.error?.code).toBe(-32603);
        expect(res?.error?.message).toContain('worker crashed');
    });

    it('a NON-namespaced unknown tool stays a core -32602 (no plugin dispatch)', async () => {
        const dispatch = vi.fn().mockResolvedValue({ content: [] });
        const res = await call(ctx({ dispatchPluginTool: dispatch }), 'nope');
        expect(res?.error?.code).toBe(-32602);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('core tools are unaffected by the plugin fall-through', async () => {
        const dispatch = vi.fn();
        const res = await call(ctx({ dispatchPluginTool: dispatch }), 'imDone');
        expect((res?.result as McpToolCallResult).content[0].text).toContain('glowing');
        expect(dispatch).not.toHaveBeenCalled();
    });
});
