import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import type { LocalFramePort } from '../src/core/local-frame.js';
import { IPC_INVENTORY } from '../src/core/ipc-inventory.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import { pageBridge, type GenieBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * HOST SPLIT P4, FAMILY 12 (Tynn #561): the Tynn tab on the one protocol. Its 13 bridge handlers went over their own IPC —
 * the board, its changes and actions, the pages and their actions, the issues, their changes and actions, and following
 * the board, the issues and the Features page. They now go through the local door; following is BY SUBSCRIPTION: a view's
 * watch is the connection's, released with it, and a window hears only the workspaces it watches.
 */
type Kind = 'board' | 'issues' | 'features';
type TynnWatch = { watch(kind: Kind, viewId: string, workspaceId: string): Promise<boolean>; unwatch(kind: Kind, viewId: string): void; subscribe(listener: (e: { kind: Kind; workspaceId: string; signal: unknown }) => void): () => void };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };
let dir: string;
let devices: DeviceStore;
const clients: RemoteClient[] = [];
const closePorts: Array<() => void> = [];

/** A host-side Tynn watch port, recording what it was asked and letting a test emit live signals. */
function tynnPort() {
    const listeners = new Set<(e: { kind: Kind; workspaceId: string; signal: unknown }) => void>();
    const watched = new Map<string, { kind: Kind; workspaceId: string }>();
    const port: TynnWatch = {
        watch: vi.fn(async (kind: Kind, viewId: string, workspaceId: string) => { watched.set(viewId, { kind, workspaceId }); return true; }),
        unwatch: vi.fn((_kind: Kind, viewId: string) => { watched.delete(viewId); }),
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    return { port, watched, emit: (kind: Kind, workspaceId: string, signal: unknown) => { for (const l of listeners) l({ kind, workspaceId, signal }); } };
}

function serve(deps: HostApiDeps) {
    const api = buildHostApi(deps);
    const invoke = vi.spyOn(api, 'invoke');
    let accept!: (connection: ServerConnection) => void;
    new RemoteHost({ api, hostName: 'family12-host', baton: new Baton(), devices,
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
    }, connect: async (local = true) => {
        const pair = inMemoryPair();
        let frames = 0;
        pair.client.onMessage(() => { frames += 1; });
        accept({ ...pair.server, ...(local ? { preAuth: { kind: 'local', label: 'window', isOwner: true, workspaceId: null, readonly: false } } : { remoteAddress: 'relay:x', preAuth: { label: 'pat', isOwner: true, workspaceId: null, readonly: false } }) });
        const client = connectRemote(pair.client, local ? { kind: 'local' } : { kind: 'relay' }, 'window');
        clients.push(client);
        expect(await client.ready).toEqual({ ok: true });
        return Object.assign(client, { frames: () => frames });
    } };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-p4-family12-'));
    let seq = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `family12-${++seq}` });
});
afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const close of closePorts.splice(0)) close();
    vi.unstubAllGlobals();
    await tick();
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

type Ws = GenieBridge['workspaces'];
const rows: Array<{ name: string; method: string; args: unknown[]; result: unknown; call: (ws: Ws) => Promise<unknown> }> = [
    { name: 'tynnBoard', method: 'workspaces.tynnBoard', args: ['work', { mine: true }], result: { ok: true, state: 'live', columns: [] }, call: (ws) => ws.tynnBoard!('work', { mine: true } as never) },
    { name: 'tynnBoardAction', method: 'workspaces.tynnBoardAction', args: ['work', { action: 'move', ids: { story: 's1' } }], result: { ok: true }, call: (ws) => ws.tynnBoardAction!('work', { action: 'move', ids: { story: 's1' } } as never) },
    { name: 'tynnPage', method: 'workspaces.tynnPage', args: ['work', 'wip', { q: 'a' }], result: { ok: true, page: 'wip', view: {} }, call: (ws) => ws.tynnPage!('work', 'wip' as never, { q: 'a' } as never) },
    { name: 'tynnPageAction', method: 'workspaces.tynnPageAction', args: ['work', { action: 'save' }], result: { ok: false, state: 'error', reason: 'Tynn said no' }, call: (ws) => ws.tynnPageAction!('work', { action: 'save' } as never) },
    { name: 'tynnBoardChanges', method: 'workspaces.tynnBoardChanges', args: ['work', {}, 'c1', ['s1']], result: { ok: true, cursor: 'c2', changed: [] }, call: (ws) => ws.tynnBoardChanges!('work', {} as never, 'c1', ['s1']) },
    { name: 'tynnIssues', method: 'workspaces.tynnIssues', args: ['work', { status: 'open' }], result: { ok: true, view: { issues: [] } }, call: (ws) => ws.tynnIssues!('work', { status: 'open' } as never) },
    { name: 'tynnIssueAction', method: 'workspaces.tynnIssueAction', args: ['work', { action: 'close', issueId: 'i1' }], result: { ok: true }, call: (ws) => ws.tynnIssueAction!('work', { action: 'close', issueId: 'i1' } as never) },
    { name: 'tynnIssueChanges', method: 'workspaces.tynnIssueChanges', args: ['work', {}, 'c1', []], result: { ok: true, cursor: 'c3', changed: [] }, call: (ws) => ws.tynnIssueChanges!('work', {} as never, 'c1', []) },
];

describe('the Tynn tab\'s reads and actions reach the API through the local door', () => {
    it.each(rows)('$name: the page bridge sends it over the door with its arguments; the API\'s answer, untouched; no IPC', async (row) => {
        const deps = protocolContractDeps(dir);
        const operation = vi.fn(async (..._args: unknown[]) => row.result);
        Object.assign(deps.workspaceOps, { [row.name]: operation });
        const source = serve(deps);
        vi.stubGlobal('window', { genieLocalProtocol: source.framePort() });
        const old = vi.fn(async () => ({ ok: false, reason: 'the old IPC path was used' }));
        const preload = { snapshot: async () => ({ workspaces: null }), subscribeAgentWire: () => () => {}, workspaces: Object.fromEntries(rows.map((r) => [r.name, old])) } as unknown as PreloadBridge;
        const bridge = pageBridge(preload);
        expect(await row.call(bridge.workspaces)).toEqual(row.result);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(row.method, row.args);
        expect(operation).toHaveBeenCalledExactlyOnceWith(...row.args);
        expect(old).not.toHaveBeenCalled();
    });

    it('a changes read with no workspace or cursor is refused in the IPC path\'s words', async () => {
        const deps = protocolContractDeps(dir);
        const operation = vi.fn(async () => ({ ok: true }));
        Object.assign(deps.workspaceOps, { tynnBoardChanges: operation, tynnIssueChanges: operation });
        const client = await serve(deps).connect();
        const refusal = { ok: false, state: 'error', reason: 'name a workspace and a cursor' };
        expect(await (client.bridge.workspaces.tynnBoardChanges as (...a: unknown[]) => Promise<unknown>)('work', {}, 7, [])).toEqual(refusal);
        expect(await (client.bridge.workspaces.tynnIssueChanges as (...a: unknown[]) => Promise<unknown>)(null, {}, 'c', [])).toEqual(refusal);
        expect(operation).not.toHaveBeenCalled();
    });
});

describe('following the board, the issues and Features: by subscription, the connection\'s own', () => {
    it.each(['board', 'issues', 'features'] as const)('%s: a window hears the workspace it watches, nothing else; another window hears nothing; unwatch releases it', async (kind) => {
        const tynn = tynnPort();
        const deps = Object.assign(protocolContractDeps(dir), { tynnWatch: tynn.port });
        const source = serve(deps);
        const a = await source.connect();
        const b = await source.connect();
        const watch = { board: 'tynnBoardWatch', issues: 'tynnIssuesWatch', features: 'tynnFeaturesWatch' }[kind] as 'tynnBoardWatch';
        const heard: unknown[] = [];
        const stop = a.bridge.workspaces[watch]!('work', (signal) => heard.push(signal));
        await settle();
        expect(tynn.port.watch).toHaveBeenCalledTimes(1);
        expect([...tynn.watched.values()]).toEqual([{ kind, workspaceId: 'work' }]);
        const bBefore = b.frames();
        tynn.emit(kind, 'work', { ring: 1 });
        tynn.emit(kind, 'other', { ring: 2 });
        tynn.emit(kind === 'board' ? 'issues' : 'board', 'work', { ring: 3 });
        await settle();
        expect(heard).toEqual([{ ring: 1 }]);
        // The other window watches nothing: not a frame was sent to it.
        expect(b.frames()).toBe(bBefore);
        stop();
        await settle();
        expect(tynn.port.unwatch).toHaveBeenCalledTimes(1);
        expect(tynn.watched.size).toBe(0);
        tynn.emit(kind, 'work', { ring: 4 });
        await settle();
        expect(heard).toEqual([{ ring: 1 }]);
    });

    it('a window that closes releases its watches', async () => {
        const tynn = tynnPort();
        const source = serve(Object.assign(protocolContractDeps(dir), { tynnWatch: tynn.port }));
        const a = await source.connect();
        a.bridge.workspaces.tynnBoardWatch!('work', () => {});
        a.bridge.workspaces.tynnFeaturesWatch!('work', () => {});
        await settle();
        expect(tynn.watched.size).toBe(2);
        a.close();
        await settle();
        expect(tynn.watched.size).toBe(0);
    });

    it('CONTROL: a remote connection may not watch (the live tab is this machine\'s window\'s)', async () => {
        const tynn = tynnPort();
        const source = serve(Object.assign(protocolContractDeps(dir), { tynnWatch: tynn.port }));
        const r = await source.connect(false);
        expect(r.bridge.workspaces.tynnBoardWatch).toBeUndefined();
        expect(tynn.port.watch).not.toHaveBeenCalled();
    });
});

describe('the IPC path is gone', () => {
    const strip = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    const channels = ['board', 'board-changes', 'board-watch', 'board-unwatch', 'board-action', 'page', 'page-action', 'issues', 'issue-action', 'issues-changes', 'issues-watch', 'issues-unwatch', 'features-watch', 'features-unwatch'].map((s) => `genie:workspace-tynn-${s}`);

    it('no native handler, no preload line, no inventory row; no broadcast of a live signal to every window', async () => {
        const main = strip(await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8'));
        const preload = strip(await readFile(new URL('../src/main/preload.ts', import.meta.url), 'utf8'));
        for (const channel of channels) {
            expect(main, channel).not.toContain(`'${channel}'`);
            expect(preload, channel).not.toContain(`'${channel}'`);
            expect(IPC_INVENTORY.map(([c]) => c), channel).not.toContain(channel);
        }
        expect(main).not.toMatch(/broadcast\('genie:workspace-tynn-(board|issues|features)-live'/);
        expect(preload).not.toContain('genie:workspace-tynn-');
    });
});
