import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConnection } from '../src/core/remote-protocol.js';
import { verifyMemberGrant, type TynnJwk } from '../src/main/relay-grant.js';
import { relayHostLink } from '../src/main/relay-host.js';
import { openRelayMember, PopKeypair, type RelayMemberTransport } from '../src/main/relay-member.js';
import { buildTicketHostHello, type PopJwk } from '../src/main/relay-wire.js';
import { mintConnectGrant } from '../src/main/tynn-network.js';
import { fakeRelay } from './relay-fake.js';

/**
 * A SHARE-LINK GUEST'S ONE SESSION LASTS WHILE THE GUEST STAYS (genie#1401; tynn.ai #394, the owner 2026-11-01: a link
 * is one session). Tynn's grants live 15 minutes, and Tynn re-mints from a link pass only while its session is live: a
 * grant minted from it, or introspected by the host, within 120 s. So the member must fetch a fresh grant during the
 * session, and the host must take it without dropping the session; once the guest has gone for 120 s, the pass is spent
 * and a reconnect is refused (404).
 *
 * Tynn here follows `tynn:app/Services/Workstations/ShareLinkPass.php` rule for rule; the clock is vitest's.
 */

const WS_ID = 'ws_host_1';
const RELAY = 'wss://relay.example.com';
const GRANT_TTL_S = 900;
const SESSION_GRACE_MS = 120_000;

const tynnKey = generateKeyPairSync('ed25519');
const tynnJwk = { ...(tynnKey.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string }), kid: 'tynn-1', alg: 'EdDSA' } as TynnJwk;
const hostKey = generateKeyPairSync('ed25519');
const hostFingerprint = createHash('sha256').update(hostKey.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const thumbprint = (jwk: { crv: string; kty: string; x: string }) =>
    createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`, 'utf8').digest('base64url');

function signGrant(claims: Record<string, unknown>): string {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = b64({ alg: 'EdDSA', typ: 'wsgrant+jwt', kid: 'tynn-1' });
    const body = b64({ aud: WS_ID, exp: Math.floor(Date.now() / 1000) + GRANT_TTL_S, sub: 'guest_1', name: 'Sam', aud_role: 'pilot', src: 'share', share_origin: 'link', cap: 'control', scope: ['workspace:tynn'], ...claims });
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), tynnKey.privateKey).toString('base64url')}`;
}

const verifyHost = (hello: Record<string, unknown>): string | null => {
    if (hello.ticket !== 'ticket-1' || hello.workstationId !== WS_ID) return null;
    const signed = `genie-relay-host-hello\n${String(hello.workstationId)}.${String(hello.fingerprint)}.${String(hello.nonce)}.${String(hello.ts)}`;
    return verify(null, Buffer.from(signed), hostKey.publicKey, Buffer.from(String(hello.sig), 'base64url')) ? WS_ID : null;
};

/** Tynn's share-link pass (ShareLinkPass.php): one claimed link, one session, live while seen within the grace. */
function fakeTynn() {
    const grants = new Map<string, { mintedAt: number; lastSeen: number; revoked: boolean }>();
    let ended = false;
    let revoked = false;
    let next = 0;
    const mints: number[] = [];
    /** Override what a mint signs, to play a Tynn that hands out a different grant. */
    let claims: (pop: PopJwk) => Record<string, unknown> = (pop) => ({ cnf: { jkt: thumbprint(pop) } });
    const usable = (): boolean => {
        if (revoked || ended) return false;
        if (grants.size === 0) return true;
        const last = Math.max(...[...grants.values()].map((g) => Math.max(g.mintedAt, g.lastSeen)));
        if (last + SESSION_GRACE_MS > Date.now()) return true;
        ended = true;
        for (const g of grants.values()) g.revoked = true;
        return false;
    };
    const request = async (path: string, init: { method: string; body?: unknown }) => {
        if (!path.endsWith('/connect-grant') || init.method !== 'POST') return { ok: false, status: 404, json: async () => ({}) };
        mints.push(Date.now());
        if (!usable()) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
        const jti = `g${++next}`;
        grants.set(jti, { mintedAt: Date.now(), lastSeen: 0, revoked: false });
        const token = signGrant({ jti, ...claims((init.body as { pop_jwk: PopJwk }).pop_jwk) });
        return { ok: true, status: 201, json: async () => ({ token, relay_endpoint: RELAY }) };
    };
    const introspect = (token: string): boolean => {
        const jti = (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { jti: string }).jti;
        const g = grants.get(jti);
        if (!g) return false;
        // Judged BEFORE it counts as a heartbeat (WorkstationHostController::introspect).
        const honoured = usable();
        g.lastSeen = Date.now();
        return honoured && !g.revoked;
    };
    return {
        request,
        introspect,
        mints,
        revokeLink: () => { revoked = true; for (const g of grants.values()) g.revoked = true; },
        signs: (fn: typeof claims) => { claims = fn; },
    };
}

let relay: ReturnType<typeof fakeRelay>;
let link: ReturnType<typeof relayHostLink>;
let tynn: ReturnType<typeof fakeTynn>;
let connections: ServerConnection[];
const ended: string[] = [];

/** Let queued frames land (microtasks), without moving the clock. */
const settle = async () => { for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0); };

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    relay = fakeRelay(verifyHost);
    tynn = fakeTynn();
    connections = [];
    ended.length = 0;
    link = relayHostLink({
        socket: relay.socket,
        relayUrl: RELAY,
        workstationId: WS_ID,
        hello: async () => buildTicketHostHello({ ticket: 'ticket-1', workstationId: WS_ID, fingerprint: hostFingerprint, sign: (d) => sign(null, d, hostKey.privateKey) }),
        validateGrant: async (token) => {
            const check = verifyMemberGrant(token, { keys: [tynnJwk], workstationId: WS_ID });
            if (!check.ok) return check;
            return tynn.introspect(token) ? check : { ok: false, reason: 'grant is no longer active' };
        },
        revalidateMs: 30_000,
        reconnect: { minMs: 0, maxMs: 0 },
        popTimeoutMs: 1_000,
        log: (m) => ended.push(m),
    });
    link.onConnection((c) => connections.push(c));
    link.connect();
    await settle();
});

afterEach(() => {
    link.close();
    vi.useRealTimers();
});

/** A guest connects the way main's `genie:relay-open` does: a grant for this connection's key, then the relay. */
async function guest(opts: { renew?: boolean } = {}): Promise<{ transport: RelayMemberTransport; pop: PopKeypair }> {
    const pop = PopKeypair.generate();
    const grant = await mintConnectGrant(tynn.request, WS_ID, pop.publicJwk);
    if (!grant.ok) throw new Error(grant.reason);
    const opening = openRelayMember({
        socket: relay.socket, relayUrl: grant.relayEndpoint, workstationId: WS_ID, grant: grant.token, pop,
        ...(opts.renew === false ? {} : { renew: () => mintConnectGrant(tynn.request, WS_ID, pop.publicJwk) }),
    });
    await settle();
    const opened = await opening;
    if (!opened.ok) throw new Error(opened.reason);
    await settle();
    return { transport: opened.transport, pop };
}

/** Whether a message the guest sends still reaches the host's side of the session. */
async function stillConnected(t: RelayMemberTransport): Promise<boolean> {
    const c = connections.at(-1);
    if (!c) return false;
    const got: string[] = [];
    const off = c.onMessage((text) => got.push(text));
    t.send('ping');
    await settle();
    off();
    return got.includes('ping') && t.closedBecause() === null;
}

describe('a share-link session past its first grant (genie#1401)', () => {
    it('keeps working for 40 minutes: the member renews before each expiry and the host takes the renewal', async () => {
        const { transport } = await guest();
        let closed = false;
        connections.at(-1)!.onClose(() => { closed = true; });
        await vi.advanceTimersByTimeAsync(40 * 60_000);
        await settle();
        expect(closed).toBe(false);
        expect(await stillConnected(transport)).toBe(true);
        // Fresh grants were fetched during the session, each before the one in use expired.
        expect(tynn.mints.length).toBeGreaterThanOrEqual(3);
        for (let i = 1; i < tynn.mints.length; i++) expect(tynn.mints[i]! - tynn.mints[i - 1]!).toBeLessThan(GRANT_TTL_S * 1000);
        expect(connections).toHaveLength(1);
    });

    it('CONTROL: a member that does not renew is dropped by the host once its grant expires', async () => {
        const { transport } = await guest({ renew: false });
        expect(await stillConnected(transport)).toBe(true);
        await vi.advanceTimersByTimeAsync(20 * 60_000);
        await settle();
        expect(transport.closedBecause()).toBe('grant expired');
    });

    it('after the guest disconnects, no more grants are fetched, and 120 s later a reconnect is refused (404)', async () => {
        const { transport } = await guest();
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        transport.close();
        await settle();
        const before = tynn.mints.length;
        // Well past when the next renewal would have come.
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(tynn.mints.length).toBe(before);
        const again = await mintConnectGrant(tynn.request, WS_ID, PopKeypair.generate().publicJwk);
        expect(again).toMatchObject({ ok: false, refusedByTynn: true });
    });

    it('CONTROL: a reconnect inside the 120 s grace is still the one session, and is let in', async () => {
        const { transport } = await guest();
        transport.close();
        await settle();
        await vi.advanceTimersByTimeAsync(60_000);
        const again = await mintConnectGrant(tynn.request, WS_ID, PopKeypair.generate().publicJwk);
        expect(again.ok).toBe(true);
    });

    it('revoking the link ends the live session at once when the host re-checks, without waiting for the timer', async () => {
        const { transport } = await guest();
        tynn.revokeLink();
        await link.revalidate();
        await settle();
        expect(transport.closedBecause()).toBe('grant is no longer active');
    });
});

describe('what the host accepts as a renewal', () => {
    it('a renewed grant bound to a DIFFERENT key ends the session (the proof was made with the first key)', async () => {
        const { transport } = await guest();
        tynn.signs(() => ({ cnf: { jkt: thumbprint(PopKeypair.generate().publicJwk) } }));
        await vi.advanceTimersByTimeAsync(14 * 60_000);
        await settle();
        expect(transport.closedBecause()).toMatch(/renew/);
    });

    it('a renewed grant that WIDENS the scope ends the session (a renewal never changes who the guest is)', async () => {
        const { transport } = await guest();
        tynn.signs((pop) => ({ cnf: { jkt: thumbprint(pop) }, scope: ['host:all'] }));
        await vi.advanceTimersByTimeAsync(14 * 60_000);
        await settle();
        expect(transport.closedBecause()).toMatch(/renew/);
    });

    it('a renewed grant for SOMEONE ELSE ends the session', async () => {
        const { transport } = await guest();
        tynn.signs((pop) => ({ cnf: { jkt: thumbprint(pop) }, sub: 'guest_2' }));
        await vi.advanceTimersByTimeAsync(14 * 60_000);
        await settle();
        expect(transport.closedBecause()).toMatch(/renew/);
    });
});
