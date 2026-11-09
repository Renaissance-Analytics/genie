import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { LOCAL_EVENTS, RESTRICTED_CALL_CONTEXT } from '../src/core/remote-protocol.js';
import { hostAloneApi, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import type { HostApi } from '../src/main/remote-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/*
 * THE FEATURES WITH EVERY WINDOW CLOSED (Tynn #553, host split P5d.5g). genie-host answers `features.snapshot` and the actions
 * on what it owns, with the same code a window runs: knowledge, the inbox, flows, hosting, services, settings, remote
 * access, plugins. What only a window can do (a browser pane, an installer, a sign-in page) still says to open one.
 */

let dir = '';
let registry: Registry;
let atlas: AgentRecord;
const sent: unknown[] = [];
const written: Array<[string, unknown]> = [];

type Sources = { fire(): void };

interface Mods { hostFeatureServices(parts: Record<string, unknown>): unknown }
/** Reached loosely so these are red by assertion, not by a compile error, until the module exists. */
const mods = async (): Promise<Mods> => (await import(/* @vite-ignore */ `../src/main/${'host-feature-services'}.js`)) as Mods;

function parts(over: Record<string, unknown> = {}): Record<string, unknown> {
    const mail = [{ id: 'm1', from: atlas.id, to: 'human', text: 'hello', at: '2026-11-09T00:00:00Z', attachments: [], read: false }];
    return {
        inbox: { all: () => mail, unread: () => mail, involving: () => mail, send: async (m: unknown) => { sent.push(m); return { id: 'm2' }; } },
        attention: { finished: () => [], dismiss: async () => true },
        knowledge: { search: async ({ query }: { query: string }) => ({ hits: [{ id: 'k1', title: query }] }), summaries: async () => ({ hits: [{ id: 'k0', title: 'kept' }] }) },
        settings: { snapshot: () => ({ theme: 'dark', remote_access: true }), set: async (k: string, v: unknown) => { written.push([k, v]); }, reset: async () => {} },
        supervisor: { readLog: () => null, list: () => [] },
        flows: { list: () => [{ id: 'f1', name: 'nightly' }] },
        hosting: () => ({
            sites: { list: () => [{ id: 's1', name: 'moic' }] }, externalFrontDoor: { state: 'on' }, hostingProblems: () => [], engineStatuses: async () => [{ id: 'redis', status: 'running' }],
            routes: () => [], trust: { entries: () => [] },
        }),
        remote: { status: () => ({ host: 'alphar', url: 'wss://alphar', unavailable: null, locked: false, pin: null, devices: [{ id: 'd1' }], connections: [], pairRequests: [] }), issuePin: () => ({ code: '123456', expiresAt: 9 }), revokeDevice: () => true, lock: () => {}, unlock: () => {}, answerPair: () => ({ ok: true }) },
        plugins: { list: () => [{ id: 'p1' }] },
        pluginsDir: '/plugins',
        pluginsRefresh: async () => {},
        catalog: () => [],
        roster: () => [atlas],
        slugs: () => new Map([['tynn', 'tynn']]),
        workspaces: () => [{ id: 'tynn', asleep: false }],
        mcp: () => ({ url: 'http://127.0.0.1:9/mcp', tools: [] }),
        ...over,
    };
}

function ports(services: unknown, over: Record<string, unknown> = {}, source?: Sources): HostAlonePorts {
    const engine = { probe: () => null, subscribe: () => () => {}, ledgerFor: () => [], rowsFor: () => [], turnsFor: () => 0, recentStderrFor: () => [], refusals: new Map(), needsNewDriver: () => false, notice: () => true } as unknown as HostAloneEngine;
    return {
        hostName: 'alphar', registry, engine: () => engine, cwdFor: () => '/w', startRefusal: () => null,
        models: { get: async () => ({ models: [] }) }, providerInstalled: () => true, windowConnected: () => false,
        terminals: { attach: () => null, write: () => true, resize: () => true, close: () => true, list: () => [], onData: () => () => {}, onExit: () => () => {} },
        takeOver: () => null,
        settings: { snapshotFor: () => ({}), workspaceValues: () => ({}), setFor: async () => {}, resetFor: async () => {} },
        headroom: { view: () => ({}), subscribe: () => () => {} },
        attention: { finished: () => [], markSeen: () => {}, answer: async () => true, lists: { done: async () => true } },
        approvals: { resolve: () => true }, inbox: { unread: () => [], receive: async () => [], involving: () => [] }, deliverToAgent: async () => true,
        files: { children: async () => null, open: async () => ({ ok: false }), readBytes: async () => ({ ok: false }), upload: async () => ({ ok: false }) },
        workspaceLifecycle: { terminals: () => null, supervisor: () => null, engines: () => null, reverifyTrust: async () => {}, github: () => null, tynn: () => null, defaultEnvFile: () => '', stagingDirectory: () => '' },
        colors: { set: async () => ({ ok: true }) },
        tynnTab: { board: () => ({}), readPage: async () => ({}) },
        featureHost: { services: () => services, ports: {}, subscribe: (l: () => void) => { if (source) source.fire = l; return () => {}; } },
        ...over,
    } as unknown as HostAlonePorts;
}

function gate(alone: HostApi, window: Partial<{ connected: () => boolean; invoke: HostApi['invoke'] }> = {}): HostApi {
    return hostRemoteApi({ hostName: 'alphar', own: {}, window: { connected: () => false, invoke: async () => { throw new Error('the window was asked'); }, ...window }, alone });
}

async function api(over: Record<string, unknown> = {}, portOver: Record<string, unknown> = {}, source?: Sources) {
    const { hostFeatureServices } = await mods();
    return hostAloneApi(ports(hostFeatureServices(parts(over)), portOver, source));
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-host-alone-features-'));
    sent.length = 0;
    written.length = 0;
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
    atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

interface Snapshot {
    knowledge: { hits: Array<{ id: string; title: string }> }; flows: { flows: unknown[] }; hosting: { sites: unknown[] }; services: { instances: unknown[] };
    inbox: { unread: unknown[]; peers: Array<{ name: string }> }; settings: { values: Record<string, unknown> }; remote: { host: string; url: string; devices: unknown[]; enabled: boolean }; plugins: { entries: unknown[] }; integrations: { tynnSignedIn: boolean };
}

describe('the snapshot with no window', () => {
    it('every section reads what genie-host owns', async () => {
        const data = (await gate(await api()).invoke('features.snapshot', [])) as Snapshot;
        expect(data.knowledge.hits).toEqual([{ id: 'k0', title: 'kept' }]);
        expect(data.flows.flows).toHaveLength(1);
        expect(data.hosting.sites).toHaveLength(1);
        expect(data.services.instances).toHaveLength(1);
        expect(data.inbox.unread).toHaveLength(1);
        expect(data.inbox.peers.map((p) => p.name)).toEqual(['atlas']);
        expect(data.settings.values).toMatchObject({ theme: 'dark' });
        expect(data.remote).toMatchObject({ host: 'alphar', url: 'wss://alphar', enabled: true });
        expect(data.remote.devices).toHaveLength(1);
        expect(data.plugins.entries).toHaveLength(1);
        expect(data.integrations.tynnSignedIn).toBe(false);
    });

    it('with no hosting it says why, rather than answering with half a snapshot (CONTROL)', async () => {
        await expect(gate(await api({ hosting: () => null })).invoke('features.snapshot', [])).rejects.toThrow(/hosting/i);
    });
});

describe('the actions with no window', () => {
    it('a setting is written to genie-host\'s store', async () => {
        await gate(await api()).invoke('features.act', [{ kind: 'settings.set', key: 'theme', value: 'light' }], RESTRICTED_CALL_CONTEXT);
        expect(written).toEqual([['theme', 'light']]);
    });

    it('a knowledge search answers with its hits', async () => {
        const data = (await gate(await api()).invoke('features.act', [{ kind: 'knowledge.search', query: 'cats' }], RESTRICTED_CALL_CONTEXT)) as Snapshot;
        expect(data.knowledge.hits).toEqual([{ id: 'k1', title: 'cats' }]);
    });

    it('a message from a Pilot reaches the agent', async () => {
        await gate(await api()).invoke('features.act', [{ kind: 'inbox.send', to: 'atlas', text: 'hi' }], RESTRICTED_CALL_CONTEXT);
        expect(sent).toMatchObject([{ from: 'human', to: atlas.id, text: 'hi' }]);
    });

    it('ORIGIN RULE: a path on this disk cannot be attached from another machine, and nothing is sent', async () => {
        await expect(gate(await api()).invoke('features.act', [{ kind: 'inbox.send', to: 'atlas', text: 'hi', attachments: ['/home/person/.ssh/id_ed25519'] }], RESTRICTED_CALL_CONTEXT)).rejects.toThrow();
        expect(sent).toEqual([]);
    });

    it('one Pilot\'s search does not move what the next snapshot shows', async () => {
        const live = gate(await api());
        await live.invoke('features.act', [{ kind: 'knowledge.search', query: 'cats' }], RESTRICTED_CALL_CONTEXT);
        expect(((await live.invoke('features.snapshot', [])) as Snapshot).knowledge.hits).toEqual([{ id: 'k0', title: 'kept' }]);
    });

    it.each([
        [{ kind: 'toolchain.check' }],
        [{ kind: 'browser.navigate', url: 'https://example.test' }],
        [{ kind: 'integrations.tynnSignIn' }],
        [{ kind: 'tailscale.up' }],
        [{ kind: 'keyring.fix' }],
        [{ kind: 'flows.openEditor', flowId: 'f1' }],
    ])('what only a window can do still says to open one: %j', async (action) => {
        await expect(gate(await api()).invoke('features.act', [action], RESTRICTED_CALL_CONTEXT)).rejects.toThrow('open Genie on alphar');
    });

    it('an action needing something genie-host does not hold says to open a window, never crashes', async () => {
        await expect(gate(await api()).invoke('features.act', [{ kind: 'workspace.syncAgentFiles', workspaceId: 'tynn', workspacePath: '/w/tynn' }], RESTRICTED_CALL_CONTEXT)).rejects.toThrow('open Genie on alphar');
    });

    it('the Deck\'s answer still goes the way it did', async () => {
        const answers: string[] = [];
        const live = gate(await api({}, { attention: { finished: () => [], markSeen: () => {}, answer: async (id: string) => { answers.push(id); return true; }, lists: { done: async () => true } } }));
        const item = { id: 'q_1', source: 'agent-question', agentId: atlas.id, agentName: 'atlas', workspaceId: 'tynn', title: 'Ship it?', blocking: true, priority: 'high', at: 1, answer: { kind: 'inline', question: { id: 'q_1', prompt: 'Ship it?', options: [{ id: 'yes', label: 'Yes' }] } } };
        await live.invoke('features.act', [{ kind: 'deck.answer', item, optionId: 'yes' }], RESTRICTED_CALL_CONTEXT).catch(() => null);
        expect(answers).toEqual(['q_1']);
    });
});

describe('its events', () => {
    const settled = () => new Promise((r) => setTimeout(r, 5));

    it('a change reaches a listening Pilot as the snapshot', async () => {
        const source: Sources = { fire: () => {} };
        const alone = await api({}, {}, source);
        const seen: string[] = [];
        alone.onEvent((channel) => { seen.push(channel); });
        source.fire();
        await vi.waitFor(() => { expect(seen).toContain('features'); });
        expect(seen).toContain(LOCAL_EVENTS.features);
    });

    it('with a window connected nothing is built: the window pushes its own (CONTROL)', async () => {
        const source: Sources = { fire: () => {} };
        const summaries = vi.fn(async () => ({ hits: [] }));
        const alone = await api({ knowledge: { search: async () => ({ hits: [] }), summaries } }, { windowConnected: () => true }, source);
        alone.onEvent(() => {});
        source.fire();
        await settled();
        expect(summaries).not.toHaveBeenCalled();
    });

    it('with nobody listening nothing is built (CONTROL)', async () => {
        const source: Sources = { fire: () => {} };
        const summaries = vi.fn(async () => ({ hits: [] }));
        await api({ knowledge: { search: async () => ({ hits: [] }), summaries } }, {}, source);
        source.fire();
        await settled();
        expect(summaries).not.toHaveBeenCalled();
    });
});

describe('the gate', () => {
    it('with a window connected the window answers, and genie-host is not asked (CONTROL)', async () => {
        const alone = await api();
        const invoke = vi.spyOn(alone, 'invoke');
        const live = gate(alone, { connected: () => true, invoke: async (method) => `window answered ${method}` });
        expect(await live.invoke('features.snapshot', [])).toBe('window answered features.snapshot');
        expect(invoke).not.toHaveBeenCalled();
    });
});

describe('the wiring', () => {
    it('genie-host gives it what it owns, and tells it when that changes', () => {
        const host = readFileSync('src/main/genie-host.ts', 'utf8');
        expect(host).toMatch(/hostFeatureServices\(\{/);
        expect(host).toMatch(/featureHost: \{/);
    });

    it('a feature action goes through the code the window runs, with the origin from the call', () => {
        const alone = readFileSync('src/main/host-alone-api.ts', 'utf8');
        expect(alone).toContain('handleFeatureAction(');
        expect(alone).toContain('featureOriginOf(context,');
    });
});
