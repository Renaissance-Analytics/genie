import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
    startMcpServer,
    stopMcpServer,
    restartMcpServer,
    mcpServerState,
    mcpServerPort,
    workspaceEndpointUrl,
    registerTerminalEndpoint,
    pushToWorkspace,
    pushToTerminal,
    DEFAULT_MCP_PORT,
} from '../server';

// server.ts is pure Node (http/crypto/fs/path/protocol) — no electron — so it
// can be exercised directly over the loopback socket.

function tmpUserDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'genie-mcp-test-'));
}

/** POST a JSON-RPC message to a /mcp/<token> endpoint; resolve {status, body}. */
function rpc(
    port: number,
    token: string,
    msg: unknown,
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(msg);
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: `/mcp/${token}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
            },
            (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            },
        );
        req.on('error', reject);
        req.end(data);
    });
}

/**
 * POST a JSON-RPC message and collect a streamed (text/event-stream) response.
 * Resolves once the socket closes with the raw stream text + the parsed
 * JSON-RPC `message` events (data: lines), so tests can assert on both the
 * heartbeat/progress traffic and the final response.
 */
function rpcStream(
    port: number,
    token: string,
    msg: unknown,
): Promise<{ status: number; contentType: string; raw: string; events: any[] }> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(msg);
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: `/mcp/${token}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'Content-Length': Buffer.byteLength(data),
                },
            },
            (res) => {
                let raw = '';
                res.on('data', (c) => (raw += c));
                res.on('end', () => {
                    const events = raw
                        .split('\n')
                        .filter((l) => l.startsWith('data:'))
                        .map((l) => JSON.parse(l.slice(5).trim()));
                    resolve({
                        status: res.statusCode ?? 0,
                        contentType: String(res.headers['content-type'] ?? ''),
                        raw,
                        events,
                    });
                });
            },
        );
        req.on('error', reject);
        req.end(data);
    });
}

/**
 * A heartbeat scheduler the TEST drives, injected in place of the server's real
 * `setInterval`.
 *
 * These tests used to prove the keepalive by setting GENIE_MCP_HEARTBEAT_MS=20
 * and having the handler resolve after a real 120ms — i.e. betting that a real
 * interval fires inside a real delay. That bet is off the moment anything
 * disturbs the ambient clock: in genie#76 an earlier test file left
 * `globalThis.setInterval` bound to an uninstalled fake clock, the interval
 * never fired at all, and these five tests failed while looking like CI load.
 *
 * With the beat injected there is no clock in the loop: the handler fires the
 * beat itself, so "heartbeat, then response" is an ORDERING the test states
 * rather than a race it hopes to win.
 */
function manualHeartbeat() {
    const beats = new Set<() => void>();
    return {
        /** The port handed to the server; returns its unsubscribe. */
        schedule: (beat: () => void): (() => void) => {
            beats.add(beat);
            return () => beats.delete(beat);
        },
        /** Emit one beat on every stream currently waiting, synchronously. */
        fire: (): void => {
            for (const beat of beats) beat();
        },
        /** Streams still subscribed — 0 after the server tears a beat down. */
        get scheduled(): number {
            return beats.size;
        },
    };
}

/**
 * POST a JSON-RPC message and hand back the stream WHILE it is still open, so a
 * test can wait on bytes (a heartbeat) before letting the handler settle.
 * `done` resolves with the full raw stream once the socket closes.
 */
function rpcStreamOpen(
    port: number,
    token: string,
    msg: unknown,
): Promise<{ read: () => string; done: Promise<string> }> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(msg);
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: `/mcp/${token}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'Content-Length': Buffer.byteLength(data),
                },
            },
            (res) => {
                let raw = '';
                res.on('data', (c) => (raw += c));
                resolve({
                    read: () => raw,
                    done: new Promise<string>((r) => res.on('end', () => r(raw))),
                });
            },
        );
        req.on('error', reject);
        req.end(data);
    });
}

/** Poll `fn` until it holds. Waits FOR a condition — never a bare sleep that
 *  assumes one has happened by now. */
const until = async (fn: () => boolean, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('condition not met in time');
};

const deps = (
    userDataDir: string,
    configuredPort: number,
    terminals: { ids: string[]; lastActive: string | null },
    onImDone: (id: string) => void,
    onForceQuestion: () => Promise<{ cancelled: boolean; answers: any[] }> = async () => ({
        cancelled: true,
        answers: [],
    }),
    manageProcess: () => Promise<{ ok: boolean; processes: any[] }> = async () => ({
        ok: true,
        processes: [],
    }),
    provisionWorkspaces: () => Promise<{
        ok: boolean;
        isOps: boolean;
        children: any[];
    }> = async () => ({ ok: true, isOps: true, children: [] }),
    manageTerminals: () => Promise<{ ok: boolean; terminals: any[] }> = async () => ({
        ok: true,
        terminals: [],
    }),
    runAgent: () => Promise<{ ok: boolean; id?: string }> = async () => ({ ok: true }),
    manageWorkspaces: () => Promise<{ ok: boolean; workspaces: any[] }> = async () => ({
        ok: true,
        workspaces: [],
    }),
    agentInbox: () => Promise<{
        ok: boolean;
        messages?: any[];
        cursor?: number;
    }> = async () => ({ ok: true, messages: [], cursor: 0 }),
    knowledge: () => Promise<{ ok: boolean }> = async () => ({ ok: true }),
) => ({
    serverVersion: '0.0.0-test',
    userDataDir,
    configuredPort: () => configuredPort,
    workspaceTerminals: () => terminals,
    onImDone,
    checkIssues: async () => ({
        connected: true,
        workspaceResolved: true,
        counts: { issue: 0, pr: 0, security: 0 },
        items: [],
    }),
    onForceQuestion,
    describeWorkspace: async () => null,
    manageProcess,
    // The container Dev Server is not exercised by these transport tests; a stub
    // keeps the deps complete without pulling a runtime probe into them.
    manageSite: async () => ({ ok: true, sites: [] }),
    provisionWorkspaces,
    manageTerminals,
    runAgent,
    manageWorkspaces,
    agentInbox,
    knowledge,
    openFileForUser: async () => ({ ok: true, reused: false, openedNew: true }),
    setEnv: () => ({ ok: true, file: '.env' }),
    checkEnv: () => ({ ok: true, exists: false, file: '.env' }),
    isOpsProject: async () => true,
});

afterEach(() => stopMcpServer());

describe('mcp server', () => {
    it('binds an ephemeral port (0) and reports running state', async () => {
        const dir = tmpUserDir();
        await startMcpServer(deps(dir, 0, { ids: [], lastActive: null }, () => {}));
        const st = mcpServerState();
        expect(st.running).toBe(true);
        expect(st.conflict).toBe(false);
        expect(st.port).toBe(mcpServerPort());
        expect(st.configuredPort).toBe(0);
    });

    it('mints a stable, env-free workspace endpoint url', async () => {
        const dir = tmpUserDir();
        await startMcpServer(deps(dir, 0, { ids: [], lastActive: null }, () => {}));
        const url1 = workspaceEndpointUrl('ws-1');
        const url2 = workspaceEndpointUrl('ws-1');
        expect(url1).toBe(url2); // idempotent per workspace
        expect(url1).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-f0-9]+$/);
        expect(url1).not.toContain('${');
    });

    /**
     * Terminal resolution used to fall back to the LAST-ACTIVE terminal whenever a
     * caller omitted `terminalId`. That is nondeterministic exactly when it matters
     * — under concurrent orchestration "last active" is whatever another agent
     * touched most recently. Worse, `agentinbox` mints an agent's durable identity
     * onto whatever terminal resolves, so a busy workspace could attach identity to
     * a stranger's pane (the "identity flips" in genie#17).
     *
     * The contract now: an explicit `terminalId` wins; a workspace with exactly ONE
     * terminal is unambiguous and still resolves; anything else is an ERROR rather
     * than a guess. Every pty already carries GENIE_TERMINAL_ID, so a caller that
     * hits this needs fixing, not papering over.
     */
    it('refuses to guess when a workspace has several terminals and no terminalId', async () => {
        const dir = tmpUserDir();
        const seen: string[] = [];
        await startMcpServer(
            deps(
                dir,
                0,
                { ids: ['t-a', 't-b'], lastActive: 't-b' },
                (id) => seen.push(id),
            ),
        );
        const url = workspaceEndpointUrl('ws-1')!;
        const token = url.split('/').pop()!;
        const res = await rpc(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'imDone', arguments: {} },
        });

        // No side effect on ANY terminal — silently glowing the wrong one is the bug.
        expect(seen).toEqual([]);
        // And the caller is told why, naming the env var that fixes it.
        const body = JSON.stringify(res.body);
        expect(body).toContain('GENIE_TERMINAL_ID');
    });

    it('still resolves without a terminalId when the workspace has exactly one terminal', async () => {
        // One candidate is not a guess. Keeping this avoids breaking every
        // single-terminal workspace for a bug that only exists under ambiguity.
        const dir = tmpUserDir();
        const seen: string[] = [];
        await startMcpServer(
            deps(dir, 0, { ids: ['t-only'], lastActive: 't-only' }, (id) => seen.push(id)),
        );
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        await rpc(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'imDone', arguments: {} },
        });
        expect(seen).toEqual(['t-only']);
    });

    it('refuses a terminalId that is not a member of the token workspace', async () => {
        // A stale id from another workspace must not silently fall back to a local
        // terminal — that would be the same wrong-pane bug by another route.
        const dir = tmpUserDir();
        const seen: string[] = [];
        await startMcpServer(
            deps(dir, 0, { ids: ['t-a', 't-b'], lastActive: 't-b' }, (id) => seen.push(id)),
        );
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        await rpc(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'imDone', arguments: { terminalId: 't-elsewhere' } },
        });
        expect(seen).toEqual([]);
    });

    it('honours an explicit terminalId arg when it is a workspace member', async () => {
        const dir = tmpUserDir();
        const seen: string[] = [];
        await startMcpServer(
            deps(
                dir,
                0,
                { ids: ['t-a', 't-b'], lastActive: 't-b' },
                (id) => seen.push(id),
            ),
        );
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        await rpc(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'imDone', arguments: { terminalId: 't-a' } },
        });
        expect(seen).toEqual(['t-a']); // explicit arg wins over last-active
    });

    it('still resolves a legacy per-terminal token directly', async () => {
        const dir = tmpUserDir();
        const seen: string[] = [];
        await startMcpServer(
            deps(dir, 0, { ids: [], lastActive: null }, (id) => seen.push(id)),
        );
        const token = registerTerminalEndpoint('term-legacy')!.split('/').pop()!;
        await rpc(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'imDone', arguments: {} },
        });
        expect(seen).toEqual(['term-legacy']);
    });

    it('falls back to an ephemeral port and flags a conflict when the configured port is taken', async () => {
        // Occupy a port, then ask the MCP server to bind the SAME one.
        const blocker = http.createServer(() => {});
        const taken: number = await new Promise((resolve) => {
            blocker.listen(0, '127.0.0.1', () => {
                resolve((blocker.address() as { port: number }).port);
            });
        });
        try {
            const dir = tmpUserDir();
            await startMcpServer(deps(dir, taken, { ids: [], lastActive: null }, () => {}));
            const st = mcpServerState();
            expect(st.running).toBe(true);
            expect(st.conflict).toBe(true);
            expect(st.port).not.toBe(taken); // bound elsewhere
            expect(st.configuredPort).toBe(taken);
        } finally {
            await new Promise<void>((r) => blocker.close(() => r()));
        }
    });

    it('restartMcpServer rebinds and clears a prior conflict on a free port', async () => {
        const dir = tmpUserDir();
        await startMcpServer(deps(dir, 0, { ids: [], lastActive: null }, () => {}));
        const before = mcpServerPort();
        await restartMcpServer();
        expect(mcpServerState().running).toBe(true);
        // A fresh ephemeral bind may differ; the point is it's listening again.
        expect(mcpServerPort()).not.toBeNull();
        void before;
    });

    it('exposes DEFAULT_MCP_PORT as an obscure fixed port', () => {
        expect(DEFAULT_MCP_PORT).toBe(51717);
    });

    it('serves a manageProcess CREATE over SSE so an approval gate never times out', async () => {
        // A create can block on the per-workspace process-approval prompt, so it
        // must take the heartbeat SSE path (like ForceTheQuestion). The dep
        // stands in for that parked gate: it beats the keepalive while the user
        // would be deciding, then answers.
        const hb = manualHeartbeat();
        const dir = tmpUserDir();
        await startMcpServer({
            ...deps(
                dir,
                0,
                { ids: ['t-a'], lastActive: 't-a' },
                () => {},
                undefined,
                async () => {
                    hb.fire();
                    return { ok: true, processes: [] };
                },
            ),
            scheduleHeartbeat: hb.schedule,
        });
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        const res = await rpcStream(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 11,
            method: 'tools/call',
            params: {
                name: 'manageProcess',
                arguments: { action: 'create', label: 'dev', command: 'npm run dev' },
            },
        });
        expect(res.contentType).toContain('text/event-stream');
        expect(res.raw).toContain(': heartbeat'); // kept alive during the gate
        expect(res.events.some((e) => e.id === 11)).toBe(true); // final response delivered
        expect(hb.scheduled).toBe(0); // and the beat is torn down with the stream
    });

    it('serves a manageProcess LIST as a single JSON response (no blocking path)', async () => {
        const dir = tmpUserDir();
        await startMcpServer(deps(dir, 0, { ids: ['t-a'], lastActive: 't-a' }, () => {}));
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        const res = await rpc(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 12,
            method: 'tools/call',
            params: { name: 'manageProcess', arguments: { action: 'list' } },
        });
        expect(res.status).toBe(200);
        // Plain JSON-RPC, not an SSE stream.
        const body = JSON.parse(res.body);
        expect(body.id).toBe(12);
    });

    it('serves a manageTerminals CREATE over SSE so the approval gate never times out', async () => {
        const hb = manualHeartbeat();
        const dir = tmpUserDir();
        await startMcpServer({
            ...deps(
                dir,
                0,
                { ids: ['t-a'], lastActive: 't-a' },
                () => {},
                undefined,
                undefined,
                undefined,
                // manageTerminals dep parked on the gate: beat, then answer.
                async () => {
                    hb.fire();
                    return { ok: true, terminals: [] };
                },
            ),
            scheduleHeartbeat: hb.schedule,
        });
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        const res = await rpcStream(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 50,
            method: 'tools/call',
            params: {
                name: 'manageTerminals',
                arguments: { action: 'create', label: 'agent' },
            },
        });
        expect(res.contentType).toContain('text/event-stream');
        expect(res.raw).toContain(': heartbeat');
        expect(res.events.some((e) => e.id === 50)).toBe(true);
        expect(hb.scheduled).toBe(0);
    });

    it('serves a manageTerminals READ as a single JSON response (no blocking path)', async () => {
        const dir = tmpUserDir();
        await startMcpServer(
            deps(
                dir,
                0,
                { ids: ['t-a'], lastActive: 't-a' },
                () => {},
                undefined,
                undefined,
                undefined,
                async () => ({ ok: true, terminals: [], data: 'out', cursor: 3 }),
            ),
        );
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        const res = await rpc(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 51,
            method: 'tools/call',
            params: { name: 'manageTerminals', arguments: { action: 'read', id: 't-a' } },
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.id).toBe(51);
    });

    it('serves a runAgent START over SSE so the approval gate never times out', async () => {
        const hb = manualHeartbeat();
        const dir = tmpUserDir();
        await startMcpServer({
            ...deps(
                dir,
                0,
                { ids: ['t-a'], lastActive: 't-a' },
                () => {},
                undefined,
                undefined,
                undefined,
                undefined,
                async () => {
                    hb.fire();
                    return { ok: true, id: 'a-1' };
                },
            ),
            scheduleHeartbeat: hb.schedule,
        });
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        const res = await rpcStream(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 52,
            method: 'tools/call',
            params: { name: 'runAgent', arguments: { action: 'start', agent: 'claude' } },
        });
        expect(res.contentType).toContain('text/event-stream');
        expect(res.raw).toContain(': heartbeat');
        expect(res.events.some((e) => e.id === 52)).toBe(true);
        expect(hb.scheduled).toBe(0);
    });

    it('serves an agentinbox RECEIVE+wait over SSE so a long-poll never times out', async () => {
        // A `receive` with wait:true parks a long-poll waiter; it must ride the
        // heartbeat SSE path (like ForceTheQuestion) so the client never times
        // out. The dep stands in for that parked poll: beat, then deliver.
        const hb = manualHeartbeat();
        const dir = tmpUserDir();
        await startMcpServer({
            ...deps(
                dir,
                0,
                { ids: ['t-a'], lastActive: 't-a' },
                () => {},
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                async () => {
                    hb.fire();
                    return { ok: true, messages: [{ seq: 1, text: 'hi' }], cursor: 1 };
                },
            ),
            scheduleHeartbeat: hb.schedule,
        });
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        const res = await rpcStream(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 80,
            method: 'tools/call',
            params: { name: 'agentinbox', arguments: { action: 'receive', wait: true } },
        });
        expect(res.contentType).toContain('text/event-stream');
        expect(res.raw).toContain(': heartbeat'); // kept alive while polling
        expect(res.events.some((e) => e.id === 80)).toBe(true); // final response delivered
        expect(hb.scheduled).toBe(0);
    });

    it('serves an agentinbox LIST as a single JSON response (no blocking path)', async () => {
        const dir = tmpUserDir();
        await startMcpServer(deps(dir, 0, { ids: ['t-a'], lastActive: 't-a' }, () => {}));
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        const res = await rpc(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 81,
            method: 'tools/call',
            params: { name: 'agentinbox', arguments: { action: 'list' } },
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.id).toBe(81);
    });

    it('serves an agentinbox RECEIVE without wait as a single JSON response', async () => {
        const dir = tmpUserDir();
        await startMcpServer(deps(dir, 0, { ids: ['t-a'], lastActive: 't-a' }, () => {}));
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        const res = await rpc(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 82,
            method: 'tools/call',
            params: { name: 'agentinbox', arguments: { action: 'receive' } },
        });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body).id).toBe(82);
    });

    it('answers ForceTheQuestion over an SSE stream (never a timed-out single response)', async () => {
        const dir = tmpUserDir();
        await startMcpServer(
            deps(
                dir,
                0,
                { ids: ['t-a'], lastActive: 't-a' },
                () => {},
                async () => ({
                    cancelled: false,
                    answers: [{ header: 'Go?', question: 'Proceed?', selected: ['Yes'], note: '' }],
                }),
            ),
        );
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        const res = await rpcStream(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: {
                name: 'ForceTheQuestion',
                arguments: {
                    questions: [
                        { header: 'Go?', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] },
                    ],
                },
            },
        });
        expect(res.status).toBe(200);
        expect(res.contentType).toContain('text/event-stream');
        // The final JSON-RPC response arrives as the last data event and carries
        // the user's answer.
        const final = res.events.find((e) => e.id === 7);
        expect(final).toBeTruthy();
        expect(final.result.content[0].text).toContain('Yes');
    });

    it('heartbeats a pending ForceTheQuestion so the request stays alive past the idle window', async () => {
        const hb = manualHeartbeat();
        const dir = tmpUserDir();
        await startMcpServer({
            ...deps(
                dir,
                0,
                { ids: ['t-a'], lastActive: 't-a' },
                () => {},
                // The user takes their time: three keepalive beats pass before
                // an answer comes back. Driving the beats here rather than
                // waiting out three real intervals makes the COUNT assertable.
                async () => {
                    hb.fire();
                    hb.fire();
                    hb.fire();
                    return { cancelled: false, answers: [] };
                },
            ),
            scheduleHeartbeat: hb.schedule,
        });
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        const res = await rpcStream(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 9,
            method: 'tools/call',
            // Opt into progress so we get spec notifications too.
            params: {
                name: 'ForceTheQuestion',
                _meta: { progressToken: 'p9' },
                arguments: {
                    questions: [
                        { header: 'Q', question: 'Wait?', options: [{ label: 'A' }, { label: 'B' }] },
                    ],
                },
            },
        });
        // Every beat kept the stream warm before the answer — exactly the three
        // we drove, no more (a comment line per beat).
        expect(res.raw.match(/: heartbeat/g)).toHaveLength(3);
        // Each beat also emitted a spec progress notification against the
        // supplied token, and `progress` rises monotonically as the spec requires.
        const progress = res.events.filter((e) => e.method === 'notifications/progress');
        expect(progress.map((e) => e.params.progress)).toEqual([1, 2, 3]);
        expect(progress.every((e) => e.params.progressToken === 'p9')).toBe(true);
        // And the final response still arrived after all that waiting.
        expect(res.events.some((e) => e.id === 9)).toBe(true);
        expect(hb.scheduled).toBe(0);
    });

    it('beats on a REAL interval when no scheduler is injected (the production path)', async () => {
        // The tests above inject the beat, which proves the SSE wiring but would
        // happily keep passing if the default scheduler were deleted — and that
        // default is what ships. So exercise it: no scheduleHeartbeat, a real
        // timer, GENIE_MCP_HEARTBEAT_MS to keep the cadence short.
        //
        // It waits FOR a beat instead of racing one: the handler stays parked
        // until the client has actually received ': heartbeat', so a slow runner
        // makes this test slower, never red. (If a real interval genuinely never
        // fires — the genie#76 breakage — it fails here, correctly.)
        const prev = process.env.GENIE_MCP_HEARTBEAT_MS;
        process.env.GENIE_MCP_HEARTBEAT_MS = '20';
        let release = (): void => {};
        const parked = new Promise<void>((r) => {
            release = () => r();
        });
        try {
            const dir = tmpUserDir();
            await startMcpServer(
                deps(
                    dir,
                    0,
                    { ids: ['t-a'], lastActive: 't-a' },
                    () => {},
                    undefined,
                    async () => {
                        await parked;
                        return { ok: true, processes: [] };
                    },
                ),
            );
            const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
            const s = await rpcStreamOpen(mcpServerPort()!, token, {
                jsonrpc: '2.0',
                id: 13,
                method: 'tools/call',
                params: {
                    name: 'manageProcess',
                    arguments: { action: 'create', label: 'dev', command: 'npm run dev' },
                },
            });
            // The gate is still open; the keepalive must arrive on its own.
            await until(() => s.read().includes(': heartbeat'));
            release();
            const raw = await s.done;
            expect(raw).toContain(': heartbeat');
            expect(raw).toContain('"id":13'); // and the response still followed
        } finally {
            release();
            if (prev === undefined) delete process.env.GENIE_MCP_HEARTBEAT_MS;
            else process.env.GENIE_MCP_HEARTBEAT_MS = prev;
        }
    });
});

/**
 * The server->client GET SSE stream (MCP Streamable HTTP §"Listening for
 * Messages from the Server"). Drives it over a real socket: a GET opens the
 * stream (previously 405), initialize hands back an Mcp-Session-Id, and a
 * server-side push reaches the open stream. This is the PROBE — the transport
 * half whose live behaviour against a real client we still have to measure.
 */
describe('mcp server — GET server-push stream', () => {
    /** Open a GET SSE stream; resolve once `bytes` contains `marker`, keeping
     *  the socket OPEN so the caller can trigger a push, then close it. */
    function openStream(
        portNum: number,
        token: string,
        headers: Record<string, string> = {},
    ): Promise<{ status: number; contentType: string; read: () => string; close: () => void }> {
        return new Promise((resolve, reject) => {
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port: portNum,
                    path: `/mcp/${token}`,
                    method: 'GET',
                    headers: { Accept: 'text/event-stream', ...headers },
                },
                (res) => {
                    let bytes = '';
                    res.on('data', (c) => (bytes += c));
                    res.on('error', () => {});
                    resolve({
                        status: res.statusCode ?? 0,
                        contentType: String(res.headers['content-type'] ?? ''),
                        read: () => bytes,
                        close: () => req.destroy(),
                    });
                },
            );
            req.on('error', reject);
            req.end();
        });
    }

    /** POST that also returns response headers (for the Mcp-Session-Id check). */
    function rpcWithHeaders(
        portNum: number,
        token: string,
        msg: unknown,
    ): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(msg);
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port: portNum,
                    path: `/mcp/${token}`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data),
                    },
                },
                (res) => {
                    res.on('data', () => {});
                    res.on('end', () =>
                        resolve({ status: res.statusCode ?? 0, headers: res.headers }),
                    );
                },
            );
            req.on('error', reject);
            req.end(data);
        });
    }

    it('answers a GET with an SSE stream instead of 405', async () => {
        const dir = tmpUserDir();
        await startMcpServer(deps(dir, 0, { ids: ['t-a'], lastActive: 't-a' }, () => {}));
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;

        const s = await openStream(mcpServerPort()!, token);
        try {
            expect(s.status).toBe(200);
            expect(s.contentType).toContain('text/event-stream');
            await until(() => s.read().includes(': open'));
        } finally {
            s.close();
        }
    });

    it('hands the client an Mcp-Session-Id at initialize', async () => {
        const dir = tmpUserDir();
        await startMcpServer(deps(dir, 0, { ids: ['t-a'], lastActive: 't-a' }, () => {}));
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;

        const r = await rpcWithHeaders(mcpServerPort()!, token, {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {},
        });
        expect(r.status).toBe(200);
        expect(r.headers['mcp-session-id']).toBeTruthy();
    });

    it('pushToWorkspace delivers a notification onto the open stream', async () => {
        const dir = tmpUserDir();
        await startMcpServer(deps(dir, 0, { ids: ['t-a'], lastActive: 't-a' }, () => {}));
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;

        const s = await openStream(mcpServerPort()!, token);
        try {
            await until(() => s.read().includes(': open'));

            const reached = pushToWorkspace('ws-1', {
                method: 'notifications/message',
                params: { level: 'info', data: 'you have a new AgentInbox message' },
            });
            expect(reached).toBe(1);

            await until(() => s.read().includes('notifications/message'));
            expect(s.read()).toContain('you have a new AgentInbox message');
        } finally {
            s.close();
        }
    });

    it('pushToWorkspace reaches nobody when no stream is open (the measurement)', async () => {
        const dir = tmpUserDir();
        await startMcpServer(deps(dir, 0, { ids: ['t-a'], lastActive: 't-a' }, () => {}));
        // No GET stream opened — a push must report 0 reached.
        expect(pushToWorkspace('ws-1', { method: 'notifications/message' })).toBe(0);
    });

    /** POST that lets the caller set request headers (to echo Mcp-Session-Id). */
    function postWithHeaders(
        portNum: number,
        token: string,
        msg: unknown,
        extra: Record<string, string>,
    ): Promise<{ status: number }> {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(msg);
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port: portNum,
                    path: `/mcp/${token}`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data),
                        ...extra,
                    },
                },
                (res) => {
                    res.on('data', () => {});
                    res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
                },
            );
            req.on('error', reject);
            req.end(data);
        });
    }

    it('routes a push to ONE agent once its session↔terminal is correlated', async () => {
        const dir = tmpUserDir();
        await startMcpServer(
            deps(dir, 0, { ids: ['t-a', 't-b'], lastActive: 't-b' }, () => {}),
        );
        const port = mcpServerPort()!;
        const token = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        const sessionA = 'sess-A';

        // The client echoes its session id on a tools/call naming terminal t-a —
        // this is what correlates sessionA ↔ t-a server-side.
        await postWithHeaders(
            port,
            token,
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'imDone', arguments: { terminalId: 't-a' } },
            },
            { 'Mcp-Session-Id': sessionA },
        );

        // t-a's stream carries that same session id.
        const streamA = await openStream(port, token, { 'Mcp-Session-Id': sessionA });
        try {
            await until(() => streamA.read().includes(': open'));

            // A DM to t-a routes to exactly this stream...
            expect(pushToTerminal('t-a', { method: 'notifications/message', params: { data: 'for t-a' } })).toBe(1);
            await until(() => streamA.read().includes('for t-a'));

            // ...and a push aimed at t-b (no correlated session) reaches nobody,
            // so the caller would fall back to workspace-wide.
            expect(pushToTerminal('t-b', { method: 'notifications/message' })).toBe(0);
        } finally {
            streamA.close();
        }
    });
});
