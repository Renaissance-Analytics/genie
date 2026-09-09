import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import { AddressInfo } from 'node:net';
import { setSecretEncryptor } from '../../secrets/store';
import {
    _resetPairingJournalForTest,
    readPairingJournal,
    setPairingJournalDir,
} from '../../pairing-journal';
import { connectRemote, disconnectConnKey, hasSavedToken } from '../index';

/**
 * genie#578, client side — WHY the PIN field came back.
 *
 * Four different things make Genie ask for the PIN again, and they used to be
 * one indistinguishable `needsPin: true`: never paired, the saved token could
 * not be decrypted, there is no keychain to decrypt it with, and the host threw
 * the token out. The first is normal; the other three are faults, and telling
 * the user "first time pairing" while one of them is happening is how this went
 * unexplained for so long.
 */

interface FakeHost {
    port: number;
    close(): Promise<void>;
}

/** A host that pairs, and answers `/api/state` with whatever status is asked
 *  for — 200 for a live pairing, 401 for a token it no longer knows. */
function startFakeHost(opts: { hostId: string; stateStatus: () => number }): Promise<FakeHost> {
    const eventsSockets = new Set<WsServerSocket>();
    const wssEvents = new WebSocketServer({ noServer: true });
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/api/ping') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ genie: true, hostId: opts.hostId, name: 'fake', hostname: 'fake', protocolVersion: 1, appVersion: '0.0.0-test' }));
            return;
        }
        if (url.pathname === '/api/pair') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ token: 'tok-paired' }));
            return;
        }
        if (url.pathname === '/api/state') {
            const status = opts.stateStatus();
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(status === 200 ? JSON.stringify({ locked: false }) : JSON.stringify({ error: 'unknown token' }));
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
                close: () =>
                    new Promise<void>((res) => {
                        for (const ws of eventsSockets) ws.terminate();
                        server.close(() => res());
                    }),
            });
        });
    });
}

const identityEnc = {
    isAvailable: () => true,
    encrypt: (b: Buffer) => b,
    decrypt: (b: Buffer) => b,
};
const wrongKeyEnc = {
    isAvailable: () => true,
    encrypt: (b: Buffer) => b,
    decrypt: () => {
        throw new Error('decrypt failed: not our key');
    },
};

let dataDir: string;
const openKeys: string[] = [];

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-pairing-578-'));
    vi.spyOn(app, 'getPath').mockReturnValue(dataDir);
    setPairingJournalDir(dataDir);
    setSecretEncryptor(identityEnc);
});

afterEach(async () => {
    for (const k of openKeys.splice(0)) disconnectConnKey(k);
    setSecretEncryptor(null);
    _resetPairingJournalForTest();
    vi.restoreAllMocks();
});

const HOST = () => ({ ip: '127.0.0.1', hostname: 'fake' });

describe('why the PIN field came back (client side)', () => {
    it('says FIRST-PAIR when there genuinely is no saved token', async () => {
        const host = await startFakeHost({ hostId: 'H1', stateStatus: () => 200 });
        const res = await connectRemote({ ...HOST(), port: host.port });
        expect(res.ok).toBe(false);
        expect(res.needsPin).toBe(true);
        expect(res.pinReason).toBe('first-pair');
        const entry = readPairingJournal().find((e) => e.event === 'client-token-missing');
        expect(entry?.detail.encryptor).toBe('available'); // positive control for the case below
        await host.close();
    });

    it('does NOT call it a first pair when the keychain is down — nothing could have been saved', async () => {
        // The leading suspect for the recurrence in genie#578: a client whose
        // keychain is unavailable never persists the token it just minted, so
        // the NEXT connect finds an empty store. "First time pairing" is the
        // wrong thing to say — the pairing about to be made won't be kept
        // either, which is the fact the user actually needs.
        const host = await startFakeHost({ hostId: 'H7', stateStatus: () => 200 });
        setSecretEncryptor(null);
        const res = await connectRemote({ ...HOST(), port: host.port });
        expect(res.ok).toBe(false);
        expect(res.needsPin).toBe(true);
        expect(res.pinReason).toBe('keychain-unavailable');
        const entry = readPairingJournal().find((e) => e.event === 'client-token-missing');
        expect(entry?.detail.encryptor).toBe('unavailable');
        await host.close();
    });

    it('says TOKEN-UNREADABLE — and KEEPS the token — when the saved one will not decrypt', async () => {
        const host = await startFakeHost({ hostId: 'H2', stateStatus: () => 200 });
        const paired = await connectRemote({ ...HOST(), port: host.port }, '123456');
        expect(paired.ok).toBe(true);
        disconnectConnKey('host:H2');

        // Same store, a key that cannot open it.
        setSecretEncryptor(wrongKeyEnc);
        const res = await connectRemote({ ...HOST(), port: host.port });
        expect(res.ok).toBe(false);
        expect(res.needsPin).toBe(true);
        expect(res.pinReason).toBe('token-unreadable');
        // NOT deleted: the blob may open again under the right key, and throwing
        // it away is the client-side form of the bug this issue is about.
        expect(hasSavedToken({ ...HOST(), port: host.port, hostId: 'H2' })).toBe(true);
        const entry = readPairingJournal().find((e) => e.event === 'client-token-unreadable');
        expect(entry?.detail.reason).toBe('decrypt-failed');
        expect(entry?.detail.host).toBe('host:H2');
        await host.close();
    });

    it('says KEYCHAIN-UNAVAILABLE when there is no encryptor to read the token with', async () => {
        const host = await startFakeHost({ hostId: 'H3', stateStatus: () => 200 });
        const paired = await connectRemote({ ...HOST(), port: host.port }, '123456');
        expect(paired.ok).toBe(true);
        disconnectConnKey('host:H3');

        setSecretEncryptor(null);
        const res = await connectRemote({ ...HOST(), port: host.port });
        expect(res.ok).toBe(false);
        expect(res.pinReason).toBe('keychain-unavailable');
        expect(readPairingJournal().map((e) => e.event)).toContain('client-token-unreadable');
        await host.close();
    });

    it('says TOKEN-REJECTED when the host 401s a token we had on file', async () => {
        let status = 200;
        const host = await startFakeHost({ hostId: 'H4', stateStatus: () => status });
        const paired = await connectRemote({ ...HOST(), port: host.port }, '123456');
        expect(paired.ok).toBe(true);
        disconnectConnKey('host:H4');

        // The host lost its own store (or unpaired the device) — our token is dead.
        status = 401;
        const res = await connectRemote({ ...HOST(), port: host.port });
        expect(res.ok).toBe(false);
        expect(res.needsPin).toBe(true);
        expect(res.pinReason).toBe('token-rejected');
        // A rejected token IS dropped — the host has spoken; keeping it only
        // makes the next reconnect fail the same way.
        expect(hasSavedToken({ ...HOST(), port: host.port, hostId: 'H4' })).toBe(false);
        expect(readPairingJournal().map((e) => e.event)).toContain('client-token-rejected');
        await host.close();
    });

    it('records that a freshly paired token could NOT be saved (so it silently will not survive a restart)', async () => {
        const host = await startFakeHost({ hostId: 'H5', stateStatus: () => 200 });
        setSecretEncryptor(null); // fail closed: pairing works, persistence does not
        const paired = await connectRemote({ ...HOST(), port: host.port }, '123456');
        if (paired.connKey) openKeys.push(paired.connKey);
        expect(paired.ok).toBe(true);
        const entry = readPairingJournal().find((e) => e.event === 'client-token-not-saved');
        expect(entry?.detail.reason).toBe('keychain-unavailable');
        expect(entry?.detail.host).toBe('host:H5');
        await host.close();
    });

    it('leaves pinReason unset on a successful reconnect (positive control)', async () => {
        const host = await startFakeHost({ hostId: 'H6', stateStatus: () => 200 });
        const paired = await connectRemote({ ...HOST(), port: host.port }, '123456');
        expect(paired.ok).toBe(true);
        disconnectConnKey('host:H6');
        const back = await connectRemote({ ...HOST(), port: host.port });
        if (back.connKey) openKeys.push(back.connKey);
        expect(back.ok).toBe(true);
        expect(back.pinReason).toBeUndefined();
        expect(back.needsPin).toBeUndefined();
        expect(readPairingJournal().map((e) => e.event)).toContain('client-token-saved');
        await host.close();
    });
});
