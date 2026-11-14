import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConnection } from '../src/core/remote-protocol.js';
import { REMOTE_FRAME_MAX_BYTES, fitRemoteFrame } from '../src/core/remote-frame.js';
import { verifyMemberGrant, type TynnJwk } from '../src/main/relay-grant.js';
import { relayHostLink } from '../src/main/relay-host.js';
import { openRelayMember, PopKeypair, type RelayMemberTransport } from '../src/main/relay-member.js';
import { buildTicketHostHello, type PopJwk } from '../src/main/relay-wire.js';
import { mintConnectGrant } from '../src/main/tynn-network.js';
import { fakeRelay } from './relay-fake.js';

/**
 * THE RELAY HAS A SIZE CAP AND REFUSES, IT DOES NOT DISCONNECT (Tynn #579). A frame the host sends over the Tynn relay
 * that is larger than REMOTE_FRAME_MAX_BYTES is answered with a refusal (a result) or not sent (an event); the session
 * stays up either way.
 */

const WS_ID = 'ws_host_1';
const RELAY = 'wss://relay.example.com';
const tynnKey = generateKeyPairSync('ed25519');
const tynnJwk = { ...(tynnKey.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string }), kid: 'tynn-1', alg: 'EdDSA' } as TynnJwk;
const hostKey = generateKeyPairSync('ed25519');
const hostFingerprint = createHash('sha256').update(hostKey.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const thumbprint = (jwk: { crv: string; kty: string; x: string }) =>
    createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`, 'utf8').digest('base64url');

function signGrant(claims: Record<string, unknown>): string {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = b64({ alg: 'EdDSA', typ: 'wsgrant+jwt', kid: 'tynn-1' });
    const body = b64({ aud: WS_ID, exp: Math.floor(Date.now() / 1000) + 900, sub: 'guest_1', name: 'Sam', aud_role: 'pilot', src: 'share', share_origin: 'link', cap: 'control', scope: ['workspace:tynn'], ...claims });
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), tynnKey.privateKey).toString('base64url')}`;
}
const verifyHost = (hello: Record<string, unknown>): string | null => {
    if (hello.ticket !== 'ticket-1' || hello.workstationId !== WS_ID) return null;
    const signed = `genie-relay-host-hello\n${String(hello.workstationId)}.${String(hello.fingerprint)}.${String(hello.nonce)}.${String(hello.ts)}`;
    return verify(null, Buffer.from(signed), hostKey.publicKey, Buffer.from(String(hello.sig), 'base64url')) ? WS_ID : null;
};
let jti = 0;
const request = async (path: string, init: { method: string; body?: unknown }) => {
    if (!path.endsWith('/connect-grant') || init.method !== 'POST') return { ok: false, status: 404, json: async () => ({}) };
    const token = signGrant({ jti: `g${++jti}`, cnf: { jkt: thumbprint((init.body as { pop_jwk: PopJwk }).pop_jwk) } });
    return { ok: true, status: 201, json: async () => ({ token, relay_endpoint: RELAY }) };
};

let relay: ReturnType<typeof fakeRelay>;
let link: ReturnType<typeof relayHostLink>;
let connections: ServerConnection[];
const settle = async () => { for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0); };

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    relay = fakeRelay(verifyHost);
    connections = [];
    link = relayHostLink({
        socket: relay.socket,
        relayUrl: RELAY,
        workstationId: WS_ID,
        hello: async () => buildTicketHostHello({ ticket: 'ticket-1', workstationId: WS_ID, fingerprint: hostFingerprint, sign: (d) => sign(null, d, hostKey.privateKey) }),
        validateGrant: async (token) => verifyMemberGrant(token, { keys: [tynnJwk], workstationId: WS_ID }),
        revalidateMs: 30_000,
        reconnect: { minMs: 0, maxMs: 0 },
        popTimeoutMs: 1_000,
        log: () => {},
    });
    link.onConnection((c) => connections.push(c));
    link.connect();
    await settle();
});
afterEach(() => { link.close(); vi.useRealTimers(); });

async function guest(): Promise<{ transport: RelayMemberTransport; received: string[] }> {
    const pop = PopKeypair.generate();
    const grant = await mintConnectGrant(request, WS_ID, pop.publicJwk);
    if (!grant.ok) throw new Error(grant.reason);
    const opening = openRelayMember({ socket: relay.socket, relayUrl: grant.relayEndpoint, workstationId: WS_ID, grant: grant.token, pop });
    await settle();
    const opened = await opening;
    if (!opened.ok) throw new Error(opened.reason);
    await settle();
    const received: string[] = [];
    opened.transport.onMessage((t) => received.push(t));
    return { transport: opened.transport, received };
}

const big = (kind: string, extra: object) => JSON.stringify({ kind, ...extra, value: 'x'.repeat(REMOTE_FRAME_MAX_BYTES + 10) });

describe('fitRemoteFrame', () => {
    it('a frame within the cap is sent as it is', () => {
        expect(fitRemoteFrame('{"kind":"event","channel":"snapshot","payload":{}}')).toEqual({ text: '{"kind":"event","channel":"snapshot","payload":{}}' });
    });
    it('a result over the cap becomes a refusal for the same call', () => {
        const fit = fitRemoteFrame(big('result', { id: 7, ok: true }));
        expect(JSON.parse(fit.text!)).toEqual({ kind: 'result', id: 7, ok: false, reason: expect.stringMatching(/too large/) });
    });
    it('an event over the cap is not sent', () => {
        expect(fitRemoteFrame(big('event', { channel: 'snapshot' })).text).toBeNull();
    });
});

describe('the relay path (Tynn #579)', () => {
    it('a result over the cap reaches the guest as a refusal, and the session stays up', async () => {
        const { transport, received } = await guest();
        connections.at(-1)!.send(big('result', { id: 7, ok: true }));
        await settle();
        expect(received).toHaveLength(1);
        expect(JSON.parse(received[0]!)).toMatchObject({ kind: 'result', id: 7, ok: false, reason: expect.stringMatching(/too large/) });
        expect(transport.closedBecause()).toBeNull();
        connections.at(-1)!.send('{"kind":"result","id":8,"ok":true,"value":1}'); // CONTROL: the session still carries frames
        await settle();
        expect(received).toHaveLength(2);
    });

    it('an event over the cap is not sent, and the session stays up', async () => {
        const { transport, received } = await guest();
        connections.at(-1)!.send(big('event', { channel: 'snapshot' }));
        await settle();
        expect(received).toHaveLength(0);
        expect(transport.closedBecause()).toBeNull();
    });
});
