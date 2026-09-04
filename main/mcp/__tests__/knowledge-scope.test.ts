import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GENIE_SCOPE_KINDS } from '../../genie-scope';

/**
 * The `knowledge` MCP tool learns WHO is calling (spec §4.2, §10).
 *
 * `knowledgeForMcp` took a `_callerTerminalId` and deliberately ignored it, with
 * a docblock explaining that the store is workstation-wide so the caller does not
 * matter. That was true of a store with no scope. It is why every agent-written
 * memory landed in one undifferentiated pile: the tool COULD not say where a note
 * belonged, so no note said.
 *
 * Two things are pinned here, and the second is the one that must not rot:
 *
 *  1. The caller resolves through `callerWorkspaceIdFor` — the same resolver
 *     every other tool uses, which already handles terminals AND GApp callers —
 *     so reads narrow to the caller's own scopes and `add` files a note where the
 *     agent is actually working.
 *
 *  2. ★ A CROSS-SCOPE READ SUCCEEDS. `scope: 'all'` from a workspace-bound caller
 *     returns every node on the machine. Scope is noise reduction in agent
 *     reasoning; it is NOT a security boundary, and this test is what stops that
 *     becoming an assumption somebody later builds on.
 */

// --- the seams knowledgeForMcp reaches through ------------------------------

const store = vi.hoisted(() => ({
    search: vi.fn(() => []),
    searchPage: vi.fn(() => ({ results: [], nextCursor: null })),
    list: vi.fn(() => []),
    listPage: vi.fn(() => ({ nodes: [], nextCursor: null })),
    get: vi.fn(() => null),
    add: vi.fn(() => ({ id: 'new-node' })),
    link: vi.fn(() => ({ ok: true })),
}));

/** Terminal id → workspace, exactly as `getTerminalSpec` answers it. */
const specs = new Map<string, { id: string; workspace_id: string | null }>([
    ['term-in-ws', { id: 'term-in-ws', workspace_id: 'ws-1' }],
    ['term-loose', { id: 'term-loose', workspace_id: null }],
]);

const grants = new Map<string, { workspaceId: string; revoked: boolean }>([
    ['com.example.app', { workspaceId: 'ws-app', revoked: false }],
]);

vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] },
    app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', on: () => {} },
    ipcMain: { handle: () => {}, on: () => {} },
    shell: { openExternal: () => {} },
}));

vi.mock('../../db', () => ({
    listWorkspaces: () => [{ id: 'ws-1', path: '/ws', project_name: 'Demo' }],
    getWorkspace: (id: string) =>
        id === 'ws-1' ? { id: 'ws-1', path: '/ws', project_name: 'Demo' } : undefined,
    listTerminalSpecs: () => [...specs.values()],
    getTerminalSpec: (id: string) => specs.get(id) ?? null,
    createTerminalSpec: vi.fn(),
    updateTerminalSpec: vi.fn(),
    deleteTerminalSpec: vi.fn(),
    workspaceProcessApproval: () => false,
    workspaceTerminalApproval: () => true,
    workspaceScheduleApproval: () => false,
    getAllSettings: () => ({}),
    getWorkspaceIssuewatchPolicyBuckets: () => ({}),
    removeWorkspace: vi.fn(),
}));

vi.mock('../../apps/grant-lookup', () => ({
    appGrantFor: (appId: string) => grants.get(appId) ?? null,
}));

vi.mock('../../knowledge/store', () => ({ getKnowledgeStore: () => store }));

vi.mock('../../terminal/genie-adapter', () => ({
    dbSettingsProvider: () => ({ get: () => undefined }),
}));
vi.mock('../../ask/force-question', () => ({
    forceQuestion: async () => ({ cancelled: false, answers: [{ selected: ['Approve'] }] }),
}));
vi.mock('../../terminal/process-scheduler', () => ({
    armSchedule: vi.fn(),
    disarmSchedule: vi.fn(),
    forgetSchedule: vi.fn(),
    runScheduleNow: vi.fn(),
    nextRunAt: () => null,
}));
vi.mock('../../terminal/ipc', () => ({
    broadcastTerminalSpecsChanged: vi.fn(),
    killTerminalById: vi.fn(),
    createAgentTerminal: vi.fn(),
    decideAgentTerminalSpawn: vi.fn(),
    writeToTerminal: vi.fn(),
    readTerminalOutput: vi.fn(() => ({ data: '', cursor: 0 })),
    agentSessionTranscriptExists: vi.fn(),
    isTerminalLive: vi.fn(),
}));
vi.mock('../../workspace/detect', () => ({ detectFolder: () => ({ repos: [] }) }));
vi.mock('../../ipc', () => ({ broadcastWorkspacesChanged: vi.fn() }));
vi.mock('../../remote', () => ({ broadcastLocal: vi.fn() }));
vi.mock('../../mobile/server', () => ({ mobileEmit: vi.fn() }));
vi.mock('../../tray', () => ({
    rebuildMenu: vi.fn(),
    createTray: vi.fn(),
    setInboxBadge: vi.fn(),
    setUpdateAvailable: vi.fn(),
}));

import { knowledgeForMcp } from '../host-tools';
import { handleMcpMessage, type McpContext } from '../protocol';

beforeEach(() => {
    vi.clearAllMocks();
    store.search.mockReturnValue([]);
    store.searchPage.mockReturnValue({ results: [], nextCursor: null });
    store.list.mockReturnValue([]);
    store.listPage.mockReturnValue({ nodes: [], nextCursor: null });
    store.add.mockReturnValue({ id: 'new-node' });
});

describe('reads narrow to the caller’s own scopes', () => {
    it('a terminal in a workspace searches its workspace + system by default', async () => {
        await knowledgeForMcp('term-in-ws', { action: 'search', query: 'caddy' });

        expect(store.searchPage).toHaveBeenCalledWith(
            expect.objectContaining({
                query: 'caddy',
                scope: { kind: undefined, workspaceId: 'ws-1', appId: null },
            }),
        );
    });

    it('a GApp caller resolves to ITS granted workspace and its own app id', async () => {
        // The same resolver, one path — an installed app is not a second kind of
        // caller with a second answer to "where am I".
        await knowledgeForMcp('gapp:com.example.app', { action: 'list' });

        expect(store.listPage).toHaveBeenCalledWith(
            expect.objectContaining({
                scope: { kind: undefined, workspaceId: 'ws-app', appId: 'com.example.app' },
            }),
        );
    });

    it('a terminal in no workspace still reads — it just sees system only', async () => {
        await knowledgeForMcp('term-loose', { action: 'list' });

        expect(store.listPage).toHaveBeenCalledWith(
            expect.objectContaining({
                scope: { kind: undefined, workspaceId: null, appId: null },
            }),
        );
    });
});

describe('SCOPE IS NOT A SECURITY BOUNDARY', () => {
    it('`scope: all` from a workspace-bound caller SUCCEEDS and asks for everything', async () => {
        store.searchPage.mockReturnValue({
            results: [{ id: 'elsewhere', title: 'Another workspace’s note' }],
            nextCursor: null,
        } as never);

        const res = await knowledgeForMcp('term-in-ws', {
            action: 'search',
            query: 'caddy',
            scope: 'all',
        });

        expect(res.ok).toBe(true);
        expect(res.results).toHaveLength(1);
        expect(store.searchPage).toHaveBeenCalledWith(
            expect.objectContaining({ scope: expect.objectContaining({ kind: 'all' }) }),
        );
    });

    it('positive control — the same caller’s DEFAULT read is narrowed', async () => {
        // Without this, "all works" would also pass on a tool that ignored scope
        // entirely, which is the state this change is leaving.
        await knowledgeForMcp('term-in-ws', { action: 'search', query: 'caddy' });

        expect(store.searchPage).toHaveBeenCalledWith(
            expect.objectContaining({ scope: expect.objectContaining({ kind: undefined }) }),
        );
    });
});

describe('add files a memory where the agent is working', () => {
    it('defaults to the caller’s workspace', async () => {
        // A default does more encouraging than any amount of prose.
        await knowledgeForMcp('term-in-ws', { action: 'add', title: 'What we learned' });

        expect(store.add).toHaveBeenCalledWith(
            expect.objectContaining({ scope: { kind: 'workspace', workspaceId: 'ws-1' } }),
        );
    });

    it('defaults to system when the caller has no workspace', async () => {
        await knowledgeForMcp('term-loose', { action: 'add', title: 'Machine-wide' });

        expect(store.add).toHaveBeenCalledWith(
            expect.objectContaining({ scope: { kind: 'system' } }),
        );
    });

    it('honours an explicit `system` from a caller that has a workspace', async () => {
        await knowledgeForMcp('term-in-ws', {
            action: 'add',
            title: 'Everyone needs this',
            scope: 'system',
        });

        expect(store.add).toHaveBeenCalledWith(
            expect.objectContaining({ scope: { kind: 'system' } }),
        );
    });

    it('refuses `all` as a WRITE scope, naming what it is', async () => {
        // `all` is a question about what to read. There is no such place to put a
        // node, and silently picking one would file it somewhere nobody asked for.
        const res = await knowledgeForMcp('term-in-ws', {
            action: 'add',
            title: 'Nowhere',
            scope: 'all',
        });

        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/all/i);
        expect(store.add).not.toHaveBeenCalled();
    });

    it('refuses `gapp` scope from a caller that is not a GApp', async () => {
        const res = await knowledgeForMcp('term-in-ws', {
            action: 'add',
            title: 'App note',
            scope: 'gapp',
        });

        expect(res.ok).toBe(false);
        expect(store.add).not.toHaveBeenCalled();
    });

    it('a GApp writing at `gapp` scope files under its own app id', async () => {
        await knowledgeForMcp('gapp:com.example.app', {
            action: 'add',
            title: 'Internal',
            scope: 'gapp',
        });

        expect(store.add).toHaveBeenCalledWith(
            expect.objectContaining({ scope: { kind: 'gapp', appId: 'com.example.app' } }),
        );
    });
});

// --- what the tool ADVERTISES ----------------------------------------------

function ctx(): McpContext {
    return {
        terminalId: 'term-in-ws',
        serverName: 'genie',
        serverVersion: '0.0.0-test',
        onImDone: vi.fn(),
        checkIssues: vi.fn(),
        onForceQuestion: vi.fn(),
        describeWorkspace: vi.fn(),
        manageProcess: vi.fn(),
        provisionWorkspaces: vi.fn(),
        manageTerminals: vi.fn(),
        runAgent: vi.fn(),
        manageWorkspaces: vi.fn(),
        agentInbox: vi.fn(),
        knowledge: vi.fn().mockResolvedValue({ ok: true, results: [], nodes: [], id: 'n1' }),
        openFileForUser: vi.fn(),
        setEnv: vi.fn(),
        checkEnv: vi.fn(),
        isOpsProject: vi.fn().mockResolvedValue(false),
    } as unknown as McpContext;
}

async function advertised(): Promise<{
    description: string;
    properties: Record<string, { enum?: string[]; description?: string }>;
}> {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx());
    const tools = (res?.result as { tools: Array<{ name: string; description: string; inputSchema?: unknown }> })
        .tools;
    const tool = tools.find((t) => t.name === 'knowledge');
    if (!tool) throw new Error('knowledge tool not advertised');
    const schema = tool.inputSchema as {
        properties?: Record<string, { enum?: string[]; description?: string }>;
    };
    return { description: tool.description, properties: schema.properties ?? {} };
}

describe('the knowledge tool advertises scope, and says what it is not', () => {
    it('offers `scope` with exactly the three rungs plus `all`', async () => {
        const { properties } = await advertised();

        // Pinned to GENIE_SCOPE_KINDS, not to a literal: a rung added to the
        // ladder and not to the tool is the same silent gap the memory-class test
        // exists to close.
        expect([...(properties.scope?.enum ?? [])].sort()).toEqual(
            [...GENIE_SCOPE_KINDS, 'all'].sort(),
        );
    });

    it('states in the DESCRIPTION that scope is not a security boundary', async () => {
        // The most likely failure of this design is that somebody reads scope as
        // a permission. The sentence lives where an agent actually plans from.
        const { description } = await advertised();

        expect(description.toLowerCase()).toContain('not a security boundary');
    });

    it('names every rung in the description, so an agent knows they exist', async () => {
        const { description } = await advertised();

        for (const kind of GENIE_SCOPE_KINDS) {
            expect(description, `description never mentions ${kind}`).toContain(kind);
        }
    });
});
