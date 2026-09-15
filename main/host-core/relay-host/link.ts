import { randomBytes } from 'node:crypto';

import { WebSocket } from 'ws';

import { decodeFrame, encodeFrame, type Frame } from '../../remote/relay-protocol';
import { acceptSiteKey, type SiteKeyInit, type SitePayloadCipher } from '../../remote/site-e2e';
import type { GrantCheck, HostGrant } from './grant';
import type { TicketHostHello } from './hello';
import { popDecision, verifyPopProof } from './pop';

/**
 * The relay HOST link (genie#680): one outbound WebSocket to a relay's `/ws/host`,
 * carrying every member session for this workstation. Ported from genie-cloud's
 * `src/relay/client.ts`, which has run this protocol in production; the frames are
 * the ones `remote/relay-protocol.ts` already mirrors for the member side.
 *
 * Per member session the relay sends a control `open` with the member's grant.
 * The link verifies it (signature, audience, introspection — `validateGrant`),
 * runs the proof-of-possession challenge for a bound grant, and only then admits
 * the session, answers the site E2E handshake with the host key, and hands its
 * frames to `onFrame`.
 *
 * DIFFERENCE FROM genie-cloud: no per-frame scope check on member-supplied
 * `workspaceId` tags. A tag the member writes decides nothing (genie-cloud#33);
 * every admitted session gets its OWN session on the local server, minted from
 * its grant in `onSessionOpen`, and that server judges each request by the
 * resource it reaches (`mobile/guest-access.ts`).
 */

export type RelayLinkState = 'idle' | 'connecting' | 'authenticating' | 'open' | 'closed';

export interface RelayHostLinkOptions {
    /** The relay base (`wss://relay…`); the link dials `<base>/ws/host`. */
    relayUrl: string;
    workstationId: string;
    /** A fresh signed host-hello for each dial (a relay ticket expires). */
    hello: () => Promise<TicketHostHello>;
    /** Sign with the enrolled host key — answers the site E2E handshake. */
    sign: (data: Buffer) => Buffer;
    /** Verify a member grant: signature + envelope + introspection. */
    validateGrant: (token: string) => Promise<GrantCheck>;
    /** A session is admitted; return false to refuse it after all. */
    onSessionOpen: (sid: string, grant: HostGrant) => boolean;
    onSessionClose: (sid: string) => void;
    /** A frame from an admitted session; `reply` sends back to that member. */
    onFrame: (frame: Frame, reply: (f: Frame) => void) => void;
    onState?: (state: RelayLinkState, detail?: string) => void;
    /** Re-introspect admitted sessions this often (ms). 0 disables. */
    revalidateMs?: number;
    heartbeatMs?: number;
    popTimeoutMs?: number;
    reconnect?: { minMs: number; maxMs: number };
    log?: (msg: string) => void;
}

/** Frames a member may pipeline while its session is still being admitted. */
const MAX_PENDING_FRAMES = 64;

interface PendingPop {
    grant: HostGrant;
    token: string;
    nonce: string;
    timer: NodeJS.Timeout;
}

export class RelayHostLink {
    private ws: WebSocket | null = null;
    private state: RelayLinkState = 'idle';
    private closing = false;
    private reconnectDelay: number;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private revalidateTimer: NodeJS.Timeout | null = null;
    private readonly sessions = new Map<string, { grant: HostGrant; token: string }>();
    private readonly pendingPop = new Map<string, PendingPop>();
    private readonly preAdmit = new Map<string, Frame[]>();
    private readonly siteCiphers = new Map<string, SitePayloadCipher>();

    constructor(private readonly opts: RelayHostLinkOptions) {
        this.reconnectDelay = opts.reconnect?.minMs ?? 1000;
    }

    currentState(): RelayLinkState {
        return this.state;
    }

    /** Admitted session ids and the grants they rode in on. */
    admittedSessions(): Array<{ sid: string; grant: HostGrant }> {
        return [...this.sessions].map(([sid, s]) => ({ sid, grant: s.grant }));
    }

    connect(): void {
        if (this.state === 'connecting' || this.state === 'authenticating' || this.state === 'open') return;
        this.closing = false;
        this.setState('connecting');
        void this.dial();
    }

    close(): void {
        this.closing = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.teardown();
        try {
            this.ws?.close();
        } catch {
            /* already closing */
        }
        this.ws = null;
        this.setState('closed');
    }

    /** End one member session: the member is told why, and the relay drops it. */
    endSession(sid: string, reason: string): void {
        this.reject(sid, reason);
    }

    private setState(state: RelayLinkState, detail?: string): void {
        this.state = state;
        this.opts.onState?.(state, detail);
    }

    private async dial(): Promise<void> {
        let hello: TicketHostHello;
        try {
            hello = await this.opts.hello();
        } catch (e) {
            // The hello failed (no ticket): not a socket to retry blindly — report it.
            this.setState('closed', e instanceof Error ? e.message : String(e));
            if (!this.closing) this.scheduleReconnect();
            return;
        }
        if (this.closing) return;

        const ws = new WebSocket(`${this.opts.relayUrl.replace(/\/+$/, '')}/ws/host`);
        this.ws = ws;
        ws.on('open', () => {
            this.setState('authenticating');
            ws.send(JSON.stringify(hello));
        });
        ws.on('message', (raw: Buffer) => {
            if (this.state === 'authenticating') {
                let msg: { type?: string; reason?: string } = {};
                try {
                    msg = JSON.parse(raw.toString('utf8'));
                } catch {
                    /* not the handshake reply */
                }
                if (msg.type === 'host-welcome') {
                    this.reconnectDelay = this.opts.reconnect?.minMs ?? 1000;
                    this.setState('open');
                    this.startTimers();
                } else {
                    this.opts.log?.(`relay refused this host: ${msg.reason ?? msg.type ?? 'no reason'}`);
                    ws.close();
                }
                return;
            }
            if (this.state !== 'open') return;
            let frame: Frame;
            try {
                frame = decodeFrame(raw);
            } catch {
                return;
            }
            this.handle(frame);
        });
        ws.on('close', () => {
            if (this.ws !== ws) return;
            this.teardown();
            this.ws = null;
            this.setState('closed');
            if (!this.closing) this.scheduleReconnect();
        });
        ws.on('error', (err: Error) => this.opts.log?.(`relay link error: ${err.message}`));
    }

    private send(frame: Frame): void {
        if (this.state !== 'open' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const cipher = frame.channel === 'site' ? this.siteCiphers.get(frame.sid) : undefined;
        this.ws.send(encodeFrame(cipher ? cipher.seal(frame) : frame));
    }

    private handle(frame: Frame): void {
        if (frame.channel === 'control' && frame.kind === 'open') {
            const grant = (frame.payload as { grant?: unknown } | undefined)?.grant;
            if (typeof grant !== 'string') {
                this.reject(frame.sid, 'missing grant');
                return;
            }
            this.preAdmit.set(frame.sid, []);
            void this.admit(frame.sid, grant);
            return;
        }
        if (frame.channel === 'control' && (frame.kind === 'close' || frame.kind === 'error')) {
            this.forget(frame.sid);
            return;
        }
        if (frame.channel === 'control' && frame.kind === 'data') {
            const payload = (frame.payload ?? {}) as Record<string, unknown>;
            if (payload.type === 'pop-proof') this.proof(frame.sid, payload);
            else if (payload.type === 'site-key-init') this.siteKey(frame.sid, payload);
            return;
        }
        const session = this.sessions.get(frame.sid);
        if (!session) {
            const buffer = this.preAdmit.get(frame.sid);
            if (buffer && buffer.length < MAX_PENDING_FRAMES) buffer.push(frame);
            return;
        }
        this.deliver(frame);
    }

    private deliver(frame: Frame): void {
        if (frame.channel === 'site') {
            const cipher = this.siteCiphers.get(frame.sid);
            if (!cipher) {
                this.reject(frame.sid, 'site E2E channel is not established');
                return;
            }
            try {
                frame = cipher.open(frame);
            } catch {
                this.reject(frame.sid, 'invalid encrypted site frame');
                return;
            }
        }
        this.opts.onFrame(frame, (f) => this.send(f));
    }

    private async admit(sid: string, token: string): Promise<void> {
        let check: GrantCheck;
        try {
            check = await this.opts.validateGrant(token);
        } catch {
            check = { ok: false, reason: 'grant validation error' };
        }
        if (this.state !== 'open' || !this.preAdmit.has(sid)) return;
        if (!check.ok) {
            this.reject(sid, check.reason);
            return;
        }
        const decision = popDecision(check.grant);
        if (decision === 'reject') {
            this.reject(sid, 'control grant missing required proof-of-possession binding (cnf)');
            return;
        }
        if (decision === 'skip') {
            this.accept(sid, check.grant, token);
            return;
        }
        const nonce = randomBytes(32).toString('hex');
        const timer = setTimeout(() => {
            if (this.pendingPop.has(sid)) this.reject(sid, 'proof-of-possession timeout');
        }, this.opts.popTimeoutMs ?? 10_000);
        timer.unref();
        this.pendingPop.set(sid, { grant: check.grant, token, nonce, timer });
        this.send({ kind: 'data', channel: 'control', sid, payload: { type: 'pop-challenge', nonce } });
    }

    private proof(sid: string, payload: Record<string, unknown>): void {
        const pending = this.pendingPop.get(sid);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingPop.delete(sid); // single-use nonce
        const check = verifyPopProof({
            jwk: payload.jwk,
            signatureB64u: typeof payload.sig === 'string' ? payload.sig : '',
            nonce: pending.nonce,
            workstationId: this.opts.workstationId,
            sid,
            expectedThumbprint: pending.grant.confirmationKeyThumbprint ?? '',
        });
        if (check.verified) this.accept(sid, pending.grant, pending.token);
        else this.reject(sid, check.reason ?? 'proof-of-possession failed');
    }

    private accept(sid: string, grant: HostGrant, token: string): void {
        if (!this.opts.onSessionOpen(sid, grant)) {
            this.reject(sid, 'this host could not open a session');
            return;
        }
        this.sessions.set(sid, { grant, token });
        // This host always has its enrolled key: offer the site E2E handshake.
        this.send({ kind: 'data', channel: 'control', sid, payload: { type: 'site-key-ready' } });
        const buffered = this.preAdmit.get(sid) ?? [];
        this.preAdmit.delete(sid);
        for (const frame of buffered) this.deliver(frame);
    }

    private siteKey(sid: string, payload: Record<string, unknown>): void {
        if (!this.sessions.has(sid)) return;
        if (typeof payload.publicKey !== 'string' || typeof payload.nonce !== 'string') {
            this.reject(sid, 'malformed site E2E handshake');
            return;
        }
        try {
            const { accept, cipher } = acceptSiteKey(payload as unknown as SiteKeyInit, {
                sid,
                workstationId: this.opts.workstationId,
                sign: this.opts.sign,
            });
            this.siteCiphers.set(sid, cipher);
            this.send({ kind: 'data', channel: 'control', sid, payload: accept });
        } catch {
            this.reject(sid, 'site E2E handshake failed');
        }
    }

    /** Refuse or end a session: tell the member why, and release everything it held. */
    private reject(sid: string, reason: string): void {
        this.opts.log?.(`member session ${sid} ended: ${reason}`);
        this.send({ kind: 'error', channel: 'control', sid, code: 'grant', reason });
        this.forget(sid);
    }

    private forget(sid: string): void {
        const pending = this.pendingPop.get(sid);
        if (pending) clearTimeout(pending.timer);
        this.pendingPop.delete(sid);
        this.preAdmit.delete(sid);
        this.siteCiphers.delete(sid);
        if (this.sessions.delete(sid)) this.opts.onSessionClose(sid);
    }

    private async revalidate(): Promise<void> {
        for (const [sid, session] of [...this.sessions]) {
            let check: GrantCheck;
            try {
                check = await this.opts.validateGrant(session.token);
            } catch {
                check = { ok: false, reason: 'revalidation error' };
            }
            if (this.state !== 'open') return;
            if (!check.ok && this.sessions.has(sid)) this.reject(sid, check.reason || 'grant revoked');
        }
    }

    private startTimers(): void {
        this.stopTimers();
        this.heartbeatTimer = setInterval(() => {
            try {
                this.ws?.ping();
            } catch {
                /* closing */
            }
        }, this.opts.heartbeatMs ?? 30_000);
        this.heartbeatTimer.unref();
        if ((this.opts.revalidateMs ?? 0) > 0) {
            this.revalidateTimer = setInterval(() => void this.revalidate(), this.opts.revalidateMs);
            this.revalidateTimer.unref();
        }
    }

    private stopTimers(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.revalidateTimer) clearInterval(this.revalidateTimer);
        this.heartbeatTimer = null;
        this.revalidateTimer = null;
    }

    /** The link went down: every session on it ends. */
    private teardown(): void {
        this.stopTimers();
        for (const pending of this.pendingPop.values()) clearTimeout(pending.timer);
        this.pendingPop.clear();
        this.preAdmit.clear();
        this.siteCiphers.clear();
        for (const sid of [...this.sessions.keys()]) {
            this.sessions.delete(sid);
            this.opts.onSessionClose(sid);
        }
    }

    private scheduleReconnect(): void {
        const min = this.opts.reconnect?.minMs ?? 1000;
        const max = this.opts.reconnect?.maxMs ?? 30_000;
        if (min <= 0) return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(delay * 2, max);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.setState('connecting');
            void this.dial();
        }, delay);
        this.reconnectTimer.unref();
    }
}
