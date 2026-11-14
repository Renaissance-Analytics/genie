import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { capabilityOf, inMemoryPair, type PreAuth, type RemoteMethod, type ServerConnection } from '../src/core/remote-protocol.js';
import type { LocalFramePort } from '../src/core/local-frame.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { pageBridge, type GenieBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

// Routing/removal already landed in 99727212. These are after-the-feature controls:
// record their break-probe and exact restoration before claiming coverage (Tynn #559).
const ROOT = '/host/work', HOME = '/host/owner';
const rows = [
    { method: 'workspaces.hibernate', args: ['work'], capability: 'write' },
    { method: 'workspaces.wake', args: ['work'], capability: 'write' },
    { method: 'workspaces.remove', args: ['work'], capability: 'write' },
    { method: 'host.listDir', args: [ROOT], capability: 'read' },
    { method: 'host.mkdir', args: [ROOT, 'new-folder'], capability: 'write' },
    { method: 'host.home', args: [], capability: 'read' },
] as const;
type Row = (typeof rows)[number];
type Peer = 'remote owner' | 'relay owner' | 'phone owner' | 'workspace guest' | 'readonly guest';
const owner: PreAuth = { kind: 'relay', label: 'relay owner', isOwner: true, workspaceId: null, readonly: false };
let dir: string, devices: DeviceStore;
const clients: RemoteClient[] = [];
const ports: Array<() => void> = [];
const value = (method: string) => method === 'host.home' ? HOME : { ok: true, method };
const call = (bridge: GenieBridge, row: Row): Promise<unknown> => {
    const [family, name] = row.method.split('.') as ['host' | 'workspaces', string];
    return ((bridge[family] as unknown as Record<string, (...args: readonly unknown[]) => Promise<unknown>>)[name]!)(...row.args);
};

function fixture() {
    const invoke = vi.fn<HostApi['invoke']>(async method => method === 'snapshot'
        ? { workspaces: [{ id: 'work', path: ROOT }], agents: [] }
        : value(method));
    let admit!: (connection: ServerConnection) => void;
    new RemoteHost({
        api: { invoke, onEvent: () => () => {}, workspaceOfAgent: () => 'work', workspacePaths: () => ({ work: ROOT }) },
        devices, hostName: 'family10-host', baton: new Baton(), pins: new PairingPins({ now: Date.now }),
        confirm: allowEveryPairing,
        transport: { onConnection: listener => { admit = listener; return () => {}; } },
    });
    const selected = () => invoke.mock.calls.filter(([method]) => rows.some(row => row.method === method));
    const local = () => {
        const pair = inMemoryPair(); ports.push(() => pair.client.close());
        const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
        let handle = '';
        pair.client.onMessage(text => { for (const listener of listeners) listener('frame', handle, text); });
        pair.client.onClose(() => { for (const listener of listeners) listener('closed', handle, 'closed'); });
        const port: LocalFramePort = {
            onFrame: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            send: (action, id, text) => {
                if (action === 'open') {
                    handle = id;
                    admit({ ...pair.server, preAuth: { kind: 'local', label: 'this window', isOwner: true, workspaceId: null, readonly: false, window: 'main' } });
                } else if (action === 'frame') pair.client.send(text);
                else pair.client.close();
            },
        };
        vi.stubGlobal('window', { genieLocalProtocol: port });
        const native = vi.fn(async () => { throw new Error('retired IPC was used'); });
        const bridge = pageBridge({ workspaces: { hibernate: native, wake: native, remove: native }, host: { listDir: native, mkdir: native, home: native } } as unknown as PreloadBridge);
        return { bridge, native };
    };
    const connect = async (kind: Peer) => {
        const pair = inMemoryPair(), relay = kind.includes('relay') || kind.includes('guest');
        const proof: PreAuth = kind.includes('guest')
            ? { kind: 'relay', label: kind, isOwner: false, workspaceId: 'work', readonly: kind === 'readonly guest' }
            : owner;
        admit({ ...pair.server, ...(relay ? { preAuth: proof } : {}) });
        const token = relay ? null : devices.pair(kind).token;
        const client = connectRemote(pair.client, relay ? { kind: 'relay' } : { kind: 'token', token: token! }, kind,
            kind === 'phone owner' ? { profile: 'mobile' } : {});
        clients.push(client);
        expect(await client.ready).toEqual({ ok: true });
        return client;
    };
    return { invoke, selected, local, connect };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-family10-kept-'));
    let sequence = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `family10-kept-${++sequence}` });
});
afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const close of ports.splice(0)) close();
    vi.unstubAllGlobals();
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

describe('family 10 keeps local caller values and visible failures', () => {
    it.each(rows)('$method preserves explicit null through the actual local session', async row => {
        const source = fixture(); source.invoke.mockResolvedValue(null);
        const { bridge, native } = source.local();
        expect(await call(bridge, row)).toBeNull();
        expect(source.selected()).toEqual([[row.method, [...row.args], expect.anything()]]);
        expect(native).not.toHaveBeenCalled();
    });

    it.each(rows)('$method exposes a transport/API refusal in its existing return shape', async row => {
        const source = fixture(), reason = `${row.method} cannot answer this request`;
        source.invoke.mockRejectedValue(new Error(reason));
        const { bridge, native } = source.local();
        if (row.method === 'host.home') await expect(call(bridge, row)).rejects.toThrow(reason);
        else await expect(call(bridge, row)).resolves.toEqual({ ok: false, reason });
        expect(source.selected()).toEqual([[row.method, [...row.args], expect.anything()]]);
        expect(native).not.toHaveBeenCalled();
    });

    it('CONTROL: every local operation succeeds without taking the remote baton', async () => {
        const source = fixture(), { bridge, native } = source.local();
        for (const row of rows) expect(await call(bridge, row)).toEqual(value(row.method));
        expect(source.selected().map(([method, args]) => [method, args])).toEqual(rows.map(row => [row.method, [...row.args]]));
        expect(native).not.toHaveBeenCalled();
    });
});

describe('family 10 keeps its existing non-local capabilities', () => {
    it.each(['remote owner', 'relay owner', 'phone owner'] as const)('%s keeps reads and baton-gated writes for all six operations', async kind => {
        const source = fixture(), client = await source.connect(kind);
        for (const row of rows) {
            expect(capabilityOf(row.method as RemoteMethod)).toBe(row.capability);
            if (row.capability === 'write') {
                const before = source.selected().length;
                expect(await call(client.bridge, row)).toMatchObject({ ok: false, reason: expect.stringMatching(/driv|baton/i) });
                expect(source.selected()).toHaveLength(before);
            } else expect(await call(client.bridge, row)).toEqual(value(row.method));
        }
        expect(await client.takeBaton()).toEqual({ ok: true });
        for (const row of rows.filter(row => row.capability === 'write')) expect(await call(client.bridge, row)).toEqual(value(row.method));
        expect(source.selected().map(([method, args]) => [method, args])).toEqual([
            ...rows.filter(row => row.capability === 'read'), ...rows.filter(row => row.capability === 'write'),
        ].map(row => [row.method, [...row.args]]));
    });

    it('a workspace guest keeps its shared folder and cannot change the workstation roster or another folder', async () => {
        const source = fixture(), client = await source.connect('workspace guest');
        expect(await client.takeBaton()).toEqual({ ok: true });
        expect(await client.bridge.host!.home!()).toBe(ROOT);
        expect(await client.bridge.host!.listDir(ROOT)).toEqual(value('host.listDir'));
        expect(await client.bridge.host!.listDir('/host/other')).toMatchObject({ ok: false, reason: expect.stringContaining('outside what this link shares') });
        for (const row of rows.filter(row => row.capability === 'write')) {
            expect(await call(client.bridge, row)).toMatchObject({ ok: false, reason: expect.stringMatching(/shares|shared|only its owner/) });
        }
        expect(source.selected().map(([method, args]) => [method, args])).toEqual([['host.listDir', [ROOT]]]);
    });

    it('a read-only guest keeps both reads and refuses every write before calling the API', async () => {
        const source = fixture(), client = await source.connect('readonly guest');
        expect(await client.bridge.host!.home!()).toBe(ROOT);
        expect(await client.bridge.host!.listDir(ROOT)).toEqual(value('host.listDir'));
        for (const row of rows.filter(row => row.capability === 'write')) {
            expect(await call(client.bridge, row)).toMatchObject({ ok: false, reason: expect.stringContaining('read-only access') });
        }
        expect(source.selected().map(([method, args]) => [method, args])).toEqual([['host.listDir', [ROOT]]]);
    });
});
