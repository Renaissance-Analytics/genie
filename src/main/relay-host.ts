import { createPublicKey, randomBytes, verify } from 'node:crypto';
import type { ServerConnection, ServerTransport } from '../core/remote-protocol.js';
import { principalOf, type GrantCheck, type HostGrant } from './relay-grant.js';
import { decodeFrame, encodeFrame, jwkThumbprint, OPEN, popSignedInput, textOf, type Frame, type RelaySocket, type RelaySocketFactory, type TicketHostHello } from './relay-wire.js';

/**
 * THIS GENIE ON THE TYNN NETWORK, AS A HOST (Tynn #838) — Genie 1's `host-core/relay-host/link.ts`, feeding Genie 2's
 * RemoteHost instead of a loopback HTTP server.
 *
 * One socket to `<relay>/ws/host`, opened with a Tynn-ticketed hello signed by this machine's enrolled key. For each
 * member the relay opens (`control open {grant}`): the grant is checked (Tynn's signature, audience, expiry, still
 * active), the member must prove the key the grant is bound to (a control grant MUST be bound), the grant must map to a
 * Genie principal — and only then does RemoteHost get a connection, already authenticated as that principal (its
 * `relay` hello takes it). Frames that arrive before admission wait, a few, in order. Every admitted session is
 * re-checked on a timer: a revoked grant ends it, in words.
 */

export type RelayLinkState = 'idle' | 'connecting' | 'authenticating' | 'open' | 'closed';

export interface RelayHostLinkDeps {
    socket: RelaySocketFactory;
    relayUrl: string;
    workstationId: string;
    /** A fresh ticketed hello for each dial (main asks Tynn for the ticket). */
    hello(): Promise<TicketHostHello>;
    /** Signature + claims, and still active at Tynn. */
    validateGrant(token: string): Promise<GrantCheck>;
    popTimeoutMs?: number;
    /** Re-check every admitted grant this often; 0 = never (tests call `revalidate`). */
    revalidateMs?: number;
    /** Redial backoff; `minMs: 0` = do not redial. */
    reconnect?: { minMs: number; maxMs: number };
    onState?(state: RelayLinkState, detail?: string): void;
    log?(message: string): void;
}

export interface RelayHostLink extends ServerTransport {
    connect(): void;
    close(): void;
    state(): RelayLinkState;
    revalidate(): Promise<void>;
}

const MAX_PENDING_FRAMES = 64;

interface Session {
    readonly grant: HostGrant;
    readonly token: string;
    readonly messages: Set<(text: string) => void>;
    readonly closes: Set<() => void>;
}

export function relayHostLink(deps: RelayHostLinkDeps): RelayHostLink {
    const listeners = new Set<(connection: ServerConnection) => void>();
    const sessions = new Map<string, Session>();
    const preAdmit = new Map<string, Frame[]>();
    const pendingPop = new Map<string, { grant: HostGrant; token: string; nonce: string; timer: ReturnType<typeof setTimeout> }>();
    let ws: RelaySocket | null = null;
    let state: RelayLinkState = 'idle';
    let closing = false;
    let reconnectDelay = deps.reconnect?.minMs ?? 1_000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let revalidateTimer: ReturnType<typeof setInterval> | null = null;

    const setState = (next: RelayLinkState, detail?: string) => {
        state = next;
        deps.onState?.(next, detail);
    };

    const send = (frame: Frame) => {
        if (state !== 'open' || !ws || ws.readyState !== OPEN) return;
        ws.send(encodeFrame(frame));
    };

    const forget = (sid: string) => {
        const pending = pendingPop.get(sid);
        if (pending) clearTimeout(pending.timer);
        pendingPop.delete(sid);
        preAdmit.delete(sid);
        const session = sessions.get(sid);
        if (!session) return;
        sessions.delete(sid);
        for (const l of session.closes) l();
    };

    const reject = (sid: string, reason: string) => {
        deps.log?.(`relay member ${sid} ended: ${reason}`);
        send({ kind: 'error', channel: 'control', sid, code: 'grant', reason });
        forget(sid);
    };

    const deliver = (frame: Frame) => {
        const session = sessions.get(frame.sid);
        if (!session) return;
        if (frame.channel === 'rest' && frame.kind === 'data' && typeof frame.payload === 'string') {
            for (const l of session.messages) l(frame.payload);
        }
    };

    const accept = (sid: string, grant: HostGrant, token: string) => {
        const who = principalOf(grant);
        if (!who.ok) {
            reject(sid, who.reason);
            return;
        }
        const session: Session = { grant, token, messages: new Set(), closes: new Set() };
        sessions.set(sid, session);
        const connection: ServerConnection = {
            remoteAddress: `relay:${grant.name ?? grant.sub}`,
            preAuth: who.principal,
            send: (text) => { if (sessions.get(sid) === session) send({ kind: 'data', channel: 'rest', sid, payload: text }); },
            onMessage: (l) => { session.messages.add(l); return () => { session.messages.delete(l); }; },
            onClose: (l) => { session.closes.add(l); return () => { session.closes.delete(l); }; },
            close: () => {
                if (sessions.get(sid) !== session) return;
                send({ kind: 'close', channel: 'control', sid, reason: 'closed by the host' });
                forget(sid);
            },
        };
        for (const l of listeners) l(connection);
        const buffered = preAdmit.get(sid) ?? [];
        preAdmit.delete(sid);
        for (const frame of buffered) deliver(frame);
    };

    const admit = async (sid: string, token: string) => {
        let check: GrantCheck;
        try {
            check = await deps.validateGrant(token);
        } catch {
            check = { ok: false, reason: 'grant validation error' };
        }
        if (state !== 'open' || !preAdmit.has(sid)) return;
        if (!check.ok) {
            reject(sid, check.reason);
            return;
        }
        const grant = check.grant;
        if (!grant.confirmationKeyThumbprint) {
            // A read-only grant may skip the proof; control may not.
            if (grant.capability === 'control') reject(sid, 'control grant missing required proof-of-possession binding (cnf)');
            else accept(sid, grant, token);
            return;
        }
        const nonce = randomBytes(32).toString('hex');
        const timer = setTimeout(() => { if (pendingPop.has(sid)) reject(sid, 'proof-of-possession timeout'); }, deps.popTimeoutMs ?? 10_000);
        pendingPop.set(sid, { grant, token, nonce, timer });
        send({ kind: 'data', channel: 'control', sid, payload: { type: 'pop-challenge', nonce } });
    };

    const proof = (sid: string, payload: Record<string, unknown>) => {
        const pending = pendingPop.get(sid);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingPop.delete(sid); // the nonce is single-use
        const reason = popFailure(payload, pending.nonce, deps.workstationId, sid, pending.grant.confirmationKeyThumbprint ?? '');
        if (reason) reject(sid, reason);
        else accept(sid, pending.grant, pending.token);
    };

    const handle = (frame: Frame) => {
        if (frame.channel === 'control') {
            if (frame.kind === 'open') {
                const grant = (frame.payload as { grant?: unknown } | undefined)?.grant;
                if (typeof grant !== 'string') {
                    reject(frame.sid, 'missing grant');
                    return;
                }
                preAdmit.set(frame.sid, []);
                void admit(frame.sid, grant);
                return;
            }
            if (frame.kind === 'close' || frame.kind === 'error') {
                forget(frame.sid);
                return;
            }
            const payload = (frame.payload ?? {}) as Record<string, unknown>;
            if (frame.kind === 'data' && payload.type === 'pop-proof') proof(frame.sid, payload);
            return;
        }
        if (sessions.has(frame.sid)) {
            deliver(frame);
            return;
        }
        const buffer = preAdmit.get(frame.sid);
        if (buffer && buffer.length < MAX_PENDING_FRAMES) buffer.push(frame);
    };

    const teardown = () => {
        if (revalidateTimer) clearInterval(revalidateTimer);
        revalidateTimer = null;
        for (const p of pendingPop.values()) clearTimeout(p.timer);
        pendingPop.clear();
        preAdmit.clear();
        for (const sid of [...sessions.keys()]) forget(sid);
    };

    const scheduleReconnect = () => {
        const min = deps.reconnect?.minMs ?? 1_000;
        const max = deps.reconnect?.maxMs ?? 30_000;
        if (min <= 0 || closing) return;
        const delay = reconnectDelay;
        reconnectDelay = Math.min(delay * 2, max);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void dial();
        }, delay);
    };

    const dial = async () => {
        setState('connecting');
        let hello: TicketHostHello;
        try {
            hello = await deps.hello();
        } catch (error) {
            // No ticket: Tynn's refusal, said; tried again later.
            setState('closed', error instanceof Error ? error.message : String(error));
            scheduleReconnect();
            return;
        }
        if (closing) return;
        const socket = deps.socket(`${deps.relayUrl.replace(/\/+$/, '')}/ws/host`);
        ws = socket;
        socket.onopen = () => {
            setState('authenticating');
            socket.send(JSON.stringify(hello));
        };
        socket.onmessage = (event) => {
            const raw = textOf(event.data);
            if (raw === null || ws !== socket) return;
            if (state === 'authenticating') {
                let msg: { type?: unknown; reason?: unknown } = {};
                try {
                    msg = JSON.parse(raw) as typeof msg;
                } catch {
                    /* not the handshake reply */
                }
                if (msg.type === 'host-welcome') {
                    reconnectDelay = deps.reconnect?.minMs ?? 1_000;
                    setState('open');
                    if ((deps.revalidateMs ?? 30_000) > 0) revalidateTimer = setInterval(() => { void revalidate(); }, deps.revalidateMs ?? 30_000);
                } else {
                    deps.log?.(`the relay refused this host: ${typeof msg.reason === 'string' ? msg.reason : String(msg.type ?? 'no reason')}`);
                    socket.close();
                }
                return;
            }
            if (state !== 'open') return;
            let frame: Frame;
            try {
                frame = decodeFrame(raw);
            } catch {
                return;
            }
            handle(frame);
        };
        socket.onclose = () => {
            if (ws !== socket) return;
            teardown();
            ws = null;
            setState('closed');
            scheduleReconnect();
        };
        socket.onerror = () => { /* a close follows */ };
    };

    const revalidate = async () => {
        for (const [sid, session] of [...sessions]) {
            let check: GrantCheck;
            try {
                check = await deps.validateGrant(session.token);
            } catch {
                check = { ok: false, reason: 'revalidation error' };
            }
            if (state !== 'open') return;
            if (!check.ok && sessions.get(sid) === session) reject(sid, check.reason || 'grant revoked');
        }
    };

    return {
        onConnection: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        address: () => null,
        unavailable: () => (state === 'open' ? null : 'not connected to the Tynn relay'),
        connect: () => {
            closing = false;
            if (state === 'idle' || state === 'closed') void dial();
        },
        close: () => {
            closing = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = null;
            teardown();
            const socket = ws;
            ws = null;
            try { socket?.close(); } catch { /* already closing */ }
            setState('closed');
        },
        state: () => state,
        revalidate,
    };
}

/** Why a proof fails, or null when it holds: the key is the one the grant is bound to, and it signed this challenge. */
function popFailure(payload: Record<string, unknown>, nonce: string, workstationId: string, sid: string, expectedThumbprint: string): string | null {
    const k = payload.jwk as Record<string, unknown> | null | undefined;
    if (!k || typeof k !== 'object' || k.kty !== 'OKP' || k.crv !== 'Ed25519' || typeof k.x !== 'string' || k.x === '') return 'proof key is not an Ed25519 OKP JWK';
    if (jwkThumbprint({ kty: k.kty, crv: k.crv, x: k.x }) !== expectedThumbprint) return 'proof key does not match the grant binding';
    if (typeof payload.sig !== 'string' || payload.sig === '') return 'missing proof signature';
    try {
        const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' });
        return verify(null, popSignedInput(nonce, workstationId, sid), key, Buffer.from(payload.sig, 'base64url')) ? null : 'proof signature invalid';
    } catch {
        return 'proof verification error';
    }
}
