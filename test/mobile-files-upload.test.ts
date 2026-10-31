import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachWebSocketServer } from '@particle-academy/fancy-ws';
import { UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES } from '../src/core/mobile-wire.js';
import { Baton, PairingPins, ShareLinks } from '../src/core/remote.js';
import { FilesHost } from '../src/main/files-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { fancyWsTransport } from '../src/main/ws-server-transport.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { webSocketTransport } from '../src/renderer/ws-transport.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/**
 * UPLOADS INTO A WORKSPACE (2026-10-30: "a mobile friendly file browser and viewer with upload support").
 *
 * `FilesHost.upload` writes ONE file into a folder of the workspace: the folder is confined (lexically AND by its real
 * path, so a symlinked folder that points out is refused), the name is its last segment only, an executable or an
 * oversize file is refused, and nothing is overwritten — a taken name gets a fresh one.
 *
 * Then the whole path over a REAL socket: Genie 2's phone sent a file as ONE base64 frame, and fancy-ws closes any frame
 * over 1 MiB — so every phone photo (2–5 MB) killed the connection. The positive control shows that cap is real; the
 * renderer's bridge then sends a 3 MB file in chunks and it lands.
 */

let root: string;
let outside: string;
let files: FilesHost;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-upload-ws-'));
    outside = await mkdtemp(join(tmpdir(), 'genie2-upload-out-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'taken.txt'), 'original');
    files = new FilesHost({ workspace: (id) => (id === 'tynn' ? { id: 'tynn', path: root } : null), agentsOf: () => [], eventsOf: () => [] });
});
afterEach(async () => {
    await files.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
});

const bytes = (s: string) => new Uint8Array(Buffer.from(s));

describe('FilesHost.upload — confined, limited, never overwriting', () => {
    it('lands in the folder asked for, at the workspace root for ""', async () => {
        expect(await files.upload('tynn', 'docs', 'photo.jpg', bytes('JPEG'))).toEqual({ ok: true, path: 'docs/photo.jpg' });
        expect(await readFile(join(root, 'docs', 'photo.jpg'), 'utf8')).toBe('JPEG');
        expect(await files.upload('tynn', '', 'top.txt', bytes('t'))).toEqual({ ok: true, path: 'top.txt' });
    });

    it('a taken name is never overwritten — the upload gets a fresh name and the original is intact', async () => {
        const r = await files.upload('tynn', 'docs', 'taken.txt', bytes('new'));
        expect(r.ok).toBe(true);
        expect((r as { path: string }).path).not.toBe('docs/taken.txt');
        expect(await readFile(join(root, 'docs', 'taken.txt'), 'utf8')).toBe('original');
    });

    it('a folder outside the workspace — by .., by an absolute path, or by a symlink that points out — is refused', async () => {
        for (const dir of ['..', '../..', 'docs/../..', outside]) {
            expect(await files.upload('tynn', dir, 'x.txt', bytes('x')), dir).toMatchObject({ ok: false });
        }
        await symlink(outside, join(root, 'escape'), 'junction');
        expect(await files.upload('tynn', 'escape', 'x.txt', bytes('x'))).toMatchObject({ ok: false });
        expect(await readdir(outside)).toEqual([]);
    });

    it('a name with a path in it lands as its last segment, inside', async () => {
        expect(await files.upload('tynn', 'docs', '../../evil.txt', bytes('e'))).toEqual({ ok: true, path: 'docs/evil.txt' });
        expect(await readdir(outside)).toEqual([]);
    });

    it('an executable, an empty file, an oversize file, a missing folder and an unknown workspace are refused', async () => {
        expect(await files.upload('tynn', 'docs', 'run.exe', bytes('MZ'))).toMatchObject({ ok: false });
        expect(await files.upload('tynn', 'docs', 'empty.txt', new Uint8Array(0))).toMatchObject({ ok: false });
        expect(await files.upload('tynn', 'docs', 'huge.bin', new Uint8Array(UPLOAD_MAX_BYTES + 1))).toMatchObject({ ok: false });
        expect(await files.upload('tynn', 'nope', 'a.txt', bytes('a'))).toMatchObject({ ok: false });
        expect(await files.upload('fancy', '', 'a.txt', bytes('a'))).toMatchObject({ ok: false });
    });
});

describe('over a real socket', () => {
    let server: ReturnType<typeof createServer>;
    let port = 0;
    let devices: DeviceStore;
    let host: RemoteHost;
    const listeners = new Set<(channel: string, payload: unknown) => void>();
    beforeEach(async () => {
        server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        port = (server.address() as { port: number }).port;
        devices = await DeviceStore.open(root, { now: () => 1, random: () => 'tok' });
        const api: HostApi = {
            invoke: async (method, args) => {
                if (method === 'snapshot') return { agents: [], workspaces: [{ id: 'tynn', path: root, agentsKnown: true }], deckItems: [], signals: {} };
                if (method === 'files.upload') { const f = args[2] as { name: string; bytes: Uint8Array }; return files.upload(String(args[0]), String(args[1]), f.name, f.bytes); }
                if (method === 'inbox.sendFile') return { ok: true, messageId: 'm' };
                return { ok: true };
            },
            onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
            workspaceOfAgent: () => 'tynn',
        };
        host = new RemoteHost({ confirm: allowEveryPairing, api, hostName: 'alphar', baton: new Baton(), pins: new PairingPins({ now: () => 1, random: () => 0.5 }), shares: new ShareLinks({ host: 'x', now: () => 1, random: () => 's' }), devices, transport: fancyWsTransport({ attach: attachWebSocketServer, server, path: '/genie', address: () => `ws://127.0.0.1:${port}/genie` }) });
    });
    afterEach(async () => {
        await devices.flushed();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
    });

    it('control: ONE frame carrying a 1.2 MB file closes the connection (fancy-ws’s 1 MiB frame cap) — what the old phone upload did', async () => {
        const { code } = host.issuePin();
        const client = connectRemote(webSocketTransport(`ws://127.0.0.1:${port}/genie`), { kind: 'pin', code, label: 'phone' }, 'phone');
        expect((await client.ready).ok).toBe(true);
        const big = Buffer.alloc(1_200_000, 7).toString('base64');
        const r = await client.bridge.uploads!.sendFile('atlas@tynn', 'x', 'big.bin', big);
        expect(r.ok).toBe(false);
        expect(client.state().connected).toBe(false);
    });

    it('the phone’s bridge sends a 3 MB photo in chunks and it lands in the workspace, byte for byte', async () => {
        const { code } = host.issuePin();
        const client = connectRemote(webSocketTransport(`ws://127.0.0.1:${port}/genie`), { kind: 'pin', code, label: 'phone' }, 'phone', { profile: 'mobile' });
        expect((await client.ready).ok).toBe(true);
        expect((await client.takeBaton()).ok).toBe(true);
        const photo = new Uint8Array(3 * 1024 * 1024 + 17);
        for (let i = 0; i < photo.length; i++) photo[i] = (i * 31) & 0xff;
        expect(photo.byteLength).toBeGreaterThan(UPLOAD_CHUNK_BYTES * 4);
        const r = await client.bridge.files.upload!('tynn', 'docs', 'IMG_0042.jpg', photo);
        expect(r).toEqual({ ok: true, path: 'docs/IMG_0042.jpg' });
        expect(Buffer.compare(await readFile(join(root, 'docs', 'IMG_0042.jpg')), Buffer.from(photo))).toBe(0);
        expect(client.state().connected).toBe(true);
        client.close();
    });
});
