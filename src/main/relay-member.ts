import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { ClientTransport } from '../core/remote-protocol.js';
import { pipeSiteStream, type SiteFrame, type SiteOpen, type SitePipe } from './relay-site.js';
import { decodeFrame, decodeMemberControl, encodeFrame, encodeMemberHello, OPEN, popSignedInput, textOf, type PopJwk, type RelaySocketFactory } from './relay-wire.js';

/**
 * A MEMBER OF THE TYNN NETWORK (Tynn #837) — Genie 1's `remote/relay-client.ts` + `relay-pop.ts`, carrying Genie 2's
 * own protocol. Main dials `<relay>/ws/member` with the Tynn grant (never the renderer: the grant and the proof key stay
 * here), the relay answers with the session id, the host challenges, the member proves the key the grant is bound to —
 * and from then on Genie 2's text messages travel as `rest` data frames, in both directions.
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

    discard(): void {
        this.#privateKey = null;
    }
}

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

export type RelayMemberResult = { ok: true; transport: RelayMemberTransport } | { ok: false; reason: string };

export function openRelayMember(input: {
    socket: RelaySocketFactory;
    relayUrl: string;
    workstationId: string;
    grant: string;
    pop: PopKeypair;
    timeoutMs?: number;
}): Promise<RelayMemberResult> {
    return new Promise((resolve) => {
        const ws = input.socket(`${input.relayUrl.replace(/\/+$/, '')}/ws/member`);
        const messages = new Set<(text: string) => void>();
        const closes = new Set<() => void>();
        let sid: string | null = null;
        let settled = false;
        let closed = false;
        let because: string | null = null;
        const streams = new Map<string, SiteStream>();
        let nextReq = 0;

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
            input.pop.discard();
            for (const stream of [...streams.values()]) {
                stream.settle?.({ ok: false, reason: reason ?? 'the connection to the host closed' });
                stream.pipe?.destroy();
            }
            streams.clear();
            try { ws.close(); } catch { /* already closing */ }
            finish({ ok: false, reason: reason ?? 'the relay closed the connection' });
            for (const l of closes) l();
        };
        const timer = setTimeout(() => closeOnce('the relay did not answer'), input.timeoutMs ?? 15_000);

        const transport: RelayMemberTransport = {
            send: (text) => {
                if (closed || sid === null || ws.readyState !== OPEN) return;
                ws.send(encodeFrame({ kind: 'data', channel: 'rest', sid, payload: text }));
            },
            onMessage: (l) => { messages.add(l); return () => { messages.delete(l); }; },
            onClose: (l) => { closes.add(l); return () => { closes.delete(l); }; },
            close: () => closeOnce(null),
            closedBecause: () => because,
            openSite: (host) => new Promise<SiteOpen>((resolve) => {
                if (closed || sid === null || ws.readyState !== OPEN) {
                    resolve({ ok: false, reason: because ?? 'not connected to the host' });
                    return;
                }
                const reqId = `site_${++nextReq}`;
                const session = sid;
                const say = (f: SiteFrame) => { if (!closed && ws.readyState === OPEN) ws.send(encodeFrame({ ...f, channel: 'site', sid: session, reqId })); };
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
                const p = frame.payload as { t?: unknown } | undefined;
                if (frame.kind === 'data' && p?.t === 'open') {
                    const say = (f: SiteFrame) => { if (!closed && ws.readyState === OPEN && sid !== null) ws.send(encodeFrame({ ...f, channel: 'site', sid, reqId })); };
                    stream.settle({
                        ok: true,
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
                    closeOnce(reply.reason || reply.code);
                    return;
                }
                sid = reply.sid;
                finish({ ok: true, transport });
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
                }
                return;
            }
            if (frame.channel === 'rest' && frame.kind === 'data' && typeof frame.payload === 'string') {
                for (const l of messages) l(frame.payload);
                return;
            }
            if (frame.channel === 'site' && frame.reqId) {
                siteFrame(frame.reqId, { kind: frame.kind, ...(frame.payload !== undefined ? { payload: frame.payload } : {}), ...(frame.reason !== undefined ? { reason: frame.reason } : {}) });
            }
        };
        ws.onclose = () => closeOnce(because ?? 'the relay closed the connection');
        ws.onerror = () => { /* a close follows */ };
    });
}
