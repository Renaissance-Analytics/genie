import { describe, expect, it, vi } from 'vitest';
import { handleMcpMessage, MCP_PROTOCOL_VERSION, type McpContext, type McpToolDescriptor } from '../../mcp/protocol';
import { buildManifest, runDispatch } from '../publisher';
import type { DispatchFrame } from '../core';

/**
 * GENIE'S SIDE OF THE SHUTTLE — what it publishes, and how it runs what it is sent.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §4.2, §4.3.
 *
 * The shuttle answers discovery from the manifest Genie publishes, and forwards
 * everything else back to Genie. So the property that matters is that **an agent
 * cannot tell the shuttle from the in-process server**: the manifest must say what
 * `handleMcpMessage` would have said, and a dispatched call must run through
 * `handleMcpMessage` exactly as a request on the in-process server does.
 *
 * Both are derived FROM `handleMcpMessage`, not restated beside it, so a tool added
 * to `protocol.ts` tomorrow reaches the shuttle with no second edit — and these
 * tests compare against the real function, so a restatement that drifted would fail.
 */

function ctx(overrides: Partial<McpContext> = {}): McpContext {
    return {
        terminalId: '',
        serverName: 'genie',
        serverVersion: '0.7.0-beta.323',
        onImDone: vi.fn().mockReturnValue({ attention: 1 }),
        ...overrides,
    } as unknown as McpContext;
}

const plugin: McpToolDescriptor = {
    name: 'artboard_post',
    description: 'Post to the artboard.',
    inputSchema: { type: 'object', properties: {} },
};

async function inProcess(method: string, c: McpContext) {
    const r = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method, params: {} }, c);
    return (r as { result: Record<string, unknown> }).result;
}

describe('the manifest says what the in-process server would say', () => {
    it('publishes EXACTLY the tools tools/list answers, plugin tools included, in order', async () => {
        const c = ctx({ pluginTools: () => [plugin] });
        const manifest = await buildManifest(c, { genieVersion: '0.7.0-beta.323', generation: 4 });
        expect(manifest.tools).toEqual((await inProcess('tools/list', c)).tools);
        expect(manifest.tools.at(-1)?.name).toBe('artboard_post');
    });

    it('publishes EXACTLY the prompts prompts/list answers', async () => {
        const c = ctx();
        const manifest = await buildManifest(c, { genieVersion: 'v', generation: 1 });
        expect(manifest.prompts).toEqual((await inProcess('prompts/list', c)).prompts);
        expect(manifest.prompts.length).toBeGreaterThan(0);
    });

    it('publishes EXACTLY what initialize answers', async () => {
        const c = ctx();
        const manifest = await buildManifest(c, { genieVersion: 'v', generation: 1 });
        const init = await inProcess('initialize', c);

        expect(manifest.protocolVersions).toEqual([init.protocolVersion]);
        expect(manifest.serverInfo).toEqual(init.serverInfo);
        expect(manifest.instructions).toBe(init.instructions);
        expect(manifest.capabilities).toEqual(init.capabilities);
        expect(manifest.protocolVersions).toEqual([MCP_PROTOCOL_VERSION]);
    });

    it('publishes no resources, because the in-process server declares none', async () => {
        const manifest = await buildManifest(ctx(), { genieVersion: 'v', generation: 1 });
        expect(manifest.resources).toEqual([]);
        expect(manifest.capabilities.resources).toBeUndefined();
    });

    it('stamps the version and generation it was given', async () => {
        const manifest = await buildManifest(ctx(), { genieVersion: '0.7.0-beta.323', generation: 7 });
        expect(manifest.genieVersion).toBe('0.7.0-beta.323');
        expect(manifest.generation).toBe(7);
    });

    it('fails CLOSED on a throwing plugin registry, exactly as tools/list does', async () => {
        const c = ctx({
            pluginTools: () => {
                throw new Error('registry down');
            },
        });
        const manifest = await buildManifest(c, { genieVersion: 'v', generation: 1 });
        expect(manifest.tools).toEqual((await inProcess('tools/list', c)).tools);
        expect(manifest.tools.some((t) => t.name === 'artboard_post')).toBe(false);
    });
});

describe('a dispatched call runs through handleMcpMessage, for the terminal the shuttle resolved', () => {
    const frame = (request: DispatchFrame['request'], terminalId = 't-7'): DispatchFrame => ({
        correlationId: 1,
        generation: 1,
        request,
        route: { token: 'tok', terminalId },
    });

    it('runs the call with the context for the ROUTED terminal', async () => {
        const onImDone = vi.fn().mockReturnValue({ attention: 1 });
        const contextFor = vi.fn((terminalId: string) => ctx({ terminalId, onImDone }));

        const response = await runDispatch(
            frame({ id: 3, method: 'tools/call', params: { name: 'imDone', arguments: {} } }),
            contextFor,
        );

        expect(contextFor).toHaveBeenCalledWith('t-7');
        expect(onImDone).toHaveBeenCalledWith('t-7');
        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
    });

    it('returns the same result the in-process server returns, without the JSON-RPC envelope', async () => {
        const request = { id: 9, method: 'tools/call', params: { name: 'imDone', arguments: {} } };
        const c = ctx({ terminalId: 't-7' });
        const direct = await handleMcpMessage({ jsonrpc: '2.0', ...request }, c);

        const response = await runDispatch(frame(request), () => ctx({ terminalId: 't-7' }));

        expect(response).toEqual({ result: (direct as { result: unknown }).result });
        expect(response).not.toHaveProperty('jsonrpc');
        expect(response).not.toHaveProperty('id');
    });

    it("passes a JSON-RPC error through as the call's error", async () => {
        const response = await runDispatch(
            frame({ id: 1, method: 'no/such/method' }),
            (terminalId) => ctx({ terminalId }),
        );
        expect(response.error?.code).toBe(-32601);
    });

    it('treats a frame with no route as no terminal, as the in-process server does', async () => {
        const contextFor = vi.fn((terminalId: string) => ctx({ terminalId }));
        await runDispatch({ correlationId: 1, generation: 1, request: { id: 1, method: 'ping' } }, contextFor);
        expect(contextFor).toHaveBeenCalledWith('');
    });

    it('answers a handler that THROWS with an internal error naming Genie, and never rejects', async () => {
        // A rejection here would leave the agent's call parked in the shuttle
        // until the publisher disconnected — a hang that reads as a broken tool.
        const response = await runDispatch(
            frame({ id: 1, method: 'tools/call', params: { name: 'imDone', arguments: {} } }),
            () =>
                ctx({
                    onImDone: () => {
                        throw new Error('db locked');
                    },
                }),
        );
        expect(response.error?.code).toBe(-32603);
        expect(response.error?.message).toMatch(/Genie/);
    });
});
