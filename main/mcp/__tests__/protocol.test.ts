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

    it('lists imDone + ForceTheQuestion + manageProcess + provisionWorkspaces + genieGuide tools (NOT initializeWorkspace — it is a prompt)', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            ctx(),
        );
        const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
        expect(tools.map((t) => t.name)).toEqual([
            'imDone',
            'ForceTheQuestion',
            'manageProcess',
            'provisionWorkspaces',
            'manageTerminals',
            'runAgent',
            'manageWorkspaces',
            'genieGuide',
        ]);
        expect(tools.map((t) => t.name)).not.toContain('initializeWorkspace');
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

    it('manageProcess rejects a bad/missing action', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 26, method: 'tools/call', params: { name: 'manageProcess', arguments: {} } },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32602);
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
