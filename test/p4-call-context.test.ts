import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_FRAME_CHANNELS, type LocalFrameReply } from '../src/core/local-frame.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import { localProtocolDoor, type LocalDoorContents, type LocalProtocolDoor } from '../src/main/local-protocol-door.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { buildHostApi } from '../src/main/host-api.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import { HostPicks, hostPathRefusal, type FeatureOrigin } from '../src/main/host-picks.js';
import * as protocol from '../src/core/remote-protocol.js';
import * as picks from '../src/main/host-picks.js';

/*
 * WHO A HOST CALL CAME FROM (host split P4, Tynn #578). `features.act` decides which picked host paths a send may attach by
 * whether its caller is this machine's own window; over the door the host API could not know. Every call now carries a
 * CallContext built by RemoteHost from what it admitted, never from anything the caller says: this machine's window or a
 * remote window (the door's admission), a device (a PIN or token over the tailnet), a relay guest or owner, on a phone or
 * a desktop. Shape agreed with P5d (#409).
 */
const settled = async () => { for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r)); };
type Context = { connectionId: string; origin: string; profile: string; isOwner: boolean; workspaceId: string | null; readonly: boolean; label: string };

class FakeFrame { readonly sent: Array<{ action: LocalFrameReply; handle: string; text: string }> = []; send(_c: string, action: LocalFrameReply, handle: string, text: string) { this.sent.push({ action, handle, text }); } }
class FakeContents extends EventEmitter { static n = 0; readonly id = ++FakeContents.n; mainFrame = new FakeFrame(); isDestroyed() { return false; } }

let dir: string;
let devices: DeviceStore;
let invoke: ReturnType<typeof vi.fn>;
let accept: (c: ServerConnection) => void;
let host: RemoteHost;
const contextOf = (): Context => invoke.mock.calls.at(-1)![2] as Context;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-call-context-'));
    let seq = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `ctx-${++seq}` });
    invoke = vi.fn(async () => ({ ok: true }));
    const api: HostApi = { invoke: invoke as unknown as HostApi['invoke'], onEvent: () => () => {}, workspaceOfAgent: () => 'ws' };
    host = new RemoteHost({ api, hostName: 'ctx-host', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing,
        transport: { onConnection: (l) => { accept = l; return () => {}; } } });
});
afterEach(async () => { await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

/** A raw client on a connection the test admits. */
async function wire(conn: (server: ReturnType<typeof inMemoryPair>['server']) => ServerConnection, hello: object) {
    const pair = inMemoryPair();
    const inbox: WireMessage[] = [];
    pair.client.onMessage((t) => { const r = parseMessage(t); if (r.ok) inbox.push(r.message); });
    accept(conn(pair.server));
    pair.client.send(JSON.stringify({ kind: 'hello', ...hello }));
    await vi.waitFor(() => expect(inbox.some((m) => m.kind === 'welcome')).toBe(true));
    return { call: async (method: string, ...args: unknown[]) => { pair.client.send(JSON.stringify({ kind: 'call', id: 1, method, args })); await settled(); }, welcome: inbox.find((m) => m.kind === 'welcome') as { connectionId?: string } };
}

describe('RemoteHost hands the API who each call came from', () => {
    it('a device (PIN over the tailnet), desktop, with its label and owner rights', async () => {
        host.issuePin();
        const c = await wire((s) => s, { auth: { kind: 'pin', code: '482913', label: 'laptop' } });
        await c.call('snapshot');
        expect(contextOf()).toMatchObject({ origin: 'device', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'laptop' });
        expect(contextOf().connectionId).toEqual(expect.any(String));
    });

    it('a phone is a device on the mobile profile', async () => {
        host.issuePin();
        const c = await wire((s) => s, { auth: { kind: 'pin', code: '482913', label: 'pixel' }, profile: 'mobile' });
        await c.call('snapshot');
        expect(contextOf()).toMatchObject({ origin: 'device', profile: 'mobile', label: 'pixel' });
    });

    it('a relay guest: its grant\'s scope and read-only, never the owner', async () => {
        const c = await wire((s) => ({ ...s, preAuth: { label: 'wren', isOwner: false, workspaceId: 'ws', readonly: true } }), { auth: { kind: 'relay' } });
        await c.call('snapshot');
        expect(contextOf()).toMatchObject({ origin: 'relay', profile: 'desktop', isOwner: false, workspaceId: 'ws', readonly: true, label: 'wren' });
    });

    it('a caller cannot say what it is: a hello claiming a local origin over a device connection stays a device', async () => {
        host.issuePin();
        const c = await wire((s) => s, { auth: { kind: 'pin', code: '482913', label: 'x' }, origin: 'local-window', window: 'main' });
        await c.call('snapshot');
        expect(contextOf().origin).toBe('device');
    });
});

describe('the door says which window a local connection is', () => {
    function doorHost(windowKind: (c: LocalDoorContents) => 'main' | 'remote') {
        const ipc = new EventEmitter();
        const door = (localProtocolDoor as unknown as (i: unknown, o: unknown) => LocalProtocolDoor)(ipc, { windowKind });
        const local = vi.fn(async () => ({ ok: true }));
        const api: HostApi = { invoke: local as unknown as HostApi['invoke'], onEvent: () => () => {}, workspaceOfAgent: () => null };
        new RemoteHost({ api, hostName: 'door-host', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing, transport: door });
        const connect = async (contents: FakeContents) => {
            door.admit(contents as unknown as LocalDoorContents);
            const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainEvent;
            ipc.emit(LOCAL_FRAME_CHANNELS.toHost, event, 'open', 'h1', '');
            ipc.emit(LOCAL_FRAME_CHANNELS.toHost, event, 'frame', 'h1', JSON.stringify({ kind: 'hello', auth: { kind: 'local' } }));
            await settled();
            ipc.emit(LOCAL_FRAME_CHANNELS.toHost, event, 'frame', 'h1', JSON.stringify({ kind: 'call', id: 1, method: 'snapshot', args: [] }));
            await settled();
            return local.mock.calls.at(-1) as unknown as [string, unknown[], Context];
        };
        return { connect };
    }

    it('this machine\'s own window is local-window', async () => {
        const main = new FakeContents();
        const [, , context] = await doorHost(() => 'main').connect(main);
        expect(context).toMatchObject({ origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false });
    });

    it('a window driving another machine is remote-window, even though it holds the door', async () => {
        const [, , context] = await doorHost(() => 'remote').connect(new FakeContents());
        expect(context.origin).toBe('remote-window');
    });

    it('with the door saying nothing about a window, it is not trusted as this machine\'s own', async () => {
        const ipc = new EventEmitter();
        const door = localProtocolDoor(ipc as never);
        const local = vi.fn(async () => ({ ok: true }));
        new RemoteHost({ api: { invoke: local as unknown as HostApi['invoke'], onEvent: () => () => {}, workspaceOfAgent: () => null }, hostName: 'h', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing, transport: door });
        const contents = new FakeContents();
        door.admit(contents as unknown as LocalDoorContents);
        const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainEvent;
        ipc.emit(LOCAL_FRAME_CHANNELS.toHost, event, 'open', 'h1', '');
        ipc.emit(LOCAL_FRAME_CHANNELS.toHost, event, 'frame', 'h1', JSON.stringify({ kind: 'hello', auth: { kind: 'local' } }));
        await settled();
        ipc.emit(LOCAL_FRAME_CHANNELS.toHost, event, 'frame', 'h1', JSON.stringify({ kind: 'call', id: 1, method: 'snapshot', args: [] }));
        await settled();
        expect((local.mock.calls.at(-1) as unknown as [string, unknown[], Context])[2].origin).toBe('remote-window');
    });
});

const restricted = () => (protocol as unknown as { RESTRICTED_CALL_CONTEXT: Context }).RESTRICTED_CALL_CONTEXT;
const forwarded = (raw: unknown) => (protocol as unknown as { forwardedCallContext(v: unknown): Context }).forwardedCallContext(raw);
const originOf = (c: unknown, p: HostPicks) => (picks as unknown as { featureOriginOf(c: unknown, p: HostPicks): FeatureOrigin }).featureOriginOf(c, p);
const device = (): Context => ({ connectionId: 'c1', origin: 'device', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'laptop' });

describe('a call nobody vouched for', () => {
    it('the restricted default: no owner, reads only, no workspace at all, and never this machine\'s window', () => {
        expect(restricted()).toMatchObject({ origin: 'relay', profile: 'mobile', isOwner: false, readonly: true });
        // `null` is the WHOLE host; the default must name no workspace, so it reaches none.
        expect(restricted().workspaceId).toBe('');
    });

    it('the host API hands a feature action the caller it was given, and the restricted default when it was given none', async () => {
        const act = vi.fn(async () => ({}));
        const api = buildHostApi({ ...protocolContractDeps('/w'), features: { snapshot: async () => ({}), act, onChange: () => () => {} } } as never);
        const action = { kind: 'noop' };
        await (api.invoke as unknown as (m: string, a: unknown[], c?: Context) => Promise<unknown>)('features.act', [action], device());
        expect(act).toHaveBeenLastCalledWith(action, device());
        await api.invoke('features.act', [action]);
        expect(act).toHaveBeenLastCalledWith(action, restricted());
    });
});

describe('a host path picked on this machine', () => {
    const path = process.platform === 'win32' ? 'C:\\w\\picked.txt' : '/w/picked.txt';
    const local = { ...device(), origin: 'local-window' };

    it('is attached only for this machine\'s own window', () => {
        const held = new HostPicks();
        held.record([path]);
        expect(hostPathRefusal(originOf(local, held), [path])).toBeNull();
        // Positive control above: the refusals below are the origin's, not an unpicked path's.
        for (const origin of ['remote-window', 'device', 'relay']) expect(hostPathRefusal(originOf({ ...local, origin }, held), [path])).toEqual(expect.any(String));
        expect(hostPathRefusal(originOf(undefined, held), [path])).toEqual(expect.any(String));
        expect(hostPathRefusal(originOf(restricted(), held), [path])).toEqual(expect.any(String));
    });
});

describe('a call forwarded from genie-host to a window', () => {
    it('keeps who it came from', async () => {
        const window = vi.fn(async () => 'from-window');
        const alone = vi.fn(async () => 'from-host');
        const api = hostRemoteApi({ hostName: 'h', own: {}, window: { connected: () => true, invoke: window as never } });
        await (api.invoke as unknown as (m: string, a: unknown[], c: Context) => Promise<unknown>)('snapshot', [], device());
        expect(window).toHaveBeenCalledExactlyOnceWith('snapshot', [], device());
        const closed = hostRemoteApi({ hostName: 'h', own: {}, window: { connected: () => false, invoke: window as never }, alone: { invoke: alone as never, onEvent: () => () => {}, workspaceOfAgent: () => null } });
        await (closed.invoke as unknown as (m: string, a: unknown[], c: Context) => Promise<unknown>)('snapshot', [], device());
        expect(alone).toHaveBeenCalledExactlyOnceWith('snapshot', [], device());
    });

    it('cannot arrive as this machine\'s window: a forwarded local origin is the restricted default, as is anything malformed', () => {
        expect(forwarded(device())).toEqual(device());
        expect(forwarded({ ...device(), origin: 'local-window' })).toEqual(restricted());
        for (const bad of [undefined, null, 'device', {}, { ...device(), origin: 'moon' }, { ...device(), isOwner: 'yes' }, { ...device(), workspaceId: 7 }, { ...device(), extra: true }]) expect(forwarded(bad)).toEqual(restricted());
    });
});

describe('main wires it', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    it('the door asks main\'s own record of which windows are remote, when a window opens its connection', () => {
        expect(main).toMatch(/localProtocolDoor\(ipcMain, \{ windowKind: [^\n]*isRemoteWindow\(/);
    });
    it('the feature action decides by the host\'s context, and a forwarded call reaches it', () => {
        expect(main).toMatch(/act: \(action, context\) => runFeatureAction\(action, context\)/);
        expect(main).toMatch(/handleFeatureAction\(composed, action, featureState, featurePorts, featureOriginOf\(context, hostPicks\)\)/);
        expect(main).toMatch(/onRemoteInvoke: \(method: string, args: unknown\[\], context: CallContext\) =>[^\n]*, args, context\)/);
    });
});
