import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { hostAloneApi, PHONE_METHODS, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/** genie-host's terminals are a CLASS with private state (main/terminal-host.ts), never a plain object of functions. */
class PrivateTerminals {
    readonly #data = new Set<(id: string, data: string) => void>();
    readonly #exit = new Set<(id: string, code: number) => void>();
    attach() { return null; }
    write() { return true; }
    resize() { return true; }
    close() { return true; }
    list() { return []; }
    onData(listener: (id: string, data: string) => void) { this.#data.add(listener); return () => { this.#data.delete(listener); }; }
    onExit(listener: (id: string, code: number) => void) { this.#exit.add(listener); return () => { this.#exit.delete(listener); }; }
    emit(id: string, data: string) { for (const l of this.#data) l(id, data); }
}

/*
 * THE PHONE'S METHODS, ANSWERED BY GENIE-HOST WITH EVERY WINDOW CLOSED (Tynn #551, host split P5d.2). genie-host runs the
 * SAME host API the window does (host-api.ts `buildHostApi`), over what it owns: the registry's files, its session host,
 * its attention, inbox and approval stores, the workspaces' files. What a phone asks is answered as the window would
 * answer it; anything else is refused with what to do. While a window is open, the window answers, as before.
 */

let dir = '';
let registry: Registry;
let atlas: AgentRecord;
const calls: string[] = [];

function engine(running = false): HostAloneEngine {
    const live = new Set<string>(running ? ['*'] : []);
    const isLive = (id: string) => live.has('*') || live.has(id);
    const subscribers = new Set<(id: string) => void>();
    const fake = {
        probe: (id: string) => (isLive(id) ? { running: true, inTurn: false } : null),
        start: (r: AgentRecord, cwd: string) => { calls.push(`start ${r.name} ${cwd}`); live.add(r.id); return { ok: true }; },
        stop: (id: string) => { calls.push(`stop ${id === atlas.id ? 'atlas' : id}`); live.delete(id); live.delete('*'); return true; },
        ended: async () => { calls.push('ended'); return { verified: true, survivors: [], reason: '' }; },
        deliverOwed: async () => { calls.push('deliverOwed'); return 0; },
        cancel: () => ({ ok: true }),
        resumeLimit: (provider: string) => { calls.push(`resumeLimit ${provider}`); },
        prompt: async (_id: string, text: string, by: string | null) => { calls.push(`prompt ${text} by ${by}`); return true; },
        promptWith: async (_id: string, text: string, files: readonly unknown[], by: string | null) => { calls.push(`promptWith ${text} ${files.length} by ${by}`); return { ok: true }; },
        resolvePrompt: async () => ({ ok: true }),
        answerApproval: (_id: string, option: string, note: string) => { calls.push(`answerApproval ${option} ${note}`); return { ok: true }; },
        subscribe: (l: (id: string) => void) => { subscribers.add(l); return () => subscribers.delete(l); },
        needsNewDriver: () => false,
        notice: () => true,
        ledgerFor: () => [],
        turnsFor: () => 3,
        recentStderrFor: () => [],
        rowsFor: () => [],
        refusals: new Map(),
        emit: (id: string) => { for (const l of subscribers) l(id); },
    };
    return fake as unknown as HostAloneEngine;
}

function ports(e: HostAloneEngine, over: Partial<HostAlonePorts> = {}): HostAlonePorts {
    return {
        hostName: 'alphar',
        registry,
        engine: () => e,
        cwdFor: (r) => (r.workspaceId === 'tynn' ? '/w/tynn' : '/home'),
        startRefusal: () => null,
        attention: {
            finished: () => [{ id: 'fin_1', agentId: atlas.id, agentName: 'atlas', handoff: 'shipped the fix; next, the docs', at: '2026-11-08T20:00:00Z', seen: false }],
            markSeen: (id) => { calls.push(`markSeen ${id}`); },
            answer: async (id, answer) => { calls.push(`answer ${id} ${JSON.stringify(answer.selections)}`); return true as never; },
            // The question the Deck answers is still waiting (deck-answer.ts checks, Tynn #600).
            pending: () => [{ id: 'q_1' }] as never,
            lists: { done: async () => true },
        },
        approvals: { resolve: () => true },
        inbox: { unread: () => [], receive: async () => [] as never, involving: () => [] },
        deliverToAgent: async () => true,
        files: {
            children: async (workspaceId, path) => { calls.push(`children ${workspaceId} ${path}`); return [{ name: 'README.md', path: 'README.md', kind: 'file' }] as never; },
            open: async (_w, path) => ({ ok: false as const, path, error: 'n/a' }),
            readBytes: async (_w, path) => ({ ok: false as const, path, error: 'n/a' }),
            upload: async () => ({ ok: false as const, reason: 'n/a' }),
        },
        models: { get: async () => ({ models: [] }) as never },
        providerInstalled: () => true,
        windowConnected: () => false,
        tynnTab: { board: () => ({ signedIn: () => false, projectFor: () => null, request: async () => ({ ok: false, status: 404, json: async () => null }) }), readPage: async () => ({ ok: false, state: 'error', reason: 'n/a' }) },
        workspaceLifecycle: { terminals: () => null, supervisor: () => null, engines: () => null, reverifyTrust: async () => {}, github: () => null, tynn: () => null, defaultEnvFile: () => '', stagingDirectory: () => '' },
        colors: { set: async () => ({ ok: true as const }) },
        settings: { snapshotFor: () => ({}), workspaceValues: () => ({}), setFor: async () => {}, resetFor: async () => {} },
        terminals: { attach: () => null, write: () => true, resize: () => true, close: () => true, list: () => [], onData: () => () => {}, onExit: () => () => {} },
        takeOver: () => null,
        headroom: { view: () => ({}), subscribe: () => () => {} },
        ...over,
    };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-host-alone-'));
    calls.length = 0;
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
    atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('genie-host answers the phone itself', () => {
    it('the snapshot and an agent\'s detail, from the host\'s own registry and session host', async () => {
        const api = hostAloneApi(ports(engine(true)));
        const snapshot = (await api.invoke('snapshot', [])) as { agents: Array<{ id: string; name: string }> };
        expect(snapshot.agents.map((a) => a.name)).toContain('atlas');
        const detail = (await api.invoke('agentDetail', [atlas.id])) as { agent: { name: string; cwd: string }; session: unknown; turns: number };
        expect(detail).toMatchObject({ agent: { name: 'atlas', cwd: '/w/tynn' }, session: { running: true }, turns: 3 });
        expect(await api.invoke('agentDetail', ['agent_nobody'])).toBeNull();
    });

    it('a message starts a stopped agent first, as the composer does, then is sent by you', async () => {
        const api = hostAloneApi(ports(engine(false)));
        expect(await api.invoke('prompt', [atlas.id, 'look at the build'])).toEqual({ ok: true });
        expect(calls).toEqual(['start atlas /w/tynn', 'promptWith look at the build 0 by you']);
    });

    it('an approval answer, Resume now, and a restart go to the host\'s own session host', async () => {
        const api = hostAloneApi(ports(engine(true)));
        expect(await api.invoke('answerApproval', [atlas.id, 'allow', 'go ahead'])).toEqual({ ok: true });
        expect(await api.invoke('resumeLimit', [atlas.id])).toEqual({ ok: true });
        expect(await api.invoke('agents.restart', [atlas.id, 'graceful'])).toEqual({ ok: true, kind: 'graceful' });
        expect(calls).toEqual(['answerApproval allow go ahead', 'resumeLimit claude', 'stop atlas', 'ended', 'start atlas /w/tynn', 'deliverOwed']);
    });

    it('Restart with handoff: the one restart, then the note, and the finished item seen', async () => {
        const api = hostAloneApi(ports(engine(true)));
        expect(await api.invoke('restartWithHandoff', [atlas.id, 'fin_1'])).toMatchObject({ ok: true });
        expect(calls.slice(0, 4)).toEqual(['stop atlas', 'ended', 'start atlas /w/tynn', 'deliverOwed']);
        expect(calls.slice(4)).toEqual(['prompt You are restarting from your own handoff note. Pick up where it leaves off:\n\nshipped the fix; next, the docs by undefined', 'markSeen fin_1']);
    });

    it('the Deck answer for a question is answered in the host\'s attention store; any other feature action needs a window', async () => {
        const api = hostAloneApi(ports(engine(true)));
        const item = { id: 'q_1', source: 'agent-question', agentId: atlas.id, agentName: 'atlas', workspaceId: 'tynn', title: 'Ship it?', blocking: true, priority: 'high', at: 1, answer: { kind: 'inline', options: [{ id: 'yes', label: 'Yes' }] }, forwardedFrom: null };
        await api.invoke('features.act', [{ kind: 'deck.answer', item, optionId: 'yes' }]);
        expect(calls).toContain('answer q_1 [["yes"]]');
        await expect(api.invoke('features.act', [{ kind: 'settings.set', key: 'theme', value: 'dark' }])).rejects.toThrow('open Genie on alphar');
    });

    it('the phone\'s file browser lists the workspace through the host\'s files', async () => {
        const api = hostAloneApi(ports(engine(true)));
        expect(await api.invoke('files.children', ['tynn', ''])).toEqual([{ name: 'README.md', path: 'README.md', kind: 'file' }]);
        expect(calls).toEqual(['children tynn ']);
    });

    it('its events: the snapshot when the registry changes, an agent\'s detail when its session does', async () => {
        const e = engine(true);
        const api = hostAloneApi(ports(e, { schedule: (_ms, fn) => { fn(); return () => {}; } }));
        const seen: string[] = [];
        const off = api.onEvent((channel) => { seen.push(channel); });
        registry.touch();
        (e as unknown as { emit(id: string): void }).emit(atlas.id);
        expect(seen).toContain('snapshot');
        expect(seen).toContain(`agent:${atlas.id}`);
        off();
    });
});

describe('the remote host uses it only while no window is connected', () => {
    it('the phone\'s methods: the window while one is open, genie-host while none; anything else is refused with none', async () => {
        let windowOpen = true;
        const alone = hostAloneApi(ports(engine(true)));
        const api = hostRemoteApi({
            hostName: 'alphar', own: {},
            window: { connected: () => windowOpen, invoke: async (method) => ({ fromWindow: method }) },
            alone,
        });
        expect(await api.invoke('snapshot', [])).toEqual({ fromWindow: 'snapshot' });
        windowOpen = false;
        expect(((await api.invoke('snapshot', [])) as { agents: unknown[] }).agents.length).toBeGreaterThan(0);
        await expect(api.invoke('addAgent', ['tynn', {}])).rejects.toThrow('alphar answers addAgent only while a Genie window is open there: open Genie on alphar');
        expect([...PHONE_METHODS].sort()).toEqual(['agentDetail', 'agents.restart', 'answerApproval', 'features.act', 'files.children', 'files.open', 'files.readMedia', 'files.upload', 'prompt', 'restartWithHandoff', 'resumeLimit', 'snapshot']);
    });

    it('genie-host\'s own events reach remote connections only while no window is connected (a window forwards its own)', async () => {
        let windowOpen = true;
        const alone = { invoke: vi.fn(), onEvent: (l: (c: string, p: unknown) => void) => { emitAlone = l; return () => {}; }, workspaceOfAgent: () => null };
        let emitAlone: (c: string, p: unknown) => void = () => {};
        const api = hostRemoteApi({ hostName: 'alphar', own: {}, window: { connected: () => windowOpen, invoke: async () => null }, alone });
        const seen: string[] = [];
        api.onEvent((channel) => { seen.push(channel); });
        emitAlone('snapshot', {});
        windowOpen = false;
        emitAlone('snapshot', { n: 2 });
        expect(seen).toEqual(['snapshot']);
    });
});

describe('a Pilot connecting to a Drone with no window open (beta.61 blocker, Azure pair gp-11102138)', () => {
    it('genie-host\'s own terminals are listened to without losing their class: no "private member" throw', () => {
        const api = hostAloneApi(ports(engine(true), { terminals: new PrivateTerminals() as never }));
        const off = api.onEvent(() => {});
        off();
    });

    it('a Pilot pairs over the wire, as its window does, and hears the Drone\'s events', async () => {
        const terminals = new PrivateTerminals();
        const devices = await DeviceStore.open(dir, { now: Date.now, random: () => 'pilot-token' });
        let accept!: (c: ServerConnection) => void;
        const drone = new RemoteHost({
            api: hostRemoteApi({ hostName: 'drone', own: {}, window: { connected: () => false, invoke: async () => null }, alone: hostAloneApi(ports(engine(true), { terminals: terminals as never })) }),
            hostName: 'drone', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing,
            transport: { onConnection: (l) => { accept = l; return () => {}; } },
        });
        drone.issuePin();
        const pair = inMemoryPair();
        accept(pair.server);
        const pilot = connectRemote(pair.client, { kind: 'pin', code: '482913', label: 'pilot' }, 'pilot', { drive: true });
        expect(await pilot.ready).toEqual({ ok: true });
        expect(pilot.state()).toMatchObject({ connected: true, host: 'drone' });
        const heard: unknown[] = [];
        const off = pilot.bridge.terminals.onData((id: string, data: string) => { heard.push([id, data]); });
        terminals.emit('term_1', 'hello');
        await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
        off();
        pilot.close();
        await devices.flushed();
    });
});
