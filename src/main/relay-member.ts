import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { ClientTransport } from '../core/remote-protocol.js';
import { e2eWords, hostKeyOf, RelayE2eError, startMember, type FrameCipher, type MemberExchange } from './relay-e2e.js';
import { pipeSiteStream, type SiteFrame, type SiteOpen, type SitePipe } from './relay-site.js';
import { decodeFrame, decodeMemberControl, encodeFrame, encodeMemberHello, OPEN, popSignedInput, textOf, type Frame, type PopJwk, type RelaySocketFactory } from './relay-wire.js';

/**
 * A MEMBER OF THE TYNN NETWORK (Tynn #837) — Genie 1's `remote/relay-client.ts` + `relay-pop.ts`, carrying Genie 2's
 * own protocol. Main dials `<relay>/ws/member` with the Tynn grant (never the renderer: the grant and the proof key stay
 * here), the relay answers with the session id, the host challenges, the member proves the key the grant is bound to —
 * and from then on Genie 2's text messages travel as `rest` data frames, in both directions.
 *
 * END TO END (audit M-a, host split P9.2; relay-e2e.ts): before anything of Genie's own is sent, the host must prove it
 * holds the key TYNN named for the workstation with this grant, and the member proves the grant's key to it. After that
 * every `rest` and `site` frame is sealed, and one that does not open ends the connection. There is no plain path: with
 * no key from Tynn the relay is not dialled, and a host that does not answer the handshake is sent nothing.
 *
 * A refusal anywhere (the relay's, the host's) closes the transport with its reason, kept for whoever shows it.
 */

/** One connection's throwaway Ed25519 key: its public half binds the grant (`pop_jwk`), the private half proves it. */
export class PopKeypair {
    #privateKey: KeyObject | null;
    readonly publicJwk: PopJwk;

    private constructor(privateKey: KeyObject, publicJwk: PopJwk) {
        this.#privateKey = privateKey;
        this.publicJwk = publicJwk;
    }

    static generate(): PopKeypair {
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        const jwk = publicKey.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string };
        if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('unexpected Ed25519 JWK export shape');
        return new PopKeypair(privateKey, { kty: 'OKP', crv: 'Ed25519', x: jwk.x });
    }

    prove(nonce: string, workstationId: string, sid: string): { jwk: PopJwk; sig: string } {
        if (!this.#privateKey) throw new Error('the proof key was discarded');
        return { jwk: this.publicJwk, sig: sign(null, popSignedInput(nonce, workstationId, sid), this.#privateKey).toString('base64url') };
    }

    /**
     * This key's signature for the end-to-end handshake (relay-e2e.ts): only over that handshake's own labelled string,
     * so the key can never be made to sign a proof-of-possession digest, or anything else, through here.
     */
    signHandshake(data: Buffer): Buffer {
        if (!this.#privateKey) throw new Error('the proof key was discarded');
        if (!data.subarray(0, HANDSHAKE_LABEL.length).equals(HANDSHAKE_LABEL)) throw new Error('not the end-to-end handshake');
        return sign(null, data, this.#privateKey);
    }

    discard(): void {
        this.#privateKey = null;
    }
}

const HANDSHAKE_LABEL = Buffer.from('genie-relay-e2e v1 member\n', 'utf8');

/** A transport over the relay that can say why it closed. */
export interface RelayMemberTransport extends ClientTransport {
    /** The relay's or the host's reason, once closed by either; `null` while open, or after our own close. */
    closedBecause(): string | null;
    /**
     * Open a stream to one of the HOST's `.gen` sites (relay-site.ts): settles once the host's front door accepted —
     * then pipe the browser's socket into it — or with the host's refusal in its words.
     */
    openSite(host: string): Promise<SiteOpen>;
}

interface SiteStream {
    settle: ((opened: SiteOpen) => void) | null;
    pipe: SitePipe | null;
    early: SiteFrame[];
}

const SITE_OPEN_TIMEOUT_MS = 15_000;

/**
 * RENEWING THE GRANT DURING A LIVE SESSION (genie#1401). Tynn's grants live 15 minutes and the host ends a session whose
 * grant has expired, so the member fetches a fresh one (bound to the SAME proof key) before then and hands it to the host
 * as a control `grant-renew`. For a share link that is also what keeps its one session alive at Tynn (tynn.ai #394): Tynn
 * re-mints from a link pass only while the session is live. Renew this long before the grant in use expires, or after a
 * third of its life when it is short; a refused renewal is tried again every RENEW_RETRY_MS until that grant expires.
 */
const RENEW_LEAD_MS = 5 * 60_000;
const RENEW_RETRY_MS = 30_000;

/** The grant's `exp` in ms, read only to schedule its renewal (the host is the one that verifies it). */
function expiresAtOf(token: string): number | null {
    try {
        const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
        return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
    } catch {
        return null;
    }
}

/** A fresh grant for this connection's key (main: `mintConnectGrant` with the same `pop_jwk`), or why not. */
export type RenewGrant = () => Promise<{ ok: true; token: string } | { ok: false; reason: string }>;

/** `offline`: the relay said the machine is not connected to it (genie-cloud's `no-host`), as against any other refusal. */
export type RelayMemberResult = { ok: true; transport: RelayMemberTransport } | { ok: false; reason: string; offline?: true };

export function openRelayMember(input: {
    socket: RelaySocketFactory;
    relayUrl: string;
    workstationId: string;
    grant: string;
    /**
     * `host_public_key` as Tynn returned it with THIS grant (tynn-network.ts `mintConnectGrant`): the only key the host is
     * checked against. `null` (Tynn named none) refuses before the relay is dialled.
     */
    hostPublicKey: string | null;
    /** The workstation's name, for the words a person reads; absent = "the workstation you asked for". */
    name?: string | null;
    pop: PopKeypair;
    timeoutMs?: number;
    /** How long the host has to answer the handshake after this member's proof; a host from before P9.2 never does. */
    e2eTimeoutMs?: number;
    /** Fetch a fresh grant during the session (genie#1401); absent = the session lasts as long as its first grant. */
    renew?: RenewGrant;
}): Promise<RelayMemberResult> {
    // No key from Tynn: there is nothing to check the host against, so nothing is dialled and nothing is sent.
    if (hostKeyOf(input.hostPublicKey) === null) {
        input.pop.discard();
        return Promise.resolve({ ok: false, reason: e2eWords.noKey(input.name) });
    }
    return new Promise((resolve) => {
        const ws = input.socket(`${input.relayUrl.replace(/\/+$/, '')}/ws/member`);
        const messages = new Set<(text: string) => void>();
        const closes = new Set<() => void>();
        let sid: string | null = null;
        let settled = false;
        let closed = false;
        let because: string | null = null;
        let offline = false;
        const streams = new Map<string, SiteStream>();
        let nextReq = 0;
        let renewTimer: ReturnType<typeof setTimeout> | null = null;
        /** The handshake in flight, then the session's cipher: nothing of Genie's own moves before `cipher` is set. */
        let exchange: MemberExchange | null = null;
        let cipher: FrameCipher | null = null;
        let e2eTimer: ReturnType<typeof setTimeout> | null = null;

        /** The one way a rest or site frame leaves: sealed, at the moment of the write. */
        const sendSealed = (frame: Frame): void => {
            if (closed || cipher === null || ws.readyState !== OPEN) return;
            try {
                ws.send(encodeFrame(cipher.seal(frame)));
            } catch (error) {
                closeOnce(error instanceof RelayE2eError && error.code === 'limit' ? e2eWords.limit(input.name) : e2eWords.changed(input.name));
            }
        };
        /** Schedule the next renewal for the grant in use, which expires at `expiresAt`. */
        const scheduleRenew = (expiresAt: number | null, retry = false) => {
            if (renewTimer) clearTimeout(renewTimer);
            renewTimer = null;
            if (!input.renew || closed || expiresAt === null) return;
            const left = expiresAt - Date.now();
            if (left <= 0) return; // the host ends it; nothing left to renew
            const wait = retry ? Math.min(RENEW_RETRY_MS, left) : Math.max(0, left - Math.min(RENEW_LEAD_MS, Math.floor(left / 3)));
            renewTimer = setTimeout(() => { void renewNow(expiresAt); }, wait);
        };
        const renewNow = async (current: number) => {
            renewTimer = null;
            if (!input.renew || closed) return;
            let fresh: Awaited<ReturnType<RenewGrant>>;
            try {
                fresh = await input.renew();
            } catch (error) {
                fresh = { ok: false, reason: error instanceof Error ? error.message : String(error) };
            }
            if (closed || sid === null || cipher === null || ws.readyState !== OPEN) return;
            if (!fresh.ok) {
                scheduleRenew(current, true);
                return;
            }
            // Inside the seal (relay-e2e.ts): only this member can hand the host a renewal, and the relay reads neither it nor the grant.
            sendSealed({ kind: 'data', channel: 'control', sid, payload: { type: 'grant-renew', grant: fresh.token } });
            scheduleRenew(expiresAtOf(fresh.token));
        };

        const finish = (result: RelayMemberResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const closeOnce = (reason: string | null) => {
            if (closed) return;
            closed = true;
            because = reason;
            if (renewTimer) clearTimeout(renewTimer);
            renewTimer = null;
            if (e2eTimer) clearTimeout(e2eTimer);
            e2eTimer = null;
            exchange = null;
            cipher = null;
            input.pop.discard();
            for (const stream of [...streams.values()]) {
                stream.settle?.({ ok: false, reason: reason ?? 'the connection to the host closed' });
                stream.pipe?.destroy();
            }
            streams.clear();
            try { ws.close(); } catch { /* already closing */ }
            finish(offline ? { ok: false, reason: reason ?? 'the relay closed the connection', offline: true } : { ok: false, reason: reason ?? 'the relay closed the connection' });
            for (const l of closes) l();
        };
        const timer = setTimeout(() => closeOnce('the relay did not answer'), input.timeoutMs ?? 15_000);

        const transport: RelayMemberTransport = {
            send: (text) => {
                if (closed || sid === null) return;
                sendSealed({ kind: 'data', channel: 'rest', sid, payload: text });
            },
            onMessage: (l) => { messages.add(l); return () => { messages.delete(l); }; },
            onClose: (l) => { closes.add(l); return () => { closes.delete(l); }; },
            close: () => closeOnce(null),
            closedBecause: () => because,
            openSite: (host) => new Promise<SiteOpen>((resolve) => {
                if (closed || sid === null || cipher === null || ws.readyState !== OPEN) {
                    resolve({ ok: false, reason: because ?? 'not connected to the host' });
                    return;
                }
                const reqId = `site_${++nextReq}`;
                const session = sid;
                const say = (f: SiteFrame) => { sendSealed({ ...f, channel: 'site', sid: session, reqId }); };
                const stream: SiteStream = { settle: null, pipe: null, early: [] };
                const timer = setTimeout(() => {
                    if (!stream.settle) return;
                    say({ kind: 'close' });
                    streams.delete(reqId);
                    stream.settle({ ok: false, reason: 'the host did not open the site' });
                }, SITE_OPEN_TIMEOUT_MS);
                stream.settle = (opened) => { clearTimeout(timer); stream.settle = null; resolve(opened); };
                streams.set(reqId, stream);
                say({ kind: 'open', payload: { host } });
            }),
        };

        /** A site frame from the host: the answer to an open, or bytes for a piped stream. */
        const siteFrame = (reqId: string, frame: SiteFrame) => {
            const stream = streams.get(reqId);
            if (!stream) return;
            if (stream.settle) {
                const p = frame.payload as { t?: unknown; ca?: unknown } | undefined;
                if (frame.kind === 'data' && p?.t === 'open') {
                    const say = (f: SiteFrame) => { if (sid !== null) sendSealed({ ...f, channel: 'site', sid, reqId }); };
                    stream.settle({
                        ok: true,
                        ...(typeof p.ca === 'string' ? { ca: p.ca } : {}),
                        pipe: (socket) => {
                            if (closed || streams.get(reqId) !== stream) { socket.destroy(); return; }
                            const pipe = pipeSiteStream(socket, say, () => { if (streams.get(reqId) === stream) streams.delete(reqId); });
                            stream.pipe = pipe;
                            for (const f of stream.early.splice(0)) pipe.receive(f);
                        },
                    });
                    return;
                }
                streams.delete(reqId);
                stream.settle({ ok: false, reason: frame.kind === 'error' ? (frame.reason ?? 'the host refused the site') : 'the host closed the site stream' });
                return;
            }
            if (stream.pipe) stream.pipe.receive(frame);
            else if (stream.early.length < 64) stream.early.push(frame);
        };

        ws.onopen = () => ws.send(encodeMemberHello(input.workstationId, input.grant));
        ws.onmessage = (event) => {
            const raw = textOf(event.data);
            if (raw === null || closed) return;
            if (sid === null) {
                let reply: ReturnType<typeof decodeMemberControl>;
                try {
                    reply = decodeMemberControl(raw);
                } catch {
                    closeOnce('the relay answered with something that is not the relay protocol');
                    return;
                }
                if (reply.type === 'error') {
                    // genie-cloud relay-server: `no-host` = "workstation not connected" — the machine is offline.
                    offline = reply.code === 'no-host';
                    closeOnce(reply.reason || reply.code);
                    return;
                }
                sid = reply.sid;
                // The handshake starts at once, ahead of the proof: the host answers it only after the grant and the proof hold.
                try {
                    exchange = startMember({ workstationId: input.workstationId, sid, grant: input.grant, hostPublicKey: input.hostPublicKey, memberJwk: input.pop.publicJwk, sign: (data) => input.pop.signHandshake(data) });
                } catch {
                    closeOnce(e2eWords.noKey(input.name));
                    return;
                }
                ws.send(encodeFrame({ kind: 'data', channel: 'control', sid, payload: exchange.init }));
                return;
            }
            let frame: ReturnType<typeof decodeFrame>;
            try {
                frame = decodeFrame(raw);
            } catch {
                return;
            }
            if (frame.channel === 'control') {
                if (frame.kind === 'close' || frame.kind === 'error') {
                    closeOnce(frame.reason ?? 'the host ended the session');
                    return;
                }
                const payload = frame.payload as { type?: unknown; nonce?: unknown } | undefined;
                if (frame.kind === 'data' && payload?.type === 'pop-challenge' && typeof payload.nonce === 'string') {
                    const proof = input.pop.prove(payload.nonce, input.workstationId, sid);
                    ws.send(encodeFrame({ kind: 'data', channel: 'control', sid, payload: { type: 'pop-proof', jwk: proof.jwk, sig: proof.sig } }));
                    // A host of this build answers the handshake as soon as the proof holds; one from before it never does.
                    if (cipher === null && e2eTimer === null) e2eTimer = setTimeout(() => closeOnce(e2eWords.oldHost(input.name)), input.e2eTimeoutMs ?? 10_000);
                    return;
                }
                if (frame.kind === 'data' && payload?.type === 'e2e-accept') {
                    // Answered once: a second accept, or one nobody asked for, is somebody else's.
                    if (exchange === null || cipher !== null) {
                        closeOnce(e2eWords.changed(input.name));
                        return;
                    }
                    const asked = exchange;
                    exchange = null;
                    let done: ReturnType<MemberExchange['accept']>;
                    try {
                        done = asked.accept(frame.payload);
                    } catch {
                        // The host did not prove it holds the key Tynn named: nothing of Genie's own was sent, and nothing will be.
                        closeOnce(e2eWords.notProved(input.name));
                        return;
                    }
                    if (e2eTimer) clearTimeout(e2eTimer);
                    e2eTimer = null;
                    ws.send(encodeFrame({ kind: 'data', channel: 'control', sid, payload: done.finish }));
                    cipher = done.cipher;
                    scheduleRenew(expiresAtOf(input.grant));
                    finish({ ok: true, transport });
                }
                return;
            }
            if (frame.channel !== 'rest' && frame.channel !== 'site') return;
            // Everything else is the host's, sealed: one frame that does not open ends the connection, and is not delivered.
            let opened: Frame;
            try {
                if (cipher === null) throw new RelayE2eError('plain', 'a frame before the handshake');
                opened = cipher.open(frame);
            } catch {
                closeOnce(e2eWords.changed(input.name));
                return;
            }
            if (opened.channel === 'rest' && opened.kind === 'data' && typeof opened.payload === 'string') {
                for (const l of messages) l(opened.payload);
                return;
            }
            if (opened.channel === 'site' && opened.reqId) {
                siteFrame(opened.reqId, { kind: opened.kind, ...(opened.payload !== undefined ? { payload: opened.payload } : {}), ...(opened.reason !== undefined ? { reason: opened.reason } : {}) });
            }
        };
        ws.onclose = () => closeOnce(because ?? 'the relay closed the connection');
        ws.onerror = () => { /* a close follows */ };
    });
}
