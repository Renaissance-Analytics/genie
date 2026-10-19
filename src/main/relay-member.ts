import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { ClientTransport } from '../core/remote-protocol.js';
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
}

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
            }
        };
        ws.onclose = () => closeOnce(because ?? 'the relay closed the connection');
        ws.onerror = () => { /* a close follows */ };
    });
}
