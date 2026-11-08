import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import type { LocalFramePort } from '../src/core/local-frame.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { SettingsStore } from '../src/main/settings-store.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import { pageBridge, type GenieBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

type Workspaces = GenieBridge['workspaces'];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
let dir: string;
let devices: DeviceStore;
const clients: RemoteClient[] = [];
const closePorts: Array<() => void> = [];

function serve(deps: HostApiDeps) {
    const api = buildHostApi(deps);
    const invoke = vi.spyOn(api, 'invoke');
    let accept!: (connection: ServerConnection) => void;
    new RemoteHost({ api, hostName: 'workspace-host', baton: new Baton(), devices,
        pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: (listener) => { accept = listener; return () => {}; } },
    });
    return { invoke, framePort: (): LocalFramePort => {
        const pair = inMemoryPair();
        closePorts.push(() => pair.client.close());
        const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
        let handle = '';
        pair.client.onMessage((text) => { for (const listener of listeners) listener('frame', handle, text); });
        pair.client.onClose(() => { for (const listener of listeners) listener('closed', handle, ''); });
        return {
            onFrame: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            send: (action, id, text) => {
                if (action === 'open') {
                    handle = id;
                    accept({ ...pair.server, preAuth: { kind: 'local', label: 'page', isOwner: true, workspaceId: null, readonly: false } });
                } else if (action === 'frame') pair.client.send(text);
                else pair.client.close();
            },
        };
    }, connect: async () => {
        const pair = inMemoryPair();
        accept({ ...pair.server, preAuth: { kind: 'local', label: 'window', isOwner: true, workspaceId: null, readonly: false } });
        const client = connectRemote(pair.client, { kind: 'local' }, 'window');
        clients.push(client);
        expect(await client.ready).toEqual({ ok: true });
        return client;
    } };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-p4-workspaces-'));
    let seq = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `workspace-fixture-${++seq}` });
});
afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const close of closePorts.splice(0)) close();
    vi.unstubAllGlobals();
    await tick();
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

// Frozen old preload forwarding contract from1f8638dc, kept after its product lines are removed.
// These functions return invoke's value unchanged, including null and domain refusals.
function oldWorkspacePreload(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>) {
    return {
        listRepos: (id: string) => invoke('genie:workspace-repos', id),
        addRepo: (id: string, input: { name: string; path: string }) => invoke('genie:workspace-repo-add', id, input),
        removeRepo: (id: string, slug: string) => invoke('genie:workspace-repo-remove', id, slug),
        removeRepoLock: (id: string, slug: string) => invoke('genie:workspace-repo-unlock', id, slug),
        locateRepo: (id: string, slug: string, path: string) => invoke('genie:workspace-repo-locate', id, slug, path),
        commitsSince: (id: string, since: number) => invoke('genie:workspace-commits-since', id, since),
        settings: (id: string) => invoke('genie:workspace-settings', id),
        setSetting: (id: string, key: string, value: boolean | string) => invoke('genie:workspace-setting-set', id, key, value),
        resetSetting: (id: string, key: string) => invoke('genie:workspace-setting-reset', id, key),
        setGoverns: (id: string, children: readonly string[]) => invoke('genie:workspace-set-governs', id, [...children]),
        setDefaultAgent: (id: string, agent: string | null) => invoke('genie:workspace-set-default-agent', id, agent),
        setColor: (id: string, color: string) => invoke('genie:workspace-set-color', id, color),
    };
}
type LegacyWorkspaces = ReturnType<typeof oldWorkspacePreload>;
type FamilyCall = { name: keyof LegacyWorkspaces; channel: string; args: unknown[]; result: unknown; call: (ws: LegacyWorkspaces | Workspaces) => Promise<unknown> };
const rows: FamilyCall[] = [
    { name: 'listRepos', channel: 'genie:workspace-repos', args: ['work'], result: { ok: true, repos: [{ name: 'app', path: 'repos/app', branch: null }] }, call: (ws) => ws.listRepos('work') },
    { name: 'addRepo', channel: 'genie:workspace-repo-add', args: ['work', { name: 'docs', path: 'repos/docs' }], result: { ok: true, slug: 'docs' }, call: (ws) => ws.addRepo('work', { name: 'docs', path: 'repos/docs' }) },
    { name: 'removeRepo', channel: 'genie:workspace-repo-remove', args: ['work', 'app'], result: { ok: false, reason: 'the host repo cannot be removed' }, call: (ws) => ws.removeRepo('work', 'app') },
    { name: 'removeRepoLock', channel: 'genie:workspace-repo-unlock', args: ['work', 'docs'], result: { ok: false, reason: 'the lock is still recent' }, call: (ws) => ws.removeRepoLock('work', 'docs') },
    { name: 'locateRepo', channel: 'genie:workspace-repo-locate', args: ['work', 'docs', '/estate/docs'], result: { ok: true, path: '/estate/docs' }, call: (ws) => ws.locateRepo!('work', 'docs', '/estate/docs') },
    { name: 'commitsSince', channel: 'genie:workspace-commits-since', args: ['work', 1700000000123], result: { ok: true, commits: [{ repo: 'app', sha: 'abc123', subject: 'docs', author: 'Fixture', at: 1700000000456 }] }, call: (ws) => ws.commitsSince!('work', 1700000000123) },
    { name: 'settings', channel: 'genie:workspace-settings', args: ['work'], result: { ok: true, values: { workspace_tabs: '{"tabs":[]}' }, overridden: [] }, call: (ws) => ws.settings('work') },
    { name: 'setSetting', channel: 'genie:workspace-setting-set', args: ['work', 'workspace_tabs', '{"tabs":["docs"]}'], result: { ok: true }, call: (ws) => ws.setSetting('work', 'workspace_tabs', '{"tabs":["docs"]}') },
    { name: 'resetSetting', channel: 'genie:workspace-setting-reset', args: ['work', 'workspace_tabs'], result: { ok: true }, call: (ws) => ws.resetSetting('work', 'workspace_tabs') },
    { name: 'setGoverns', channel: 'genie:workspace-set-governs', args: ['work', ['child_b', 'child_a']], result: { ok: true, governs: ['child_b', 'child_a'] }, call: (ws) => ws.setGoverns('work', ['child_b', 'child_a']) },
    { name: 'setDefaultAgent', channel: 'genie:workspace-set-default-agent', args: ['work', null], result: { ok: true, defaultAgent: null }, call: (ws) => ws.setDefaultAgent('work', null) },
    { name: 'setColor', channel: 'genie:workspace-set-color', args: ['work', '#7c3aed'], result: { ok: true }, call: (ws) => ws.setColor!('work', '#7c3aed') },
];

describe('all twelve workspace bridge calls reach the real API with the old preload contract', () => {
    it.each(rows)('$name records method and arguments, preserving a meaningful result', async (row) => {
        const deps = protocolContractDeps(dir);
        const operation = vi.fn(async (..._args: unknown[]) => row.result);
        Object.assign(deps.workspaceOps, { [row.name]: operation });
        const source = serve(deps);
        const client = await source.connect();
        const invoke = vi.fn(async (_channel: string, ..._args: unknown[]) => row.result);
        const legacy = await row.call(oldWorkspacePreload(invoke));
        expect(invoke).toHaveBeenCalledExactlyOnceWith(row.channel, ...row.args);
        expect(await row.call(client.bridge.workspaces)).toEqual(legacy);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(`workspaces.${row.name}`, row.args);
        expect(operation).toHaveBeenCalledExactlyOnceWith(...row.args);
    });
    it.each(rows)('the actual page bridge routes $name over the frame door while unmoved methods keep working', async (row) => {
        const deps = protocolContractDeps(dir);
        const operation = vi.fn(async (..._args: unknown[]) => row.result);
        Object.assign(deps.workspaceOps, { [row.name]: operation });
        const source = serve(deps);
        vi.stubGlobal('window', { genieLocalProtocol: source.framePort() });
        const oldInvoke = vi.fn(async (_channel: string, ..._args: unknown[]) => row.result);
        const snapshot = vi.fn(async () => ({ workspaces: null }));
        const hibernate = vi.fn(async () => ({ ok: false, reason: 'agent still working' }));
        const preload = { snapshot, subscribeAgentWire: () => () => {}, workspaces: { ...oldWorkspacePreload(oldInvoke), tynnBoard: hibernate } } as unknown as PreloadBridge;
        const bridge = pageBridge(preload);
        expect(pageBridge(preload)).toBe(bridge);
        expect(await bridge.snapshot()).toEqual({ workspaces: null });
        expect(await bridge.workspaces.tynnBoard!('work', undefined as never)).toEqual({ ok: false, reason: 'agent still working' });
        expect(snapshot).toHaveBeenCalledTimes(1);
        expect(hibernate).toHaveBeenCalledExactlyOnceWith('work', undefined);
        expect(await row.call(bridge.workspaces)).toEqual(row.result);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(`workspaces.${row.name}`, row.args);
        expect(operation).toHaveBeenCalledExactlyOnceWith(...row.args);
        expect(oldInvoke).not.toHaveBeenCalled();
    });
    it('preserves an actual null API result without manufacturing settings', async () => {
        const deps = protocolContractDeps(dir);
        deps.workspaceOps.settings = vi.fn(() => null);
        const source = serve(deps);
        const client = await source.connect();
        expect(await client.bridge.workspaces.settings('unknown')).toBeNull();
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith('workspaces.settings', ['unknown']);
        expect(deps.workspaceOps.settings).toHaveBeenCalledExactlyOnceWith('unknown');
    });
});

async function settingsSource() {
    const store = await SettingsStore.open(dir);
    const deps = protocolContractDeps(dir);
    deps.workspaceOps.settings = (id) => ({ ok: true, values: store.snapshotFor(id), overridden: Object.keys(store.workspaceValues(id)) });
    const set = async (id: string, key: string, value: unknown) => {
        try { await store.setFor(id, key, value); return { ok: true as const }; }
        catch (error) { return { ok: false as const, reason: error instanceof Error ? error.message : String(error) }; }
    };
    deps.workspaceOps.setSetting = set;
    deps.workspaceOps.resetSetting = async (id, key) => {
        try { await store.resetFor(id, key); return { ok: true as const }; }
        catch (error) { return { ok: false as const, reason: error instanceof Error ? error.message : String(error) }; }
    };
    const listeners = new Set<(id: string) => void>();
    store.onChange((_key, _value, id) => { if (id) for (const listener of listeners) listener(id); });
    Object.assign(deps.workspaceOps, { onSettingsChanged: (listener: (id: string) => void) => {
        listeners.add(listener); return () => { listeners.delete(listener); };
    } });
    return { store, set, listeners, ...serve(deps) };
}

describe('settings validation and live local settings', () => {
    it('preserves the old SettingsStore refusal for null rather than converting it to an accepted empty string', async () => {
        const source = await settingsSource();
        const client = await source.connect();
        const legacy = await source.set('work', 'workspace_tabs', null);
        expect(legacy).toEqual({ ok: false, reason: expect.any(String) });
        // A malformed page input still reaches the store's existing unknown-value validator.
        expect(await client.bridge.workspaces.setSetting('work', 'workspace_tabs', null as never)).toEqual(legacy);
        expect(source.store.workspaceValues('work')).toEqual({});
    });
    it('two windows hot-swap set and reset through the actual store and HostApi event source', async () => {
        const source = await settingsSource();
        const a = await source.connect(); const b = await source.connect();
        expect(a.bridge.workspaces.onSettingsChanged).toBeTypeOf('function');
        expect(b.bridge.workspaces.onSettingsChanged).toBeTypeOf('function');
        const seenA: string[] = []; const seenB: string[] = [];
        const offA = a.bridge.workspaces.onSettingsChanged!((id) => { seenA.push(id); });
        const offB = b.bridge.workspaces.onSettingsChanged!((id) => { seenB.push(id); });
        expect(source.listeners.size).toBe(1);
        expect(await a.bridge.workspaces.setSetting('work', 'workspace_tabs', '{"tabs":["docs"]}')).toEqual({ ok: true });
        await tick();
        expect(seenA).toEqual(['work']); expect(seenB).toEqual(['work']);
        expect(await b.bridge.workspaces.settings('work')).toMatchObject({ ok: true, values: { workspace_tabs: '{"tabs":["docs"]}' }, overridden: ['workspace_tabs'] });
        expect(await b.bridge.workspaces.resetSetting('work', 'workspace_tabs')).toEqual({ ok: true });
        await tick();
        expect(seenA).toEqual(['work', 'work']); expect(seenB).toEqual(['work', 'work']);
        expect(await a.bridge.workspaces.settings('work')).toMatchObject({ ok: true, values: { workspace_tabs: '{"tabs":[]}' }, overridden: [] });
        offB();
        await a.bridge.workspaces.setSetting('other', 'workspace_tabs', '{}'); await tick();
        expect(seenA).toEqual(['work', 'work', 'other']); expect(seenB).toEqual(['work', 'work']);
        offA(); a.close(); b.close(); await tick();
        expect(source.listeners.size).toBe(0);
    });
});
