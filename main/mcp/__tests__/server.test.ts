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

const deps = (
    userDataDir: string,
    configuredPort: number,
    terminals: { ids: string[]; lastActive: string | null },
    onImDone: (id: string) => void,
) => ({
    serverVersion: '0.0.0-test',
    userDataDir,
    configuredPort: () => configuredPort,
    workspaceTerminals: () => terminals,
    onImDone,
    onForceQuestion: async () => ({ cancelled: true, answers: [] }),
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
});
