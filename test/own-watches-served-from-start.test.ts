import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMPTY_HOST_SUMMARY, type HostSummary } from '../src/core/host-summary.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { LOCAL_EVENTS, inMemoryPair, parseMessage, type RemoteMethod, type ServerTransport, type WireMessage } from '../src/core/remote-protocol.js';
import type { RemoteWatchView } from '../src/core/remote-watch.js';
import { OWN_CLIENT_LABEL, ownProtocolClient } from '../src/main/own-protocol-client.js';
import { hostRemoteApi, type HostRemoteApiPorts } from '../src/main/remote-access-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * EVERY WATCH MAIN'S OWN CLIENT KEEPS IS ANSWERED BY GENIE-HOST, FROM ITS START (P6-3 follow-up to #2178). genie-host gives
 * RemoteHost hostRemoteApi's api, and RemoteHost answers `X.watch` with that api's `xWatch()` (or `null` when it has none).
 * #2178 found settings.watch answered null for that reason (every window boot read the default settings). This file reads
 * the window's watches from own-protocol-client.ts itself, so a watch added there is checked here too, and asks each of
 * them of the api genie-host composes, while its own answers are still being built and once they are.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const code = (path: string) => readFileSync(resolve(root, path), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

/** The watches the window keeps open on genie-host: each `persistent('<method>', …)` main's own client says. */
const WINDOW_WATCHES = [...code('src/main/own-protocol-client.ts').matchAll(/persistent\('([a-z]+\.watch)'/g)].map((m) => m[1]!);

const SUMMARY: HostSummary = { ...EMPTY_HOST_SUMMARY, terminals: [{ workspaceId: 'tynn', pid: 42 }], tynnAccountKey: 'acct_1', keychainReady: true };
const GUEST = { id: 'pr_1', label: 'a phone', from: '100.64.0.9', host: 'alphar', replaces: null, raisedAt: 1_000, expiresAt: 121_000 };
const REMOTE: RemoteWatchView = { hostName: 'alphar', connections: [{ id: 'conn_9', label: 'laptop', driving: false, mode: 'control' }], pairRequests: [GUEST] };
const SETTINGS = { data: { values: { launch_at_login: true }, workspaces: {}, carriedOver: null }, key: null, value: null, workspaceId: null };
const REGISTRY = { revision: 0, dropped: [] };
const FRONT_DOOR = { url: 'http://127.0.0.1:7000/' };
const DECK_ITEM = { id: 'q_1', kind: 'question', title: 'Ship it?' };

/** A feed: its value now, and each change said to its listeners. */
function feed<T>(value: T) {
    const listeners = new Set<(view: T) => void>();
    return { now: () => value, subscribe: (l: (view: T) => void) => { listeners.add(l); return () => { listeners.delete(l); }; }, say: (next: T) => { value = next; for (const l of [...listeners]) l(next); } };
}

/**
 * Where genie-host says each watch from its start: the hostRemoteApi port that carries it. `null` = from its own answers
 * (the Deck is read off its snapshot), asked again by the window until they are built. A watch the window keeps that is
 * not named here fails the first test: say where genie-host answers it.
 */
const FROM_START: Record<string, keyof HostRemoteApiPorts | null> = {
    'deck.watch': null,
    'summary.watch': 'summary' as keyof HostRemoteApiPorts,
    'remote.watch': 'remote' as keyof HostRemoteApiPorts,
    'settings.watch': 'settings',
    'registry.watch': 'registry',
    'frontdoor.watch': 'frontdoor',
};
const EXPECTED: Record<string, unknown> = { 'summary.watch': SUMMARY, 'remote.watch': REMOTE, 'settings.watch': SETTINGS, 'registry.watch': REGISTRY, 'frontdoor.watch': FRONT_DOOR };

/** genie-host's api, as it composes it: every from-the-start port, and its own answers (`alone`) once built. */
function genieHostApi() {
    const ports = {
        summary: feed(SUMMARY), remote: feed(REMOTE), settings: feed(SETTINGS), frontdoor: feed(FRONT_DOOR),
        registry: { read: async () => null, watch: feed(REGISTRY) },
    };
    let alone: HostApi | null = null;
    const ready = new Set<() => void>();
    const api = hostRemoteApi({
        hostName: 'alphar', own: {}, alone: () => alone,
        onAloneReady: (l: () => void) => { ready.add(l); return () => { ready.delete(l); }; },
        ...ports,
    } as unknown as HostRemoteApiPorts);
    const build = () => {
        // genie-host's own answers: the snapshot the Deck is read off, and no watch of their own (each is said from the start).
        alone = { invoke: async (method: RemoteMethod) => (method === 'snapshot' ? { deckItems: [DECK_ITEM] } : null), onEvent: () => () => {}, workspaceOfAgent: () => null } as unknown as HostApi;
        for (const l of [...ready]) l();
    };
    return { api, ports, build };
}

async function host(api: HostApi, transport: ServerTransport) {
    const home = await mkdtemp(join(tmpdir(), 'genie-own-watches-'));
    const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
    new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing, transport });
    return { done: async () => { await devices.flushed(); await rm(home, { recursive: true, force: true }); } };
}

const OWN = { kind: 'local', label: OWN_CLIENT_LABEL, isOwner: true, workspaceId: null, readonly: false, window: 'main', own: true };

/** main's own client, speaking the protocol by hand: each call's result, or undefined when none came. */
function ownConnection() {
    let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void = () => {};
    const transport: ServerTransport = { onConnection: (l) => { accept = l; return () => {}; } };
    const connect = async () => {
        const pair = inMemoryPair();
        const frames: WireMessage[] = [];
        pair.client.onMessage((m) => { const r = parseMessage(m); if (r.ok) frames.push(r.message); });
        accept({ ...pair.server, preAuth: OWN as never });
        pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: 'local' }, label: OWN_CLIENT_LABEL }));
        await settle();
        return async (method: string) => {
            pair.client.send(JSON.stringify({ kind: 'call', id: 1, method, args: [] }));
            await settle();
            return frames.find((m) => m.kind === 'result' && m.id === 1) as Extract<WireMessage, { kind: 'result' }> | undefined;
        };
    };
    return { transport, connect };
}

describe('the window’s watches, read from its own client', () => {
    it('are the six it keeps, and each is named where genie-host says it from', () => {
        expect(WINDOW_WATCHES.sort()).toEqual(['deck.watch', 'frontdoor.watch', 'registry.watch', 'remote.watch', 'settings.watch', 'summary.watch']);
        for (const watch of WINDOW_WATCHES) expect(Object.keys(FROM_START), watch).toContain(watch);
    });
});

describe('genie-host answers every one of them', () => {
    it('while its own answers are still being built: each with its value now, and the Deck refused as starting (so the window asks again), never left unanswered', async () => {
        const g = genieHostApi();
        const c = ownConnection();
        const h = await host(g.api, c.transport);
        try {
            const answers: Record<string, unknown> = {};
            for (const watch of WINDOW_WATCHES) {
                const answer = await (await c.connect())(watch);
                answers[watch] = answer === undefined ? 'NO ANSWER' : answer.ok ? answer.value : `refused: ${answer.reason}`;
            }
            expect(answers).toEqual({
                'deck.watch': expect.stringMatching(/^refused: .*still starting/),
                ...EXPECTED,
            });
        } finally { await h.done(); }
    });

    it('once its own answers are built: each with its value now, the Deck’s items too, and none null', async () => {
        const g = genieHostApi();
        g.build();
        const c = ownConnection();
        const h = await host(g.api, c.transport);
        try {
            const answers: Record<string, unknown> = {};
            for (const watch of WINDOW_WATCHES) {
                const answer = await (await c.connect())(watch);
                answers[watch] = answer === undefined ? 'NO ANSWER' : answer.ok ? answer.value : `refused: ${answer.reason}`;
            }
            expect(answers).toEqual({ 'deck.watch': [DECK_ITEM], ...EXPECTED });
        } finally { await h.done(); }
    });
});

describe('the window reads genie-host’s real values at its boot', () => {
    it('remote.watch: who is connected and who asks to pair, then each change once', async () => {
        const g = genieHostApi();
        const own = ownProtocolClient();
        const h = await host(g.api, own.door);
        try {
            const heard: RemoteWatchView[] = [];
            const stop = own.watchRemote((v) => heard.push(v));
            await settle();
            expect(heard).toEqual([REMOTE]);
            const changed = { ...REMOTE, pairRequests: [] };
            g.ports.remote.say(changed);
            await settle();
            expect(heard).toEqual([REMOTE, changed]);
            stop();
        } finally { await h.done(); }
    });

    it('summary.watch: what genie-host runs, its account and its keychain, before its own answers are built', async () => {
        const g = genieHostApi();
        const own = ownProtocolClient();
        const h = await host(g.api, own.door);
        try {
            const heard: HostSummary[] = [];
            const stop = own.watchSummary((s) => heard.push(s));
            await settle();
            expect(heard).toEqual([SUMMARY]);
            const changed = { ...SUMMARY, terminals: [] };
            g.ports.summary.say(changed);
            await settle();
            expect(heard).toEqual([SUMMARY, changed]);
            stop();
        } finally { await h.done(); }
    });

    it('deck.watch: asked while genie-host is starting, the window gets the Deck once its answers are built', async () => {
        const g = genieHostApi();
        const own = ownProtocolClient();
        const h = await host(g.api, own.door);
        try {
            const heard: unknown[][] = [];
            const stop = own.watchDeck((items) => heard.push([...items]));
            await settle();
            expect(heard).toEqual([]);
            g.build();
            await new Promise((r) => setTimeout(r, 700));
            await settle();
            expect(heard).toEqual([[DECK_ITEM]]);
            stop();
        } finally { await h.done(); }
    });
});

describe('genie-host wires it so', () => {
    const host = code('src/main/genie-host.ts');
    const remoteApi = host.slice(host.indexOf('api: hostRemoteApi({'), host.indexOf('let remoteAccessService'));
    const aloneApi = host.slice(host.indexOf('phoneApi = hostAloneApi({'));

    it('each from-the-start port is given to hostRemoteApi, and its own answers no longer say it (a change is said once)', () => {
        for (const [watch, port] of Object.entries(FROM_START)) {
            if (port === null) continue;
            expect(remoteApi, watch).toMatch(new RegExp(`\\n\\s*${port}: `));
        }
        expect(aloneApi.slice(0, aloneApi.indexOf('});'))).not.toMatch(/\n\s*(hostSummary|remoteWatch|settingsWatch),\n/);
    });

    it('hostRemoteApi says each port’s changes on its own channel', () => {
        const api = code('src/main/remote-access-host.ts');
        expect(api).toMatch(/ports\.summary\?\.subscribe\(\(view\) => listener\(LOCAL_EVENTS\.summary, view\)\)/);
        expect(api).toMatch(/ports\.remote\?\.subscribe\(\(view\) => listener\(LOCAL_EVENTS\.remote, view\)\)/);
        expect(LOCAL_EVENTS.summary).toBe('local-summary');
    });
});
