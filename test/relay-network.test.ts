import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins, ShareLinks } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type ClientTransport, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { verifyMemberGrant, type TynnJwk } from '../src/main/relay-grant.js';
import { relayHostLink } from '../src/main/relay-host.js';
import { openRelayMember, PopKeypair } from '../src/main/relay-member.js';
import { buildTicketHostHello, type RelaySocket } from '../src/main/relay-wire.js';

/**
 * THE TYNN NETWORK OVER THE RELAY (Tynn #837 + #838; Genie 1's relay wire, unchanged — the owner, 2026-10-19: "Port
 * Tynn network"). A Genie 2 host keeps one link to the relay, proved by a Tynn ticket and its enrolled key; a member
 * dials the relay with a Tynn grant; the host checks the grant (Tynn's signature, audience, expiry, still active) and
 * the member's proof of possession of the key the grant is bound to, and only then does Genie 2's own protocol run —
 * over `rest` data frames, which the relay forwards reliably and never reads.
 *
 * The relay here is in memory and follows genie-cloud's `src/relay-server/server.ts` + `router.ts` + `registry.ts`
 * rule for rule: host-hello → host-welcome; member-hello → no-host error, or member-welcome + a control `open {grant}`
 * to the host; member frames stamped with the relay's own sid; a host control close/error delivered then the session
 * dropped; a member leaving → a control close to the host. The signing strings and the thumbprint are written out
 * literally here, NOT imported, so a drift in the port fails these tests.
 */

const WS_ID = 'ws_host_1';

// ---------------------------------------------------------------- Tynn: its grant key, and the host's enrolled key
const tynnKey = generateKeyPairSync('ed25519');
const tynnJwk = { ...(tynnKey.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string }), kid: 'tynn-1', alg: 'EdDSA' } as TynnJwk;
const hostKey = generateKeyPairSync('ed25519');
const hostFingerprint = createHash('sha256').update(hostKey.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

/** RFC 7638 thumbprint of an Ed25519 OKP JWK — written out, not imported. */
const thumbprint = (jwk: { crv: string; kty: string; x: string }) =>
    createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`, 'utf8').digest('base64url');

function mintGrant(claims: Record<string, unknown>, key: KeyObject = tynnKey.privateKey, kid = 'tynn-1'): string {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = b64({ alg: 'EdDSA', typ: 'wsgrant+jwt', kid });
    const body = b64({ aud: WS_ID, exp: Math.floor(Date.now() / 1000) + 300, jti: 'g1', sub: 'user_1', name: 'Pat', ...claims });
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}

// ---------------------------------------------------------------- the relay, as genie-cloud runs it
interface FakeSocket extends RelaySocket {
    readonly url: string;
    deliver(text: string): void;
    drop(): void;
}

function fakeRelay() {
    const log: string[] = [];
    const hosts = new Map<string, FakeSocket>();
    const sessions = new Map<string, { workstationId: string; member: FakeSocket }>();
    const helloOf = new Map<FakeSocket, string | null>();
    let nextSid = 0;

    const verifyHost = (hello: Record<string, unknown>): string | null => {
        // createTynnEnrollmentVerifier: the ticket names the workstation; the hello is signed by its enrolled key.
        if (hello.ticket !== 'ticket-1' || hello.workstationId !== WS_ID) return null;
        const signed = `genie-relay-host-hello\n${String(hello.workstationId)}.${String(hello.fingerprint)}.${String(hello.nonce)}.${String(hello.ts)}`;
        return verify(null, Buffer.from(signed), hostKey.publicKey, Buffer.from(String(hello.sig), 'base64url')) ? WS_ID : null;
    };

    const dropSession = (sid: string) => {
        const s = sessions.get(sid);
        if (!s) return;
        sessions.delete(sid);
        s.member.drop();
    };

    const onMessage = (socket: FakeSocket, text: string) => {
        const path = new URL(socket.url).pathname;
        const msg = JSON.parse(text) as Record<string, unknown>;
        if (path === '/ws/host') {
            if (helloOf.get(socket) === undefined) {
                const id = msg.type === 'host-hello' ? verifyHost(msg) : null;
                if (!id) { log.push('host refused'); socket.deliver(JSON.stringify({ type: 'error', code: 'enroll', reason: 'denied' })); socket.drop(); return; }
                helloOf.set(socket, id);
                hosts.set(id, socket);
                log.push(`host ${id} registered`);
                socket.deliver(JSON.stringify({ type: 'host-welcome', workstationId: id }));
                return;
            }
            const s = sessions.get(String(msg.sid));
            if (!s) return;
            s.member.deliver(text);
            if (msg.channel === 'control' && (msg.kind === 'close' || msg.kind === 'error')) dropSession(String(msg.sid));
            return;
        }
        // /ws/member
        const sid = [...sessions].find(([, s]) => s.member === socket)?.[0];
        if (!sid) {
            if (msg.type !== 'member-hello') { socket.drop(); return; }
            const host = hosts.get(String(msg.workstationId));
            if (!host) { socket.deliver(JSON.stringify({ type: 'error', code: 'no-host', reason: 'workstation not connected' })); socket.drop(); return; }
            const fresh = `sid_${++nextSid}`;
            sessions.set(fresh, { workstationId: String(msg.workstationId), member: socket });
            socket.deliver(JSON.stringify({ type: 'member-welcome', sid: fresh }));
            host.deliver(JSON.stringify({ kind: 'open', channel: 'control', sid: fresh, payload: { grant: msg.grant } }));
            return;
        }
        // Stamp the authoritative sid: a member cannot speak for another session.
        hosts.get(sessions.get(sid)!.workstationId)?.deliver(JSON.stringify({ ...msg, sid }));
    };

    const onClosed = (socket: FakeSocket) => {
        const path = new URL(socket.url).pathname;
        if (path === '/ws/host') {
            const id = helloOf.get(socket);
            if (id && hosts.get(id) === socket) {
                hosts.delete(id);
                for (const [sid, s] of [...sessions]) if (s.workstationId === id) dropSession(sid);
            }
            return;
        }
        const sid = [...sessions].find(([, s]) => s.member === socket)?.[0];
        if (!sid) return;
        const s = sessions.get(sid)!;
        sessions.delete(sid);
        hosts.get(s.workstationId)?.deliver(JSON.stringify({ kind: 'close', channel: 'control', sid, reason: 'member left' }));
    };

    const socket = (url: string): FakeSocket => {
        let closed = false;
        const s: FakeSocket = {
            url,
            readyState: 0,
            onopen: null,
            onmessage: null,
            onclose: null,
            onerror: null,
            send: (data) => { if (!closed) queueMicrotask(() => onMessage(s, data)); },
            close: () => { s.drop(); },
            // As a real socket: what arrived before the close is delivered before it (the close is queued after).
            deliver: (text) => { if (!closed) queueMicrotask(() => s.onmessage?.({ data: text })); },
            drop: () => {
                if (closed) return;
                closed = true;
                (s as { readyState: number }).readyState = 3;
                queueMicrotask(() => { s.onclose?.({}); onClosed(s); });
            },
        };
        queueMicrotask(() => { if (closed) return; (s as { readyState: number }).readyState = 1; s.onopen?.({}); });
        return s;
    };
    return { socket, log, hosts, sessions };
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

// ---------------------------------------------------------------- a Genie 2 host behind the link
const snapshot = {
    agents: [{ id: 'agent_a', name: 'atlas', workspaceId: 'tynn' }, { id: 'agent_b', name: 'bolt', workspaceId: 'fancy' }],
    workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }, { id: 'fancy', path: '/w/fancy', agentsKnown: true }],
    deckItems: [],
    signals: {},
};
const api: HostApi = {
    invoke: async (method) => (method === 'snapshot' ? snapshot : { ok: true }),
    onEvent: () => () => {},
    workspaceOfAgent: (id) => snapshot.agents.find((a) => a.id === id)?.workspaceId ?? null,
};

function wireClient(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    return {
        hello: async (auth: unknown) => { t.send(JSON.stringify({ kind: 'hello', auth, label: 'laptop' })); return next(); },
        call: async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next(); },
    };
}

let dir: string;
let relay: ReturnType<typeof fakeRelay>;
let link: ReturnType<typeof relayHostLink>;
let active: Set<string>;
let tickets: number;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-relay-'));
    relay = fakeRelay();
    active = new Set(['g1']);
    tickets = 0;
    link = relayHostLink({
        socket: relay.socket,
        relayUrl: 'wss://relay.example.com',
        workstationId: WS_ID,
        hello: async () => { tickets++; return buildTicketHostHello({ ticket: 'ticket-1', workstationId: WS_ID, fingerprint: hostFingerprint, sign: (d) => sign(null, d, hostKey.privateKey) }); },
        validateGrant: async (token) => {
            const check = verifyMemberGrant(token, { keys: [tynnJwk], workstationId: WS_ID });
            return check.ok && !active.has(check.grant.jti) ? { ok: false, reason: 'grant is no longer active' } : check;
        },
        reconnect: { minMs: 0, maxMs: 0 },
        popTimeoutMs: 1_000,
    });
    new RemoteHost({
        api,
        hostName: 'alphar',
        baton: new Baton(),
        pins: new PairingPins({ now: Date.now, random: Math.random }),
        shares: new ShareLinks({ host: 'alphar.invalid:7421', now: Date.now, random: () => 'sekrit' }),
        devices: await DeviceStore.open(dir, { now: Date.now, random: () => 'tok' }),
        transport: link,
    });
    link.connect();
    await settle();
});

afterEach(async () => {
    link.close();
    await rm(dir, { recursive: true, force: true });
});

async function member(claims: Record<string, unknown>, opts: { bind?: boolean; prove?: PopKeypair } = {}) {
    const pop = PopKeypair.generate();
    const bound = opts.bind === false ? {} : { cnf: { jkt: thumbprint(pop.publicJwk) } };
    const opened = await openRelayMember({ socket: relay.socket, relayUrl: 'wss://relay.example.com', workstationId: WS_ID, grant: mintGrant({ ...bound, ...claims }), pop: opts.prove ?? pop });
    return opened;
}

describe('the host link', () => {
    it('registers with the relay by a Tynn ticket, signed by the ENROLLED key', () => {
        expect(relay.log).toEqual([`host ${WS_ID} registered`]);
        expect(link.state()).toBe('open');
        expect(tickets).toBe(1);
    });
});

describe('a member over the relay', () => {
    it('the OWNER’s grant, key proved: Genie’s own hello over the relay is welcomed as the owner, and calls work', async () => {
        const opened = await member({ src: 'owner', cap: 'control', scope: ['host:all'] });
        expect(opened.ok).toBe(true);
        const c = wireClient((opened as { transport: ClientTransport }).transport);
        expect(await c.hello({ kind: 'relay' })).toMatchObject({ kind: 'welcome', host: 'alphar', isOwner: true, workspaceId: null });
        const snap = await c.call('snapshot');
        expect(snap).toMatchObject({ kind: 'result', ok: true });
        expect(((snap as { value: typeof snapshot }).value.agents)).toHaveLength(2);
    });

    it('a share of ONE workspace: a guest scoped to it — the other workspace is refused by name', async () => {
        const opened = await member({ src: 'invite', cap: 'control', scope: ['workspace:tynn'] });
        const c = wireClient((opened as { transport: ClientTransport }).transport);
        expect(await c.hello({ kind: 'relay' })).toMatchObject({ kind: 'welcome', isOwner: false, workspaceId: 'tynn' });
        const snap = (await c.call('snapshot')) as { value: typeof snapshot };
        expect(snap.value.agents.map((a) => a.id)).toEqual(['agent_a']);
        expect(await c.call('baton.take')).toMatchObject({ ok: true });
        // CONTROL: a write inside the workspace goes through, so the refusal below is the scope's.
        expect(await c.call('openAgent', 'agent_a')).toMatchObject({ ok: true });
        expect(await c.call('openAgent', 'agent_b')).toMatchObject({ ok: false, reason: 'agent_b is not in the workspace this link shares' });
    });

    // The same write by a CONTROL grant to the same workspace goes through (the test above) — so this refusal is read-only's.
    it('a READ-ONLY grant: reads work, a write is refused', async () => {
        const opened = await member({ src: 'invite', cap: 'readonly', scope: ['workspace:tynn'] }, { bind: false });
        const c = wireClient((opened as { transport: ClientTransport }).transport);
        await c.hello({ kind: 'relay' });
        expect(await c.call('snapshot')).toMatchObject({ ok: true });
        // Nor the baton: holding it would stop everyone who can write.
        expect(await c.call('baton.take')).toMatchObject({ ok: false, reason: 'Pat has read-only access to alphar' });
        expect(await c.call('openAgent', 'agent_a')).toMatchObject({ ok: false, reason: 'Pat has read-only access to alphar' });
    });

    it('a guest of the WHOLE host cannot change the host itself (CONTROL: the owner can)', async () => {
        const guest = wireClient(((await member({ src: 'grant', cap: 'control', scope: ['host:all'] })) as { transport: ClientTransport }).transport);
        expect(await guest.hello({ kind: 'relay' })).toMatchObject({ kind: 'welcome', isOwner: false, workspaceId: null });
        expect(await guest.call('baton.take')).toMatchObject({ ok: true });
        expect(await guest.call('openAgent', 'agent_b')).toMatchObject({ ok: true });
        expect(await guest.call('features.act', { kind: 'remote.lock' })).toMatchObject({ ok: false, reason: 'features.act changes alphar itself; only its owner can' });
        expect(await guest.call('baton.release')).toMatchObject({ ok: true });
        const owner = wireClient(((await member({ src: 'owner', cap: 'control', scope: ['host:all'] })) as { transport: ClientTransport }).transport);
        await owner.hello({ kind: 'relay' });
        await owner.call('baton.take');
        expect(await owner.call('features.act', { kind: 'remote.lock' })).toMatchObject({ ok: true });
    });

    it('a grant naming SEVERAL workspaces is refused in words (this Genie scopes a guest to one)', async () => {
        const opened = await member({ src: 'invite', cap: 'control', scope: ['workspace:tynn', 'workspace:fancy'] });
        const c = wireClient((opened as { transport: ClientTransport }).transport);
        const t = (opened as { transport: ClientTransport & { closedBecause(): string | null } }).transport;
        void c.hello({ kind: 'relay' });
        await settle();
        expect(t.closedBecause()).toMatch(/one workspace/);
    });

    it.each([
        ['signed by another key', () => mintGrant({ src: 'owner', cap: 'control', scope: ['host:all'] }, generateKeyPairSync('ed25519').privateKey), 'signature verification failed'],
        ['for another workstation', () => mintGrant({ src: 'owner', cap: 'control', scope: ['host:all'], aud: 'ws_other' }), 'grant audience mismatch'],
        ['expired', () => mintGrant({ src: 'owner', cap: 'control', scope: ['host:all'], exp: Math.floor(Date.now() / 1000) - 3600 }), 'grant expired'],
    ])('a grant %s is refused before Genie’s protocol is reached', async (_name, grant, reason) => {
        const pop = PopKeypair.generate();
        const opened = await openRelayMember({ socket: relay.socket, relayUrl: 'wss://relay.example.com', workstationId: WS_ID, grant: grant(), pop });
        const t = (opened as { transport: ClientTransport & { closedBecause(): string | null } }).transport;
        const c = wireClient(t);
        void c.hello({ kind: 'relay' });
        await settle();
        expect(t.closedBecause()).toBe(reason);
    });

    it('the WRONG key proved: refused (the grant alone is not enough)', async () => {
        const opened = await member({ src: 'owner', cap: 'control', scope: ['host:all'] }, { prove: PopKeypair.generate() });
        const t = (opened as { transport: ClientTransport & { closedBecause(): string | null } }).transport;
        await settle();
        expect(t.closedBecause()).toBe('proof key does not match the grant binding');
    });

    it('a CONTROL grant with no key binding is refused', async () => {
        const opened = await member({ src: 'owner', cap: 'control', scope: ['host:all'] }, { bind: false });
        const t = (opened as { transport: ClientTransport & { closedBecause(): string | null } }).transport;
        await settle();
        expect(t.closedBecause()).toMatch(/proof-of-possession/);
    });

    it('a grant REVOKED in Tynn ends the session at the next revalidation', async () => {
        const opened = await member({ src: 'owner', cap: 'control', scope: ['host:all'] });
        const t = (opened as { transport: ClientTransport & { closedBecause(): string | null } }).transport;
        const c = wireClient(t);
        await c.hello({ kind: 'relay' });
        active.delete('g1');
        await link.revalidate();
        await settle();
        expect(t.closedBecause()).toBe('grant is no longer active');
    });

    it('no host on the relay: the member is told so', async () => {
        link.close();
        await settle();
        expect(await member({ src: 'owner', cap: 'control', scope: ['host:all'] })).toEqual({ ok: false, reason: 'workstation not connected' });
    });
});

describe('the relay hello is the TRANSPORT’s to grant', () => {
    it('a `relay` hello on a connection the relay did not admit is refused (a tailnet socket cannot claim it)', async () => {
        const connections: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
        new RemoteHost({
            api,
            hostName: 'alphar',
            baton: new Baton(),
            pins: new PairingPins({ now: Date.now, random: Math.random }),
            shares: new ShareLinks({ host: 'alphar.invalid:7421', now: Date.now, random: () => 'sekrit' }),
            devices: await DeviceStore.open(dir, { now: Date.now, random: () => 'tok' }),
            transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } },
        });
        const pair = inMemoryPair();
        for (const cb of connections) cb(pair.server);
        const c = wireClient(pair.client);
        expect(await c.hello({ kind: 'relay' })).toMatchObject({ kind: 'refused' });
    });
});

describe('the wire, byte for byte', () => {
    it('the member’s proof signs SHA-256(nonce ‖ workstationId ‖ sid) with the bound key', () => {
        const pop = PopKeypair.generate();
        const proof = pop.prove('abc123', WS_ID, 'sid_9');
        const digest = createHash('sha256').update(Buffer.from(`abc123${WS_ID}sid_9`, 'utf8')).digest();
        const key = createPublicKey({ key: pop.publicJwk as never, format: 'jwk' });
        expect(verify(null, digest, key, Buffer.from(proof.sig, 'base64url'))).toBe(true);
        expect(proof.jwk).toEqual(pop.publicJwk);
    });
});
