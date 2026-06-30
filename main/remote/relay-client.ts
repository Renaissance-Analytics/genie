import { WebSocket } from 'ws';
import {
    encodeMemberHello,
    decodeMemberControl,
    encodeFrame,
    decodeFrame,
    encodePopProof,
    decodePopChallenge,
    type RestRequestPayload,
    type RestReplyPayload,
} from './relay-protocol';
import { RelayFrameMux } from './relay-mux';
import type { PopKeypair } from './relay-pop';

/**
 * The desktop MEMBER client for a Virtual Workstation connection over the Tynn
 * relay — the relay-tier analogue of a tailnet `connectRemote`. Opens one
 * `wss://<relay>/ws/member`, sends `member-hello {workstationId, grant}`, awaits
 * `member-welcome {sid}`, then exposes REST / events / term over the multiplexed
 * frame stream ({@link RelayFrameMux}). The remote bridge drives a host window's
 * `api()` through this instead of the tailnet HTTP+WS stack.
 *
 * Grant validation, scope×capability, and demux to the workstation's real
 * surface all happen on the genie-cloud side; this client just frames + routes.
 */
export interface RelayConnectOpts {
    /** The relay base, e.g. `wss://relay.tynn.ai`. */
    relayUrl: string;
    workstationId: string;
    /** The short-TTL Tynn connection grant (JWS) for member-hello. */
    grant: string;
    /**
     * The ephemeral PoP keypair the grant is bound to (P4.5). When present, a
     * post-welcome `pop-challenge` is answered with a `pop-proof` signed by it.
     * Omit for a connection with no PoP binding (the host then mustn't challenge).
     */
    popKeypair?: PopKeypair;
    /** Handshake timeout (ms). */
    timeoutMs?: number;
}

export class RelayMemberClient {
    private ws: WebSocket | null = null;
    private mux: RelayFrameMux | null = null;
    private sid: string | null = null;
    private popKeypair: PopKeypair | null = null;
    private workstationId: string | null = null;

    /** The relay-assigned member-session id (after connect). */
    get sessionId(): string | null {
        return this.sid;
    }

    /** Dial the relay + complete the member handshake. Resolves once welcomed
     *  (the mux is live); rejects on a control error, a malformed reply, the
     *  socket erroring before welcome, or the handshake timeout. */
    connect(opts: RelayConnectOpts): Promise<void> {
        const url = opts.relayUrl.replace(/\/+$/, '') + '/ws/member';
        this.popKeypair = opts.popKeypair ?? null;
        this.workstationId = opts.workstationId;
        return new Promise<void>((resolve, reject) => {
            let ws: WebSocket;
            try {
                ws = new WebSocket(url);
            } catch (e) {
                reject(e instanceof Error ? e : new Error(String(e)));
                return;
            }
            this.ws = ws;
            let welcomed = false;
            const timer = setTimeout(() => {
                if (!welcomed) {
                    try {
                        ws.close();
                    } catch {
                        /* already closing */
                    }
                    reject(new Error('relay handshake timed out'));
                }
            }, opts.timeoutMs ?? 15_000);
            timer.unref?.();

            ws.on('open', () => {
                ws.send(encodeMemberHello(opts.workstationId, opts.grant));
            });
            ws.on('message', (raw: Buffer | string) => {
                if (!welcomed) {
                    // The FIRST message is the control reply (welcome / error).
                    let ctrl;
                    try {
                        ctrl = decodeMemberControl(raw);
                    } catch (e) {
                        clearTimeout(timer);
                        try {
                            ws.close();
                        } catch {
                            /* */
                        }
                        reject(e instanceof Error ? e : new Error(String(e)));
                        return;
                    }
                    if (ctrl.type === 'error') {
                        clearTimeout(timer);
                        try {
                            ws.close();
                        } catch {
                            /* */
                        }
                        reject(new Error(`relay rejected member: ${ctrl.code} — ${ctrl.reason}`));
                        return;
                    }
                    welcomed = true;
                    clearTimeout(timer);
                    this.sid = ctrl.sid;
                    this.mux = new RelayFrameMux(ctrl.sid, (frame) => {
                        if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(frame));
                    });
                    resolve();
                    return;
                }
                // Post-welcome: a routed frame. `control`-channel frames carry
                // the PoP handshake — answer a pop-challenge with a signed proof
                // (the host rejects a control session that never proves
                // possession); everything else is multiplexed as usual.
                let frame;
                try {
                    frame = decodeFrame(raw);
                } catch {
                    return; // drop a malformed frame rather than tear down
                }
                if (frame.channel === 'control') {
                    try {
                        const challenge = decodePopChallenge(frame);
                        if (challenge) {
                            this.respondToPopChallenge(ws, challenge.nonce, challenge.sid);
                        }
                    } catch {
                        // malformed pop-challenge payload — drop; the host
                        // re-challenges or rejects. Don't tear down.
                    }
                    return;
                }
                this.mux?.handle(frame);
            });
            ws.on('error', (e: Error) => {
                if (!welcomed) {
                    clearTimeout(timer);
                    reject(e);
                }
            });
            ws.on('close', () => {
                this.mux?.rejectAll('relay connection closed');
            });
        });
    }

    /** Sign the host's PoP challenge with the ephemeral key and send the proof.
     *  No keypair (a non-PoP connection) → nothing to prove; the host decides
     *  whether to allow the session.
     *
     *  CRITICAL: the preimage's workstation id is `this.workstationId` — the
     *  DIALED workstation id (the grant `aud`, from member-hello) — NOT `sid`
     *  (the relay session id). The `sid` is echoed only into the proof envelope. */
    private respondToPopChallenge(ws: WebSocket, nonce: string, sid: string): void {
        if (!this.popKeypair || !this.workstationId) return;
        let proof;
        try {
            proof = this.popKeypair.prove(nonce, this.workstationId, sid);
        } catch {
            return; // keypair discarded mid-flight (disconnecting)
        }
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(encodePopProof(sid, proof.jwk, proof.sig));
        }
    }

    /** A REST call to the workstation over the `rest` channel. */
    rest(req: RestRequestPayload): Promise<RestReplyPayload> {
        if (!this.mux) throw new Error('relay client not connected');
        return this.mux.rest(req);
    }

    /** Subscribe to the workstation's `/ws/events`. Returns an unsubscribe. */
    openEvents(onEvent: (msg: string) => void): () => void {
        if (!this.mux) throw new Error('relay client not connected');
        return this.mux.openEvents(onEvent);
    }

    /** Attach to a workstation terminal's `/ws/term`. */
    openTerm(
        terminalId: string,
        onData: (msg: string) => void,
    ): { send: (input: string) => void; close: () => void } {
        if (!this.mux) throw new Error('relay client not connected');
        return this.mux.openTerm(terminalId, onData);
    }

    close(): void {
        try {
            this.ws?.close();
        } catch {
            /* already closing */
        }
        this.mux?.rejectAll('relay client closed');
        this.mux = null;
        this.sid = null;
        // Wipe the ephemeral private key — it must not outlive the connection.
        this.popKeypair?.discard();
        this.popKeypair = null;
        this.workstationId = null;
    }
}
