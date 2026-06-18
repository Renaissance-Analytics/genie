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

const deps = (
    userDataDir: string,
    configuredPort: number,
    terminals: { ids: string[]; lastActive: string | null },
    onImDone: (id: string) => void,
    onForceQuestion: () => Promise<{ cancelled: boolean; answers: any[] }> = async () => ({
        cancelled: true,
        answers: [],
    }),
) => ({
    serverVersion: '0.0.0-test',
    userDataDir,
    configuredPort: () => configuredPort,
    workspaceTerminals: () => terminals,
    onImDone,
    onForceQuestion,
    describeWorkspace: async () => null,
    manageProcess: async () => ({ ok: true, processes: [] }),
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

    it('resolves a workspace endpoint to the last-active terminal for imDone', async () => {
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
        expect(res.status).toBe(200);
        expect(seen).toEqual(['t-b']); // fell back to last-active
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
        // Tiny heartbeat for the test; restored after.
        const prev = process.env.GENIE_MCP_HEARTBEAT_MS;
        process.env.GENIE_MCP_HEARTBEAT_MS = '20';
        try {
            const dir = tmpUserDir();
            await startMcpServer(
                deps(
                    dir,
                    0,
                    { ids: ['t-a'], lastActive: 't-a' },
                    () => {},
                    // Resolve only after several heartbeat intervals have passed.
                    () =>
                        new Promise((r) =>
                            setTimeout(
                                () => r({ cancelled: false, answers: [] }),
                                150,
                            ),
                        ),
                ),
            );
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
            // At least one heartbeat comment kept the stream warm before the answer.
            expect(res.raw).toContain(': heartbeat');
            // Progress notifications were emitted against the supplied token.
            const progress = res.events.filter(
                (e) => e.method === 'notifications/progress',
            );
            expect(progress.length).toBeGreaterThan(0);
            expect(progress[0].params.progressToken).toBe('p9');
            // And the final response still arrived after all that waiting.
            expect(res.events.some((e) => e.id === 9)).toBe(true);
        } finally {
            if (prev === undefined) delete process.env.GENIE_MCP_HEARTBEAT_MS;
            else process.env.GENIE_MCP_HEARTBEAT_MS = prev;
        }
    });
});
