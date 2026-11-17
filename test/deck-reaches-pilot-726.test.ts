import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inMemoryPair, parseMessage, type PreAuth, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import type { HostApi } from '../src/main/remote-host.js';
import { hostRemoteApi, RemoteAccessHost, RemoteAccessService } from '../src/main/remote-access-host.js';
import { RemoteAccessReplica } from '../src/main/remote-access-replica.js';

/**
 * ONE FTQ ON THE MACHINE BEING REACHED, AND THE PILOT'S DECK (Tynn #726 part 1; the owner's live trial, 2026-11-16: a fresh
 * install, one ForceTheQuestion, a tiny snapshot — and the Pilot's Deck never updated). The whole path a Deck change
 * takes, composed from the real pieces: the client's window (its RemoteAccessReplica, refreshed at boot while nobody is
 * connected, forwarding its host API's events) → genie-host's RemoteAccessService (only the newest window feeds remote
 * connections) → hostRemoteApi → RemoteHost → a Pilot admitted by the relay. And the same with no window open, where
 * genie-host's own answers (the phone's registry) speak. Names are fixtures.
 */

const OWNER: PreAuth = { label: 'Pilot laptop', isOwner: true, workspaceId: null, readonly: false };
const EMPTY = { agents: [], workspaces: [{ id: 'ws_shop', path: '/w/shop', agentsKnown: true }], deckItems: [], signals: {} };
const FTQ = { id: 'q_1', source: 'agent-question', agentId: 'agent_kai', agentName: 'kai', workspaceId: 'ws_shop', title: 'Which engine?', blocking: true, priority: 'normal', at: 1, forwardedFrom: null, answer: { kind: 'form', fields: 1, questions: [{ question: 'Which engine?', header: 'Engine', options: [{ label: 'postgres' }], multiSelect: false }] } };
const ASKED = { ...EMPTY, deckItems: [FTQ] };
const WINDOW = 'conn_window';

type Listener = (channel: string, payload: unknown) => void;
function emitter() {
    const listeners = new Set<Listener>();
    return { on: (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; }, emit: (channel: string, payload: unknown) => { for (const l of [...listeners]) l(channel, payload); } };
}

let home = '';
let access: RemoteAccessHost;
let connections: Array<(c: ServerConnection) => void> = [];
let windowOpen = true;
/** The client's window's own host API: what it emits (the snapshot on every change) and answers. */
const windowApi = emitter();
/** genie-host's own answers with no window (host-alone-api, the phone's registry). */
const aloneApi = emitter();
let replica: RemoteAccessReplica;

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie-726-deck-'));
    connections = [];
    windowOpen = true;
    const remoteWindowEvents = new Set<Listener>();
    const alone: HostApi = {
        invoke: async (method) => { if (method === 'snapshot') return EMPTY; throw new Error(`no ${method}`); },
        onEvent: (listener) => aloneApi.on(listener),
        workspaceOfAgent: () => 'ws_shop',
    } as unknown as HostApi;
    const api = hostRemoteApi({
        hostName: 'client-box',
        own: {},
        window: { connected: () => windowOpen, invoke: async (method) => { if (method === 'snapshot') return EMPTY; throw new Error(`no ${method}`); } },
        onEvent: (listener) => { remoteWindowEvents.add(listener); return () => { remoteWindowEvents.delete(listener); }; },
        alone: () => alone,
        workspaceOfAgent: () => 'ws_shop',
    });
    access = await RemoteAccessHost.open({ home, hostName: 'client-box', api, transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } }, now: () => 1_000_000 });
    let service: RemoteAccessService | null = null;
    replica = new RemoteAccessReplica('client-box', (method, args) => service!.call(WINDOW, method, args));
    service = new RemoteAccessService(access, {
        switch: { apply: async () => {}, restart: async () => {}, stop: async () => {} },
        newestWindow: () => (windowOpen ? WINDOW : null),
        windowEvent: (channel, payload) => { for (const l of [...remoteWindowEvents]) l(channel, payload); },
        send: (owner, event) => { if (owner === null || owner === WINDOW) replica.deliver(event); },
    });
    // The window at boot, as main.ts does: forward its host API's events, and read the status — nobody connected yet.
    replica.forwardEvents((listener) => windowApi.on(listener));
    await replica.refresh();
});
afterEach(async () => { await access.close(); await rm(home, { recursive: true, force: true }); });

function pilot() {
    const pair = inMemoryPair();
    for (const cb of connections) cb({ ...pair.server, remoteAddress: 'relay:pilot', preAuth: OWNER });
    const heard: WireMessage[] = [];
    pair.client.onMessage((text) => { const r = parseMessage(text); if (r.ok) heard.push(r.message); });
    let n = 0;
    return {
        heard,
        hello: () => pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, label: 'pilot' })),
        call: (method: string) => pair.client.send(JSON.stringify({ kind: 'call', id: ++n, method, args: [] })),
    };
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const snapshotsHeard = (heard: WireMessage[]) => heard.filter((m) => m.kind === 'event' && (m as { channel?: string }).channel === 'snapshot').map((m) => (m as unknown as { payload: { deckItems: Array<{ id: string }> } }).payload);

describe('one FTQ on the machine being reached reaches the Pilot’s Deck', () => {
    it('positive control: the Pilot is admitted and reads the snapshot', async () => {
        const p = pilot();
        p.hello();
        await settle();
        expect(p.heard[0]).toMatchObject({ kind: 'welcome', isOwner: true });
        p.call('snapshot');
        await settle();
        expect(p.heard.some((m) => m.kind === 'result' && (m as { ok?: boolean }).ok === true)).toBe(true);
    });

    it('with the client’s window open: the window’s next snapshot, carrying the question, is pushed to the Pilot', async () => {
        const p = pilot();
        p.hello();
        await settle();
        windowApi.emit('snapshot', ASKED);
        await settle();
        expect(snapshotsHeard(p.heard).at(-1)?.deckItems.map((d) => d.id)).toEqual(['q_1']);
    });

    it('with no window open: genie-host’s own snapshot, carrying the question, is pushed to the Pilot', async () => {
        windowOpen = false;
        const p = pilot();
        p.hello();
        await settle();
        aloneApi.emit('snapshot', ASKED);
        await settle();
        expect(snapshotsHeard(p.heard).at(-1)?.deckItems.map((d) => d.id)).toEqual(['q_1']);
    });
});
