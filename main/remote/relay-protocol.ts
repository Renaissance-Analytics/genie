/**
 * Relay frame protocol — the MEMBER side.
 * ===========================================================================
 *
 * A Virtual Workstation connection runs over the Tynn relay instead of a tailnet
 * dial: the desktop member client opens ONE `wss://<relay>/ws/member` socket,
 * sends a `member-hello {workstationId, grant}` control, gets a
 * `member-welcome {sid}`, then multiplexes its REST + `/ws/events` + `/ws/term`
 * traffic as tagged {@link Frame}s. genie-cloud's relay-client demuxes the frames
 * to the workstation's real mobile-server surface.
 *
 * Wire-compatible with genie-cloud's `src/relay-server/protocol.ts` (we mirror
 * the shapes rather than import across repos). JSON, fail-closed: anything
 * malformed throws {@link RelayProtocolError}.
 */

export type Channel = 'rest' | 'events' | 'term' | 'control';
export type FrameKind = 'open' | 'data' | 'close' | 'error';

const CHANNELS: readonly Channel[] = ['rest', 'events', 'term', 'control'];
const FRAME_KINDS: readonly FrameKind[] = ['open', 'data', 'close', 'error'];

/** A routed frame between this member session and its workstation link. */
export interface Frame {
    kind: FrameKind;
    channel: Channel;
    /** Member-session id (relay-assigned, from member-welcome). */
    sid: string;
    /** REST request/response correlation id (channel === 'rest'). */
    reqId?: string;
    /** Channel payload: a REST req/reply object, a term/events data string, etc. */
    payload?: unknown;
    /** close/error code. */
    code?: string;
    /** Human-readable detail (logs/audit, never trusted from the peer). */
    reason?: string;
}

/** A REST request rendered onto the `rest` channel (mirrors the host's HTTP). */
export interface RestRequestPayload {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
    /** Names the target workspace for the relay's scope×capability filter. */
    workspaceId?: string;
}

/** The REST reply rendered back on the `rest` channel. */
export interface RestReplyPayload {
    status: number;
    body?: string;
}

export class RelayProtocolError extends Error {
    constructor(detail: string) {
        super(`relay protocol error: ${detail}`);
        this.name = 'RelayProtocolError';
    }
}

function isString(v: unknown): v is string {
    return typeof v === 'string';
}
function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.length > 0;
}

export function encodeFrame(frame: Frame): string {
    return JSON.stringify(frame);
}

/** Parse + validate a routed frame. Throws `RelayProtocolError` on anything off. */
export function decodeFrame(raw: string | Buffer): Frame {
    let obj: unknown;
    try {
        obj = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
        throw new RelayProtocolError('invalid JSON');
    }
    if (typeof obj !== 'object' || obj === null) {
        throw new RelayProtocolError('frame is not an object');
    }
    const f = obj as Record<string, unknown>;
    if (!isString(f.kind) || !FRAME_KINDS.includes(f.kind as FrameKind)) {
        throw new RelayProtocolError('invalid frame kind');
    }
    if (!isString(f.channel) || !CHANNELS.includes(f.channel as Channel)) {
        throw new RelayProtocolError('invalid channel');
    }
    if (!isNonEmptyString(f.sid)) {
        throw new RelayProtocolError('missing sid');
    }
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

// --- Control handshake (distinct from routed Frames) ------------------------

export interface MemberHello {
    type: 'member-hello';
    workstationId: string;
    /** The Tynn-minted short-TTL connection grant (JWS); opaque to the relay. */
    grant: string;
}

export interface MemberWelcome {
    type: 'member-welcome';
    sid: string;
}

export interface ControlError {
    type: 'error';
    code: string;
    reason: string;
}

/** Encode the member's dial-in control. */
export function encodeMemberHello(workstationId: string, grant: string): string {
    const hello: MemberHello = { type: 'member-hello', workstationId, grant };
    return JSON.stringify(hello);
}

/** Decode the relay's reply to member-hello: a welcome (with sid) or an error.
 *  Fail-closed — anything else throws. */
export function decodeMemberControl(raw: string | Buffer): MemberWelcome | ControlError {
    let obj: unknown;
    try {
        obj = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
        throw new RelayProtocolError('invalid JSON');
    }
    if (typeof obj !== 'object' || obj === null) {
        throw new RelayProtocolError('control is not an object');
    }
    const m = obj as Record<string, unknown>;
    if (m.type === 'member-welcome') {
        if (!isNonEmptyString(m.sid)) throw new RelayProtocolError('malformed member-welcome');
        return { type: 'member-welcome', sid: m.sid };
    }
    if (m.type === 'error') {
        return {
            type: 'error',
            code: isString(m.code) ? m.code : 'unknown',
            reason: isString(m.reason) ? m.reason : '',
        };
    }
    throw new RelayProtocolError('unexpected control reply');
}

// --- Proof-of-Possession handshake (P4.5, post-welcome) ---------------------
// The host challenges the member to prove possession of the ephemeral key the
// grant is bound to. These ride `control`-channel DATA frames (the wire matches
// GenieCloudScaffold's host side exactly): the `pop-challenge` / `pop-proof`
// discriminator lives in `payload.type` inside an otherwise-ordinary Frame, so
// `decodeFrame` parses the envelope and these helpers read/build the payload.

/** A PoP challenge extracted from a `control` frame's payload. */
export interface PopChallenge {
    /** The member-session id (echoed from the challenge frame). */
    sid: string;
    /** Opaque challenge nonce (signed, never interpreted). */
    nonce: string;
}

/** Build the host's PoP challenge control frame (host side; used in tests). */
export function encodePopChallenge(sid: string, nonce: string): string {
    return encodeFrame({
        kind: 'data',
        channel: 'control',
        sid,
        payload: { type: 'pop-challenge', nonce },
    });
}

/** Build the member's PoP proof as a `control` data frame. */
export function encodePopProof(sid: string, jwk: unknown, sig: string): string {
    return encodeFrame({
        kind: 'data',
        channel: 'control',
        sid,
        payload: { type: 'pop-proof', jwk, sig },
    });
}

/**
 * Read a PoP challenge out of a DECODED `control` frame. Returns `null` when the
 * frame isn't a pop-challenge (a non-control frame, or another control payload),
 * so the caller routes non-PoP frames onward. Fail-closed: a frame that IS a
 * pop-challenge but is missing its nonce throws.
 */
export function decodePopChallenge(frame: Frame): PopChallenge | null {
    if (frame.channel !== 'control') return null;
    const payload = frame.payload;
    if (typeof payload !== 'object' || payload === null) return null;
    const p = payload as Record<string, unknown>;
    if (p.type !== 'pop-challenge') return null;
    // `frame.sid` is already guaranteed non-empty by decodeFrame.
    if (!isNonEmptyString(p.nonce)) throw new RelayProtocolError('malformed pop-challenge: nonce');
    return { sid: frame.sid, nonce: p.nonce };
}
