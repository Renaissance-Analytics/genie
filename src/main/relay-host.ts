import { createPublicKey, randomBytes, verify } from 'node:crypto';
import type { ServerConnection, ServerTransport } from '../core/remote-protocol.js';
import { acceptMember, E2E_HOST_WORDS, E2E_REST_TEXT_MAX_BYTES, RelayE2eError, type FrameCipher, type HostExchange } from './relay-e2e.js';
import { principalOf, type GrantCheck, type HostGrant } from './relay-grant.js';
import { isGenHost, pipeSiteStream, type SiteDial, type SiteFrame, type SitePipe } from './relay-site.js';
import { decodeFrame, encodeFrame, jwkThumbprint, OPEN, popSignedInput, textOf, type Frame, type PopJwk, type RelaySocket, type RelaySocketFactory, type TicketHostHello } from './relay-wire.js';
import { fitRemoteFrame } from '../core/remote-frame.js';

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
 *
 * END TO END (audit M-a, host split P9.2; relay-e2e.ts): admission has one more step. After the proof this host answers
 * the member's handshake, signing with its ENROLLED key, and the member must sign the same exchange with the key its
 * grant names. Only then is there a session, and every `rest` and `site` frame of it is sealed: one that does not open
 * ends the session and is never delivered. A member that sends no handshake (a Genie from before this) is refused in
 * words. Nothing is written to the relay but `control` frames and sealed frames.
 */

export type RelayLinkState = 'idle' | 'connecting' | 'authenticating' | 'open' | 'closed';

export interface RelayHostLinkDeps {
    socket: RelaySocketFactory;
    relayUrl: string;
    workstationId: string;
    /** SHA-256 (hex) of this machine's enrolled key (workstation-identity.ts `fingerprint`): what Tynn names it by. */
    fingerprint: string;
    /** Signs with the enrolled key: the end-to-end handshake's proof that this is the host Tynn named. */
    sign(data: Buffer): Buffer | Promise<Buffer>;
    /** A fresh ticketed hello for each dial (main asks Tynn for the ticket). */
    hello(): Promise<TicketHostHello>;
    /** Signature + claims, and still active at Tynn. */
    validateGrant(token: string): Promise<GrantCheck>;
    /**
     * The Tynn account signed in on THIS machine, or null (Tynn #757): only a grant for it is the owner's; every other
     * caller, whatever Tynn says, is a guest who meets the Allow. Read at each admission.
     */
    signedInHere(): string | null;
    popTimeoutMs?: number;
    /** Re-check every admitted grant this often; 0 = never (tests call `revalidate`). */
    revalidateMs?: number;
    /** Redial backoff; `minMs: 0` = do not redial. */
    reconnect?: { minMs: number; maxMs: number };
    /**
     * A SILENT RELAY ENDS THE LINK (Tynn #940): nothing from the relay (no frame, no heartbeat ping) for this long, and
     * the socket is terminated and redialled. The relay pings every 30 s; default 75 s, about 2.5 heartbeats. 0 = never.
     */
    silentMs?: number;
    onState?(state: RelayLinkState, detail?: string): void;
    log?(message: string): void;
    /**
     * This host's own `.gen` sites, for the owner's windows on other workstations (`relay-site.ts`): CONNECT its front
     * door for a name; `ca` is the CA its front door signs with, sent with each accepted open so the client's browser
     * trusts this host's certificates (and only those). Absent = every site stream is refused.
     */
    site?: { dial(host: string): Promise<SiteDial>; ca?(): string | null };
}

export interface RelayHostLink extends ServerTransport {
    connect(): void;
    close(): void;
    state(): RelayLinkState;
    revalidate(): Promise<void>;
}

const MAX_PENDING_FRAMES = 64;

interface Session {
    /** The grant in use: replaced by a renewal (genie#1401), re-checked on the timer. */
    grant: HostGrant;
    token: string;
    readonly messages: Set<(text: string) => void>;
    readonly closes: Set<() => void>;
    /** Its open site streams, by reqId (relay-site.ts). */
    readonly sites: Map<string, SitePipe>;
    /** The session's seal (relay-e2e.ts): every rest and site frame goes through it, both ways. */
    readonly cipher: FrameCipher;
}

/** Why this grant may not open a site stream, or null: only the owner's own control link browses this host's sites. */
function siteRefusal(grant: HostGrant, signedInHere: string | null): string | null {
    const who = principalOf(grant, signedInHere);
    if (!who.ok || !who.principal.isOwner || who.principal.readonly) return "only the owner's own control link may browse this workstation's sites";
    return null;
}

export function relayHostLink(deps: RelayHostLinkDeps): RelayHostLink {
    const listeners = new Set<(connection: ServerConnection) => void>();
    const sessions = new Map<string, Session>();
    const preAdmit = new Map<string, Frame[]>();
    const pendingPop = new Map<string, { grant: HostGrant; token: string; nonce: string; timer: ReturnType<typeof setTimeout> }>();
    /** A member's `e2e-init`, kept until its grant and proof hold; and the exchange this host answered, until its finish. */
    const inits = new Map<string, unknown>();
    const pendingE2e = new Map<string, { grant: HostGrant; token: string; exchange: HostExchange; timer: ReturnType<typeof setTimeout> }>();
    /** Sessions whose handshake this host is answering right now (its signature is awaited). */
    const answering = new Set<string>();
    let ws: RelaySocket | null = null;
    let state: RelayLinkState = 'idle';
    let closing = false;
    let reconnectDelay = deps.reconnect?.minMs ?? 1_000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let revalidateTimer: ReturnType<typeof setInterval> | null = null;
    const silentMs = deps.silentMs ?? 75_000;
    let lastHeard = 0;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;

    const setState = (next: RelayLinkState, detail?: string) => {
        state = next;
        deps.onState?.(next, detail);
    };

    /** A control frame: the only kind written unsealed (a challenge, the handshake, a close and its reason). */
    const sendControl = (frame: Omit<Frame, 'channel'>) => {
        if (state !== 'open' || !ws || ws.readyState !== OPEN) return;
        ws.send(encodeFrame({ ...frame, channel: 'control' }));
    };

    /** A rest or site frame of a session: sealed at the moment of the write, or not written. */
    const sendSealed = (sid: string, session: Session, frame: Frame) => {
        if (state !== 'open' || !ws || ws.readyState !== OPEN || sessions.get(sid) !== session) return;
        try {
            ws.send(encodeFrame(session.cipher.seal(frame)));
        } catch (error) {
            reject(sid, error instanceof RelayE2eError && error.code === 'limit' ? E2E_HOST_WORDS.limit : E2E_HOST_WORDS.changed, 'e2e');
        }
    };

    const forget = (sid: string) => {
        const pending = pendingPop.get(sid);
        if (pending) clearTimeout(pending.timer);
        pendingPop.delete(sid);
        const exchanging = pendingE2e.get(sid);
        if (exchanging) clearTimeout(exchanging.timer);
        pendingE2e.delete(sid);
        inits.delete(sid);
        answering.delete(sid);
        preAdmit.delete(sid);
        const session = sessions.get(sid);
        if (!session) return;
        sessions.delete(sid);
        for (const pipe of [...session.sites.values()]) pipe.destroy();
        session.sites.clear();
        for (const l of session.closes) l();
    };

    const reject = (sid: string, reason: string, code: 'grant' | 'e2e' = 'grant') => {
        deps.log?.(`relay member ${sid} ended: ${reason}`);
        sendControl({ kind: 'error', sid, code, reason });
        forget(sid);
    };

    const site = (sid: string, session: Session, frame: Frame) => {
        const reqId = frame.reqId;
        if (!reqId) return;
        const say = (f: SiteFrame) => { sendSealed(sid, session, { ...f, channel: 'site', sid, reqId }); };
        if (frame.kind !== 'open') {
            session.sites.get(reqId)?.receive(frame);
            return;
        }
        if (session.sites.has(reqId)) return;
        const host = (frame.payload as { host?: unknown } | undefined)?.host;
        const refusal = siteRefusal(session.grant, deps.signedInHere()) ?? (!deps.site ? 'this Genie does not serve its sites over the relay' : !isGenHost(host) ? 'a site stream names one .gen site' : null);
        if (refusal !== null || !deps.site || !isGenHost(host)) {
            say({ kind: 'error', reason: refusal ?? 'refused' });
            return;
        }
        // Until the front door answers, what the member sends for this stream waits (it sends nothing before `open`).
        const early: SiteFrame[] = [];
        let cancelled = false;
        const opening: SitePipe = {
            receive: (f) => { if (early.length < MAX_PENDING_FRAMES) early.push(f); },
            destroy: () => { cancelled = true; },
        };
        session.sites.set(reqId, opening);
        void deps.site.dial(host).then((dialed) => {
            if (cancelled || sessions.get(sid) !== session || session.sites.get(reqId) !== opening) {
                if (dialed.ok) dialed.socket.destroy();
                return;
            }
            if (!dialed.ok) {
                session.sites.delete(reqId);
                say({ kind: 'error', reason: dialed.reason });
                return;
            }
            const ca = deps.site?.ca?.() ?? null;
            say({ kind: 'data', payload: { t: 'open', ...(ca !== null ? { ca } : {}) } });
            const pipe = pipeSiteStream(dialed.socket, say, () => { if (session.sites.get(reqId) === pipe) session.sites.delete(reqId); });
            session.sites.set(reqId, pipe);
            for (const f of early) pipe.receive(f);
        });
    };

    const deliver = (sealed: Frame) => {
        const session = sessions.get(sealed.sid);
        if (!session) return;
        // One frame that does not open (changed, repeated, out of order, or never sealed) ends the session; it is not delivered.
        let frame: Frame;
        try {
            frame = session.cipher.open(sealed);
        } catch {
            reject(sealed.sid, E2E_HOST_WORDS.changed, 'e2e');
            return;
        }
        if (frame.channel === 'rest' && frame.kind === 'data' && typeof frame.payload === 'string') {
            for (const l of session.messages) l(frame.payload);
            return;
        }
        if (frame.channel === 'site') site(frame.sid, session, frame);
    };

    const accept = (sid: string, grant: HostGrant, token: string, cipher: FrameCipher) => {
        const who = principalOf(grant, deps.signedInHere());
        if (!who.ok) {
            reject(sid, who.reason);
            return;
        }
        const session: Session = { grant, token, messages: new Set(), closes: new Set(), sites: new Map(), cipher };
        sessions.set(sid, session);
        const connection: ServerConnection = {
            remoteAddress: `relay:${grant.name ?? grant.sub}`,
            preAuth: who.principal,
            // The relay's size cap (Tynn #579): a frame over it is a refusal or not sent, never a disconnect.
            send: (text) => {
                if (sessions.get(sid) !== session) return;
                // Fitted to what SEALS under the cap (relay-e2e.ts): the frame on the wire is never over it, whatever the text holds.
                const fit = fitRemoteFrame(text, E2E_REST_TEXT_MAX_BYTES);
                if (fit.text !== null) sendSealed(sid, session, { kind: 'data', channel: 'rest', sid, payload: fit.text });
            },
            onMessage: (l) => { session.messages.add(l); return () => { session.messages.delete(l); }; },
            onClose: (l) => { session.closes.add(l); return () => { session.closes.delete(l); }; },
            close: () => {
                if (sessions.get(sid) !== session) return;
                sendControl({ kind: 'close', sid, reason: 'closed by the host' });
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
            // With no key there is nobody to make the end-to-end exchange with (P9.2), so there is no session.
            else reject(sid, 'this grant is not bound to a key, so its connection cannot be made end to end');
            return;
        }
        const nonce = randomBytes(32).toString('hex');
        const timer = setTimeout(() => { if (pendingPop.has(sid)) reject(sid, 'proof-of-possession timeout'); }, deps.popTimeoutMs ?? 10_000);
        pendingPop.set(sid, { grant, token, nonce, timer });
        sendControl({ kind: 'data', sid, payload: { type: 'pop-challenge', nonce } });
    };

    const proof = (sid: string, payload: Record<string, unknown>) => {
        const pending = pendingPop.get(sid);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingPop.delete(sid); // the nonce is single-use
        const reason = popFailure(payload, pending.nonce, deps.workstationId, sid, pending.grant.confirmationKeyThumbprint ?? '');
        if (reason) {
            reject(sid, reason);
            return;
        }
        // The key just proved is the one the grant names (popFailure checked its thumbprint): the handshake is with it.
        const jwk = payload.jwk as { x: string };
        void handshake(sid, pending.grant, pending.token, { kty: 'OKP', crv: 'Ed25519', x: jwk.x });
    };

    /**
     * THE END-TO-END EXCHANGE (relay-e2e.ts), after the grant and the proof hold: answer the member's `e2e-init`, signed
     * with this machine's enrolled key, and wait for its finish. A member that sent none is a Genie from before this: it
     * is refused in words, and whatever it sent meanwhile is dropped unread.
     */
    const handshake = async (sid: string, grant: HostGrant, token: string, memberJwk: PopJwk) => {
        const init = inits.get(sid);
        inits.delete(sid);
        if (init === undefined) {
            reject(sid, E2E_HOST_WORDS.oldMember, 'e2e');
            return;
        }
        // Who this would be, before any exchange: a grant this Genie cannot seat is refused in its own words.
        const who = principalOf(grant, deps.signedInHere());
        if (!who.ok) {
            reject(sid, who.reason);
            return;
        }
        let exchange: HostExchange;
        // This admission's own mark: one that was refused meanwhile (and a later one for the same id) is not this one.
        const waiting = preAdmit.get(sid);
        answering.add(sid);
        try {
            exchange = await acceptMember({ workstationId: deps.workstationId, sid, grant: token, hostFingerprint: deps.fingerprint, memberJwk, sign: deps.sign, init });
        } catch {
            if (state === 'open' && preAdmit.get(sid) === waiting && waiting !== undefined) reject(sid, E2E_HOST_WORDS.changed, 'e2e');
            return;
        }
        if (state !== 'open' || waiting === undefined || preAdmit.get(sid) !== waiting || pendingE2e.has(sid)) return;
        answering.delete(sid);
        const timer = setTimeout(() => { if (pendingE2e.has(sid)) reject(sid, 'the encrypted connection was not completed in time', 'e2e'); }, deps.popTimeoutMs ?? 10_000);
        pendingE2e.set(sid, { grant, token, exchange, timer });
        sendControl({ kind: 'data', sid, payload: exchange.accept });
    };

    /** The member's finish: it holds the grant's key and saw this exchange, or there is no session. */
    const finishE2e = (sid: string, payload: Record<string, unknown>) => {
        const pending = pendingE2e.get(sid);
        if (!pending) {
            // A finish nobody is waiting for, on a live session: somebody else's.
            if (sessions.has(sid)) reject(sid, E2E_HOST_WORDS.changed, 'e2e');
            return;
        }
        clearTimeout(pending.timer);
        pendingE2e.delete(sid);
        let cipher: FrameCipher;
        try {
            cipher = pending.exchange.finish(payload);
        } catch {
            reject(sid, E2E_HOST_WORDS.notProved, 'e2e');
            return;
        }
        accept(sid, pending.grant, pending.token, cipher);
    };

    /**
     * A FRESH GRANT FOR A LIVE SESSION (genie#1401): the member renews before its grant expires, and the session goes on
     * under the new one. It must be valid (Tynn's signature, audience, expiry, still active), for the same person, bound
     * to the SAME key the member proved at admission (so no new challenge is needed), and map to exactly the same
     * principal: a renewal never changes who the guest is or what it may reach. Anything else ends the session, in words.
     */
    const renew = async (sid: string, token: unknown) => {
        const session = sessions.get(sid);
        if (!session) return;
        if (typeof token !== 'string') {
            reject(sid, 'grant renewal refused: no grant');
            return;
        }
        let check: GrantCheck;
        try {
            check = await deps.validateGrant(token);
        } catch {
            check = { ok: false, reason: 'grant validation error' };
        }
        if (state !== 'open' || sessions.get(sid) !== session) return;
        const refusal = !check.ok ? check.reason : renewalRefusal(session.grant, check.grant, deps.signedInHere());
        if (refusal !== null || !check.ok) {
            reject(sid, `grant renewal refused: ${refusal ?? 'invalid'}`);
            return;
        }
        session.grant = check.grant;
        session.token = token;
    };

    /** What only the admitted member may say on control: sealed, opened here, and nothing but a renewal. */
    const sealedControl = (sealed: Frame) => {
        const session = sessions.get(sealed.sid);
        let frame: Frame | null = null;
        try {
            if (session) frame = session.cipher.open(sealed);
        } catch {
            frame = null;
        }
        const payload = (frame?.payload ?? {}) as Record<string, unknown>;
        if (!frame || frame.kind !== 'data' || payload.type !== 'grant-renew') {
            reject(sealed.sid, E2E_HOST_WORDS.changed, 'e2e');
            return;
        }
        void renew(sealed.sid, payload.grant);
    };

    const handle = (frame: Frame) => {
        if (frame.channel === 'control') {
            if (frame.kind === 'open') {
                // A session id is opened once: a second open for one that is live or being admitted is not acted on at all
                // (no grant read, no challenge, no timer), and the first is left exactly as it was.
                if (sessions.has(frame.sid) || preAdmit.has(frame.sid)) {
                    deps.log?.(`relay member ${frame.sid}: an open for a session that is already open was refused`);
                    return;
                }
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
            // A renewal comes inside the seal or not at all: a plain one could be anybody's (the relay's, with another grant).
            else if (frame.kind === 'data' && payload.type === 'grant-renew') reject(frame.sid, E2E_HOST_WORDS.changed, 'e2e');
            else if (frame.kind === 'data' && payload.e2e !== undefined) sealedControl(frame);
            else if (frame.kind === 'data' && payload.type === 'e2e-init') {
                // One exchange a session, asked before admission: a second (also while the first is being answered), or one
                // on a live session, is somebody else's.
                if (!preAdmit.has(frame.sid) || inits.has(frame.sid) || answering.has(frame.sid) || pendingE2e.has(frame.sid)) reject(frame.sid, E2E_HOST_WORDS.changed, 'e2e');
                else inits.set(frame.sid, payload);
            } else if (frame.kind === 'data' && payload.type === 'e2e-finish') finishE2e(frame.sid, payload);
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
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = null;
        for (const p of pendingPop.values()) clearTimeout(p.timer);
        pendingPop.clear();
        for (const p of pendingE2e.values()) clearTimeout(p.timer);
        pendingE2e.clear();
        inits.clear();
        answering.clear();
        preAdmit.clear();
        for (const sid of [...sessions.keys()]) forget(sid);
    };

    const scheduleReconnect = (reason: string) => {
        const min = deps.reconnect?.minMs ?? 1_000;
        const max = deps.reconnect?.maxMs ?? 30_000;
        if (min <= 0 || closing) return;
        const delay = reconnectDelay;
        reconnectDelay = Math.min(delay * 2, max);
        deps.log?.(`redial in ${Math.round(delay / 1000)} s (${reason})`);
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
            const reason = error instanceof Error ? error.message : String(error);
            setState('closed', reason);
            scheduleReconnect(reason);
            return;
        }
        if (closing) return;
        const socket = deps.socket(`${deps.relayUrl.replace(/\/+$/, '')}/ws/host`);
        ws = socket;
        /** The relay's refusal of this hello, said when its close comes. */
        let refused: string | null = null;
        // Anything from the relay is life: a frame, or its heartbeat ping (which `ws` answers itself and never delivers).
        const heard = () => { if (ws === socket) lastHeard = Date.now(); };
        socket.on?.('ping', heard);
        socket.onopen = () => {
            if (ws !== socket) return;
            heard();
            watchSilence(socket);
            setState('authenticating');
            socket.send(JSON.stringify(hello));
        };
        socket.onmessage = (event) => {
            heard();
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
                    deps.log?.(`open (${deps.relayUrl})`);
                    setState('open');
                    if ((deps.revalidateMs ?? 30_000) > 0) revalidateTimer = setInterval(() => { void revalidate(); }, deps.revalidateMs ?? 30_000);
                } else {
                    refused = `the relay refused this host: ${typeof msg.reason === 'string' ? msg.reason : String(msg.type ?? 'no reason')}`;
                    deps.log?.(refused);
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
        socket.onclose = () => { lose(socket, refused ?? 'the relay closed the link', false); };
        socket.onerror = () => { /* a close follows */ };
    };

    /**
     * THIS SOCKET IS GONE (Tynn #940), by its own close or because the relay went silent: said in the log, the sessions on
     * it ended, the state told, and a redial scheduled. A silent socket is TERMINATED, not closed (a half-open socket's
     * close handshake never completes), and is let go first, so its own close, when `ws` sends it, does nothing more.
     */
    const lose = (socket: RelaySocket, reason: string, kill: boolean) => {
        if (ws !== socket) return;
        teardown();
        ws = null;
        deps.log?.(`closed (${reason})`);
        if (kill) {
            try {
                if (socket.terminate) socket.terminate();
                else socket.close();
            } catch { /* already gone */ }
        }
        setState('closed', reason);
        scheduleReconnect(reason);
    };

    /** Watch this socket for silence: re-armed for what is left of the window, so a busy link costs one timer a window. */
    const watchSilence = (socket: RelaySocket) => {
        if (silentMs <= 0) return;
        if (silenceTimer) clearTimeout(silenceTimer);
        const check = () => {
            silenceTimer = null;
            if (ws !== socket) return;
            const quiet = Date.now() - lastHeard;
            if (quiet < silentMs) {
                silenceTimer = setTimeout(check, silentMs - quiet);
                silenceTimer.unref?.();
                return;
            }
            lose(socket, `the relay sent nothing for ${Math.round(silentMs / 1000)} s`, true);
        };
        silenceTimer = setTimeout(check, silentMs);
        silenceTimer.unref?.();
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

/** Why `next` may not replace `current` for a live session, or null when it may: same person, key and principal. */
function renewalRefusal(current: HostGrant, next: HostGrant, signedInHere: string | null): string | null {
    if (next.sub !== current.sub) return 'it is for someone else';
    if ((next.confirmationKeyThumbprint ?? null) !== (current.confirmationKeyThumbprint ?? null)) return 'it is bound to a different key';
    const was = principalOf(current, signedInHere);
    const now = principalOf(next, signedInHere);
    if (!now.ok) return now.reason;
    if (!was.ok || was.principal.isOwner !== now.principal.isOwner || was.principal.workspaceId !== now.principal.workspaceId || was.principal.readonly !== now.principal.readonly) {
        return 'it changes what this session may reach';
    }
    return null;
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
