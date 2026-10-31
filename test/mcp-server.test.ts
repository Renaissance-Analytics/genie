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

/**
 * genie#1360: Claude Code drops a tools/call whose response has said nothing for 60 s (measured: every wait past 60 s
 * came back "The operation timed out." at 61.9 s). prism-mcp-server 0.4.0 answers a tools/call that accepts
 * `text/event-stream` as SSE — opened at once, a heartbeat every 10 s, the result as the last event — and Genie builds
 * its transport with `abortOnDisconnect`, so a client that goes away fires the handler's signal and the wait behind it
 * (an approval, `services exec`, `agentinbox receive wait`) is withdrawn instead of running on for nobody. A JSON-only
 * client (Codex) keeps its one JSON body.
 */
describe('genieMcpServer — long waits (genie#1360)', () => {
    const call = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'hold', arguments: {}, _meta: { ...META, progressToken: `p${id}` } } });
    let aborted: boolean[] = [];
    let release: () => void = () => {};
    const hold: Registration = {
        definition: new ToolDefinition('hold', 'Waits until released or its call goes away', { type: 'object', properties: {} }),
        handler: (_args: JsonObject, context) => new Promise((resolve) => {
            context.progress?.('holding');
            const done = (text: string) => resolve({ text, isError: false });
            release = () => done('released');
            context.signal?.addEventListener('abort', () => { aborted.push(true); done('aborted'); }, { once: true });
        }),
    };

    it('a client that drops its connection mid-wait aborts the handler’s signal', async () => {
        aborted = [];
        server = genieMcpServer({ registrations: [hold], port: 0 });
        const { url, token } = await server.start();
        const client = new AbortController();
        const res = await fetch(url, { method: 'POST', signal: client.signal, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: call(1) });
        expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
        const reader = res.body!.getReader();
        // The stream opened at once, before any result: the client hears something long before 60 s.
        const first = new TextDecoder().decode((await reader.read()).value);
        expect(first).toContain(': open');
        client.abort();
        const until = Date.now() + 5_000;
        while (aborted.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
        expect(aborted).toEqual([true]);
    });

    it('a JSON-only client gets its one JSON body, unchanged', async () => {
        aborted = [];
        server = genieMcpServer({ registrations: [hold], port: 0 });
        const { url, token } = await server.start();
        const pending = fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` }, body: call(2) });
        await new Promise((r) => setTimeout(r, 100));
        release();
        const res = await pending;
        expect(res.headers.get('content-type')).toMatch(/^application\/json/);
        const body = (await res.json()) as { id: number; result: { content: Array<{ text: string }> } };
        expect(body.id).toBe(2);
        expect(JSON.stringify(body.result)).toContain('released');
        expect(aborted).toEqual([]);
    });
});

/**
 * genie#1360, the SECOND limit (measured on omarchy-test with the real claude -p 2.1.314 after 0.4.0): SSE heartbeat
 * comments keep the 60 s transport timeout away, but Claude Code ALSO aborts a call that "sent no response or progress
 * for 302s" — every approval wait of 330, 660, 960 and 1860 s died at 304 s, while a 15-minute `services exec`, which
 * reports its output size every 10 s, came back at 902 s. So while any call is in flight, Genie's server repeats the
 * handler's latest progress message (with the time waited) on an interval: a wait that is still waiting says so.
 */
describe('genieMcpServer — progress while a call waits (genie#1360)', () => {
    it('repeats the latest progress message while the handler waits, and stops when it answers', async () => {
        let release: () => void = () => {};
        const quiet: Registration = {
            definition: new ToolDefinition('quiet', 'Says one thing, then waits until released', { type: 'object', properties: {} }),
            handler: (_args: JsonObject, context) => new Promise((resolve) => {
                context.progress?.('waiting for the person’s approval');
                release = () => resolve({ text: 'released', isError: false });
            }),
        };
        server = genieMcpServer({ registrations: [quiet], port: 0, progressEveryMs: 40 });
        const { url, token } = await server.start();
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'quiet', arguments: {}, _meta: { ...META, progressToken: 'p7' } } }) });
        setTimeout(() => release(), 400);
        const text = await res.text();
        const messages = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as { method?: string; params?: { message?: string }; result?: unknown });
        const progress = messages.filter((m) => m.method === 'notifications/progress').map((m) => m.params?.message ?? '');
        // The handler said it once; the server said it again, several times, before the answer.
        const repeats = progress.filter((m) => m.startsWith('waiting for the person’s approval') && m !== 'waiting for the person’s approval');
        expect(repeats.length).toBeGreaterThanOrEqual(3);
        expect(messages.at(-1)?.result).toBeDefined();
    });
});
