import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type ClientTransport, type PreAuth, type WireMessage } from '../src/core/remote-protocol.js';
import { terminalWorkspaceOf, workspaceFolders } from '../src/main/host-share-scope.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/**
 * A WORKSPACE SHARE GETS ITS WORKSPACE'S TERMINALS AND FOLDERS (Tynn #691).
 *
 * genie-host decides what a guest of one workspace may reach by asking which workspace a terminal is in and where each
 * workspace's folder is. Without those answers it refuses every terminal and folder to the guest (#688 fails closed), so
 * a workspace share had no terminals and no folder browsing at all. genie-host now answers both, from its own terminal
 * host and registry: a guest reaches exactly its workspace's terminals (open / attach / output; typing per capability)
 * and folders, another workspace's are still refused, and the owner reaches everything (positive control).
 */

describe('what genie-host answers', () => {
    it('a terminal’s workspace: a live one from the list; an ended one from the host’s record of it; an unknown one: none', () => {
        const live = [{ id: 'term_t', workspaceId: 'tynn' }, { id: 'term_f', workspaceId: 'fancy' }];
        const ended: Record<string, { workspaceId: string; exitCode: number }> = { term_gone: { workspaceId: 'tynn', exitCode: 0 } };
        const of = terminalWorkspaceOf({ list: () => live, finished: (id) => ended[id] ?? null });
        expect(of('term_t')).toBe('tynn');
        expect(of('term_f')).toBe('fancy');
        expect(of('term_gone')).toBe('tynn');
        expect(of('term_unknown')).toBeNull();
    });

    it('each workspace’s folder', () => {
        expect(workspaceFolders(() => [{ id: 'tynn', path: '/w/tynn' }, { id: 'fancy', path: '/w/fancy' }])()).toEqual({ tynn: '/w/tynn', fancy: '/w/fancy' });
    });

    it('genie-host wires both into the API its remote connections are held to', () => {
        const source = readFileSync(join(import.meta.dirname, '../src/main/genie-host.ts'), 'utf8');
        const call = source.slice(source.indexOf('api: hostRemoteApi({'), source.indexOf('api: hostRemoteApi({') + 3000);
        expect(call).toMatch(/workspaceOfTerminal: terminalWorkspaceOf\(terminalHost\)/);
        expect(call).toMatch(/workspacePaths: workspaceFolders\(/);
    });
});

/** genie-host's remote API, a window connected that performs what it is asked, and the relay principals over it. */
const LIVE = [{ id: 'term_t', workspaceId: 'tynn' }, { id: 'term_f', workspaceId: 'fancy' }];
const FOLDERS = [{ id: 'tynn', path: '/w/tynn' }, { id: 'fancy', path: '/w/fancy' }];

let dir: string;
let devices: DeviceStore;
let asked: Array<{ method: string; args: unknown[] }>;
let emit: (channel: string, payload: unknown) => void;
let connectRelay: (who: PreAuth) => ReturnType<typeof client>;

function client(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    return { call: async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next(); }, next, send: (f: unknown) => t.send(JSON.stringify(f)) };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-share-terminals-'));
    devices = await DeviceStore.open(dir, { now: () => 1, random: () => 'tok' });
    asked = [];
    const listeners = new Set<(channel: string, payload: unknown) => void>();
    emit = (channel, payload) => { for (const l of listeners) l(channel, payload); };
    const api = hostRemoteApi({
        hostName: 'alphar',
        own: {},
        window: { connected: () => true, invoke: async (method, args) => { asked.push({ method, args }); return method === 'host.home' ? '/home/owner' : { ok: true }; } },
        onEvent: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        workspaceOfAgent: () => null,
        workspaceOfTerminal: terminalWorkspaceOf({ list: () => LIVE, finished: () => null }),
        workspacePaths: workspaceFolders(() => FOLDERS),
    });
    const connections: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
    new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), pins: new PairingPins({ now: () => 1 }), devices, confirm: allowEveryPairing, now: () => 1, transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } } });
    connectRelay = (who) => { const pair = inMemoryPair(); for (const cb of connections) cb({ ...pair.server, remoteAddress: 'relay:wren', preAuth: who }); return client(pair.client); };
});

afterEach(async () => {
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

const GUEST: PreAuth = { label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: false };
const READONLY: PreAuth = { label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: true };
const OWNER: PreAuth = { label: 'glenn', isOwner: true, workspaceId: null, readonly: false };

async function admitted(who: PreAuth, drive: boolean) {
    const c = connectRelay(who);
    c.send({ kind: 'hello', auth: { kind: 'relay' }, label: who.label });
    expect(await c.next()).toMatchObject({ kind: 'welcome' });
    if (drive) expect(await c.call('baton.take')).toMatchObject({ ok: true });
    return c;
}
const reached = (method: string) => asked.filter((a) => a.method === method).length;

describe('a workspace guest: its own terminals and folders, nobody else’s', () => {
    it('types into, resizes and closes its own terminal; another workspace’s is refused, the host never asked', async () => {
        const g = await admitted(GUEST, true);
        for (const [method, args] of [['terminals.write', ['term_t', 'ls\r']], ['terminals.resize', ['term_t', 80, 24]], ['terminals.close', ['term_t']]] as const) {
            expect(await g.call(method, ...args), method).toMatchObject({ ok: true });
            expect(reached(method)).toBe(1);
            expect(await g.call(method, 'term_f', ...args.slice(1)), `${method} another workspace’s`).toMatchObject({ ok: false });
            expect(reached(method)).toBe(1);
        }
    });

    it('receives its own terminal’s output and exit, not another workspace’s', async () => {
        const g = await admitted(GUEST, false);
        emit('terminal-data', { id: 'term_f', data: 'fancy output' });
        emit('terminal-exit', { id: 'term_f', exitCode: 0 });
        emit('terminal-data', { id: 'term_t', data: 'tynn output' });
        expect(await g.next()).toMatchObject({ kind: 'event', channel: 'terminal-data', payload: { id: 'term_t' } });
        emit('terminal-exit', { id: 'term_t', exitCode: 0 });
        expect(await g.next()).toMatchObject({ kind: 'event', channel: 'terminal-exit', payload: { id: 'term_t' } });
    });

    it('browses its own folder and starts there; another workspace’s folder and the host’s are refused', async () => {
        const g = await admitted(GUEST, false);
        expect(await g.call('host.home')).toMatchObject({ ok: true, value: '/w/tynn' });
        expect(await g.call('host.listDir', '/w/tynn/src')).toMatchObject({ ok: true });
        expect(reached('host.listDir')).toBe(1);
        for (const outside of ['/w/fancy', '/w', '/home/owner', '/w/tynn/../fancy']) expect(await g.call('host.listDir', outside), outside).toMatchObject({ ok: false });
        expect(reached('host.listDir')).toBe(1);
    });

    it('read-only: its terminals’ output and folders, and never a keystroke', async () => {
        const r = await admitted(READONLY, false);
        expect(await r.call('terminals.attach', 'tynn', 'term_t')).toMatchObject({ ok: true });
        expect(await r.call('host.listDir', '/w/tynn')).toMatchObject({ ok: true });
        expect(await r.call('terminals.write', 'term_t', 'ls\r')).toMatchObject({ ok: false });
        expect(reached('terminals.write')).toBe(0);
        emit('terminal-data', { id: 'term_t', data: 'tynn output' });
        expect(await r.next()).toMatchObject({ kind: 'event', channel: 'terminal-data', payload: { id: 'term_t' } });
    });

    it('the owner reaches every terminal and folder (CONTROL)', async () => {
        const o = await admitted(OWNER, true);
        expect(await o.call('terminals.write', 'term_f', 'ls\r')).toMatchObject({ ok: true });
        expect(await o.call('host.listDir', '/w/fancy')).toMatchObject({ ok: true });
        expect(await o.call('host.home')).toMatchObject({ ok: true, value: '/home/owner' });
        emit('terminal-data', { id: 'term_f', data: 'fancy output' });
        expect(await o.next()).toMatchObject({ kind: 'event', channel: 'terminal-data', payload: { id: 'term_f' } });
    });
});
