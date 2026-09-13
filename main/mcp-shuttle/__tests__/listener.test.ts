import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createShuttleCore, SHUTTLE_ERROR_CODES, SWAP_GRACE_MS, type DispatchFrame } from '../core';
import { createManifestStore, type ShuttleManifest } from '../manifest-store';
import { createShuttleListener, type ShuttleRoutes } from '../listener';
import { AMBIGUOUS_TERMINAL_MESSAGE, type EndpointRoute } from '../../mcp/terminal-resolution';

/**
 * THE SHUTTLE'S LISTENER — the socket every agent's `.mcp.json` already points at.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §3.2, §4.2, §4.3.
 *
 * This is the layer that makes the shuttle real to an agent: the URL is
 * byte-identical to today's (`/mcp/<workspace-token>`), discovery is answered from
 * the published manifest without asking Genie, and everything only Genie can answer
 * is forwarded through the core — which parks it while Genie is being replaced.
 *
 * Two properties are the point, and each is tested against its opposite:
 *
 *  1. **Discovery never reaches Genie.** `initialize`, `tools/list`, `prompts/list`
 *     and `ping` are answered while Genie is gone — or an agent that starts mid-swap
 *     cannot even connect.
 *  2. **A call that has to wait keeps its connection alive.** A parked call can wait
 *     up to the grace window, far past a client's idle timeout. So a call that has not
 *     settled quickly is switched to a heartbeat stream, and its answer arrives on the
 *     same HTTP response. The listener never inspects a tool's arguments to decide
 *     this (§4.3) — it cannot know how long any call will take, parked or not.
 *
 * Real loopback HTTP on an ephemeral port: headless, nothing on screen.
 */

const WS_TOKEN = 'wsTokenAbc';
const LEGACY_TOKEN = 'legacyTerminalToken';

const manifest = (over: Partial<ShuttleManifest> = {}): ShuttleManifest => ({
    genieVersion: '0.7.0-beta.322',
    generation: 1,
    protocolVersions: ['2024-11-05'],
    serverInfo: { name: 'genie', version: '0.7.0-beta.322' },
    instructions: 'The Genie protocol.',
    capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
    tools: [{ name: 'imDone', description: 'Signal completion.', inputSchema: { type: 'object' } }],
    prompts: [{ name: 'connectToGenie', description: 'Orient.' }],
    resources: [],
    ...over,
});

interface Harness {
    port: number;
    core: ReturnType<typeof createShuttleCore>;
    frames: DispatchFrame[];
    attach(): void;
    clock: { advance(ms: number): void };
}

const servers: http.Server[] = [];
const closers: Array<() => void> = [];

afterEach(async () => {
    for (const c of closers.splice(0)) c();
    await Promise.all(
        servers.splice(0).map(
            (s) =>
                new Promise<void>((resolve) => {
                    s.closeAllConnections();
                    s.close(() => resolve());
                }),
        ),
    );
});

async function harness(
    opts: {
        manifest?: ShuttleManifest | null;
        terminals?: string[];
        routes?: ShuttleRoutes;
        streamAfterMs?: number;
        heartbeatMs?: number;
    } = {},
): Promise<Harness> {
    let t = 1_000_000;
    const core = createShuttleCore({ now: () => t });
    const store = createManifestStore({ read: () => null, write: () => {} });
    if (opts.manifest !== null) store.publish(opts.manifest ?? manifest());

    const terminals = opts.terminals ?? ['t-a', 't-b'];
    const routes: ShuttleRoutes = opts.routes ?? {
        endpoint: (token): EndpointRoute | null =>
            token === WS_TOKEN
                ? { kind: 'workspace', workspaceId: 'w1' }
                : token === LEGACY_TOKEN
                  ? { kind: 'terminal', terminalId: 't-legacy' }
                  : null,
        workspaceTerminals: (id) => (id === 'w1' ? terminals : []),
    };

    const listener = createShuttleListener({
        core,
        manifest: store,
        routes,
        streamAfterMs: opts.streamAfterMs ?? 40,
        heartbeatMs: opts.heartbeatMs ?? 10,
    });
    closers.push(() => listener.close());

    const server = http.createServer(listener.handle);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const frames: DispatchFrame[] = [];
    return {
        port: (server.address() as AddressInfo).port,
        core,
        frames,
        attach: () => core.attach({ dispatch: (f) => void frames.push(f) }, 1),
        clock: { advance: (ms) => void (t += ms) },
    };
}

interface Reply {
    status: number;
    headers: http.IncomingHttpHeaders;
    /** Everything received so far. */
    text(): string;
    /** Resolves when the response has ended. */
    done: Promise<void>;
    /** Resolves once the received text satisfies the predicate. */
    waitFor(test: (text: string) => boolean): Promise<void>;
}

/** Send a request and resolve as soon as the response HEADERS arrive. */
function request(
    port: number,
    opts: { path?: string; method?: string; body?: unknown; raw?: string; headers?: Record<string, string> },
): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const data = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: opts.path ?? `/mcp/${WS_TOKEN}`,
                method: opts.method ?? 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    ...(opts.headers ?? {}),
                },
            },
            (res) => {
                let text = '';
                const watchers: Array<{ test: (t: string) => boolean; resolve: () => void }> = [];
                const check = () => {
                    for (const w of watchers.slice()) {
                        if (w.test(text)) {
                            watchers.splice(watchers.indexOf(w), 1);
                            w.resolve();
                        }
                    }
                };
                const done = new Promise<void>((r, fail) => {
                    const timer = setTimeout(
                        () => fail(new Error(`response did not end in 2s; received: ${JSON.stringify(text)}`)),
                        2_000,
                    );
                    res.on('end', () => (clearTimeout(timer), r()));
                });
                done.catch(() => {}); // only an awaited reply reports it
                res.on('data', (c) => {
                    text += c;
                    check();
                });
                resolve({
                    status: res.statusCode ?? 0,
                    headers: res.headers,
                    text: () => text,
                    done,
                    waitFor: (test) =>
                        new Promise<void>((r, fail) => {
                            // Fail fast and say what was received, rather than
                            // sitting out vitest's 60s timeout.
                            const timer = setTimeout(
                                () => fail(new Error(`waited 2s; received: ${JSON.stringify(text)}`)),
                                2_000,
                            );
                            watchers.push({ test, resolve: () => (clearTimeout(timer), r()) });
                            check();
                        }),
                });
            },
        );
        req.on('error', reject);
        // No headers means the listener never answered or committed to a stream.
        req.setTimeout(2_000, () => {
            req.destroy(new Error('no response headers within 2s'));
        });
        req.end(data);
    });
}

/** Fire a request whose reply the test does not read; torn down at cleanup. */
function fire(port: number, opts: Parameters<typeof request>[1]): void {
    request(port, opts).catch(() => {});
}

async function rpc(port: number, body: unknown, path?: string) {
    const reply = await request(port, { body, path });
    await reply.done;
    const text = reply.text();
    return { status: reply.status, headers: reply.headers, text, json: text ? JSON.parse(text) : undefined };
}

/** The JSON-RPC messages carried by an SSE body. */
const sseMessages = (text: string) =>
    text
        .split('\n\n')
        .map((block) => block.split('\n').find((l) => l.startsWith('data: '))?.slice(6))
        .filter((d): d is string => !!d && d.trim().length > 0)
        .map((d) => JSON.parse(d));

const toolCall = (id: number, args: Record<string, unknown> = { terminalId: 't-a' }) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'imDone', arguments: args },
});

describe('the URL is byte-identical to today', () => {
    it('serves /mcp/<token> for a known workspace token', async () => {
        const h = await harness();
        const r = await rpc(h.port, { jsonrpc: '2.0', id: 1, method: 'ping' });
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    });

    it('404s an unknown token, exactly as server.ts does', async () => {
        const h = await harness();
        const r = await rpc(h.port, { jsonrpc: '2.0', id: 1, method: 'ping' }, '/mcp/nobodysToken');
        expect(r.status).toBe(404);
        expect(r.json).toEqual({ error: 'unknown endpoint' });
    });

    it('404s a path that is not /mcp/<token>', async () => {
        const h = await harness();
        const r = await rpc(h.port, { jsonrpc: '2.0', id: 1, method: 'ping' }, '/other');
        expect(r.status).toBe(404);
        expect(r.json).toEqual({ error: 'not found' });
    });

    it('405s a method other than GET or POST', async () => {
        const h = await harness();
        const reply = await request(h.port, { method: 'PUT', body: {} });
        await reply.done;
        expect(reply.status).toBe(405);
    });

    it('opens the server→client event stream on GET, and holds it', async () => {
        const h = await harness();
        const reply = await request(h.port, { method: 'GET' });
        expect(reply.status).toBe(200);
        expect(reply.headers['content-type']).toBe('text/event-stream');
        await reply.waitFor((t) => t.includes(': heartbeat'));
    });
});

describe('malformed input is answered, never thrown', () => {
    it('answers unparseable JSON with -32700', async () => {
        const h = await harness();
        const reply = await request(h.port, { raw: '{ not json' });
        await reply.done;
        expect(reply.status).toBe(400);
        expect(JSON.parse(reply.text()).error.code).toBe(-32700);
    });

    it('answers a body that is not a JSON-RPC message with -32600', async () => {
        const h = await harness();
        const reply = await request(h.port, { raw: '[1,2,3]' });
        await reply.done;
        expect(reply.status).toBe(400);
        expect(JSON.parse(reply.text()).error.code).toBe(-32600);
    });

    it('refuses an oversized body with 413 and keeps serving', async () => {
        const h = await harness();
        const reply = await request(h.port, { raw: JSON.stringify({ pad: 'x'.repeat(1_100_000) }) });
        await reply.done;
        expect(reply.status).toBe(413);
        const after = await rpc(h.port, { jsonrpc: '2.0', id: 2, method: 'ping' });
        expect(after.status).toBe(200);
    });

    it('survives a throwing route lookup with a 500, and serves the next request', async () => {
        // A throw out of the request handler would take the shuttle process down,
        // and with it every agent's tools on the machine (§9.1).
        let explode = true;
        const h = await harness({
            routes: {
                endpoint: () => {
                    if (explode) throw new Error('boom');
                    return { kind: 'workspace', workspaceId: 'w1' };
                },
                workspaceTerminals: () => ['t-a'],
            },
        });
        const bad = await rpc(h.port, { jsonrpc: '2.0', id: 1, method: 'ping' });
        expect(bad.status).toBe(500);

        explode = false;
        const good = await rpc(h.port, { jsonrpc: '2.0', id: 2, method: 'ping' });
        expect(good.status).toBe(200);
    });

    it('answers a notification with a bare 202 and forwards nothing', async () => {
        const h = await harness();
        h.attach();
        const r = await rpc(h.port, { jsonrpc: '2.0', method: 'notifications/initialized' });
        expect(r.status).toBe(202);
        expect(r.text).toBe('');
        expect(h.frames).toHaveLength(0);
    });
});

describe('discovery is answered from the manifest and never reaches Genie', () => {
    it('answers initialize from the manifest, with no Genie attached at all', async () => {
        const h = await harness();
        const r = await rpc(h.port, {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
        });
        expect(r.json).toEqual({
            jsonrpc: '2.0',
            id: 1,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
                serverInfo: { name: 'genie', version: '0.7.0-beta.322' },
                instructions: 'The Genie protocol.',
            },
        });
        expect(r.headers['mcp-session-id']).toBeTruthy();
    });

    it('negotiates: echoes a revision Genie speaks, and offers its preferred one otherwise', async () => {
        const h = await harness({ manifest: manifest({ protocolVersions: ['2025-06-18', '2024-11-05'] }) });
        const init = (protocolVersion: string) =>
            rpc(h.port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion } });

        expect((await init('2024-11-05')).json.result.protocolVersion).toBe('2024-11-05');
        expect((await init('1999-01-01')).json.result.protocolVersion).toBe('2025-06-18');
    });

    it('answers tools/list and prompts/list while Genie is being replaced', async () => {
        const h = await harness();
        h.attach();
        h.core.detach();

        const tools = await rpc(h.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const prompts = await rpc(h.port, { jsonrpc: '2.0', id: 2, method: 'prompts/list' });

        expect(tools.json.result.tools.map((t: { name: string }) => t.name)).toEqual(['imDone']);
        expect(prompts.json.result.prompts.map((p: { name: string }) => p.name)).toEqual(['connectToGenie']);
    });

    it('sends NOTHING to an attached Genie for initialize, lists or ping', async () => {
        const h = await harness();
        h.attach();
        for (const [id, method] of [
            [1, 'initialize'],
            [2, 'tools/list'],
            [3, 'prompts/list'],
            [4, 'ping'],
        ] as const) {
            await rpc(h.port, { jsonrpc: '2.0', id, method, params: {} });
        }
        expect(h.frames).toHaveLength(0);
    });

    it('POSITIVE CONTROL — prompts/get, which only Genie can render, IS forwarded', async () => {
        // Without this, "nothing reached Genie" also passes for a listener that
        // forwards nothing at all.
        const h = await harness({ streamAfterMs: 5_000 });
        h.attach();
        const pending = request(h.port, {
            body: { jsonrpc: '2.0', id: 9, method: 'prompts/get', params: { name: 'connectToGenie' } },
        });
        await until(() => h.frames.length === 1);
        h.core.result(h.frames[0]!.correlationId, { result: { messages: [] } });
        const reply = await pending;
        await reply.done;
        expect(JSON.parse(reply.text()).result).toEqual({ messages: [] });
    });

    it('says honestly that nothing has been published, rather than listing zero tools', async () => {
        // An empty tool list reads as "this server has no tools" — the misreading
        // genie#346 is about.
        const h = await harness({ manifest: null });
        const r = await rpc(h.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(r.json.result).toBeUndefined();
        expect(r.json.error.code).toBe(SHUTTLE_ERROR_CODES.GenieDetached);
        expect(r.json.error.message).toMatch(/Genie/);
    });

    it('POSITIVE CONTROL — a manifest that declares no tools IS an empty list', async () => {
        const h = await harness({ manifest: manifest({ tools: [] }) });
        const r = await rpc(h.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(r.json.result).toEqual({ tools: [] });
    });

    it('treats resources/list as unknown unless Genie declared the capability, as today', async () => {
        const h = await harness();
        const r = await rpc(h.port, { jsonrpc: '2.0', id: 1, method: 'resources/list' });
        expect(r.json.error.code).toBe(-32601);
    });

    it('POSITIVE CONTROL — serves resources/list once Genie declares resources', async () => {
        const h = await harness({
            manifest: manifest({
                capabilities: { tools: {}, resources: {} },
                resources: [{ uri: 'genie://guide', name: 'guide' }],
            }),
        });
        const r = await rpc(h.port, { jsonrpc: '2.0', id: 1, method: 'resources/list' });
        expect(r.json.result).toEqual({ resources: [{ uri: 'genie://guide', name: 'guide' }] });
    });
});

describe('forwarding — a pipe with a manifest', () => {
    it('forwards a tools/call EXACTLY as the client sent it, with its route beside it', async () => {
        const h = await harness({ streamAfterMs: 5_000 });
        h.attach();
        const sent = toolCall(7, { terminalId: 't-b', note: { nested: [1, 'two'] }, handoff: 'x' });

        // Headers only arrive once the call is answered, so do not wait for them first.
        const pending = request(h.port, { body: sent });
        await until(() => h.frames.length === 1);
        expect(h.frames[0]!.request).toEqual(sent);
        expect(h.frames[0]!.route).toEqual({ token: WS_TOKEN, terminalId: 't-b' });

        h.core.result(h.frames[0]!.correlationId, { result: { content: [{ type: 'text', text: 'ok' }] } });
        const reply = await pending;
        await reply.done;
        expect(JSON.parse(reply.text())).toEqual({
            jsonrpc: '2.0',
            id: 7,
            result: { content: [{ type: 'text', text: 'ok' }] },
        });
    });

    it('answers a call that settles quickly as a single JSON response, as today', async () => {
        const h = await harness({ streamAfterMs: 5_000 });
        // A publisher that answers the moment it is dispatched to.
        h.core.attach(
            { dispatch: (f) => queueMicrotask(() => h.core.result(f.correlationId, { result: { ok: true } })) },
            1,
        );
        const reply = await request(h.port, { body: toolCall(3) });
        await reply.done;
        expect(reply.headers['content-type']).toBe('application/json');
        expect(JSON.parse(reply.text())).toEqual({ jsonrpc: '2.0', id: 3, result: { ok: true } });
    });

    it('forwards a method it does not know, so a newer Genie can answer it without a new shuttle', async () => {
        const h = await harness({ streamAfterMs: 5_000 });
        h.attach();
        const pending = request(h.port, {
            body: { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'genie://x' } },
        });
        await until(() => h.frames.length === 1);
        expect(h.frames.map((f) => f.request.method)).toEqual(['resources/read']);
        h.core.result(h.frames[0]!.correlationId, { result: { contents: [] } });
        const reply = await pending;
        await reply.done;
        expect(JSON.parse(reply.text()).result).toEqual({ contents: [] });
    });
});

describe('which terminal a call acts for — resolved exactly as server.ts does', () => {
    it('REFUSES a tools/call on a multi-terminal workspace that names no terminal, and forwards nothing', async () => {
        const h = await harness({ terminals: ['t-a', 't-b'] });
        h.attach();
        const r = await rpc(h.port, toolCall(1, {}));
        expect(r.json).toEqual({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32602, message: AMBIGUOUS_TERMINAL_MESSAGE },
        });
        expect(h.frames).toHaveLength(0);
    });

    it('refuses a terminalId that is not a member of the workspace', async () => {
        const h = await harness({ terminals: ['t-a'] });
        h.attach();
        const r = await rpc(h.port, toolCall(1, { terminalId: 't-elsewhere' }));
        expect(r.json.error.code).toBe(-32602);
        expect(h.frames).toHaveLength(0);
    });

    it('resolves the only terminal of a single-terminal workspace', async () => {
        const h = await harness({ terminals: ['t-only'] });
        h.attach();
        fire(h.port, { body: toolCall(1, {}) });
        await until(() => h.frames.length === 1);
        expect(h.frames[0]!.route).toEqual({ token: WS_TOKEN, terminalId: 't-only' });
    });

    it('resolves a legacy per-terminal endpoint to its own terminal', async () => {
        const h = await harness();
        h.attach();
        fire(h.port, { body: toolCall(1, {}), path: `/mcp/${LEGACY_TOKEN}` });
        await until(() => h.frames.length === 1);
        expect(h.frames[0]!.route).toEqual({ token: LEGACY_TOKEN, terminalId: 't-legacy' });
    });

    it('forwards a non-tools/call request with no terminal instead of refusing it, as server.ts does', async () => {
        // server.ts refuses only tools/call; prompts/get with no terminal renders a
        // "name your terminal" prompt (genie#334). Refusing here would change that.
        const h = await harness({ terminals: ['t-a', 't-b'] });
        h.attach();
        fire(h.port, { body: { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'x' } } });
        await until(() => h.frames.length === 1);
        expect(h.frames[0]!.route).toEqual({ token: WS_TOKEN, terminalId: '' });
    });
});

describe('a call that has to wait keeps its connection alive', () => {
    it('switches an unsettled call to a heartbeat stream, and delivers the answer on it', async () => {
        const h = await harness({ streamAfterMs: 20, heartbeatMs: 10 });
        h.attach();
        // Headers only arrive once the listener commits to a stream.
        const reply = await request(h.port, { body: toolCall(5) });
        expect(reply.headers['content-type']).toBe('text/event-stream');

        await reply.waitFor((t) => t.includes(': heartbeat'));
        h.core.result(h.frames[0]!.correlationId, { result: { answered: true } });
        await reply.done;

        expect(sseMessages(reply.text()).at(-1)).toEqual({ jsonrpc: '2.0', id: 5, result: { answered: true } });
    });

    it('sends MCP progress on the stream only when the client asked for it, rising each beat', async () => {
        const h = await harness({ streamAfterMs: 20, heartbeatMs: 10 });
        h.attach();
        const withToken = { ...toolCall(6), params: { ...toolCall(6).params, _meta: { progressToken: 'p1' } } };
        const reply = await request(h.port, { body: withToken });
        await reply.waitFor((t) => sseMessages(t).filter((m) => m.method === 'notifications/progress').length >= 2);
        h.core.result(h.frames[0]!.correlationId, { result: {} });
        await reply.done;

        const progress = sseMessages(reply.text()).filter((m) => m.method === 'notifications/progress');
        expect(progress[0].params.progressToken).toBe('p1');
        expect(progress[1].params.progress).toBeGreaterThan(progress[0].params.progress);

        const plain = await request(h.port, { body: toolCall(7) });
        await plain.waitFor((t) => (t.match(/: heartbeat/g) ?? []).length >= 2);
        h.core.result(h.frames[1]!.correlationId, { result: {} });
        await plain.done;
        expect(sseMessages(plain.text()).some((m) => m.method === 'notifications/progress')).toBe(false);
    });

    it('THE SWAP — a call made while Genie is away waits on one open connection and completes on the new Genie', async () => {
        // The Phase 1 property at this layer: the agent's HTTP response never
        // closes across the swap. Old Genie gone → call parked → new Genie
        // attaches → call runs → answer arrives on the response it opened.
        const h = await harness({ streamAfterMs: 20, heartbeatMs: 10 });
        h.attach();
        h.core.detach(); // the old Genie exits

        const reply = await request(h.port, { body: toolCall(11) });
        expect(reply.headers['content-type']).toBe('text/event-stream');
        await reply.waitFor((t) => t.includes(': heartbeat'));
        expect(h.frames).toHaveLength(0); // nobody to send it to yet

        const newGenie: DispatchFrame[] = [];
        h.core.attach({ dispatch: (f) => void newGenie.push(f) }, 2);
        expect(newGenie).toHaveLength(1);
        h.core.result(newGenie[0]!.correlationId, { result: { ranOn: 'new' } });
        await reply.done;

        expect(sseMessages(reply.text()).at(-1)).toEqual({ jsonrpc: '2.0', id: 11, result: { ranOn: 'new' } });
    });

    it('answers an in-flight call interrupted by the swap with GenieSwapInterrupted on its open stream', async () => {
        const h = await harness({ streamAfterMs: 20, heartbeatMs: 10 });
        h.attach();
        const reply = await request(h.port, { body: toolCall(12) });
        await reply.waitFor((t) => t.includes(': heartbeat'));

        h.core.detach();
        await reply.done;

        expect(sseMessages(reply.text()).at(-1).error.code).toBe(SHUTTLE_ERROR_CODES.GenieSwapInterrupted);
    });

    it('fails a call IMMEDIATELY once Genie has been gone past the grace window, instead of parking it', async () => {
        const h = await harness({ streamAfterMs: 5_000 });
        h.attach();
        h.core.detach();
        h.clock.advance(SWAP_GRACE_MS);

        const reply = await request(h.port, { body: toolCall(13) });
        await reply.done;

        expect(reply.headers['content-type']).toBe('application/json');
        expect(JSON.parse(reply.text()).error.code).toBe(SHUTTLE_ERROR_CODES.GenieOrphaned);
    }, 2_000);

    it('keeps serving after a client hangs up mid-call, and delivers nothing to the dead socket', async () => {
        const h = await harness({ streamAfterMs: 20, heartbeatMs: 10 });
        h.attach();
        const gone = await new Promise<http.ClientRequest>((resolve) => {
            const req = http.request({
                host: '127.0.0.1',
                port: h.port,
                path: `/mcp/${WS_TOKEN}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            req.on('response', () => resolve(req));
            req.on('error', () => {});
            req.end(JSON.stringify(toolCall(14)));
        });
        gone.destroy();
        await until(() => h.frames.length === 1);

        expect(() => h.core.result(h.frames[0]!.correlationId, { result: {} })).not.toThrow();
        const after = await rpc(h.port, { jsonrpc: '2.0', id: 15, method: 'ping' });
        expect(after.status).toBe(200);
    });
});

async function until(test: () => boolean, timeoutMs = 1_000): Promise<void> {
    const start = Date.now();
    while (!test()) {
        if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 5));
    }
}
