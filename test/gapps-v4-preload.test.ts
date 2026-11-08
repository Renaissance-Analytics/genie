import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_BRIDGE } from '../src/core/catalog.js';

/**
 * GAPPS V2, V4 (Tynn #569): THE APP WINDOW'S PRELOAD. It exposes `window.genieApp` and nothing else. The channel's address
 * and token stay inside the preload (the page cannot read them); the page can only make the bridge's calls and follow its
 * events. Sandboxed preloads are CommonJS and cannot share a chunk, so its copy of the bridge is held equal to the catalog's.
 */
const exposed: Array<[string, Record<string, unknown>]> = [];
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (name: string, api: Record<string, unknown>) => { exposed.push([name, api]); } } }));

class FakeSocket {
    static last: FakeSocket;
    sent: string[] = [];
    handlers = new Map<string, Array<(e: { data?: string }) => void>>();
    constructor(public url: string) { FakeSocket.last = this; }
    addEventListener(type: string, fn: (e: { data?: string }) => void) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]); }
    send(text: string) { this.sent.push(text); }
    fire(type: string, data?: unknown) { for (const fn of this.handlers.get(type) ?? []) fn(data === undefined ? {} : { data: JSON.stringify(data) }); }
}

const argv = process.argv;
beforeEach(async () => {
    exposed.length = 0;
    vi.resetModules();
    vi.stubGlobal('WebSocket', FakeSocket);
    process.argv = [...argv, '--genie-app-channel=wss://notes.apps.gen/.genie/channel', '--genie-app-token=secret-token'];
    await import('../src/main/gapp-preload.js');
});
afterEach(() => { process.argv = argv; vi.unstubAllGlobals(); });

const api = () => exposed[0]![1] as { request(method: string, params?: unknown): Promise<unknown>; on(event: string, fn: (d: unknown) => void): () => void };

describe('the sealed preload', () => {
    it('exposes window.genieApp and nothing else', () => {
        expect(exposed.map(([name]) => name)).toEqual(['genieApp']);
        expect(Object.keys(api()).sort()).toEqual(['on', 'request']);
    });

    it('says hello with the token on the channel; the token is not on the object the page gets', () => {
        const socket = FakeSocket.last;
        expect(socket.url).toBe('wss://notes.apps.gen/.genie/channel');
        socket.fire('open');
        expect(JSON.parse(socket.sent[0]!)).toEqual({ hello: 'secret-token' });
        expect(JSON.stringify(api())).not.toContain('secret-token');
    });

    it('a bridge call goes over the channel after the hello and resolves with its answer', async () => {
        const socket = FakeSocket.last;
        socket.fire('open');
        socket.fire('message', { ok: true, packageId: 'com.example.notes' });
        const pending = api().request('app.me');
        await Promise.resolve();
        const sent = JSON.parse(socket.sent.at(-1)!) as { id: number; method: string };
        expect(sent.method).toBe('app.me');
        socket.fire('message', { id: sent.id, result: { packageId: 'com.example.notes' } });
        await expect(pending).resolves.toEqual({ packageId: 'com.example.notes' });
    });

    it('a refused hello rejects what is waiting, in words', async () => {
        const socket = FakeSocket.last;
        const pending = api().request('app.me');
        socket.fire('open');
        socket.fire('message', { ok: false, reason: 'this token is not for this app' });
        await expect(pending).rejects.toThrow(/not for this app/);
    });

    it('anything outside the bridge is refused here, by name, and never sent', async () => {
        const socket = FakeSocket.last;
        socket.fire('open');
        const sentBefore = socket.sent.length;
        await expect(api().request('engine.shutdown')).rejects.toThrow(/engine\.shutdown/);
        expect(socket.sent).toHaveLength(sentBefore);
        expect(() => api().on('host.anything', () => {})).toThrow(/host\.anything/);
    });

    it('events reach their listener until it unsubscribes', () => {
        const socket = FakeSocket.last;
        socket.fire('open');
        socket.fire('message', { ok: true, packageId: 'p' });
        const seen: unknown[] = [];
        const off = api().on('app.grantChanged', (d) => seen.push(d));
        socket.fire('message', { event: 'app.grantChanged', data: { uses: [] } });
        off();
        socket.fire('message', { event: 'app.grantChanged', data: { uses: ['x'] } });
        expect(seen).toEqual([{ uses: [] }]);
    });

    it('its copy of the bridge is exactly the catalog\'s', () => {
        const source = readFileSync(join(__dirname, '..', 'src', 'main', 'gapp-preload.ts'), 'utf8');
        for (const name of [...APP_BRIDGE.calls, ...APP_BRIDGE.events]) expect(source, name).toContain(`'${name}'`);
        const quoted = [...source.matchAll(/'(app\.[A-Za-z.]+)'/g)].map((m) => m[1]);
        expect([...new Set(quoted)].sort()).toEqual([...APP_BRIDGE.calls, ...APP_BRIDGE.events].sort());
    });

    it('the preload build includes it', () => {
        expect(readFileSync(join(__dirname, '..', 'vite.preload.config.ts'), 'utf8')).toContain("'gapp-preload': 'src/main/gapp-preload.ts'");
    });
});
