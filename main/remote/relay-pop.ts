import crypto from 'node:crypto';

/**
 * Relay connection Proof-of-Possession (PoP) — MEMBER side (P4.5).
 * ===========================================================================
 *
 * A connect grant is bearer-ish: anyone who captures the JWS could replay it.
 * PoP binds the grant to an EPHEMERAL keypair the member proves possession of,
 * so a leaked grant alone can't open a session.
 *
 *   1. Per connection the member generates an ephemeral Ed25519 keypair IN MAIN
 *      (never the renderer). Its PUBLIC key travels as a JWK (`pop_jwk`) in the
 *      connect-grant request; Tynn binds the grant to its thumbprint
 *      (`cnf: { jkt }`).
 *   2. After `member-welcome`, the host challenges with a nonce. The member
 *      signs `SHA-256(nonce || workstationId || sid)` with the ephemeral PRIVATE
 *      key and returns the public JWK + signature. The host verifies the
 *      signature AND that the JWK's thumbprint matches the grant's `cnf.jkt`.
 *   3. The private key never leaves main and is discarded on disconnect.
 *
 * The wire ENCODING of the signed input (here: the UTF-8 bytes of the three
 * values concatenated) is isolated in {@link popSignedInput} so it can be
 * aligned to genie-cloud / Tynn's exact definition in one place.
 */

/** An Ed25519 public key as a JWK (RFC 8037 OKP). */
export interface PopJwk {
    kty: 'OKP';
    crv: 'Ed25519';
    /** base64url-encoded public key. */
    x: string;
}

/** The member's answer to a PoP challenge. */
export interface PopProof {
    /** The ephemeral public key (same JWK sent as `pop_jwk` at grant time). */
    jwk: PopJwk;
    /** base64url Ed25519 signature over {@link popSignedInput}. */
    sig: string;
}

/**
 * The exact bytes the member signs — this MUST byte-match the host's verify
 * preimage (GenieCloudScaffold), so the invariants are locked here:
 *
 *   `SHA-256( utf8(nonce) || utf8(workstationId) || utf8(sid) )`
 *
 *   - **nonce** is an OPAQUE hex string — signed as its UTF-8 bytes exactly as
 *     received from the challenge. Do NOT hex-decode it.
 *   - **workstationId** is the DIALED workstation's id (the grant `aud`, the
 *     same id passed to member-hello) — NOT the relay session id.
 *   - **sid** is the relay-assigned member-session id (echoed from the challenge).
 *   - Concatenation order is exactly (nonce, workstationId, sid), with NO
 *     separators; the signed message is the resulting 32-byte digest.
 *
 * Isolated so the encoding stays reconciled with the host/Tynn definition in
 * ONE place.
 */
export function popSignedInput(nonce: string, workstationId: string, sid: string): Buffer {
    const concatenated = Buffer.concat([
        Buffer.from(nonce, 'utf8'),
        Buffer.from(workstationId, 'utf8'),
        Buffer.from(sid, 'utf8'),
    ]);
    return crypto.createHash('sha256').update(concatenated).digest();
}

/**
 * An ephemeral Ed25519 keypair for one workstation connection. The public JWK
 * is shared (as `pop_jwk` + in the proof); the private key stays inside this
 * object and is wiped by {@link discard} on disconnect.
 */
export class PopKeypair {
    private constructor(
        private readonly publicKey: crypto.KeyObject,
        private privateKey: crypto.KeyObject | null,
        /** The public key as a JWK — sent as `pop_jwk` and echoed in the proof. */
        readonly publicJwk: PopJwk,
    ) {}

    /** Generate a fresh ephemeral keypair (main-process only). */
    static generate(): PopKeypair {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const jwk = publicKey.export({ format: 'jwk' }) as {
            kty?: string;
            crv?: string;
            x?: string;
        };
        if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
            throw new Error('unexpected Ed25519 JWK export shape');
        }
        return new PopKeypair(publicKey, privateKey, { kty: 'OKP', crv: 'Ed25519', x: jwk.x });
    }

    /** Answer a PoP challenge: sign the canonical input and return jwk + sig. */
    prove(nonce: string, workstationId: string, sid: string): PopProof {
        if (!this.privateKey) throw new Error('PoP keypair already discarded');
        const sig = crypto.sign(null, popSignedInput(nonce, workstationId, sid), this.privateKey);
        return { jwk: this.publicJwk, sig: sig.toString('base64url') };
    }

    /** Wipe the private key — call on disconnect; further `prove` calls throw. */
    discard(): void {
        this.privateKey = null;
    }
}
