import { InMemoryTransport, ToolDefinition, type JsonObject } from '@particle-academy/prism-mcp-server';
import { afterEach, describe, expect, it } from 'vitest';
import type { Registration } from '../src/main/mcp-tools.js';
import { genieMcpServer, type GenieMcpServer } from '../src/main/mcp-server.js';

/**
 * GENIE'S OWN MCP SERVER (§6.9): prism-mcp-server 0.2.0 on a loopback HTTP transport with a bearer minted at
 * listen, serving every Genie tool registration; `GENIE_MCP_URL` / `GENIE_MCP_TOKEN` are what the URL and
 * token become in every terminal's environment. "Native transport verified at boot" (§6.4) is `verify()`: a
 * real `server/discover` through the server's own door, answered with the one protocol revision it serves —
 * `{ ok: false }` in words when nothing listens. Over the in-memory transport the dispatch is proven without
 * a socket; over the real loopback the bearer is proven to be required.
 */

const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const ping: Registration = {
    // prism's mirror annotation is the HEADER NAME as a string: `Mcp-Param-TerminalId` lands in `args.terminalId`.
    definition: new ToolDefinition('ping', 'Answers with the terminal that called', { type: 'object', properties: { terminalId: { type: 'string', 'x-mcp-header': 'TerminalId' } } }),
    handler: (args: JsonObject) => ({ text: JSON.stringify({ pong: args.terminalId ?? null }), isError: false }),
};

let server: GenieMcpServer | null = null;
afterEach(async () => { await server?.stop(); server = null; });

describe('genieMcpServer over the in-memory transport', () => {
    it('lists and dispatches the registrations; the mirrored header becomes the argument', async () => {
        const transport = new InMemoryTransport();
        server = genieMcpServer({ registrations: [ping], transport });
        const started = await server.start();
        expect(typeof started.url).toBe('string');
        const listed = (await transport.request({ method: 'tools/list', params: { _meta: META } })) as { tools: Array<{ name: string }> };
        expect(listed.tools.map((t) => t.name)).toEqual(['ping']);
        const called = (await transport.request({ method: 'tools/call', params: { name: 'ping', arguments: {}, _meta: META }, headers: { 'mcp-param-terminalid': 'term_7' } })) as { content: Array<{ text: string }> };
        expect(JSON.parse(called.content[0]!.text)).toEqual({ pong: 'term_7' });
    });

    it('verify() is a real server/discover: the served revision while listening, a reason when stopped', async () => {
        const transport = new InMemoryTransport();
        server = genieMcpServer({ registrations: [ping], transport });
        expect(await server.verify()).toEqual({ ok: false, reason: 'the MCP server is not listening' });
        await server.start();
        expect(await server.verify()).toEqual({ ok: true, versions: ['2026-07-28'] });
        await server.stop();
        expect(await server.verify()).toEqual({ ok: false, reason: 'the MCP server is not listening' });
    });
});

describe('genieMcpServer over the real loopback', () => {
    it('listens on 127.0.0.1 with a bearer minted at start; no bearer is 401, the bearer answers discovery; the endpoint is what terminals get', async () => {
        server = genieMcpServer({ registrations: [ping], port: 0 });
        const { url, token } = await server.start();
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
        expect(token.length).toBeGreaterThanOrEqual(32);
        expect(server.endpoint()).toEqual({ url, token });

        const bare = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }) });
        expect(bare.status).toBe(401);

        const probe = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'server/discover' }) });
        expect(probe.status).toBe(200);
        const body = (await probe.json()) as { result: { supportedVersions: string[] } };
        expect(body.result.supportedVersions).toEqual(['2026-07-28']);

        expect(await server.verify()).toEqual({ ok: true, versions: ['2026-07-28'] });
        await server.stop();
        expect(server.endpoint()).toBeNull();
    });
});
