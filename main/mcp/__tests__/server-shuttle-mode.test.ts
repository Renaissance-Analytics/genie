import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { handleMcpMessage } from '../protocol';
import {
    adoptShuttleListener,
    mcpContextFor,
    mcpServerState,
    mcpTopology,
    noteShuttleFallback,
    onMcpTopologyChanged,
    registerTerminalEndpoint,
    startMcpServer,
    stopMcpServer,
    unregisterTerminalEndpoint,
    workspaceEndpointUrl,
    type ServerDeps,
} from '../server';

/**
 * THE SERVER WHEN THE SHUTTLE OWNS THE PORT (genie#346 Phase 1).
 *
 * With a shuttle attached, Genie stops listening and keeps everything else:
 * it still mints every endpoint URL (the shuttle never mints or renumbers a token,
 * §9.2), still persists the token maps, and still runs every call — the shuttle
 * forwards them. What it adds is the routing table the shuttle needs, and a way to
 * hear when that table changes.
 *
 * The URLs have to be byte-identical either way: they are literals in every
 * `.mcp.json`, and an agent must not be able to tell which process answered.
 */

const dirs: string[] = [];
afterEach(() => {
    stopMcpServer();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function userDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-mcp-shuttle-mode-'));
    dirs.push(dir);
    return dir;
}

async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((r) => probe.close(() => r()));
    return port;
}

function deps(userDataDir: string, port: number, onImDone = vi.fn(() => ({ attention: 1 }))): ServerDeps {
    return {
        serverVersion: '0.0.0-test',
        userDataDir,
        configuredPort: () => port,
        workspaceTerminals: () => ({ ids: ['t-a', 't-b'], lastActive: null }),
        onImDone,
        checkIssues: async () => ({ connected: true, workspaceResolved: true, counts: { issue: 0, pr: 0, security: 0, feedback: 0 }, items: [] }),
        onForceQuestion: async () => ({ cancelled: true, answers: [] }),
        describeWorkspace: async () => null,
    } as unknown as ServerDeps;
}

const listening = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });

describe('shuttle mode', () => {
    it('mints endpoint URLs on the configured port WITHOUT listening on it', async () => {
        const port = await freePort();

        adoptShuttleListener(deps(userDir(), port));
        const url = workspaceEndpointUrl('ws-1');

        expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/mcp/[a-f0-9]+$`));
        expect(mcpServerState()).toMatchObject({ running: true, mode: 'shuttle', port, conflict: false });
        expect(await listening(port)).toBe(false);
    });

    it('keeps every token an earlier in-process run issued', async () => {
        const dir = userDir();
        const port = await freePort();
        await startMcpServer(deps(dir, port));
        const issued = workspaceEndpointUrl('ws-1');
        const terminal = registerTerminalEndpoint('t-9');
        stopMcpServer();

        adoptShuttleListener(deps(dir, port));

        expect(workspaceEndpointUrl('ws-1')).toBe(issued);
        expect(registerTerminalEndpoint('t-9')).toBe(terminal);
    });

    it('describes every endpoint, and each workspace’s terminals, as the shuttle’s routing table', async () => {
        adoptShuttleListener(deps(userDir(), await freePort()));
        const wsToken = workspaceEndpointUrl('ws-1')!.split('/').pop()!;
        const terminalToken = registerTerminalEndpoint('t-9')!.split('/').pop()!;

        expect(mcpTopology()).toEqual({
            endpoints: {
                [wsToken]: { kind: 'workspace', workspaceId: 'ws-1' },
                [terminalToken]: { kind: 'terminal', terminalId: 't-9' },
            },
            workspaces: { 'ws-1': ['t-a', 't-b'] },
        });
    });

    it('says when the routing table changes', async () => {
        adoptShuttleListener(deps(userDir(), await freePort()));
        const changed = vi.fn();
        const off = onMcpTopologyChanged(changed);

        workspaceEndpointUrl('ws-2');
        registerTerminalEndpoint('t-new');
        unregisterTerminalEndpoint('t-new');
        expect(changed).toHaveBeenCalledTimes(3);

        // Reusing an existing token changes nothing, and says nothing.
        workspaceEndpointUrl('ws-2');
        expect(changed).toHaveBeenCalledTimes(3);

        off();
        workspaceEndpointUrl('ws-3');
        expect(changed).toHaveBeenCalledTimes(3);
    });

    it('runs a forwarded call against the same implementations the in-process server uses', async () => {
        const onImDone = vi.fn(() => ({ attention: 1 }));
        adoptShuttleListener(deps(userDir(), await freePort(), onImDone));

        const response = await handleMcpMessage(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'imDone', arguments: {} } },
            mcpContextFor('t-a'),
        );

        expect(response?.error).toBeUndefined();
        expect(onImDone).toHaveBeenCalledWith('t-a');
    });

    it('serves in-process on the configured port when the shuttle cannot', async () => {
        const port = await freePort();
        const d = deps(userDir(), port);
        adoptShuttleListener(d);
        const url = workspaceEndpointUrl('ws-1')!;

        await startMcpServer(d);

        expect(mcpServerState()).toMatchObject({ running: true, mode: 'in-process', port, conflict: false });
        // The URL already handed out now answers in-process.
        const status = await new Promise<number>((resolve, reject) => {
            const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
            });
            req.on('error', reject);
            req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
        });
        expect(status).toBe(200);
    });

    it('reports why a wanted shuttle is not serving, for Settings to show', async () => {
        const d = deps(userDir(), await freePort());
        adoptShuttleListener(d);
        noteShuttleFallback('No standalone Node runtime is shipped with this build.');
        await startMcpServer(d);

        expect(mcpServerState()).toMatchObject({
            mode: 'in-process',
            shuttleFallback: 'No standalone Node runtime is shipped with this build.',
        });
    });

    it('POSITIVE CONTROL: the ordinary start still reports in-process', async () => {
        await startMcpServer(deps(userDir(), await freePort()));

        expect(mcpServerState().mode).toBe('in-process');
    });
});
