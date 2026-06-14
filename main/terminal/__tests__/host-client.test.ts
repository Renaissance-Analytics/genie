import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
    encodeFrame,
    FrameDecoder,
    PROTOCOL_VERSION,
    type ClientMessage,
    type HostMessage,
} from '../host-protocol';

/**
 * Tier 3 — HostClient proxying. We stand up a REAL net.Server speaking the host
 * protocol on an ephemeral transport (a unix socket on POSIX, a named pipe on
 * Windows) and assert the client: handshakes, proxies create/write, surfaces
 * pushed data/exit, and seeds its mirror from a list+scrollback on connect.
 *
 * sessions.readSnapshot is stubbed so create()'s on-disk snapshot probe never
 * touches the filesystem.
 */

vi.mock('../sessions', () => ({
    readSnapshot: () => null,
    writeSnapshot: () => 1,
    deleteSnapshot: () => undefined,
}));

import { HostClient } from '../host-client';

function ephemeralPath(): string {
    const tag = crypto.randomBytes(6).toString('hex');
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\genie-test-${tag}`;
    }
    return path.join(os.tmpdir(), `genie-test-${tag}.sock`);
}

interface MockHostOptions {
    /** Pre-seed live ptys the client should discover on connect. */
    seed?: Array<{ id: string; pid: number; shell: string; scrollback: string }>;
    /** Override the protocol version reported in hello-ok (for mismatch tests). */
    helloVersion?: number;
}

/** A minimal protocol-speaking server. Returns control handles for the test. */
function startMockHost(socketPath: string, opts: MockHostOptions = {}) {
    const sockets = new Set<net.Socket>();
    const received: ClientMessage[] = [];
    const seed = new Map(
        (opts.seed ?? []).map((s) => [s.id, s] as const),
    );

    const server = net.createServer((sock) => {
        sockets.add(sock);
        const dec = new FrameDecoder();
        sock.on('data', (chunk: Buffer) => {
            for (const f of dec.push(chunk)) {
                const msg = f as ClientMessage;
                received.push(msg);
                handle(sock, msg);
            }
        });
        sock.on('close', () => sockets.delete(sock));
        sock.on('error', () => sockets.delete(sock));
    });

    function send(sock: net.Socket, msg: HostMessage) {
        sock.write(encodeFrame(msg));
    }

    function handle(sock: net.Socket, msg: ClientMessage) {
        switch (msg.kind) {
            case 'hello':
                send(sock, {
                    kind: 'hello-ok',
                    seq: msg.seq,
                    protocolVersion: opts.helloVersion ?? PROTOCOL_VERSION,
                    pid: 9999,
                });
                break;
            case 'list':
                send(sock, {
                    kind: 'list-result',
                    seq: msg.seq,
                    terminals: Array.from(seed.values()).map((s) => ({
                        id: s.id,
                        pid: s.pid,
                        shell: s.shell,
                    })),
                });
                break;
            case 'get-scrollback':
                send(sock, {
                    kind: 'scrollback-result',
                    seq: msg.seq,
                    scrollback: seed.get(msg.id)?.scrollback ?? null,
                });
                break;
            case 'create':
                send(sock, {
                    kind: 'created',
                    seq: msg.seq,
                    result: {
                        id: msg.opts.id,
                        pid: 1234,
                        shell: msg.opts.shell ?? 'sh',
                        existing: false,
                        scrollback: '',
                    },
                });
                break;
            case 'ping':
                send(sock, { kind: 'pong', seq: msg.seq });
                break;
            default:
                break;
        }
    }

    return {
        server,
        received,
        /** Push a data/exit message to all connected clients. */
        push(msg: HostMessage) {
            for (const s of sockets) s.write(encodeFrame(msg));
        },
        listen() {
            return new Promise<void>((resolve) => server.listen(socketPath, resolve));
        },
        close() {
            for (const s of sockets) s.destroy();
            return new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

let socketPath: string;
let host: ReturnType<typeof startMockHost>;
let client: HostClient | null = null;

beforeEach(async () => {
    socketPath = ephemeralPath();
});

afterEach(async () => {
    try {
        client?.disconnect();
    } catch {
        /* ignore */
    }
    client = null;
    if (host) await host.close();
    if (process.platform !== 'win32') {
        try {
            fs.rmSync(socketPath, { force: true });
        } catch {
            /* ignore */
        }
    }
});

describe('HostClient.connect', () => {
    it('handshakes and reports connected', async () => {
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, 2000);
        expect(client.isConnected()).toBe(true);
        expect(client.hostPid).toBe(9999);
    });

    it('rejects on protocol-version mismatch', async () => {
        host = startMockHost(socketPath, { helloVersion: PROTOCOL_VERSION + 99 });
        await host.listen();
        await expect(HostClient.connect(socketPath, 2000)).rejects.toThrow(/mismatch/);
    });

    it('rejects on connect timeout when nothing is listening', async () => {
        // No server started → connection fails fast (ENOENT/ECONNREFUSED) or times out.
        await expect(HostClient.connect(socketPath, 800)).rejects.toBeTruthy();
    });

    it('seeds its mirror from the host list + scrollback on connect', async () => {
        host = startMockHost(socketPath, {
            seed: [
                { id: 'srv', pid: 42, shell: '/bin/bash', scrollback: 'listening :3000\r\n' },
            ],
        });
        await host.listen();
        client = await HostClient.connect(socketPath, 2000);

        expect(client.liveIds()).toContain('srv');
        expect(client.isLive('srv')).toBe(true);
        expect(client.getScrollback('srv')).toContain('listening :3000');

        // create() on a seeded id is a warm rejoin (no respawn), returning the
        // replayed scrollback — exactly the reattach-after-quit path.
        const res = client.create({ id: 'srv', cwd: '/tmp' });
        expect(res.existing).toBe(true);
        expect(res.scrollback).toContain('listening :3000');
    });
});

describe('HostClient proxying', () => {
    it('proxies create + write to the host', async () => {
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, 2000);

        const res = client.create({ id: 'a', cwd: '/tmp', shell: 'sh' });
        expect(res.existing).toBe(false);
        expect(client.isLive('a')).toBe(true);

        expect(client.write('a', 'echo hi\n')).toBe(true);

        // Let the create + write frames land on the host.
        await new Promise((r) => setTimeout(r, 50));
        const kinds = host.received.map((m) => m.kind);
        expect(kinds).toContain('create');
        expect(kinds).toContain('write');
    });

    it('surfaces pushed data + exit events to subscribers', async () => {
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, 2000);
        client.create({ id: 'a', cwd: '/tmp' });

        const datas: Array<{ id: string; data: string }> = [];
        const exits: Array<{ id: string; exitCode: number }> = [];
        client.on('data', (id, data) => datas.push({ id, data }));
        client.on('exit', (id, p) => exits.push({ id, exitCode: p.exitCode }));

        host.push({ kind: 'data', id: 'a', data: 'output line\r\n' });
        host.push({ kind: 'exit', id: 'a', exitCode: 0 });

        await new Promise((r) => setTimeout(r, 50));
        expect(datas).toEqual([{ id: 'a', data: 'output line\r\n' }]);
        expect(exits).toEqual([{ id: 'a', exitCode: 0 }]);
        // Exit removes the pty from the mirror.
        expect(client.isLive('a')).toBe(false);
    });

    it('killAll is a no-op (host ptys survive quit)', async () => {
        host = startMockHost(socketPath);
        await host.listen();
        client = await HostClient.connect(socketPath, 2000);
        client.create({ id: 'a', cwd: '/tmp' });
        client.killAll();
        // Still live locally — killAll must NOT tear down host ptys.
        expect(client.isLive('a')).toBe(true);
    });
});
