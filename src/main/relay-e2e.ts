import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, verify, type KeyObject } from 'node:crypto';
import { jwkThumbprint, type Frame, type PopJwk } from './relay-wire.js';

/**
 * THE RELAY PATH, END TO END (audit M-a, host split P9.2). The Tynn relay carries frames between a member and a host;
 * with this it can read and change none of Genie's own. node:crypto only, nothing invented: a signed ephemeral
 * Diffie-Hellman (the SIGMA shape TLS 1.3 uses), then an AEAD on every frame.
 *
 *   member → host  e2e-init    {v:1, e}        the member's ephemeral X25519 public key (raw, base64url)
 *   host → member  e2e-accept  {v:1, e, sig}   the host's ephemeral, and its ENROLLED Ed25519 key's signature over
 *                                              "genie-relay-e2e v1 host\n" ‖ th
 *   member → host  e2e-finish  {sig}           the signature of the key the member's GRANT is bound to (`cnf.jkt`) over
 *                                              "genie-relay-e2e v1 member\n" ‖ th
 *
 * `th` is SHA-256 over the length-prefixed label, workstation id, session id, the host key's fingerprint, the member
 * key's thumbprint, SHA-256 of the exact grant, and both ephemerals. So each signature is good for this workstation,
 * this session, this grant (and with it the rights the host reads from it) and this exchange only.
 *
 * - The member checks the host's signature with the key TYNN returned with the grant. No key the relay could supply is
 *   ever read: `e2e-accept` carries none.
 * - The host checks the member's signature with the key the Tynn-signed grant names. A relay cannot run its own exchange
 *   in an admitted member's place.
 * - Keys: HKDF-SHA256(X25519 shared, salt = th, info = "genie-relay-e2e v1 keys") → one per direction. The ephemerals
 *   are per connection; the long-lived keys only sign.
 * - Frames: AES-256-GCM. The nonce is the channel's id (rest 1, site 2) and a 64-bit counter kept per direction and
 *   channel, so no nonce repeats under a key; the AAD is the envelope the relay routes on (session, channel, kind,
 *   reqId) and the number. The receiver takes exactly the next number on each channel: a changed, repeated, dropped or
 *   reordered frame ends the session. Channels are counted apart because a relay may pace them apart.
 * - A counter stops before 2^32: the session ends and the member connects again.
 * - There is one version and no plain path. Anything that is not exactly this is refused, and a cipher that refused once
 *   refuses everything after.
 */

const LABEL = 'genie-relay-e2e v1';
const VERSION = 1;
const CHANNEL_ID = { rest: 1, site: 2 } as const;
type SealedChannel = keyof typeof CHANNEL_ID;
const TAG_BYTES = 16;

/** The most frames one direction of one channel carries in a session. */
export const E2E_FRAME_LIMIT = 2 ** 32;

export type RelayE2eCode =
    /** Tynn named no usable key for the host. */
    | 'no-host-key'
    /** The host did not prove it holds the key Tynn named. */
    | 'host-not-proved'
    /** The member did not prove it holds the key its grant names. */
    | 'member-not-proved'
    /** A handshake message that is not one. */
    | 'malformed'
    /** A frame that does not open: changed, or not for this session, channel or number. */
    | 'frame'
    /** A frame out of its order: repeated, early, or after one that never came. */
    | 'sequence'
    /** A rest or site frame that is not sealed. */
    | 'plain'
    /** The counter's end. */
    | 'limit'
    /** Used after it refused, or asked for something it does not do. */
    | 'state';

export class RelayE2eError extends Error {
    readonly code: RelayE2eCode;
    constructor(code: RelayE2eCode, detail: string) {
        super(`relay end-to-end: ${detail}`);
        this.name = 'RelayE2eError';
        this.code = code;
    }
}

export interface E2eInit { type: 'e2e-init'; v: 1; e: string }
export interface E2eAccept { type: 'e2e-accept'; v: 1; e: string; sig: string }
export interface E2eFinish { type: 'e2e-finish'; sig: string }

export interface X25519Pair { publicKey: KeyObject; privateKey: KeyObject }

/** SHA-256 (hex) of an SPKI DER public key: the fingerprint a host reports for its enrolled key (workstation-identity.ts). */
const fingerprintOf = (spki: Buffer): string => createHash('sha256').update(spki).digest('hex');

/**
 * The host key as Tynn names it (`host_public_key`: SPKI DER, base64), or null when it is not an Ed25519 public key.
 */
export function hostKeyOf(value: unknown): { key: KeyObject; fingerprint: string } | null {
    if (typeof value !== 'string' || value === '' || value.length > 4096) return null;
    try {
        const spki = Buffer.from(value, 'base64');
        const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
        if (key.asymmetricKeyType !== 'ed25519') return null;
        // The fingerprint is of the key's own canonical encoding, whatever padding or spacing the text had.
        return { key, fingerprint: fingerprintOf(key.export({ type: 'spki', format: 'der' }) as Buffer) };
    } catch {
        return null;
    }
}

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const field = (value: string | Buffer): Buffer => { const b = typeof value === 'string' ? Buffer.from(value, 'utf8') : value; return Buffer.concat([u32(b.length), b]); };

export interface Transcript {
    workstationId: string;
    sid: string;
    /** SHA-256 (hex) of the host's enrolled key (SPKI DER). */
    hostFingerprint: string;
    /** RFC 7638 thumbprint of the key the member's grant is bound to. */
    memberThumbprint: string;
    /** The grant, exactly as sent. */
    grant: string;
    memberEphemeral: Buffer;
    hostEphemeral: Buffer;
}

export function transcriptHash(t: Transcript): Buffer {
    return createHash('sha256').update(Buffer.concat([
        field(LABEL),
        field(t.workstationId),
        field(t.sid),
        field(t.hostFingerprint),
        field(t.memberThumbprint),
        field(createHash('sha256').update(t.grant, 'utf8').digest()),
        field(t.memberEphemeral),
        field(t.hostEphemeral),
    ])).digest();
}

const hostSigned = (th: Buffer): Buffer => Buffer.concat([Buffer.from(`${LABEL} host\n`, 'utf8'), th]);
const memberSigned = (th: Buffer): Buffer => Buffer.concat([Buffer.from(`${LABEL} member\n`, 'utf8'), th]);

const rawPublic = (key: KeyObject): Buffer => Buffer.from((key.export({ format: 'jwk' }) as { x?: string }).x ?? '', 'base64url');

/** A peer's ephemeral X25519 public key from its 32 raw bytes (base64url); a low-order point is refused. */
function ephemeralOf(value: unknown): { key: KeyObject; raw: Buffer } {
    if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new RelayE2eError('malformed', 'the ephemeral key is not 32 bytes');
    const raw = Buffer.from(value, 'base64url');
    if (raw.length !== 32 || raw.toString('base64url') !== value) throw new RelayE2eError('malformed', 'the ephemeral key is not 32 bytes');
    try {
        return { key: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: value }, format: 'jwk' }), raw };
    } catch {
        throw new RelayE2eError('malformed', 'the ephemeral key is not an X25519 key');
    }
}

/** The X25519 shared secret; all zero (a low-order point from the peer) is refused, as RFC 7748 §6.1 asks. */
function sharedOf(privateKey: KeyObject, publicKey: KeyObject): Buffer {
    let shared: Buffer;
    try {
        shared = diffieHellman({ privateKey, publicKey });
    } catch {
        throw new RelayE2eError('malformed', 'the key exchange failed');
    }
    if (shared.length !== 32 || shared.every((b) => b === 0)) throw new RelayE2eError('malformed', 'the key exchange failed');
    return shared;
}

function keysOf(shared: Buffer, th: Buffer): { memberToHost: Buffer; hostToMember: Buffer } {
    const okm = Buffer.from(hkdfSync('sha256', shared, th, Buffer.from(`${LABEL} keys`, 'utf8'), 64));
    return { memberToHost: Buffer.from(okm.subarray(0, 32)), hostToMember: Buffer.from(okm.subarray(32)) };
}

const signatureOf = (value: unknown): Buffer | null => {
    if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const sig = Buffer.from(value, 'base64url');
    return sig.length === 64 ? sig : null;
};

const objectOf = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

// ---- the frames --------------------------------------------------------------------------------------------------------

export interface FrameCipher {
    /** Seal a `rest` or `site` frame for the wire. Call it at the moment of the write: a sealed frame took its number. */
    seal(frame: Frame): Frame;
    /** Open a `rest` or `site` frame from the wire, or throw: nothing that throws was delivered, and nothing after it will be. */
    open(frame: Frame): Frame;
}

const isSealedChannel = (channel: string): channel is SealedChannel => channel === 'rest' || channel === 'site';

function nonceOf(channel: SealedChannel, n: number): Buffer {
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(CHANNEL_ID[channel], 0);
    nonce.writeBigUInt64BE(BigInt(n), 4);
    return nonce;
}

const aadOf = (frame: Pick<Frame, 'sid' | 'channel' | 'kind' | 'reqId'>, n: number): Buffer => Buffer.from(JSON.stringify([VERSION, frame.sid, frame.channel, frame.kind, frame.reqId ?? '', n]), 'utf8');

/**
 * One end's cipher for a session: `send` seals what this end writes, `receive` opens what it reads. `sent` and `received`
 * are where each channel's count stands (a new session: nothing).
 */
export function frameCipher(input: { send: Buffer; receive: Buffer; sid: string; sent?: Partial<Record<SealedChannel, number>>; received?: Partial<Record<SealedChannel, number>> }): FrameCipher {
    if (input.send.length !== 32 || input.receive.length !== 32) throw new RelayE2eError('state', 'a frame key is 32 bytes');
    const sent: Record<SealedChannel, number> = { rest: input.sent?.rest ?? 0, site: input.sent?.site ?? 0 };
    const received: Record<SealedChannel, number> = { rest: input.received?.rest ?? 0, site: input.received?.site ?? 0 };
    let dead = false;
    const refuse = (code: RelayE2eCode, detail: string): never => {
        dead = true;
        throw new RelayE2eError(code, detail);
    };
    return {
        seal(frame) {
            if (dead) throw new RelayE2eError('state', 'this session was already refused');
            if (!isSealedChannel(frame.channel)) return refuse('state', 'only rest and site frames are sealed');
            if (frame.sid !== input.sid) return refuse('state', 'a frame of another session');
            const n = sent[frame.channel] + 1;
            if (n >= E2E_FRAME_LIMIT) return refuse('limit', 'this session carried as many frames as one session may');
            sent[frame.channel] = n;
            const inner: { p?: unknown; r?: string; c?: string } = {};
            if (frame.payload !== undefined) inner.p = frame.payload;
            if (frame.reason !== undefined) inner.r = frame.reason;
            if (frame.code !== undefined) inner.c = frame.code;
            const cipher = createCipheriv('aes-256-gcm', input.send, nonceOf(frame.channel, n));
            cipher.setAAD(aadOf(frame, n));
            const c = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(inner), 'utf8')), cipher.final(), cipher.getAuthTag()]).toString('base64');
            const sealed: Frame = { kind: frame.kind, channel: frame.channel, sid: frame.sid, payload: { e2e: VERSION, n, c } };
            if (frame.reqId !== undefined) sealed.reqId = frame.reqId;
            return sealed;
        },
        open(frame) {
            if (dead) throw new RelayE2eError('state', 'this session was already refused');
            if (!isSealedChannel(frame.channel)) return refuse('state', 'only rest and site frames are sealed');
            const envelope = frame.payload as { e2e?: unknown; n?: unknown; c?: unknown } | null | undefined;
            if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope) || envelope.e2e !== VERSION) return refuse('plain', 'a frame that is not sealed');
            // What the relay could add beside the seal is not read, and not let through.
            if (frame.reason !== undefined || frame.code !== undefined || Object.keys(envelope).length !== 3) return refuse('frame', 'a sealed frame carries nothing beside its seal');
            const n = envelope.n;
            if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n >= E2E_FRAME_LIMIT) return refuse('sequence', 'a frame number that is not one');
            if (n !== received[frame.channel] + 1) return refuse('sequence', 'a frame out of its order');
            if (typeof envelope.c !== 'string') return refuse('frame', 'a sealed frame with no ciphertext');
            const bytes = Buffer.from(envelope.c, 'base64');
            if (bytes.length < TAG_BYTES) return refuse('frame', 'a sealed frame too short to be one');
            let text: string;
            try {
                const decipher = createDecipheriv('aes-256-gcm', input.receive, nonceOf(frame.channel, n));
                decipher.setAAD(aadOf(frame, n));
                decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
                text = Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)), decipher.final()]).toString('utf8');
            } catch {
                return refuse('frame', 'a frame that does not open');
            }
            let inner: { p?: unknown; r?: unknown; c?: unknown };
            try {
                inner = objectOf(JSON.parse(text));
            } catch {
                return refuse('frame', 'a frame that opened to something else');
            }
            received[frame.channel] = n;
            const opened: Frame = { kind: frame.kind, channel: frame.channel, sid: frame.sid };
            if (frame.reqId !== undefined) opened.reqId = frame.reqId;
            if (inner.p !== undefined) opened.payload = inner.p;
            if (typeof inner.r === 'string') opened.reason = inner.r;
            if (typeof inner.c === 'string') opened.code = inner.c;
            return opened;
        },
    };
}

// ---- the member's side -------------------------------------------------------------------------------------------------

export interface MemberExchange {
    readonly init: E2eInit;
    /** The host's answer: verified against Tynn's key, or thrown. Once. */
    accept(payload: unknown): { finish: E2eFinish; cipher: FrameCipher };
}

export function startMember(input: {
    workstationId: string;
    sid: string;
    grant: string;
    /** `host_public_key` as Tynn returned it with THIS grant. */
    hostPublicKey: unknown;
    /** The key the grant is bound to, and its signature. */
    memberJwk: PopJwk;
    sign(data: Buffer): Buffer;
    ephemeral?: X25519Pair;
}): MemberExchange {
    const host = hostKeyOf(input.hostPublicKey);
    if (!host) throw new RelayE2eError('no-host-key', 'Tynn named no key for the host');
    const ephemeral = input.ephemeral ?? generateKeyPairSync('x25519');
    const memberEphemeral = rawPublic(ephemeral.publicKey);
    let answered = false;
    return {
        init: { type: 'e2e-init', v: VERSION, e: memberEphemeral.toString('base64url') },
        accept(payload) {
            if (answered) throw new RelayE2eError('state', 'the exchange was already answered');
            answered = true;
            const p = objectOf(payload);
            if (p.type !== 'e2e-accept' || p.v !== VERSION) throw new RelayE2eError('malformed', 'not an e2e-accept of this version');
            const hostEphemeral = ephemeralOf(p.e);
            const shared = sharedOf(ephemeral.privateKey, hostEphemeral.key);
            const th = transcriptHash({ workstationId: input.workstationId, sid: input.sid, hostFingerprint: host.fingerprint, memberThumbprint: jwkThumbprint(input.memberJwk), grant: input.grant, memberEphemeral, hostEphemeral: hostEphemeral.raw });
            const sig = signatureOf(p.sig);
            let proved = false;
            try {
                proved = sig !== null && verify(null, hostSigned(th), host.key, sig);
            } catch {
                proved = false;
            }
            if (!proved) throw new RelayE2eError('host-not-proved', 'the host did not prove it holds the key Tynn names');
            const keys = keysOf(shared, th);
            return {
                finish: { type: 'e2e-finish', sig: input.sign(memberSigned(th)).toString('base64url') },
                cipher: frameCipher({ send: keys.memberToHost, receive: keys.hostToMember, sid: input.sid }),
            };
        },
    };
}

// ---- the host's side ---------------------------------------------------------------------------------------------------

export interface HostExchange {
    readonly accept: E2eAccept;
    /** The member's finish: verified against the key its grant names, or thrown. Once. */
    finish(payload: unknown): FrameCipher;
}

export async function acceptMember(input: {
    workstationId: string;
    sid: string;
    grant: string;
    /** SHA-256 (hex) of this host's enrolled key (workstation-identity.ts `fingerprint`). */
    hostFingerprint: string;
    /** The key the member proved, whose thumbprint is the grant's `cnf.jkt`. */
    memberJwk: PopJwk;
    /** Signs with the enrolled key. */
    sign(data: Buffer): Buffer | Promise<Buffer>;
    init: unknown;
    ephemeral?: X25519Pair;
}): Promise<HostExchange> {
    const p = objectOf(input.init);
    if (p.type !== 'e2e-init' || p.v !== VERSION) throw new RelayE2eError('malformed', 'not an e2e-init of this version');
    const memberEphemeral = ephemeralOf(p.e);
    const ephemeral = input.ephemeral ?? generateKeyPairSync('x25519');
    const hostEphemeral = rawPublic(ephemeral.publicKey);
    const shared = sharedOf(ephemeral.privateKey, memberEphemeral.key);
    const th = transcriptHash({ workstationId: input.workstationId, sid: input.sid, hostFingerprint: input.hostFingerprint, memberThumbprint: jwkThumbprint(input.memberJwk), grant: input.grant, memberEphemeral: memberEphemeral.raw, hostEphemeral });
    let memberKey: KeyObject;
    try {
        memberKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: input.memberJwk.x }, format: 'jwk' });
    } catch {
        throw new RelayE2eError('member-not-proved', 'the grant names no usable key');
    }
    const sig = await input.sign(hostSigned(th));
    let finished = false;
    return {
        accept: { type: 'e2e-accept', v: VERSION, e: hostEphemeral.toString('base64url'), sig: Buffer.from(sig).toString('base64url') },
        finish(payload) {
            if (finished) throw new RelayE2eError('state', 'the exchange was already finished');
            finished = true;
            const f = objectOf(payload);
            const memberSig = f.type === 'e2e-finish' ? signatureOf(f.sig) : null;
            let proved = false;
            try {
                proved = memberSig !== null && verify(null, memberSigned(th), memberKey, memberSig);
            } catch {
                proved = false;
            }
            if (!proved) throw new RelayE2eError('member-not-proved', 'the member did not prove it holds the key its grant names');
            const keys = keysOf(shared, th);
            return frameCipher({ send: keys.hostToMember, receive: keys.memberToHost, sid: input.sid });
        },
    };
}

// ---- the words ---------------------------------------------------------------------------------------------------------

/** A machine with no name we know. */
const shown = (name: string | null | undefined): string => (typeof name === 'string' && name.trim() !== '' ? name.trim() : 'the workstation you asked for');
/** The same, where it starts a sentence. A machine's own name is never re-cased. */
const shownFirst = (name: string | null | undefined): string => (typeof name === 'string' && name.trim() !== '' ? name.trim() : 'The workstation you asked for');

/** What a person connecting is told (the member's side). */
export const e2eWords = {
    notProved: (name?: string | null): string => `This workstation could not prove it is ${shown(name)}. Nothing was sent. If ${shown(name)} was set up again, wait until it has signed in to Tynn, then connect again.`,
    noKey: (name?: string | null): string => `Tynn has no key on record for ${shown(name)}, so this workstation could not prove it is ${shown(name)}. Nothing was sent. Open Genie on ${shown(name)} and sign in to Tynn there, then connect again.`,
    oldHost: (name?: string | null): string => `${shownFirst(name)} runs an older Genie that cannot make an encrypted connection. Update Genie on ${shown(name)}. Nothing was sent.`,
    changed: (name?: string | null): string => `The connection to ${shown(name)} was changed on the way, so it was closed. Connect again.`,
    limit: (name?: string | null): string => `This connection to ${shown(name)} carried as much as one connection may, so it was closed. Connect again.`,
} as const;

/** What the host says when it ends a session (it reaches the member as the close's reason). */
export const E2E_HOST_WORDS = {
    oldMember: 'The Genie on the machine you are connecting from is too old to make an encrypted connection to this workstation. Update Genie there, then connect again.',
    notProved: 'the connecting machine could not prove it holds the key its grant names, so this workstation closed the connection',
    changed: 'the encrypted connection was changed on the way, so this workstation closed it',
    limit: 'this connection carried as much as one connection may, so this workstation closed it; connect again',
} as const;
