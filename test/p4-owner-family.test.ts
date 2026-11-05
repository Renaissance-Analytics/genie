import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { capabilityOf, inMemoryPair, REMOTE_METHODS, type PreAuth, type RemoteMethod, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import type { LocalFramePort } from '../src/core/local-frame.js';
import { droneRefusal } from '../src/core/workstation-role.js';
import { buildHostApi } from '../src/main/host-api.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { pageBridge, type GenieBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const localProof: PreAuth = { kind: 'local', label: 'local', isOwner: true, workspaceId: null, readonly: false };
const methods = ['appInbox.state', 'appInbox.createKey', 'appInbox.revokeKey', 'appInbox.source', 'deviceLink.hosts', 'deviceLink.forget', 'deviceLink.adopt', 'tynnNetwork.workstations', 'tynnNetwork.setRole', 'tynnNetwork.shares.list', 'tynnNetwork.shares.mint', 'tynnNetwork.shares.revoke'] as const;
const state = { url: null, enabled: false, sources: [], revoked: [], scriptKeys: [{ id: 'key_fixture', name: 'test', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null }] };
const share = { id: 'share_fixture', url: 'https://example.test/connect/synthetic', whole: true, workspaceIds: [], capability: 'readonly', claimed: false, expiresAt: null };
const listedShare = { ...share, url: null };
type Owner = { appInbox: NonNullable<GenieBridge['appInbox']>; deviceLink: Pick<NonNullable<GenieBridge['deviceLink']>, 'hosts' | 'forget' | 'adopt'>; tynnNetwork: Pick<NonNullable<GenieBridge['tynnNetwork']>, 'workstations' | 'setRole' | 'shares'> };
const rows: Array<{ method: typeof methods[number]; args: unknown[]; call: (b: Owner) => Promise<unknown>; value: unknown; port: string; portArgs: unknown[] }> = [
    { method: 'appInbox.state', args: ['work'], call: b => b.appInbox.state('work'), value: { ok: true, state }, port: 'state', portArgs: ['work'] },
    { method: 'appInbox.createKey', args: ['work', ' test '], call: b => b.appInbox.createKey('work', ' test '), value: { ok: true, id: 'key_fixture', name: 'test', token: 'synthetic-key-never-a-real-secret', state }, port: 'createKey', portArgs: ['work', ' test '] },
    { method: 'appInbox.revokeKey', args: ['work', 'key_fixture'], call: b => b.appInbox.revokeKey('work', 'key_fixture'), value: { ok: true, state }, port: 'revokeKey', portArgs: ['key_fixture'] },
    { method: 'appInbox.source', args: ['work', 'revoke', 'site', 'site_fixture'], call: b => b.appInbox.source('work', 'revoke', 'site', 'site_fixture'), value: { ok: true, text: 'Revoked: restarted with it', state }, port: 'revokeSource', portArgs: [{ kind: 'site', id: 'site_fixture', workspaceId: 'work' }] },
    { method: 'deviceLink.hosts', args: [], call: b => b.deviceLink.hosts(), value: ['wss://example.test/genie'], port: 'hosts', portArgs: [] },
    { method: 'deviceLink.forget', args: ['wss://example.test/genie'], call: b => b.deviceLink.forget('wss://example.test/genie'), value: false, port: 'forget', portArgs: ['wss://example.test/genie'] },
    { method: 'deviceLink.adopt', args: ['wss://example.test/genie', 'synthetic-device-token'], call: b => b.deviceLink.adopt!('wss://example.test/genie', 'synthetic-device-token'), value: true, port: 'adopt', portArgs: ['wss://example.test/genie', 'synthetic-device-token'] },
    { method: 'tynnNetwork.workstations', args: [], call: b => b.tynnNetwork.workstations(), value: { ok: true, workstations: [{ id: 'ws_fixture', source: null, online: null }] }, port: 'workstations', portArgs: [] },
    { method: 'tynnNetwork.setRole', args: ['ws_fixture', 'drone', 'synthetic-code'], call: b => b.tynnNetwork.setRole!('ws_fixture', 'drone', 'synthetic-code'), value: { ok: true, role: 'drone' }, port: 'setRole', portArgs: ['ws_fixture', 'drone', 'synthetic-code'] },
    { method: 'tynnNetwork.shares.list', args: [null], call: b => b.tynnNetwork.shares!.list(null), value: { ok: true, links: [listedShare] }, port: 'list', portArgs: [null] },
    { method: 'tynnNetwork.shares.mint', args: [{ workspaceId: null, capability: 'readonly', expiresInDays: 3 }], call: b => b.tynnNetwork.shares!.mint({ workspaceId: null, capability: 'readonly', expiresInDays: 3 }), value: { ok: true, link: share }, port: 'mint', portArgs: [{ workspaceId: null, capability: 'readonly', expiresInDays: 3 }] },
    { method: 'tynnNetwork.shares.revoke', args: ['share_fixture'], call: b => b.tynnNetwork.shares!.revoke('share_fixture'), value: { ok: true }, port: 'revoke', portArgs: ['share_fixture'] },
];
let dir: string, devices: DeviceStore;
const closes: Array<() => void> = [];
function setup() {
    const ports = {
        state: vi.fn(() => state), workspaceExists: vi.fn((id: string) => id === 'work'),
        createKey: vi.fn(async (_id: string, _name: string) => ({ id: 'key_fixture', token: 'synthetic-key-never-a-real-secret' })),
        scriptKeys: vi.fn((_id: string) => [{ id: 'key_fixture' }]), revokeKey: vi.fn(async (_id: string) => {}),
        rotate: vi.fn((_kind: string, _id: string) => {}), revokeSource: vi.fn(async (_source: unknown) => {}), allowSource: vi.fn(async (_kind: string, _id: string) => {}),
        restartSource: vi.fn(async (_workspace: string, _kind: string, _id: string) => 'restarted with it'),
        hosts: vi.fn(async () => ['wss://example.test/genie']), forget: vi.fn(async (_url: string) => false), adopt: vi.fn(async (_url: string, _token: string) => true),
        hasAccount: vi.fn(() => true), signedIn: vi.fn(() => true), role: vi.fn((): 'pilot' | 'drone' | null => 'pilot'),
        workstations: vi.fn(async () => ({ ok: true, workstations: [{ id: 'ws_fixture', source: null, online: null }] })),
        setRole: vi.fn(async (_id: string, _role: string, _code: string) => ({ ok: true, role: 'drone' })), rereadRole: vi.fn(() => {}),
        list: vi.fn(async (_workspace: unknown) => ({ ok: true, links: [listedShare] })), mint: vi.fn(async (_input: unknown) => ({ ok: true, link: share })), revoke: vi.fn(async (_id: string) => ({ ok: true })),
    };
    const deps = protocolContractDeps(dir);
    Object.assign(deps, { localOwner: { appInbox: ports, deviceLink: ports, tynnNetwork: { ...ports, shares: ports } } });
    const api = buildHostApi(deps), invoke = vi.spyOn(api, 'invoke'), calls: Array<{ method: string; args: unknown[] }> = [];
    let accept!: (connection: ServerConnection) => void;
    new RemoteHost({ api, hostName: 'owner-fixture', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: (listener) => { accept = c => { c.onMessage(text => { const m = JSON.parse(text); if (m.kind === 'call') calls.push({ method: m.method, args: m.args }); }); listener(c); }; return () => {}; } } });
    function pair(proof?: PreAuth) { const p = inMemoryPair(); accept({ ...p.server, ...(proof ? { preAuth: proof } : {}) }); closes.push(() => p.client.close()); return p; }
    async function client(proof: PreAuth = localProof, mobile = false) { const p = pair(proof), c = connectRemote(p.client, { kind: proof.kind === 'local' ? 'local' : 'relay' }, 'owner-fixture', mobile ? { profile: 'mobile' } : {}); expect(await c.ready).toEqual({ ok: true }); return c; }
    async function raw(proof?: PreAuth, mobile = false) {
        const p = pair(proof), frames: WireMessage[] = []; p.client.onMessage(text => frames.push(JSON.parse(text)));
        p.client.send(JSON.stringify({ kind: 'hello', auth: proof ? { kind: 'relay' } : { kind: 'token', token: devices.pair('owner').token }, ...(mobile ? { profile: 'mobile' } : {}) })); await tick();
        expect(frames.some(f => f.kind === 'welcome')).toBe(true); frames.length = 0;
        return { frames, call: async (method: string, args: unknown[]) => { const id = calls.length + 100; p.client.send(JSON.stringify({ kind: 'call', id, method, args })); await tick(); return frames.find(f => f.kind === 'result' && f.id === id); } };
    }
    function port(): LocalFramePort {
        const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>(); let p: ReturnType<typeof pair> | null = null, handle = '';
        return { onFrame: l => { listeners.add(l); return () => { listeners.delete(l); }; }, send: (action, id, text) => {
            if (action === 'open') { p?.client.close(); p = pair(localProof); handle = id; p.client.onMessage(frame => { for (const l of listeners) l('frame', handle, frame); }); p.client.onClose(() => { for (const l of listeners) l('closed', handle, ''); }); }
            else if (action === 'frame') p?.client.send(text); else p?.client.close();
        } };
    }
    return { ports, deps, api, invoke, calls, client, raw, port };
}
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-p4-owner-')); let seq = 0; devices = await DeviceStore.open(dir, { now: Date.now, random: () => `synthetic-owner-${++seq}` }); });
async function cleanupOwnerFixture(remove: typeof rm = rm) { for (const close of closes.splice(0)) close(); vi.unstubAllGlobals(); await tick(); await devices.flushed(); await remove(dir, { recursive: true, force: true }); }
afterEach(() => cleanupOwnerFixture());

it('late fixture cleanup removes only the directory whose device writes it awaited', async () => {
    const realDir = dir, realDevices = devices, removed: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), flushed = vi.fn(() => gate);
    const remove = (async (path: unknown) => { removed.push(path); }) as typeof rm;
    try {
        dir = 'first-fixture'; devices = { flushed } as unknown as DeviceStore;
        const pending = cleanupOwnerFixture(remove); await tick(); expect(flushed).toHaveBeenCalledOnce();
        // A timed-out hook continues after the next case has replaced these shared bindings.
        dir = 'next-fixture'; devices = { flushed: async () => {} } as unknown as DeviceStore;
        release(); await pending;
        expect(removed).toEqual(['first-fixture']);
    } finally { release(); dir = realDir; devices = realDevices; }
});

describe('family5 owner methods and real recorded bridge calls', () => {
    it.each(methods)('%s starts local', method => { expect(REMOTE_METHODS).toContain(method); expect(capabilityOf(method as RemoteMethod)).toBe('local'); });
    it.each(rows)('$method sends its actual arguments and preserves the native result', async row => {
        const f = setup(), c = await f.client();
        const owner = (c as unknown as { localOwner: Owner }).localOwner;
        expect(owner, 'local-only facade on the same client').toBeDefined();
        expect(await row.call(owner)).toEqual(row.value);
        expect(f.calls).toEqual([{ method: row.method, args: row.args }]);
        expect(f.invoke).toHaveBeenCalledExactlyOnceWith(row.method, row.args);
        expect(f.ports[row.port as keyof typeof f.ports]).toHaveBeenCalledWith(...row.portArgs);
    });
    it.each(['tailnet owner', 'relay owner', 'workspace guest', 'host guest', 'readonly relay', 'phone owner', 'phone relay guest'])('%s is refused before invocation and receives no local key/share payload', async kind => {
        const f = setup(), relay = kind.includes('relay') || kind.includes('guest'), guest = kind.includes('guest');
        const p = await f.raw(relay ? { label: kind, isOwner: !guest, workspaceId: kind === 'workspace guest' ? 'work' : null, readonly: kind.includes('readonly') } : undefined, kind.startsWith('phone'));
        for (const row of rows) expect(await p.call(row.method, row.args)).toMatchObject({ kind: 'result', ok: false, reason: expect.stringContaining("own Genie window") });
        expect(f.invoke).not.toHaveBeenCalled(); expect(f.ports.createKey).not.toHaveBeenCalled(); expect(f.ports.adopt).not.toHaveBeenCalled(); expect(f.ports.mint).not.toHaveBeenCalled();
        expect(JSON.stringify(p.frames)).not.toContain('synthetic-key-never-a-real-secret'); expect(JSON.stringify(p.frames)).not.toContain('/connect/synthetic');
    });
    it('a remote client exposes none of the local owner facade', async () => { const f = setup(), c = await f.client({ label: 'remote', isOwner: true, workspaceId: null, readonly: false }); expect((c as unknown as { localOwner?: unknown }).localOwner).toBeUndefined(); expect(c.bridge.appInbox).toBeUndefined(); });
    it.each(rows)('pageBridge $method replaces its old native forward on the cached connection', async row => {
        const f = setup(), old = vi.fn(async () => { throw new Error('old native path'); }), open = vi.fn(), send = vi.fn(), close = vi.fn(), onMessage = vi.fn(), onClosed = vi.fn(), onOpenStep = vi.fn(), openLink = vi.fn();
        vi.stubGlobal('window', { genieLocalProtocol: f.port() });
        const preload = { appInbox: { state: old, createKey: old, revokeKey: old, source: old }, deviceLink: { open, hosts: old, forget: old, adopt: old }, tynnNetwork: { open, send, close, onMessage, onClosed, onOpenStep, openLink, workstations: old, setRole: old, shares: { list: old, mint: old, revoke: old } }, subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge;
        const b = pageBridge(preload); expect(pageBridge(preload)).toBe(b);
        expect(await row.call(b as Owner)).toEqual(row.value); expect(f.calls).toEqual([{ method: row.method, args: row.args }]); expect(old).not.toHaveBeenCalled();
        expect(b.deviceLink!.open).toBe(open);
        for (const key of ['open', 'send', 'close', 'onMessage', 'onClosed', 'onOpenStep', 'openLink'] as const) expect(b.tynnNetwork![key]).toBe(preload.tynnNetwork![key]);
    });
    it.each(rows)('pageBridge $method rejects a missing local door instead of using preload', async row => {
        vi.stubGlobal('window', {}); const old = vi.fn();
        const b = pageBridge({ appInbox: { state: old, createKey: old, revokeKey: old, source: old }, deviceLink: { hosts: old, forget: old, adopt: old }, tynnNetwork: { workstations: old, setRole: old, shares: { list: old, mint: old, revoke: old } }, subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge);
        await expect(row.call(b as Owner)).rejects.toThrow('no local protocol connection'); expect(old).not.toHaveBeenCalled();
    });
    it('a stable owner facade survives manual recovery over the page connection', async () => {
        const f = setup(), port = f.port(); vi.stubGlobal('window', { genieLocalProtocol: port });
        const b = pageBridge({ deviceLink: { open: vi.fn() }, tynnNetwork: { open: vi.fn() }, subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge), inbox = b.appInbox;
        expect(await b.appInbox!.state('work')).toEqual({ ok: true, state }); port.send('close', '', ''); await tick();
        await expect(b.appInbox!.state('work')).rejects.toThrow('connection'); b.localProtocol!.retry();
        expect(await b.appInbox!.state('work')).toEqual({ ok: true, state }); expect(b.appInbox).toBe(inbox); expect(f.calls).toEqual([{ method: 'appInbox.state', args: ['work'] }, { method: 'appInbox.state', args: ['work'] }]);
    });
});

describe('native guards, null and refusal remain visible', () => {
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    const nonJsonRows: Array<{ method: string; call: (b: Owner) => Promise<unknown>; value: unknown }> = [
        { method: 'appInbox.state', call: b => b.appInbox.state(9n as never), value: { ok: false, reason: 'name a workspace' } },
        { method: 'appInbox.createKey', call: b => b.appInbox.createKey('work', 9n as never), value: { ok: false, reason: 'name a workspace and the key' } },
        { method: 'appInbox.revokeKey', call: b => b.appInbox.revokeKey('work', cycle as never), value: { ok: false, reason: 'name a workspace and the key' } },
        { method: 'appInbox.source', call: b => b.appInbox.source('work', 'rotate', 'site', cycle as never), value: { ok: false, reason: 'rotate, revoke or allow a site or a process' } },
        { method: 'deviceLink.forget', call: b => b.deviceLink.forget(cycle as never), value: false },
        { method: 'deviceLink.adopt', call: b => b.deviceLink.adopt('host', 9n as never), value: false },
        { method: 'tynnNetwork.setRole', call: b => b.tynnNetwork.setRole!('ws', 9n as never, 'code'), value: { ok: false, reason: 'not a role change' } },
        { method: 'tynnNetwork.shares.list', call: b => b.tynnNetwork.shares!.list(cycle as never), value: { ok: true, links: [listedShare] } },
        { method: 'tynnNetwork.shares.mint', call: b => b.tynnNetwork.shares!.mint(9n as never), value: { ok: true, link: share } },
        { method: 'tynnNetwork.shares.revoke', call: b => b.tynnNetwork.shares!.revoke(9n as never), value: { ok: false, reason: 'not a link' } },
        { method: 'mint ignores unrelated cyclic properties', call: b => b.tynnNetwork.shares!.mint({ workspaceId: null, capability: 'readonly', expiresInDays: 3, ignored: cycle } as never), value: { ok: true, link: share } },
    ];
    for (const target of ['client', 'page'] as const) {
        it.each(nonJsonRows)(`${target} $method preserves native non-JSON input results before serialization`, async row => {
            const f = setup(); let owner: Owner;
            if (target === 'client') owner = (await f.client() as unknown as { localOwner: Owner }).localOwner;
            else { vi.stubGlobal('window', { genieLocalProtocol: f.port() }); owner = pageBridge({ subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge) as Owner; }
            expect(await row.call(owner)).toEqual(row.value);
            expect(f.ports.createKey).not.toHaveBeenCalled(); expect(f.ports.revokeKey).not.toHaveBeenCalled(); expect(f.ports.rotate).not.toHaveBeenCalled(); expect(f.ports.forget).not.toHaveBeenCalled(); expect(f.ports.adopt).not.toHaveBeenCalled(); expect(f.ports.setRole).not.toHaveBeenCalled(); expect(f.ports.revoke).not.toHaveBeenCalled();
            if (row.method.includes('mint')) expect(f.ports.mint).toHaveBeenCalledExactlyOnceWith({ workspaceId: null, capability: row.method.startsWith('mint') ? 'readonly' : 'control', expiresInDays: row.method.startsWith('mint') ? 3 : 7 });
            if (row.method === 'tynnNetwork.shares.list') expect(f.ports.list).toHaveBeenCalledExactlyOnceWith(null);
        });
        it(`${target} keeps the native drone refusal ahead of invalid non-JSON role arguments`, async () => {
            const f = setup(); f.ports.role.mockReturnValue('drone'); let owner: Owner;
            if (target === 'client') owner = (await f.client() as unknown as { localOwner: Owner }).localOwner;
            else { vi.stubGlobal('window', { genieLocalProtocol: f.port() }); owner = pageBridge({ subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge) as Owner; }
            expect(await owner.tynnNetwork.setRole!(cycle as never, 9n as never, cycle as never)).toEqual({ ok: false, reason: droneRefusal('drone') }); expect(f.ports.setRole).not.toHaveBeenCalled();
        });
    }
    const bad = [undefined, null, false, 42, {}, [], ''];
    it.each(bad.map(v => [v]))('app inbox rejects invalid workspace %j without touching keys', async raw => {
        const f = setup();
        expect(await f.api.invoke('appInbox.state' as RemoteMethod, [raw])).toEqual({ ok: false, reason: 'name a workspace' });
        for (const method of ['appInbox.createKey', 'appInbox.revokeKey']) expect(await f.api.invoke(method as RemoteMethod, [raw, 'key_fixture'])).toEqual({ ok: false, reason: 'name a workspace and the key' });
        expect(f.ports.state).not.toHaveBeenCalled(); expect(f.ports.createKey).not.toHaveBeenCalled(); expect(f.ports.revokeKey).not.toHaveBeenCalled();
    });
    it('creating a key requires the named workspace and exposes key-store refusal', async () => {
        const f = setup(); expect(await f.api.invoke('appInbox.createKey' as RemoteMethod, ['missing', 'key'])).toEqual({ ok: false, reason: 'no workspace missing' }); expect(f.ports.createKey).not.toHaveBeenCalled();
        f.ports.createKey.mockRejectedValue(new Error('fixture key refusal'));
        expect(await f.api.invoke('appInbox.createKey' as RemoteMethod, ['work', 'key'])).toEqual({ ok: false, reason: 'fixture key refusal' });
    });
    it.each([undefined, null, false, 42, {}, []].map(v => [v]))('creating a key rejects a nonstring name %j before looking up the workspace', async raw => { const f = setup(); expect(await f.api.invoke('appInbox.createKey' as RemoteMethod, ['work', raw])).toEqual({ ok: false, reason: 'name a workspace and the key' }); expect(f.ports.workspaceExists).not.toHaveBeenCalled(); expect(f.ports.createKey).not.toHaveBeenCalled(); });
    it('revoking a key requires workspace membership', async () => { const f = setup(); expect(await f.api.invoke('appInbox.revokeKey' as RemoteMethod, ['other', 'not-owned'])).toEqual({ ok: false, reason: 'that key is not one of this workspace’s' }); expect(f.ports.revokeKey).not.toHaveBeenCalled(); });
    it.each(['rotate', 'revoke', 'allow'] as const)('source %s keeps operation and restart sequencing', async op => {
        const f = setup(); expect(await f.api.invoke('appInbox.source' as RemoteMethod, ['work', op, 'process', 'proc_fixture'])).toEqual({ ok: true, text: `${op === 'rotate' ? 'Rotated' : op === 'revoke' ? 'Revoked' : 'Allowed'}: restarted with it`, state });
        const action = op === 'rotate' ? f.ports.rotate : op === 'revoke' ? f.ports.revokeSource : f.ports.allowSource;
        expect(action).toHaveBeenCalledExactlyOnceWith(...(op === 'revoke' ? [{ kind: 'process', id: 'proc_fixture', workspaceId: 'work' }] : ['process', 'proc_fixture']));
        expect(f.ports.restartSource).toHaveBeenCalledExactlyOnceWith('work', 'process', 'proc_fixture'); expect(action.mock.invocationCallOrder[0]).toBeLessThan(f.ports.restartSource.mock.invocationCallOrder[0]!);
    });
    it.each([['work', 'bad', 'site', 'a'], ['work', 'rotate', 'bad', 'a'], ['work', 'rotate', 'site', ''], [null, 'allow', 'process', 'p']])('invalid source tuple %j refuses before mutation', async (...args) => { const f = setup(); expect(await f.api.invoke('appInbox.source' as RemoteMethod, args)).toEqual({ ok: false, reason: 'rotate, revoke or allow a site or a process' }); expect(f.ports.restartSource).not.toHaveBeenCalled(); expect(f.ports.rotate).not.toHaveBeenCalled(); expect(f.ports.revokeSource).not.toHaveBeenCalled(); expect(f.ports.allowSource).not.toHaveBeenCalled(); });
    it('a failed source mutation does not restart; a failed restart remains a refusal', async () => { const f = setup(); f.ports.revokeSource.mockRejectedValue(new Error('fixture revoke refusal')); expect(await f.api.invoke('appInbox.source' as RemoteMethod, ['work', 'revoke', 'site', 'a'])).toEqual({ ok: false, reason: 'fixture revoke refusal' }); expect(f.ports.restartSource).not.toHaveBeenCalled(); f.ports.rotate.mockImplementation(() => {}); f.ports.restartSource.mockRejectedValue(new Error('fixture restart refusal')); expect(await f.api.invoke('appInbox.source' as RemoteMethod, ['work', 'rotate', 'site', 'a'])).toEqual({ ok: false, reason: 'fixture restart refusal' }); });
    it.each(bad.filter(v => v !== '').map(v => [v]))('device string guards preserve false for %j', async raw => { const f = setup(); expect(await f.api.invoke('deviceLink.forget' as RemoteMethod, [raw])).toBe(false); expect(await f.api.invoke('deviceLink.adopt' as RemoteMethod, ['host', raw])).toBe(false); expect(await f.api.invoke('deviceLink.adopt' as RemoteMethod, [raw, 'token'])).toBe(false); expect(f.ports.forget).not.toHaveBeenCalled(); expect(f.ports.adopt).not.toHaveBeenCalled(); });
    it('absent device link keeps the native empty list/false answers', async () => { const f = setup(); (f.deps as unknown as { localOwner: { deviceLink: unknown } }).localOwner.deviceLink = undefined; expect(await f.api.invoke('deviceLink.hosts' as RemoteMethod, [])).toEqual([]); expect(await f.api.invoke('deviceLink.forget' as RemoteMethod, ['host'])).toBe(false); expect(await f.api.invoke('deviceLink.adopt' as RemoteMethod, ['host', 'token'])).toBe(false); });
    it('device empty strings still reach the original device service', async () => { const f = setup(); await f.api.invoke('deviceLink.adopt' as RemoteMethod, ['', '']); expect(f.ports.adopt).toHaveBeenCalledExactlyOnceWith('', ''); });
    it('workstation listing preserves account-before-role refusal', async () => { const f = setup(); f.ports.hasAccount.mockReturnValue(false); f.ports.role.mockReturnValue('drone'); expect(await f.api.invoke('tynnNetwork.workstations' as RemoteMethod, [])).toEqual({ ok: false, reason: 'this Genie has no Tynn account' }); expect(f.ports.role).not.toHaveBeenCalled(); expect(f.ports.workstations).not.toHaveBeenCalled(); });
    it('drone refuses listing and role changes before Tynn calls', async () => { const f = setup(); f.ports.role.mockReturnValue('drone'); for (const m of ['tynnNetwork.workstations', 'tynnNetwork.setRole']) expect(await f.api.invoke(m as RemoteMethod, [])).toEqual({ ok: false, reason: droneRefusal('drone') }); expect(f.ports.workstations).not.toHaveBeenCalled(); expect(f.ports.setRole).not.toHaveBeenCalled(); });
    it.each([['ws', 'admin', 'code'], [null, 'pilot', 'code'], ['ws', 'pilot', null]])('role guard preserves refusal for %j', async (...args) => { const f = setup(); expect(await f.api.invoke('tynnNetwork.setRole' as RemoteMethod, args)).toEqual({ ok: false, reason: 'not a role change' }); expect(f.ports.setRole).not.toHaveBeenCalled(); expect(f.ports.signedIn).not.toHaveBeenCalled(); });
    it('role change requires sign-in and re-reads the role only on success', async () => { const f = setup(); f.ports.signedIn.mockReturnValue(false); expect(await f.api.invoke('tynnNetwork.setRole' as RemoteMethod, ['ws', 'pilot', 'code'])).toEqual({ ok: false, reason: 'Sign in to Tynn to change a workstation’s role' }); f.ports.signedIn.mockReturnValue(true); await f.api.invoke('tynnNetwork.setRole' as RemoteMethod, ['ws', 'drone', 'code']); expect(f.ports.rereadRole).toHaveBeenCalledTimes(1); });
    it('Tynn role refusal keeps its authenticator marker and does not re-read', async () => { const f = setup(), refusal = { ok: false, reason: 'fixture authenticator required', needsTwoFactor: true }; f.ports.setRole.mockResolvedValue(refusal as never); expect(await f.api.invoke('tynnNetwork.setRole' as RemoteMethod, ['ws', 'pilot', 'code'])).toEqual(refusal); expect(f.ports.rereadRole).not.toHaveBeenCalled(); });
    it.each([null, undefined, 42, {}, []].map(v => [v]))('shares retain native defaults for %j', async raw => { const f = setup(); await f.api.invoke('tynnNetwork.shares.list' as RemoteMethod, [raw]); expect(f.ports.list).toHaveBeenCalledExactlyOnceWith(null); await f.api.invoke('tynnNetwork.shares.mint' as RemoteMethod, [raw]); expect(f.ports.mint).toHaveBeenCalledExactlyOnceWith({ workspaceId: null, capability: 'control', expiresInDays: 7 }); expect(await f.api.invoke('tynnNetwork.shares.revoke' as RemoteMethod, [raw])).toEqual({ ok: false, reason: 'not a link' }); expect(f.ports.revoke).not.toHaveBeenCalled(); });
    it('share native normalization keeps explicit workspace, number and capability', async () => { const f = setup(); await f.api.invoke('tynnNetwork.shares.mint' as RemoteMethod, [{ workspaceId: '', capability: 'other', expiresInDays: 0 }]); expect(f.ports.mint).toHaveBeenCalledExactlyOnceWith({ workspaceId: '', capability: 'control', expiresInDays: 0 }); });
    it('transport and operation exceptions reject moved reads instead of returning success', async () => { const f = setup(); f.ports.hosts.mockRejectedValue(new Error('fixture device unavailable')); const c = await f.client(); const owner = (c as unknown as { localOwner: Owner }).localOwner; expect(owner).toBeDefined(); await expect(owner.deviceLink.hosts()).rejects.toThrow('fixture device unavailable'); });
    it('key persistence exceptions retain the native rejection', async () => { const f = setup(); f.ports.revokeKey.mockRejectedValue(new Error('fixture persistence refused')); const c = await f.client(), owner = (c as unknown as { localOwner: Owner }).localOwner; expect(owner).toBeDefined(); await expect(owner.appInbox.revokeKey('work', 'key_fixture')).rejects.toThrow('fixture persistence refused'); });
    it('plain string guards accept whitespace without trimming workspace ids', async () => { const f = setup(); expect(await f.api.invoke('appInbox.state' as RemoteMethod, [' '])).toEqual({ ok: true, state }); expect(f.ports.state).toHaveBeenCalledExactlyOnceWith(' '); });
});

describe('native paths retired and P5/window boundaries pinned', () => {
    it('the app routes owner operations through its page bridge and keeps connect-link native', () => {
        const app = readFileSync('src/renderer/App.tsx', 'utf8');
        expect(app).not.toContain('window.genie?.appInbox'); expect(app).not.toContain('window.genie?.deviceLink');
        const nativeNetwork = app.split('\n').filter(line => line.includes('window.genie?.tynnNetwork'));
        expect(nativeNetwork).toHaveLength(1); expect(nativeNetwork[0]).toContain('openLink=');
        expect(app).toContain('function ownWindowBridge()'); expect(app).toContain('pageBridge(window.genie)');
        expect(app).toContain('ownWindowBridge()?.appInbox'); expect(app).toContain('ownWindowBridge()?.tynnNetwork?.shares');
        const desktop = app.slice(app.indexOf('function useRemote('), app.indexOf('function useMobileRemote('));
        expect(desktop).toContain('const local = ownWindowBridge()'); expect(desktop).toContain('const link = local?.deviceLink'); expect(desktop).toContain('const net = local?.tynnNetwork');
    });
    it('current device proof reads moved hosts through the page bridge and waits for it', () => {
        const script = readFileSync('scripts/device-link-cdp.mjs', 'utf8');
        expect(script).not.toContain('window.genie.deviceLink.hosts()'); expect(script.match(/window\.genieTest\.deviceLink\.hosts\(\)/g)).toHaveLength(2);
        expect(script).toContain('GENIE_PAGE_PROBE:'); expect(script).toContain('await waitForPageProbe(cdp)');
        // Opening and channel ownership stay on their deferred native path.
        expect(script).toContain('window.genie.deviceLink.open('); expect(script).toContain('window.genie.tynnNetwork');
    });
    it('leaves all five retained native bodies byte-identical apart from line endings', () => {
        const main = readFileSync('src/main/main.ts', 'utf8').replace(/\r\n/g, '\n');
        const hashes = { 'connect-link': '0b9ae3b3eda218ec458bcd0d9b770a714b31301cf031296696221ca672511252', 'relay-open': 'dca6a87c27dd79d32160394c490b63c01f1eb04c1546b27c2dac98d5362794f7', 'device-open': '2751229ddfd8bb2a12b227926d5b620bb794a1416290745538fa5c543045d753', 'relay-send': 'f6d54a0b0ffe0c6aea96a79181e7b0022623ebde512cedfbfb85410279231c95', 'relay-close': '6555bcd95a145d3b60b88bba0061da764f5dec0f0988909f1ad39310a2d1e9c0' };
        for (const [channel, hash] of Object.entries(hashes)) {
            const body = new RegExp(`^    ipcMain\\.(?:handle|on)\\('genie:${channel}'.*?^    \\}\\);`, 'ms').exec(main)?.[0];
            expect(body, channel).toBeDefined(); expect(createHash('sha256').update(body!).digest('hex'), channel).toBe(hash);
        }
    });
    it('removes all twelve native handlers, preload forwards and inventory entries', () => {
        const main = readFileSync('src/main/main.ts', 'utf8'), preload = readFileSync('src/main/preload.ts', 'utf8'), inv = readFileSync('src/core/ipc-inventory.ts', 'utf8');
        for (const channel of ['app-inbox-state', 'app-inbox-create-key', 'app-inbox-revoke-key', 'app-inbox-source', 'device-hosts', 'device-forget', 'device-adopt', 'tynn-workstations', 'tynn-workstation-role', 'tynn-share-links', 'tynn-share-mint', 'tynn-share-revoke']) { expect(main).not.toContain(`ipcMain.handle('genie:${channel}'`); expect(preload).not.toContain(`ipcRenderer.invoke('genie:${channel}'`); expect(inv).not.toContain(`['genie:${channel}',`); }
    });
    it('connect links remain window ports and relay clients remain P5 with exact sender ownership', () => {
        const main = readFileSync('src/main/main.ts', 'utf8'), preload = readFileSync('src/main/preload.ts', 'utf8'), inv = readFileSync('src/core/ipc-inventory.ts', 'utf8');
        expect(inv).toContain("['genie:connect-link', 'window-port']"); expect(main).toContain("ipcMain.handle('genie:connect-link'"); expect(preload).toContain("ipcRenderer.invoke('genie:connect-link'");
        for (const channel of ['relay-open', 'device-open', 'relay-send', 'relay-close']) expect(inv).toContain(`['genie:${channel}', 'later:P5 relay client moves into genie-host']`);
        expect(main).toContain("ipcMain.handle('genie:relay-open', async (event, workstationId: unknown)"); expect(main).toContain("ipcMain.handle('genie:device-open', async (event, url: unknown)");
        expect(main.match(/deviceChannels\.get\(channel\) === event\.sender/g)).toHaveLength(2); expect(main.match(/c\.sender === event\.sender/g)).toHaveLength(3);
        for (const event of ['relay-open-step', 'relay-message', 'relay-closed']) { expect(main).toContain(`'genie:${event}'`); expect(preload).toContain(`'genie:${event}'`); }
        const protocol = readFileSync('src/core/remote-protocol.ts', 'utf8'); for (const event of ['local-relay-step', 'local-relay-message', 'local-relay-closed']) expect(protocol).not.toContain(event);
    });
});
