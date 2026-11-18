import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_SCHEMA_VERSION } from '../src/core/catalog.js';
import { ENGINE_PROTOCOL } from '../src/core/engine-protocol.js';
import { memoryPair } from '../src/core/line-transport.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import { buildHostApi } from '../src/main/host-api.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';

/*
 * TWO-WAY PROTOCOL VERSIONING (Tynn #894; the owner, 2026-11-18): clients are dumb terminals; client and host update
 * independently, so the wire works across versions in BOTH directions. The rulings this proves:
 *
 *  - The client says its track, build, schema, window floor and capabilities in `hello`; the host its own in `welcome`.
 *    Each side uses only what both said.
 *  - FIXED support window on the date schema: a pair outside it is admitted UPDATE-ONLY (`host.version`, `host.update`),
 *    every other call refused with `code: 'version'` and both schemas named. Nothing hangs, nothing is guessed.
 *  - The client DETECTS a host to update on first connection and at any time (`checkHost`), and can TRIGGER it
 *    (`requestHostUpdate`; the host's update port is a stub until the launcher step wires it).
 *  - CONFERENCE MODE: several people are connected at once and act independently. Nothing here takes or needs the baton,
 *    each connection negotiates for itself, and two owners asking for the update at once start one.
 *  - An unknown method is answered with the call's id, on the remote wire and on the engine link both ways.
 */

let dir: string;
let devices: DeviceStore;
const closers: Array<() => void> = [];

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-894-')); let n = 0; devices = await DeviceStore.open(dir, { now: Date.now, random: () => `d-${++n}` }); });
afterEach(async () => { for (const c of closers.splice(0)) c(); await new Promise<void>((r) => setImmediate(r)); await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

type Offer = { track: 'client' | 'host' | 'launcher' | 'browser' | null; build: string | null; schema: string; minSchema: string; capabilities: readonly string[] };
const HOST: Offer = { track: 'host', build: '2026.11.18-1', schema: '2026.11.18', minSchema: '2026.10.19', capabilities: ['unsupported-result@1', `catalog@${CATALOG_SCHEMA_VERSION}`] };
const CLIENT: Offer = { track: 'client', build: '2026.11.18-1', schema: '2026.11.18', minSchema: '2026.10.19', capabilities: ['unsupported-result@1', `catalog@${CATALOG_SCHEMA_VERSION}`] };
const helloOf = (o: Offer) => ({ kind: 'hello', auth: { kind: 'relay' }, track: o.track, build: o.build, schema: o.schema, minSchema: o.minSchema, capabilities: o.capabilities });

type Admit = { label: string; isOwner: boolean; workspaceId: string | null; readonly: boolean };
const OWNER: Admit = { label: 'phone', isOwner: true, workspaceId: null, readonly: false };

/** A RemoteHost over the in-memory pair. `protocol` overrides its offer; `requestUpdate` is its host-update port. */
function serve(options: { protocol?: Offer | (() => Offer); requestUpdate?: (who: { label: string; connectionId: string }) => Promise<unknown> } = {}) {
    let accept!: (connection: ServerConnection) => void;
    new RemoteHost({ api: buildHostApi(protocolContractDeps(dir)), hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing, build: '2026.11.18-1',
        transport: { onConnection: (l) => { accept = l; return () => {}; } }, ...options } as ConstructorParameters<typeof RemoteHost>[0]);
    /** A raw connection admitted through the relay: frames in, frames out, close seen. */
    const raw = (who: Admit = OWNER) => {
        const pair = inMemoryPair();
        const frames: Array<Record<string, unknown>> = [];
        let closed = false;
        pair.client.onMessage((text) => { frames.push(JSON.parse(text) as Record<string, unknown>); });
        pair.client.onClose(() => { closed = true; });
        accept({ ...pair.server, remoteAddress: 'relay:x', preAuth: who });
        closers.push(() => pair.client.close());
        let id = 100;
        const call = async (method: string, ...args: unknown[]) => {
            const mine = ++id;
            pair.client.send(JSON.stringify({ kind: 'call', id: mine, method, args }));
            await until(() => frames.some((f) => f.kind === 'result' && f.id === mine));
            return frames.find((f) => f.kind === 'result' && f.id === mine)!;
        };
        return { send: (frame: unknown) => pair.client.send(JSON.stringify(frame)), frames, closed: () => closed, call, welcome: async () => { await until(() => frames.some((f) => f.kind === 'welcome')); return frames.find((f) => f.kind === 'welcome')!; } };
    };
    const connect = (options: Record<string, unknown> = {}, who: Admit = OWNER) => {
        const pair = inMemoryPair();
        accept({ ...pair.server, remoteAddress: 'relay:x', preAuth: who });
        const client = connectRemote(pair.client, { kind: 'relay' }, who.label, options as Parameters<typeof connectRemote>[3]);
        closers.push(() => client.close());
        return client as typeof client & {
            requestHostUpdate(): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }>;
            checkHost(): Promise<unknown>;
        };
    };
    return { raw, connect };
}

const until = async (check: () => boolean, ms = 1000): Promise<void> => {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error('timed out waiting');
        await new Promise<void>((r) => setTimeout(r, 5));
    }
};

/** Settles, or says `hung` after `ms`: a promise that never settles is the failure this story removes. */
const settles = <T>(p: Promise<T>, ms = 500): Promise<{ settled: true; value?: T; error?: unknown } | { settled: false }> =>
    Promise.race([
        p.then((value) => ({ settled: true as const, value }), (error: unknown) => ({ settled: true as const, error })),
        new Promise<{ settled: false }>((r) => setTimeout(() => r({ settled: false }), ms)),
    ]);

type State = { connected: boolean; protocol?: { schema: string; capabilities: readonly string[] } | null; hostUpdate?: { needed: boolean; compatible: boolean; hostSchema: string; hostBuild: string | null; windowDays: number } | null; compatible?: boolean };

describe('the host says its version, window and capabilities in welcome', () => {
    it('welcome carries track, build, schema, the window’s floor and catalog-named capabilities', async () => {
        const c = serve().raw();
        c.send(helloOf(CLIENT));
        const welcome = await c.welcome();
        expect(welcome).toMatchObject({ track: 'host', build: '2026.11.18-1', schema: expect.stringMatching(/^\d{4}\.\d{2}\.\d{2}$/), minSchema: expect.stringMatching(/^\d{4}\.\d{2}\.\d{2}$/) });
        expect(String(welcome.minSchema) <= String(welcome.schema)).toBe(true);
        expect(welcome.capabilities).toEqual(expect.arrayContaining(['unsupported-result@1', `catalog@${CATALOG_SCHEMA_VERSION}`]));
        // The pre-schema field stays for older clients, which read `protocol` and `build` (P10.1e).
        expect(typeof welcome.protocol).toBe('number');
    });

    it('the host’s offer is read at each hello: a capability it gains (a plugin turned on) is in the next welcome', async () => {
        let caps = ['unsupported-result@1'];
        const host = serve({ protocol: () => ({ ...HOST, capabilities: caps }) });
        const first = host.raw();
        first.send(helloOf(CLIENT));
        expect((await first.welcome()).capabilities).toEqual(['unsupported-result@1']);
        caps = ['unsupported-result@1', 'acme.sheets@1'];
        const second = host.raw();
        second.send(helloOf(CLIENT));
        expect((await second.welcome()).capabilities).toEqual(['unsupported-result@1', 'acme.sheets@1']);
    });
});

describe('an unknown method is answered with its id, so nothing hangs', () => {
    it('a client that negotiated unsupported-result gets one id’d result and no connection-level refusal', async () => {
        const c = serve().raw();
        c.send(helloOf(CLIENT));
        await c.welcome();
        const r = await c.call('host.fromTheFuture');
        expect(r).toMatchObject({ ok: false, code: 'unsupported' });
        expect(String(r.reason)).toContain('host.fromTheFuture');
        expect(c.frames.filter((f) => f.kind === 'refused')).toEqual([]);
        expect(c.closed()).toBe(false);
    });

    it('an older client (no versions in hello) still connects, and gets the id’d result after the refusal it knows', async () => {
        const c = serve().raw();
        c.send({ kind: 'hello', auth: { kind: 'relay' } });
        await c.welcome();
        await c.call('host.fromTheFuture');
        const refusedAt = c.frames.findIndex((f) => f.kind === 'refused');
        const resultAt = c.frames.findIndex((f) => f.kind === 'result');
        expect(refusedAt).toBeGreaterThanOrEqual(0);
        expect(c.frames[refusedAt]!.reason).toBe('"host.fromTheFuture" is not a bridge method');
        expect(resultAt).toBeGreaterThan(refusedAt);
        expect(c.closed()).toBe(false);
    });

    it('this client against an OLDER host (id-less refusal) settles the call, and offers the host an update', async () => {
        const { client: end, server } = inMemoryPair();
        server.onMessage((text) => {
            const raw = JSON.parse(text) as { kind: string; method?: string };
            if (raw.kind === 'hello') { server.send(JSON.stringify({ kind: 'welcome', connectionId: 'c1', host: 'aion', isOwner: true, workspaceId: null, protocol: 1, build: '2.0.0-beta.64+0123456789ab' })); return; }
            if (raw.kind === 'call' && raw.method === 'host.home') server.send(JSON.stringify({ kind: 'refused', reason: '"host.home" is not a bridge method' }));
        });
        const client = connectRemote(end, { kind: 'relay', label: 'phone' }, 'phone', { protocol: CLIENT } as Parameters<typeof connectRemote>[3]);
        closers.push(() => client.close());
        expect(await client.ready).toEqual({ ok: true });
        const r = await settles(client.bridge.host!.home!());
        expect(r.settled).toBe(true);
        if (r.settled) expect(String(r.error)).toContain('host.home');
        expect(client.state().connected).toBe(true);
        expect((client.state() as unknown as State).hostUpdate).toMatchObject({ needed: true, compatible: true, hostBuild: '2.0.0-beta.64+0123456789ab' });
    });
});

describe('each side uses only what both support', () => {
    it('the client keeps the older schema and only the capabilities both sides said', async () => {
        const client = serve({ protocol: { ...HOST, schema: '2026.11.10', minSchema: '2026.10.11', capabilities: [...HOST.capabilities, 'genie.only-on-this-host@1'] } }).connect({ protocol: CLIENT });
        expect(await client.ready).toEqual({ ok: true });
        const state = client.state() as unknown as State;
        expect(state.protocol).toEqual({ schema: '2026.11.10', capabilities: [...CLIENT.capabilities].sort() });
        expect(state.hostUpdate).toMatchObject({ needed: true, compatible: true, hostSchema: '2026.11.10', windowDays: 30 });
    });
});

describe('the fixed window: outside it, update-only', () => {
    it('a client older than the host’s window is told so with both schemas, and may only read the version', async () => {
        const c = serve({ protocol: { ...HOST, schema: '2026.12.31', minSchema: '2026.12.01' } }).raw();
        c.send({ kind: 'hello', auth: { kind: 'relay' } });
        const welcome = await c.welcome();
        expect(welcome).toMatchObject({ compatible: false, code: 'version' });
        expect(String(welcome.reason)).toContain('2026.11.01');
        expect(String(welcome.reason)).toContain('2026.12.01');
        const snapshot = await c.call('snapshot');
        expect(snapshot).toMatchObject({ ok: false, code: 'version' });
        expect(String(snapshot.reason)).toContain('2026.12.01');
        expect(await c.call('host.version')).toMatchObject({ ok: true, value: { track: 'host', schema: '2026.12.31', minSchema: '2026.12.01', windowDays: 30 } });
        expect(c.closed()).toBe(false);
    });

    it('a host outside the client’s window: the client is not connected, says why, and can still trigger the host update', async () => {
        const asked: string[] = [];
        const host = serve({ protocol: { ...HOST, schema: '2026.09.30', minSchema: '2026.08.31' }, requestUpdate: async (who) => { asked.push(who.label); return { started: true, reason: 'the launcher is updating alphar' }; } });
        const client = host.connect({ protocol: CLIENT });
        const r = await client.ready;
        expect(r.ok).toBe(false);
        if (!r.ok) { expect(r.reason).toContain('2026.09.30'); expect(r.reason).toContain('2026.10.19'); }
        const state = client.state() as unknown as State;
        expect(state.connected).toBe(false);
        expect(state.hostUpdate).toMatchObject({ needed: true, compatible: false, hostSchema: '2026.09.30' });
        expect(await client.requestHostUpdate()).toEqual({ ok: true, value: { started: true, reason: 'the launcher is updating alphar' } });
        expect(asked).toEqual(['phone']);
    });

    it('the client refuses a host below its own floor even when the host would accept it', async () => {
        const { client: end, server } = inMemoryPair();
        const calls: string[] = [];
        server.onMessage((text) => {
            const raw = JSON.parse(text) as { kind: string; id?: number; method?: string };
            if (raw.kind === 'hello') server.send(JSON.stringify({ kind: 'welcome', connectionId: 'c1', host: 'aion', isOwner: true, workspaceId: null, protocol: 1, build: '2.0.0-beta.64' }));
            if (raw.kind === 'call') { calls.push(raw.method!); server.send(JSON.stringify({ kind: 'result', id: raw.id, ok: true, value: { started: false, stub: true, reason: 'not wired' } })); }
        });
        const client = connectRemote(end, { kind: 'relay', label: 'phone' }, 'phone', { protocol: { ...CLIENT, minSchema: '2026.11.10' } } as Parameters<typeof connectRemote>[3]) as ReturnType<typeof connectRemote> & { requestHostUpdate(): Promise<unknown> };
        closers.push(() => client.close());
        const r = await client.ready;
        expect(r.ok).toBe(false);
        if (!r.ok) { expect(r.reason).toContain('2026.11.01'); expect(r.reason).toContain('2026.11.10'); }
        expect(client.state().connected).toBe(false);
        // Nothing was asked of it but what the person chooses: the update.
        expect(calls).toEqual([]);
        await client.requestHostUpdate();
        expect(calls).toEqual(['host.update']);
    });
});

describe('the client detects and triggers host updates', () => {
    it('at any time while connected: checkHost reads the host’s version and window again', async () => {
        let schema = '2026.11.18';
        const client = serve({ protocol: () => ({ ...HOST, schema, minSchema: '2026.10.19' }) }).connect({ protocol: CLIENT });
        expect(await client.ready).toEqual({ ok: true });
        expect((client.state() as unknown as State).hostUpdate).toMatchObject({ needed: false });
        schema = '2026.11.02';
        await client.checkHost();
        expect((client.state() as unknown as State).hostUpdate).toMatchObject({ needed: true, compatible: true, hostSchema: '2026.11.02' });
    });

    it('without a launcher wired, the host’s answer is the stub, said as such', async () => {
        const client = serve().connect({ protocol: CLIENT });
        expect(await client.ready).toEqual({ ok: true });
        const r = await client.requestHostUpdate();
        expect(r).toMatchObject({ ok: true, value: { started: false, stub: true } });
    });

    it('a share-link guest cannot trigger it', async () => {
        const c = serve({ requestUpdate: async () => ({ started: true, reason: 'x' }) }).raw({ label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: false });
        c.send(helloOf(CLIENT));
        await c.welcome();
        expect(await c.call('host.update')).toMatchObject({ ok: false });
    });
});

describe('conference mode: several people at once, each acting for themselves', () => {
    it('two connections on different schemas each negotiate their own answer', async () => {
        const host = serve();
        const a = host.connect({ protocol: CLIENT }, { ...OWNER, label: 'ada' });
        const b = host.connect({ protocol: { ...CLIENT, schema: '2026.11.05', minSchema: '2026.10.06' } }, { ...OWNER, label: 'bo' });
        expect(await a.ready).toEqual({ ok: true });
        expect(await b.ready).toEqual({ ok: true });
        expect((a.state() as unknown as State).protocol?.schema).toBe('2026.11.18');
        expect((b.state() as unknown as State).protocol?.schema).toBe('2026.11.05');
    });

    it('two owners asking for the update at once start ONE, both are told, and neither needed the baton', async () => {
        let calls = 0;
        let release!: (v: unknown) => void;
        const host = serve({ requestUpdate: () => { calls++; return new Promise((r) => { release = r; }); } });
        const a = host.connect({ protocol: CLIENT }, { ...OWNER, label: 'ada' });
        const b = host.connect({ protocol: CLIENT }, { ...OWNER, label: 'bo' });
        expect(await a.ready).toEqual({ ok: true });
        expect(await b.ready).toEqual({ ok: true });
        // Someone else drives: the update request is not a write that waits on the baton.
        const c = host.connect({ protocol: CLIENT }, { ...OWNER, label: 'cy' });
        expect(await c.ready).toEqual({ ok: true });
        expect(await c.takeBaton()).toEqual({ ok: true });
        const ra = a.requestHostUpdate();
        const rb = b.requestHostUpdate();
        await until(() => calls > 0);
        release({ started: true, reason: 'updating alphar' });
        expect(await ra).toEqual({ ok: true, value: { started: true, reason: 'updating alphar' } });
        expect(await rb).toEqual({ ok: true, value: { started: true, reason: 'updating alphar' } });
        expect(calls).toBe(1);
    });
});

describe('the engine link answers an unknown method with its id too', () => {
    it('genie-host answers a window’s call it does not know, so the window’s call settles', async () => {
        const server = new SessionEngineServer({ token: 'fixture', build: 'fixture' });
        const [h, w] = memoryPair();
        server.accept(h, { local: true });
        closers.push(() => w.close());
        const frames: Array<Record<string, unknown>> = [];
        w.onMessage((text) => { frames.push(JSON.parse(text) as Record<string, unknown>); });
        w.send(JSON.stringify({ kind: 'hello', auth: { kind: 'token', token: 'fixture' } }));
        await until(() => frames.some((f) => f.kind === 'welcome'));
        w.send(JSON.stringify({ kind: 'call', id: 12, method: 'engine.fromTheFuture', args: [] }));
        await until(() => frames.some((f) => f.kind === 'result' && f.id === 12));
        expect(frames.find((f) => f.kind === 'result' && f.id === 12)).toMatchObject({ ok: false, code: 'unsupported' });
    });

    it('the window answers a host call it does not know, so the host’s call settles', async () => {
        const client = new SessionEngineClient();
        const [w, h] = memoryPair();
        const frames: Array<Record<string, unknown>> = [];
        h.onMessage((text) => {
            const m = JSON.parse(text) as Record<string, unknown>;
            frames.push(m);
            if (m.kind === 'hello') {
                h.send(JSON.stringify({ kind: 'welcome', connectionId: 'c1', host: 'h', isOwner: true, workspaceId: null, protocol: ENGINE_PROTOCOL, build: 'fixture', pid: 1 }));
                h.send(JSON.stringify({ kind: 'event', channel: 'engine.ready', payload: null }));
            }
        });
        closers.push(() => h.close());
        expect(await client.connect(w, 'fixture')).toMatchObject({ ok: true });
        h.send(JSON.stringify({ kind: 'call', id: 3, method: 'client.fromTheFuture', args: [] }));
        await until(() => frames.some((f) => f.kind === 'result' && f.id === 3));
        expect(frames.find((f) => f.kind === 'result' && f.id === 3)).toMatchObject({ ok: false, code: 'unsupported' });
    });
});
