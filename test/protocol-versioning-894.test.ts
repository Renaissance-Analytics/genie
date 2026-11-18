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
 * TWO-WAY PROTOCOL VERSIONING (Tynn #894; the owner, 2026-11-18: clients are dumb terminals, and client and host update
 * independently, so the protocol must work across versions in BOTH directions).
 *
 *  - The client says its protocol, the oldest host protocol it accepts and its capabilities in `hello`; the host answers
 *    with its own in `welcome`. Each side uses only what both say (`name@level`, the ADF catalog's own levels).
 *  - A call to a method the other side does not know is answered WITH ITS ID, so the caller's promise settles.
 *  - The security floor: a peer below the minimum is refused, with a reason naming both versions.
 *
 * A peer that says nothing is an older Genie: protocol 1, minimum 1, no capabilities.
 */

let dir: string;
let devices: DeviceStore;
const closers: Array<() => void> = [];

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-894-')); let n = 0; devices = await DeviceStore.open(dir, { now: Date.now, random: () => `d-${++n}` }); });
afterEach(async () => { for (const c of closers.splice(0)) c(); await new Promise<void>((r) => setImmediate(r)); await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

type Offer = { protocol: number; minProtocol: number; capabilities: readonly string[] };

/** A RemoteHost over the in-memory pair; `protocol` overrides the host's own offer (the floor's tests raise it). */
function serve(protocol?: Offer) {
    let accept!: (connection: ServerConnection) => void;
    new RemoteHost({ api: buildHostApi(protocolContractDeps(dir)), hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing, build: '2.0.0-beta.66+0123456789ab',
        transport: { onConnection: (l) => { accept = l; return () => {}; } }, ...(protocol ? { protocol } : {}) } as ConstructorParameters<typeof RemoteHost>[0]);
    /** A raw connection, admitted as the owner's own device through the relay: frames in, frames out, close seen. */
    const raw = () => {
        const pair = inMemoryPair();
        const frames: Array<Record<string, unknown>> = [];
        let closed = false;
        pair.client.onMessage((text) => { frames.push(JSON.parse(text) as Record<string, unknown>); });
        pair.client.onClose(() => { closed = true; });
        accept({ ...pair.server, remoteAddress: 'relay:x', preAuth: { label: 'phone', isOwner: true, workspaceId: null, readonly: false } });
        closers.push(() => pair.client.close());
        return { send: (frame: unknown) => pair.client.send(JSON.stringify(frame)), frames, closed: () => closed };
    };
    const connect = (options: Record<string, unknown> = {}) => {
        const pair = inMemoryPair();
        accept({ ...pair.server, remoteAddress: 'relay:x', preAuth: { label: 'phone', isOwner: true, workspaceId: null, readonly: false } });
        const client = connectRemote(pair.client, { kind: 'relay' }, 'phone', options as Parameters<typeof connectRemote>[3]);
        closers.push(() => client.close());
        return client;
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

describe('the host says its protocol range and capabilities in welcome', () => {
    it('welcome carries protocol, minProtocol and capabilities named as the ADF catalog names its levels', async () => {
        const c = serve().raw();
        c.send({ kind: 'hello', auth: { kind: 'relay' }, protocol: 2, minProtocol: 1, capabilities: ['unsupported-result@1'] });
        await until(() => c.frames.some((f) => f.kind === 'welcome'));
        const welcome = c.frames.find((f) => f.kind === 'welcome')!;
        expect(typeof welcome.protocol).toBe('number');
        expect(welcome.minProtocol).toBeLessThanOrEqual(welcome.protocol as number);
        expect(welcome.capabilities).toEqual(expect.arrayContaining(['unsupported-result@1', `catalog@${CATALOG_SCHEMA_VERSION}`]));
    });
});

describe('an unknown method is answered with its id, so nothing hangs', () => {
    it('a client that negotiated unsupported-result gets one id’d result and no connection-level refusal', async () => {
        const c = serve().raw();
        c.send({ kind: 'hello', auth: { kind: 'relay' }, protocol: 2, minProtocol: 1, capabilities: ['unsupported-result@1'] });
        await until(() => c.frames.some((f) => f.kind === 'welcome'));
        c.send({ kind: 'call', id: 41, method: 'host.fromTheFuture', args: [] });
        await until(() => c.frames.some((f) => f.kind === 'result' && f.id === 41));
        expect(c.frames.find((f) => f.kind === 'result' && f.id === 41)).toMatchObject({ ok: false, code: 'unsupported' });
        expect(String(c.frames.find((f) => f.kind === 'result' && f.id === 41)!.reason)).toContain('host.fromTheFuture');
        expect(c.frames.filter((f) => f.kind === 'refused')).toEqual([]);
        expect(c.closed()).toBe(false);
    });

    it('an older client (no versions in hello) still connects, and also gets the id’d result after the refusal it knows', async () => {
        const c = serve().raw();
        c.send({ kind: 'hello', auth: { kind: 'relay' } });
        await until(() => c.frames.some((f) => f.kind === 'welcome'));
        c.send({ kind: 'call', id: 7, method: 'host.fromTheFuture', args: [] });
        await until(() => c.frames.some((f) => f.kind === 'result' && f.id === 7));
        // The legacy refusal first, so an older client's own skew check still reads it; then the result that settles it.
        const refusedAt = c.frames.findIndex((f) => f.kind === 'refused');
        const resultAt = c.frames.findIndex((f) => f.kind === 'result' && f.id === 7);
        expect(refusedAt).toBeGreaterThanOrEqual(0);
        expect(c.frames[refusedAt]!.reason).toBe('"host.fromTheFuture" is not a bridge method');
        expect(resultAt).toBeGreaterThan(refusedAt);
        expect(c.closed()).toBe(false);
    });

    it('this client against an OLDER host (id-less refusal) settles the call instead of hanging', async () => {
        // The host as beta.64 is: a welcome with protocol 1 and no capabilities; an unknown method is a bare `refused`.
        const { client: end, server } = inMemoryPair();
        server.onMessage((text) => {
            const raw = JSON.parse(text) as { kind: string; id?: number; method?: string };
            if (raw.kind === 'hello') { server.send(JSON.stringify({ kind: 'welcome', connectionId: 'c1', host: 'aion', isOwner: true, workspaceId: null, protocol: 1, build: '2.0.0-beta.64+0123456789ab' })); return; }
            if (raw.kind === 'call' && raw.method === 'host.home') server.send(JSON.stringify({ kind: 'refused', reason: '"host.home" is not a bridge method' }));
        });
        const client = connectRemote(end, { kind: 'relay', label: 'phone' }, 'phone');
        closers.push(() => client.close());
        expect(await client.ready).toEqual({ ok: true });
        const r = await settles(client.bridge.host!.home!());
        expect(r.settled).toBe(true);
        if (r.settled) expect(String(r.error)).toContain('host.home');
        expect(client.state().connected).toBe(true);
    });
});

describe('each side uses only what both support', () => {
    it('the client keeps the negotiated protocol and only the capabilities both sides said', async () => {
        const client = serve({ protocol: 2, minProtocol: 1, capabilities: ['unsupported-result@1', `catalog@${CATALOG_SCHEMA_VERSION}`, 'genie.only-on-this-host@1'] }).connect();
        expect(await client.ready).toEqual({ ok: true });
        const state = client.state() as unknown as { protocol?: { protocol: number; capabilities: readonly string[] } };
        expect(state.protocol?.protocol).toBe(2);
        expect(state.protocol?.capabilities).toContain('unsupported-result@1');
        expect(state.protocol?.capabilities).not.toContain('genie.only-on-this-host@1');
    });
});

describe('the security floor', () => {
    it('a hello below the host’s minimum is refused with a reason naming both versions, and the connection closes', async () => {
        const c = serve({ protocol: 3, minProtocol: 3, capabilities: [] }).raw();
        c.send({ kind: 'hello', auth: { kind: 'relay' } });
        await until(() => c.frames.some((f) => f.kind === 'refused'));
        const refused = c.frames.find((f) => f.kind === 'refused')!;
        expect(refused.code).toBe('version');
        expect(String(refused.reason)).toMatch(/\b1\b/);
        expect(String(refused.reason)).toMatch(/\b3\b/);
        expect(c.frames.some((f) => f.kind === 'welcome')).toBe(false);
        await until(() => c.closed());
    });

    it('a client that needs a newer host than this one is refused by the host in words, not left to guess', async () => {
        const c = serve().raw();
        c.send({ kind: 'hello', auth: { kind: 'relay' }, protocol: 9, minProtocol: 9, capabilities: [] });
        await until(() => c.frames.some((f) => f.kind === 'refused'));
        const refused = c.frames.find((f) => f.kind === 'refused')!;
        expect(refused.code).toBe('version');
        expect(String(refused.reason)).toContain('9');
        expect(c.frames.some((f) => f.kind === 'welcome')).toBe(false);
    });

    it('the client refuses a host below its own minimum, with the reason, and does not connect', async () => {
        const { client: end, server } = inMemoryPair();
        server.onMessage((text) => {
            const raw = JSON.parse(text) as { kind: string };
            if (raw.kind === 'hello') server.send(JSON.stringify({ kind: 'welcome', connectionId: 'c1', host: 'aion', isOwner: true, workspaceId: null, protocol: 1, build: '2.0.0-beta.64' }));
        });
        const client = connectRemote(end, { kind: 'relay', label: 'phone' }, 'phone', { protocol: { protocol: 4, minProtocol: 4, capabilities: [] } } as Parameters<typeof connectRemote>[3]);
        closers.push(() => client.close());
        const r = await client.ready;
        expect(r.ok).toBe(false);
        if (!r.ok) { expect(r.reason).toMatch(/\b1\b/); expect(r.reason).toMatch(/\b4\b/); }
        expect(client.state().connected).toBe(false);
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
