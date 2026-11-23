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
/** genie-host's own answers, as each case builds them (`null` = still being built at boot). */
let answers: ((method: string, args: unknown[], context: unknown) => Promise<unknown>) | null = null;

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie2-remote-access-link-'));
    const before = await DeviceStore.open(home, { now, random: () => 'tok-phone' });
    token = before.pair('glenn’s phone').token;
    await before.flushed();
    tailnet.length = 0;
    answers = null;
    access = await RemoteAccessHost.open({
        home, hostName: 'alphar', now,
        transport: { onConnection: (cb) => { tailnet.push(cb); return () => {}; } },
        api: hostRemoteApi({
            hostName: 'alphar',
            own: { 'updates.state': async () => ({ phase: 'idle' }) },
            alone: () => (answers ? { invoke: (m, a, c) => answers!(m, a, c), onEvent: () => () => {}, workspaceOfAgent: () => null } : null),
        }),
    });
    const service = new RemoteAccessService(access, {
        switch: { apply: async () => {}, restart: async () => {}, stop: async () => {} },
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

async function windowOn(local: boolean) {
    const [h, raw] = memoryPair();
    server.accept(h, { local });
    const t: ClientTransport = { send: (m) => raw.send(m), onMessage: (l) => raw.onMessage(l), onClose: (l) => raw.onClose(l), close: () => raw.close() };
    const client = new SessionEngineClient({});
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

    it('genie-host answers every call itself, with local and non-local windows linked or none (Tynn #898 step 2d-2b)', async () => {
        const p = phone();
        await p.hello({ kind: 'token', token });
        // Still being built at boot: told to try again, never sent to a window.
        await windowOn(true);
        expect(await p.call('host.home')).toMatchObject({ kind: 'result', ok: false, reason: 'alphar\'s services are still starting; try again in a moment' });
        answers = async (method) => ({ fromHost: method });
        expect(await p.call('host.home')).toMatchObject({ kind: 'result', ok: true, value: { fromHost: 'host.home' } });
        await windowOn(false);
        expect(await p.call('host.home')).toMatchObject({ kind: 'result', ok: true, value: { fromHost: 'host.home' } });
        for (const close of links.splice(0)) close();
        await settle();
        expect(await p.call('host.home')).toMatchObject({ kind: 'result', ok: true, value: { fromHost: 'host.home' } });
    });

    it('genie-host\'s answers are told who really asked: a phone stays a device (P4, Tynn #578)', async () => {
        const p = phone();
        await p.hello({ kind: 'token', token });
        const seen: unknown[] = [];
        answers = async (_method, _args, context) => { seen.push(context); return null; };
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
    it('main.ts builds no tailnet listener', () => {
        expect(main).not.toMatch(/remoteListener\(/);
    });
    // A client serves no remote connection (Tynn #898 step 2d-4b2): compose opens no device store at all, host-less or not.
    it('compose.ts opens no device file, with genie-host or without', () => {
        expect(compose).not.toMatch(/DeviceStore/);
        expect(compose).toMatch(/remote: remoteAccess,/);
    });
});
