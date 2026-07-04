import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import { AddressInfo } from 'node:net';
import { setSecretEncryptor, encryptSecret } from '../../secrets/store';
import {
    connectRemote,
    connKeyOf,
    disconnectConnKey,
    hasSavedToken,
    listKnownHosts,
    type RemoteHost,
} from '../index';

/**
 * Phase A — the stable host-identity model. These prove the ROOT-CAUSE fix for
 * "≥2 Genie hosts on one tailnet → mobile/Work-Mode breaks": identity is keyed on
 * a stable `hostId` (mirroring the relay's `ws:<workstationId>`), the mutable
 * `ip:port` is only a dial address, an existing IP-keyed pairing MIGRATES rather
 * than orphaning, and an old host with no `hostId` still connects (fallback).
 */

interface FakeHost {
    port: number;
    hostId: string | null;
    close(): Promise<void>;
}

/** A minimal host: `/api/ping` (optionally carrying a hostId), `/api/pair`,
 *  `/api/state`, and a `/ws/events` upgrade. Accepts any Bearer (identity, not
 *  token validity, is what these tests exercise). */
function startFakeHost(hostId: string | null): Promise<FakeHost> {
    const eventsSockets = new Set<WsServerSocket>();
    const wssEvents = new WebSocketServer({ noServer: true });
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/api/ping') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    genie: true,
                    hostId,
                    name: 'fake',
                    hostname: 'fake',
                    dnsName: hostId ? 'fake.tailnet.ts.net' : null,
                    protocolVersion: 1,
                    appVersion: '0.0.0-test',
                }),
            );
            return;
        }
        if (url.pathname === '/api/pair') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ token: 'tok-paired' }));
            return;
        }
        if (url.pathname === '/api/state') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ locked: false, workspaces: [], terminals: [], processes: [], questions: [] }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/ws/events') {
            wssEvents.handleUpgrade(req, socket, head, (ws) => {
                eventsSockets.add(ws);
                ws.on('close', () => eventsSockets.delete(ws));
            });
            return;
        }
        socket.destroy();
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({
                port,
                hostId,
                close: () =>
                    new Promise<void>((res) => {
                        for (const ws of eventsSockets) ws.terminate();
                        server.close(() => res());
                    }),
            });
        });
    });
}

let dataDir: string;
const openKeys: string[] = [];

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-remote-id-'));
    // Token/known-host stores live under app.getPath('userData').
    vi.spyOn(app, 'getPath').mockReturnValue(dataDir);
    // A reversible identity cipher so tokens actually persist + decrypt (the mock
    // safeStorage is unavailable by default → fail-closed no-op).
    setSecretEncryptor({
        isAvailable: () => true,
        encrypt: (b: Buffer) => b,
        decrypt: (b: Buffer) => b,
    });
});

afterEach(async () => {
    for (const k of openKeys.splice(0)) disconnectConnKey(k);
    setSecretEncryptor(null);
    vi.restoreAllMocks();
});

function tokensPath(): string {
    return path.join(dataDir, 'genie-remote-tokens.json');
}
function knownPath(): string {
    return path.join(dataDir, 'genie-remote-hosts.json');
}
function readJson(p: string): Record<string, unknown> {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    } catch {
        return {};
    }
}

describe('connKeyOf — identity vs address', () => {
    it('keys on host:<hostId> when identity is known, else ip:port', () => {
        expect(connKeyOf({ ip: '100.0.0.5', port: 51718 })).toBe('100.0.0.5:51718');
        expect(connKeyOf({ ip: '100.0.0.5', port: 51718, hostId: 'X' })).toBe('host:X');
    });
});

describe('migration — an IP-keyed pairing is NOT orphaned', () => {
    it('re-keys an existing ip:port token + known-host to host:<hostId> on the first identifying ping', async () => {
        const host = await startFakeHost('HID-1');
        const ipKey = `127.0.0.1:${host.port}`;
        // Seed the PRE-hostId (IP-keyed) stores, as an already-paired user has.
        fs.writeFileSync(
            tokensPath(),
            JSON.stringify({ [ipKey]: encryptSecret('tok-old') }),
        );
        fs.writeFileSync(
            knownPath(),
            JSON.stringify({
                [ipKey]: { ip: '127.0.0.1', port: host.port, hostname: 'fake', name: 'My Mac' },
            }),
        );

        // Reconnect with NO pin — must succeed on the migrated token (no re-PIN).
        const res = await connectRemote({ ip: '127.0.0.1', port: host.port, hostname: 'fake' });
        if (res.connKey) openKeys.push(res.connKey);

        expect(res.ok).toBe(true);
        expect(res.needsPin).toBeUndefined();
        expect(res.connKey).toBe('host:HID-1');

        // The IP key is GONE (no stale token to hit a recycled IP); the stable key holds it.
        const tokens = readJson(tokensPath());
        expect(tokens[ipKey]).toBeUndefined();
        expect(tokens['host:HID-1']).toBeDefined();
        expect(hasSavedToken({ ip: '127.0.0.1', port: host.port, hostname: 'fake', hostId: 'HID-1' })).toBe(true);

        // The known-host entry migrated too, PRESERVING the user's friendly name.
        const known = readJson(knownPath()) as Record<string, { name?: string }>;
        expect(known[ipKey]).toBeUndefined();
        expect(known['host:HID-1']?.name).toBe('My Mac');

        await host.close();
    });
});

describe('IP change on the same hostId keeps the pairing', () => {
    it('reconnects with no PIN after the host moves to a new address', async () => {
        // First pairing at address A.
        const a = await startFakeHost('HID-2');
        const paired = await connectRemote({ ip: '127.0.0.1', port: a.port, hostname: 'fake' }, '123456');
        expect(paired.ok).toBe(true);
        expect(paired.connKey).toBe('host:HID-2');
        disconnectConnKey('host:HID-2');
        await a.close();

        // The SAME host now answers at a DIFFERENT address (simulating a Tailscale
        // IP reassignment) — same hostId. A no-PIN reconnect must just work.
        const b = await startFakeHost('HID-2');
        const back = await connectRemote({ ip: '127.0.0.1', port: b.port, hostname: 'fake' });
        if (back.connKey) openKeys.push(back.connKey);
        expect(back.ok).toBe(true);
        expect(back.needsPin).toBeUndefined();
        expect(back.connKey).toBe('host:HID-2');
        await b.close();
    });
});

describe('back-compat — an old host with no hostId still connects (ip:port fallback)', () => {
    it('falls back to ip:port keying and pairs via PIN', async () => {
        const host = await startFakeHost(null); // ping carries no hostId
        const ipKey = `127.0.0.1:${host.port}`;

        // No saved token yet → the host asks for the PIN (first pair).
        const first = await connectRemote({ ip: '127.0.0.1', port: host.port, hostname: 'fake' });
        expect(first.ok).toBe(false);
        expect(first.needsPin).toBe(true);

        // Pair with a PIN → connects, keyed by ip:port (no identity to key on).
        const paired = await connectRemote({ ip: '127.0.0.1', port: host.port, hostname: 'fake' }, '123456');
        if (paired.connKey) openKeys.push(paired.connKey);
        expect(paired.ok).toBe(true);
        expect(paired.connKey).toBe(ipKey);

        const listed = listKnownHosts().map((h) => h.connKey);
        expect(listed).toContain(ipKey);

        await host.close();
    });
});
