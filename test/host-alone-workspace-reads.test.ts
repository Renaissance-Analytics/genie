import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostAloneApi, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import type { HostApi } from '../src/main/remote-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/*
 * A WORKSPACE'S SETTINGS AND REPOSITORIES WITH EVERY WINDOW CLOSED (Tynn #553, host split P5d.5d). genie-host reads and writes
 * them from what it owns: the settings store, the workspace's folder. A Pilot's Settings and repo chips answer as a window's
 * would. With a window connected the window answers, as it always has.
 */

let dir = '';
let workspace = '';
let bare = '';
let registry: Registry;

/** The settings store's shape, kept in memory, as the real one behaves per workspace. */
function settings() {
    const own = new Map<string, Record<string, unknown>>();
    return {
        snapshotFor: (id: string) => ({ theme: 'dark', ...own.get(id) }),
        workspaceValues: (id: string) => ({ ...own.get(id) }),
        setFor: async (id: string, key: string, value: unknown) => {
            if (key === 'not_a_setting') throw new Error('no setting not_a_setting');
            own.set(id, { ...own.get(id), [key]: value });
        },
        resetFor: async (id: string, key: string) => { const next = { ...own.get(id) }; delete next[key]; own.set(id, next); },
    };
}

function ports(over: Record<string, unknown> = {}): HostAlonePorts {
    const engine = { probe: () => null, subscribe: () => () => {}, ledgerFor: () => [], rowsFor: () => [], turnsFor: () => 0, recentStderrFor: () => [], refusals: new Map(), needsNewDriver: () => false, notice: () => true } as unknown as HostAloneEngine;
    return {
        hostName: 'alphar', registry, engine: () => engine, cwdFor: () => workspace, startRefusal: () => null,
        models: { get: async () => ({ models: [] }) }, providerInstalled: () => true, windowConnected: () => false,
        terminals: { attach: () => null, write: () => true, resize: () => true, close: () => true, list: () => [], onData: () => () => {}, onExit: () => () => {} },
        takeOver: () => null,
        headroom: { view: () => ({}), subscribe: () => () => {} },
        attention: { finished: () => [], markSeen: () => {}, answer: async () => true, lists: { done: async () => true } },
        approvals: { resolve: () => true }, inbox: { unread: () => [], receive: async () => [], involving: () => [] }, deliverToAgent: async () => true,
        files: { children: async () => null, open: async () => ({ ok: false }), readBytes: async () => ({ ok: false }), upload: async () => ({ ok: false }) },
        settings: settings(),
        ...over,
    } as unknown as HostAlonePorts;
}

function gate(alone: HostApi, window: Partial<{ connected: () => boolean; invoke: HostApi['invoke'] }> = {}): HostApi {
    return hostRemoteApi({ hostName: 'alphar', own: {}, window: { connected: () => false, invoke: async () => { throw new Error('the window was asked'); }, ...window }, alone });
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-host-alone-ws-'));
    workspace = join(dir, 'tynn');
    bare = join(dir, 'bare');
    await mkdir(join(workspace, '.git'), { recursive: true });
    await mkdir(bare, { recursive: true });
    await writeFile(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/next/line\n');
    await writeFile(join(workspace, 'project.json'), JSON.stringify({ name: 'tynn', type: 'agi', repos: [{ name: 'tynn.ai', slug: 'tynn-ai', path: '.' }] }));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: workspace });
    await registry.addWorkspace({ id: 'bare', path: bare });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('settings with no window', () => {
    it('reads the values and says which this workspace overrides', async () => {
        const store = settings();
        await store.setFor('tynn', 'terminals', 4);
        const api = gate(hostAloneApi(ports({ settings: store })));
        expect(await api.invoke('workspaces.settings', ['tynn'])).toEqual({ ok: true, values: { theme: 'dark', terminals: 4 }, overridden: ['terminals'] });
    });

    it('a change is written to genie-host\'s own store, and a reset undoes it', async () => {
        const store = settings();
        const api = gate(hostAloneApi(ports({ settings: store })));
        expect(await api.invoke('workspaces.setSetting', ['tynn', 'terminals', 4])).toEqual({ ok: true });
        expect(store.workspaceValues('tynn')).toEqual({ terminals: 4 });
        expect(await api.invoke('workspaces.resetSetting', ['tynn', 'terminals'])).toEqual({ ok: true });
        expect(store.workspaceValues('tynn')).toEqual({});
    });

    it('a change the store refuses comes back as the reason, and nothing is written (CONTROL)', async () => {
        const store = settings();
        const api = gate(hostAloneApi(ports({ settings: store })));
        expect(await api.invoke('workspaces.setSetting', ['tynn', 'not_a_setting', 1])).toEqual({ ok: false, reason: 'no setting not_a_setting' });
        expect(store.workspaceValues('tynn')).toEqual({});
    });
});

describe('repositories with no window', () => {
    it('lists them from the workspace\'s own project.json, with the branch read from its folder', async () => {
        const api = gate(hostAloneApi(ports()));
        expect(await api.invoke('workspaces.listRepos', ['tynn'])).toMatchObject({ ok: true, repos: [{ slug: 'tynn-ai', path: '.', branch: 'next/line' }] });
    });

    it('a folder with no manifest is told to convert, as a window would be (CONTROL)', async () => {
        const api = gate(hostAloneApi(ports()));
        const refusal = { ok: false, reason: 'this workspace has no project.json; convert it to an envelope first' };
        expect(await api.invoke('workspaces.listRepos', ['bare'])).toEqual(refusal);
        expect(await api.invoke('workspaces.commitsSince', ['bare', 0])).toEqual(refusal);
    });
});

describe('the gate', () => {
    it('with a window connected the window answers, and genie-host is not asked (CONTROL)', async () => {
        const store = settings();
        const alone = hostAloneApi(ports({ settings: store }));
        const invoke = vi.spyOn(alone, 'invoke');
        const api = gate(alone, { connected: () => true, invoke: async (method) => `window answered ${method}` });
        expect(await api.invoke('workspaces.setSetting', ['tynn', 'terminals', 4])).toBe('window answered workspaces.setSetting');
        expect(invoke).not.toHaveBeenCalled();
        expect(store.workspaceValues('tynn')).toEqual({});
    });

    it('the Tynn tab is not part of this: still "open a window" (CONTROL)', async () => {
        const api = gate(hostAloneApi(ports()));
        await expect(api.invoke('workspaces.tynnIssues', ['tynn', {}])).rejects.toThrow('open Genie on alphar');
    });
});

describe('the wiring', () => {
    const src = (path: string) => readFileSync(path, 'utf8');

    it('the window and genie-host answer through the same code', () => {
        for (const file of ['src/main/main.ts', 'src/main/host-alone-api.ts']) {
            expect(src(file), file).toContain('workspaceSettingsOps(');
            expect(src(file), file).toContain('repoOpsPorts(');
        }
    });

    it('genie-host gives it its own settings store', () => {
        expect(src('src/main/genie-host.ts')).toMatch(/windowConnected: \(\) => engine\.newestLocalWindow\(\) !== null,\r?\n        settings,\r?\n/);
    });
});
