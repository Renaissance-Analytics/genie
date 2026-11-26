import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import type { PairAnswer, PairConfirm } from '../src/core/pair-confirm.js';
import { parseMessage, type ClientTransport, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { principalOf, verifyMemberGrant, type TynnJwk } from '../src/main/relay-grant.js';
import { relayHostLink } from '../src/main/relay-host.js';
import { openRelayMember, PopKeypair } from '../src/main/relay-member.js';
import { buildTicketHostHello } from '../src/main/relay-wire.js';
import { fakeRelay, settle } from './relay-fake.js';

/**
 * TYNN'S "OWNER" IS NOT ENOUGH TO SKIP ALLOW (Tynn #757, security). A share-link visit could leave Tynn holding a
 * record whose owner is the VISITOR, so Tynn signs `src = owner` into the visitor's grant. The host must not take that
 * word alone: a visitor is this host's owner only when the grant's subject is the Tynn account signed in on THIS
 * machine. Anyone else meets the #731 Allow on this machine's screen, and gets a guest's powers if let in; a drone (no
 * one at it to press Allow) refuses them.
 */

const WS_ID = 'ws_host_757';
const HOST_ACCOUNT = 'user_host';
const VISITOR = 'user_visitor';

const tynnKey = generateKeyPairSync('ed25519');
const tynnJwk = { ...(tynnKey.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string }), kid: 'tynn-1', alg: 'EdDSA' } as TynnJwk;
const hostKey = generateKeyPairSync('ed25519');
const HOST_PUBLIC_KEY = (hostKey.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
const hostFingerprint = createHash('sha256').update(hostKey.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const thumbprint = (jwk: { crv: string; kty: string; x: string }) =>
    createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`, 'utf8').digest('base64url');

function mintGrant(claims: Record<string, unknown>, key: KeyObject = tynnKey.privateKey): string {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = b64({ alg: 'EdDSA', typ: 'wsgrant+jwt', kid: 'tynn-1' });
    const body = b64({ aud: WS_ID, exp: Math.floor(Date.now() / 1000) + 300, jti: 'g1', sub: VISITOR, name: 'Visitor', aud_role: 'pilot', cap: 'control', scope: ['host:all'], ...claims });
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}

function checked(claims: Record<string, unknown>) {
    const r = verifyMemberGrant(mintGrant(claims), { keys: [tynnJwk], workstationId: WS_ID });
    if (!r.ok) throw new Error(r.reason);
    return r.grant;
}

describe('principalOf: owner only when the grant is for the account signed in here', () => {
    it('CONTROL: Tynn says owner and the grant is for this machine’s account: the owner', () => {
        expect(principalOf(checked({ src: 'owner', sub: HOST_ACCOUNT }), HOST_ACCOUNT)).toMatchObject({ ok: true, principal: { isOwner: true, workspaceId: null } });
    });

    it('Tynn says owner, but the grant is for SOMEONE ELSE: a guest of the whole host, never the owner', () => {
        expect(principalOf(checked({ src: 'owner', sub: VISITOR }), HOST_ACCOUNT)).toMatchObject({ ok: true, principal: { isOwner: false, workspaceId: null } });
    });

    it('nobody signed in here: no one is the owner', () => {
        expect(principalOf(checked({ src: 'owner', sub: HOST_ACCOUNT }), null)).toMatchObject({ ok: true, principal: { isOwner: false } });
    });

    it('a DRONE refuses a Tynn "owner" from a paired machine whose account is not the one signed in here', () => {
        const r = principalOf(checked({ src: 'owner', src_ws: 'ws_other', aud_role: 'drone', sub: VISITOR }), HOST_ACCOUNT);
        expect(r.ok).toBe(false);
        // CONTROL: the same grant for this machine's own account is admitted.
        expect(principalOf(checked({ src: 'owner', src_ws: 'ws_other', aud_role: 'drone', sub: HOST_ACCOUNT }), HOST_ACCOUNT)).toMatchObject({ ok: true, principal: { isOwner: true } });
    });
});

// ---------------------------------------------------------------- over the relay, into a real RemoteHost
const verifyHost = (hello: Record<string, unknown>): string | null => {
    if (hello.ticket !== 'ticket-1' || hello.workstationId !== WS_ID) return null;
    const signed = `genie-relay-host-hello\n${String(hello.workstationId)}.${String(hello.fingerprint)}.${String(hello.nonce)}.${String(hello.ts)}`;
    return verify(null, Buffer.from(signed), hostKey.publicKey, Buffer.from(String(hello.sig), 'base64url')) ? WS_ID : null;
};
const api: HostApi = {
    invoke: async (method) => (method === 'snapshot' ? { agents: [], workspaces: [], deckItems: [], signals: {} } : { ok: true }),
    onEvent: () => () => {},
    workspaceOfAgent: () => null,
};

/** A confirm that records each ask and answers with `answer`. */
function recordingConfirm(answer: PairAnswer) {
    const asked: string[] = [];
    const confirm: PairConfirm = {
        ask: (input) => { asked.push(input.label); return { id: `ask_${asked.length}`, expiresAt: Number.MAX_SAFE_INTEGER, answer: Promise.resolve(answer) }; },
        cancel: () => {},
    };
    return { asked, confirm };
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanup.reverse()) await c(); cleanup = []; });

async function hostSignedInAs(account: string | null, answer: PairAnswer) {
    const dir = await mkdtemp(join(tmpdir(), 'genie-757-'));
    const relay = fakeRelay(verifyHost);
    const link = relayHostLink({
        socket: relay.socket,
        relayUrl: 'wss://relay.example.com',
        workstationId: WS_ID,
        hello: async () => buildTicketHostHello({ ticket: 'ticket-1', workstationId: WS_ID, fingerprint: hostFingerprint, sign: (d) => sign(null, d, hostKey.privateKey) }),
        fingerprint: hostFingerprint, sign: (d) => sign(null, d, hostKey.privateKey),
        validateGrant: async (token) => verifyMemberGrant(token, { keys: [tynnJwk], workstationId: WS_ID }),
        signedInHere: () => account,
        reconnect: { minMs: 0, maxMs: 0 },
        popTimeoutMs: 1_000,
    });
    const { asked, confirm } = recordingConfirm(answer);
    new RemoteHost({ confirm, api, hostName: 'host', baton: new Baton(), pins: new PairingPins({ now: Date.now, random: Math.random }), devices: await DeviceStore.open(dir, { now: Date.now, random: () => 'tok' }), transport: link });
    link.connect();
    await settle();
    cleanup.push(() => link.close(), () => rm(dir, { recursive: true, force: true }));
    const member = async (claims: Record<string, unknown>) => {
        const pop = PopKeypair.generate();
        const opened = await openRelayMember({ socket: relay.socket, relayUrl: 'wss://relay.example.com', workstationId: WS_ID, grant: mintGrant({ cnf: { jkt: thumbprint(pop.publicJwk) }, ...claims }), hostPublicKey: HOST_PUBLIC_KEY, pop });
        if (!opened.ok) throw new Error(opened.reason);
        return opened.transport as ClientTransport & { closedBecause(): string | null };
    };
    return { asked, member };
}

function wire(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    return {
        hello: async () => { t.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, label: 'laptop' })); let m = await next(); while (m.kind === 'pairing') m = await next(); return m; },
        call: async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next(); },
    };
}

describe('the host asks Allow of a Tynn "owner" who is not the account signed in here', () => {
    it('CONTROL: the account signed in here comes in as the owner, with no prompt', async () => {
        const host = await hostSignedInAs(HOST_ACCOUNT, 'deny');
        const c = wire(await host.member({ src: 'owner', sub: HOST_ACCOUNT }));
        expect(await c.hello()).toMatchObject({ kind: 'welcome', isOwner: true });
        expect(host.asked).toEqual([]);
    });

    it('another account Tynn calls owner is asked about on this screen, and Deny keeps it out', async () => {
        const host = await hostSignedInAs(HOST_ACCOUNT, 'deny');
        const t = await host.member({ src: 'owner', sub: VISITOR });
        void wire(t).hello();
        await settle();
        expect(host.asked).toEqual(['Visitor']);
        expect(t.closedBecause()).not.toBeNull();
    });

    it('let in with Allow, it is a guest: it cannot change the host itself', async () => {
        const host = await hostSignedInAs(HOST_ACCOUNT, 'allow');
        const c = wire(await host.member({ src: 'owner', sub: VISITOR }));
        expect(await c.hello()).toMatchObject({ kind: 'welcome', isOwner: false });
        expect(host.asked).toEqual(['Visitor']);
        expect(await c.call('features.act', { kind: 'remote.lock' })).toMatchObject({ ok: false });
    });

    it('nobody signed in on this machine: even a Tynn "owner" is asked about', async () => {
        const host = await hostSignedInAs(null, 'deny');
        const t = await host.member({ src: 'owner', sub: HOST_ACCOUNT });
        void wire(t).hello();
        await settle();
        expect(host.asked).toHaveLength(1);
        expect(t.closedBecause()).not.toBeNull();
    });
});
