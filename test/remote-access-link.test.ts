import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { inMemoryPair, parseMessage, type ClientTransport, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import { hostRemoteApi, RemoteAccessHost, RemoteAccessService } from '../src/main/remote-access-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';

/*
 * REMOTE ACCESS OVER THE ENGINE LINK (Tynn #409, P5d.1), end to end on the real engine protocol: genie-host's remote host,
 * a phone on its tailnet transport, a window linked to the host (local, or not), the window's relay host bridging a Pilot.
 */

const TOKEN = 'p5d1-token';
const now = () => 1_000_000;
const settle = () => new Promise((r) => setTimeout(r, 20));

function wire(t: ClientTransport) {
    const inbox: Array<WireMessage | 'closed'> = [];
    const waiters: Array<(m: WireMessage | 'closed') => void> = [];
    const push = (m: WireMessage | 'closed') => { const w = waiters.shift(); if (w) w(m); else inbox.push(m); };
    t.onMessage((text) => { const r = parseMessage(text); if (r.ok) push(r.message); });
    t.onClose(() => push('closed'));
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage | 'closed'>((r) => waiters.push(r)));
    let id = 0;
    return {
        hello: async (auth: object, label = 'phone') => { t.send(JSON.stringify({ kind: 'hello', auth, label })); return next(); },
        call: async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next(); },
        next,
    };
}

let home = '';
let token = '';
let server: SessionEngineServer;
const tailnet: Array<(c: ServerConnection) => void> = [];
const links: Array<() => void> = [];
let access: RemoteAccessHost;

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie2-remote-access-link-'));
    const before = await DeviceStore.open(home, { now, random: () => 'tok-phone' });
    token = before.pair('glenn’s phone').token;
    await before.flushed();
    tailnet.length = 0;
    access = await RemoteAccessHost.open({
        home, hostName: 'alphar', now,
        transport: { onConnection: (cb) => { tailnet.push(cb); return () => {}; } },
        api: hostRemoteApi({
            hostName: 'alphar',
            own: { 'updates.state': async () => ({ phase: 'idle' }) },
            window: { connected: () => server.newestLocalWindow() !== null, invoke: (m, a, c) => server.remoteInvoke(m, a, c) },
        }),
    });
    const service = new RemoteAccessService(access, {
        switch: { apply: async () => {}, restart: async () => {}, stop: async () => {} },
        newestWindow: () => server.newestLocalWindow(),
        windowEvent: () => {},
        send: (owner, event) => server.remoteAccessEvent(owner, event),
    });
    server = new SessionEngineServer({ token: TOKEN, build: 't', remoteAccess: service });
});
/** Everything this file's host and windows leave behind, then its folder. */
async function leave(): Promise<void> {
    for (const close of links.splice(0)) close();
    // Its private writes first: on Windows each ends by restricting the file's ACL, which fails on a file already gone.
    await access.close();
    await rm(home, { recursive: true, force: true });
}
afterEach(leave);

async function windowOn(local: boolean, onRemoteInvoke?: (method: string, args: unknown[], context: unknown) => Promise<unknown>) {
    const [h, raw] = memoryPair();
    server.accept(h, { local });
    const t: ClientTransport = { send: (m) => raw.send(m), onMessage: (l) => raw.onMessage(l), onClose: (l) => raw.onClose(l), close: () => raw.close() };
    const client = new SessionEngineClient({ ...(onRemoteInvoke ? { onRemoteInvoke } : {}) });
    expect(await client.connect(t, TOKEN)).toMatchObject({ ok: true });
    links.push(() => t.close());
    return { client, close: () => t.close() };
}

const phone = () => { const pair = inMemoryPair(); for (const cb of tailnet) cb(pair.server); return wire(pair.client); };

describe('remote access over the engine link', () => {
    // A token hello saves the device's last-seen privately, and on Windows that write ends by restricting the file's ACL:
    // a folder removed under it makes that step fail on a file that is gone (test/helpers/acl-guard.ts counts it).
    it('leaving waits for the host\'s private writes before its folder goes', async () => {
        const p = phone();
        await p.hello({ kind: 'token', token });
        const flushed = vi.spyOn(DeviceStore.prototype, 'flushed');
        await leave();
        expect(flushed).toHaveBeenCalled();
        flushed.mockRestore();
    });

    it('is driven from a LOCAL window only (control: a local window reads the status)', async () => {
        const remote = await windowOn(false);
        await expect(remote.client.call('engine.remoteAccess', ['status', []])).resolves.toEqual({ ok: false, reason: 'Remote access is driven from a local window only.' });
        const local = await windowOn(true);
        await expect(local.client.call('engine.remoteAccess', ['status', []])).resolves.toMatchObject({ ok: true, value: { host: 'alphar', devices: [{ label: 'glenn’s phone' }] } });
    });

    it('what the host does not own goes to the newest LOCAL window; a non-local one is never asked; with none, refused', async () => {
        const p = phone();
        await p.hello({ kind: 'token', token });
        await windowOn(false, async () => ({ fromWindow: 'not-local' }));
        expect(await p.call('snapshot')).toMatchObject({ kind: 'result', ok: false, reason: 'alphar answers snapshot only while a Genie window is open there: open Genie on alphar' });
        const local = await windowOn(true, async (method) => ({ fromWindow: method }));
        expect(await p.call('snapshot')).toMatchObject({ kind: 'result', ok: true, value: { fromWindow: 'snapshot' } });
        local.close();
        await settle();
        expect(await p.call('snapshot')).toMatchObject({ kind: 'result', ok: false });
    });

    it('a window answering for the host is told who really asked: a phone stays a device (P4, Tynn #578)', async () => {
        const p = phone();
        await p.hello({ kind: 'token', token });
        const seen: unknown[] = [];
        await windowOn(true, async (_method, _args, context) => { seen.push(context); return null; });
        expect(await p.call('snapshot')).toMatchObject({ kind: 'result', ok: true });
        expect(seen).toEqual([expect.objectContaining({ origin: 'device', isOwner: true, label: 'phone' })]);
    });

    it('a window\'s replica reads and drives the host\'s PIN, and is told when it changes', async () => {
        const local = await windowOn(true);
        const replica = local.client.remoteAccess();
        await replica.refresh();
        expect(replica.devices().map((d) => d.label)).toEqual(['glenn’s phone']);
        let changed = 0;
        replica.onChange(() => { changed += 1; });
        await replica.issuePin();
        await settle();
        expect(replica.activePin()?.code).toMatch(/^\d{6}$/);
        expect(changed).toBeGreaterThan(0);
    });
});

describe('with genie-host linked, the window starts no listener and opens no device store (source guards)', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const compose = readFileSync(new URL('../src/main/compose.ts', import.meta.url), 'utf8');
    it('main.ts builds the tailnet listener only without genie-host', () => {
        expect(main).toMatch(/const remoteSocket = linkedRemote \? null : remoteListener\(/);
    });
    it('compose.ts opens the device file only without genie-host', () => {
        expect(compose).toMatch(/input\.remoteAccess\s*\?\s*DeviceStore\.memory\(/);
    });
});
