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

export type Channel = 'rest' | 'events' | 'term' | 'control' | 'site';
export type FrameKind = 'open' | 'data' | 'close' | 'error';

const CHANNELS: readonly Channel[] = ['rest', 'events', 'term', 'control', 'site'];
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

// --- site-proxy channel (serve-local-sites Phase E) -------------------------
// The `site` channel carries the HOST reverse-proxy byte stream
// (`main/mobile/site-proxy.ts` `handleSiteProxy`) over the relay, so a remote
// with NO shared tailnet can still reach an enabled `*.gen` site. It is
// STREAMING + multiplexed (many concurrent requests per session, keyed by
// `reqId` — unlike the single-stream `events`/`term`), because one page load
// pulls many assets at once. Each direction's frames are direction-implicit:
//
//   member → host (this repo, via RelayFrameMux.openSite):
//     open  {payload: SiteOpenPayload}                 begin an HTTP request / WS upgrade
//     data  {payload: {t:'body', data:<base64>}}       request-body / WS client→server chunk
//     data  {payload: {t:'end'}}                        request body complete (HTTP half-close)
//     close                                            tear the stream down
//   host → member (genie-cloud's relay-server dispatch, mirrored in tests):
//     data  {payload: {t:'response', status, headers}}          HTTP response head
//     data  {payload: {t:'upgraded', status, statusText, headers}}  WS 101 established
//     data  {payload: {t:'body', data:<base64>}}                response-body / WS server→client chunk
//     close                                                     response complete / socket closed
//     error {code, reason}                                       upstream failed
//
// Wire-compatible with genie-cloud's `src/relay-server/protocol.ts`; the host
// side hands each `open` to `handleSiteProxy` (the SAME handler as the tailnet
// path), so token + kill-switch (423) + `siteId` allowlist + audit all apply
// unchanged regardless of carrier. See {@link SiteOpenPayload} / {@link readSiteInbound}.

/** Member→host: open a site-proxy stream (an HTTP request, or a WS `upgrade`
 *  when `upgrade` is true). `path` is the host proxy's `/api/site/<siteId>/…`. */
export interface SiteOpenPayload {
    workspaceId: string;
    siteId: string;
    method: string;
    path: string;
    headers: Record<string, string | string[]>;
    /** true → a WebSocket upgrade (HMR / Reverb / Echo), not a plain request. */
    upgrade?: boolean;
}

/** A host→member `data` frame on the `site` channel, parsed + validated. */
export type SiteInbound =
    | { t: 'response'; status: number; headers: Record<string, string | string[]> }
    | { t: 'upgraded'; status: number; statusText: string; headers: Record<string, string | string[]> }
    | { t: 'body'; chunk: Buffer };

/** Keep only well-typed header values (JSON is untrusted from the peer). */
function normalizeHeaders(h: unknown): Record<string, string | string[]> {
    if (typeof h !== 'object' || h === null) return {};
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
        else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v as string[];
    }
    return out;
}

/**
 * Read a host→member `site` DATA frame into its typed shape. Returns null for a
 * non-`site`/non-`data` frame or an unrecognized payload — the mux then IGNORES
 * it rather than tearing the session down (a bad site frame must not kill the
 * whole member link; the carrier surfaces a dead stream via close/error). The
 * envelope was already validated by {@link decodeFrame}; this reads the payload.
 */
export function readSiteInbound(frame: Frame): SiteInbound | null {
    if (frame.channel !== 'site' || frame.kind !== 'data') return null;
    const p = frame.payload;
    if (typeof p !== 'object' || p === null) return null;
    const o = p as Record<string, unknown>;
    if (o.t === 'response' && typeof o.status === 'number') {
        return { t: 'response', status: o.status, headers: normalizeHeaders(o.headers) };
    }
    if (o.t === 'upgraded' && typeof o.status === 'number') {
        return {
            t: 'upgraded',
            status: o.status,
            statusText: typeof o.statusText === 'string' ? o.statusText : '',
            headers: normalizeHeaders(o.headers),
        };
    }
    if (o.t === 'body' && typeof o.data === 'string') {
        return { t: 'body', chunk: Buffer.from(o.data, 'base64') };
    }
    return null;
}
