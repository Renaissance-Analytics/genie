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
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { fakeKeychain } from './helpers/tynn-storage.js';

/*
 * THE PILOT'S CONNECT, AS ITS WINDOW DOES IT (beta.61 blocker, Azure pairs gp-11102138 and gp-11102225): Settings → Remote
 * access → host, PIN, Connect. The window's frames go through its genie-host's device link (the host dials, keeps the token
 * the welcome carries, and cuts it from the frame); the Drone, with no window open, answers through genie-host's own API.
 * Connected means the window says so AND holds the baton.
 */
const URL = 'wss://drone.tail.ts.net:7421/genie';
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pilot-connect-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

/** One end of a WebSocket the device link dials, carried over an in-memory pair to the Drone's remote host. */
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

async function drone(keepWelcomeToken: (token: string) => Promise<void> = async () => {}) {
    const devices = await DeviceStore.open(dir, { now: Date.now, random: () => 'pilot-device-token' });
    const baton = new Baton();
    let accept!: (c: ServerConnection) => void;
    const alone: HostApi = { invoke: async (method) => (method === 'snapshot' ? { agents: [], workspaces: [] } : null), onEvent: () => () => {}, workspaceOfAgent: () => null };
    const host = new RemoteHost({
        api: hostRemoteApi({ hostName: 'drone', own: {}, window: { connected: () => false, invoke: async () => null }, alone }),
        hostName: 'drone', baton, devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing,
        transport: { onConnection: (l) => { accept = l; return () => {}; } },
    });
    host.issuePin();
    // The Pilot's genie-host: its device link and its keychain.
    const k = fakeKeychain();
    const base = k.set.bind(k);
    Object.assign(k, { set: async (name: string, value: string) => { await keepWelcomeToken(value); return base(name, value); } });
    const listeners = new Set<(event: DeviceLinkEvent) => void>();
    const link = new DeviceLinkService({
        tokens: deviceTokenStore(join(dir, 'device-hosts.json'), k),
        socket: () => { const pair = inMemoryPair(); accept(pair.server); return new BridgedSocket(pair.client); },
        send: (_owner, event) => { for (const l of listeners) l(event); },
        log: () => {},
    });
    return { host, baton, devices, link, listeners };
}

/** The window's transport on a device-link channel, as App.tsx's `ipcRelayTransport` is. */
function channelTransport(d: Awaited<ReturnType<typeof drone>>, channel: string): ClientTransport {
    const messages = new Set<(text: string) => void>(), closes = new Set<() => void>();
    d.listeners.add((e) => {
        if (!('channel' in e) || e.channel !== channel) return;
        if (e.type === 'frame') for (const l of messages) l(e.text);
        if (e.type === 'closed') for (const l of closes) l();
    });
    return {
        send: (text) => d.link.send('window', channel, text),
        onMessage: (l) => { messages.add(l); return () => { messages.delete(l); }; },
        onClose: (l) => { closes.add(l); return () => { closes.delete(l); }; },
        close: () => d.link.close('window', channel),
    };
}

describe('a Pilot connects to a Drone with no window open, as its window does', () => {
    it('host, PIN, Connect: the window is connected and drives', async () => {
        const d = await drone();
        const opened = await d.link.open('window', URL);
        if (!opened.ok) throw new Error(opened.reason);
        const client = connectRemote(channelTransport(d, opened.channel), { kind: 'pin', code: '482913', label: 'pilot' }, 'pilot', { drive: true });
        expect(await client.ready).toEqual({ ok: true });
        expect(client.state()).toMatchObject({ connected: true, host: 'drone' });
        await vi.waitFor(() => expect(d.host.connections()).toEqual([expect.objectContaining({ label: 'pilot', driving: true })]));
        await vi.waitFor(() => expect(client.state()).toMatchObject({ driving: true }));
        client.close();
        await d.devices.flushed();
    });

    /*
     * WHAT THE DRONE SAYS (Azure pair gp-11102252): the Pilot's badge said "you are driving" while the Drone's own status said
     * nobody was. genie-host's windows read the remote host's connections from its pushed status, which is pushed on a change;
     * the baton changing was not one, so the status kept the connection as it was at hello: not driving.
     */
    it('the Drone announces that the Pilot now drives, so what its windows read says so', async () => {
        const d = await drone();
        const opened = await d.link.open('window', URL);
        if (!opened.ok) throw new Error(opened.reason);
        let status = d.host.connections();
        d.host.onChange(() => { status = d.host.connections(); });
        const client = connectRemote(channelTransport(d, opened.channel), { kind: 'pin', code: '482913', label: 'pilot' }, 'pilot', { drive: true });
        expect(await client.ready).toEqual({ ok: true });
        await vi.waitFor(() => expect(client.state()).toMatchObject({ driving: true }));
        await vi.waitFor(() => expect(status).toEqual([expect.objectContaining({ label: 'pilot', driving: true })]));
        client.close();
        await d.devices.flushed();
    });

    it('a keychain slow to keep the pairing still lets the welcome through, and the window drives', async () => {
        let release!: () => void;
        const held = new Promise<void>((r) => { release = r; });
        const d = await drone(() => held);
        const opened = await d.link.open('window', URL);
        if (!opened.ok) throw new Error(opened.reason);
        const client = connectRemote(channelTransport(d, opened.channel), { kind: 'pin', code: '482913', label: 'pilot' }, 'pilot', { drive: true });
        setTimeout(release, 50);
        expect(await client.ready).toEqual({ ok: true });
        await vi.waitFor(() => expect(client.state()).toMatchObject({ connected: true, driving: true }));
        client.close();
        await d.devices.flushed();
    });
});
