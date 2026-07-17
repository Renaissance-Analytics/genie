import { describe, expect, it, vi } from 'vitest';
import {
    MCP_PROTOCOL_VERSION,
    handleMcpMessage,
    type McpContext,
} from '../protocol';

function ctx(overrides: Partial<McpContext> = {}): McpContext {
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
        provisionWorkspaces: vi
            .fn()
            .mockResolvedValue({ ok: true, isOps: true, children: [] }),
        manageTerminals: vi
            .fn()
            .mockResolvedValue({ ok: true, terminals: [] }),
        runAgent: vi.fn().mockResolvedValue({ ok: true }),
        manageWorkspaces: vi
            .fn()
            .mockResolvedValue({ ok: true, workspaces: [] }),
        agentInbox: vi.fn().mockResolvedValue({ ok: true }),
        knowledge: vi.fn().mockResolvedValue({ ok: true }),
        openFileForUser: vi
            .fn()
            .mockResolvedValue({ ok: true, reused: false, openedNew: true }),
        setEnv: vi.fn().mockReturnValue({ ok: true, file: '.env' }),
        checkEnv: vi.fn().mockReturnValue({ ok: true, exists: false, file: '.env' }),
        isOpsProject: vi.fn().mockResolvedValue(false),
        ...overrides,
    };
}

describe('handleMcpMessage', () => {
    it('answers initialize with the protocol version + serverInfo', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 1, method: 'initialize' },
            ctx(),
        );
        expect(res).toMatchObject({
            id: 1,
            result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                serverInfo: { name: 'genie', version: '0.7.0' },
            },
        });
    });

    it('returns null (no body) for the initialized notification', async () => {
        expect(
            await handleMcpMessage(
                { jsonrpc: '2.0', method: 'notifications/initialized' },
                ctx(),
            ),
        ).toBeNull();
    });

    it('lists provisionWorkspaces for an Ops project (full set; NOT initializeWorkspace — it is a prompt)', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            ctx({ isOpsProject: vi.fn().mockResolvedValue(true) }),
        );
        const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
        expect(tools.map((t) => t.name)).toEqual([
            'imDone',
            'checkIssues',
            'ForceTheQuestion',
            'manageProcess',
            'provisionWorkspaces',
            'manageTerminals',
            'runAgent',
            'manageWorkspaces',
            'agentinbox',
            'knowledge',
            'openFileForUser',
            'setEnv',
            'checkEnv',
            'genieGuide',
        ]);
        expect(tools.map((t) => t.name)).not.toContain('initializeWorkspace');
    });

    it('OMITS the ops-only provisionWorkspaces tool for a non-Ops workspace', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            ctx({ isOpsProject: vi.fn().mockResolvedValue(false) }),
        );
        const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
        expect(tools.map((t) => t.name)).toEqual([
            'imDone',
            'checkIssues',
            'ForceTheQuestion',
            'manageProcess',
            'manageTerminals',
            'runAgent',
            'manageWorkspaces',
            'agentinbox',
            'knowledge',
            'openFileForUser',
            'setEnv',
            'checkEnv',
            'genieGuide',
        ]);
    });

    it('fails CLOSED — omits provisionWorkspaces when the ops check throws', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            ctx({ isOpsProject: vi.fn().mockRejectedValue(new Error('backend down')) }),
        );
        const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
        expect(tools.map((t) => t.name)).not.toContain('provisionWorkspaces');
    });

    it('advertises the prompts capability on initialize', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 20, method: 'initialize' },
            ctx(),
        );
        const caps = (res?.result as { capabilities: Record<string, unknown> }).capabilities;
        expect(caps.prompts).toBeDefined();
        expect(caps.tools).toBeDefined();
    });

    it('lists the initializeWorkspace prompt via prompts/list', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 21, method: 'prompts/list' },
            ctx(),
        );
        const prompts = (res?.result as { prompts: Array<{ name: string }> }).prompts;
        expect(prompts.map((p) => p.name)).toEqual(['initializeWorkspace']);
    });

    it('prompts/get initializeWorkspace routes to describeWorkspace and returns map + plan messages', async () => {
        const describeWorkspace = vi.fn().mockResolvedValue({
            root: '/ws/demo.agi',
            isAgiEnvelope: true,
            hasProjectJson: true,
            hasGitmodules: true,
            knowledgeDir: '/ws/demo.agi/.ai/knowledge',
            envelopeAgents: '/ws/demo.agi/AGENTS.md',
            envelopeClaude: '/ws/demo.agi/CLAUDE.md',
            repos: [
                {
                    name: 'api',
                    path: '/ws/demo.agi/repos/api',
                    owner: 'acme',
                    repo: 'api',
                    orientation: { readme: true, agents: false, claude: false, manifests: ['composer.json'] },
                },
            ],
        });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 22,
                method: 'prompts/get',
                params: { name: 'initializeWorkspace' },
            },
            ctx({ terminalId: 'term-X', describeWorkspace }),
        );
        expect(describeWorkspace).toHaveBeenCalledWith('term-X');
        const messages = (res?.result as { messages: Array<{ role: string; content: { text: string } }> }).messages;
        expect(messages.length).toBeGreaterThan(0);
        const text = messages[0].content.text;
        expect(text).toContain('acme/api'); // the repo's GitHub ref
        expect(text).toContain('How to learn this workspace'); // the numbered plan
        expect(text).toContain('"isAgiEnvelope": true'); // machine-parseable JSON block
    });

    it('prompts/get explains when the terminal maps to no workspace', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 23, method: 'prompts/get', params: { name: 'initializeWorkspace' } },
            ctx({ describeWorkspace: vi.fn().mockResolvedValue(null) }),
        );
        const messages = (res?.result as { messages: Array<{ content: { text: string } }> }).messages;
        expect(messages[0].content.text).toContain("Couldn't resolve this terminal");
    });

    it('prompts/get errors on an unknown prompt name', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 24, method: 'prompts/get', params: { name: 'nope' } },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32602);
    });

    it('manageProcess routes to the dep and returns its result', async () => {
        const manageProcess = vi.fn().mockResolvedValue({
            ok: true,
            affectedId: 'p-1',
            processes: [
                { id: 'p-1', label: 'dev', command: 'npm run dev', status: 'running', autostart: false, cwd: '' },
            ],
        });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 25,
                method: 'tools/call',
                params: {
                    name: 'manageProcess',
                    arguments: { action: 'create', label: 'dev', command: 'npm run dev', terminalId: 'term-X' },
                },
            },
            ctx({ terminalId: 'term-X', manageProcess }),
        );
        expect(manageProcess).toHaveBeenCalledWith('term-X', {
            action: 'create',
            label: 'dev',
            command: 'npm run dev',
            repo: undefined,
            autostart: undefined,
            processId: undefined,
        });
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('process'); // summary line
        expect(text).toContain('npm run dev'); // the JSON block
    });

    it('manageProcess accepts `id` as the process id (issue #7 — list returns `id`)', async () => {
        const manageProcess = vi.fn().mockResolvedValue({ ok: true, affectedId: 'p-9', processes: [] });
        await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 27,
                method: 'tools/call',
                params: { name: 'manageProcess', arguments: { action: 'restart', id: 'p-9' } },
            },
            ctx({ terminalId: 'term-X', manageProcess }),
        );
        // The `id` a caller copied from a `list` result must reach the handler as
        // processId — previously dropped, so restart/stop failed with No process "".
        expect(manageProcess).toHaveBeenCalledWith('term-X', expect.objectContaining({
            action: 'restart',
            processId: 'p-9',
        }));
    });

    it('manageProcess still accepts the legacy `processId` alias', async () => {
        const manageProcess = vi.fn().mockResolvedValue({ ok: true, processes: [] });
        await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 28,
                method: 'tools/call',
                params: { name: 'manageProcess', arguments: { action: 'stop', processId: 'p-legacy' } },
            },
            ctx({ terminalId: 'term-X', manageProcess }),
        );
        expect(manageProcess).toHaveBeenCalledWith('term-X', expect.objectContaining({
            action: 'stop',
            processId: 'p-legacy',
        }));
    });

    it('manageProcess prefers `id` over `processId` when both are sent', async () => {
        const manageProcess = vi.fn().mockResolvedValue({ ok: true, processes: [] });
        await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 29,
                method: 'tools/call',
                params: { name: 'manageProcess', arguments: { action: 'stop', id: 'p-new', processId: 'p-old' } },
            },
            ctx({ terminalId: 'term-X', manageProcess }),
        );
        expect(manageProcess).toHaveBeenCalledWith('term-X', expect.objectContaining({ processId: 'p-new' }));
    });

    it('manageProcess rejects a bad/missing action', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 26, method: 'tools/call', params: { name: 'manageProcess', arguments: {} } },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32602);
    });

    it('openFileForUser routes to the dep and reports reuse vs new', async () => {
        const openFileForUser = vi.fn().mockResolvedValue({
            ok: true,
            file: '/ws/app/src/index.ts',
            workspaceId: 'ws1',
            reused: true,
            openedNew: false,
        });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 27,
                method: 'tools/call',
                params: {
                    name: 'openFileForUser',
                    arguments: { path: 'src/index.ts', line: 12, terminalId: 'term-X' },
                },
            },
            ctx({ terminalId: 'term-X', openFileForUser }),
        );
        expect(openFileForUser).toHaveBeenCalledWith('term-X', { path: 'src/index.ts', line: 12 });
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('reused the editor panel');
        expect(text).toContain('/ws/app/src/index.ts'); // the JSON block
    });

    it('openFileForUser requires a path', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 28, method: 'tools/call', params: { name: 'openFileForUser', arguments: {} } },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32602);
    });

    it('setEnv routes key/value/target to the dep', async () => {
        const setEnv = vi.fn().mockReturnValue({ ok: true, file: 'repos/web/.env' });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 40,
                method: 'tools/call',
                params: { name: 'setEnv', arguments: { key: 'API_KEY', value: 'rpk_x', target: 'web', terminalId: 'term-X' } },
            },
            ctx({ terminalId: 'term-X', setEnv }),
        );
        expect(setEnv).toHaveBeenCalledWith('term-X', { key: 'API_KEY', value: 'rpk_x', target: 'web' });
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('Set API_KEY in repos/web/.env');
    });

    it('setEnv requires a key and a string value', async () => {
        const noKey = await handleMcpMessage(
            { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'setEnv', arguments: { value: 'x' } } },
            ctx(),
        );
        expect(noKey?.error?.code).toBe(-32602);
        const noVal = await handleMcpMessage(
            { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'setEnv', arguments: { key: 'K' } } },
            ctx(),
        );
        expect(noVal?.error?.code).toBe(-32602);
    });

    it('checkEnv defaults to a presence check; passes value/force through', async () => {
        const checkEnv = vi.fn().mockReturnValue({ ok: true, exists: true, isSecret: true, file: '.env' });
        await handleMcpMessage(
            { jsonrpc: '2.0', id: 43, method: 'tools/call', params: { name: 'checkEnv', arguments: { key: 'TOK' } } },
            ctx({ checkEnv }),
        );
        expect(checkEnv).toHaveBeenCalledWith('term-1', { key: 'TOK', target: undefined, value: false, force: false });
        await handleMcpMessage(
            { jsonrpc: '2.0', id: 44, method: 'tools/call', params: { name: 'checkEnv', arguments: { key: 'TOK', value: true, force: true } } },
            ctx({ checkEnv }),
        );
        expect(checkEnv).toHaveBeenLastCalledWith('term-1', { key: 'TOK', target: undefined, value: true, force: true });
    });

    it('provisionWorkspaces routes to the dep and summarizes children', async () => {
        const provisionWorkspaces = vi.fn().mockResolvedValue({
            ok: true,
            isOps: true,
            children: [
                { projectId: 'c1', name: 'Child One', status: 'present', cloneUrl: null },
                {
                    projectId: 'c2',
                    name: 'Child Two',
                    status: 'missing',
                    cloneUrl: 'https://github.com/o/child-two.agi.git',
                },
            ],
        });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 30,
                method: 'tools/call',
                params: {
                    name: 'provisionWorkspaces',
                    arguments: { action: 'status', terminalId: 'term-Y' },
                },
            },
            ctx({ terminalId: 'term-Y', provisionWorkspaces }),
        );
        expect(provisionWorkspaces).toHaveBeenCalledWith('term-Y', { action: 'status' });
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('1 present, 1 missing');
        expect(text).toContain('child-two.agi.git'); // the JSON block
    });

    it('provisionWorkspaces surfaces a clear not-an-ops message', async () => {
        const provisionWorkspaces = vi.fn().mockResolvedValue({
            ok: false,
            isOps: false,
            children: [],
            error: 'This workspace is not an Ops project, so it has no governed child projects to provision.',
        });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 31,
                method: 'tools/call',
                params: { name: 'provisionWorkspaces', arguments: { action: 'status' } },
            },
            ctx({ provisionWorkspaces }),
        );
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('failed');
        expect(text).toContain('not an Ops project');
    });

    it('provisionWorkspaces rejects a bad/missing action', async () => {
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 32,
                method: 'tools/call',
                params: { name: 'provisionWorkspaces', arguments: {} },
            },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32602);
    });

    it('manageTerminals routes to the dep and summarizes a create', async () => {
        const manageTerminals = vi.fn().mockResolvedValue({
            ok: true,
            affectedId: 't-new',
            terminals: [{ id: 't-new', label: 'Agent terminal', cwd: '', agent: null }],
            data: 'hello',
            cursor: 5,
        });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 40,
                method: 'tools/call',
                params: {
                    name: 'manageTerminals',
                    arguments: { action: 'create', label: 'Agent terminal', terminalId: 'term-X' },
                },
            },
            ctx({ terminalId: 'term-X', manageTerminals }),
        );
        expect(manageTerminals).toHaveBeenCalledWith('term-X', {
            action: 'create',
            workspaceId: undefined,
            repo: undefined,
            cwd: undefined,
            label: 'Agent terminal',
            id: undefined,
            data: undefined,
            submit: undefined,
            key: undefined,
            cursor: undefined,
            bytes: undefined,
            strip: undefined,
        });
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('terminal'); // summary line
        expect(text).toContain('t-new'); // JSON block
    });

    it('manageTerminals summarizes a read with its byte count', async () => {
        const manageTerminals = vi.fn().mockResolvedValue({
            ok: true,
            terminals: [],
            data: 'abcdef',
            cursor: 6,
            dropped: true,
        });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 41,
                method: 'tools/call',
                params: { name: 'manageTerminals', arguments: { action: 'read', id: 't-1' } },
            },
            ctx({ manageTerminals }),
        );
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('Read 6 byte');
        expect(text).toContain('dropped');
    });

    it('manageTerminals rejects a bad/missing action', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'manageTerminals', arguments: {} } },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32602);
    });

    it('runAgent routes to the dep and summarizes a start', async () => {
        const runAgent = vi.fn().mockResolvedValue({
            ok: true,
            id: 'a-1',
            agent: 'claude',
            command: 'claude',
        });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 43,
                method: 'tools/call',
                params: {
                    name: 'runAgent',
                    arguments: { action: 'start', agent: 'claude', terminalId: 'term-Z' },
                },
            },
            ctx({ terminalId: 'term-Z', runAgent }),
        );
        expect(runAgent).toHaveBeenCalledWith('term-Z', {
            action: 'start',
            workspaceId: undefined,
            agent: 'claude',
            command: undefined,
            repo: undefined,
            cwd: undefined,
            id: undefined,
            prompt: undefined,
            submit: undefined,
            key: undefined,
            cursor: undefined,
            bytes: undefined,
            strip: undefined,
        });
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('Launched claude');
        expect(text).toContain('a-1');
    });

    it('runAgent routes a restart to the dep (wish #88) and reports the new terminal', async () => {
        const runAgent = vi.fn().mockResolvedValue({
            ok: true,
            id: 'a-2',
            agent: 'claude',
            command: 'claude --resume sid',
        });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 45,
                method: 'tools/call',
                params: { name: 'runAgent', arguments: { action: 'restart', id: 'a-1' } },
            },
            ctx({ terminalId: 'term-Z', runAgent }),
        );
        expect(runAgent).toHaveBeenCalledWith('term-Z', expect.objectContaining({
            action: 'restart',
            id: 'a-1',
        }));
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('restart ok');
        expect(text).toContain('a-2'); // the NEW terminal id
    });

    it('runAgent rejects an unknown action', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 46, method: 'tools/call', params: { name: 'runAgent', arguments: { action: 'nope' } } },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32602);
    });

    it('runAgent surfaces a failure (no command configured)', async () => {
        const runAgent = vi.fn().mockResolvedValue({
            ok: false,
            error: 'No command configured for agent "custom".',
        });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 44,
                method: 'tools/call',
                params: { name: 'runAgent', arguments: { action: 'start', agent: 'custom' } },
            },
            ctx({ runAgent }),
        );
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('failed');
    });

    it('runAgent rejects a bad/missing action', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 45, method: 'tools/call', params: { name: 'runAgent', arguments: {} } },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32602);
    });

    it('runAgent send plumbs submit/key/strip through to the dep', async () => {
        const runAgent = vi.fn().mockResolvedValue({ ok: true, id: 'a-1' });
        await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 46,
                method: 'tools/call',
                params: {
                    name: 'runAgent',
                    arguments: { action: 'send', id: 'a-1', prompt: 'hi', submit: false, key: 'enter' },
                },
            },
            ctx({ runAgent }),
        );
        expect(runAgent).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({ action: 'send', prompt: 'hi', submit: false, key: 'enter' }),
        );
    });

    it('manageTerminals write plumbs submit/key, read plumbs strip', async () => {
        const manageTerminals = vi.fn().mockResolvedValue({ ok: true, terminals: [] });
        await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 47,
                method: 'tools/call',
                params: {
                    name: 'manageTerminals',
                    arguments: { action: 'write', id: 't-1', key: 'ctrl-c', submit: false },
                },
            },
            ctx({ manageTerminals }),
        );
        expect(manageTerminals).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({ action: 'write', key: 'ctrl-c', submit: false }),
        );
        await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 48,
                method: 'tools/call',
                params: { name: 'manageTerminals', arguments: { action: 'read', id: 't-1', strip: true } },
            },
            ctx({ manageTerminals }),
        );
        expect(manageTerminals).toHaveBeenLastCalledWith(
            'term-1',
            expect.objectContaining({ action: 'read', strip: true }),
        );
    });

    it('the runAgent + manageTerminals schemas expose submit/key/strip', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 49, method: 'tools/list' },
            ctx(),
        );
        const tools = (res?.result as {
            tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
        }).tools;
        for (const name of ['runAgent', 'manageTerminals']) {
            const props = tools.find((t) => t.name === name)!.inputSchema.properties;
            expect(props).toHaveProperty('submit');
            expect(props).toHaveProperty('key');
            expect(props).toHaveProperty('strip');
        }
    });

    it('manageWorkspaces routes to the dep and lists actionable workspaces', async () => {
        const manageWorkspaces = vi.fn().mockResolvedValue({
            ok: true,
            workspaces: [
                { id: 'ws-self', name: 'Mine', path: '/a', relation: 'self' },
                { id: 'ws-child', name: 'Child', path: '/b', relation: 'governed' },
            ],
        });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 46,
                method: 'tools/call',
                params: { name: 'manageWorkspaces', arguments: { action: 'list', terminalId: 'term-W' } },
            },
            ctx({ terminalId: 'term-W', manageWorkspaces }),
        );
        expect(manageWorkspaces).toHaveBeenCalledWith('term-W', { action: 'list' });
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('2 workspaces');
        expect(text).toContain('ws-child'); // JSON block
    });

    it('manageWorkspaces rejects a bad/missing action', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 47, method: 'tools/call', params: { name: 'manageWorkspaces', arguments: {} } },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32602);
    });

    it('agentinbox routes to the dep and summarizes a list', async () => {
        const agentInbox = vi.fn().mockResolvedValue({
            ok: true,
            self: { agentId: 'me', label: 'Me' },
            agents: [{ agentId: 'peer', label: 'Peer' }],
            channels: [{ key: 'w1:general', slug: 'ws-one', purpose: 'general' }],
        });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 70,
                method: 'tools/call',
                params: { name: 'agentinbox', arguments: { action: 'list', terminalId: 'term-W' } },
            },
            ctx({ terminalId: 'term-W', agentInbox }),
        );
        expect(agentInbox).toHaveBeenCalledWith('term-W', {
            action: 'list',
            to: undefined,
            channel: undefined,
            text: undefined,
            interrupt: undefined,
            cursor: undefined,
            wait: undefined,
            timeoutMs: undefined,
            scope: undefined,
            workspaces: undefined,
            purpose: undefined,
        });
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('1 agent(s) reachable, 1 channel(s).');
        expect(text).toContain('w1:general'); // the JSON block
    });

    it('agentinbox plumbs send args (to/channel/text/interrupt) and summarizes delivery', async () => {
        const agentInbox = vi.fn().mockResolvedValue({ ok: true, delivered: 2 });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 71,
                method: 'tools/call',
                params: {
                    name: 'agentinbox',
                    arguments: { action: 'send', channel: 'general', text: 'hey', interrupt: true },
                },
            },
            ctx({ agentInbox }),
        );
        expect(agentInbox).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({ action: 'send', channel: 'general', text: 'hey', interrupt: true }),
        );
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('delivered to 2 recipient(s)');
    });

    it('agentinbox summarizes a receive with its message count', async () => {
        const agentInbox = vi.fn().mockResolvedValue({
            ok: true,
            messages: [{ seq: 1, id: 'x', from: 'p', fromLabel: 'P', kind: 'dm', text: 'hi', ts: 1 }],
            cursor: 1,
        });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 72,
                method: 'tools/call',
                params: { name: 'agentinbox', arguments: { action: 'receive', cursor: 0, wait: true } },
            },
            ctx({ agentInbox }),
        );
        expect(agentInbox).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({ action: 'receive', cursor: 0, wait: true }),
        );
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('1 new message(s).');
    });

    it('agentinbox surfaces a failure', async () => {
        const agentInbox = vi.fn().mockResolvedValue({ ok: false, error: 'not reachable' });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 73,
                method: 'tools/call',
                params: { name: 'agentinbox', arguments: { action: 'send', to: 'x', text: 'y' } },
            },
            ctx({ agentInbox }),
        );
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('agentinbox failed: not reachable');
    });

    it('agentinbox rejects a bad/missing action', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 74, method: 'tools/call', params: { name: 'agentinbox', arguments: {} } },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32602);
    });

    it('the agentinbox schema exposes its action enum + send/receive args', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 75, method: 'tools/list' },
            ctx(),
        );
        const tools = (res?.result as {
            tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
        }).tools;
        const props = tools.find((t) => t.name === 'agentinbox')!.inputSchema.properties;
        for (const k of ['action', 'to', 'channel', 'text', 'wait', 'cursor', 'scope']) {
            expect(props).toHaveProperty(k);
        }
    });

    it('knowledge plumbs search args and summarizes the result count', async () => {
        const knowledge = vi.fn().mockResolvedValue({
            ok: true,
            results: [{ id: 'n1', title: 'Runbook', snippet: '…', score: 1.2, tags: [] }],
        });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 80,
                method: 'tools/call',
                params: {
                    name: 'knowledge',
                    arguments: { action: 'search', query: 'deploy', limit: 5, tags: ['ops'] },
                },
            },
            ctx({ terminalId: 'term-K', knowledge }),
        );
        expect(knowledge).toHaveBeenCalledWith(
            'term-K',
            expect.objectContaining({ action: 'search', query: 'deploy', limit: 5, tags: ['ops'] }),
        );
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('1 result(s) for "deploy".');
        expect(text).toContain('Runbook'); // the JSON block
    });

    it('knowledge summarizes an add with the new id', async () => {
        const knowledge = vi.fn().mockResolvedValue({ ok: true, id: 'new-node' });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 81,
                method: 'tools/call',
                params: {
                    name: 'knowledge',
                    arguments: { action: 'add', title: 'T', body: 'see [[Other]]' },
                },
            },
            ctx({ knowledge }),
        );
        expect(knowledge).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({ action: 'add', title: 'T', body: 'see [[Other]]' }),
        );
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('Added node new-node.');
    });

    it('knowledge surfaces a failure', async () => {
        const knowledge = vi.fn().mockResolvedValue({ ok: false, error: 'add needs a `title`.' });
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 82,
                method: 'tools/call',
                params: { name: 'knowledge', arguments: { action: 'add' } },
            },
            ctx({ knowledge }),
        );
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('knowledge failed: add needs a `title`.');
    });

    it('knowledge rejects a bad/missing action', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 83, method: 'tools/call', params: { name: 'knowledge', arguments: {} } },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32602);
    });

    it('lists the knowledge tool with its action enum + args', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 84, method: 'tools/list' },
            ctx(),
        );
        const tools = (res?.result as {
            tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
        }).tools;
        const tool = tools.find((t) => t.name === 'knowledge');
        expect(tool).toBeTruthy();
        for (const k of ['action', 'query', 'title', 'body', 'tags', 'links', 'from', 'to']) {
            expect(tool!.inputSchema.properties).toHaveProperty(k);
        }
    });

    it('serves the guide via initialize instructions and genieGuide', async () => {
        const init = await handleMcpMessage(
            { jsonrpc: '2.0', id: 8, method: 'initialize' },
            ctx(),
        );
        expect((init?.result as { instructions: string }).instructions).toContain(
            'Genie MCP',
        );
        const call = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 9,
                method: 'tools/call',
                params: { name: 'genieGuide', arguments: {} },
            },
            ctx(),
        );
        const text = (call?.result as { content: Array<{ text: string }> }).content[0]
            .text;
        expect(text).toContain('imDone');
        expect(text).toContain('ForceTheQuestion');
        expect(text).not.toContain('tynn-cli');
        expect(text).not.toContain('resetme');
        // The full guide tells the agent how to self-configure an on-finish hook.
        expect(text).toContain('Automate imDone');
        expect(text).toContain('Stop');
        expect(text).toContain('$GENIE_MCP_URL');
        // Documents the process tool + frames initializeWorkspace as a user-run prompt.
        expect(text).toContain('manageProcess');
        expect(text).toMatch(/initializeWorkspace[\s\S]*prompt/);
        // Documents the agent-control tools.
        expect(text).toContain('manageTerminals');
        expect(text).toContain('runAgent');
        expect(text).toContain('manageWorkspaces');
        // Documents the IssueWatch tool + that imDone reports counts.
        expect(text).toContain('checkIssues');
        expect(text).toMatch(/imDone[\s\S]*IssueWatch/);
    });

    it('invokes onImDone with the bound terminal id on tools/call', async () => {
        const onImDone = vi.fn();
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name: 'imDone', arguments: {} },
            },
            ctx({ terminalId: 'term-XYZ', onImDone }),
        );
        expect(onImDone).toHaveBeenCalledWith('term-XYZ');
        expect((res?.result as { content: unknown[] }).content).toBeInstanceOf(Array);
    });

    it('imDone appends the IssueWatch counts line (resolved from the terminal)', async () => {
        const checkIssues = vi.fn().mockResolvedValue({
            connected: true,
            workspaceResolved: true,
            counts: { issue: 3, pr: 1, security: 2 },
            items: [],
        });
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: 'imDone', arguments: {} } },
            ctx({ terminalId: 'term-IW', checkIssues }),
        );
        expect(checkIssues).toHaveBeenCalledWith('term-IW');
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('glowing'); // the base ack
        expect(text).toContain('IssueWatch — issues:3, PR:1, sec:2');
    });

    it('imDone folds the remediation policy into the counts line when set', async () => {
        const checkIssues = vi.fn().mockResolvedValue({
            connected: true,
            workspaceResolved: true,
            counts: { issue: 0, pr: 0, security: 2 },
            items: [],
            policy: { security: 'fix-and-ship', issue: 'fix-and-ship', pr: 'fix-and-ship' },
        });
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 'imDone', arguments: {} } },
            ctx({ checkIssues }),
        );
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        // Base counts plus a root-cause / ship-now directive (no bandaids) for the
        // only open bucket (security).
        expect(text).toContain('IssueWatch — issues:0, PR:0, sec:2');
        expect(text).toContain('security: fix at the ROOT CAUSE');
        expect(text).toContain('ship right away');
    });

    it('imDone leaves the counts line bare when every open bucket is surface', async () => {
        const checkIssues = vi.fn().mockResolvedValue({
            connected: true,
            workspaceResolved: true,
            counts: { issue: 1, pr: 0, security: 0 },
            items: [],
            policy: { security: 'surface', issue: 'surface', pr: 'surface' },
        });
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 61, method: 'tools/call', params: { name: 'imDone', arguments: {} } },
            ctx({ checkIssues }),
        );
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('IssueWatch — issues:1, PR:0, sec:0');
        expect(text).not.toContain('ROOT CAUSE');
    });

    it('imDone gives a PER-BUCKET directive (security fix-and-ship, issues held)', async () => {
        const checkIssues = vi.fn().mockResolvedValue({
            connected: true,
            workspaceResolved: true,
            counts: { issue: 3, pr: 0, security: 2 },
            items: [],
            policy: { security: 'fix-and-ship', issue: 'surface', pr: 'fix' },
        });
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 62, method: 'tools/call', params: { name: 'imDone', arguments: {} } },
            ctx({ checkIssues }),
        );
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('IssueWatch — issues:3, PR:0, sec:2');
        // Security: fix + ship now. Issues: explicitly held. PRs have 0 open, so no
        // PR directive appears even though its policy is 'fix'.
        expect(text).toContain('security: fix at the ROOT CAUSE (NO bandaids) and ship right away');
        expect(text).toContain('issues: surface only (hold)');
        expect(text).not.toContain('PRs:');
    });

    it('imDone omits the counts line when there is nothing open', async () => {
        const checkIssues = vi.fn().mockResolvedValue({
            connected: true,
            workspaceResolved: true,
            counts: { issue: 0, pr: 0, security: 0 },
            items: [],
        });
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'imDone', arguments: {} } },
            ctx({ checkIssues }),
        );
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).not.toContain('IssueWatch');
    });

    it('imDone still acks if the IssueWatch snapshot throws (best-effort)', async () => {
        const checkIssues = vi.fn().mockRejectedValue(new Error('db down'));
        const onImDone = vi.fn();
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 52, method: 'tools/call', params: { name: 'imDone', arguments: {} } },
            ctx({ onImDone, checkIssues }),
        );
        expect(onImDone).toHaveBeenCalled();
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('glowing');
        expect(text).not.toContain('IssueWatch');
    });

    it('checkIssues routes to the dep and formats a grouped, scannable feed', async () => {
        const checkIssues = vi.fn().mockResolvedValue({
            connected: true,
            workspaceResolved: true,
            counts: { issue: 1, pr: 1, security: 2 },
            items: [
                { kind: 'issue', owner: 'o', repo: 'r', number: 1, title: 'A bug', url: 'https://gh/o/r/issues/1', unread: true },
                { kind: 'pr', owner: 'o', repo: 'r', number: 2, title: 'A fix', url: 'https://gh/o/r/pull/2', unread: false },
                { kind: 'dependabot', owner: 'o', repo: 'r', number: 3, title: 'Vuln', url: 'https://gh/dep/3', severity: 'high', unread: false },
                { kind: 'secret-scanning', owner: 'o', repo: 'r', number: 4, title: 'Exposed secret: AWS', url: 'https://gh/ss/4', unread: false },
            ],
        });
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 53, method: 'tools/call', params: { name: 'checkIssues', arguments: { terminalId: 'term-IW' } } },
            ctx({ terminalId: 'term-IW', checkIssues }),
        );
        expect(checkIssues).toHaveBeenCalledWith('term-IW');
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        // Grouped section headers + per-item detail (number, title, severity, url, unread).
        expect(text).toContain('## Issues (1)');
        expect(text).toContain('## Pull Requests (1)');
        expect(text).toContain('## Dependabot alerts (1)');
        expect(text).toContain('## Secret scanning alerts (1)');
        expect(text).toContain('#1');
        expect(text).toContain('A bug');
        expect(text).toContain('(new)'); // the unread flag
        expect(text).toContain('[high]'); // the severity
        expect(text).toContain('https://gh/o/r/issues/1');
    });

    it('checkIssues explains a not-connected / unresolved workspace clearly', async () => {
        const notConnected = await handleMcpMessage(
            { jsonrpc: '2.0', id: 54, method: 'tools/call', params: { name: 'checkIssues', arguments: {} } },
            ctx({
                checkIssues: vi.fn().mockResolvedValue({
                    connected: false,
                    workspaceResolved: true,
                    serviceState: 'disabled',
                    counts: { issue: 0, pr: 0, security: 0 },
                    items: [],
                }),
            }),
        );
        expect((notConnected?.result as { content: Array<{ text: string }> }).content[0].text).toContain(
            'disabled by the Tynn account entitlement',
        );

        const noWorkspace = await handleMcpMessage(
            { jsonrpc: '2.0', id: 55, method: 'tools/call', params: { name: 'checkIssues', arguments: {} } },
            ctx({
                checkIssues: vi.fn().mockResolvedValue({
                    connected: true,
                    workspaceResolved: false,
                    counts: { issue: 0, pr: 0, security: 0 },
                    items: [],
                }),
            }),
        );
        expect((noWorkspace?.result as { content: Array<{ text: string }> }).content[0].text).toContain(
            "couldn't resolve this terminal",
        );
    });

    it('routes ForceTheQuestion to onForceQuestion and returns the answers', async () => {
        const onForceQuestion = vi.fn().mockResolvedValue({
            cancelled: false,
            answers: [
                { header: 'Deploy', question: 'Ship it?', selected: ['Yes'], note: 'go' },
            ],
        });
        const questions = [
            {
                header: 'Deploy',
                question: 'Ship it?',
                options: [{ label: 'Yes' }, { label: 'No' }],
            },
        ];
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 6,
                method: 'tools/call',
                params: { name: 'ForceTheQuestion', arguments: { questions } },
            },
            ctx({ terminalId: 'term-Q', onForceQuestion }),
        );
        expect(onForceQuestion).toHaveBeenCalledWith('term-Q', questions);
        const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('Deploy');
        expect(text).toContain('Yes');
    });

    it('errors when ForceTheQuestion is called without questions', async () => {
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 7,
                method: 'tools/call',
                params: { name: 'ForceTheQuestion', arguments: {} },
            },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32602);
    });

    it('errors on an unknown tool', async () => {
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 4,
                method: 'tools/call',
                params: { name: 'nope' },
            },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32602);
    });

    it('errors on an unknown method', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 5, method: 'frobnicate' },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32601);
    });
});
