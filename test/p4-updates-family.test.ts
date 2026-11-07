import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { capabilityOf, inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import type { ActivityFeed } from '../src/core/activity-feed.js';
import type { LocalFramePort } from '../src/core/local-frame.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { UpdateHost, type UpdaterPort, type UpdateState } from '../src/main/updater.js';
import { pageBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

// Frozen native forwarding at merged family3, 4deb6b25. Accounts/events are tested separately.
function oldFamily(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>) {
    return {
        updates: {
            state: () => invoke('genie:updates-state'), check: () => invoke('genie:updates-check'),
            download: () => invoke('genie:updates-download'), install: () => invoke('genie:updates-install'),
            notes: () => invoke('genie:updates-notes'),
        },
        activity: { feeds: (id: string) => invoke('genie:activity', id) },
    };
}
type Row = { group: 'updates' | 'activity'; name: string; method: string; channel: string; args: unknown[]; result: unknown };
const available = { phase: 'available', version: '2.0.0-beta.58', percent: null, error: null, checkedAt: 123,
    changelog: { groups: [{ version: '2.0.0-beta.58', notes: 'A fixed release-note fixture.' }], partial: false } } satisfies UpdateState;
const feeds = { agent_a: { agentId: 'agent_a', running: true, since: 100, lastAt: 123,
    plan: { step: 1, of: 2, doing: 'Reviewing the fixture' }, beats: [{ minute: 0, n: 2 }],
    items: [{ id: 'row_1', at: 123, kind: 'reply', text: 'A fixed activity item.', by: null, plus: null, minus: null, status: null }] } } satisfies Record<string, ActivityFeed>;
const rows: Row[] = [
    { group: 'updates', name: 'state', method: 'updates.state', channel: 'genie:updates-state', args: [], result: { phase: 'idle', version: null, percent: null, error: null, checkedAt: null } },
    { group: 'updates', name: 'check', method: 'updates.check', channel: 'genie:updates-check', args: [], result: available },
    { group: 'updates', name: 'download', method: 'updates.download', channel: 'genie:updates-download', args: [], result: true },
    { group: 'updates', name: 'install', method: 'updates.install', channel: 'genie:updates-install', args: [], result: { report: 'No agents were running. No processes were running from the install directory.' } },
    { group: 'updates', name: 'notes', method: 'updates.notes', channel: 'genie:updates-notes', args: [], result: available },
    { group: 'activity', name: 'feeds', method: 'activity', channel: 'genie:activity', args: ['work'], result: feeds },
];
const call = (bridge: object, row: Row) => {
    const group = (bridge as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>)[row.group]!;
    return Reflect.apply(group[row.name]!, group, row.args);
};
let dir: string;
let devices: DeviceStore;
const closes: Array<() => void> = [];
const clients: RemoteClient[] = [];
function operationFor(deps: HostApiDeps, row: Row, result = row.result) {
    // Native state/feed reads are synchronous: returning a Promise would hide a null-to-default conversion.
    const synchronous = row.name === 'state' || row.group === 'activity';
    const operation = vi.fn((..._args: unknown[]) => synchronous ? result : Promise.resolve(result));
    if (row.group === 'updates') {
        deps.updates ??= { state: () => null as never, check: async () => null as never, download: async () => false, install: () => null, onChange: () => () => {} };
        Object.assign(deps.updates, { [row.name]: operation });
    } else deps.activity = { feeds: operation as never, subscribe: () => () => {} };
    return operation;
}
function serve(deps: HostApiDeps) {
    const api = buildHostApi(deps), invoke = vi.spyOn(api, 'invoke');
    let accept!: (connection: ServerConnection) => void;
    const host = new RemoteHost({ api, hostName: 'updates-host', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: (listener) => { accept = listener; return () => {}; } } });
    const pair = inMemoryPair(); closes.push(() => pair.client.close());
    const framePort = (): LocalFramePort => {
        const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
        let handle = '';
        pair.client.onMessage((text) => { for (const listener of listeners) listener('frame', handle, text); });
        pair.client.onClose(() => { for (const listener of listeners) listener('closed', handle, ''); });
        return { onFrame: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, send: (action, id, text) => {
            if (action === 'open') { handle = id; accept({ ...pair.server, preAuth: { kind: 'local', label: 'updates-page', isOwner: true, workspaceId: null, readonly: false } }); }
            else if (action === 'frame') pair.client.send(text);
            else pair.client.close();
        } };
    };
    return { invoke, framePort, connect: async (kind: 'local' | 'owner' | 'guest' = 'local') => {
        const guest = kind === 'guest';
        accept(kind === 'local' ? { ...pair.server, preAuth: { kind: 'local', label: 'updates-window', isOwner: true, workspaceId: null, readonly: false } }
            : guest ? { ...pair.server, preAuth: { kind: 'relay', label: 'guest', isOwner: false, workspaceId: null, readonly: false } } : pair.server);
        const client = connectRemote(pair.client, kind === 'local' ? { kind: 'local' } : guest ? { kind: 'relay' } : { kind: 'pin', code: host.issuePin().code }, 'updates-window');
        clients.push(client); expect(await client.ready).toEqual({ ok: true }); return client;
    } };
}
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-p4-updates-')); let seq = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `updates-fixture-${++seq}` });
});
afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const close of closes.splice(0)) close();
    vi.unstubAllGlobals(); await new Promise<void>((resolve) => setImmediate(resolve));
    await devices.flushed(); await rm(dir, { recursive: true, force: true });
});

describe('family4 update/activity reads and actions', () => {
    it.each(rows)('$method preserves meaningful old values and recorded API/dependency arguments', async (row) => {
        const deps = protocolContractDeps(dir), operation = operationFor(deps, row);
        const source = serve(deps), client = await source.connect();
        const invoke = vi.fn(async (_channel: string, ..._args: unknown[]) => row.result);
        expect(await call(client.bridge, row)).toEqual(await call(oldFamily(invoke), row));
        expect(invoke).toHaveBeenCalledExactlyOnceWith(row.channel, ...row.args);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(row.method, row.args);
        expect(operation).toHaveBeenCalledExactlyOnceWith(...row.args);
    });
    it.each(rows)('pageBridge routes $method through the shared client, preserving stable identity and unmoved calls', async (row) => {
        const deps = protocolContractDeps(dir), operation = operationFor(deps, row), source = serve(deps);
        vi.stubGlobal('window', { genieLocalProtocol: source.framePort() });
        const oldInvoke = vi.fn(async () => row.result), snapshot = vi.fn(async () => ({ agents: [] }));
        const preload = { ...oldFamily(oldInvoke), snapshot, subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge;
        const bridge = pageBridge(preload); expect(pageBridge(preload)).toBe(bridge);
        expect(await call(bridge, row)).toEqual(row.result);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(row.method, row.args);
        expect(operation).toHaveBeenCalledExactlyOnceWith(...row.args); expect(oldInvoke).not.toHaveBeenCalled();
        expect(await bridge.snapshot()).toEqual({ agents: [] }); expect(snapshot).toHaveBeenCalledTimes(1);
    });
    it.each(rows)('$method removes native handler/preload/table rows while snapshot stays native', (row) => {
        const main = readFileSync('src/main/main.ts', 'utf8'), preload = readFileSync('src/main/preload.ts', 'utf8'), inventory = readFileSync('src/core/ipc-inventory.ts', 'utf8');
        expect(main.includes("ipcMain.handle('genie:snapshot'")).toBe(true);
        expect(preload.includes("ipcRenderer.invoke('genie:snapshot'")).toBe(true);
        expect(main.includes(`ipcMain.handle('${row.channel}'`)).toBe(false);
        expect(preload.includes(`ipcRenderer.invoke('${row.channel}'`)).toBe(false);
        expect(inventory.includes(`['${row.channel}',`)).toBe(false);
    });
    it.each(rows)('$method preserves a null result without introducing a default', async (row) => {
        const deps = protocolContractDeps(dir), operation = operationFor(deps, row, null), source = serve(deps), client = await source.connect();
        expect(await call(client.bridge, row)).toBeNull();
        expect(operation).toHaveBeenCalledExactlyOnceWith(...row.args);
    });
    it.each(rows)('$method preserves a thrown failure as a visible page rejection', async (row) => {
        const deps = protocolContractDeps(dir); operationFor(deps, row).mockImplementation(() => { throw new Error('fixture operation unavailable'); });
        const source = serve(deps); vi.stubGlobal('window', { genieLocalProtocol: source.framePort() });
        const bridge = pageBridge({ ...oldFamily(vi.fn(async () => row.result)), subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge);
        await expect(call(bridge, row)).rejects.toThrow('fixture operation unavailable');
    });
    it.each(rows)('$method visibly rejects a missing local connection without falling back to preload', async (row) => {
        vi.stubGlobal('window', {});
        const oldInvoke = vi.fn(async () => row.result);
        const bridge = pageBridge({ ...oldFamily(oldInvoke), subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge);
        await expect(call(bridge, row)).rejects.toThrow('This Genie window has no local protocol connection.');
        expect(bridge.localProtocol?.state()).toMatchObject({ phase: 'failed', reason: 'This Genie window has no local protocol connection.' });
        expect(oldInvoke).not.toHaveBeenCalled();
    });
    it('download preserves the native false refusal, distinct from a null or an invented success', async () => {
        const row = rows.find((row) => row.name === 'download')!, deps = protocolContractDeps(dir), operation = operationFor(deps, row, false);
        const source = serve(deps), client = await source.connect();
        expect(await call(client.bridge, row)).toBe(false); expect(operation).toHaveBeenCalledExactlyOnceWith();
    });
    it.each([undefined, null, false, 12, {}, []].map((raw) => [raw]))('activity preserves the old non-string refusal for %j without calling the feed operation', async (raw) => {
        const row = rows.find((row) => row.group === 'activity')!, deps = protocolContractDeps(dir), operation = operationFor(deps, row);
        const source = serve(deps), client = await source.connect();
        expect(await call(client.bridge, { ...row, args: [raw] })).toEqual({});
        expect(operation).not.toHaveBeenCalled();
    });
    it.each(['updates.state', 'activity'] as const)('%s retains its existing read capability', (method) => {
        expect(capabilityOf(method)).toBe('read');
    });
    it.each(['updates.check', 'updates.download', 'updates.install'] as const)('%s retains upgrade capability and refuses a non-owner before API invocation', async (method) => {
        expect(capabilityOf(method)).toBe('upgrade');
        const row = rows.find((row) => row.method === method)!, deps = protocolContractDeps(dir), operation = operationFor(deps, row);
        const source = serve(deps), guest = await source.connect('guest');
        await expect(call(guest.bridge, row)).rejects.toThrow();
        expect(source.invoke).not.toHaveBeenCalled(); expect(operation).not.toHaveBeenCalled();
    });
    it.each(['updates.check', 'updates.download', 'updates.install'])('%s still permits an owner through its existing upgrade gate', async (method) => {
        const row = rows.find((row) => row.method === method)!, deps = protocolContractDeps(dir), operation = operationFor(deps, row);
        const source = serve(deps), owner = await source.connect('owner');
        expect(await call(owner.bridge, row)).toEqual(row.result);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(method, []); expect(operation).toHaveBeenCalledTimes(1);
    });
});

describe('update CDP callers use the actual cached page bridge', () => {
    it('the current-build update script retires the preload path and waits for the page bridge', () => {
        const source = readFileSync('scripts/update-cdp.mjs', 'utf8');
        expect(source).toContain('window.genieTest.updates');
        expect(source).toContain('waitForPageProbe');
        expect(/window\.genie\.updates\b/.test(source)).toBe(false);
    });
    it('only the actual extracted beta56 read keeps that historical binary interface (coordinator5189)', () => {
        const source = readFileSync('scripts/upgrade-acceptance-cdp.mjs', 'utf8').replace(/\r\n/g, '\n');
        const oldRead = "const version = await before.evaluate('window.genie.updates?.state?.().then((s) => s?.currentVersion ?? s?.version ?? null).catch(() => null)');";
        // #1524 (the Windows runs) builds the URL from RELEASE and picks the root per OS; the Linux read is the same AppImage.
        expect(source).toContain("const RELEASE = 'https://github.com/Renaissance-Analytics/genie/releases/download/v2.0.0-beta.56';");
        expect(source).toContain('`${RELEASE}/Genie-2.0.0-beta.56.AppImage`');
        expect(source).toContain("execFileSync(image, ['--appimage-extract']");
        expect(source).toContain("root = join(work, 'squashfs-root');");
        expect(source).toContain("const before = await launch(binaryIn(root), []);\n    " + oldRead);
        expect(/window\.genie\.updates\b/.test(source.replace(oldRead, ''))).toBe(false);
    });
});

describe('the local protocol does not bypass the existing update state/explicit-action gates', () => {
    function updater(overrides: Partial<UpdaterPort> = {}) {
        const quitAndInstall = vi.fn(), processes = vi.fn(() => []), kill = vi.fn(() => true), deferred: Array<() => void> = [];
        const port: UpdaterPort = { configure: () => {}, check: async () => ({ version: '2.0.0-beta.58' }), download: async () => {}, quitAndInstall, ...overrides };
        const host = new UpdateHost({ port, installDir: dir, ownPid: 1, processes, kill, clock: () => 123, caseInsensitive: false, defer: (fn) => { deferred.push(fn); } });
        const deps = protocolContractDeps(dir);
        deps.updates = { state: () => host.state(), check: () => host.check(), download: () => host.download(),
            install: () => { const pending = host.install(); return pending ? pending.then((result) => ({ report: result.report })) : null; }, onChange: (listener) => host.onChange(listener) };
        return { host, source: serve(deps), quitAndInstall, processes, kill, deferred };
    }
    it.each(['idle', 'checking', 'none', 'available', 'downloading', 'installing', 'error'] as const)('install is refused in the %s phase without another drain or application', async (phase) => {
        let releaseCheck!: (result: null) => void, releaseDownload!: () => void;
        const f = updater(phase === 'checking' ? { check: () => new Promise((resolve) => { releaseCheck = resolve; }) }
            : phase === 'none' ? { check: async () => null }
                : phase === 'error' ? { check: async () => { throw new Error('fixture feed unavailable'); } }
                    : phase === 'downloading' ? { download: () => new Promise<void>((resolve) => { releaseDownload = resolve; }) } : {});
        let held: Promise<unknown> | undefined;
        if (phase === 'checking') held = f.host.check();
        else if (phase !== 'idle') {
            await f.host.check();
            if (phase === 'downloading') held = f.host.download();
            if (phase === 'installing') { await f.host.download(); await f.host.install(); }
        }
        expect(f.host.state().phase).toBe(phase);
        const scanned = f.processes.mock.calls.length, deferred = f.deferred.length, client = await f.source.connect();
        expect(await client.bridge.updates.install()).toBeNull();
        expect(f.processes).toHaveBeenCalledTimes(scanned); expect(f.deferred).toHaveLength(deferred); expect(f.kill).not.toHaveBeenCalled(); expect(f.quitAndInstall).not.toHaveBeenCalled();
        releaseCheck?.(null); releaseDownload?.(); await held;
    });
    it('install before a download is refused both idle and after a check, without process/installer side effects', async () => {
        const f = updater(), client = await f.source.connect();
        expect(await client.bridge.updates.install()).toBeNull();
        await client.bridge.updates.check(); expect(await client.bridge.updates.install()).toBeNull();
        expect(f.processes).not.toHaveBeenCalled(); expect(f.kill).not.toHaveBeenCalled(); expect(f.quitAndInstall).not.toHaveBeenCalled(); expect(f.deferred).toEqual([]);
    });
    it('state/check/download do not apply anything; explicit install preserves report, phase and deferred single application', async () => {
        const f = updater(), client = await f.source.connect();
        await client.bridge.updates.state(); await client.bridge.updates.check(); expect(await client.bridge.updates.download()).toBe(true);
        expect(f.host.state().phase).toBe('downloaded'); expect(f.processes).not.toHaveBeenCalled(); expect(f.deferred).toEqual([]);
        expect(await client.bridge.updates.install()).toEqual({ report: 'No processes were running from the install directory.' });
        expect(f.host.state().phase).toBe('installing'); expect(f.processes).toHaveBeenCalledTimes(1); expect(f.quitAndInstall).not.toHaveBeenCalled();
        expect(await client.bridge.updates.install()).toBeNull(); expect(f.deferred).toHaveLength(1);
        f.deferred[0]!(); expect(f.quitAndInstall).toHaveBeenCalledTimes(1); expect(f.kill).not.toHaveBeenCalled();
    });
});
