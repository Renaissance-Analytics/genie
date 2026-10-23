import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    connectableWorkstations,
    grantValidator,
    mintConnectGrant,
    relayHostPorts,
    startRelayHost,
    type RelayHostStatus,
} from '../src/main/tynn-network.js';
import { PopKeypair } from '../src/main/relay-member.js';
import { fakeRelay, settle } from './relay-fake.js';

/**
 * THE TYNN NETWORK, WIRED (Tynn #837 + #838): the Tynn calls behind the relay ends — Genie 1's backend/tynn.ts +
 * relay-host/service.ts, unchanged in what they ask Tynn.
 *
 * As a member, over the signed-in SESSION: the workstations this person may reach (`GET /workstations/connectable`,
 * never this machine itself) and a grant for one (`POST /workstations/{id}/connect-grant {pop_jwk}`).
 * As a host, with this machine's OWN proof (`Authorization: Workstation …`, no session): a relay ticket
 * (`POST /api/v1/workstations/{id}/relay-ticket`), Tynn's grant keys (`GET …/grants/public-keys`) and whether a grant is
 * still active (`POST …/grants/introspect`).
 */

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('connectableWorkstations — what this person may reach through Tynn', () => {
    it('lists Tynn’s rows, never this machine itself, each once', async () => {
        const asked: string[] = [];
        const rows = [
            { id: 'ws_me', name: 'this desk', status: 'active', is_local: true, connectable: true, source: 'owner' },
            { id: 'ws_cloud', name: 'cloud box', status: 'active', is_local: false, connectable: true, source: 'owner' },
            { id: 'ws_cloud', name: 'cloud box', status: 'active', is_local: false, connectable: true, source: 'owner' },
            { id: 'ws_pat', name: 'Pat’s laptop', status: 'active', is_local: true, connectable: false, source: null },
        ];
        const result = await connectableWorkstations(async (path, init) => { asked.push(`${init.method} ${path}`); return json(200, { workstations: rows }); }, 'ws_me');
        expect(asked).toEqual(['GET /api/v1/workstations/connectable']);
        expect(result).toEqual({
            ok: true,
            workstations: [
                { id: 'ws_cloud', name: 'cloud box', active: true, connectable: true, local: false, source: 'owner' },
                { id: 'ws_pat', name: 'Pat’s laptop', active: true, connectable: false, local: true, source: null },
            ],
        });
    });

    it('signed out (404 since tynn.ai#303, or 401): says so', async () => {
        for (const status of [401, 404]) {
            expect(await connectableWorkstations(async () => json(status, {}), null)).toEqual({ ok: false, reason: 'sign in to Tynn to see your workstations' });
        }
    });
});

describe('mintConnectGrant — a grant for one workstation, bound to this connection’s key', () => {
    it('posts the proof key and returns the token and the relay to dial', async () => {
        const pop = PopKeypair.generate();
        let body: unknown;
        const result = await mintConnectGrant(async (path, init) => {
            expect(`${init.method} ${path}`).toBe('POST /api/v1/workstations/ws_cloud/connect-grant');
            body = init.body;
            return json(200, { token: 'jws', relay_endpoint: 'wss://relay.example.com', workstation_id: 'ws_cloud' });
        }, 'ws_cloud', pop.publicJwk);
        expect(body).toEqual({ pop_jwk: pop.publicJwk });
        expect(result).toEqual({ ok: true, token: 'jws', relayEndpoint: 'wss://relay.example.com' });
    });

    it('refused: Tynn’s own words; a 404 (signed out, or not shared with you — Tynn no longer says which)', async () => {
        const pop = PopKeypair.generate();
        expect(await mintConnectGrant(async () => json(409, { message: 'This workstation is not active.' }), 'ws_x', pop.publicJwk)).toEqual({ ok: false, reason: 'This workstation is not active.' });
        expect(await mintConnectGrant(async () => json(404, {}), 'ws_x', pop.publicJwk)).toEqual({ ok: false, reason: 'Tynn did not give this machine a way in: sign in to Tynn, and check the workstation is shared with you' });
    });
});

describe('relayHostPorts — the host’s own calls, with its own proof and no session', () => {
    it('asks for a ticket with the Workstation header and returns the relay to dial', async () => {
        const seen: Array<{ url: string; method: string; auth: string | null; cookie: string | null }> = [];
        const ports = relayHostPorts({
            tynnHost: 'https://tynn.example.com',
            workstationId: 'ws_me',
            authHeader: () => 'Workstation 1:sig',
            fetch: async (url, init) => {
                const headers = new Headers(init?.headers);
                seen.push({ url: String(url), method: init?.method ?? 'GET', auth: headers.get('authorization'), cookie: headers.get('cookie') });
                return new Response(JSON.stringify({ ticket: 't1', relay_endpoint: 'wss://relay.example.com' }), { status: 200 });
            },
        });
        expect(await ports.ticket()).toEqual({ ticket: 't1', relayEndpoint: 'wss://relay.example.com' });
        expect(seen).toEqual([{ url: 'https://tynn.example.com/api/v1/workstations/ws_me/relay-ticket', method: 'POST', auth: 'Workstation 1:sig', cookie: null }]);
    });

    it('no relay for this workstation: Tynn’s own sentence comes back', async () => {
        const ports = relayHostPorts({
            tynnHost: 'https://tynn.example.com', workstationId: 'ws_me', authHeader: () => 'Workstation 1:sig',
            fetch: async () => new Response(JSON.stringify({ error: 'no_relay', message: 'No relay is configured for this workstation, so it cannot be reached over Tynn.' }), { status: 409 }),
        });
        await expect(ports.ticket()).rejects.toThrow('No relay is configured for this workstation, so it cannot be reached over Tynn.');
    });

    it('keys and introspection', async () => {
        const ports = relayHostPorts({
            tynnHost: 'https://tynn.example.com', workstationId: 'ws_me', authHeader: () => 'Workstation 1:sig',
            fetch: async (url, init) => {
                if (String(url).endsWith('/grants/public-keys')) return new Response(JSON.stringify({ keys: [{ kid: 'k1', kty: 'OKP', crv: 'Ed25519', x: 'abc' }] }));
                expect(JSON.parse(String(init?.body))).toEqual({ token: 'jws' });
                return new Response(JSON.stringify({ active: true }));
            },
        });
        expect(await ports.keys()).toEqual([{ kid: 'k1', kty: 'OKP', crv: 'Ed25519', x: 'abc' }]);
        expect(await ports.introspect('jws')).toBe(true);
    });

    it('introspection that cannot be asked is NOT active (fail closed)', async () => {
        const ports = relayHostPorts({ tynnHost: 'https://tynn.example.com', workstationId: 'ws_me', authHeader: () => 'x', fetch: async () => { throw new Error('offline'); } });
        expect(await ports.introspect('jws')).toBe(false);
    });
});

// ---------------------------------------------------------------- a grant key, as Tynn holds it
const tynn = generateKeyPairSync('ed25519');
const tynnJwk = { ...(tynn.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string }), kid: 'k2' };
function grant(claims: Record<string, unknown>): string {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = b64({ alg: 'EdDSA', typ: 'wsgrant+jwt', kid: 'k2' });
    const body = b64({ aud: 'ws_me', exp: Math.floor(Date.now() / 1000) + 300, jti: 'g', sub: 'u', cap: 'readonly', scope: ['host:all'], ...claims });
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), tynn.privateKey).toString('base64url')}`;
}

describe('grantValidator — Tynn’s signature, then still active', () => {
    it('a new signing key: the keys are fetched again once, then the grant verifies', async () => {
        let fetched = 0;
        const validate = grantValidator({ workstationId: 'ws_me', keys: async () => { fetched++; return fetched === 1 ? [] : [tynnJwk]; }, introspect: async () => true });
        expect(await validate(grant({}))).toMatchObject({ ok: true });
        expect(fetched).toBe(2);
        // Cached now: no fetch for the next grant.
        expect(await validate(grant({}))).toMatchObject({ ok: true });
        expect(fetched).toBe(2);
    });

    it('signed, but no longer active at Tynn: refused', async () => {
        const validate = grantValidator({ workstationId: 'ws_me', keys: async () => [tynnJwk], introspect: async () => false });
        expect(await validate(grant({}))).toEqual({ ok: false, reason: 'grant is no longer active' });
    });

    it('a forged grant is refused without asking Tynn whether it is active', async () => {
        let asked = 0;
        const validate = grantValidator({ workstationId: 'ws_me', keys: async () => [tynnJwk], introspect: async () => { asked++; return true; } });
        expect(await validate(grant({ aud: 'ws_other' }))).toEqual({ ok: false, reason: 'grant audience mismatch' });
        expect(asked).toBe(0);
    });
});

describe('startRelayHost — this Genie reachable over the Tynn relay', () => {
    const hostKey = generateKeyPairSync('ed25519');
    const fingerprint = createHash('sha256').update(hostKey.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const verifyHost = (hello: Record<string, unknown>) => {
        const signed = `genie-relay-host-hello\n${String(hello.workstationId)}.${String(hello.fingerprint)}.${String(hello.nonce)}.${String(hello.ts)}`;
        return hello.ticket === 't1' && verify(null, Buffer.from(signed), hostKey.publicKey, Buffer.from(String(hello.sig), 'base64url')) ? String(hello.workstationId) : null;
    };

    it('dials the relay Tynn named, with the ticket, and says it is reachable', async () => {
        const relay = fakeRelay(verifyHost);
        const statuses: RelayHostStatus[] = [];
        const host = startRelayHost({
            ports: { ticket: async () => ({ ticket: 't1', relayEndpoint: 'wss://relay.example.com' }), keys: async () => [], introspect: async () => false },
            socket: relay.socket,
            workstationId: 'ws_me',
            fingerprint,
            sign: (d) => sign(null, d, hostKey.privateKey),
            onStatus: (s) => statuses.push(s),
            reconnect: { minMs: 0, maxMs: 0 },
        });
        await settle();
        expect(relay.log).toEqual(['host ws_me registered']);
        expect(host.status()).toEqual({ state: 'reachable', relay: 'wss://relay.example.com' });
        expect(statuses.at(0)).toEqual({ state: 'connecting' });
        host.stop();
        expect(host.status()).toEqual({ state: 'off' });
    });

    it('Tynn will not give a ticket: unavailable, in Tynn’s words, and no socket opened', async () => {
        const relay = fakeRelay(verifyHost);
        const host = startRelayHost({
            ports: { ticket: async () => { throw new Error('No relay is configured for this workstation, so it cannot be reached over Tynn.'); }, keys: async () => [], introspect: async () => false },
            socket: relay.socket,
            workstationId: 'ws_me',
            fingerprint,
            sign: (d) => sign(null, d, hostKey.privateKey),
            reconnect: { minMs: 0, maxMs: 0 },
        });
        await settle();
        expect(host.status()).toEqual({ state: 'unavailable', reason: 'No relay is configured for this workstation, so it cannot be reached over Tynn.' });
        expect(relay.log).toEqual([]);
        host.stop();
    });
});

describe('transportHub — RemoteHost hears the tailnet AND the relay', () => {
    it('connections from the primary and from every added transport, until it is removed; the address is the primary’s', async () => {
        const { transportHub, inMemoryPair } = await import('../src/core/remote-protocol.js');
        const make = () => { const ls = new Set<(c: ReturnType<typeof inMemoryPair>['server']) => void>(); return { ls, t: { onConnection: (l: (c: ReturnType<typeof inMemoryPair>['server']) => void) => { ls.add(l); return () => { ls.delete(l); }; } }, emit: (c: ReturnType<typeof inMemoryPair>['server']) => { for (const l of ls) l(c); } }; };
        const primary = make();
        const hub = transportHub({ ...primary.t, address: () => 'ws://100.64.0.1:7421', unavailable: () => null });
        const seen: string[] = [];
        hub.onConnection((c) => seen.push(c.remoteAddress));
        const relay = make();
        const remove = hub.add(relay.t);
        primary.emit({ ...inMemoryPair().server, remoteAddress: 'tailnet' });
        relay.emit({ ...inMemoryPair().server, remoteAddress: 'relay' });
        remove();
        relay.emit({ ...inMemoryPair().server, remoteAddress: 'relay-after-removal' });
        expect(seen).toEqual(['tailnet', 'relay']);
        expect(hub.address?.()).toBe('ws://100.64.0.1:7421');
        expect(hub.unavailable?.()).toBeNull();
    });
});
