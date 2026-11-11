import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, type ClientTransport, type ServerConnection } from '../src/core/remote-protocol.js';
import { DeviceLinkService, type DeviceLinkEvent, type DeviceSocket } from '../src/main/device-link-service.js';
import { deviceTokenStore } from '../src/main/device-tokens.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import { redialer } from '../src/renderer/remote-redial.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { fakeKeychain } from './helpers/tynn-storage.js';

/*
 * THE DRONE'S GENIE-HOST RESTARTS UNDER A CONNECTED PILOT (beta.61 blocker, step five; Azure pair gp-11110200, checks 6 and
 * 7). On the hotfix the remote host lived in the Drone's window, so killing genie-host never dropped the Pilot. On the line
 * it is genie-host's: its restart drops every link, and the Pilot's window, which never dialled again by itself, stayed
 * disconnected: no badge, no Deck, not driving. A window whose link dropped dials the same host again, with the token it
 * holds, and drives again.
 */
const DRONE_URL = 'wss://drone.tail.ts.net:7421/genie';
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pilot-restart-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

class BridgedSocket implements DeviceSocket {
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor(readonly end: ClientTransport) {
        end.onMessage((text) => this.onmessage?.({ data: text }));
        end.onClose(() => { this.readyState = 3; this.onclose?.({}); });
        queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); });
    }
    send(data: string): void { this.end.send(data); }
    close(): void { this.end.close(); }
}

/** The Drone's genie-host: a remote host on the devices it keeps on disk. `stop()` is the kill: every link drops. */
async function droneHost() {
    const devices = await DeviceStore.open(dir, { now: Date.now, random: () => 'pilot-device-token' });
    let accept: ((c: ServerConnection) => void) | null = null;
    const live: Array<{ close(): void }> = [];
    const alone: HostApi = { invoke: async () => null, onEvent: () => () => {}, workspaceOfAgent: () => null };
    const host = new RemoteHost({
        api: hostRemoteApi({ hostName: 'drone', own: {}, window: { connected: () => false, invoke: async () => null }, alone }),
        hostName: 'drone', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing,
        transport: { onConnection: (l) => { accept = l; return () => { accept = null; }; } },
    });
    host.issuePin();
    return {
        host, devices,
        dial: (): ServerConnection | null => { if (!accept) return null; const pair = inMemoryPair(); live.push(pair.client); accept(pair.server); return pair.client as unknown as ServerConnection; },
        pair: () => { const pair = inMemoryPair(); live.push(pair.server); return pair; },
        accept: (c: ServerConnection) => accept?.(c),
        stop: async () => { accept = null; for (const l of live.splice(0)) l.close(); await devices.flushed(); },
        track: (c: { close(): void }) => live.push(c),
        listening: () => accept !== null,
    };
}

describe('the Drone\'s genie-host restarts under a connected Pilot', () => {
    it('the Pilot dials again by itself, is connected, and drives again', async () => {
        let drone = await droneHost();
        const listeners = new Set<(event: DeviceLinkEvent) => void>();
        const link = new DeviceLinkService({
            tokens: deviceTokenStore(join(dir, 'device-hosts.json'), fakeKeychain()),
            socket: () => {
                if (!drone.listening()) { const s = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null as ((e: unknown) => void) | null, send() {}, close() {} }; queueMicrotask(() => s.onerror?.({})); return s as unknown as DeviceSocket; }
                const pair = inMemoryPair();
                drone.track(pair.server);
                drone.accept(pair.server);
                return new BridgedSocket(pair.client);
            },
            send: (_owner, event) => { for (const l of listeners) l(event); },
            log: () => {},
        });
        const transportOn = (channel: string): ClientTransport => {
            const messages = new Set<(text: string) => void>(), closes = new Set<() => void>();
            listeners.add((e) => { if (!('channel' in e) || e.channel !== channel) return; if (e.type === 'frame') for (const l of messages) l(e.text); if (e.type === 'closed') for (const l of closes) l(); });
            return { send: (t) => link.send('window', channel, t), onMessage: (l) => { messages.add(l); return () => { messages.delete(l); }; }, onClose: (l) => { closes.add(l); return () => { closes.delete(l); }; }, close: () => link.close('window', channel) };
        };
        // The window's dial: the host's address, a PIN the first time, then the saved hello; it drives.
        let client: RemoteClient | null = null;
        let paired = false;
        const dial = async (): Promise<boolean> => {
            const opened = await link.open('window', DRONE_URL);
            if (!opened.ok) return false;
            client = connectRemote(transportOn(opened.channel), paired ? { kind: 'saved', label: 'pilot' } : { kind: 'pin', code: '482913', label: 'pilot' }, 'pilot', { drive: true });
            const r = await client.ready;
            if (r.ok) paired = true;
            return r.ok;
        };
        const timers: Array<() => void> = [];
        const keep = redialer({ dial, schedule: (ms, fn) => { const t = setTimeout(fn, Math.min(ms, 20)); timers.push(() => clearTimeout(t)); return () => clearTimeout(t); }, delay: () => 10 });
        expect(await dial()).toBe(true);
        await vi.waitFor(() => expect(client!.state()).toMatchObject({ connected: true, driving: true }));
        const first = client!;
        first.onState((s) => { if (!s.connected) keep.dropped(); });

        // The kill, then genie-host started again on the same machine's devices.
        await drone.stop();
        await vi.waitFor(() => expect(first.state().connected).toBe(false));
        drone = await droneHost();

        await vi.waitFor(() => expect(client).not.toBe(first), { timeout: 5_000 });
        await vi.waitFor(() => expect(client!.state()).toMatchObject({ connected: true, host: 'drone', driving: true }), { timeout: 5_000 });
        await vi.waitFor(() => expect(drone.host.connections()).toEqual([expect.objectContaining({ label: 'pilot', driving: true })]));
        keep.stop();
        for (const t of timers) t();
        client!.close();
        await drone.stop();
    });
});

describe('the window wires it', () => {
    it('a connected window whose link dropped, not by Disconnect, dials again with redialer', () => {
        const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
        expect(app).toMatch(/redialer\(\{/);
        expect(app).toMatch(/\.dropped\(\)/);
    });
});
