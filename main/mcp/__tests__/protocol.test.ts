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

    it('lists imDone + ForceTheQuestion + manageProcess + genieGuide tools (NOT initializeWorkspace — it is a prompt)', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            ctx(),
        );
        const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
        expect(tools.map((t) => t.name)).toEqual([
            'imDone',
            'ForceTheQuestion',
            'manageProcess',
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
