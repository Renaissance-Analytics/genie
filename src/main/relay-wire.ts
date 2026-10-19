import { createHash, randomBytes } from 'node:crypto';

/**
 * THE TYNN RELAY'S WIRE (Tynn #837/#838) — Genie 1's, unchanged (`v1:main/remote/relay-protocol.ts`,
 * `relay-pop.ts`, `host-core/relay-host/hello.ts` + `pop.ts`), wire-compatible with genie-cloud's
 * `src/relay-server/protocol.ts`. The relay never reads past the envelope: Genie 2's own protocol rides `rest` data
 * frames (reliable — the relay drops a `term`/`events` frame under backpressure, and closes a `rest` session instead).
 *
 * JSON, fail closed: anything malformed throws RelayProtocolError.
 */

export type Channel = 'rest' | 'events' | 'term' | 'control' | 'site';
export type FrameKind = 'open' | 'data' | 'close' | 'error';

const CHANNELS: readonly Channel[] = ['rest', 'events', 'term', 'control', 'site'];
const FRAME_KINDS: readonly FrameKind[] = ['open', 'data', 'close', 'error'];

/** A routed frame between one member session and its workstation's link. */
export interface Frame {
    kind: FrameKind;
    channel: Channel;
    /** The member session (relay-assigned; the relay stamps it on what a member sends). */
    sid: string;
    reqId?: string;
    payload?: unknown;
    code?: string;
    reason?: string;
}

export class RelayProtocolError extends Error {
    constructor(detail: string) {
        super(`relay protocol error: ${detail}`);
        this.name = 'RelayProtocolError';
    }
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function parseObject(raw: string, what: string): Record<string, unknown> {
    let obj: unknown;
    try {
        obj = JSON.parse(raw);
    } catch {
        throw new RelayProtocolError('invalid JSON');
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new RelayProtocolError(`${what} is not an object`);
    return obj as Record<string, unknown>;
}

export function encodeFrame(frame: Frame): string {
    return JSON.stringify(frame);
}

export function decodeFrame(raw: string): Frame {
    const f = parseObject(raw, 'frame');
    if (!isString(f.kind) || !FRAME_KINDS.includes(f.kind as FrameKind)) throw new RelayProtocolError('invalid frame kind');
    if (!isString(f.channel) || !CHANNELS.includes(f.channel as Channel)) throw new RelayProtocolError('invalid channel');
    if (!isNonEmpty(f.sid)) throw new RelayProtocolError('missing sid');
    const frame: Frame = { kind: f.kind as FrameKind, channel: f.channel as Channel, sid: f.sid };
    if (f.reqId !== undefined) {
        if (!isString(f.reqId)) throw new RelayProtocolError('invalid reqId');
        frame.reqId = f.reqId;
    }
    if (f.payload !== undefined) frame.payload = f.payload;
    if (f.code !== undefined) {
        if (!isString(f.code)) throw new RelayProtocolError('invalid code');
        frame.code = f.code;
    }
    if (f.reason !== undefined) {
        if (!isString(f.reason)) throw new RelayProtocolError('invalid reason');
        frame.reason = f.reason;
    }
    return frame;
}

// ---- the member's dial-in --------------------------------------------------------------------------------------------

export function encodeMemberHello(workstationId: string, grant: string): string {
    return JSON.stringify({ type: 'member-hello', workstationId, grant });
}

/** The relay's answer to member-hello: a welcome with the session id, or an error. Anything else throws. */
export function decodeMemberControl(raw: string): { type: 'member-welcome'; sid: string } | { type: 'error'; code: string; reason: string } {
    const m = parseObject(raw, 'control');
    if (m.type === 'member-welcome') {
        if (!isNonEmpty(m.sid)) throw new RelayProtocolError('malformed member-welcome');
        return { type: 'member-welcome', sid: m.sid };
    }
    if (m.type === 'error') return { type: 'error', code: isString(m.code) ? m.code : 'unknown', reason: isString(m.reason) ? m.reason : '' };
    throw new RelayProtocolError('unexpected control reply');
}

// ---- proof of possession ------------------------------------------------------------------------------------------------

/** An Ed25519 public key as a JWK (RFC 8037). */
export interface PopJwk {
    kty: 'OKP';
    crv: 'Ed25519';
    x: string;
}

/**
 * What the member signs, byte for byte the host's preimage: SHA-256(utf8(nonce) ‖ utf8(workstationId) ‖ utf8(sid)),
 * no separators; the nonce is signed as received, never hex-decoded.
 */
export function popSignedInput(nonce: string, workstationId: string, sid: string): Buffer {
    return createHash('sha256').update(Buffer.concat([Buffer.from(nonce, 'utf8'), Buffer.from(workstationId, 'utf8'), Buffer.from(sid, 'utf8')])).digest();
}

/** RFC 7638 thumbprint of an OKP JWK — what Tynn binds a grant to (`cnf.jkt`). */
export function jwkThumbprint(jwk: { kty: string; crv: string; x: string }): string {
    const canonical = `{"crv":${JSON.stringify(jwk.crv)},"kty":${JSON.stringify(jwk.kty)},"x":${JSON.stringify(jwk.x)}}`;
    return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

// ---- the host's dial-in ----------------------------------------------------------------------------------------------

export interface TicketHostHello {
    type: 'host-hello';
    workstationId: string;
    fingerprint: string;
    nonce: string;
    ts: number;
    /** Tynn's relay ticket naming this workstation and its enrolled key. */
    ticket: string;
    /** This host's Ed25519 signature (base64url) over {@link hostHelloSigningString}. */
    sig: string;
}

export function hostHelloSigningString(h: { workstationId: string; fingerprint: string; nonce: string; ts: number }): string {
    return `genie-relay-host-hello\n${h.workstationId}.${h.fingerprint}.${h.nonce}.${h.ts}`;
}

export function buildTicketHostHello(opts: { ticket: string; workstationId: string; fingerprint: string; sign: (data: Buffer) => Buffer; now?: number }): TicketHostHello {
    const base = { workstationId: opts.workstationId, fingerprint: opts.fingerprint, nonce: randomBytes(16).toString('hex'), ts: opts.now ?? Date.now() };
    return { type: 'host-hello', ...base, ticket: opts.ticket, sig: opts.sign(Buffer.from(hostHelloSigningString(base), 'utf8')).toString('base64url') };
}

// ---- the socket -------------------------------------------------------------------------------------------------------

/** The slice of a WebSocket the relay ends use: the global WebSocket in main, a fake relay in tests. */
export interface RelaySocket {
    readonly readyState: number;
    send(data: string): void;
    close(): void;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
}

export type RelaySocketFactory = (url: string) => RelaySocket;

/** A message's text: the relay sends text frames; anything else is not ours. */
export function textOf(data: unknown): string | null {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    return null;
}

export const OPEN = 1;
