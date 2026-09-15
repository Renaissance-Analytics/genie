import { createHash, createPublicKey, verify as edVerify, type webcrypto } from 'node:crypto';

import { popSignedInput } from '../../remote/relay-pop';
import type { HostGrant } from './grant';

/**
 * Proof of possession, HOST side (genie#680). Tynn binds a `control` grant to the
 * member's ephemeral key (`cnf.jkt`), so a leaked grant alone opens nothing: the
 * host issues a single-use nonce and admits the session only when the member
 * signs it with that key. The member half is `remote/relay-pop.ts`; the signed
 * input is its `popSignedInput`, used here directly so the two cannot drift.
 * Mirrors genie-cloud `src/relay/pop.ts`.
 */

export interface PopCheck {
    verified: boolean;
    reason?: string;
}

/** RFC 7638 thumbprint of an Ed25519 OKP JWK — the value Tynn binds as `cnf.jkt`. */
export function jwkThumbprint(jwk: { kty: string; crv: string; x: string }): string {
    const canonical = `{"crv":${JSON.stringify(jwk.crv)},"kty":${JSON.stringify(jwk.kty)},"x":${JSON.stringify(jwk.x)}}`;
    return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/**
 * - `challenge` — the grant is bound to a key: prove possession first.
 * - `reject`    — a `control` grant with no binding. Tynn binds every control
 *                 grant, so an unbound one is not Tynn's to trust.
 * - `skip`      — an unbound read-only grant (the viewer path).
 */
export function popDecision(grant: Pick<HostGrant, 'capability' | 'confirmationKeyThumbprint'>): 'challenge' | 'reject' | 'skip' {
    if (grant.confirmationKeyThumbprint) return 'challenge';
    return grant.capability === 'control' ? 'reject' : 'skip';
}

export function verifyPopProof(input: {
    jwk: unknown;
    signatureB64u: string;
    nonce: string;
    workstationId: string;
    sid: string;
    expectedThumbprint: string;
}): PopCheck {
    const k = input.jwk as Record<string, unknown> | null;
    if (!k || typeof k !== 'object' || k.kty !== 'OKP' || k.crv !== 'Ed25519' || typeof k.x !== 'string' || k.x === '') {
        return { verified: false, reason: 'proof key is not an Ed25519 OKP JWK' };
    }
    if (jwkThumbprint({ kty: k.kty, crv: k.crv, x: k.x }) !== input.expectedThumbprint) {
        return { verified: false, reason: 'proof key does not match the grant binding' };
    }
    if (!input.signatureB64u) return { verified: false, reason: 'missing proof signature' };
    try {
        const key = createPublicKey({ key: k as unknown as webcrypto.JsonWebKey, format: 'jwk' });
        const ok = edVerify(null, popSignedInput(input.nonce, input.workstationId, input.sid), key, Buffer.from(input.signatureB64u, 'base64url'));
        return ok ? { verified: true } : { verified: false, reason: 'proof signature invalid' };
    } catch {
        return { verified: false, reason: 'proof verification error' };
    }
}
