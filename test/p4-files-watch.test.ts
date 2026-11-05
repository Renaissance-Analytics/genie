import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTROL_METHODS, type WireMessage } from '../src/core/remote-protocol.js';
import { pageBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { localWatchDoor, watchTick as tick } from './support/local-watch-door.js';
import { resultValue } from './support/local-resource-door.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const controls = ['files.watch', 'files.unwatch', 'files.watchState'] as const;
const events = (frames: WireMessage[]) => frames.filter(frame => frame.kind === 'event' && frame.channel === 'local-files');

describe('7D connection controls and native watch retirement', () => {
    it.each(controls)('%s is recognized as a connection control', method => { expect(CONTROL_METHODS).toContain(method); });
    it.each(['tailnet', 'relay owner', 'workspace guest', 'host guest', 'readonly relay', 'phone'])('%s is refused before a watch or cached read', async kind => {
        const f = await localWatchDoor(cleanups);
        const raw = kind === 'tailnet' || kind === 'phone' ? await f.raw('tailnet', kind === 'phone') : await f.raw({ kind: 'relay', label: kind, isOwner: kind === 'relay owner' || kind === 'readonly relay', readonly: kind === 'readonly relay', workspaceId: kind === 'workspace guest' ? 'work' : null });
        for (const method of controls) expect(await raw.call(method, ['view', 'work', {}])).toMatchObject({ kind: 'result', ok: false, reason: expect.stringContaining('own Genie window') });
        expect(f.watch).not.toHaveBeenCalled(); expect(f.unwatch).not.toHaveBeenCalled(); expect(f.git).not.toHaveBeenCalled();
    });
    it('uses the old string guards and want normalization and preserves boolean answers', async () => {
        const f = await localWatchDoor(cleanups), raw = await f.raw();
        expect(resultValue(await raw.call('files.watch', ['view', 'work', { git: 1, repos: ['repos/a', 4, null, ''] }]))).toBe(true);
        expect(f.watch).toHaveBeenCalledWith(expect.any(String), 'work', { repos: ['repos/a', ''] });
        for (const args of [[null, 'work', {}], ['v', null, {}], [4, 'work', {}], ['v', 'missing', {}]]) expect(resultValue(await raw.call('files.watch', args))).toBe(false);
        expect(resultValue(await raw.call('files.unwatch', [null]))).toBe(false);
        expect(resultValue(await raw.call('files.unwatch', ['unknown']))).toBe(true);
        expect(resultValue(await raw.call('files.unwatch', ['view']))).toBe(true);
        expect(f.watchers[0]!.closed).toBe(true);
    });
    it('returns null before a held view has a computed snapshot and refuses an unowned view', async () => {
        const f = await localWatchDoor(cleanups), raw = await f.raw();
        expect(resultValue(await raw.call('files.watch', ['view', 'work', {}]))).toBe(true);
        expect(await f.readState(raw, 'view')).toBeNull();
        expect(await raw.call('files.watchState', ['unknown'])).toMatchObject({ kind: 'result', ok: false, reason: expect.any(String) });
        expect(f.git).not.toHaveBeenCalled();
    });
    it('retires the two handlers, their ownership body, preload calls/listeners and inventory rows together', () => {
        const main = readFileSync('src/main/main.ts', 'utf8'), preload = readFileSync('src/main/preload.ts', 'utf8'), inventory = readFileSync('src/core/ipc-inventory.ts', 'utf8');
        for (const name of ['files-watch', 'files-unwatch']) { expect(main).not.toContain(`ipcMain.handle('genie:${name}'`); expect(preload).not.toContain(`ipcRenderer.invoke('genie:${name}'`); expect(inventory).not.toContain(`['genie:${name}',`); }
        for (const name of ['files-changed', 'files-git']) { expect(main).not.toContain(`broadcast('genie:${name}'`); expect(preload).not.toContain(`ipcRenderer.on('genie:${name}'`); }
        expect(main).not.toContain('filesViewsBySender'); expect(main).not.toContain('dropFilesViewsOf');
        for (const name of ['files-open-external', 'files-reveal', 'files-export', 'files-popout']) expect(main).toContain(`ipcMain.handle('genie:${name}'`);
    });
});

describe('7D owned views preserve the existing hub batching and git counts', () => {
    it('zero views do no work; one and then two views share one watcher and one git run per batch', async () => {
        const f = await localWatchDoor(cleanups), raw = await f.raw();
        expect(f.watchers).toEqual([]); expect(f.git).toHaveBeenCalledTimes(0);
        expect(resultValue(await raw.call('files.watch', ['a', 'work', { git: true, repos: ['repos/a'] }]))).toBe(true);
        await f.emit(['a.txt']); expect(f.git).toHaveBeenCalledTimes(1); expect(f.repo).toHaveBeenCalledTimes(1);
        expect(resultValue(await raw.call('files.watch', ['b', 'work', { git: true, repos: ['repos/a'] }]))).toBe(true);
        await f.emit(['b.txt', 'c.txt']); expect(f.watchers).toHaveLength(1); expect(f.git).toHaveBeenCalledTimes(2); expect(f.repo).toHaveBeenCalledTimes(2);
        const before = f.git.mock.calls.length;
        expect(await f.readState(raw, 'a')).toMatchObject({ event: { paths: ['b.txt', 'c.txt'], git: { tree: f.data.tree } } });
        expect(await f.readState(raw, 'b')).toMatchObject({ event: { paths: ['b.txt', 'c.txt'] } });
        expect(f.git).toHaveBeenCalledTimes(before); expect(f.repo).toHaveBeenCalledTimes(2);
        await raw.call('files.unwatch', ['a']); expect(f.watchers[0]!.closed).toBe(false);
        await raw.call('files.unwatch', ['b']); expect(f.watchers[0]!.closed).toBe(true);
        expect(await raw.call('files.watchState', ['b'])).toMatchObject({ kind: 'result', ok: false });
        await raw.call('files.watch', ['new', 'work', {}]); expect(await f.readState(raw, 'new')).toBeNull();
    });
    it('two connections with the same view id cannot read or unwatch one another; an idle connection hears no files', async () => {
        const f = await localWatchDoor(cleanups), a = await f.raw(), b = await f.raw(), idle = await f.raw(), remote = await f.raw('tailnet');
        await a.call('files.watch', ['same', 'work', {}]); await b.call('files.watch', ['same', 'work', {}]);
        expect(f.watch.mock.calls[0]![0]).not.toBe(f.watch.mock.calls[1]![0]);
        await f.emit(['a.txt']); expect(events(a.frames)).toHaveLength(1); expect(events(b.frames)).toHaveLength(1); expect(events(idle.frames)).toEqual([]); expect(events(remote.frames)).toEqual([]);
        await a.call('files.unwatch', ['same']); await f.emit(['b.txt']);
        expect(events(a.frames)).toHaveLength(1); expect(events(b.frames)).toHaveLength(2); expect(f.watchers[0]!.closed).toBe(false);
        expect(await a.call('files.watchState', ['same'])).toMatchObject({ kind: 'result', ok: false });
        expect(await f.readState(b, 'same')).toMatchObject({ event: { paths: ['b.txt'] } });
        b.transport.close(); await tick(); expect(f.watchers[0]!.closed).toBe(true);
    });
    it('switching one view to another workspace releases the old watcher and snapshot', async () => {
        const f = await localWatchDoor(cleanups), raw = await f.raw();
        await raw.call('files.watch', ['view', 'work', {}]); await f.emit(['old.txt']);
        await raw.call('files.watch', ['view', 'other', {}]); expect(f.watchers[0]!.closed).toBe(true);
        expect(await f.readState(raw, 'view')).toBeNull(); await f.emit(['new.txt'], 'other');
        expect(await f.readState(raw, 'view')).toMatchObject({ event: { paths: ['new.txt'] } });
    });
    it.each(['unwatch', 'disconnect'])('a pending registration is released after %s, including its late completion', async end => {
        const f = await localWatchDoor(cleanups), raw = await f.raw(); let finish!: () => void;
        f.holdRegistration(() => new Promise<void>(resolve => { finish = resolve; }));
        const pending = raw.call('files.watch', ['view', 'work', {}]); await tick(); expect(f.watch).toHaveBeenCalledTimes(1);
        if (end === 'unwatch') await raw.call('files.unwatch', ['view']); else raw.transport.close();
        finish(); await tick(); await tick(); if (end === 'unwatch') expect(resultValue(await pending)).toBe(false);
        expect(f.hub.watching()).toEqual([]); expect(f.watchers.every(w => w.closed)).toBe(true);
    });
    it('a registration exception is visible and leaves no held view', async () => {
        const f = await localWatchDoor(cleanups), client = await f.client(); f.watch.mockRejectedValueOnce(new Error('watch unavailable'));
        const off = client.bridge.files.subscribe!('work', {}, () => {}); await tick();
        expect(client.state().lastRefusal).toContain('watch unavailable'); expect(f.hub.watching()).toEqual([]); off();
    });
});

describe('7D same-client subscriptions and bounded cached refetch', () => {
    it('records each view registration and cleanup and preserves native changed/git and onChange callbacks', async () => {
        const f = await localWatchDoor(cleanups), client = await f.client(), a = vi.fn(), b = vi.fn(), changed = vi.fn();
        const offChanges = client.bridge.files.onChange(changed), offA = client.bridge.files.subscribe!('work', { git: true }, a), offB = client.bridge.files.subscribe!('work', {}, b); await tick();
        await f.emit(['a.txt', 'b.txt']);
        expect(a.mock.calls).toEqual([[{ paths: ['a.txt', 'b.txt'] }], [{ git: { tree: f.data.tree } }]]);
        expect(b.mock.calls[0]).toEqual([{ paths: ['a.txt', 'b.txt'] }]); expect(changed).toHaveBeenCalledExactlyOnceWith('work', ['a.txt', 'b.txt']);
        const calls = f.calls.filter(c => c.method === 'files.watch'); expect(calls).toHaveLength(2); expect(calls[0]!.args).toEqual([expect.any(String), 'work', { git: true }]); expect(calls[1]!.args).toEqual([expect.any(String), 'work', {}]);
        expect(calls[0]!.args[0]).not.toBe(calls[1]!.args[0]);
        offA(); offA(); await tick(); expect(f.hub.watching()).toEqual(['work']);
        offB(); offChanges(); await tick(); expect(f.hub.watching()).toEqual([]);
        expect(f.calls.filter(c => c.method === 'files.unwatch').map(c => c.args)).toEqual([[calls[0]!.args[0]], [calls[1]!.args[0]]]);
        expect(f.invoke).not.toHaveBeenCalled();
    });
    it('a UTF-8 oversized changed batch sends one refetch for two views, reassembles every path, and never closes', async () => {
        const f = await localWatchDoor(cleanups), client = await f.client(), a = vi.fn(), b = vi.fn(), changed = vi.fn();
        client.bridge.files.onChange(changed); client.bridge.files.subscribe!('work', {}, a); client.bridge.files.subscribe!('work', {}, b); await tick();
        const paths = Array.from({ length: 6000 }, (_, i) => `dir/${i}-${'雪'.repeat(40)}.txt`); expect(Buffer.byteLength(JSON.stringify(paths))).toBeGreaterThan(512 * 1024);
        await f.emit(paths); await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(1));
        expect(a).toHaveBeenCalledWith({ paths }); expect(b).toHaveBeenCalledExactlyOnceWith({ paths }); expect(changed).toHaveBeenCalledExactlyOnceWith('work', paths);
        const pushed = f.serialized.map(text => JSON.parse(text) as WireMessage).filter(frame => frame.kind === 'event' && frame.channel === 'local-files');
        expect(pushed).toHaveLength(1); expect(pushed[0]).toMatchObject({ payload: { workspaceId: 'work', changed: 'refetch' } });
        expect(f.calls.filter(c => c.method === 'files.watchState')).toHaveLength(1); expect(f.calls.some(c => c.method === 'page.open' && c.args[0] === 'workspace-tree')).toBe(true);
        expect(client.state().connected).toBe(true); expect(Math.max(...f.serialized.map(text => Buffer.byteLength(text)))).toBeLessThanOrEqual(1024 * 1024); expect(f.git).not.toHaveBeenCalled();
    });
    it('oversized git uses the cached workspace projection and does not run git on refetch', async () => {
        const f = await localWatchDoor(cleanups), client = await f.client(), seen = vi.fn();
        f.data.tree = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`${i}-${'雪'.repeat(100)}.txt`, 'untracked' as const]));
        client.bridge.files.subscribe!('work', { git: true }, seen); await tick(); await f.emit(['a.txt']);
        await vi.waitFor(() => expect(seen.mock.calls.some(([value]) => value.git)).toBe(true));
        expect(seen.mock.calls.findLast(([value]) => value.git)![0].git.tree).toEqual(f.data.tree);
        expect(f.git).toHaveBeenCalledTimes(1); expect(f.calls.filter(c => c.method === 'files.watchState')).toHaveLength(1);
        const pushed = f.serialized.map(text => JSON.parse(text) as WireMessage).filter(frame => frame.kind === 'event' && frame.channel === 'local-files');
        expect(pushed).toHaveLength(2); expect(pushed[1]).toMatchObject({ payload: { changed: 'refetch' } }); expect(client.state().connected).toBe(true);
    });
    it('a delayed older refetch cannot overwrite a newer normal snapshot', async () => {
        const f = await localWatchDoor(cleanups), client = await f.client(), seen = vi.fn();
        let unblock!: () => void, started!: () => void; const blocked = new Promise<void>(resolve => { unblock = resolve; }), reading = new Promise<void>(resolve => { started = resolve; });
        const original = client.pages!.readAll.bind(client.pages!);
        vi.spyOn(client.pages!, 'readAll').mockImplementationOnce(async (...args) => { started(); await blocked; return original(...args); });
        client.bridge.files.subscribe!('work', { git: true }, seen); await tick();
        f.data.tree = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`${i}-${'雪'.repeat(100)}.txt`, 'deleted' as const]));
        await f.emit(['old.txt']); await reading;
        f.data.tree = { 'new.txt': 'added' }; await f.emit(['new.txt']); unblock(); await tick();
        await vi.waitFor(() => expect(seen.mock.calls.findLast(([value]) => value.git)?.[0].git.tree).toEqual({ 'new.txt': 'added' }));
        const trees = seen.mock.calls.filter(([value]) => value.git).map(([value]) => value.git.tree);
        expect(trees.every(tree => Object.keys(tree).length === 1 && tree['new.txt'] === 'added')).toBe(true); expect(f.git).toHaveBeenCalledTimes(2);
    });
    it('the cached pageBridge recovers live watches and keeps onChange listen-only', async () => {
        const f = await localWatchDoor(cleanups), transport = f.port(); let handle = '';
        vi.stubGlobal('window', { genieLocalProtocol: { ...transport, send: (action: 'open' | 'frame' | 'close', id: string, text: string) => { if (action === 'open') handle = id; transport.send(action, id, text); } } });
        const native = vi.fn(), preload = { subscribeAgentWire: () => () => {}, workspaces: {}, files: { subscribe: native, onChange: native } } as unknown as PreloadBridge;
        const bridge = pageBridge(preload), seen = vi.fn(), changed = vi.fn();
        bridge.files.onChange(changed); const off = bridge.files.subscribe!('work', {}, seen);
        await vi.waitFor(() => expect(bridge.localProtocol!.state().phase).toBe('ready')); await tick();
        expect(f.calls.filter(c => c.method === 'files.watch')).toHaveLength(1); await f.emit(['before.txt']); expect(seen).toHaveBeenCalledExactlyOnceWith({ paths: ['before.txt'] });
        transport.send('close', handle, ''); await tick(); await tick(); expect(f.hub.watching()).toEqual([]);
        bridge.localProtocol!.retry(); await vi.waitFor(() => expect(bridge.localProtocol!.state().phase).toBe('ready')); await tick();
        expect(pageBridge(preload)).toBe(bridge); await f.emit(['after.txt']); expect(seen).toHaveBeenLastCalledWith({ paths: ['after.txt'] }); expect(changed).toHaveBeenCalledTimes(2);
        expect(f.calls.filter(c => c.method === 'files.watch')).toHaveLength(2); off(); await tick(); expect(f.hub.watching()).toEqual([]); expect(native).not.toHaveBeenCalled();
    });
});
