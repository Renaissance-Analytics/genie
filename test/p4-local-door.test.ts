import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_FRAME_CHANNELS, LOCAL_FRAME_LIMIT_BYTES, type LocalFramePort, type LocalFrameReply } from '../src/core/local-frame.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import * as protocol from '../src/core/remote-protocol.js';
import { localProtocolDoor, type LocalDoorContents } from '../src/main/local-protocol-door.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import { localTransport } from '../src/renderer/local-transport.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
class FakeFrame {
    readonly sent: Array<{ channel: string; action: LocalFrameReply; connection: string; text: string }> = [];
    readonly listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
    send(channel: string, action: LocalFrameReply, connection: string, text: string) {
        this.sent.push({ channel, action, connection, text });
        queueMicrotask(() => { for (const listener of this.listeners) listener(action, connection, text); });
    }
}
let nextContents = 0;
class FakeContents extends EventEmitter {
    readonly id = ++nextContents;
    mainFrame = new FakeFrame();
    destroyed = false;
    isDestroyed() { return this.destroyed; }
    asPort() { return this as unknown as LocalDoorContents; }
    destroy() { this.destroyed = true; this.emit('destroyed'); }
}

let ipc: EventEmitter;
let door: ReturnType<typeof localProtocolDoor>;
let host: RemoteHost;
let baton: Baton;
let dir: string;
let devices: DeviceStore;
let invoke: ReturnType<typeof vi.fn<HostApi['invoke']>>;
let eventListeners: Set<(channel: string, payload: unknown) => void>;
const clients: RemoteClient[] = [];

function port(contents: FakeContents, frame = contents.mainFrame): LocalFramePort {
    return {
        send: (action, connection, text) => {
            queueMicrotask(() => ipc.emit(LOCAL_FRAME_CHANNELS.toHost, { sender: contents, senderFrame: frame } as unknown as IpcMainEvent, action, connection, text));
        },
        onFrame: (listener) => { frame.listeners.add(listener); return () => { frame.listeners.delete(listener); }; },
    };
}

function open(contents: FakeContents, frame = contents.mainFrame) {
    const transport = localTransport(port(contents, frame));
    const client = connectRemote(transport, { kind: 'local' } as unknown as protocol.AuthRequest, 'this window');
    clients.push(client);
    const frames = () => frame.sent.filter((f) => f.action === 'frame').map((f) => JSON.parse(f.text) as protocol.WireMessage);
    return { client, transport, frames, frame };
}

async function connected(contents: FakeContents) {
    const opened = open(contents);
    await settled();
    expect(opened.client.state().connected).toBe(true);
    expect(await opened.client.ready).toEqual({ ok: true });
    return opened;
}

beforeEach(async () => {
    ipc = new EventEmitter();
    door = localProtocolDoor(ipc);
    dir = await mkdtemp(join(tmpdir(), 'genie-p4-local-door-'));
    let tokenSeq = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `door-fixture-${++tokenSeq}` });
    baton = new Baton();
    eventListeners = new Set();
    invoke = vi.fn(async () => ({ seen: true }));
    host = new RemoteHost({
        api: {
            invoke,
            onEvent: (listener) => { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; },
            workspaceOfAgent: () => 'work',
        },
        hostName: 'door-contract-host', baton, devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: door,
    });
});

afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await settled();
    door.dispose();
    vi.restoreAllMocks();
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

describe('the P4 door admits only explicitly registered main-preload windows and their top-level frame', () => {
    it.each(['main', 'remote', 'take-over', 'files', 'flow'])('%s can connect without a credential', async () => {
        const contents = new FakeContents();
        door.admit(contents.asPort());
        const { client, frames } = await connected(contents);
        expect(client.state()).toMatchObject({ isOwner: true, workspaceId: null, token: null });
        expect(frames().find((f) => f.kind === 'welcome')).not.toHaveProperty('token');
        expect(devices.list()).toEqual([]);
        expect(host.connections()).toHaveLength(1);
        expect(eventListeners.size).toBe(1);
    });

    it.each(['doctor', 'question', 'browser', 'webview', 'unregistered window'])('%s is refused by main, with a reason', async () => {
        const contents = new FakeContents();
        const opened = open(contents);
        await settled();
        expect(opened.frames()).toContainEqual({ kind: 'refused', reason: expect.stringMatching(/window|preload|admit/i) });
        expect(await opened.client.ready).toMatchObject({ ok: false, reason: expect.any(String) });
        expect(host.connections()).toEqual([]);
        expect(eventListeners.size).toBe(0);
    });

    it('a subframe is refused while the same window top-level frame is a positive control', async () => {
        const contents = new FakeContents();
        door.admit(contents.asPort());
        const child = open(contents, new FakeFrame());
        await settled();
        expect(child.frames()).toContainEqual({ kind: 'refused', reason: expect.stringMatching(/top.level|main frame/i) });
        expect(await child.client.ready).toMatchObject({ ok: false });
        await connected(contents);
        expect(host.connections()).toHaveLength(1);
    });

    it('the real door is the positive control for a local-capability call, with exact method, arguments and null result', async () => {
        const contents = new FakeContents();
        door.admit(contents.asPort());
        const opened = await connected(contents);
        vi.spyOn(protocol, 'capabilityOf').mockReturnValue('local' as protocol.RemoteCapability);
        invoke.mockResolvedValue(null);
        expect(await opened.client.bridge.workspaces.settings('work')).toBeNull();
        expect(invoke).toHaveBeenCalledExactlyOnceWith('workspaces.settings', ['work']);
        expect(opened.frames()).toContainEqual({ kind: 'result', id: expect.any(Number), ok: true, value: null });
    });

    it('a second hello on a live door connection is refused without creating another connection', async () => {
        const contents = new FakeContents();
        door.admit(contents.asPort());
        const opened = await connected(contents);
        opened.transport.send(JSON.stringify({ kind: 'hello', auth: { kind: 'local' } }));
        await settled();
        expect(opened.client.state().lastRefusal).toMatch(/already|hello/i);
        expect(host.connections()).toHaveLength(1);
    });
});

describe('door connection ownership and cleanup', () => {
    it('opening again replaces the live connection and releases its baton and subscriptions', async () => {
        const contents = new FakeContents();
        door.admit(contents.asPort());
        const first = await connected(contents);
        expect(await first.client.takeBaton()).toEqual({ ok: true });
        expect(baton.holder()).not.toBeNull();
        const second = await connected(contents);
        expect(first.client.state().connected).toBe(false);
        expect(second.client.state().connected).toBe(true);
        expect(host.connections()).toHaveLength(1);
        expect(eventListeners.size).toBe(1);
        expect(baton.holder()).toBeNull();
        first.transport.send(JSON.stringify({ kind: 'call', id: 99, method: 'workspaces.settings', args: ['work'] }));
        await settled();
        expect(invoke).not.toHaveBeenCalled();
    });

    it.each(['reload', 'destroy', 'renderer gone', 'client close', 'door disposal'])('%s releases the connection, baton and API listener', async (how) => {
        const contents = new FakeContents();
        door.admit(contents.asPort());
        const opened = await connected(contents);
        await opened.client.takeBaton();
        expect(baton.holder()).not.toBeNull();
        if (how === 'reload') contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
        if (how === 'destroy') contents.destroy();
        if (how === 'renderer gone') contents.emit('render-process-gone');
        if (how === 'client close') opened.client.close();
        if (how === 'door disposal') door.dispose();
        await settled();
        expect(host.connections()).toEqual([]);
        expect(baton.holder()).toBeNull();
        expect(eventListeners.size).toBe(0);
        expect(opened.client.state().connected).toBe(false);
    });

    it('same-document and subframe navigation retain the connection; reload permits a new top-level frame', async () => {
        const contents = new FakeContents();
        door.admit(contents.asPort());
        door.admit(contents.asPort());
        const first = await connected(contents);
        contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
        contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
        await settled();
        expect(first.client.state().connected).toBe(true);
        expect(contents.listenerCount('destroyed')).toBe(1);
        contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
        contents.mainFrame = new FakeFrame();
        const second = await connected(contents);
        expect(first.client.state().connected).toBe(false);
        expect(second.client.state().connected).toBe(true);
        expect(host.connections()).toHaveLength(1);
    });

    it('closing one window keeps the other window and its subscriptions alive', async () => {
        const a = new FakeContents();
        const b = new FakeContents();
        door.admit(a.asPort()); door.admit(b.asPort());
        await connected(a);
        const live = await connected(b);
        a.destroy();
        await settled();
        expect(host.connections()).toHaveLength(1);
        expect(eventListeners.size).toBe(1);
        const snapshots: unknown[] = [];
        live.client.bridge.subscribe((snapshot) => snapshots.push(snapshot));
        for (const listener of eventListeners) listener('snapshot', { workspaces: null });
        await settled();
        expect(snapshots).toEqual([{ workspaces: null }]);
    });

    it('old connection frames and close messages leave a replacement connection alive', async () => {
        const contents = new FakeContents();
        door.admit(contents.asPort());
        await connected(contents);
        const oldId = contents.mainFrame.sent.find((f) => f.action === 'frame')!.connection;
        const replacement = await connected(contents);
        port(contents).send('frame', oldId, JSON.stringify({ kind: 'call', id: 99, method: 'workspaces.settings', args: ['work'] }));
        port(contents).send('close', oldId, '');
        await settled();
        expect(invoke).not.toHaveBeenCalled();
        expect(replacement.client.state().connected).toBe(true);
        expect(host.connections()).toHaveLength(1);
    });

    it('an in-flight result from before reload never reaches the new frame or connection', async () => {
        const contents = new FakeContents();
        door.admit(contents.asPort());
        const first = await connected(contents);
        let finish: (value: unknown) => void = () => {};
        invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        first.transport.send(JSON.stringify({ kind: 'call', id: 700, method: 'workspaces.settings', args: ['work'] }));
        await settled();
        expect(invoke).toHaveBeenCalledOnce();
        contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
        contents.mainFrame = new FakeFrame();
        const second = await connected(contents);
        finish({ old: true });
        await settled();
        expect(second.frames().some((f) => f.kind === 'result' && f.id === 700)).toBe(false);
        expect(first.frames().some((f) => f.kind === 'result' && f.id === 700)).toBe(false);
        expect(second.client.state().connected).toBe(true);
    });

    it('client close notifies once and unsubscribes the frame listener', async () => {
        const contents = new FakeContents();
        door.admit(contents.asPort());
        const opened = await connected(contents);
        let closed = 0;
        opened.transport.onClose(() => { closed++; });
        opened.client.close();
        opened.client.close();
        await settled();
        expect(closed).toBe(1);
        expect(contents.mainFrame.listeners.size).toBe(0);
    });
});

function exactFrame(shell: { kind: string; id: number; method?: string; args?: unknown[]; ok?: boolean; value?: string }, bytes: number): string {
    const empty = JSON.stringify(shell);
    const spare = bytes - Buffer.byteLength(empty);
    const text = 'é'.repeat(Math.floor(spare / 2)) + (spare % 2 ? 'x' : '');
    return JSON.stringify(shell.kind === 'call' ? { ...shell, args: [text] } : { ...shell, value: text });
}

describe('the local door retains a 1 MiB UTF-8 protocol frame cap in both directions', () => {
    it('accepts only string port arguments, with a visible refusal and cleanup', async () => {
        const contents = new FakeContents();
        door.admit(contents.asPort());
        const opened = await connected(contents);
        const id = contents.mainFrame.sent.find((f) => f.action === 'frame')!.connection;
        ipc.emit(LOCAL_FRAME_CHANNELS.toHost, { sender: contents, senderFrame: contents.mainFrame }, 'frame', id, { not: 'text' });
        await settled();
        expect(invoke).not.toHaveBeenCalled();
        expect(opened.frames()).toContainEqual({ kind: 'refused', reason: expect.stringMatching(/string|text/i) });
        expect(host.connections()).toEqual([]);
        expect(eventListeners.size).toBe(0);
    });

    it.each([0, 1])('inbound cap + %s bytes: forwards only the frame within the cap', async (extra) => {
        const contents = new FakeContents();
        door.admit(contents.asPort());
        const opened = await connected(contents);
        const text = exactFrame({ kind: 'call', id: 71, method: 'workspaces.settings', args: [''] }, LOCAL_FRAME_LIMIT_BYTES + extra);
        expect(Buffer.byteLength(text)).toBe(1024 * 1024 + extra);
        opened.transport.send(text);
        await settled();
        if (extra === 0) {
            expect(invoke).toHaveBeenCalledOnce();
            expect(opened.frames()).toContainEqual({ kind: 'result', id: 71, ok: true, value: { seen: true } });
        } else {
            expect(invoke).not.toHaveBeenCalled();
            expect(opened.frames()).toContainEqual({ kind: 'refused', reason: expect.stringContaining('1 MiB') });
            expect(opened.client.state().connected).toBe(false);
            expect(host.connections()).toEqual([]);
        }
    });

    it.each([0, 1])('outbound cap + %s bytes: sends only the result within the cap', async (extra) => {
        const contents = new FakeContents();
        door.admit(contents.asPort());
        const opened = await connected(contents);
        const text = exactFrame({ kind: 'result', id: 72, ok: true, value: '' }, LOCAL_FRAME_LIMIT_BYTES + extra);
        expect(Buffer.byteLength(text)).toBe(1024 * 1024 + extra);
        invoke.mockResolvedValue((JSON.parse(text) as { value: string }).value);
        opened.transport.send(JSON.stringify({ kind: 'call', id: 72, method: 'workspaces.settings', args: ['work'] }));
        await settled();
        expect(invoke).toHaveBeenCalledOnce();
        if (extra === 0) expect(opened.frame.sent.some((f) => f.text === text)).toBe(true);
        else {
            expect(opened.frame.sent.some((f) => f.text === text)).toBe(false);
            expect(opened.frames()).toContainEqual({ kind: 'refused', reason: expect.stringContaining('1 MiB') });
            expect(host.connections()).toEqual([]);
            expect(eventListeners.size).toBe(0);
        }
    });
});

describe('the preload and main wiring', () => {
    const read = (name: string) => readFileSync(new URL(`../src/main/${name}`, import.meta.url), 'utf8');
    it('only the main preload exposes the string frame port', () => {
        expect(read('preload.ts')).toContain("contextBridge.exposeInMainWorld('genieLocalProtocol'");
        for (const name of ['doctor-preload.ts', 'question-preload.ts', 'browser-preload.ts']) expect(read(name)).not.toContain('genieLocalProtocol');
    });
    it.each(['createWindow', 'openTakeOverWindow', 'openFilesWindow', 'openFlowEditorWindow'])('%s admits its window before loading the renderer', (name) => {
        const body = read('main.ts').match(new RegExp(`function ${name}\\b[\\s\\S]*?void win.loadFile`))?.[0];
        expect(body).toContain('localDoor.admit(win.webContents)');
    });
});
