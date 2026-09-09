import { describe, expect, it, vi } from 'vitest';
import { CORE_TOOLS, handleMcpMessage, type McpContext } from '../protocol';
import type { ListsResult } from '../../lists/types';

/**
 * The `lists` tool, and the half of the feature that has no tool call at all:
 * an unfinished AgentList RIDING `imDone`.
 *
 * That ride is the owner's spec — "it rides imDone" — and it is the part most
 * likely to rot silently. `imDone` composes its extras with `.filter(Boolean)`,
 * so a summary that returns the wrong empty value either vanishes from every
 * response or appends a blank line to every agent's finish. Neither shows up in
 * a test of the list itself, so both are pinned here, at the response an agent
 * actually reads.
 */

const EMPTY: ListsResult = {
    ok: true,
    agentName: 'lists',
    workspaceId: 'ws-1',
    agent: [],
    user: [],
};

function makeCtx(over: Partial<McpContext> = {}): McpContext {
    return {
        terminalId: 'term-1',
        serverName: 'genie',
        serverVersion: '0.0.0-test',
        onImDone: vi.fn().mockReturnValue({ attention: 1 }),
        checkIssues: vi.fn().mockResolvedValue({}),
        onForceQuestion: vi.fn(),
        describeWorkspace: vi.fn(),
        manageProcess: vi.fn(),
        provisionWorkspaces: vi.fn(),
        manageTerminals: vi.fn(),
        runAgent: vi.fn(),
        manageWorkspaces: vi.fn(),
        agentInbox: vi.fn(),
        knowledge: vi.fn(),
        openFileForUser: vi.fn(),
        setEnv: vi.fn(),
        checkEnv: vi.fn(),
        isOpsProject: vi.fn().mockResolvedValue(false),
        lists: vi.fn().mockReturnValue(EMPTY),
        ...over,
    } as unknown as McpContext;
}

async function call(ctx: McpContext, name: string, args: Record<string, unknown> = {}) {
    const res = await handleMcpMessage(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
        ctx,
    );
    return res as { result?: { content: { text: string }[] }; error?: { message: string } };
}

const textOf = (r: { result?: { content: { text: string }[] } }) =>
    (r.result?.content ?? []).map((c) => c.text).join('\n');

describe('the lists tool is advertised', () => {
    it('declares show / add / done / clear', () => {
        const tool = CORE_TOOLS.find((t) => t.name === 'lists') as
            | { inputSchema?: { properties?: { action?: { enum?: string[] } } } }
            | undefined;
        expect(tool, 'lists must be advertised in tools/list').toBeTruthy();
        expect(tool!.inputSchema?.properties?.action?.enum).toEqual([
            'show',
            'add',
            'done',
            'clear',
        ]);
    });

    it('says these lists never reach Tynn — the one thing the owner was explicit about', () => {
        const tool = CORE_TOOLS.find((t) => t.name === 'lists') as { description: string };
        expect(tool.description).toMatch(/Tynn/);
        expect(tool.description).toMatch(/local|never (?:sync|leaves)|not sync/i);
    });
});

describe('lists dispatches each action to the host', () => {
    it('forwards `add` with the text and the chosen list', async () => {
        const lists = vi.fn().mockReturnValue(EMPTY);
        const ctx = makeCtx({ lists });

        await call(ctx, 'lists', { action: 'add', list: 'user', text: 'Approve the login' });

        expect(lists).toHaveBeenCalledWith('term-1', {
            action: 'add',
            list: 'user',
            text: 'Approve the login',
        });
    });

    it('defaults `add` to the agent’s OWN list, which is the common case', async () => {
        const lists = vi.fn().mockReturnValue(EMPTY);
        const ctx = makeCtx({ lists });

        await call(ctx, 'lists', { action: 'add', text: 'Read the RFC' });

        expect(lists).toHaveBeenCalledWith('term-1', {
            action: 'add',
            list: 'agent',
            text: 'Read the RFC',
        });
    });

    it('forwards `done` with the item id', async () => {
        const lists = vi.fn().mockReturnValue(EMPTY);
        const ctx = makeCtx({ lists });

        await call(ctx, 'lists', { action: 'done', id: 'todo-7' });

        expect(lists).toHaveBeenCalledWith('term-1', { action: 'done', id: 'todo-7' });
    });

    it('refuses `add` with no text instead of adding an empty item', async () => {
        const lists = vi.fn().mockReturnValue(EMPTY);
        const ctx = makeCtx({ lists });

        const r = await call(ctx, 'lists', { action: 'add', text: '   ' });

        expect(r.error?.message ?? textOf(r)).toMatch(/text/i);
        expect(lists).not.toHaveBeenCalled();
    });

    it('refuses `done` with no id', async () => {
        const lists = vi.fn().mockReturnValue(EMPTY);
        const ctx = makeCtx({ lists });

        const r = await call(ctx, 'lists', { action: 'done' });

        expect(r.error?.message ?? textOf(r)).toMatch(/id/i);
        expect(lists).not.toHaveBeenCalled();
    });

    it('reports a host refusal as the host’s own sentence, not a generic failure', async () => {
        const ctx = makeCtx({
            lists: vi.fn().mockReturnValue({
                ok: false,
                error: 'this terminal is not attached to a Genie workspace, and a list is scoped to one',
            }),
        });

        const r = await call(ctx, 'lists', { action: 'show' });

        expect(textOf(r)).toMatch(/not attached to a Genie workspace/);
    });

    it('renders both lists with the ids `done` needs', async () => {
        const ctx = makeCtx({
            lists: vi.fn().mockReturnValue({
                ok: true,
                agentName: 'lists',
                workspaceId: 'ws-1',
                agent: [{ id: 'a-1', text: 'Read the RFC' }],
                user: [{ id: 'u-1', text: 'Approve the login', agentName: 'lists' }],
            } satisfies ListsResult),
        });

        const out = textOf(await call(ctx, 'lists', { action: 'show' }));

        expect(out).toMatch(/Read the RFC/);
        expect(out).toMatch(/a-1/);
        expect(out).toMatch(/Approve the login/);
        expect(out).toMatch(/u-1/);
    });
});

describe('an unfinished AgentList rides imDone', () => {
    it('appends the open items to the imDone response', async () => {
        const ctx = makeCtx({
            lists: vi.fn().mockReturnValue({
                ok: true,
                agentName: 'lists',
                workspaceId: 'ws-1',
                agent: [{ id: 'a-1', text: 'Read the RFC' }, { id: 'a-2', text: 'Write the test' }],
                user: [],
            } satisfies ListsResult),
        });

        const out = textOf(await call(ctx, 'imDone', {}));

        expect(out).toMatch(/2 items/);
        expect(out).toMatch(/Read the RFC/);
        expect(out).toMatch(/Write the test/);
    });

    it('adds NOTHING for an agent that keeps no list', async () => {
        // The positive control for the line above: "the summary is absent"
        // passes just as well against a feature that never appends anything, so
        // the SAME response shape must still carry the ordinary imDone text.
        const ctx = makeCtx();

        const out = textOf(await call(ctx, 'imDone', {}));

        expect(out).toMatch(/glowing in Genie/);
        expect(out).not.toMatch(/AgentList/);
        expect(out).not.toMatch(/\n\n\n/);
    });

    it('never sinks the imDone glow when reading the list throws', async () => {
        // The glow is what imDone exists for. A list that cannot be read is a
        // missing line, never a lost finish signal.
        const ctx = makeCtx({
            lists: vi.fn().mockImplementation(() => {
                throw new Error('db is gone');
            }),
        });

        const out = textOf(await call(ctx, 'imDone', {}));

        expect(out).toMatch(/glowing in Genie/);
    });
});
