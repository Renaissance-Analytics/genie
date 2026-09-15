import { randomBytes } from 'node:crypto';

/**
 * The host's dial-in `host-hello` for a SHARED relay (genie#680, genie-cloud#34):
 * a Tynn relay ticket naming this workstation and its host key, plus this host's
 * Ed25519 signature over the claim with that key.
 *
 * The signed string MUST match genie-cloud's `hostHelloSigningString` exactly. Its
 * `genie-relay-host-hello` domain keeps the signature from being replayable as any
 * other signature the host key makes (Tynn's `workstation-auth` proof, the site
 * E2E transcript).
 */

export interface TicketHostHello {
    type: 'host-hello';
    workstationId: string;
    fingerprint: string;
    nonce: string;
    ts: number;
    ticket: string;
    /** base64url Ed25519 signature over {@link hostHelloSigningString}. */
    sig: string;
}

export function hostHelloSigningString(h: { workstationId: string; fingerprint: string; nonce: string; ts: number }): string {
    return `genie-relay-host-hello\n${h.workstationId}.${h.fingerprint}.${h.nonce}.${h.ts}`;
}

export function buildTicketHostHello(opts: {
    ticket: string;
    workstationId: string;
    fingerprint: string;
    /** Sign with the enrolled host key (the key never leaves the identity module). */
    sign: (data: Buffer) => Buffer;
    now?: number;
}): TicketHostHello {
    const base = {
        workstationId: opts.workstationId,
        fingerprint: opts.fingerprint,
        nonce: randomBytes(16).toString('hex'),
        ts: opts.now ?? Date.now(),
    };
    const sig = opts.sign(Buffer.from(hostHelloSigningString(base), 'utf8')).toString('base64url');
    return { type: 'host-hello', ...base, ticket: opts.ticket, sig };
}
