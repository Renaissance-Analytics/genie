import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import type { LocalFramePort } from '../src/core/local-frame.js';
import { IPC_INVENTORY } from '../src/core/ipc-inventory.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { listHostDir } from '../src/main/host-fs.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import { pageBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * HOST SPLIT P4, FAMILY 10 (Tynn #559): the workspace lifecycle (hibernate, wake, remove) and the host's folders (list,
 * make, home) on the one protocol. The window's six calls went over their own IPC (`genie:workspace-hibernate`, …,
 * `genie:host-home`); they now go through the local door, like families 1-8, and their native handlers and preload lines
 * are gone. What the caller gets is what the IPC path gave: the same answers, the same refusals in the same words.
 */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
let dir: string;
let devices: DeviceStore;
const clients: RemoteClient[] = [];
const closePorts: Array<() => void> = [];

function serve(deps: HostApiDeps) {
    const api = buildHostApi(deps);
    const invoke = vi.spyOn(api, 'invoke');
    let accept!: (connection: ServerConnection) => void;
    new RemoteHost({ api, hostName: 'family10-host', baton: new Baton(), devices,
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
    dir = await mkdtemp(join(tmpdir(), 'genie-p4-family10-'));
    let seq = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `family10-${++seq}` });
});
afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const close of closePorts.splice(0)) close();
    vi.unstubAllGlobals();
    await tick();
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

type Lifecycle = 'hibernate' | 'wake' | 'remove';
const lifecycle: Array<{ name: Lifecycle; result: unknown }> = [
    { name: 'hibernate', result: { ok: true, asleep: true, handoffs: { landed: ['atlas'], missing: [] } } },
    { name: 'wake', result: { ok: false, reason: 'the folder is gone' } },
    { name: 'remove', result: { ok: true } },
];

describe('the workspace lifecycle reaches the API through the local door', () => {
    it.each(lifecycle)('$name: the page bridge sends it over the door with its argument; the answer is the API\'s, untouched; no IPC', async (row) => {
        const deps = protocolContractDeps(dir);
        const operation = vi.fn(async (..._args: unknown[]) => row.result);
        Object.assign(deps.workspaceOps, { [row.name]: operation });
        const source = serve(deps);
        vi.stubGlobal('window', { genieLocalProtocol: source.framePort() });
        const oldInvoke = vi.fn(async () => ({ ok: false, reason: 'the old IPC path was used' }));
        const preload = { snapshot: async () => ({ workspaces: null }), subscribeAgentWire: () => () => {}, workspaces: { hibernate: oldInvoke, wake: oldInvoke, remove: oldInvoke } } as unknown as PreloadBridge;
        const bridge = pageBridge(preload);
        expect(await bridge.workspaces[row.name]('work')).toEqual(row.result);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(`workspaces.${row.name}`, ['work'], expect.anything());
        expect(operation).toHaveBeenCalledExactlyOnceWith('work');
        expect(oldInvoke).not.toHaveBeenCalled();
    });

    it.each(lifecycle)('$name with no workspace named: refused in the IPC path\'s words, the operation never asked', async (row) => {
        const deps = protocolContractDeps(dir);
        const operation = vi.fn(async () => row.result);
        Object.assign(deps.workspaceOps, { [row.name]: operation });
        const client = await serve(deps).connect();
        expect(await (client.bridge.workspaces[row.name] as (id: unknown) => Promise<unknown>)(42)).toEqual({ ok: false, reason: `${row.name} names a workspace` });
        expect(operation).not.toHaveBeenCalled();
    });
});

describe('the host\'s folders reach the API through the local door', () => {
    it('listDir, mkdir and home: the page bridge sends them over the door; the answers are the host\'s; no IPC', async () => {
        const source = serve(protocolContractDeps(dir));
        vi.stubGlobal('window', { genieLocalProtocol: source.framePort() });
        const oldHost = { listDir: vi.fn(), mkdir: vi.fn(), home: vi.fn() };
        const preload = { snapshot: async () => ({ workspaces: null }), subscribeAgentWire: () => () => {}, workspaces: {}, host: oldHost } as unknown as PreloadBridge;
        const bridge = pageBridge(preload);
        await mkdir(join(dir, 'inside'));
        const listing = await bridge.host!.listDir(dir);
        expect(JSON.stringify(listing)).toContain('inside');
        expect(source.invoke).toHaveBeenCalledWith('host.listDir', [dir], expect.anything());
        const made = await bridge.host!.mkdir!(dir, 'made-here');
        expect(made).toMatchObject({ ok: true });
        expect((await stat(join(dir, 'made-here'))).isDirectory()).toBe(true);
        expect(await bridge.host!.home!()).toBe(homedir());
        expect(source.invoke).toHaveBeenCalledWith('host.mkdir', [dir, 'made-here'], expect.anything());
        expect(source.invoke).toHaveBeenCalledWith('host.home', [], expect.anything());
        for (const f of Object.values(oldHost)) expect(f).not.toHaveBeenCalled();
    });

    it('listDir with no path lists the root, and mkdir with no names is refused, as the IPC path did', async () => {
        const client = await serve(protocolContractDeps(dir)).connect();
        const root = await (client.bridge.host!.listDir as (p: unknown) => Promise<unknown>)(undefined);
        expect(root).toEqual(await listHostDir('/'));
        expect(await (client.bridge.host!.mkdir as (a: unknown, b: unknown) => Promise<unknown>)(null, 7)).toEqual({ ok: false, reason: 'name a folder and where to make it' });
    });
});

describe('the IPC path is gone', () => {
    const strip = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    const channels = ['genie:workspace-hibernate', 'genie:workspace-wake', 'genie:workspace-remove', 'genie:host-list-dir', 'genie:host-mkdir', 'genie:host-home'];

    it('no native handler, no preload line, no inventory row for any of the six', async () => {
        const main = strip(await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8'));
        const preload = strip(await readFile(new URL('../src/main/preload.ts', import.meta.url), 'utf8'));
        for (const channel of channels) {
            expect(main, channel).not.toContain(`'${channel}'`);
            expect(preload, channel).not.toContain(`'${channel}'`);
            expect(IPC_INVENTORY.map(([c]) => c), channel).not.toContain(channel);
        }
    });

    it('a hibernate still tells the registry, as the IPC path did (the rail redraws the sleeping workspace)', async () => {
        const main = strip(await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8'));
        expect(main).toMatch(/hibernate: \(id\) => hibernateWorkspace\(workspaceOps, id, \{ handoffWaitMs: 20_000, pollMs: 500 \}\)\.finally\(\(\) => registry\?\.touch\(\)\),/);
    });
});
