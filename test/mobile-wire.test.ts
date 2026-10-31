import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PairingPins } from '../src/core/remote.js';
import { parseTailscaleStatus, remoteListenAddress } from '../src/core/tailscale.js';
import { fitWithin, mobilePhase, mobileView, previewKind, reconnectDelay, staticFile } from '../src/core/mobile.js';
import { MOBILE_TAIL, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES, UploadStaging, WindowReceiver, nextWindow, openWindow, uploadName } from '../src/core/mobile-wire.js';
import { DEVICE_IDLE_MS, DeviceStore } from '../src/main/remote-devices.js';

/**
 * THE PHONE OVER THE TAILNET — the pure decisions under it (2026-10-30, the owner: "make sure our mobile interface over
 * tailscale is working … do it better" than Genie 1, which streamed terminals to the phone).
 *
 * - A watched agent's ledger reaches the phone as a WINDOW (its last rows) and then as patches — never the whole ledger
 *   on every change — and a phone that slept resumes from a CURSOR (the rows it holds), not from zero.
 * - Uploads cross in chunks under the socket's 1 MiB frame cap, staged per connection, size-limited, named safely.
 * - The PIN comes from the OS's CSPRNG, the socket binds only to a Tailscale (CGNAT) address or the loopback, and a
 *   paired device that has not been seen for DEVICE_IDLE_MS is no longer paired.
 */

type R = { id: string; text: string };
const row = (id: string, text = id): R => ({ id, text });

describe('the ledger window: a tail, then patches, then a cursor', () => {
    it('opens on the last MOBILE_TAIL rows (or the tail asked for), not the whole ledger', () => {
        const rows = Array.from({ length: MOBILE_TAIL + 50 }, (_, i) => row(`r${i}`));
        const open = openWindow(rows);
        expect(open.rows.base).toBeNull();
        expect(open.rows.append).toHaveLength(MOBILE_TAIL);
        expect(open.rows.append[0]!.id).toBe('r50');
        expect(openWindow(rows, { tail: 3 }).rows.append.map((r) => r.id)).toEqual([`r${MOBILE_TAIL + 47}`, `r${MOBILE_TAIL + 48}`, `r${MOBILE_TAIL + 49}`]);
    });

    it('a new row is a patch of ONE row; a growing reply replaces only the newest; nothing changed sends nothing new', () => {
        const a = row('a'); const b = row('b'); const c = row('c');
        const open = openWindow([a, b], { tail: 10 });
        const grew = nextWindow(open.state, [a, b, c]);
        expect(grew.rows).toEqual({ base: open.state.seq, keep: 2, append: [c] });
        const c2 = row('c', 'c, longer');
        const streamed = nextWindow(grew.state, [a, b, c2]);
        expect(streamed.rows).toEqual({ base: grew.state.seq, keep: 2, append: [c2] });
        const same = nextWindow(streamed.state, [a, b, c2]);
        expect(same.rows).toEqual({ base: streamed.state.seq, keep: 3, append: [] });
    });

    it('the receiver rebuilds exactly what the host holds, and ignores a patch for a base it does not hold', () => {
        const a = row('a'); const b = row('b'); const c = row('c');
        const recv = new WindowReceiver<R>();
        const open = openWindow([a, b], { tail: 10 });
        expect(recv.apply(open.state.seq, open.rows)?.map((r) => r.id)).toEqual(['a', 'b']);
        const next = nextWindow(open.state, [a, b, c]);
        expect(recv.apply(next.state.seq, next.rows)?.map((r) => r.id)).toEqual(['a', 'b', 'c']);
        // A stale patch (its base is long gone) changes nothing.
        expect(recv.apply(99, { base: 42, keep: 1, append: [row('x')] })).toBeUndefined();
        expect(recv.rows()?.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    });

    it('RESUME: a phone that slept sends a cursor and receives only the rows after it', () => {
        const rows = ['a', 'b', 'c', 'd'].map((id) => row(id));
        const recv = new WindowReceiver<R>();
        const open = openWindow(rows, { tail: 10 });
        recv.apply(open.state.seq, open.rows);
        // The cursor: its first row, and the last row it trusts (the newest may still have been growing).
        const cursor = recv.cursor();
        expect(cursor).toEqual({ from: 'a', after: 'c' });
        // Meanwhile on the host: d finished growing, e and f arrived. A NEW connection resumes.
        const later = [...rows.slice(0, 3), row('d', 'd, done'), row('e'), row('f')];
        const resumed = openWindow(later, { tail: 10, resume: cursor });
        expect(resumed.rows.base).toBe('resume');
        expect(resumed.rows.keep).toBe(3);
        expect(resumed.rows.append.map((r) => r.text)).toEqual(['d, done', 'e', 'f']);
        expect(recv.apply(resumed.state.seq, resumed.rows)?.map((r) => r.text)).toEqual(['a', 'b', 'c', 'd, done', 'e', 'f']);
        // And the window carries on from there as patches.
        const g = row('g');
        const more = nextWindow(resumed.state, [...later, g]);
        expect(more.rows).toEqual({ base: resumed.state.seq, keep: 6, append: [g] });
    });

    it('a cursor the host cannot find (the ledger was replaced) falls back to a fresh tail, never a guess', () => {
        const fresh = openWindow([row('x'), row('y')], { tail: 10, resume: { from: 'a', after: 'c' } });
        expect(fresh.rows.base).toBeNull();
        expect(fresh.rows.append.map((r) => r.id)).toEqual(['x', 'y']);
    });

    it('a ledger that no longer starts where the window does is re-sent as a fresh tail', () => {
        const open = openWindow([row('a'), row('b'), row('c')], { tail: 2 });
        const replaced = nextWindow(open.state, [row('p'), row('q')]);
        expect(replaced.rows.base).toBeNull();
        expect(replaced.rows.append.map((r) => r.id)).toEqual(['p', 'q']);
    });
});

describe('uploads: chunked under the socket frame cap, staged, limited, safely named', () => {
    it('a chunk, base64-encoded inside a JSON frame, stays well under fancy-ws’s 1 MiB frame cap', () => {
        expect(Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4 + 1024).toBeLessThan(1024 * 1024);
    });

    it('the name is its last segment only; empty, dot names, control characters and executables are refused', () => {
        expect(uploadName('photo.jpg')).toEqual({ ok: true, name: 'photo.jpg' });
        expect(uploadName('../../etc/passwd')).toEqual({ ok: true, name: 'passwd' });
        expect(uploadName('..\\..\\Windows\\win.ini')).toEqual({ ok: true, name: 'win.ini' });
        expect(uploadName('  spaced.txt  ')).toEqual({ ok: true, name: 'spaced.txt' });
        for (const bad of ['', '   ', '.', '..', 'a/..', 'nul\u0000.txt', 'line\nbreak.txt', 'setup.exe', 'run.bat', 'x'.repeat(256)]) {
            expect(uploadName(bad).ok, bad).toBe(false);
        }
    });

    it('stages in order, per owner, refuses oversize, out-of-order and over-declared bytes, and hands the bytes over once', () => {
        let now = 0;
        const staging = new UploadStaging({ now: () => now });
        expect(staging.begin('conn_1', { name: 'big.bin', size: UPLOAD_MAX_BYTES + 1 }).ok).toBe(false);
        expect(staging.begin('conn_1', { name: 'zero.bin', size: 0 }).ok).toBe(false);
        expect(staging.begin('conn_1', { name: 'evil.exe', size: 4 }).ok).toBe(false);
        const b = staging.begin('conn_1', { name: 'note.txt', size: 6 });
        if (!b.ok) throw new Error(b.reason);
        expect(staging.chunk('conn_1', b.id, 1, Buffer.from('lo!').toString('base64')).ok).toBe(false); // out of order
        expect(staging.chunk('conn_2', b.id, 0, Buffer.from('hel').toString('base64')).ok).toBe(false); // not yours
        expect(staging.take('conn_1', b.id)).toBeNull(); // not complete yet
        expect(staging.chunk('conn_1', b.id, 0, Buffer.from('hel').toString('base64')).ok).toBe(true);
        expect(staging.chunk('conn_1', b.id, 1, Buffer.from('lo!!').toString('base64')).ok).toBe(false); // over declared
        expect(staging.chunk('conn_1', b.id, 1, Buffer.from('lo!').toString('base64')).ok).toBe(true);
        const taken = staging.take('conn_1', b.id);
        expect(taken?.name).toBe('note.txt');
        expect(Buffer.from(taken!.bytes).toString()).toBe('hello!');
        expect(staging.take('conn_1', b.id)).toBeNull(); // once
        // Expiry and a closed connection both drop what was staged.
        const c = staging.begin('conn_1', { name: 'a.txt', size: 1 });
        const d = staging.begin('conn_2', { name: 'b.txt', size: 1 });
        if (!c.ok || !d.ok) throw new Error('begin');
        staging.chunk('conn_1', c.id, 0, Buffer.from('a').toString('base64'));
        staging.chunk('conn_2', d.id, 0, Buffer.from('b').toString('base64'));
        staging.dropOwner('conn_2');
        expect(staging.take('conn_2', d.id)).toBeNull();
        now += 11 * 60_000;
        expect(staging.take('conn_1', c.id)).toBeNull();
    });

    it('one owner cannot hold more than a few uploads open at once', () => {
        const staging = new UploadStaging({ now: () => 0 });
        const results = Array.from({ length: 5 }, (_, i) => staging.begin('conn_1', { name: `f${i}.txt`, size: 1 }).ok);
        expect(results.filter(Boolean).length).toBeLessThanOrEqual(3);
        expect(results.at(-1)).toBe(false);
    });
});

describe('the phone’s routes, previews and connection phase', () => {
    it('the hash names the view: home (optionally one workspace), one agent, or a workspace’s files at a path', () => {
        expect(mobileView('')).toEqual({ kind: 'home', workspaceId: null });
        expect(mobileView('#ws=tynn')).toEqual({ kind: 'home', workspaceId: 'tynn' });
        expect(mobileView('#agent=agent_a')).toEqual({ kind: 'agent', agentId: 'agent_a' });
        expect(mobileView('#files=tynn')).toEqual({ kind: 'files', workspaceId: 'tynn', path: '' });
        expect(mobileView(`#files=tynn&path=${encodeURIComponent('docs/a b.md')}`)).toEqual({ kind: 'files', workspaceId: 'tynn', path: 'docs/a b.md' });
    });

    it('previews by kind: markdown, image, pdf, text/code; anything else is offered, not guessed', () => {
        expect(previewKind('README.md')).toBe('markdown');
        expect(previewKind('a/b/photo.JPG')).toBe('image');
        expect(previewKind('shot.webp')).toBe('image');
        expect(previewKind('spec.pdf')).toBe('pdf');
        for (const p of ['main.ts', 'App.tsx', 'x.json', 'notes.txt', 'Dockerfile', '.env.example', 'style.css', 'a.php', 'b.py']) expect(previewKind(p), p).toBe('text');
        expect(previewKind('archive.zip')).toBe('other');
    });

    it('a photo is scaled to fit inside the longest side, never up', () => {
        expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
        expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 });
        expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
    });

    it('a phone that was connected and has its token RECONNECTS (never the pairing form); backoff grows and is capped', () => {
        expect(mobilePhase({ connected: true, everConnected: true, hasToken: true, refusal: null })).toBe('ready');
        expect(mobilePhase({ connected: false, everConnected: true, hasToken: true, refusal: null })).toBe('reconnecting');
        expect(mobilePhase({ connected: false, everConnected: false, hasToken: false, refusal: null })).toBe('pair');
        // The host said this device is not paired (revoked, expired): pairing again is the only way in.
        expect(mobilePhase({ connected: false, everConnected: true, hasToken: true, refusal: 'this device is not paired with alphar' })).toBe('pair');
        expect(reconnectDelay(0)).toBeLessThan(reconnectDelay(3));
        expect(reconnectDelay(50)).toBeLessThanOrEqual(15_000);
    });

    it('Vite’s own chunks, whose names start with an underscore, are served — one was refused and the phone page was blank', () => {
        // Measured on omarchy-test (2026-10-30): the built page imports ./assets/__vite-browser-external-TtGlo6oh.js; the
        // allow-list's first character had to be alphanumeric, so it was a 404 and the whole module graph failed to load.
        expect(staticFile('/assets/__vite-browser-external-TtGlo6oh.js')).toMatchObject({ relative: 'assets/__vite-browser-external-TtGlo6oh.js', contentType: 'text/javascript; charset=utf-8' });
        expect(staticFile('/assets/_x.js.map')).not.toBeNull();
        // Still one plain segment: no dot-names, no traversal, no hidden files.
        for (const bad of ['/assets/..', '/assets/.env', '/assets/_/../x.js', '/assets/__..js']) expect(staticFile(bad), bad).toBeNull();
    });

    it('the page at /mobile/ (a trailing slash) gets its assets too — relative URLs resolve under it', () => {
        expect(staticFile('/mobile/assets/index-abc.js')).toEqual(staticFile('/assets/index-abc.js'));
        expect(staticFile('/mobile/assets/../secret.txt')).toBeNull();
    });
});

describe('security: the PIN, the bind, and device expiry', () => {
    it('the PIN comes from the OS CSPRNG, never Math.random', () => {
        const spy = vi.spyOn(Math, 'random');
        const pins = new PairingPins({ now: () => 0 });
        const codes = new Set(Array.from({ length: 40 }, () => pins.issue().code));
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
        for (const c of codes) expect(c).toMatch(/^\d{6}$/);
        expect(codes.size).toBeGreaterThan(30);
    });

    it('the composed host does not hand the PIN Math.random', () => {
        const compose = readFileSync(new URL('../src/main/compose.ts', import.meta.url), 'utf8');
        expect(compose).not.toMatch(/PairingPins\(\{[^}]*Math\.random/);
    });

    it('binds ONLY to a Tailscale address (100.64.0.0/10) or the loopback — never a LAN or wildcard address Tailscale might report', () => {
        const status = (ip: string) => parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'alphar.tail.ts.net.', TailscaleIPs: [ip] } }));
        expect(remoteListenAddress(status('100.101.102.103'), 7421)?.bind).toBe('100.101.102.103');
        expect(remoteListenAddress(status('127.0.0.1'), 7421)?.bind).toBe('127.0.0.1');
        for (const ip of ['0.0.0.0', '192.168.1.20', '10.0.0.5', '100.128.0.1', '100.63.255.255', '8.8.8.8']) {
            expect(remoteListenAddress(status(ip), 7421), ip).toBeNull();
        }
    });

    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-device-idle-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('a device unseen for DEVICE_IDLE_MS is unpaired: its token is refused and Settings no longer lists it; a used one slides', async () => {
        let now = 1_000_000;
        let n = 0;
        const store = await DeviceStore.open(dir, { now: () => now, random: () => `tok${n++}` });
        const kept = store.pair('daily phone');
        const idle = store.pair('old tablet');
        now += DEVICE_IDLE_MS - 1000;
        expect(store.byToken(kept.token)?.label).toBe('daily phone');
        now += 2000;
        expect(store.byToken(idle.token)).toBeNull();
        expect(store.list().map((d) => d.label)).toEqual(['daily phone']);
        await store.flushed();
        // Expiry is written down, so a restart does not bring it back.
        const reopened = await DeviceStore.open(dir, { now: () => now, random: () => 'x' });
        expect(reopened.list().map((d) => d.label)).toEqual(['daily phone']);
        expect(DEVICE_IDLE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    });
});
