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

/** genie-host's remote API over its own answers: no window relays events into it (Tynn #898 step 2d-4b2). */
function gate(alone: HostApi | (() => HostApi | null)) {
    return { api: hostRemoteApi({ hostName: 'fixture-host', own: {}, alone }) };
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
    it.each(rows)('$method is answered by the host', async ({ method, args }) => {
        const answer = { hostAnswered: method }, invoke = vi.fn(async () => answer);
        const source = gate({ invoke, onEvent: () => () => {}, workspaceOfAgent: () => null });
        expect(await source.api.invoke(method, args, context)).toEqual(answer);
        expect(invoke).toHaveBeenCalledExactlyOnceWith(method, args, context);
    });

    it('an unavailable owned service refuses clearly instead of falling back to a window', async () => {
        const source = gate(() => null);
        await expect(source.api.invoke('workspaces.settings', ['work'], context)).rejects.toThrow(/still starting/);
    });

    it('the real host settings store persists set/read/reset', async () => {
        const source = gate(ownedApi());
        expect(await source.api.invoke('workspaces.setSetting', ['work', 'app_inbox', false], context)).toEqual({ ok: true });
        expect(await source.api.invoke('workspaces.settings', ['work'], context)).toMatchObject({
            ok: true, values: { app_inbox: false }, overridden: ['app_inbox'],
        });
        expect((await SettingsStore.open(dir)).workspaceValues('work')).toEqual({ app_inbox: false });
        expect(await source.api.invoke('workspaces.resetSetting', ['work', 'app_inbox'], context)).toEqual({ ok: true });
        expect((await SettingsStore.open(dir)).workspaceValues('work')).toEqual({});
    });

    it('a real invalid-setting refusal keeps its reason and writes nothing', async () => {
        const source = gate(ownedApi());
        expect(await source.api.invoke('workspaces.setSetting', ['work', 'not_a_setting', true], context)).toEqual({
            ok: false, reason: 'not_a_setting is not a setting Genie knows',
        });
        expect(settings.workspaceValues('work')).toEqual({});
    });

    it('CONTROL: genie-host\'s other families are its own too (Tynn #898), host.home included (step 2d-2b)', async () => {
        const invoke = vi.fn(async () => 'host answer');
        const source = gate({ invoke, onEvent: () => () => {}, workspaceOfAgent: () => null });
        for (const method of ['workspaces.tynnBoard', 'workspaces.hibernate', 'agents.models', 'features.act', 'host.home'] as const) {
            invoke.mockClear();
            expect(await source.api.invoke(method, [], context)).toBe('host answer');
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

    it('host settings signals are delivered exactly once', () => {
        const events = hostEvents(), source = gate(events.api), heard = vi.fn();
        listeners.push(source.api.onEvent(heard));
        events.emit(SETTINGS_EVENT, 'work');
        expect(heard.mock.calls).toEqual([[SETTINGS_EVENT, 'work']]);
    });

    it('CONTROL: other events come from genie-host, with a window connected or not (Tynn #898)', () => {
        const events = hostEvents(), source = gate(events.api), heard = vi.fn();
        listeners.push(source.api.onEvent(heard));
        events.emit('activity', { source: 'host while connected' });
        events.emit('activity', { source: 'host with no window' });
        expect(heard.mock.calls).toEqual([
            ['activity', { source: 'host while connected' }], ['activity', { source: 'host with no window' }],
        ]);
    });

    it('CONTROL: unsubscribe releases genie-host\'s source and prevents later delivery', () => {
        const events = hostEvents(), source = gate(events.api), heard = vi.fn();
        const off = source.api.onEvent(heard); listeners.push(off);
        expect(events.subscribers.size).toBe(1);
        off();
        events.emit(SETTINGS_EVENT, 'work');
        expect(events.subscribers.size).toBe(0);
        expect(heard).not.toHaveBeenCalled();
    });
});
