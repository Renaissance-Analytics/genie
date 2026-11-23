import { createCipheriv, createDecipheriv, createHash, diffieHellman, generateKeyPairSync, hkdfSync, sign, verify, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { acceptMember, frameCipher, hostKeyOf, RelayE2eError, startMember, transcriptHash, E2E_FRAME_LIMIT } from '../src/main/relay-e2e.js';
import type { Frame } from '../src/main/relay-wire.js';

/**
 * THE RELAY PATH, END TO END (audit M-a, host split P9.2). The Tynn relay carries frames between a member and a host and
 * must be able to read and change none of Genie's own: a signed-ephemeral exchange (X25519; the HOST signs the transcript
 * with the key it enrolled at Tynn, the MEMBER with the key its grant is bound to), then AES-256-GCM on every `rest` and
 * `site` frame, counted per direction and channel.
 *
 * Everything the wire is made of is WRITTEN OUT here with node:crypto, not imported: the transcript, the two signed
 * strings, the key derivation, the nonce and the AAD. A drift in the module fails these rows.
 */

const WS = 'ws_host_1';
const SID = 'sid_7';
const GRANT = 'head.body.signature';

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const field = (v: string | Buffer) => { const b = typeof v === 'string' ? Buffer.from(v, 'utf8') : v; return Buffer.concat([u32(b.length), b]); };
const rawX = (key: KeyObject) => Buffer.from((key.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
const thumbprint = (jwk: { crv: string; kty: string; x: string }) => createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`, 'utf8').digest('base64url');

/** The transcript hash, written out: SHA-256 over length-prefixed fields, in this order. */
function referenceTh(t: { workstationId: string; sid: string; hostFingerprint: string; memberThumbprint: string; grant: string; memberEphemeral: Buffer; hostEphemeral: Buffer }): Buffer {
    return createHash('sha256').update(Buffer.concat([
        field('genie-relay-e2e v1'),
        field(t.workstationId),
        field(t.sid),
        field(t.hostFingerprint),
        field(t.memberThumbprint),
        field(createHash('sha256').update(t.grant, 'utf8').digest()),
        field(t.memberEphemeral),
        field(t.hostEphemeral),
    ])).digest();
}
const hostSigned = (th: Buffer) => Buffer.concat([Buffer.from('genie-relay-e2e v1 host\n', 'utf8'), th]);
const memberSigned = (th: Buffer) => Buffer.concat([Buffer.from('genie-relay-e2e v1 member\n', 'utf8'), th]);
const referenceKeys = (shared: Buffer, th: Buffer) => {
    const okm = Buffer.from(hkdfSync('sha256', shared, th, Buffer.from('genie-relay-e2e v1 keys', 'utf8'), 64));
    return { memberToHost: okm.subarray(0, 32), hostToMember: okm.subarray(32) };
};
const CHANNEL_ID = { rest: 1, site: 2 } as const;
const referenceNonce = (channel: 'rest' | 'site', seq: number) => { const b = Buffer.alloc(12); b.writeUInt32BE(CHANNEL_ID[channel], 0); b.writeBigUInt64BE(BigInt(seq), 4); return b; };
const referenceAad = (f: { sid: string; channel: string; kind: string; reqId?: string }, seq: number) => Buffer.from(JSON.stringify([1, f.sid, f.channel, f.kind, f.reqId ?? '', seq]), 'utf8');

function world() {
    const host = generateKeyPairSync('ed25519');
    const hostSpki = (host.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    const hostFingerprint = createHash('sha256').update(Buffer.from(hostSpki, 'base64')).digest('hex');
    const pop = generateKeyPairSync('ed25519');
    const j = pop.publicKey.export({ format: 'jwk' }) as { x: string };
    const memberJwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: j.x };
    const memberEph = generateKeyPairSync('x25519');
    const hostEph = generateKeyPairSync('x25519');
    const memberInput = { workstationId: WS, sid: SID, grant: GRANT, hostPublicKey: hostSpki, memberJwk, sign: (d: Buffer) => sign(null, d, pop.privateKey), ephemeral: memberEph };
    const hostInput = { workstationId: WS, sid: SID, grant: GRANT, hostFingerprint, memberJwk, sign: (d: Buffer) => sign(null, d, host.privateKey), ephemeral: hostEph };
    return { host, hostSpki, hostFingerprint, pop, memberJwk, memberEph, hostEph, memberInput, hostInput };
}

/** Both ends, honestly: the two ciphers of one session. */
async function session(w = world()) {
    const m = startMember(w.memberInput);
    const h = await acceptMember({ ...w.hostInput, init: m.init });
    const done = m.accept(h.accept);
    const hostCipher = h.finish(done.finish);
    return { w, m, h, done, memberCipher: done.cipher, hostCipher };
}

const rest = (payload: string): Frame => ({ kind: 'data', channel: 'rest', sid: SID, payload });
const refusal = (fn: () => unknown): RelayE2eError => {
    try { fn(); } catch (error) { if (error instanceof RelayE2eError) return error; throw error; }
    throw new Error('it was not refused');
};

describe('the handshake, byte for byte', () => {
    it('e2e-init carries the member’s ephemeral X25519 key, raw, and nothing else', () => {
        const w = world();
        const m = startMember(w.memberInput);
        expect(m.init).toEqual({ type: 'e2e-init', v: 1, e: rawX(w.memberEph.publicKey).toString('base64url') });
    });

    it('the transcript hash is SHA-256 over the length-prefixed label, workstation, session, host key, member key, grant and both ephemerals', () => {
        const w = world();
        const t = { workstationId: WS, sid: SID, hostFingerprint: w.hostFingerprint, memberThumbprint: thumbprint(w.memberJwk), grant: GRANT, memberEphemeral: rawX(w.memberEph.publicKey), hostEphemeral: rawX(w.hostEph.publicKey) };
        expect(transcriptHash(t).equals(referenceTh(t))).toBe(true);
    });

    it('e2e-accept is the host’s ephemeral key and its ENROLLED key’s signature over "genie-relay-e2e v1 host\\n" ‖ th', async () => {
        const w = world();
        const m = startMember(w.memberInput);
        const h = await acceptMember({ ...w.hostInput, init: m.init });
        expect(Object.keys(h.accept).sort()).toEqual(['e', 'sig', 'type', 'v']);
        expect(h.accept).toMatchObject({ type: 'e2e-accept', v: 1, e: rawX(w.hostEph.publicKey).toString('base64url') });
        const th = referenceTh({ workstationId: WS, sid: SID, hostFingerprint: w.hostFingerprint, memberThumbprint: thumbprint(w.memberJwk), grant: GRANT, memberEphemeral: rawX(w.memberEph.publicKey), hostEphemeral: rawX(w.hostEph.publicKey) });
        expect(verify(null, hostSigned(th), w.host.publicKey, Buffer.from(h.accept.sig, 'base64url'))).toBe(true);
    });

    it('e2e-finish is the signature of the key the GRANT is bound to over "genie-relay-e2e v1 member\\n" ‖ th', async () => {
        const { w, done } = await session();
        expect(Object.keys(done.finish).sort()).toEqual(['sig', 'type']);
        const th = referenceTh({ workstationId: WS, sid: SID, hostFingerprint: w.hostFingerprint, memberThumbprint: thumbprint(w.memberJwk), grant: GRANT, memberEphemeral: rawX(w.memberEph.publicKey), hostEphemeral: rawX(w.hostEph.publicKey) });
        expect(verify(null, memberSigned(th), w.pop.publicKey, Buffer.from(done.finish.sig, 'base64url'))).toBe(true);
        // The two signatures are over different strings: one can never stand for the other.
        expect(verify(null, hostSigned(th), w.pop.publicKey, Buffer.from(done.finish.sig, 'base64url'))).toBe(false);
    });

    it('the keys are HKDF-SHA256(X25519 shared, salt = th, "genie-relay-e2e v1 keys"), one per direction; a frame is AES-256-GCM under a channel+counter nonce', async () => {
        const { w, memberCipher, hostCipher } = await session();
        const th = referenceTh({ workstationId: WS, sid: SID, hostFingerprint: w.hostFingerprint, memberThumbprint: thumbprint(w.memberJwk), grant: GRANT, memberEphemeral: rawX(w.memberEph.publicKey), hostEphemeral: rawX(w.hostEph.publicKey) });
        const keys = referenceKeys(diffieHellman({ privateKey: w.memberEph.privateKey, publicKey: w.hostEph.publicKey }), th);
        expect(keys.memberToHost.equals(keys.hostToMember)).toBe(false);

        // Member → host, opened by hand.
        const sealed = memberCipher.seal(rest('{"kind":"hello"}'));
        expect(sealed).toMatchObject({ kind: 'data', channel: 'rest', sid: SID });
        const env = sealed.payload as { e2e: number; n: number; c: string };
        expect(Object.keys(env).sort()).toEqual(['c', 'e2e', 'n']);
        expect(env).toMatchObject({ e2e: 1, n: 1 });
        const bytes = Buffer.from(env.c, 'base64');
        const d = createDecipheriv('aes-256-gcm', keys.memberToHost, referenceNonce('rest', 1));
        d.setAAD(referenceAad(sealed, 1));
        d.setAuthTag(bytes.subarray(bytes.length - 16));
        const plain = Buffer.concat([d.update(bytes.subarray(0, bytes.length - 16)), d.final()]).toString('utf8');
        expect(JSON.parse(plain)).toEqual({ p: '{"kind":"hello"}' });

        // Host → member, sealed by hand on the SITE channel: the module opens it.
        const frame = { kind: 'error' as const, channel: 'site' as const, sid: SID, reqId: 'site_1' };
        const c = createCipheriv('aes-256-gcm', keys.hostToMember, referenceNonce('site', 1));
        c.setAAD(referenceAad(frame, 1));
        const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify({ r: 'refused' }), 'utf8')), c.final(), c.getAuthTag()]);
        expect(memberCipher.open({ ...frame, payload: { e2e: 1, n: 1, c: ct.toString('base64') } })).toEqual({ ...frame, reason: 'refused' });
        // And the host's own seal opens at the member (on rest: the hand-made frame above took the site channel's first number).
        expect(memberCipher.open(hostCipher.seal(rest('{"kind":"welcome"}')))).toEqual(rest('{"kind":"welcome"}'));
    });

    it('what a frame said in words (reason, code) travels inside the seal, not beside it', async () => {
        const { memberCipher, hostCipher } = await session();
        const sealed = hostCipher.seal({ kind: 'error', channel: 'site', sid: SID, reqId: 'site_2', reason: 'no such site: secret.gen', code: 'x' });
        expect(sealed.reason).toBeUndefined();
        expect(sealed.code).toBeUndefined();
        expect(JSON.stringify(sealed)).not.toContain('secret.gen');
        expect(memberCipher.open(sealed)).toEqual({ kind: 'error', channel: 'site', sid: SID, reqId: 'site_2', reason: 'no such site: secret.gen', code: 'x' });
    });
});

describe('who the other end is', () => {
    // CONTROL for every refusal below: the same world, untouched, completes (`session()` above and here).
    it('CONTROL: an honest exchange completes and traffic passes both ways', async () => {
        const { memberCipher, hostCipher } = await session();
        expect(hostCipher.open(memberCipher.seal(rest('a')))).toEqual(rest('a'));
        expect(memberCipher.open(hostCipher.seal(rest('b')))).toEqual(rest('b'));
    });

    it('a host that signs with ANOTHER key than the one Tynn named is refused, and no finish is made', async () => {
        const w = world();
        const other = generateKeyPairSync('ed25519');
        const m = startMember(w.memberInput);
        const h = await acceptMember({ ...w.hostInput, sign: (d) => sign(null, d, other.privateKey), init: m.init });
        expect(refusal(() => m.accept(h.accept)).code).toBe('host-not-proved');
    });

    it('Tynn naming ANOTHER key than the host holds is refused the same way', async () => {
        const w = world();
        const other = generateKeyPairSync('ed25519');
        const m = startMember({ ...w.memberInput, hostPublicKey: (other.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64') });
        const h = await acceptMember({ ...w.hostInput, init: m.init });
        expect(refusal(() => m.accept(h.accept)).code).toBe('host-not-proved');
    });

    it.each([
        ['another workstation', { workstationId: 'ws_other' }],
        ['another session', { sid: 'sid_8' }],
        ['another grant', { grant: 'head.other.signature' }],
    ])('a host signature made for %s does not prove this one', async (_name, change) => {
        const w = world();
        const m = startMember(w.memberInput);
        const h = await acceptMember({ ...w.hostInput, ...change, init: m.init });
        expect(refusal(() => m.accept(h.accept)).code).toBe('host-not-proved');
    });

    it('a swapped host ephemeral (the relay’s own) is refused: the signature covers it', async () => {
        const w = world();
        const m = startMember(w.memberInput);
        const h = await acceptMember({ ...w.hostInput, init: m.init });
        const relays = generateKeyPairSync('x25519');
        expect(refusal(() => m.accept({ ...h.accept, e: rawX(relays.publicKey).toString('base64url') })).code).toBe('host-not-proved');
    });

    it('a member that does not hold the grant’s key is refused by the host (the relay cannot take an admitted member’s place)', async () => {
        const w = world();
        const intruder = generateKeyPairSync('ed25519');
        const m = startMember({ ...w.memberInput, sign: (d) => sign(null, d, intruder.privateKey) });
        const h = await acceptMember({ ...w.hostInput, init: m.init });
        const done = m.accept(h.accept);
        expect(refusal(() => h.finish(done.finish)).code).toBe('member-not-proved');
    });

    it('a finish made for another exchange (the relay’s own ephemeral toward the host) is refused', async () => {
        const w = world();
        // The honest member runs its exchange; the relay runs ANOTHER with the host and replays the member's finish into it.
        const honest = startMember(w.memberInput);
        const honestHost = await acceptMember({ ...w.hostInput, init: honest.init });
        const finish = honest.accept(honestHost.accept).finish;
        const relays = generateKeyPairSync('x25519');
        const hijack = await acceptMember({ ...w.hostInput, ephemeral: generateKeyPairSync('x25519'), init: { type: 'e2e-init', v: 1, e: rawX(relays.publicKey).toString('base64url') } });
        expect(refusal(() => hijack.finish(finish)).code).toBe('member-not-proved');
    });

    it.each([
        ['no key', null],
        ['an empty key', ''],
        ['not base64 of a key', 'not a key'],
        ['an RSA-shaped blob', Buffer.alloc(294, 7).toString('base64')],
        ['an X25519 key (not a signing key)', (generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')],
    ])('Tynn answering with %s: there is no host key, so nothing starts', (_name, value) => {
        expect(hostKeyOf(value)).toBeNull();
        const w = world();
        expect(refusal(() => startMember({ ...w.memberInput, hostPublicKey: value as string })).code).toBe('no-host-key');
    });

    it('the words name the machine as it is written, and say something when no name is known', async () => {
        const { e2eWords } = await import('../src/main/relay-e2e.js');
        expect(e2eWords.oldHost('alphar')).toBe('alphar runs an older Genie that cannot make an encrypted connection. Update Genie on alphar. Nothing was sent.');
        expect(e2eWords.oldHost(null)).toBe('The workstation you asked for runs an older Genie that cannot make an encrypted connection. Update Genie on the workstation you asked for. Nothing was sent.');
        expect(e2eWords.notProved('alphar')).toBe('This workstation could not prove it is alphar. Nothing was sent. If alphar was set up again, wait until it has signed in to Tynn, then connect again.');
        expect(e2eWords.notProved('  ')).toMatch(/^This workstation could not prove it is the workstation you asked for[.] Nothing was sent[.]/);
    });

    it('CONTROL: an Ed25519 SPKI key from Tynn is read, with the fingerprint the host itself reports', () => {
        const w = world();
        const read = hostKeyOf(w.hostSpki);
        expect(read?.fingerprint).toBe(w.hostFingerprint);
        expect(read?.key.equals(w.host.publicKey)).toBe(true);
    });

    it.each([
        ['an all-zero ephemeral (a low-order point: the shared secret would be zero)', Buffer.alloc(32).toString('base64url')],
        ['a short ephemeral', Buffer.alloc(31, 1).toString('base64url')],
        ['a long ephemeral', Buffer.alloc(33, 1).toString('base64url')],
        ['no ephemeral', undefined],
    ])('%s is refused by the host', async (_name, e) => {
        const w = world();
        await expect(acceptMember({ ...w.hostInput, init: { type: 'e2e-init', v: 1, e } })).rejects.toBeInstanceOf(RelayE2eError);
    });

    it('an all-zero host ephemeral is refused by the member, whatever is signed', async () => {
        const w = world();
        const m = startMember(w.memberInput);
        const zero = Buffer.alloc(32);
        const th = referenceTh({ workstationId: WS, sid: SID, hostFingerprint: w.hostFingerprint, memberThumbprint: thumbprint(w.memberJwk), grant: GRANT, memberEphemeral: rawX(w.memberEph.publicKey), hostEphemeral: zero });
        // Even signed by the REAL host key: the exchange itself is refused.
        const sig = sign(null, hostSigned(th), w.host.privateKey).toString('base64url');
        expect(refusal(() => m.accept({ type: 'e2e-accept', v: 1, e: zero.toString('base64url'), sig })).code).toBe('malformed');
    });

    it.each([
        ['another version from the member', (i: Record<string, unknown>) => ({ ...i, v: 2 })],
        ['no version', (i: Record<string, unknown>) => { const { v: _v, ...rest } = i; return rest; }],
        ['another type', (i: Record<string, unknown>) => ({ ...i, type: 'site-key-init' })],
    ])('%s is refused: there is one version and no older one to fall back to', async (_name, change) => {
        const w = world();
        const m = startMember(w.memberInput);
        await expect(acceptMember({ ...w.hostInput, init: change({ ...m.init }) })).rejects.toBeInstanceOf(RelayE2eError);
    });

    it('an accept of another version is refused by the member', async () => {
        const w = world();
        const m = startMember(w.memberInput);
        const h = await acceptMember({ ...w.hostInput, init: m.init });
        expect(refusal(() => m.accept({ ...h.accept, v: 2 })).code).toBe('malformed');
    });

    it('an exchange is answered once: a second accept, or a second finish, is refused', async () => {
        const w = world();
        const m = startMember(w.memberInput);
        const h = await acceptMember({ ...w.hostInput, init: m.init });
        const done = m.accept(h.accept);
        expect(() => m.accept(h.accept)).toThrow(RelayE2eError);
        h.finish(done.finish);
        expect(() => h.finish(done.finish)).toThrow(RelayE2eError);
    });
});

describe('a frame the relay touched', () => {
    const tamper = (frame: Frame, change: (env: { e2e: number; n: number; c: string }) => unknown): Frame => ({ ...frame, payload: change({ ...(frame.payload as { e2e: number; n: number; c: string }) }) });
    const flip = (c: string, at: number) => { const b = Buffer.from(c, 'base64'); b[at] = b[at]! ^ 0x01; return b.toString('base64'); };

    it('CONTROL: untouched, three frames in order open', async () => {
        const { memberCipher, hostCipher } = await session();
        for (const text of ['one', 'two', 'three']) expect(hostCipher.open(memberCipher.seal(rest(text)))).toEqual(rest(text));
    });

    it.each([
        ['the first ciphertext byte', (f: Frame) => tamper(f, (e) => ({ ...e, c: flip(e.c, 0) }))],
        ['the last tag byte', (f: Frame) => tamper(f, (e) => ({ ...e, c: flip(e.c, Buffer.from(e.c, 'base64').length - 1) }))],
        ['the channel (rest moved to site)', (f: Frame) => ({ ...f, channel: 'site' as const })],
        ['the kind', (f: Frame) => ({ ...f, kind: 'close' as const })],
        ['the reqId', (f: Frame) => ({ ...f, reqId: 'site_9' })],
        ['the session', (f: Frame) => ({ ...f, sid: 'sid_8' })],
        ['a truncated ciphertext', (f: Frame) => tamper(f, (e) => ({ ...e, c: Buffer.from(e.c, 'base64').subarray(0, 8).toString('base64') }))],
        ['an added reason beside the seal', (f: Frame) => ({ ...f, reason: 'said the relay' })],
        ['an added code beside the seal', (f: Frame) => ({ ...f, code: 'x' })],
    ])('one change to %s: the frame is refused', async (_name, change) => {
        const { memberCipher, hostCipher } = await session();
        expect(refusal(() => hostCipher.open(change(memberCipher.seal(rest('{"kind":"call"}'))))).code).toBe('frame');
    });

    it('a frame that is not sealed at all is refused: there is no plain path', async () => {
        const fresh = { a: await session(), b: await session(), c: await session() };
        // A session each: a cipher that refused once refuses everything after (the row below), so each plain frame meets a live one.
        expect(refusal(() => fresh.a.hostCipher.open(rest('{"kind":"hello"}'))).code).toBe('plain');
        expect(refusal(() => fresh.b.memberCipher.open({ kind: 'data', channel: 'site', sid: SID, reqId: 'site_1', payload: { t: 'open', ca: 'RELAY CA' } })).code).toBe('plain');
        expect(refusal(() => fresh.c.memberCipher.open({ kind: 'close', channel: 'site', sid: SID, reqId: 'site_1' })).code).toBe('plain');
    });

    it('a frame delivered twice is refused the second time', async () => {
        const { memberCipher, hostCipher } = await session();
        const sealed = memberCipher.seal(rest('pay once'));
        expect(hostCipher.open(sealed)).toEqual(rest('pay once'));
        expect(refusal(() => hostCipher.open(sealed)).code).toBe('sequence');
    });

    it('a frame left out is noticed at the next one; two frames of one channel swapped are refused', async () => {
        const a = await session();
        a.memberCipher.seal(rest('dropped'));
        expect(refusal(() => a.hostCipher.open(a.memberCipher.seal(rest('next')))).code).toBe('sequence');
        const b = await session();
        const first = b.memberCipher.seal(rest('first'));
        const second = b.memberCipher.seal(rest('second'));
        expect(refusal(() => b.hostCipher.open(second)).code).toBe('sequence');
        void first;
    });

    it('a number rewritten to the expected one does not open another frame (the number is in the nonce and the AAD)', async () => {
        const { memberCipher, hostCipher } = await session();
        memberCipher.seal(rest('dropped'));
        const second = memberCipher.seal(rest('second'));
        expect(refusal(() => hostCipher.open(tamper(second, (e) => ({ ...e, n: 1 })))).code).toBe('frame');
    });

    it('a frame reflected to its own sender does not open (each direction has its own key)', async () => {
        const { memberCipher } = await session();
        expect(refusal(() => memberCipher.open(memberCipher.seal(rest('mine')))).code).toBe('frame');
    });

    it('a frame from ANOTHER session of the same two machines does not open', async () => {
        const w = world();
        const one = await session(w);
        const two = await session({ ...w, memberInput: { ...w.memberInput, ephemeral: generateKeyPairSync('x25519') }, hostInput: { ...w.hostInput, ephemeral: generateKeyPairSync('x25519') } });
        expect(refusal(() => two.hostCipher.open(one.memberCipher.seal(rest('old session')))).code).toBe('frame');
    });

    it('after any refusal the cipher is dead: the next honest frame is refused too (fail closed, nothing is skipped)', async () => {
        const { memberCipher, hostCipher } = await session();
        const good = memberCipher.seal(rest('good'));
        expect(() => hostCipher.open(tamper(good, (e) => ({ ...e, c: flip(e.c, 0) })))).toThrow(RelayE2eError);
        expect(() => hostCipher.open(good)).toThrow(RelayE2eError);
        expect(() => hostCipher.seal(rest('reply'))).toThrow(RelayE2eError);
    });
});

describe('the channels are counted apart', () => {
    it('rest and site frames may arrive in either order relative to each other (a relay may pace channels differently)', async () => {
        const { memberCipher, hostCipher } = await session();
        const r1 = memberCipher.seal(rest('r1'));
        const s1 = memberCipher.seal({ kind: 'open', channel: 'site', sid: SID, reqId: 'site_1', payload: { host: 'app.gen' } });
        const r2 = memberCipher.seal(rest('r2'));
        expect((r1.payload as { n: number }).n).toBe(1);
        expect((s1.payload as { n: number }).n).toBe(1);
        expect((r2.payload as { n: number }).n).toBe(2);
        // Sent r1, s1, r2; delivered s1, r1, r2: each channel is still in its own order.
        expect(hostCipher.open(s1)).toMatchObject({ channel: 'site', payload: { host: 'app.gen' } });
        expect(hostCipher.open(r1)).toEqual(rest('r1'));
        expect(hostCipher.open(r2)).toEqual(rest('r2'));
    });

    it('the same number on the two channels never shares a nonce: a rest frame does not open as the site frame of that number', async () => {
        const { memberCipher, hostCipher } = await session();
        const r1 = memberCipher.seal(rest('r1'));
        expect(refusal(() => hostCipher.open({ ...r1, channel: 'site', reqId: 'site_1' })).code).toBe('frame');
    });

    it('only rest and site are sealed; a control frame is not this cipher’s to carry', async () => {
        const { memberCipher } = await session();
        expect(() => memberCipher.seal({ kind: 'data', channel: 'control', sid: SID, payload: { type: 'grant-renew' } })).toThrow(RelayE2eError);
        expect(() => memberCipher.open({ kind: 'data', channel: 'control', sid: SID, payload: { type: 'pop-challenge' } })).toThrow(RelayE2eError);
    });
});

describe('the limit', () => {
    const keys = () => ({ send: Buffer.alloc(32, 1), receive: Buffer.alloc(32, 2) });

    it('is 2^32 frames in one direction on one channel', () => {
        expect(E2E_FRAME_LIMIT).toBe(2 ** 32);
    });

    it('CONTROL: the last frame under the limit is sealed and opened', () => {
        const a = frameCipher({ ...keys(), sid: SID, sent: { rest: E2E_FRAME_LIMIT - 2 } });
        const b = frameCipher({ send: keys().receive, receive: keys().send, sid: SID, received: { rest: E2E_FRAME_LIMIT - 2 } });
        const sealed = a.seal(rest('last'));
        expect((sealed.payload as { n: number }).n).toBe(E2E_FRAME_LIMIT - 1);
        expect(b.open(sealed)).toEqual(rest('last'));
    });

    it('the frame that would reach the limit is not sealed: the session ends instead', () => {
        const a = frameCipher({ ...keys(), sid: SID, sent: { rest: E2E_FRAME_LIMIT - 1 } });
        expect(refusal(() => a.seal(rest('one too many'))).code).toBe('limit');
        // The site channel's own count is not the rest channel's.
        const s = frameCipher({ ...keys(), sid: SID, sent: { rest: E2E_FRAME_LIMIT - 1 } });
        expect(() => s.seal({ kind: 'close', channel: 'site', sid: SID, reqId: 'site_1' })).not.toThrow();
    });

    it('a received number at or past the limit is refused', () => {
        const b = frameCipher({ send: keys().receive, receive: keys().send, sid: SID, received: { rest: E2E_FRAME_LIMIT - 1 } });
        expect(() => b.open({ kind: 'data', channel: 'rest', sid: SID, payload: { e2e: 1, n: E2E_FRAME_LIMIT, c: Buffer.alloc(32).toString('base64') } })).toThrow(RelayE2eError);
    });

    it.each([['a fraction', 1.5], ['zero', 0], ['a negative number', -1], ['a string', '1'], ['beyond a safe integer', 2 ** 60]])('a frame number that is %s is refused', (_name, n) => {
        const b = frameCipher({ send: keys().receive, receive: keys().send, sid: SID });
        expect(() => b.open({ kind: 'data', channel: 'rest', sid: SID, payload: { e2e: 1, n, c: Buffer.alloc(32).toString('base64') } })).toThrow(RelayE2eError);
    });
});

describe('the capability', () => {
    it('both sides say `relay-e2e@1` in their offers (what the window’s bar reads; the refusal of an older peer does not rest on it)', async () => {
        const { remoteCapabilities, remoteOffer } = await import('../src/core/protocol-version.js');
        expect(remoteCapabilities()).toContain('relay-e2e@1');
        expect(remoteOffer('host').capabilities).toContain('relay-e2e@1');
        expect(remoteOffer('client').capabilities).toContain('relay-e2e@1');
    });
});
