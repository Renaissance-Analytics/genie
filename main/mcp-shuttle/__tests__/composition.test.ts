import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleMcpMessage, type McpContext, type McpToolDescriptor } from '../../mcp/protocol';
import { createShuttleCore, type DispatchFrame } from '../core';
import { createManifestStore } from '../manifest-store';
import { createShuttleListener } from '../listener';
import { buildManifest, runDispatch } from '../publisher';

/**
 * AN AGENT CANNOT TELL THE SHUTTLE FROM THE IN-PROCESS SERVER.
 *
 * genie#346 Phase 1. Each layer has its own tests; this one wires them together —
 * Genie's publisher, the manifest store, the core and the listener, over real
 * loopback HTTP — and compares every answer with what `handleMcpMessage` gives for
 * the same request directly. If the layers compose into anything other than the
 * server agents already talk to, this is where it shows.
 *
 * It then replaces the publisher under an open call, which is the whole point of
 * the shuttle: the call made while Genie was away completes on the new Genie, on
 * the HTTP response the agent opened before the swap.
 */

const WS_TOKEN = 'wsCompositionToken';

const plugin: McpToolDescriptor = {
    name: 'artboard_post',
    description: 'Post to the artboard.',
    inputSchema: { type: 'object', properties: {} },
};

function genie(onImDone = vi.fn().mockReturnValue({ attention: 1 })) {
    const ctxFor = (terminalId: string): McpContext =>
        ({
            terminalId,
            serverName: 'genie',
            serverVersion: '0.7.0-beta.323',
            onImDone,
            pluginTools: () => [plugin],
        }) as unknown as McpContext;
    return { ctxFor, onImDone };
}

const servers: http.Server[] = [];
afterEach(async () => {
    await Promise.all(
        servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))),
    );
});

async function shuttle(streamAfterMs: number) {
    const core = createShuttleCore({ now: () => 0 });
    const store = createManifestStore({ read: () => null, write: () => {} });
    const listener = createShuttleListener({
        core,
        manifest: store,
        routes: {
            endpoint: (token) => (token === WS_TOKEN ? { kind: 'workspace', workspaceId: 'w1' } : null),
            workspaceTerminals: () => ['t-a', 't-b'],
        },
        streamAfterMs,
        heartbeatMs: 10,
    });
    const server = http.createServer(listener.handle);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

    /** Attach a Genie as publisher: publish its manifest, run what it is sent. */
    const attach = async (g: ReturnType<typeof genie>, generation: number) => {
        store.publish(await buildManifest(g.ctxFor(''), { genieVersion: '0.7.0-beta.323', generation }));
        core.attach(
            {
                dispatch: (frame: DispatchFrame) =>
                    void runDispatch(frame, g.ctxFor).then((r) => core.result(frame.correlationId, r)),
            },
            generation,
        );
    };
    return { core, attach, port: (server.address() as AddressInfo).port, close: () => listener.close() };
}

function post(port: number, body: unknown): Promise<{ contentType: string; text: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: `/mcp/${WS_TOKEN}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            },
            (res) => {
                let text = '';
                res.on('data', (c) => (text += c));
                res.on('end', () => resolve({ contentType: String(res.headers['content-type']), text }));
            },
        );
        req.on('error', reject);
        req.setTimeout(3_000, () => req.destroy(new Error('no response in 3s')));
        req.end(JSON.stringify(body));
    });
}

/** The last JSON-RPC message in a response, whether it came as JSON or as a stream. */
function lastMessage(r: { contentType: string; text: string }) {
    if (r.contentType.startsWith('application/json')) return JSON.parse(r.text);
    const data = r.text
        .split('\n')
        .filter((l) => l.startsWith('data: ') && l.length > 6)
        .map((l) => JSON.parse(l.slice(6)));
    return data.at(-1);
}

describe('the shuttle answers exactly as the in-process server does', () => {
    it.each([
        ['initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c', version: '1' } }],
        ['tools/list', {}],
        ['prompts/list', {}],
        ['resources/list', {}],
        ['ping', {}],
    ])('%s', async (method, params) => {
        const g = genie();
        const s = await shuttle(5_000);
        await s.attach(g, 1);

        const msg = { jsonrpc: '2.0' as const, id: 42, method, params };
        const viaShuttle = lastMessage(await post(s.port, msg));
        const direct = await handleMcpMessage(msg, g.ctxFor(''));

        expect(viaShuttle).toEqual(direct);
        s.close();
    });

    it('a tools/call, run on the terminal the agent named', async () => {
        const g = genie();
        const s = await shuttle(5_000);
        await s.attach(g, 1);

        const msg = { jsonrpc: '2.0' as const, id: 7, method: 'tools/call', params: { name: 'imDone', arguments: { terminalId: 't-b' } } };
        const viaShuttle = lastMessage(await post(s.port, msg));
        const direct = await handleMcpMessage(msg, genie().ctxFor('t-b'));

        expect(viaShuttle).toEqual(direct);
        expect(g.onImDone).toHaveBeenCalledWith('t-b');
        s.close();
    });
});

describe('the swap, end to end', () => {
    it('a call made while Genie is away completes on the NEW Genie, on the response the agent already opened', async () => {
        const oldGenie = genie();
        const newGenie = genie();
        const s = await shuttle(20);
        await s.attach(oldGenie, 1);
        s.core.detach(); // the old Genie exits for an upgrade

        const msg = { jsonrpc: '2.0' as const, id: 9, method: 'tools/call', params: { name: 'imDone', arguments: { terminalId: 't-a' } } };
        const pending = post(s.port, msg);
        await new Promise((r) => setTimeout(r, 60)); // well past the switch to a stream

        await s.attach(newGenie, 2);
        const reply = await pending;

        expect(reply.contentType).toBe('text/event-stream');
        expect(lastMessage(reply)).toEqual(await handleMcpMessage(msg, genie().ctxFor('t-a')));
        expect(oldGenie.onImDone).not.toHaveBeenCalled();
        expect(newGenie.onImDone).toHaveBeenCalledWith('t-a');
        s.close();
    });
});
