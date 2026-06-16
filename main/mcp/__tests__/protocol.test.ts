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

    it('lists the imDone + ForceTheQuestion + genieGuide tools', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            ctx(),
        );
        const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
        expect(tools.map((t) => t.name)).toEqual([
            'imDone',
            'ForceTheQuestion',
            'genieGuide',
        ]);
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
