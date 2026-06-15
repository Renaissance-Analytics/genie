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
        ...overrides,
    };
}

describe('handleMcpMessage', () => {
    it('answers initialize with the protocol version + serverInfo', () => {
        const res = handleMcpMessage(
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

    it('returns null (no body) for the initialized notification', () => {
        expect(
            handleMcpMessage(
                { jsonrpc: '2.0', method: 'notifications/initialized' },
                ctx(),
            ),
        ).toBeNull();
    });

    it('lists the imDone tool', () => {
        const res = handleMcpMessage(
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            ctx(),
        );
        const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
        expect(tools.map((t) => t.name)).toEqual(['imDone']);
    });

    it('invokes onImDone with the bound terminal id on tools/call', () => {
        const onImDone = vi.fn();
        const res = handleMcpMessage(
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

    it('errors on an unknown tool', () => {
        const res = handleMcpMessage(
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

    it('errors on an unknown method', () => {
        const res = handleMcpMessage(
            { jsonrpc: '2.0', id: 5, method: 'frobnicate' },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32601);
    });
});
