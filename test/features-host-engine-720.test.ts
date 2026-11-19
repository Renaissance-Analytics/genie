import type { CallContext } from '../src/core/remote-protocol.js';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { versionDir } from '../src/core/toolchain-defaults.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { FeatureCallers } from '../src/main/feature-callers.js';
import { featureWindow } from '../src/main/feature-window.js';
import { adoptFeatureEnvironment } from '../src/main/feature-native-toolchain.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { localProtocolDoor, type LocalDoorContents } from '../src/main/local-protocol-door.js';
import { LOCAL_FRAME_CHANNELS } from '../src/core/local-frame.js';
import type { IpcMainEvent } from 'electron';
import { groupTwoFixture, groupTwoContext, type GroupTwoFixture } from './helpers/features-host-group2.js';

let f: GroupTwoFixture;
const closers: Array<() => void | Promise<void>> = [];
beforeEach(async () => { f = await groupTwoFixture(); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); await f.close(); });

describe('the production feature route (Tynn #720)', () => {
    it('two engine windows with the same local caller id keep separate state and use only their own effects', async () => {
        const callers = new FeatureCallers(() => f.service);
        Object.assign(f.service.ports, { presentation: callers.presentation.bind(callers) });
        const server = new SessionEngineServer({ token: 'fixture', build: 'fixture', features: callers });
        const connect = async (owner: string) => {
            const view = { url: null as string | null, canGoBack: false, canGoForward: false };
            const effect = vi.fn(async (_id: string, method: string, args: unknown[]) => {
                if (method === 'browser.navigate') view.url = String(args[0]);
                return { value: null, browser: view };
            });
            const client = new SessionEngineClient({ onFeatureEffect: effect });
            const [host, window] = memoryPair(); server.accept(host, { local: true });
            expect(await client.connect(window, 'fixture')).toMatchObject({ ok: true });
            closers.push(() => window.close());
            // The engine route's own calls, as a window that asks it makes them: the method, its args, the admitted context and
            // the window's browser pane. (The window's replica that wrapped them went with main's host API, Tynn #898 2d-4b2.)
            const call = async <T>(method: string, args: unknown[], context?: CallContext): Promise<T> => {
                const result = await client.call('engine.features', [method, args, context, context ? view : null]);
                if (!result.ok) throw new Error(result.reason);
                return result.value as T;
            };
            const replica = {
                snapshot: (context: CallContext) => call<{ knowledge: { query: string } }>('snapshot', [], context),
                act: (action: unknown, context: CallContext) => call<{ browser: { url: string | null } }>('act', [action], context),
                releaseCaller: (context: CallContext) => { void call('releaseCaller', [], context).catch(() => {}); },
            };
            const context = { ...groupTwoContext, origin: 'local-window' as const, connectionId: 'same-local-id', label: owner };
            return { replica, context, effect };
        };
        const a = await connect('A'), b = await connect('B');
        await a.replica.act({ kind: 'knowledge.search', query: 'private A' }, a.context);
        await b.replica.act({ kind: 'knowledge.search', query: 'private B' }, b.context);
        const shown = await a.replica.act({ kind: 'browser.navigate', url: 'https://fixture.gen/' }, a.context);
        expect(shown.browser.url).toBe('https://fixture.gen/');
        expect(a.effect).toHaveBeenCalledExactlyOnceWith('same-local-id', 'browser.navigate', ['https://fixture.gen/']);
        expect(b.effect).not.toHaveBeenCalled();
        expect((await a.replica.snapshot(a.context)).knowledge.query).toBe('private A');
        expect((await b.replica.snapshot(b.context)).knowledge.query).toBe('private B');
        a.replica.releaseCaller?.(a.context);
        expect((await a.replica.snapshot(a.context)).knowledge.query).toBe('');
        expect((await b.replica.snapshot(b.context)).knowledge.query).toBe('private B');
    });

    it('a non-local engine connection cannot enter the feature route', async () => {
        const callers = new FeatureCallers(() => f.service), server = new SessionEngineServer({ token: 'fixture', build: 'fixture', features: callers });
        const [host, window] = memoryPair(); server.accept(host);
        const client = new SessionEngineClient(); closers.push(() => window.close());
        expect(await client.connect(window, 'fixture')).toMatchObject({ ok: true });
        expect(await client.call('engine.features', ['snapshot', [], groupTwoContext, null])).toMatchObject({ ok: false, reason: expect.stringMatching(/own window/) });
    });

    it('a window effect needs the exact live admitted protocol connection, including after navigation', async () => {
        const ipc = new EventEmitter();
        const door = localProtocolDoor(ipc as never); closers.push(() => door.dispose());
        const frame = { send: vi.fn() }, contents = Object.assign(new EventEmitter(), { id: 101, mainFrame: frame, isDestroyed: () => false });
        door.admit(contents as unknown as LocalDoorContents);
        let close!: () => void;
        door.onConnection(connection => {
            connection.onMessage(() => {});
            connection.send(JSON.stringify({ kind: 'welcome', connectionId: 'actual-admitted-id' }));
            close = () => connection.close();
        });
        ipc.emit(LOCAL_FRAME_CHANNELS.toHost, { sender: contents, senderFrame: frame } as unknown as IpcMainEvent, 'open', 'fixture-handle', '');
        const openExternal = vi.fn(async () => {});
        const effect = featureWindow(door, { openExternal }, () => 101);
        await expect(effect('invented-id', 'openExternal', ['https://example.com/'])).rejects.toThrow(/own admitted/);
        expect(openExternal).not.toHaveBeenCalled();
        expect(await effect('actual-admitted-id', 'openExternal', ['https://example.com/'])).toEqual({ value: null, browser: null });
        expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/');
        close();
        expect(door.contentsFor('actual-admitted-id')).toBeNull();
        await expect(effect('actual-admitted-id', 'openExternal', ['https://example.com/'])).rejects.toThrow(/own admitted/);
        expect(openExternal).toHaveBeenCalledTimes(1);
    });

    it('host-selected toolchain defaults survive a stale window environment at the next start', async () => {
        const home = await mkdtemp(join(tmpdir(), 'genie-720-env-')); closers.push(() => rm(home, { recursive: true, force: true }));
        const tc = join(home, 'genie2-toolchain'), version = versionDir(tc, 'node', '22.20.0');
        await mkdir(version, { recursive: true }); await mkdir(join(tc, 'current'), { recursive: true });
        await symlink(version, join(tc, 'current', 'node'), process.platform === 'win32' ? 'junction' : 'dir');
        const target = { PATH: '/old-system-path', GENIE_HOME: 'owned-home', REMOVED: 'old' };
        adoptFeatureEnvironment(home, { PATH: '/new-window-path', FRESH: 'new', GENIE_HOME: 'window-home' }, target, process.platform as 'linux' | 'darwin' | 'win32');
        expect(target.PATH.split(delimiter)[0]).toBe(join(tc, 'current', 'node', ...(process.platform === 'win32' ? [] : ['bin'])));
        expect(target.PATH).toContain('/new-window-path');
        expect(target).toMatchObject({ GENIE_HOME: 'owned-home', FRESH: 'new' });
        expect(target).not.toHaveProperty('REMOVED');
    });
});
