import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_FRAME_MAX_BYTES } from '../src/core/remote-frame.js';
import type { ServerConnection } from '../src/core/remote-protocol.js';
import { verifyMemberGrant, type TynnJwk } from '../src/main/relay-grant.js';
import { relayHostLink } from '../src/main/relay-host.js';
import { openRelayMember, PopKeypair, type RelayMemberResult, type RelayMemberTransport, type RenewGrant } from '../src/main/relay-member.js';
import { buildTicketHostHello } from '../src/main/relay-wire.js';
import { fakeRelay, settle, type RelayTamper } from './relay-fake.js';

/**
 * A RELAY IN THE MIDDLE THAT IS NOT HONEST (audit M-a, host split P9.2). The real host link and the real member, with a
 * relay between them that reads, rewrites, repeats, drops and invents frames. What must hold:
 *
 * - it reads none of Genie's own protocol and none of a site stream (only the envelope it routes on);
 * - the member talks only to the host that holds the key TYNN named for the workstation, and says nothing before that;
 * - the host hands RemoteHost a connection only for the member that holds the key its GRANT is bound to;
 * - one changed, repeated, dropped or invented frame ends the session, in words; nothing is skipped;
 * - there is no plain path: a peer (or a relay) that leaves the handshake out gets nothing delivered.
 *
 * Every refusal row runs beside the honest relay (the first describe): the same rig with no tampering passes traffic.
 */

const WS_ID = 'ws_host_1';
const NAME = 'alphar';
const tynnKey = generateKeyPairSync('ed25519');
const tynnJwk = { ...(tynnKey.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string }), kid: 'tynn-1', alg: 'EdDSA' } as TynnJwk;
const hostKey = generateKeyPairSync('ed25519');
const spkiOf = (key: KeyObject) => (key.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
const HOST_PUBLIC_KEY = spkiOf(hostKey.publicKey);
const hostFingerprint = createHash('sha256').update(Buffer.from(HOST_PUBLIC_KEY, 'base64')).digest('hex');
const thumbprint = (jwk: { crv: string; kty: string; x: string }) => createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`, 'utf8').digest('base64url');

function mintGrant(claims: Record<string, unknown>): string {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = b64({ alg: 'EdDSA', typ: 'wsgrant+jwt', kid: 'tynn-1' });
    const body = b64({ aud: WS_ID, exp: Math.floor(Date.now() / 1000) + 300, jti: 'g1', sub: 'user_1', name: 'Pat', aud_role: 'pilot', src: 'owner', cap: 'control', scope: ['host:all'], ...claims });
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), tynnKey.privateKey).toString('base64url')}`;
}
const verifyHost = (hello: Record<string, unknown>): string | null => {
    if (hello.ticket !== 'ticket-1' || hello.workstationId !== WS_ID) return null;
    const signed = `genie-relay-host-hello\n${String(hello.workstationId)}.${String(hello.fingerprint)}.${String(hello.nonce)}.${String(hello.ts)}`;
    return verify(null, Buffer.from(signed), hostKey.publicKey, Buffer.from(String(hello.sig), 'base64url')) ? WS_ID : null;
};

/** The sentences, written out (the person reads these). */
const NOT_PROVED = `This workstation could not prove it is ${NAME}. Nothing was sent. If ${NAME} was set up again, wait until it has signed in to Tynn, then connect again.`;
const NO_KEY = `Tynn has no key on record for ${NAME}, so this workstation could not prove it is ${NAME}. Nothing was sent. Open Genie on ${NAME} and sign in to Tynn there, then connect again.`;
const OLD_HOST = `${NAME} runs an older Genie that cannot make an encrypted connection. Update Genie on ${NAME}. Nothing was sent.`;
const OLD_MEMBER = 'The Genie on the machine you are connecting from is too old to make an encrypted connection to this workstation. Update Genie there, then connect again.';
const CHANGED = `The connection to ${NAME} was changed on the way, so it was closed. Connect again.`;
const CHANGED_AT_HOST = 'the encrypted connection was changed on the way, so this workstation closed it';
const MEMBER_NOT_PROVED = 'the connecting machine could not prove it holds the key its grant names, so this workstation closed the connection';

/** One end of a byte stream that does not echo (a front door, or a browser): what was written to it, and a way to make it speak. */
function endpoint() {
    const got: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk: Buffer, _encoding, done) { got.push(chunk); done(); } });
    return { socket, got, say: (text: string) => { socket.push(Buffer.from(text)); } };
}

const links: Array<ReturnType<typeof relayHostLink>> = [];
afterEach(() => { for (const l of links.splice(0)) l.close(); });

async function rig(tamper: RelayTamper = {}, opts: { hostSigns?: KeyObject; holdValidate?: () => Promise<void>; holdSign?: () => Promise<void> } = {}) {
    const relay = fakeRelay(verifyHost, tamper);
    const hostLog: string[] = [];
    const dialed: string[] = [];
    const frontDoors: Array<ReturnType<typeof endpoint>> = [];
    /** Every grant the host was asked to check, in order. */
    const validated: string[] = [];
    const link = relayHostLink({
        socket: relay.socket,
        relayUrl: 'wss://relay.example.com',
        workstationId: WS_ID,
        fingerprint: hostFingerprint,
        sign: opts.holdSign ? async (d) => { await opts.holdSign!(); return sign(null, d, opts.hostSigns ?? hostKey.privateKey); } : (d) => sign(null, d, opts.hostSigns ?? hostKey.privateKey),
        hello: async () => buildTicketHostHello({ ticket: 'ticket-1', workstationId: WS_ID, fingerprint: hostFingerprint, sign: (d) => sign(null, d, hostKey.privateKey) }),
        signedInHere: () => 'user_1',
        validateGrant: async (token) => { validated.push(token); await opts.holdValidate?.(); return verifyMemberGrant(token, { keys: [tynnJwk], workstationId: WS_ID }); },
        reconnect: { minMs: 0, maxMs: 0 },
        revalidateMs: 0,
        popTimeoutMs: 200,
        log: (m) => hostLog.push(m),
        site: { dial: async (host) => { dialed.push(host); const door = endpoint(); frontDoors.push(door); return { ok: true, socket: door.socket as unknown as Socket }; }, ca: () => 'HOST CA' },
    });
    links.push(link);
    /** What RemoteHost would be handed, and what it would read. */
    const admitted: ServerConnection[] = [];
    const hostRead: string[] = [];
    link.onConnection((c) => { admitted.push(c); c.onMessage((text) => { hostRead.push(text); c.send(`echo:${text}`); }); });
    link.connect();
    await settle();
    const connect = async (o: { hostPublicKey?: string | null; grant?: string; pop?: PopKeypair; e2eTimeoutMs?: number; renew?: RenewGrant } = {}): Promise<RelayMemberResult> => {
        const pop = o.pop ?? PopKeypair.generate();
        return openRelayMember({
            socket: relay.socket, relayUrl: 'wss://relay.example.com', workstationId: WS_ID, name: NAME,
            grant: o.grant ?? mintGrant({ cnf: { jkt: thumbprint(pop.publicJwk) } }),
            hostPublicKey: o.hostPublicKey === undefined ? HOST_PUBLIC_KEY : o.hostPublicKey,
            pop, timeoutMs: 1_000, e2eTimeoutMs: o.e2eTimeoutMs ?? 300,
            ...(o.renew ? { renew: o.renew } : {}),
        });
    };
    /** The frames the relay was handed on a channel, from one side. */
    const seen = (from: 'member' | 'host', channel: string) => relay.wire.filter((w) => w.from === from).map((w) => JSON.parse(w.text) as Record<string, unknown>).filter((f) => f.channel === channel);
    return { relay, link, hostLog, dialed, frontDoors, admitted, hostRead, connect, seen, validated };
}

const transportOf = (opened: RelayMemberResult): RelayMemberTransport => {
    if (!opened.ok) throw new Error(`not connected: ${opened.reason}`);
    return opened.transport;
};
const reading = (t: RelayMemberTransport) => { const got: string[] = []; t.onMessage((text) => got.push(text)); return got; };
const kindOf = (text: string) => { const f = JSON.parse(text) as { channel?: string; kind?: string; payload?: { type?: string } }; return `${f.channel}/${f.kind}${f.payload?.type ? `/${f.payload.type}` : ''}`; };

const MARKER_UP = 'MARKER-FROM-THE-MEMBER-7c1f';
const MARKER_DOWN = 'echo:MARKER-FROM-THE-MEMBER-7c1f';

describe('an honest relay (the control for every row below)', () => {
    it('passes Genie’s protocol both ways, and the host admits the member once', async () => {
        const r = await rig();
        const t = transportOf(await r.connect());
        const got = reading(t);
        t.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, note: MARKER_UP }));
        await settle();
        expect(r.admitted).toHaveLength(1);
        expect(r.hostRead).toEqual([JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, note: MARKER_UP })]);
        expect(got).toEqual([`echo:${JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, note: MARKER_UP })}`]);
        expect(t.closedBecause()).toBeNull();
    });

    it('reads none of it: no rest frame on its wire holds the protocol, either way', async () => {
        const r = await rig();
        const t = transportOf(await r.connect());
        t.send(MARKER_UP);
        await settle();
        const all = r.relay.wire.map((w) => w.text).join('\n');
        // CONTROL for the absence: the frames ARE on the wire (one each way), so this looked in the right place.
        expect(r.seen('member', 'rest')).toHaveLength(1);
        expect(r.seen('host', 'rest')).toHaveLength(1);
        expect(all).not.toContain(MARKER_UP);
        expect(all).not.toContain(MARKER_DOWN);
        for (const f of [...r.seen('member', 'rest'), ...r.seen('host', 'rest')]) {
            expect(Object.keys(f).sort()).toEqual(['channel', 'kind', 'payload', 'sid']);
            expect(Object.keys(f.payload as object).sort()).toEqual(['c', 'e2e', 'n']);
        }
    });

    it('the handshake is three control frames, in this order, before any rest frame', async () => {
        const r = await rig();
        const t = transportOf(await r.connect());
        t.send('first');
        await settle();
        const order = r.relay.wire.filter((w) => !w.text.includes('member-hello')).map((w) => `${w.from}:${kindOf(w.text)}`);
        expect(order).toEqual([
            'member:control/data/e2e-init',
            'host:control/data/pop-challenge',
            'member:control/data/pop-proof',
            'host:control/data/e2e-accept',
            'member:control/data/e2e-finish',
            'member:rest/data',
            'host:rest/data',
        ]);
    });

    it('a site stream opens for the owner, carries the HOST’s CA, and the relay reads neither the name nor the CA nor the bytes', async () => {
        const r = await rig();
        const t = transportOf(await r.connect());
        const opened = await t.openSite('app.gen');
        expect(opened).toMatchObject({ ok: true, ca: 'HOST CA' });
        expect(r.dialed).toEqual(['app.gen']);
        if (!opened.ok) return;
        const browser = endpoint();
        opened.pipe(browser.socket);
        browser.say('SITE-BYTES-MARKER-91ab');
        await settle();
        r.frontDoors[0]!.say('SITE-ANSWER-MARKER-44f0');
        await settle();
        // The bytes crossed, both ways.
        expect(Buffer.concat(r.frontDoors[0]!.got).toString()).toBe('SITE-BYTES-MARKER-91ab');
        expect(Buffer.concat(browser.got).toString()).toBe('SITE-ANSWER-MARKER-44f0');
        const all = r.relay.wire.map((w) => w.text).join('\n');
        expect(r.seen('member', 'site').length).toBeGreaterThanOrEqual(2);
        expect(r.seen('host', 'site').length).toBeGreaterThanOrEqual(1);
        expect(all).not.toContain('app.gen');
        expect(all).not.toContain('HOST CA');
        expect(all).not.toContain(Buffer.from('SITE-BYTES-MARKER-91ab').toString('base64'));
        expect(all).not.toContain(Buffer.from('SITE-ANSWER-MARKER-44f0').toString('base64'));
        expect(t.closedBecause()).toBeNull();
    });

    it('may deliver a rest frame and a site frame in the other order (channels paced apart): the session lives and both arrive', async () => {
        // The relay holds the first rest frame from the member until the next site frame has gone ahead of it.
        let held: string | null = null;
        const r = await rig({
            fromMember: (text) => {
                const f = JSON.parse(text) as { channel: string };
                if (f.channel === 'rest' && held === null) { held = text; return []; }
                if (f.channel === 'site' && held !== null && held !== 'released') { const first = held; held = 'released'; return [text, first]; }
                return [text];
            },
        });
        const t = transportOf(await r.connect());
        const got = reading(t);
        t.send('rest before site');
        const opened = await t.openSite('app.gen');
        await settle();
        expect(opened).toMatchObject({ ok: true });
        expect(r.hostRead).toEqual(['rest before site']);
        expect(got).toEqual(['echo:rest before site']);
        expect(t.closedBecause()).toBeNull();
    });
});

describe('the host is the one Tynn named', () => {
    it('Tynn named ANOTHER key than the host holds: refused in words, and no rest frame ever left the member', async () => {
        const r = await rig();
        const other = spkiOf(generateKeyPairSync('ed25519').publicKey);
        expect(await r.connect({ hostPublicKey: other })).toEqual({ ok: false, reason: NOT_PROVED });
        await settle();
        expect(r.seen('member', 'rest')).toEqual([]);
        expect(r.seen('member', 'site')).toEqual([]);
        expect(r.seen('member', 'control').map((f) => (f.payload as { type?: string } | undefined)?.type)).not.toContain('e2e-finish');
        expect(r.admitted).toEqual([]);
    });

    it('a host that holds ANOTHER key than the one enrolled (an impostor behind the relay): the same refusal', async () => {
        const r = await rig({}, { hostSigns: generateKeyPairSync('ed25519').privateKey });
        expect(await r.connect()).toEqual({ ok: false, reason: NOT_PROVED });
        await settle();
        expect(r.seen('member', 'rest')).toEqual([]);
        expect(r.admitted).toEqual([]);
    });

    it('the relay answers the handshake ITSELF, with its own key: refused before any hello leaves', async () => {
        const relays = generateKeyPairSync('ed25519');
        const eph = generateKeyPairSync('x25519');
        const e = (eph.publicKey.export({ format: 'jwk' }) as { x: string }).x;
        const r = await rig({
            fromHost: (text, sid) => {
                const f = JSON.parse(text) as { payload?: { type?: string } };
                if (f.payload?.type !== 'e2e-accept') return [text];
                // Its own ephemeral, and a well-formed signature by a key Tynn never named.
                const sig = sign(null, Buffer.from('genie-relay-e2e v1 host\n'), relays.privateKey).toString('base64url');
                return [JSON.stringify({ kind: 'data', channel: 'control', sid, payload: { type: 'e2e-accept', v: 1, e, sig } })];
            },
        });
        expect(await r.connect()).toEqual({ ok: false, reason: NOT_PROVED });
        await settle();
        expect(r.seen('member', 'rest')).toEqual([]);
        expect(r.admitted).toEqual([]);
    });

    it('the relay supplies a key of its own beside the accept: it is not read (the member checks Tynn’s key only)', async () => {
        const relays = generateKeyPairSync('ed25519');
        const r = await rig({
            fromHost: (text) => {
                const f = JSON.parse(text) as { payload?: Record<string, unknown> };
                if (f.payload?.type !== 'e2e-accept') return [text];
                return [JSON.stringify({ ...f, payload: { ...f.payload, hostPublicKey: spkiOf(relays.publicKey), host_public_key: spkiOf(relays.publicKey), key: spkiOf(relays.publicKey) } })];
            },
        });
        // The real host's accept, untouched but for the extra keys: it still verifies against Tynn's key, and only that.
        const t = transportOf(await r.connect());
        t.send('ok');
        await settle();
        expect(r.hostRead).toEqual(['ok']);
    });

    it.each([['null', null], ['an empty string', ''], ['not a key', 'bm90IGEga2V5']])('Tynn returned %s for the key: refused before the relay is dialled', async (_name, key) => {
        const r = await rig();
        const before = r.relay.wire.length;
        expect(await r.connect({ hostPublicKey: key })).toEqual({ ok: false, reason: NO_KEY });
        await settle();
        expect(r.relay.wire.length).toBe(before);
        expect(r.relay.sessions.size).toBe(0);
    });
});

describe('the member is the one the grant names', () => {
    it('the relay swaps in its OWN ephemeral toward the host (to sit in the middle): the host admits nobody', async () => {
        const eph = generateKeyPairSync('x25519');
        const e = (eph.publicKey.export({ format: 'jwk' }) as { x: string }).x;
        const r = await rig({
            fromMember: (text) => {
                const f = JSON.parse(text) as { payload?: Record<string, unknown> };
                return f.payload?.type === 'e2e-init' ? [JSON.stringify({ ...f, payload: { ...f.payload, e } })] : [text];
            },
        });
        const opened = await r.connect();
        expect(opened).toEqual({ ok: false, reason: NOT_PROVED });
        await settle();
        expect(r.admitted).toEqual([]);
        expect(r.hostRead).toEqual([]);
    });

    it('the relay takes the member’s place after its proof of possession (forges the finish): refused, nobody admitted', async () => {
        const relays = generateKeyPairSync('ed25519');
        const r = await rig({
            fromMember: (text) => {
                const f = JSON.parse(text) as { payload?: Record<string, unknown> };
                if (f.payload?.type !== 'e2e-finish') return [text];
                return [JSON.stringify({ ...f, payload: { type: 'e2e-finish', sig: sign(null, Buffer.from('genie-relay-e2e v1 member\n'), relays.privateKey).toString('base64url') } })];
            },
        });
        // The member finished its own side (the host's accept was real), so its open came back; the host then ends it.
        const t = transportOf(await r.connect());
        await settle();
        expect(r.admitted).toEqual([]);
        expect(r.hostLog.join('\n')).toMatch(/could not prove it holds the key its grant names/);
        expect(t.closedBecause()).toBe(MEMBER_NOT_PROVED);
    });

    // The strong case (review note): the RIGHT key's finish, made for ANOTHER session of the same member, moved into this one.
    it('a real finish by the right key, taken from another of the member’s sessions, does not admit this one', async () => {
        let first: string | null = null;
        const r = await rig({
            fromMember: (text, sid) => {
                const f = JSON.parse(text) as { payload?: Record<string, unknown> };
                if (f.payload?.type !== 'e2e-finish') return [text];
                if (first === null) { first = text; return [text]; }
                return [JSON.stringify({ ...(JSON.parse(first) as object), sid })];
            },
        });
        const pop = PopKeypair.generate();
        const grant = mintGrant({ cnf: { jkt: thumbprint(pop.publicJwk) } });
        const one = transportOf(await r.connect({ pop, grant }));
        await settle();
        // CONTROL: the first session, with its own finish, is admitted.
        expect(r.admitted).toHaveLength(1);
        const two = transportOf(await r.connect({ pop, grant }));
        await settle();
        expect(r.admitted).toHaveLength(1);
        expect(two.closedBecause()).toBe(MEMBER_NOT_PROVED);
        expect(one.closedBecause()).toBeNull();
    });

    it('the relay invents rest frames for an admitted session (plain, as before this build): the session ends and RemoteHost reads none', async () => {
        const r = await rig();
        const t = transportOf(await r.connect());
        const sid = [...r.relay.sessions.keys()][0]!;
        r.relay.toHost(sid, JSON.stringify({ kind: 'data', channel: 'rest', sid, payload: JSON.stringify({ kind: 'call', id: 1, method: 'snapshot', args: [] }) }));
        await settle();
        expect(r.hostRead).toEqual([]);
        expect(t.closedBecause()).toBe(CHANGED_AT_HOST);
    });

    it('the relay invents a site open in the owner’s session: the front door is never dialled, and the session ends', async () => {
        const r = await rig();
        const t = transportOf(await r.connect());
        const sid = [...r.relay.sessions.keys()][0]!;
        r.relay.toHost(sid, JSON.stringify({ kind: 'open', channel: 'site', sid, reqId: 'relay_1', payload: { host: 'app.gen' } }));
        await settle();
        expect(r.dialed).toEqual([]);
        expect(t.closedBecause()).toBe(CHANGED_AT_HOST);
    });
});

describe('a frame changed on the way', () => {
    const flipOne = (text: string): string => {
        const f = JSON.parse(text) as { payload: { c: string } };
        const bytes = Buffer.from(f.payload.c, 'base64');
        bytes[0] = bytes[0]! ^ 0x01;
        return JSON.stringify({ ...f, payload: { ...f.payload, c: bytes.toString('base64') } });
    };
    const isRest = (text: string) => (JSON.parse(text) as { channel?: string }).channel === 'rest';

    it('one ciphertext byte flipped on the way to the host: nothing is delivered and the session ends, in words', async () => {
        const r = await rig({ fromMember: (text) => (isRest(text) ? [flipOne(text)] : [text]) });
        const t = transportOf(await r.connect());
        t.send('call');
        await settle();
        expect(r.hostRead).toEqual([]);
        expect(t.closedBecause()).toBe(CHANGED_AT_HOST);
    });

    it('one ciphertext byte flipped on the way to the member: nothing is delivered and the session ends, in words', async () => {
        const r = await rig({ fromHost: (text) => (isRest(text) ? [flipOne(text)] : [text]) });
        const t = transportOf(await r.connect());
        const got = reading(t);
        t.send('call');
        await settle();
        expect(r.hostRead).toEqual(['call']);
        expect(got).toEqual([]);
        expect(t.closedBecause()).toBe(CHANGED);
    });

    it('a frame replayed to the host: delivered once, then the session ends', async () => {
        const r = await rig({ fromMember: (text) => (isRest(text) ? [text, text] : [text]) });
        const t = transportOf(await r.connect());
        t.send('pay once');
        await settle();
        expect(r.hostRead).toEqual(['pay once']);
        expect(t.closedBecause()).toBe(CHANGED_AT_HOST);
    });

    it('a frame replayed to the member: delivered once, then the session ends', async () => {
        const r = await rig({ fromHost: (text) => (isRest(text) ? [text, text] : [text]) });
        const t = transportOf(await r.connect());
        const got = reading(t);
        t.send('once');
        await settle();
        expect(got).toEqual(['echo:once']);
        expect(t.closedBecause()).toBe(CHANGED);
    });

    it('a frame dropped on the way to the host: the next one ends the session (nothing is skipped)', async () => {
        let dropped = false;
        const r = await rig({ fromMember: (text) => { if (isRest(text) && !dropped) { dropped = true; return []; } return [text]; } });
        const t = transportOf(await r.connect());
        t.send('stop the agent');
        t.send('delete the files');
        await settle();
        expect(r.hostRead).toEqual([]);
        expect(t.closedBecause()).toBe(CHANGED_AT_HOST);
    });

    it('two rest frames swapped: the session ends', async () => {
        let first: string | null = null;
        const r = await rig({ fromMember: (text) => { if (!isRest(text)) return [text]; if (first === null) { first = text; return []; } const a = first; first = 'done'; return a === 'done' ? [text] : [text, a]; } });
        const t = transportOf(await r.connect());
        t.send('one');
        t.send('two');
        await settle();
        expect(r.hostRead).toEqual([]);
        expect(t.closedBecause()).toBe(CHANGED_AT_HOST);
    });

    it('two site frames swapped: the session ends', async () => {
        let first: string | null = null;
        const isSite = (text: string) => (JSON.parse(text) as { channel?: string }).channel === 'site';
        const r = await rig({ fromMember: (text) => { if (!isSite(text)) return [text]; if (first === null) { first = text; return []; } const a = first; first = 'done'; return a === 'done' ? [text] : [text, a]; } });
        const t = transportOf(await r.connect());
        void t.openSite('app.gen');
        void t.openSite('app.gen');
        await settle();
        expect(r.dialed).toEqual([]);
        expect(t.closedBecause()).toBe(CHANGED_AT_HOST);
    });

    it('the host’s CA replaced by the relay’s (a plain site frame in its place): the member takes no CA and the session ends', async () => {
        const r = await rig({
            fromHost: (text, sid) => {
                const f = JSON.parse(text) as { channel?: string; reqId?: string };
                return f.channel === 'site' ? [JSON.stringify({ kind: 'data', channel: 'site', sid, reqId: f.reqId, payload: { t: 'open', ca: 'RELAY CA' } })] : [text];
            },
        });
        const t = transportOf(await r.connect());
        const opened = await t.openSite('app.gen');
        expect(opened).toEqual({ ok: false, reason: CHANGED });
        expect(t.closedBecause()).toBe(CHANGED);
    });
});

describe('the handshake left out', () => {
    it('the relay drops the member’s e2e-init: the host refuses at the proof, nothing is delivered', async () => {
        const r = await rig({ fromMember: (text) => ((JSON.parse(text) as { payload?: { type?: string } }).payload?.type === 'e2e-init' ? [] : [text]) });
        expect(await r.connect()).toEqual({ ok: false, reason: OLD_MEMBER });
        await settle();
        expect(r.admitted).toEqual([]);
    });

    it('the relay drops the host’s e2e-accept: the member stops in words, and no rest frame ever left it', async () => {
        const r = await rig({ fromHost: (text) => ((JSON.parse(text) as { payload?: { type?: string } }).payload?.type === 'e2e-accept' ? [] : [text]) });
        expect(await r.connect({ e2eTimeoutMs: 50 })).toEqual({ ok: false, reason: OLD_HOST });
        await settle();
        expect(r.seen('member', 'rest')).toEqual([]);
        expect(r.admitted).toEqual([]);
    });

    it('a member from before this build (grant, proof, then a plain hello; no handshake): refused in words that say which side to update', async () => {
        const r = await rig();
        // The old member, by hand on the relay's own wire.
        const pop = PopKeypair.generate();
        const ws = r.relay.socket('wss://relay.example.com/ws/member');
        const got: Array<Record<string, unknown>> = [];
        let sid = '';
        ws.onopen = () => ws.send(JSON.stringify({ type: 'member-hello', workstationId: WS_ID, grant: mintGrant({ cnf: { jkt: thumbprint(pop.publicJwk) } }) }));
        ws.onmessage = (ev) => {
            const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
            got.push(m);
            if (m.type === 'member-welcome') {
                sid = String(m.sid);
                ws.send(JSON.stringify({ kind: 'data', channel: 'rest', sid, payload: JSON.stringify({ kind: 'hello', auth: { kind: 'relay' } }) }));
            }
            const p = m.payload as { type?: string; nonce?: string } | undefined;
            if (p?.type === 'pop-challenge') { const proof = pop.prove(String(p.nonce), WS_ID, sid); ws.send(JSON.stringify({ kind: 'data', channel: 'control', sid, payload: { type: 'pop-proof', ...proof } })); }
        };
        await settle();
        await settle();
        expect(r.admitted).toEqual([]);
        expect(r.hostRead).toEqual([]);
        expect(got.at(-1)).toMatchObject({ kind: 'error', channel: 'control', code: 'e2e', reason: OLD_MEMBER });
    });

    it('a host from before this build (admits after the proof, never answers the handshake): the member stops in words and sends nothing', async () => {
        // The old host, by hand: it registers, challenges, and then waits for a hello that must never come.
        const relay = fakeRelay(verifyHost);
        const host = relay.socket('wss://relay.example.com/ws/host');
        const hostGot: Array<Record<string, unknown>> = [];
        host.onopen = async () => host.send(JSON.stringify(await buildTicketHostHello({ ticket: 'ticket-1', workstationId: WS_ID, fingerprint: hostFingerprint, sign: (d) => sign(null, d, hostKey.privateKey) })));
        host.onmessage = (ev) => {
            const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
            hostGot.push(m);
            if (m.kind === 'open') host.send(JSON.stringify({ kind: 'data', channel: 'control', sid: m.sid, payload: { type: 'pop-challenge', nonce: 'aa' } }));
        };
        await settle();
        const pop = PopKeypair.generate();
        const opened = await openRelayMember({ socket: relay.socket, relayUrl: 'wss://relay.example.com', workstationId: WS_ID, name: NAME, grant: mintGrant({ cnf: { jkt: thumbprint(pop.publicJwk) } }), hostPublicKey: HOST_PUBLIC_KEY, pop, timeoutMs: 1_000, e2eTimeoutMs: 50 });
        expect(opened).toEqual({ ok: false, reason: OLD_HOST });
        await settle();
        // CONTROL: the old host did hear the member (its proof), so the absence below is not an empty wire.
        expect(hostGot.some((m) => (m.payload as { type?: string } | undefined)?.type === 'pop-proof')).toBe(true);
        expect(hostGot.filter((m) => m.channel === 'rest')).toEqual([]);
        host.close();
    });

    it('a second e2e-init on a session (the relay restarting the exchange) ends it', async () => {
        const r = await rig();
        const t = transportOf(await r.connect());
        const sid = [...r.relay.sessions.keys()][0]!;
        const init = r.seen('member', 'control').find((f) => (f.payload as { type?: string }).type === 'e2e-init')!;
        r.relay.toHost(sid, JSON.stringify(init));
        await settle();
        expect(t.closedBecause()).toBe(CHANGED_AT_HOST);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// The independent security review of this change (2026-11-23), finding by finding.

describe('review finding 1: the frame cap holds for the SEALED frame (Tynn #579)', () => {
    const hostFrames = (r: Awaited<ReturnType<typeof rig>>) => r.relay.wire.filter((w) => w.from === 'host').map((w) => Buffer.byteLength(w.text));
    /** A result whose text is `bytes` long and nearly all quotes: the worst text for anything that escapes. */
    const quoteHeavy = (id: number, bytes: number): string => {
        const shell = JSON.stringify({ kind: 'result', id, ok: true, value: '' });
        return JSON.stringify({ kind: 'result', id, ok: true, value: '"'.repeat(Math.floor((bytes - Buffer.byteLength(shell)) / 2)) });
    };

    it('a quote-heavy result just under the plain cap is refused in words for the same call, never sent over the cap, and the session lives', async () => {
        const r = await rig();
        const t = transportOf(await r.connect());
        const got = reading(t);
        t.send('hello');
        await settle();
        got.length = 0;
        const text = quoteHeavy(7, REMOTE_FRAME_MAX_BYTES - 64);
        // CONTROL: this is a frame the plain cap lets through.
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(REMOTE_FRAME_MAX_BYTES);
        r.admitted[0]!.send(text);
        await settle();
        expect(got).toHaveLength(1);
        expect(JSON.parse(got[0]!)).toEqual({ kind: 'result', id: 7, ok: false, reason: expect.stringMatching(/too large/) });
        expect(Math.max(...hostFrames(r))).toBeLessThanOrEqual(REMOTE_FRAME_MAX_BYTES);
        expect(t.closedBecause()).toBeNull();
        // CONTROL: the session still carries frames, and a large quote-heavy one under the sealed cap arrives whole.
        const fits = quoteHeavy(8, 380_000);
        r.admitted[0]!.send(fits);
        await settle();
        expect(got).toHaveLength(2);
        expect(got[1]).toBe(fits);
        expect(Math.max(...hostFrames(r))).toBeLessThanOrEqual(REMOTE_FRAME_MAX_BYTES);
        expect(Math.max(...hostFrames(r))).toBeGreaterThan(380_000);
    });

    it('an event that would seal over the cap is not sent, and the session lives', async () => {
        const r = await rig();
        const t = transportOf(await r.connect());
        const got = reading(t);
        t.send('hello');
        await settle();
        got.length = 0;
        r.admitted[0]!.send(JSON.stringify({ kind: 'event', channel: 'snapshot', payload: '"'.repeat(Math.floor((REMOTE_FRAME_MAX_BYTES - 200) / 2)) }));
        await settle();
        expect(got).toEqual([]);
        expect(Math.max(...hostFrames(r))).toBeLessThanOrEqual(REMOTE_FRAME_MAX_BYTES);
        expect(t.closedBecause()).toBeNull();
    });
});

describe('review finding 2: a grant renewal travels inside the seal', () => {
    // The first grant lives 3 to 4 s: long enough that a slow machine's connect leaves time to renew, short enough to wait out.
    const soon = () => Math.floor(Date.now() / 1000) + 4;

    it('CONTROL: an honest renewal is taken, the session outlives its first grant, and the relay reads neither the renewal nor the new grant', async () => {
        const r = await rig();
        const pop = PopKeypair.generate();
        const cnf = { cnf: { jkt: thumbprint(pop.publicJwk) } };
        const exp = soon();
        const first = mintGrant({ ...cnf, jti: 'g1', exp });
        const fresh = mintGrant({ ...cnf, jti: 'g2' });
        const t = transportOf(await r.connect({ pop, grant: first, renew: async () => ({ ok: true, token: fresh }) }));
        await vi.waitFor(() => { expect(r.validated).toContain(fresh); }, { timeout: 20_000, interval: 50 });
        await settle();
        // The first grant has expired by now; a re-check passes only because the session is under the new one.
        await vi.waitFor(() => { expect(Date.now() / 1000).toBeGreaterThan(exp + 0.1); }, { timeout: 20_000, interval: 50 });
        await r.link.revalidate();
        await settle();
        expect(t.closedBecause()).toBeNull();
        const all = r.relay.wire.map((w) => w.text).join('\n');
        expect(all).not.toContain('grant-renew');
        expect(all).not.toContain(fresh);
        // It did cross the relay: one sealed control frame from the member.
        expect(r.seen('member', 'control').filter((f) => (f.payload as { e2e?: unknown } | undefined)?.e2e === 1)).toHaveLength(1);
    }, 60_000);

    it('the relay substitutes another valid grant of the same person and key (a plain grant-renew): refused unread, and the session ends in words', async () => {
        const r = await rig();
        const pop = PopKeypair.generate();
        const cnf = { cnf: { jkt: thumbprint(pop.publicJwk) } };
        const older = mintGrant({ ...cnf, jti: 'g0' });
        const t = transportOf(await r.connect({ pop, grant: mintGrant({ ...cnf, jti: 'g1' }) }));
        await settle();
        const sid = [...r.relay.sessions.keys()][0]!;
        r.relay.toHost(sid, JSON.stringify({ kind: 'data', channel: 'control', sid, payload: { type: 'grant-renew', grant: older } }));
        await settle();
        expect(r.validated).not.toContain(older);
        expect(t.closedBecause()).toBe(CHANGED_AT_HOST);
    });

    it('the relay replays the member’s own sealed renewal: the session ends', async () => {
        const r = await rig();
        const pop = PopKeypair.generate();
        const cnf = { cnf: { jkt: thumbprint(pop.publicJwk) } };
        const fresh = mintGrant({ ...cnf, jti: 'g2' });
        const t = transportOf(await r.connect({ pop, grant: mintGrant({ ...cnf, jti: 'g1', exp: soon() }), renew: async () => ({ ok: true, token: fresh }) }));
        await vi.waitFor(() => { expect(r.validated).toContain(fresh); }, { timeout: 20_000, interval: 50 });
        await settle();
        const sid = [...r.relay.sessions.keys()][0]!;
        const sealed = r.seen('member', 'control').find((f) => (f.payload as { e2e?: unknown } | undefined)?.e2e === 1)!;
        r.relay.toHost(sid, JSON.stringify(sealed));
        await settle();
        expect(t.closedBecause()).toBe(CHANGED_AT_HOST);
    }, 60_000);
});

describe('review finding 3: a session id is opened once', () => {
    it('a second `control open` for a LIVE session is refused: the first session is untouched, nobody new is admitted, no grant is checked', async () => {
        const r = await rig();
        const t = transportOf(await r.connect());
        const got = reading(t);
        t.send('before');
        await settle();
        const sid = [...r.relay.sessions.keys()][0]!;
        const checked = r.validated.length;
        const intruder = PopKeypair.generate();
        r.relay.toHost(sid, JSON.stringify({ kind: 'open', channel: 'control', sid, payload: { grant: mintGrant({ cnf: { jkt: thumbprint(intruder.publicJwk) }, src: 'invite', scope: ['workspace:tynn'] }) } }));
        await settle();
        await new Promise((resolve) => setTimeout(resolve, 300)); // past the proof timeout a second admission would have armed
        await settle();
        expect(r.validated.length).toBe(checked);
        expect(r.admitted).toHaveLength(1);
        expect(t.closedBecause()).toBeNull();
        t.send('after');
        await settle();
        expect(r.hostRead).toEqual(['before', 'after']);
        expect(got).toEqual(['echo:before', 'echo:after']);
        expect(r.hostLog.join('\n')).toMatch(/already open/);
    });

    it('a second `control open` for a session UNDER ADMISSION is refused: the first admission completes as itself', async () => {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => { release = resolve; });
        const r = await rig({}, { holdValidate: () => held });
        const opening = r.connect({ e2eTimeoutMs: 2_000 });
        await vi.waitFor(() => { expect(r.relay.sessions.size).toBe(1); expect(r.validated).toHaveLength(1); }, { timeout: 2_000, interval: 10 });
        const sid = [...r.relay.sessions.keys()][0]!;
        const intruder = PopKeypair.generate();
        r.relay.toHost(sid, JSON.stringify({ kind: 'open', channel: 'control', sid, payload: { grant: mintGrant({ cnf: { jkt: thumbprint(intruder.publicJwk) }, src: 'invite', scope: ['workspace:tynn'] }) } }));
        await settle();
        expect(r.validated).toHaveLength(1);
        release();
        const t = transportOf(await opening);
        await settle();
        expect(r.admitted).toHaveLength(1);
        expect(r.admitted[0]!.preAuth).toMatchObject({ isOwner: true });
        t.send('mine');
        await settle();
        expect(r.hostRead).toEqual(['mine']);
        expect(t.closedBecause()).toBeNull();
    });
});

describe('review finding 5: one handshake a session, also while the host is answering it', () => {
    it('an e2e-init that arrives while the host is signing its answer to the first is refused, not kept', async () => {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => { release = resolve; });
        let signing = 0;
        const r = await rig({}, { holdSign: () => { signing += 1; return held; } });
        const opening = r.connect({ e2eTimeoutMs: 2_000 });
        await vi.waitFor(() => { expect(signing).toBe(1); }, { timeout: 2_000, interval: 10 });
        const sid = [...r.relay.sessions.keys()][0]!;
        const init = r.seen('member', 'control').find((f) => (f.payload as { type?: string }).type === 'e2e-init')!;
        r.relay.toHost(sid, JSON.stringify(init));
        await settle();
        release();
        expect(await opening).toEqual({ ok: false, reason: CHANGED_AT_HOST });
        await settle();
        expect(r.admitted).toEqual([]);
    });

    it('CONTROL: with a host that signs slowly and nothing injected, the member is admitted', async () => {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => { release = resolve; });
        let signing = 0;
        const r = await rig({}, { holdSign: () => { signing += 1; return held; } });
        const opening = r.connect({ e2eTimeoutMs: 2_000 });
        await vi.waitFor(() => { expect(signing).toBe(1); }, { timeout: 2_000, interval: 10 });
        release();
        expect((await opening).ok).toBe(true);
        await settle();
        expect(r.admitted).toHaveLength(1);
    });
});

describe('review residual: an admission acts only for the open that started it', () => {
    const challenges = (r: Awaited<ReturnType<typeof rig>>) => r.seen('host', 'control').filter((f) => (f.payload as { type?: string } | undefined)?.type === 'pop-challenge').length;

    it('open, close, open again for the same session id while the first grant is still being checked: a stale admission does nothing, and the later one goes on as itself', async () => {
        const releases: Array<() => void> = [];
        const r = await rig({}, { holdValidate: () => new Promise<void>((resolve) => { releases.push(resolve); }) });
        const first = r.connect({ e2eTimeoutMs: 5_000 });
        void first.catch(() => {});
        await vi.waitFor(() => { expect(r.validated).toHaveLength(1); }, { timeout: 5_000, interval: 10 });
        const sid = [...r.relay.sessions.keys()][0]!;
        // The relay says the member left, then opens the same session id again with another grant.
        r.relay.toHost(sid, JSON.stringify({ kind: 'close', channel: 'control', sid, reason: 'member left' }));
        const other = PopKeypair.generate();
        const later = mintGrant({ cnf: { jkt: thumbprint(other.publicJwk) }, jti: 'g-later', src: 'invite', scope: ['workspace:tynn'] });
        r.relay.toHost(sid, JSON.stringify({ kind: 'open', channel: 'control', sid, payload: { grant: later } }));
        await vi.waitFor(() => { expect(r.validated).toHaveLength(2); }, { timeout: 5_000, interval: 10 });
        expect(r.validated[1]).toBe(later);
        expect(challenges(r)).toBe(0);
        // The FIRST check answers now. Its open is gone: it must not challenge, time, or end anything for the later one.
        releases[0]!();
        await settle();
        expect(challenges(r)).toBe(0);
        expect(r.hostLog.filter((line) => line.includes('ended'))).toEqual([]);
        // CONTROL: the later admission is alive and goes on as itself when its own check answers: one challenge.
        releases[1]!();
        await settle();
        expect(challenges(r)).toBe(1);
        expect(r.admitted).toEqual([]);
    });
});
