import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallContext, RemoteMethod } from '../src/core/remote-protocol.js';
import { hostAloneApi, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import type { HostApi } from '../src/main/remote-host.js';
import { Registry } from '../src/main/registry.js';
import { SettingsStore } from '../src/main/settings-store.js';
import { Store } from '../src/main/store.js';

// Tynn #666 moves only this set and its settings signal. Other families keep their window fallback.
const rows: Array<{ method: RemoteMethod; args: unknown[] }> = [
    { method: 'workspaces.settings', args: ['work'] },
    { method: 'workspaces.setSetting', args: ['work', 'app_inbox', false] },
    { method: 'workspaces.resetSetting', args: ['work', 'app_inbox'] },
    { method: 'workspaces.listRepos', args: ['work'] },
    { method: 'workspaces.commitsSince', args: ['work', 0] },
];
const SETTINGS_EVENT = 'workspace-settings-changed';
type Listener = (channel: string, payload: unknown) => void;
const context: CallContext = { connectionId: 'fixture-connection', origin: 'relay', profile: 'desktop',
    isOwner: true, workspaceId: null, readonly: false, label: 'fixture owner' };
const listeners: Array<() => void> = [];
let dir: string, workspace: string, registry: Registry, settings: SettingsStore;

function gate(alone: HostApi | (() => HostApi | null)) {
    let windows = 0;
    const invokeWindow = vi.fn(async (method: RemoteMethod) => ({ windowAnswered: method }));
    const windowListeners = new Set<Listener>();
    const api = hostRemoteApi({ hostName: 'fixture-host', own: {}, alone,
        window: { connected: () => windows > 0, invoke: invokeWindow },
        onEvent: listener => { windowListeners.add(listener); return () => { windowListeners.delete(listener); }; },
    });
    return { api, invokeWindow, windows: (count: number) => { windows = count; },
        emitWindow: (channel: string, payload: unknown) => { for (const listener of windowListeners) listener(channel, payload); },
        windowListeners,
    };
}

function hostEvents() {
    const subscribers = new Set<Listener>();
    const api: HostApi = { invoke: vi.fn(async () => null), workspaceOfAgent: () => null,
        onEvent: listener => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    };
    return { api, subscribers, emit: (channel: string, payload: unknown) => { for (const listener of subscribers) listener(channel, payload); } };
}

function ownedApi(): HostApi {
    const engine = { probe: () => null, subscribe: () => () => {}, ledgerFor: () => [], rowsFor: () => [],
        turnsFor: () => 0, recentStderrFor: () => [], refusals: new Map(), needsNewDriver: () => false, notice: () => true } as unknown as HostAloneEngine;
    return hostAloneApi({
        hostName: 'fixture-host', registry, settings, engine: () => engine, cwdFor: () => workspace,
        startRefusal: () => null, models: { get: async () => ({ models: [] }) }, providerInstalled: () => true,
        windowConnected: () => false,
        terminals: { attach: () => null, write: () => true, resize: () => true, close: () => true,
            list: () => [], onData: () => () => {}, onExit: () => () => {} },
        takeOver: () => null, headroom: { view: () => ({}), subscribe: () => () => {} },
        attention: { finished: () => [], answer: async () => true, lists: { done: async () => true } },
        approvals: { resolve: () => true }, inbox: { unread: () => [], receive: async () => [], involving: () => [] },
        deliverToAgent: async () => true,
        files: { children: async () => null, open: async () => ({ ok: false }),
            readBytes: async () => ({ ok: false }), upload: async () => ({ ok: false }) },
    } as unknown as HostAlonePorts);
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-workspace-settings-666-'));
    workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'project.json'), JSON.stringify({ name: 'fixture', type: 'agi', repos: [] }));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'fixture-host', healthy: true });
    await registry.addWorkspace({ id: 'work', path: workspace });
    settings = await SettingsStore.open(dir);
});
afterEach(async () => {
    for (const off of listeners.splice(0)) off();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
});

describe('five workspace methods have one host answer', () => {
    it.each(rows)('$method stays on the host with zero, one or multiple windows', async ({ method, args }) => {
        const answer = { hostAnswered: method }, invoke = vi.fn(async () => answer);
        const source = gate({ invoke, onEvent: () => () => {}, workspaceOfAgent: () => null });
        for (const count of [0, 1, 2, 0]) {
            source.windows(count); invoke.mockClear();
            expect(await source.api.invoke(method, args, context)).toEqual(answer);
            expect(invoke).toHaveBeenCalledExactlyOnceWith(method, args, context);
            expect(source.invokeWindow).not.toHaveBeenCalled();
        }
    });

    it('an unavailable owned service refuses clearly instead of falling back to a window', async () => {
        const source = gate(() => null); source.windows(1);
        await expect(source.api.invoke('workspaces.settings', ['work'], context)).rejects.toThrow(/still starting/);
        expect(source.invokeWindow).not.toHaveBeenCalled();
    });

    it('the real host settings store persists set/read/reset while a window is connected', async () => {
        const source = gate(ownedApi()); source.windows(1);
        expect(await source.api.invoke('workspaces.setSetting', ['work', 'app_inbox', false], context)).toEqual({ ok: true });
        expect(await source.api.invoke('workspaces.settings', ['work'], context)).toMatchObject({
            ok: true, values: { app_inbox: false }, overridden: ['app_inbox'],
        });
        expect((await SettingsStore.open(dir)).workspaceValues('work')).toEqual({ app_inbox: false });
        expect(await source.api.invoke('workspaces.resetSetting', ['work', 'app_inbox'], context)).toEqual({ ok: true });
        expect((await SettingsStore.open(dir)).workspaceValues('work')).toEqual({});
        expect(source.invokeWindow).not.toHaveBeenCalled();
    });

    it('a real invalid-setting refusal keeps its reason and writes nothing with a window connected', async () => {
        const source = gate(ownedApi()); source.windows(1);
        expect(await source.api.invoke('workspaces.setSetting', ['work', 'not_a_setting', true], context)).toEqual({
            ok: false, reason: 'not_a_setting is not a setting Genie knows',
        });
        expect(settings.workspaceValues('work')).toEqual({});
        expect(source.invokeWindow).not.toHaveBeenCalled();
    });

    it('CONTROL: an unrelated family still uses the window and its existing no-window fallback', async () => {
        const invoke = vi.fn(async () => 'host fallback');
        const source = gate({ invoke, onEvent: () => () => {}, workspaceOfAgent: () => null });
        for (const method of ['workspaces.tynnBoard', 'workspaces.hibernate', 'agents.models', 'features.act'] as const) {
            invoke.mockClear(); source.invokeWindow.mockClear(); source.windows(1);
            expect(await source.api.invoke(method, [], context)).toEqual({ windowAnswered: method });
            expect(invoke).not.toHaveBeenCalled();
            source.windows(0);
            expect(await source.api.invoke(method, [], context)).toBe('host fallback');
            expect(invoke).toHaveBeenCalledExactlyOnceWith(method, [], context);
        }
    });
});

describe('one host-owned workspace settings signal', () => {
    it('the real host API signals a workspace set and reset from the owned store', async () => {
        const heard = vi.fn(), off = ownedApi().onEvent(heard); listeners.push(off);
        await settings.setFor('work', 'app_inbox', false);
        await settings.resetFor('work', 'app_inbox');
        expect(heard.mock.calls.filter(([channel]) => channel === SETTINGS_EVENT)).toEqual([
            [SETTINGS_EVENT, 'work'], [SETTINGS_EVENT, 'work'],
        ]);
        off(); heard.mockClear();
        await settings.setFor('work', 'app_inbox', false);
        expect(heard.mock.calls.filter(([channel]) => channel === SETTINGS_EVENT)).toEqual([]);
    });

    it('CONTROL: a workstation-wide setting is not a workspace settings signal', async () => {
        const heard = vi.fn(); listeners.push(ownedApi().onEvent(heard));
        await settings.set('theme', 'light');
        expect(heard.mock.calls.filter(([channel]) => channel === SETTINGS_EVENT)).toEqual([]);
    });

    it('host settings signals survive window attach, replacement and detach exactly once', () => {
        const events = hostEvents(), source = gate(events.api), heard = vi.fn();
        listeners.push(source.api.onEvent(heard));
        for (const count of [0, 1, 2, 0]) {
            source.windows(count); heard.mockClear();
            events.emit(SETTINGS_EVENT, 'work');
            expect(heard.mock.calls).toEqual([[SETTINGS_EVENT, 'work']]);
        }
    });

    it('a window echo is suppressed; the same signal from the host is delivered', () => {
        const events = hostEvents(), source = gate(events.api), heard = vi.fn(); source.windows(1);
        listeners.push(source.api.onEvent(heard));
        source.emitWindow(SETTINGS_EVENT, 'work'); expect(heard).not.toHaveBeenCalled();
        events.emit(SETTINGS_EVENT, 'work');
        expect(heard.mock.calls).toEqual([[SETTINGS_EVENT, 'work']]);
    });

    it('CONTROL: unrelated events keep their current connected-window and host-fallback sources', () => {
        const events = hostEvents(), source = gate(events.api), heard = vi.fn(); source.windows(1);
        listeners.push(source.api.onEvent(heard));
        events.emit('activity', { source: 'host while connected' }); expect(heard).not.toHaveBeenCalled();
        source.emitWindow('activity', { source: 'window' });
        source.windows(0); events.emit('activity', { source: 'host fallback' });
        expect(heard.mock.calls).toEqual([
            ['activity', { source: 'window' }], ['activity', { source: 'host fallback' }],
        ]);
    });

    it('CONTROL: unsubscribe releases both sources and prevents later delivery', () => {
        const events = hostEvents(), source = gate(events.api), heard = vi.fn();
        const off = source.api.onEvent(heard); listeners.push(off);
        expect(events.subscribers.size).toBe(1); expect(source.windowListeners.size).toBe(1);
        off(); source.windows(1);
        events.emit(SETTINGS_EVENT, 'work'); source.emitWindow(SETTINGS_EVENT, 'work');
        expect(events.subscribers.size).toBe(0); expect(source.windowListeners.size).toBe(0);
        expect(heard).not.toHaveBeenCalled();
    });
});
