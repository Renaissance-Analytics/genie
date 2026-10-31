import { InMemoryTransport, ToolDefinition, type JsonObject } from '@particle-academy/prism-mcp-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
 * genie#1360, the SECOND limit (measured on omarchy-test with the real claude -p 2.1.314): SSE heartbeat comments keep
 * the 60 s transport timeout away, but Claude Code ALSO aborts a call that "sent no response or progress for 302s" —
 * on 0.4.0 every approval wait of 330, 660, 960 and 1860 s died at 304 s.
 *
 * prism-mcp-server 0.5.0 answers that itself: a streamed tools/call carrying a progressToken gets a keepalive
 * `notifications/progress` every 30 s (its default `progressKeepaliveMs`) repeating the handler's latest message.
 * Genie RELIES on it and adds no repeat of its own: a wait says what it waits for ONCE, and prism keeps saying it.
 * 0.5.0's wire `progress` is an activity counter (strictly increasing); the handler's own report is in
 * `_meta['particle-academy/progress']`, whose `origin` tells a handler's report from prism's keepalive.
 */
describe('genieMcpServer — a waiting call keeps reporting progress through prism’s keepalive (genie#1360)', () => {
    const PRISM_KEEPALIVE_MS = 30_000;
    type Progress = { progress: number; total?: number; message?: string; _meta?: { 'particle-academy/progress'?: { origin?: string; nativeWork?: { message?: string; progress?: number; total?: number } } } };

    /** One streamed call to a handler that reports `said` once and then waits while `keepalives` × 30 s pass. */
    async function waitingCall(said: string, keepalives: number): Promise<{ progress: Progress[]; last: { result?: unknown } | undefined }> {
        let release: () => void = () => {};
        let reported: () => void = () => {};
        const reportedOnce = new Promise<void>((r) => { reported = r; });
        const quiet: Registration = {
            definition: new ToolDefinition('quiet', 'Says one thing, then waits until released', { type: 'object', properties: {} }),
            handler: (_args: JsonObject, context) => new Promise((resolve) => {
                context.progress?.(said);
                release = () => resolve({ text: 'released', isError: false });
                reported();
            }),
        };
        // Only the interval clock is faked: the sockets are real, and every repeating timer — prism's, or one Genie might
        // add — runs on the same clock, so half an hour passes in an instant.
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        try {
            server = genieMcpServer({ registrations: [quiet], port: 0 });
            const { url, token } = await server.start();
            const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'quiet', arguments: {}, _meta: { ...META, progressToken: 'p7' } } }) });
            expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
            await reportedOnce;
            // Read as a client does, and let each 30 s pass as its own turn of the event loop. prism SKIPS a keepalive
            // while the response is backed up (`writableNeedDrain`, documented in 0.5.0) — 61 intervals fired in one
            // synchronous burst filled the write buffer on Windows and 16 keepalives were rightly skipped (main's
            // unit (windows), ec60e329). A real wait never bursts: one notification per 30 s, flushed long before the next.
            const body = res.text();
            for (let i = 0; i < keepalives; i++) {
                vi.advanceTimersByTime(PRISM_KEEPALIVE_MS);
                await new Promise((r) => setTimeout(r, 2));
            }
            vi.advanceTimersByTime(1_000);
            release();
            const text = await body;
            const messages = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as { method?: string; params?: Progress; result?: unknown });
            return { progress: messages.filter((m) => m.method === 'notifications/progress').map((m) => m.params!), last: messages.at(-1) };
        } finally {
            vi.useRealTimers();
        }
    }
    const origin = (p: Progress) => p._meta?.['particle-academy/progress']?.origin;

    it('prism repeats the handler’s message every 30 s, verbatim, until the answer; the wire progress only climbs', async () => {
        const waiting = 'waiting for the person’s approval';
        const { progress, last } = await waitingCall(waiting, 4);
        // 4 × 30 s passed: prism said it again four times — its own keepalive, carrying the handler's words unchanged.
        const keepalives = progress.filter((p) => origin(p) === 'keepalive');
        expect(keepalives.map((p) => p.message)).toEqual([waiting, waiting, waiting, waiting]);
        expect(keepalives.map((p) => p._meta?.['particle-academy/progress']?.nativeWork?.message)).toEqual([waiting, waiting, waiting, waiting]);
        // 0.5.0: the wire `progress` is an activity counter — every notification higher than the one before.
        const counters = progress.map((p) => p.progress);
        expect(counters.every((c, i) => i === 0 || c > counters[i - 1]!)).toBe(true);
        expect(last?.result).toBeDefined();
    });

    it('Genie adds no repeat of its own: the handler’s one report is the only report not from prism', async () => {
        const waiting = 'waiting for mail';
        const { progress } = await waitingCall(waiting, 61);
        // 30.5 minutes of waiting. A repeat of Genie's own reaches prism as a HANDLER report (it goes through the
        // handler's progress), so there must be exactly one — the one the handler made — and no words it did not say.
        expect(progress.filter((p) => origin(p) !== 'start' && p.message !== waiting).map((p) => p.message)).toEqual([]);
        expect(progress.filter((p) => origin(p) === 'handler').map((p) => p.message)).toEqual([waiting]);
        expect(progress.filter((p) => origin(p) === 'keepalive')).toHaveLength(61);
    });
});
