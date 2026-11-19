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

/* The engine server's engine.features route is retired (Tynn #898 step 2e-2, #914): every client reaches the features over
 * the one protocol, and a tunnelled connection's effects are held by split-2d4b-window-tunnel. What stays here is the
 * window's own effect gate and the toolchain defaults. */
describe('the window\'s feature effects and the toolchain defaults (Tynn #720)', () => {
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
